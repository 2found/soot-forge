// Outbox consumer (channel-adapter.v1 §4.7–4.9, §6.2–6.4): SSE with Last-Event-ID
// resume, 45 s silence reconnect, per-chat ordered delivery, journal-first dedup by
// receipt_id and batched acks.
import {EXIT_OK, ExitError, PlatformError, backoff, sleep} from './errors.mjs';
import {renderItem} from './render.mjs';

const KNOWN = new Set(['reply', 'attention', 'attention_resolved', 'brief', 'notice']);
const IN_PLACE = new Set(['question', 'decision']);

// §9.6 adapter lock: outside a DM only a question/decision with an asker, its
// resolution, notices and replies are posted. v1.2 §10.9 widens it only for an item
// the host addressed to the owner chat (`place: "owner_chat"`). A refusal only: the
// choices shown are still exactly the item's, never inferred from its kind.
function refusedOutsideDM(item) {
  if (item.chat.kind === 'dm') return false;
  if (item.kind === 'brief') return true;
  if (item.kind !== 'attention') return false;
  if (item.attention?.place === 'owner_chat') return false;
  return !IN_PLACE.has(item.attention?.kind) || !item.attention?.asker;
}

export class Outbox {
  // platform: {name, send(chat, text, {buttons, replyTo}) → id, edit(chat, id, text) → id}
  constructor({client, journal, platform, getSession, log = () => {}, onHealth = () => {},
    silenceMs = 45_000, ackDelayMs = 200, backoffBase = 1000, backoffMax = 60_000, onConnectionLost = async () => {}}) {
    Object.assign(this, {client, journal, platform, getSession, log, onHealth, silenceMs, ackDelayMs, backoffBase, backoffMax, onConnectionLost});
    this.queues = new Map();
    this.pending = [];           // [{seq, done}] in arrival order; the cursor follows the done prefix
    this.acks = [];              // [{ack, entry}]
    this.ackTimer = null;
    this.flushing = Promise.resolve();
    this.stopping = false;
  }

  async run(signal) {
    this.signal = signal;
    let attempt = 0;
    while (!signal.aborted) {
      const outcome = await this.connect(signal);
      if (signal.aborted) break;
      if (outcome === 'closed') { attempt = 0; continue; }
      await sleep(backoff(attempt++, this.backoffBase, this.backoffMax), signal);
      if (!signal.aborted) await this.onConnectionLost();
    }
  }

