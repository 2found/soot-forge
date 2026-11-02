// Soot website chat, browser mode (channel-adapter §11.17): the session the
// shared chat frame talks to, over the SDK's BrowserChannel instead of the
// /public/v1 app API. It answers the same calls the live-chat loader makes of
// SootChatSession (readState, init, client.getAppInfo/getConversation/
// getMessages, reconcile, sendMessage, saveDraft, reset, setLanguage, answer)
// with the same shapes, so the frame behaves the same on either widget.
//
// The host keeps the conversation; the browser keeps only what it showed: a
// local transcript (capped), the pending message receipt and the draft. A send
// is persisted with its request id before the POST and a Resend reuses that
// id, so a retry after a reload is answered once (the host dedupes, §11.7).
import { BrowserChannel, ChannelError, isRunEvent } from './channel-browser.js';

const TRANSCRIPT_CAP = 200;
const MAX_TEXT = 12 * 1024;
// Outbox kinds a visitor reads as a line in the chat. Everything else is
// acked `skipped`, as the contract asks of unknown kinds.
const SHOWN = new Set(['reply', 'message', 'notice', 'attention', 'brief', 'direct']);

/** An error the loader words like the old API's: it reads `status`. */
const statusError = (status, code, message) => Object.assign(new Error(message ?? code), { status, code });

function randomID() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** Maps a ChannelError onto the HTTP-status vocabulary the frame already words. */
export function wordable(err) {
  if (!(err instanceof ChannelError)) return err;
  // A refused or expired product assertion is the old "session expired":
  // the frame offers a new conversation. 403 assertion_required too — the
  // page must sign the visitor in first.
  if (err.status === 401 || err.status === 403) return statusError(401, err.code, err.message);
  if (err.status === 429) return statusError(429, err.code, err.message);
  if ([400, 413, 422].includes(err.status) || err.code === 'invalid_request') return statusError(400, err.code, err.message);
  return statusError(err.status || 503, err.code, err.message);
}

export class WebChatSession {
  #o;
  #storage;
  #key;
  #channel = null;
  #opening = null;
  #handle = null;
  #streaming = null;
  #active = false;
  #since = '';
  // Counts stream events, so a send answered before its POST returned is not shown as still running.
  #events = 0;
  #queue = Promise.resolve();
  #language;

