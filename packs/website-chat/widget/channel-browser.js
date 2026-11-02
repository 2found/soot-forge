// @tofound/soot-sdk@0.6.0 channel/browser, vendored by scripts/sync-web-chat.mjs; do not edit.
// ---- ../errors.js ----
/**
 * A refusal or failure of a `./channel` call. `code` is the host's
 * `{code}` (channel-adapter §3) or one of the SDK's own client-side codes:
 * `invalid_request`, `invalid_answer` (refused before any wire call),
 * `unknown_seq`, `closed`, `stream_busy`, `contract_mismatch`,
 * `binding_mismatch`, `unavailable` (retries exhausted), `stream_ended`.
 * `status` is the HTTP status, or 0 for a client-side code.
 */
class ChannelError extends Error {
    code;
    status;
    /** The host's error body when there was one. */
    body;
    /** Seconds the host asked to wait (429/503), when given. */
    retryAfter;
    constructor(code, status, message, body) {
        super(message ?? body?.error ?? code);
        this.name = 'ChannelError';
        this.code = code;
        this.status = status;
        if (body)
            this.body = body;
        if (typeof body?.retry_after === 'number')
            this.retryAfter = body.retry_after;
    }
    /**
     * Fatal refusals are never retried by the SDK: the credential is gone or
     * refused (401), the call is not allowed (403), or the request is wrong
     * (400/404/405/409/413/422). Network errors, 429, 5xx and `409 stream_taken`
     * (the host still holds an earlier stream; §11.2) are transient.
     */
    get fatal() {
        if (this.status === 0)
            return !['unavailable', 'network'].includes(this.code);
        if (this.code === 'stream_taken')
            return false;
        return this.status < 500 && this.status !== 429 && this.status !== 408;
    }
}
/** Builds a ChannelError from a non-2xx response; never throws itself. */
async function errorFromResponse(res) {
    let body;
    try {
        const parsed = await res.json();
        if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string')
            body = parsed;
    }
    catch { /* not JSON */ }
    const retry = Number(res.headers.get('retry-after'));
    if (body && body.retry_after === undefined && Number.isFinite(retry) && retry > 0)
        body = { ...body, retry_after: retry };
    return new ChannelError(body?.code ?? (res.status >= 500 ? 'unavailable' : `http_${res.status}`), res.status, body?.error ?? `HTTP ${res.status}`, body);
}

// ---- ../sse.js ----
// Minimal Server-Sent Events reader over a fetch body (WHATWG streams; Node,
// Bun). Yields one event per blank-line-terminated block; comments (`: ping`)
// only reset the idle timer.
async function* readSSE(body, onBytes) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let event = '';
    let data = [];
    let id;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            onBytes();
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
                if (line === '') {
                    if (data.length)
                        yield { event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}) };
                    event = '';
                    data = [];
                    id = undefined;
                    continue;
                }
                if (line.startsWith(':'))
                    continue;
                const c = line.indexOf(':');
                const field = c < 0 ? line : line.slice(0, c);
                const val = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
                if (field === 'event')
                    event = val;
                else if (field === 'data')
                    data.push(val);
                else if (field === 'id')
                    id = val;
            }
        }
    }
    finally {
        reader.cancel().catch(() => { });
    }
}

// ---- ../timing.js ----
// Internal timing of the `./channel` client. Values follow channel-adapter
// §4.7 (reconnect, heartbeat) and §3 (backoff). Not a public option: retry and
// reconnect policy is fixed by the contract, not by the embedding product.
// Tests shrink these through `dist/channel/timing.js`.
const timing = {
    /** First backoff step and cap for network/5xx retries (§3: 1 s → 60 s, jitter). */
    backoffMinMs: 1000,
    backoffMaxMs: 60_000,
    /** Attempts for one POST/GET before `unavailable` (same request_id each time). */
    maxAttempts: 6,
    /** No bytes for this long on an open stream → reconnect (§4.7: 45 s). */
    idleMs: 45_000,
    /** Consecutive SSE failures before falling back to long-poll. */
    sseFailuresBeforePoll: 3,
    /** How long a fallback stays on long-poll before trying SSE again. */
    pollWindowMs: 60_000,
    /** Wait between empty outbox pages while long-polling. */
    pollIntervalMs: 2000,
    /** Acks issued within this window go out as one AckRequest (§4.9, ≤ 100). */
    ackLingerMs: 25,
    /** Status report while open, also without a stream (§4.2: at most once a minute). */
    statusIntervalMs: 60_000,
};
function backoff(attempt) {
    const base = Math.min(timing.backoffMaxMs, timing.backoffMinMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(base / 2 + Math.random() * (base / 2));
}
function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const t = setTimeout(done, ms);
        function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
        signal?.addEventListener('abort', done, { once: true });
    });
}

