// Platform-neutral inbound pipeline (channel-adapter.v1 §4.3–4.6, §4.10, §6.1, §6.6).
//
// An event is {requestID, sender, chat, addressed, messageID, text, attachment,
// command: null|'new'|'start', payload, button, replyToMessageID}. The platform
// supplies `ops`: say(chat, formatted, {replyTo}), sayPrivately(event, formatted),
// deleteMessage(chat, messageID) → boolean, toast(event, text|null).
import {detectSecret} from './secrets.mjs';
import {plainText} from './render.mjs';

export class Inbound {
  constructor({client, journal, platform, getSession, ops, log = () => {}}) {
    this.client = client;
    this.journal = journal;
    this.platform = platform;
    this.getSession = getSession;
    this.ops = ops;
    this.log = log;
  }

  get copy() { return this.getSession()?.copy ?? {}; }

  // Handles one platform update end to end. The request id is journaled only after
  // the host gave a final answer; a crash before that re-sends with the same id.
  async handle(event) {
    if (this.journal.hasInbound(event.requestID)) {
      if (event.button) await this.ops.toast(event, null).catch(() => {});
      return 'duplicate';
    }
    const outcome = await this.route(event);
    if (outcome !== 'dropped') this.journal.finishInbound(event.requestID);
    this.log('inbound', {request_id: event.requestID, outcome});
    return outcome;
  }

  // A bug or an unexpected platform failure on one update must not wedge the
  // stream: log it and move on. Exits and a rejected bot token still propagate.
  async handleSafely(event) {
    try { return await this.handle(event); }
    catch (error) {
      if (error?.exitCode !== undefined || error?.tokenInvalid) throw error;
      this.log('inbound_error', {request_id: event.requestID, name: error?.name, code: error?.code});
      return 'error';
    }
  }

  async route(event) {
    // Unaddressed group/guild messages never leave the adapter (§4.4, §6.5).
    if (!event.addressed && event.chat.kind !== 'dm') return 'dropped';
    if (event.button) return this.answer(event);

    // The code pattern also matches ordinary 8-letter words ("Schedule"), so a
    // pattern-only match from a sender who is already admitted is a message.
    let code = this.pairingCode(event);
    let admitted = null;
    if (code && event.command !== 'start' && event.chat.kind === 'dm') {
      const {status, body} = await this.client.post('/v1/channel/admission', {sender: event.sender, chat: event.chat, addressed: true});
      if (status === 200 && body.admitted === true) { code = null; admitted = true; }
    }
    if (code) {
      if (event.chat.kind !== 'dm') {
        await this.ops.sayPrivately(event, this.text(this.copy.pair_in_dm)).catch(error => this.log('say_failed', {code: error?.code}));
        return 'pair_in_dm';
      }
      const {status, body} = await this.client.post('/v1/channel/pairings/claim', {
        request_id: event.requestID, sender: event.sender, chat: event.chat, code,
      });
      await this.reply(event, body.reply);
      return status === 200 ? 'paired' : body.code || `claim_${status}`;
    }

    admitted ??= await this.admit(event);
    if (admitted !== true) return admitted;
    if (event.attachment) {
      await this.reply(event, this.copy.attachment_refused);
      return 'attachment_refused';
    }
    if (event.command) {
      const {status, body} = await this.client.post('/v1/channel/conversations/resolve', {
        request_id: event.requestID, sender: event.sender, chat: event.chat, new: event.command === 'new',
      });
      await this.reply(event, body.reply ?? body.notice);
      return status === 200 ? `resolved_${event.command}` : body.code || `resolve_${status}`;
    }
    const text = (event.text ?? '').trim();
    if (!text) return 'empty';
    if (detectSecret(text)) return this.secret(event);
    const maxBytes = this.getSession()?.limits?.text_bytes ?? 16384;
    if (Buffer.byteLength(text) > maxBytes) {
      await this.reply(event, this.copy.too_long);
      return 'too_long';
    }
    const body = {
      request_id: event.requestID, sender: event.sender, chat: event.chat,
      platform_message_id: String(event.messageID), text,
    };
    const receipt = event.replyToMessageID ? this.journal.receiptFor(event.chat.id, event.replyToMessageID) : null;
    if (receipt) body.reply_to = {receipt_id: receipt};
    const result = await this.client.post('/v1/channel/messages', body);
    if (result.status === 200 || result.status === 202) return result.body.duplicate ? 'message_duplicate' : 'message_accepted';
    if (result.status === 413) await this.reply(event, this.copy.too_long);
    else if (result.status === 422) return this.secret(event);
    else await this.reply(event, result.body.reply ?? result.body.notice);
    return result.body.code || `message_${result.status}`;
  }

  async admit(event) {
    const {status, body} = await this.client.post('/v1/channel/admission', {
      sender: event.sender, chat: event.chat, addressed: event.addressed || event.chat.kind === 'dm',
    });
    if (status !== 200) {
      await this.reply(event, body.notice ?? body.reply);
      return body.code || `admission_${status}`;
    }
    if (body.admitted === true) return true;
    // The host decides when a stranger gets its one fixed sentence; send it only then.
    if (body.notice && event.chat.kind === 'dm') await this.reply(event, body.notice);
    return `not_admitted_${body.reason || 'unknown'}`;
  }

  async answer(event) {
    const admitted = await this.admit({...event, addressed: true});
    if (admitted !== true) {
      await this.ops.toast(event, null).catch(() => {});
      return admitted;
    }
    const {status, body} = await this.client.post('/v1/channel/answers', {
      request_id: event.requestID, sender: event.sender, chat: event.chat, token: event.button,
    });
    await this.ops.toast(event, body.toast ?? null).catch(error => this.log('toast_failed', {code: error?.code}));
    return status === 200 ? (body.duplicate ? 'answer_duplicate' : 'answered') : body.code || `answer_${status}`;
  }

  async secret(event) {
    const deleted = await this.ops.deleteMessage(event.chat, event.messageID).catch(() => false);
    await this.reply(event, this.copy.secret_warning);
    return deleted ? 'secret_deleted' : 'secret_warned';
  }

  pairingCode(event) {
    if (event.command === 'start') return event.payload?.trim() || null;
    if (event.command) return null;
    const pattern = this.getSession()?.pairing?.code_pattern;
    const text = (event.text ?? '').trim();
    if (!pattern || !text) return null;
    try { return new RegExp(pattern, 'i').test(text) ? text : null; } catch { return null; }
  }

  text(sentence) { return sentence ? plainText(sentence, this.platform) : ''; }

  async reply(event, sentence) {
    if (!sentence) return;
    try {
      await this.ops.say(event.chat, this.text(sentence), {replyTo: event.chat.kind === 'dm' ? null : event.messageID});
    } catch (error) {
      if (error?.exitCode !== undefined || error?.tokenInvalid) throw error;
      this.log('say_failed', {code: error?.code});
    }
  }
}
