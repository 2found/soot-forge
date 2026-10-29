// Discord side: Gateway (identify, resume, heartbeat, reconnect) for inbound, REST for
// messages and interaction responses.
import {PlatformError, backoff, sleep} from '../core/errors.mjs';

// GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);
const THREAD_TYPES = new Set([10, 11, 12]);
// Close codes that no reconnect can fix → StatusReport reason (§9.4), then exit 78.
const FATAL_CLOSE = new Map([
  [4004, 'platform_token_rejected'],
  [4014, 'discord_intents_disallowed'],
  [4011, 'discord_sharding_required'],
  [4010, 'adapter_incompatible'], [4012, 'adapter_incompatible'], [4013, 'adapter_incompatible'],
]);
const FRESH_SESSION_CLOSE = new Set([4007, 4009]);
const STYLE = {primary: 1, danger: 4};

export class Discord {
  constructor({token, apiBase = 'https://discord.com/api/v10', gatewayUrl = null, WebSocket = globalThis.WebSocket,
    fetch = globalThis.fetch, log = () => {}, backoffBase = 1000}) {
    this.name = 'discord';
    this.token = token;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.gatewayUrl = gatewayUrl;
    this.WebSocket = WebSocket;
    this.fetch = fetch;
    this.log = log;
    this.backoffBase = backoffBase;
    this.me = null;
    this.applicationID = null;
    this.session = null;    // {id, resumeUrl}
    this.seq = null;
    this.channelTypes = new Map();
    this.dmChannels = new Map();
  }

