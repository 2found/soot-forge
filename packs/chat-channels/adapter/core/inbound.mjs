// Platform-neutral inbound pipeline (channel-adapter.v1 §4.3–4.6, §4.10, §6.1, §6.6,
// v1.2 §10.2, §10.6–10.8, §10.11).
//
// An event is {requestID, sender, chat, addressed, messageID, text, attachment,
// command: null|'new'|'start', payload, button, replyToMessageID}, or
// {requestID, chat, left: true} when the bot left or was removed from a chat. The
// platform supplies `ops`: say(chat, formatted, {replyTo}), sayPrivately(event, formatted),
// deleteMessage(chat, messageID) → boolean, toast(event, text|null),
// memberCount(chat) → integer|null.
import {detectSecret} from './secrets.mjs';
import {plainText} from './render.mjs';

// v1.2 refusals whose one notice is posted in a group too, threaded (§10.2).
const GROUP_NOTICES = new Set(['rate_limited', 'guest_budget']);

// A host-served pattern, case-insensitive; a missing or broken one matches nothing.
function matches(pattern, text) {
  if (!pattern || !text) return false;
  try { return new RegExp(pattern, 'i').test(text); } catch { return false; }
}

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
    if (event.left) {
      const outcome = await this.left(event);
      this.log('inbound', {request_id: event.requestID, outcome});
      return outcome;
    }
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
    // Unaddressed group/guild messages never leave the adapter (§4.4, §6.5); an
    // owner chat claim is a command, so it counts as addressed (§10.7).
    const claim = this.claimCode(event);
    if (!event.addressed && event.chat.kind !== 'dm' && claim === null) return 'dropped';
    if (event.button) return this.answer(event);
    if (claim !== null) return this.claim(event, claim);

    // The code pattern also matches ordinary 8-letter words ("Schedule"), so a
    // pattern-only match from a sender who is already linked is a message. A
    // revision-2 host admits unlinked senders too (§10.2): theirs is still a claim.
    let code = this.pairingCode(event);
    let admitted = null;
    if (code && event.command !== 'start' && event.chat.kind === 'dm') {
      const {status, body} = await this.client.post('/v1/channel/admission', {sender: event.sender, chat: event.chat, addressed: true});
      if (status === 200 && body.admitted === true && body.principal?.linked !== false) { code = null; admitted = true; }
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
    const request = {sender: event.sender, chat: await this.placeChat(event.chat), addressed: event.addressed || event.chat.kind === 'dm'};
    if (event.button) request.button = true;
    const {status, body} = await this.client.post('/v1/channel/admission', request);
    if (event.button) event.admissionToast = body?.toast ?? null;
    if (status !== 200) {
      await this.reply(event, body.notice ?? body.reply);
      return body.code || `admission_${status}`;
    }
    if (body.admitted === true) return true;
    // The host decides when a refusal gets its one fixed sentence; send it only then.
    // `blocked` is always silent, and a press is answered by its toast instead.
    const posted = event.chat.kind === 'dm' || (GROUP_NOTICES.has(body.reason) && !event.button);
    if (body.notice && body.reason !== 'blocked' && posted) await this.reply(event, body.notice);
    return `not_admitted_${body.reason || 'unknown'}`;
  }

  async answer(event) {
    const press = {...event, addressed: true};
    const admitted = await this.admit(press);
    if (admitted !== true) {
      // A v1.1 host refuses an unpaired press with a toast (§9.2): shown to the presser only.
      await this.ops.toast(event, press.admissionToast).catch(error => this.log('toast_failed', {code: error?.code}));
      return admitted;
    }
    const {status, body} = await this.client.post('/v1/channel/answers', {
      request_id: event.requestID, sender: event.sender, chat: event.chat, token: event.button,
    });
    await this.ops.toast(event, body.toast ?? null).catch(error => this.log('toast_failed', {code: error?.code}));
    return status === 200 ? (body.duplicate ? 'answer_duplicate' : 'answered') : body.code || `answer_${status}`;
  }

  // §10.6: the host checks the code and that the sender is the linked owner. A 429
  // carries no sentence and is not retried: a claim must not hold the chat for minutes.
  async claim(event, code) {
    const {status, body} = await this.client.post('/v1/channel/places/claim', {
      request_id: event.requestID, sender: event.sender, chat: await this.placeChat(event.chat), code,
    }, {retryRateLimit: false});
    await this.reply(event, body.reply);
    if (status === 200) return body.duplicate ? 'owner_chat_duplicate' : 'owner_chat';
    return body.code || `claim_${status}`;
  }

  // §10.8, toward a revision-2 host only. Not journaled: the host applies it on every
  // call, and a Discord request id names the chat, not one event.
  async left(event) {
    if (!this.getSession()?.places) return 'left_ignored';
    const {status, body} = await this.client.post('/v1/channel/places/left', {request_id: event.requestID, chat: event.chat});
    return status === 200 ? 'left' : body.code || `left_${status}`;
  }

  // §10.11: the chat as sent on admission and claim, with the platform's member count
  // when a revision-2 host asks for places and the platform reports one.
  async placeChat(chat) {
    if (chat.kind === 'dm' || !this.getSession()?.places || !this.ops.memberCount) return chat;
    const count = await this.ops.memberCount(chat).catch(error => {
      if (error?.exitCode !== undefined || error?.tokenInvalid) throw error;
      return null;
    });
    return Number.isInteger(count) && count >= 0 ? {...chat, member_count: count} : chat;
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
    return matches(pattern, text) ? text : null;
  }

  // §10.7: only outside a DM, matched on the text with the bot mention removed. The
  // code is what follows the command word.
  claimCode(event) {
    const pattern = this.getSession()?.places?.claim_pattern;
    const text = (event.text ?? '').trim();
    if (event.button || event.chat.kind === 'dm' || !matches(pattern, text)) return null;
    const space = text.search(/\s/);
    return space < 0 ? '' : text.slice(space).trim();
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
