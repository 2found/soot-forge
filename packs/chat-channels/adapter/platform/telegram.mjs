// Telegram Bot API side: getUpdates long polling, HTML messages, inline keyboards.
import {PlatformError, backoff, sleep} from '../core/errors.mjs';

const CONFLICT_BACKOFF_MAX = 5 * 60_000;
const MEMBER_COUNT_TTL_MS = 10 * 60_000;
const GONE = new Set(['left', 'kicked']);
const ATTACHMENTS = ['photo', 'document', 'sticker', 'voice', 'video', 'audio', 'animation', 'video_note'];

export class Telegram {
  constructor({token, apiBase = 'https://api.telegram.org', fetch = globalThis.fetch, log = () => {}, pollTimeout = 25, backoffBase = 1000}) {
    this.name = 'telegram';
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.fetch = fetch;
    this.log = log;
    this.pollTimeout = pollTimeout;
    this.backoffBase = backoffBase;
    this.me = null;
    this.memberCounts = new Map();   // chat id → {count, at}
  }

  async call(method, params = {}, {signal} = {}) {
    let response, body;
    try {
      response = await this.fetch(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(params), signal,
      });
      body = await response.json().catch(() => null);
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new PlatformError('telegram_network', {retryable: true, reason: 'platform_unreachable'});
    }
    if (body?.ok) return body.result;
    const status = body?.error_code ?? response.status;
    const description = String(body?.description ?? '').toLowerCase();
    if (status === 401 || (status === 404 && method === 'getMe')) throw new PlatformError(`telegram_${method.toLowerCase()}_${status}`, {tokenInvalid: true, reason: 'platform_token_rejected'});
    if (status === 429) throw new PlatformError('telegram_429', {retryable: true, retryAfter: Number(body?.parameters?.retry_after) || 1, reason: 'platform_rate_limited'});
    // 409 on getUpdates: a webhook is set, or another program polls this bot (§9.4).
    if (status === 409) throw new PlatformError('telegram_409', {retryable: true, reason: description.includes('webhook') ? 'telegram_webhook_active' : 'telegram_poll_conflict'});
    if (status >= 500) throw new PlatformError(`telegram_${status}`, {retryable: true, reason: 'platform_unreachable'});
    if (description.includes('message is not modified')) throw new PlatformError('telegram_not_modified');
    if (status === 403) throw new PlatformError('telegram_403_blocked');
    const editGone = description.includes('message to edit not found') || description.includes("can't be edited");
    throw new PlatformError(`telegram_${status}`, {editGone});
  }

  async start() {
    const me = await this.call('getMe');
    this.me = me;
    return {id: String(me.id), username: me.username, display_name: me.first_name};
  }

  // Telegram update → inbound event (channel-adapter.v1 §3.1, §4.4), or null.
  eventFromUpdate(update) {
    const me = this.me;
    // v1.2 §10.8: the bot left or was removed from a group.
    if (update.my_chat_member) {
      const change = update.my_chat_member;
      const chat = chatOf(change.chat);
      if (!chat || chat.kind === 'dm' || String(change.new_chat_member?.user?.id) !== String(me.id)) return null;
      return GONE.has(change.new_chat_member.status) ? {requestID: `tg:${me.id}:u:${update.update_id}`, chat, left: true} : null;
    }
    if (update.callback_query) {
      const query = update.callback_query;
      const chat = query.message?.chat;
      return {
        requestID: `tg:${me.id}:cb:${query.id}`, callbackID: query.id,
        sender: sender(query.from), chat: chat ? chatOf(chat) : null, addressed: true,
        messageID: query.message ? String(query.message.message_id) : null, button: query.data ?? '',
      };
    }
    const message = update.message;
    if (!message || message.from?.is_bot) return null;
    const chat = chatOf(message.chat);
    if (!chat) return null;
    let text = message.text ?? message.caption ?? '';
    const entities = message.entities ?? message.caption_entities ?? [];
    const username = (me.username ?? '').toLowerCase();
    let addressed = chat.kind === 'dm' || message.reply_to_message?.from?.id === me.id;
    let command = null, payload = '', foreign = false;
    const strip = [];
    for (const entity of entities) {
      const piece = text.slice(entity.offset, entity.offset + entity.length);
      if (entity.type === 'mention' && piece.slice(1).toLowerCase() === username) { addressed = true; strip.push(entity); }
      else if (entity.type === 'text_mention' && entity.user?.id === me.id) { addressed = true; strip.push(entity); }
      else if (entity.type === 'bot_command' && entity.offset === 0) {
        const [name, target] = piece.slice(1).split('@');
        if (target && target.toLowerCase() !== username) foreign = true;
        else {
          if (target) addressed = true;
          // `/owner@<bot> CODE` is matched as `/owner CODE` (§10.7).
          if (target && name.toLowerCase() === 'owner') strip.push({offset: entity.offset + 1 + name.length, length: target.length + 1});
          if (name === 'start' || name === 'new') {
            command = name;
            payload = text.slice(entity.length).trim();
          }
        }
      }
    }
    if (foreign && !strip.length && chat.kind !== 'dm') addressed = false;
    for (const entity of [...strip].sort((a, b) => b.offset - a.offset))
      text = text.slice(0, entity.offset) + text.slice(entity.offset + entity.length);
    return {
      requestID: `tg:${me.id}:u:${update.update_id}`,
      sender: sender(message.from), chat, addressed,
      messageID: String(message.message_id),
      text: text.trim(),
      attachment: ATTACHMENTS.some(kind => message[kind] !== undefined),
      command, payload,
      replyToMessageID: message.reply_to_message ? String(message.reply_to_message.message_id) : null,
    };
  }

  // Long polling. The offset moves past an update only after the inbound pipeline
  // journaled it (§6.1), so a crash re-reads it and re-sends the same request_id.
  async listen(inbound, journal, signal, onHealth = () => {}) {
    let attempt = 0;
    while (!signal.aborted) {
      let updates;
      try {
        updates = await this.call('getUpdates', {
          offset: journal.offset ?? undefined, timeout: this.pollTimeout, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
        }, {signal});
        attempt = 0;
        onHealth('connected');
      } catch (error) {
        if (signal.aborted) return;
        if (!(error instanceof PlatformError) || error.tokenInvalid) throw error;
        onHealth('degraded', error.code, error.reason);
        this.log('telegram_poll_failed', {code: error.code, reason: error.reason});
        // A conflict only clears when the person acts (webhook removed, other poller
        // stopped): keep trying, at most every 5 minutes.
        const max = error.code === 'telegram_409' ? CONFLICT_BACKOFF_MAX : undefined;
        await sleep(Math.max(error.retryAfter * 1000, backoff(attempt++, this.backoffBase, max)), signal);
        continue;
      }
      for (const update of updates) {
        const event = this.eventFromUpdate(update);
        if (event?.chat || event?.callbackID) {
          if (event.chat) await inbound.handleSafely(event);
          else await this.toast(event, null).catch(() => {});
        }
        journal.setOffset(update.update_id + 1);
        if (signal.aborted) return;
      }
    }
  }

  // Ops shared with the core.
  async send(chat, text, {buttons = [], replyTo = null} = {}) {
    const params = {chat_id: chat.id, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}};
    if (buttons.length) params.reply_markup = {inline_keyboard: buttons.map(button => [button.token
      ? {text: button.label, callback_data: button.token} : {text: button.label, url: button.url}])};
    if (replyTo) params.reply_parameters = {message_id: Number(replyTo), allow_sending_without_reply: true};
    const message = await this.call('sendMessage', params);
    return String(message.message_id);
  }

  async edit(chat, messageID, text) {
    try {
      await this.call('editMessageText', {
        chat_id: chat.id, message_id: Number(messageID), text, parse_mode: 'HTML',
        link_preview_options: {is_disabled: true}, reply_markup: {inline_keyboard: []},
      });
    } catch (error) {
      if (error.code !== 'telegram_not_modified') throw error;
    }
    return String(messageID);
  }

  // §10.11, cached per chat; a failed lookup is cached too and the count omitted.
  async memberCount(chat) {
    const cached = this.memberCounts.get(chat.id);
    if (cached && Date.now() - cached.at < MEMBER_COUNT_TTL_MS) return cached.count;
    let count = null;
    try { count = await this.call('getChatMemberCount', {chat_id: chat.id}); }
    catch (error) {
      if (error?.tokenInvalid) throw error;
      this.log('telegram_member_count_failed', {code: error?.code});
    }
    if (!Number.isInteger(count)) count = null;
    this.memberCounts.set(chat.id, {count, at: Date.now()});
    return count;
  }

  async deleteMessage(chat, messageID) {
    if (!messageID) return false;
    try { return Boolean(await this.call('deleteMessage', {chat_id: chat.id, message_id: Number(messageID)})); }
    catch { return false; }
  }

  async toast(event, text) {
    if (!event.callbackID) return;
    const params = {callback_query_id: event.callbackID};
    if (text) params.text = String(text).slice(0, 200);
    await this.call('answerCallbackQuery', params);
  }

  ops() {
    return {
      say: (chat, text, {replyTo} = {}) => this.send(chat, text, {replyTo}),
      sayPrivately: (event, text) => this.send(event.chat, text, {replyTo: event.messageID}),
      deleteMessage: (chat, id) => this.deleteMessage(chat, id),
      toast: (event, text) => this.toast(event, text),
      memberCount: chat => this.memberCount(chat),
    };
  }
}

function chatOf(chat) {
  if (chat.type === 'private') return {id: String(chat.id), kind: 'dm'};
  if (chat.type === 'group' || chat.type === 'supergroup') return {id: String(chat.id), kind: 'group', ...(chat.title ? {title: chat.title} : {})};
  return null;
}

function sender(user = {}) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return {id: String(user.id), ...(name ? {name} : {}), ...(user.username ? {username: user.username} : {})};
}