  /**
   * @param {{ host: string, binding: string, assertion?: string | (() => Promise<string | undefined> | string | undefined),
   *   storage?: Storage, fetch?: typeof fetch, language?: 'vi' | 'en', widget?: object, name?: string }} o
   */
  constructor(o) {
    if (!o?.host || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(o.binding ?? '')) throw new TypeError('host and a binding id are required');
    this.#o = o;
    this.#storage = o.storage ?? globalThis.localStorage;
    this.#key = `soot.webchat.v1:${new URL(o.host).origin}:${o.binding}`;
    this.#language = o.language;
    const self = this;
    this.client = {
      // Appearance is the product's: the page passes it in, nothing is fetched.
      async getAppInfo() {
        return { widget: { ...(self.#o.widget ?? {}) }, soots: [{ id: self.#o.binding, name: self.#o.name ?? self.#o.widget?.name }], capabilities: [] };
      },
      async getConversation(id) {
        self.#own(id);
        const messages = self.#read().messages.filter(m => !m.hidden);
        return {
          id, soot: self.#o.binding, state: self.#active ? 'running' : 'idle',
          progress: self.#active ? { run: id, phase: 'thinking', steps: 0, since: self.#since } : null,
          message_cursor: messages.at(-1)?.id ?? 0, pointers: [],
        };
      },
      async getMessages(id, { after = 0, limit = 50 } = {}) {
        self.#own(id);
        const page = self.#read().messages.filter(m => !m.hidden && m.id > after).slice(0, Math.max(1, Math.min(limit, 100)));
        return { messages: page.map(({ rid, receipt, hidden, ...m }) => m), next_after: page.at(-1)?.id ?? after };
      },
    };
  }

  get channel() { return this.#channel; }

  setLanguage(language) {
    if (language !== 'en' && language !== 'vi') throw new TypeError('Invalid conversation language');
    this.#language = language;
  }

  #read() {
    let parsed = {};
    try { parsed = JSON.parse(this.#storage?.getItem(this.#key) || '{}') ?? {}; } catch { parsed = {}; }
    return {
      // A returning visitor: the loader reconnects (and reconciles) on load.
      session: parsed.session ?? null,
      conversationId: parsed.conversationId ?? null,
      pendingMessage: parsed.pendingMessage ?? null,
      pendingAnswer: null,
      draft: typeof parsed.draft === 'string' ? parsed.draft : '',
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
    };
  }
  #write(state) {
    // No send is admitted when its receipt cannot survive a reload: a throw here is a send error.
    this.#storage.setItem(this.#key, JSON.stringify(state));
  }
  #own(id) { if (!id || id !== this.#read().conversationId) throw statusError(404, 'not_found'); }

  readState() {
    const { messages, ...state } = this.#read();
    return state;
  }

  #lock(fn) {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Opens the browser session and the visitor's default conversation, then starts the stream. */
  async #open() {
    if (this.#channel && this.#handle) return;
    this.#opening ??= (async () => {
      try {
        const channel = await BrowserChannel.connect({ host: this.#o.host, binding: this.#o.binding, assertion: this.#o.assertion, storage: this.#storage, fetch: this.#o.fetch });
        const conv = await channel.conversation('default');
        const state = this.#read();
        // A different conversation (another signed-in person, a reset visitor) starts a new local transcript.
        if (state.conversationId && state.conversationId !== conv.handle) { state.messages = []; state.pendingMessage = null; }
        state.conversationId = conv.handle;
        state.session = { level: channel.level };
        this.#write(state);
        this.#channel = channel;
        this.#handle = conv.handle;
        this.#stream(channel);
      } catch (err) { throw wordable(err); } finally { this.#opening = null; }
    })();
    return this.#opening;
  }

  #stream(channel) {
    const loop = async () => {
      try {
        for await (const ev of channel.stream()) {
          this.#events++;
          if (isRunEvent(ev)) {
            if (ev.conversation && ev.conversation !== this.#handle) continue;
            if (ev.active && !this.#active) this.#since = new Date().toISOString();
            this.#active = ev.active;
            continue;
          }
          await this.#deliver(channel, ev);
        }
      } catch { /* fatal: the next init reconnects */ }
      if (this.#channel === channel) { this.#channel = null; this.#handle = null; this.#active = false; }
    };
    this.#streaming = loop();
  }

  /** Shows an outbox item once (by receipt), then acks it. */
  async #deliver(channel, item) {
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const shown = SHOWN.has(item.kind) && text !== '' && (!item.conversation || item.conversation === this.#handle);
    if (shown) {
      try {
        const state = this.#read();
        if (!state.messages.some(m => m.receipt === item.receipt_id)) {
          const member = !!item.speaker;
          state.messages.push({
            id: (state.messages.at(-1)?.id ?? 0) + 1, receipt: item.receipt_id,
            role: member ? 'user' : 'assistant', ...(member ? { actor_role: 'member' } : {}),
            text, created: item.created_at,
          });
          state.messages = state.messages.slice(-TRANSCRIPT_CAP);
          this.#write(state);
        }
        if (item.kind === 'reply' || item.kind === 'message') this.#active = false;
      } catch {
        // Could not keep it on this device: tell the host it was not shown.
        await channel.ack(item.receipt_id, 'failed').catch(() => {});
        return;
      }
    }
    await channel.ack(item.receipt_id, shown ? 'delivered' : 'skipped').catch(() => {});
  }

  async init() {
    const appInfo = await this.client.getAppInfo();
    await this.#open();
    const state = await this.reconcile();
    return { appInfo, state };
  }

  /**
   * Reconnects. An unconfirmed message stays pending, as on the old widget:
   * nothing is sent without the visitor's Resend, and that Resend reuses the
   * message's request id, so an admitted-but-unconfirmed message is answered
   * once (the host replies `duplicate`). The channel has no receipt lookup,
   * so the old widget's silent settle of such a message becomes one tap.
   */
  reconcile() {
    return this.#lock(async () => {
      await this.#open();
      const { messages, ...out } = this.#read();
      return out;
    });
  }

  async #post(state) {
    const pending = state.pendingMessage;
    const mark = this.#events;
    let accepted;
    try {
      accepted = await this.#channel.send({ conversation: this.#handle, text: pending.text, request_id: pending.id, message_id: pending.id });
    } catch (err) {
      const e = wordable(err);
      // A definitive refusal admitted nothing: keep the draft editable, drop the receipt.
      if (e.status === 400) { const s = this.#read(); s.pendingMessage = null; s.messages = s.messages.filter(m => m.rid !== pending.id); this.#write(s); }
      throw e;
    }
    const s = this.#read();
    const line = s.messages.find(m => m.rid === pending.id);
    if (line) delete line.hidden;
    else s.messages = [...s.messages, { id: (s.messages.at(-1)?.id ?? 0) + 1, rid: pending.id, role: 'user', text: pending.text, created: new Date().toISOString() }].slice(-TRANSCRIPT_CAP);
    s.pendingMessage = null;
    s.draft = '';
    this.#write(s);
    // Working until the stream says otherwise, unless it already answered.
    if (!this.#active && this.#events === mark) { this.#active = true; this.#since = new Date().toISOString(); }
    return accepted;
  }

  sendMessage(text) {
    const trimmed = typeof text === 'string' ? text.trim() : '';
    if (!trimmed) return Promise.reject(new Error('Message cannot be empty'));
    if (new TextEncoder().encode(trimmed).length > MAX_TEXT) return Promise.reject(statusError(400, 'invalid_request', 'Message too long'));
    return this.#lock(async () => {
      await this.#open();
      const state = this.#read();
      if (!state.pendingMessage) {
        // The visitor's line takes its place now, hidden until the host accepts
        // it, so a reply that streams in before the POST returns sorts after it.
        const id = randomID();
        state.pendingMessage = { id, text: trimmed };
        state.messages = [...state.messages, { id: (state.messages.at(-1)?.id ?? 0) + 1, rid: id, role: 'user', text: trimmed, created: new Date().toISOString(), hidden: true }].slice(-TRANSCRIPT_CAP);
        state.draft = text;
        this.#write(state);
      }
      return this.#post(this.#read());
    });
  }

  saveDraft(draft) {
    const state = this.#read();
    state.draft = draft;
    this.#write(state);
  }

  /** Question cards are not part of browser mode yet; the frame never shows one here. */
  async answer() { throw new Error('Answers are not supported in browser mode'); }

  /**
   * A new conversation, from this device's view: the stream closes, the local
   * transcript and receipts go, and an anonymous visitor becomes a new visitor.
   * A signed-in person keeps their host conversation; only this device forgets.
   */
  reset() {
    return this.#lock(async () => {
      this.#channel?.close();
      this.#channel = null; this.#handle = null; this.#active = false;
      await this.#streaming?.catch(() => {});
      this.#storage.removeItem(this.#key);
      try { this.#storage.removeItem(`soot.visitor.${this.#o.binding}`); } catch {}
    });
  }

  /** Ends the stream (page unload, tests). */
  close() { this.#channel?.close(); }
}