  // One stream connection. Returns 'closed' (server ended it: reconnect at once) or 'error'.
  async connect(signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, {once: true});
    let silence;
    const arm = () => { clearTimeout(silence); silence = setTimeout(() => { this.log('outbox_silence'); controller.abort(); }, this.silenceMs); };
    try {
      const headers = this.client.headers({accept: 'text/event-stream'});
      if (this.journal.cursor !== null) headers['last-event-id'] = String(this.journal.cursor);
      arm();
      const response = await this.client.fetch(this.client.api + '/v1/channel/outbox/stream', {headers, signal: controller.signal});
      if (response.status === 401) throw new ExitError(EXIT_OK, 'credential_invalid');
      if (response.status === 409) throw new ExitError(EXIT_OK, 'stream_taken');
      if (response.status !== 200 || !response.body) {
        this.log('outbox_stream_status', {status: response.status});
        await response.body?.cancel().catch(() => {});
        return 'error';
      }
      const decoder = new TextDecoder();
      let buffer = '', event = {};
      for await (const chunk of response.body) {
        arm();
        buffer += decoder.decode(chunk, {stream: true});
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line === '') { this.dispatch(event); event = {}; continue; }
          if (line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon < 0 ? line : line.slice(0, colon);
          const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'data') event.data = event.data === undefined ? value : event.data + '\n' + value;
          else if (field === 'id' || field === 'event') event[field] = value;
        }
      }
      return 'closed';
    } catch (error) {
      if (error instanceof ExitError) throw error;
      if (!signal.aborted) this.log('outbox_stream_error', {name: error?.name});
      return 'error';
    } finally {
      clearTimeout(silence);
      signal.removeEventListener('abort', abort);
    }
  }

  dispatch(event) {
    if ((event.event ?? 'message') !== 'item' || event.data === undefined) return;
    let item;
    try { item = JSON.parse(event.data); } catch { this.log('outbox_bad_item'); return; }
    if (!item?.receipt_id || !item.chat?.id) { this.log('outbox_bad_item'); return; }
    const entry = {seq: Number(item.seq ?? event.id), done: false};
    this.pending.push(entry);
    const key = String(item.chat.id);
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(() => this.process(item, entry)).catch(error => this.fail(error));
    this.queues.set(key, next);
    next.finally(() => { if (this.queues.get(key) === next) this.queues.delete(key); });
  }

  fail(error) {
    // Exit conditions (token rejected, credential dead) surface through run()'s caller.
    if (!this.fatal) this.fatal = error;
    this.onFatal?.(error);
  }

  async process(item, entry) {
    if (this.stopping) return;   // not started: the host redelivers it
    const ack = await this.deliver(item);
    this.queueAck(ack, entry);
  }

  async deliver(item) {
    const receipt = item.receipt_id;
    if (!KNOWN.has(item.kind)) return {receipt_id: receipt, status: 'skipped'};
    if (refusedOutsideDM(item)) return {receipt_id: receipt, status: 'skipped'};
    const journaled = this.journal.delivered(receipt);
    if (journaled) return {receipt_id: receipt, status: 'delivered', platform_message_ids: journaled};
    let rendered;
    try { rendered = renderItem(item, {platform: this.platform.name, copy: this.getSession()?.copy}); }
    catch (error) {
      // A malformed item would crash the adapter on every redelivery: give it up.
      this.log('outbox_render_failed', {receipt_id: receipt, kind: item.kind, name: error?.name});
      return {receipt_id: receipt, status: 'failed', error: {code: 'render_failed', retryable: false}};
    }
    let ids;
    try {
      ids = item.kind === 'attention_resolved' ? await this.resolve(item, rendered) : [await this.platform.send(item.chat, rendered.text, {
        buttons: rendered.buttons, replyTo: item.in_reply_to?.platform_message_id ?? null,
      })];
    } catch (error) {
      if (!(error instanceof PlatformError) || error.tokenInvalid) throw error;
      this.onHealth('degraded', error.code, error.reason);
      this.log('outbox_platform_failed', {receipt_id: receipt, code: error.code, retryable: error.retryable});
      return {receipt_id: receipt, status: 'failed', error: {code: error.code, retryable: error.retryable}};
    }
    this.journal.recordDelivery(receipt, item.chat.id, ids);
    this.onHealth('connected');
    return {receipt_id: receipt, status: 'delivered', platform_message_ids: ids.map(String)};
  }

  // Edit every message that showed the item; a message that cannot be edited any
  // more gets the text as a new post instead (§4.8).
  async resolve(item, rendered) {
    const ids = [];
    const repost = () => this.platform.send(item.chat, rendered.text, {buttons: [], replyTo: item.in_reply_to?.platform_message_id ?? null});
    const targets = (item.resolved?.edit ?? []).flatMap(edit => edit.platform_message_ids ?? []);
    for (const id of targets) {
      try {
        ids.push(String(await this.platform.edit(item.chat, id, rendered.text)));
      } catch (error) {
        if (!(error instanceof PlatformError) || error.retryable || error.tokenInvalid) throw error;
        ids.push(String(await repost()));
      }
    }
    if (!targets.length) ids.push(String(await repost()));
    return ids;
  }

  queueAck(ack, entry) {
    this.acks.push({ack, entry});
    const batch = this.getSession()?.limits?.ack_batch ?? 100;
    if (this.acks.length >= batch) this.flush();
    else if (!this.ackTimer) this.ackTimer = setTimeout(() => this.flush(), this.ackDelayMs);
  }

  flush() {
    clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.flushing = this.flushing.then(async () => {
      while (this.acks.length) {
        const batch = this.acks.splice(0, this.getSession()?.limits?.ack_batch ?? 100);
        const {status, body} = await this.client.post('/v1/channel/outbox/ack', {acks: batch.map(entry => entry.ack)});
        if (status !== 200) this.log('outbox_ack_status', {status, code: body?.code});
        for (const result of body?.results ?? []) if (result?.ok === false) this.log('outbox_ack_refused', {receipt_id: result.receipt_id, code: result.code});
        for (const {entry} of batch) entry.done = true;
        this.advance();
      }
    }).catch(error => this.fail(error));
    return this.flushing;
  }

  advance() {
    let seq = null;
    while (this.pending.length && this.pending[0].done) seq = this.pending.shift().seq;
    if (seq !== null && Number.isFinite(seq)) this.journal.setCursor(seq);
  }

  // SIGTERM: let in-flight deliveries finish, then send their acks.
  async drain() {
    this.stopping = true;
    await Promise.allSettled([...this.queues.values()]);
    await this.flush();
  }
}