  async rest(method, path, body) {
    let response;
    try {
      response = await this.fetch(this.apiBase + path, {
        method,
        headers: {authorization: `Bot ${this.token}`, 'content-type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new PlatformError('discord_network', {retryable: true, reason: 'platform_unreachable'});
    }
    const parsed = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.ok) return parsed;
    const status = response.status;
    if (status === 401) throw new PlatformError('discord_401', {tokenInvalid: true, reason: 'platform_token_rejected'});
    if (status === 429) throw new PlatformError('discord_429', {retryable: true, retryAfter: Number(parsed?.retry_after) || 1, reason: 'platform_rate_limited'});
    if (status >= 500) throw new PlatformError(`discord_${status}`, {retryable: true, reason: 'platform_unreachable'});
    if (status === 403 && parsed?.code === 50007) throw new PlatformError('discord_403_blocked');
    throw new PlatformError(`discord_${status}`, {editGone: status === 404 || parsed?.code === 50005});
  }

  async start() {
    const me = await this.rest('GET', '/users/@me');
    const application = await this.rest('GET', '/oauth2/applications/@me');
    this.me = me;
    this.applicationID = String(application.id);
    if (!this.gatewayUrl) this.gatewayUrl = (await this.rest('GET', '/gateway/bot')).url;
    return {id: String(me.id), username: me.username, display_name: me.global_name ?? me.username};
  }

  // Gateway MESSAGE_CREATE → inbound event, or null.
  eventFromMessage(message) {
    if (!message || message.author?.bot || message.webhook_id) return null;
    const chat = this.chatOf(message);
    const botID = String(this.me.id);
    const mentioned = (message.mentions ?? []).some(user => String(user.id) === botID);
    const replied = message.referenced_message?.author && String(message.referenced_message.author.id) === botID;
    let text = String(message.content ?? '').replace(new RegExp(`<@!?${botID}>`, 'g'), ' ').trim();
    let command = null, payload = '';
    const slash = text.match(/^\/(new|start)(?:\s+([\s\S]*))?$/i);
    if (slash) { command = slash[1].toLowerCase(); payload = (slash[2] ?? '').trim(); text = ''; }
    return {
      requestID: `dc:${this.applicationID}:m:${message.id}`,
      sender: sender(message.author), chat,
      addressed: chat.kind === 'dm' || mentioned || Boolean(replied),
      messageID: String(message.id), text,
      attachment: Boolean(message.attachments?.length || message.sticker_items?.length),
      command, payload,
      replyToMessageID: message.message_reference?.message_id ? String(message.message_reference.message_id) : null,
    };
  }

  // Gateway INTERACTION_CREATE (message component) → inbound event, or null.
  eventFromInteraction(interaction) {
    if (interaction?.type !== 3) return null;
    return {
      requestID: `dc:${this.applicationID}:i:${interaction.id}`,
      sender: sender(interaction.member?.user ?? interaction.user), chat: this.chatOf(interaction),
      addressed: true, messageID: interaction.message?.id ? String(interaction.message.id) : null,
      button: interaction.data?.custom_id ?? '',
      interaction: {id: String(interaction.id), token: interaction.token},
    };
  }

  chatOf(source) {
    if (!source.guild_id) return {id: String(source.channel_id), kind: 'dm'};
    const type = source.channel?.type ?? this.channelTypes.get(String(source.channel_id));
    return {id: String(source.channel_id), kind: THREAD_TYPES.has(type) ? 'thread' : 'guild_channel', guild_id: String(source.guild_id)};
  }

  // Runs the Gateway until `signal` aborts. Rejects on a fatal close (bad token or
  // intents) or an exit raised by the inbound pipeline.
  async listen(inbound, journal, signal, onHealth = () => {}) {
    let attempt = 0;
    this.inboundChain = Promise.resolve();
    this.failure = null;
    while (!signal.aborted) {
      const {code, healthy} = await this.connect(inbound, signal, onHealth);
      if (this.failure) throw this.failure;
      if (signal.aborted) return;
      if (FATAL_CLOSE.has(code)) throw new PlatformError(`discord_gateway_${code}`, {tokenInvalid: true, reason: FATAL_CLOSE.get(code)});
      if (FRESH_SESSION_CLOSE.has(code)) { this.session = null; this.seq = null; }
      if (healthy) { attempt = 0; continue; }
      onHealth('degraded', `discord_gateway_${code ?? 'lost'}`, 'platform_unreachable');
      await sleep(backoff(attempt++, this.backoffBase), signal);
    }
  }

  connect(inbound, signal, onHealth) {
    return new Promise(resolve => {
      const base = this.session?.resumeUrl ?? this.gatewayUrl;
      const url = `${base}${base.includes('?') ? '&' : '?'}v=10&encoding=json`;
      let socket;
      try { socket = new this.WebSocket(url); } catch { return resolve({code: null}); }
      this.socket = socket;
      let beat = null, acked = true, healthy = false, settled = false;
      const finish = result => {
        if (settled) return;
        settled = true;
        result.healthy = healthy;
        clearTimeout(beat); clearInterval(beat);
        signal.removeEventListener('abort', onAbort);
        // 1000 ends the Discord session; any other code keeps it resumable.
        try { socket.close(signal.aborted ? 1000 : 4000); } catch {}
        resolve(result);
      };
      const onAbort = () => finish({code: null});
      signal.addEventListener('abort', onAbort, {once: true});
      const send = payload => { try { socket.send(JSON.stringify(payload)); } catch {} };
      const heartbeat = () => {
        if (!acked) { this.log('discord_zombie'); return finish({code: 'zombie'}); }
        acked = false;
        send({op: 1, d: this.seq});
      };
      socket.addEventListener('message', message => {
        let payload;
        try { payload = JSON.parse(typeof message.data === 'string' ? message.data : new TextDecoder().decode(message.data)); }
        catch { return; }
        if (payload.s !== null && payload.s !== undefined) this.seq = payload.s;
        switch (payload.op) {
          case 10: {
            const interval = payload.d.heartbeat_interval;
            beat = setTimeout(() => { heartbeat(); beat = setInterval(heartbeat, interval); }, Math.floor(interval * Math.random()));
            if (this.session) send({op: 6, d: {token: this.token, session_id: this.session.id, seq: this.seq}});
            else send({op: 2, d: {token: this.token, intents: INTENTS, properties: {os: process.platform, browser: 'soot-channel', device: 'soot-channel'}}});
            break;
          }
          case 11: acked = true; break;
          case 1: send({op: 1, d: this.seq}); break;
          case 7: finish({code: 'reconnect'}); break;
          case 9:
            if (!payload.d) { this.session = null; this.seq = null; }
            finish({code: 'invalid_session'});
            break;
          case 0: this.dispatch(payload.t, payload.d, inbound, onHealth, () => { healthy = true; }); break;
        }
      });
      socket.addEventListener('close', event => finish({code: event.code}));
      socket.addEventListener('error', () => finish({code: null}));
    });
  }

  dispatch(type, data, inbound, onHealth, markReady) {
    if (type === 'READY') {
      this.session = {id: data.session_id, resumeUrl: data.resume_gateway_url ?? null};
      if (data.application?.id) this.applicationID = String(data.application.id);
      markReady();
      onHealth('connected');
    } else if (type === 'RESUMED') {
      markReady();
      onHealth('connected');
    } else if (type === 'GUILD_CREATE') {
      for (const channel of [...(data.channels ?? []), ...(data.threads ?? [])]) this.channelTypes.set(String(channel.id), channel.type);
    } else if (type === 'CHANNEL_CREATE' || type === 'THREAD_CREATE' || type === 'CHANNEL_UPDATE') {
      this.channelTypes.set(String(data.id), data.type);
    } else if (type === 'MESSAGE_CREATE') {
      const event = this.eventFromMessage(data);
      if (event) this.enqueue(event, inbound);
    } else if (type === 'INTERACTION_CREATE') {
      const event = this.eventFromInteraction(data);
      if (!event) return;
      // Discord needs an answer within 3 s; the host's toast follows as an edit.
      this.rest('POST', `/interactions/${event.interaction.id}/${event.interaction.token}/callback`, {type: 5, data: {flags: 64}})
        .catch(error => this.log('discord_defer_failed', {code: error?.code}));
      this.enqueue(event, inbound);
    }
  }

  // Inbound events run one at a time in Gateway order.
  // An exit raised here (credential dead, token rejected) ends the Gateway loop.
  enqueue(event, inbound) {
    this.inboundChain = this.inboundChain.then(() => inbound.handleSafely(event)).catch(error => {
      this.failure ??= error;
      this.close();
    });
  }

  async send(chat, text, {buttons = [], replyTo = null} = {}) {
    const body = {content: text, allowed_mentions: {parse: []}};
    if (buttons.length) body.components = rows(buttons);
    // A threaded post may notify the person it answers, nobody else.
    if (replyTo) Object.assign(body, {message_reference: {message_id: String(replyTo), fail_if_not_exists: false}, allowed_mentions: {parse: [], replied_user: true}});
    const message = await this.rest('POST', `/channels/${chat.id}/messages`, body);
    return String(message.id);
  }

  async edit(chat, messageID, text) {
    await this.rest('PATCH', `/channels/${chat.id}/messages/${messageID}`, {content: text, components: [], allowed_mentions: {parse: []}});
    return String(messageID);
  }

  // A bot cannot delete the other person's message in a DM (§6.6: warn only).
  async deleteMessage(chat, messageID) {
    if (chat.kind === 'dm' || !messageID) return false;
    try { await this.rest('DELETE', `/channels/${chat.id}/messages/${messageID}`); return true; }
    catch { return false; }
  }

  async toast(event, text) {
    if (!event.interaction) return;
    const path = `/webhooks/${this.applicationID}/${event.interaction.token}/messages/@original`;
    if (text) await this.rest('PATCH', path, {content: String(text).slice(0, 200), allowed_mentions: {parse: []}});
    else await this.rest('DELETE', path).catch(() => {});
  }

  async sayPrivately(event, text) {
    let channel = this.dmChannels.get(event.sender.id);
    if (!channel) {
      channel = String((await this.rest('POST', '/users/@me/channels', {recipient_id: event.sender.id})).id);
      this.dmChannels.set(event.sender.id, channel);
    }
    return this.send({id: channel, kind: 'dm'}, text);
  }

  ops() {
    return {
      say: (chat, text, {replyTo} = {}) => this.send(chat, text, {replyTo}),
      sayPrivately: (event, text) => this.sayPrivately(event, text),
      deleteMessage: (chat, id) => this.deleteMessage(chat, id),
      toast: (event, text) => this.toast(event, text),
    };
  }

  close() { try { this.socket?.close(1000); } catch {} }
}

function rows(buttons) {
  const components = buttons.slice(0, 25).map(button => button.token
    ? {type: 2, style: STYLE[button.style] ?? 2, label: button.label.slice(0, 80), custom_id: button.token}
    : {type: 2, style: 5, label: button.label.slice(0, 80), url: button.url});
  const result = [];
  for (let i = 0; i < components.length; i += 5) result.push({type: 1, components: components.slice(i, i + 5)});
  return result;
}

function sender(user = {}) {
  const name = user.global_name ?? user.username;
  return {id: String(user.id), ...(name ? {name} : {}), ...(user.username ? {username: user.username} : {})};
}