// ---- channel/browser/index.js ----
// `@tofound/soot-sdk/channel/browser` — browser mode of the channel-adapter
// contract (docs/contracts/channel-adapter.md §11.17, P6.1). A web page talks
// to its Soot directly: it opens its own `scc_` session on a `web` binding,
// anonymous or with a product assertion its backend signed, and then sends,
// streams and acks as that one sender. No binding secret ever reaches the
// browser, no Node API is imported, and requests carry no cookies
// (`credentials: 'omit'`). The host fixes the sender; this client never sends
// one.




/** True for a `run` stream event (typing indicator); false for an outbox item, which needs an ack. */
export function isRunEvent(e) {
    return typeof e.seq !== 'number' && typeof e.active === 'boolean';
}
const visitorKey = (binding) => `soot.visitor.${binding}`;
// Renew this long before the host's expiry, so no call races it.
const renewEarlyMs = 60_000;
function randomID() {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
export class BrowserChannel {
    #base;
    #binding;
    #fetch;
    #assertion;
    #storage;
    #life = new AbortController();
    #opened;
    #visitor;
    #renewing;
    #cursor;
    #seen = new Set();
    constructor(o, f, opened, visitor) {
        this.#base = o.host.replace(/\/+$/, '');
        this.#binding = o.binding;
        this.#fetch = f;
        this.#assertion = o.assertion;
        this.#storage = o.storage;
        this.#opened = opened;
        this.#visitor = visitor;
    }
    /** Opens a browser session (`POST /v1/channel/session`). Throws `ChannelError` (401 `invalid_assertion` / `assertion_expired` / `assertion_replayed`, 403 `assertion_required`, 404 `unknown_binding`). */
    static async connect(o) {
        const f = o.fetch ?? globalThis.fetch.bind(globalThis);
        let visitor;
        try {
            visitor = o.storage?.getItem(visitorKey(o.binding)) ?? undefined;
        }
        catch {
            visitor = undefined;
        }
        const opened = await open(f, o.host.replace(/\/+$/, ''), o.binding, o.assertion, visitor);
        const ch = new BrowserChannel(o, f, opened, opened.visitor ?? visitor);
        ch.#keepVisitor();
        return ch;
    }
    /** Who the host says this session is; a page never chooses it. */
    get sender() { return this.#opened.sender; }
    /** `asserted` (signed-in, via a product assertion) or `anonymous`. */
    get level() { return this.#opened.level; }
    get expiresAt() { return new Date(this.#opened.expires_at); }
    /** The sender's default conversation (created on first use), or the open member-started `direct` one. */
    async conversation(kind = 'default') {
        return this.#call('POST', '/v1/channel/conversations', { request_id: randomID(), kind });
    }
    /** Sends the visitor's message. The host coalesces bursts and answers on the stream. */
    async send(m) {
        if (typeof m.text !== 'string' || m.text.trim() === '')
            throw new ChannelError('invalid_request', 0, 'text is empty');
        const body = { request_id: m.request_id ?? randomID(), conversation: m.conversation, message_id: m.message_id ?? randomID(), text: m.text };
        if (m.reply_to)
            body.reply_to = m.reply_to;
        return this.#call('POST', '/v1/channel/messages', body);
    }
    /** Records that an item was shown (`delivered`) or could not be (`failed`). Another sender's receipt is `unknown_receipt`. */
    async ack(receipt_id, status = 'delivered') {
        return this.#call('POST', '/v1/channel/outbox/ack', { acks: [{ receipt_id, status }] });
    }
    /**
     * The sender's outbox items and run events, as SSE with reconnect (resume
     * after the last seq seen) and renewal of an expired session. Ends when
     * `signal` aborts or the channel is closed; throws a fatal `ChannelError`.
     */
    async *stream(opts = {}) {
        const signal = anySignal(this.#life.signal, opts.signal);
        let failures = 0;
        while (!signal.aborted) {
            await this.#fresh();
            const ctl = new AbortController();
            const stop = () => ctl.abort();
            signal.addEventListener('abort', stop, { once: true });
            let idle;
            const touch = () => { clearTimeout(idle); idle = setTimeout(stop, timing.idleMs); };
            try {
                const headers = { Authorization: `Bearer ${this.#opened.session}`, Accept: 'text/event-stream' };
                if (this.#cursor !== undefined)
                    headers['Last-Event-ID'] = String(this.#cursor);
                const res = await this.#fetch(`${this.#base}/v1/channel/outbox/stream`, { method: 'GET', headers, credentials: 'omit', signal: ctl.signal });
                if (res.status === 401) {
                    await this.#renew();
                    continue;
                }
                if (!res.ok || !res.body)
                    throw await errorFromResponse(res);
                failures = 0;
                touch();
                for await (const ev of readSSE(res.body, touch)) {
                    if (ev.event === 'error') {
                        const code = safeJSON(ev.data)?.code;
                        if (code === 'session_expired') {
                            await this.#renew();
                            break;
                        }
                        throw new ChannelError(String(code ?? 'stream_ended'), 0, 'stream ended by host');
                    }
                    if (ev.event === 'run') {
                        const run = safeJSON(ev.data);
                        if (run)
                            yield run;
                        continue;
                    }
                    if (ev.event !== 'item')
                        continue;
                    const item = safeJSON(ev.data);
                    if (!item || typeof item.seq !== 'number')
                        continue;
                    this.#cursor = Math.max(this.#cursor ?? 0, item.seq);
                    if (this.#seen.has(item.seq))
                        continue;
                    this.#seen.add(item.seq);
                    if (this.#seen.size > 1000)
                        this.#seen.delete(this.#seen.values().next().value);
                    yield item;
                }
            }
            catch (e) {
                if (signal.aborted)
                    return;
                if (e instanceof ChannelError && e.fatal)
                    throw e;
                failures += 1;
                await sleep(backoff(failures), signal);
            }
            finally {
                clearTimeout(idle);
                signal.removeEventListener('abort', stop);
                ctl.abort();
            }
        }
    }
    /** One page of the outbox after `after` (long-poll fallback for pages that cannot stream). */
    async page(after = 0, limit = 100) {
        return this.#call('GET', `/v1/channel/outbox?after=${after}&limit=${limit}`);
    }
    /** Ends every open stream. The session expires on the host by itself. */
    close() { this.#life.abort(); }
    #keepVisitor() {
        if (!this.#visitor || this.#opened.level !== 'anonymous')
            return;
        try {
            this.#storage?.setItem(visitorKey(this.#binding), this.#visitor);
        }
        catch { /* storage blocked: the visitor is new next time */ }
    }
    async #fresh() {
        if (Date.parse(this.#opened.expires_at) - Date.now() < renewEarlyMs)
            await this.#renew();
    }
    async #renew() {
        this.#renewing ??= (async () => {
            try {
                this.#opened = await open(this.#fetch, this.#base, this.#binding, this.#assertion, this.#visitor);
                if (this.#opened.visitor)
                    this.#visitor = this.#opened.visitor;
                this.#keepVisitor();
            }
            finally {
                this.#renewing = undefined;
            }
        })();
        return this.#renewing;
    }
    async #call(method, path, body) {
        await this.#fresh();
        const raw = body === undefined ? undefined : JSON.stringify(body);
        let renewed = false;
        for (let attempt = 1;; attempt++) {
            let res;
            try {
                res = await this.#fetch(`${this.#base}${path}`, {
                    method, credentials: 'omit', signal: this.#life.signal, body: raw,
                    headers: { Authorization: `Bearer ${this.#opened.session}`, ...(raw ? { 'Content-Type': 'application/json' } : {}) },
                });
            }
            catch (e) {
                if (this.#life.signal.aborted)
                    throw new ChannelError('closed', 0, 'channel closed');
                if (attempt >= timing.maxAttempts)
                    throw new ChannelError('unavailable', 0, String(e));
                await sleep(backoff(attempt), this.#life.signal);
                continue;
            }
            if (res.ok)
                return (await res.json());
            if (res.status === 401 && !renewed) {
                renewed = true;
                await this.#renew();
                continue;
            }
            const err = await errorFromResponse(res);
            if (err.fatal || attempt >= timing.maxAttempts)
                throw err;
            await sleep(err.retryAfter ? err.retryAfter * 1000 : backoff(attempt), this.#life.signal);
        }
    }
}
async function open(f, base, binding, src, visitor) {
    const assertion = typeof src === 'function' ? await src() : src;
    const body = { binding };
    if (assertion)
        body.assertion = assertion;
    else if (visitor)
        body.visitor = visitor;
    const res = await f(`${base}/v1/channel/session`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.status !== 201)
        throw await errorFromResponse(res);
    const out = (await res.json());
    if (typeof out.session !== 'string' || !out.session.startsWith('scc_'))
        throw new ChannelError('contract_mismatch', 0, 'no scc_ session in the reply');
    return out;
}
function safeJSON(s) {
    try {
        const v = JSON.parse(s);
        return v && typeof v === 'object' ? v : undefined;
    }
    catch {
        return undefined;
    }
}
function anySignal(...signals) {
    const ctl = new AbortController();
    for (const s of signals) {
        if (!s)
            continue;
        if (s.aborted) {
            ctl.abort();
            break;
        }
        s.addEventListener('abort', () => ctl.abort(), { once: true });
    }
    return ctl.signal;
}
export { ChannelError };
// Test seam, as the SDK's own tests shrink dist/channel/timing.js; a page never sets it.
export { timing };
