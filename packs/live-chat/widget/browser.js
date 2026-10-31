export class SootPublicHTTPError extends Error {
    status;
    errorBody;
    constructor(status, errorBody) {
        super(`Soot public API rejected request (${status})${errorBody ? `: ${errorBody}` : ''}`);
        this.status = status;
        this.errorBody = errorBody;
        this.name = 'SootPublicHTTPError';
    }
    /** The contract refusal code from a JSON error body (`already_resolved`, `moved_on`, …). */
    get code() {
        try {
            const body = JSON.parse(this.errorBody ?? '');
            const code = typeof body === 'object' && body !== null ? body.code : undefined;
            return typeof code === 'string' ? code : undefined;
        }
        catch {
            return undefined;
        }
    }
}
// ---- live-chat-attention v1 (docs/contracts/live-chat-attention.md) ----
/** Capability a runtime advertises when it serves question cards and pointers. */
export const LIVE_CHAT_ATTENTION_V1 = 'live-chat-attention-v1';
export const ANSWER_REFUSAL_CODES = ['not_asker', 'already_resolved', 'moved_on', 'item_gone', 'invalid_answer'];
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const shortText = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const POINTER_CLASSES = ['approval', 'team', 'not_ready', 'unavailable'];
function resolutionOf(raw) {
    if (!isRecord(raw) || (raw.outcome !== 'answered' && raw.outcome !== 'closed') || (raw.by !== 'asker' && raw.by !== 'team') || typeof raw.at !== 'string')
        return undefined;
    const labels = Array.isArray(raw.labels) && raw.outcome === 'answered' ? raw.labels.filter(l => shortText(l, 200)) : undefined;
    return { outcome: raw.outcome, ...(labels?.length ? { labels } : {}), by: raw.by, at: raw.at };
}
/**
 * The card a client may render, rebuilt from known fields only, or undefined.
 * A card that is not a question (a `kind` other than `question`, no options,
 * over the ask limits) is dropped: a customer never renders a team item
 * (contract §7, the second of the two locks).
 */
export function questionOf(raw) {
    if (!isRecord(raw) || (raw.kind !== undefined && raw.kind !== 'question'))
        return undefined;
    if (!shortText(raw.item, 128) || !shortText(raw.prompt, 2000) || typeof raw.multi !== 'boolean')
        return undefined;
    if (!Array.isArray(raw.options) || raw.options.length < 1 || raw.options.length > 8)
        return undefined;
    const options = [];
    for (const o of raw.options) {
        if (!isRecord(o) || !shortText(o.label, 200) || (o.description !== undefined && typeof o.description !== 'string'))
            return undefined;
        options.push({ label: o.label, ...(shortText(o.description, 200) ? { description: o.description } : {}) });
    }
    const resolution = raw.resolution === undefined ? undefined : resolutionOf(raw.resolution);
    if (raw.resolution !== undefined && !resolution)
        return undefined;
    return { item: raw.item, prompt: raw.prompt, options, multi: raw.multi, ...(resolution ? { resolution } : {}) };
}
// Only a team or approval pointer can be covered by a Soot-written reply.
const replyOf = (c, reply) => reply && (c === 'team' || c === 'approval');
/** A conversation detail's `pointers`, validated and ordered by `afterMessage`. */
export function pointersOf(raw) {
    if (!Array.isArray(raw))
        return [];
    return raw.flatMap(p => isRecord(p) && shortText(p.item, 128) && POINTER_CLASSES.includes(p.class) && typeof p.reply === 'boolean'
        && Number.isSafeInteger(p.after_message) ? [{ item: p.item, class: p.class, reply: replyOf(p.class, p.reply), afterMessage: p.after_message }] : [])
        .sort((a, b) => a.afterMessage - b.afterMessage);
}
export function waitingOf(raw) {
    return isRecord(raw) && (raw.on === 'asker' || raw.on === 'team') && typeof raw.reason === 'string' ? { on: raw.on, reason: raw.reason } : undefined;
}
/** The decoded `text` of an `attention.resolved` event, or undefined. */
export function attentionResolvedOf(text) {
    try {
        const raw = typeof text === 'string' ? JSON.parse(text) : undefined;
        if (!isRecord(raw) || raw.kind !== 'question' || !shortText(raw.item, 128))
            return undefined;
        const resolution = resolutionOf(raw);
        return resolution && { item: raw.item, ...resolution };
    }
    catch {
        return undefined;
    }
}
/** The decoded `text` of an `attention.pointer` event, or undefined. */
export function attentionPointerOf(text) {
    try {
        const raw = typeof text === 'string' ? JSON.parse(text) : undefined;
        if (!isRecord(raw) || !shortText(raw.item, 128) || !POINTER_CLASSES.includes(raw.class) || typeof raw.reply !== 'boolean')
            return undefined;
        return { item: raw.item, class: raw.class, reply: replyOf(raw.class, raw.reply) };
    }
    catch {
        return undefined;
    }
}
/** The answer text Nest and the runtime build: the chosen labels, ", "-joined. */
export function answerText(card, choices) {
    if (!validChoices(card, choices))
        throw new Error('Invalid answer');
    return choices.map(i => card.options[i].label).join(', ');
}
function validChoices(card, choices) {
    if (!Array.isArray(choices) || choices.length < 1 || new Set(choices).size !== choices.length)
        return false;
    if (!choices.every(c => Number.isSafeInteger(c) && c >= 0 && c < 8))
        return false;
    return !card || ((card.multi || choices.length === 1) && choices.every(c => c < card.options.length));
}
export class SootPublicTransportError extends Error {
    uncertain;
    constructor(uncertain, message) {
        super(message ??
            (uncertain
                ? 'Soot request outcome is uncertain; inspect before resubmitting'
                : 'Soot public API transport failed'));
        this.uncertain = uncertain;
        this.name = 'SootPublicTransportError';
    }
}
function validText(value, maxBytes) {
    if (typeof value !== 'string' || !value.trim())
        throw new Error('Invalid text');
    if (value.includes('\0'))
        throw new Error('Null byte forbidden');
    if (new TextEncoder().encode(value).byteLength > maxBytes) {
        throw new Error(`Text exceeds maximum byte size of ${maxBytes}`);
    }
}
function validSegment(id) {
    validText(id, 128);
    if (id === '.' || id === '..')
        throw new Error('Invalid path segment');
    return encodeURIComponent(id);
}
function validCursor(n) {
    if (!Number.isSafeInteger(n) || n < 0)
        throw new Error('Invalid cursor');
    return n;
}
function validRunID(value) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
        throw new Error('Invalid run ID');
    }
    return value;
}
async function readBodyText(response, maxBytes) {
    if (!response.body)
        return '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let size = 0;
    let result = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done)
                break;
            size += value.byteLength;
            if (size > maxBytes)
                throw new Error('Response byte limit exceeded');
            result += decoder.decode(value, { stream: true });
        }
        return result + decoder.decode();
    }
    finally {
        await reader.cancel().catch(() => { });
        reader.releaseLock();
    }
}
/**
 * Low-level HTTP client for /public/v1 endpoints.
 * Never includes credentials or X-Soot-User headers.
 */
export class SootPublicClient {
    #base;
    #appKey;
    #token;
    #fetch;
    #timeout;
    constructor(options) {
        const url = new URL(options.baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
            throw new Error('Invalid Soot API URL');
        }
        if (typeof options.appKey !== 'string' || !options.appKey.startsWith('spk_') || options.appKey.length < 24) {
            throw new Error('Invalid publishable app key (spk_ prefix required, min 24 chars)');
        }
        this.#base = url.href.replace(/\/$/, '');
        this.#appKey = options.appKey;
        this.#token = options.token;
        this.#timeout = options.timeoutMs ?? 15_000;
        if (!Number.isSafeInteger(this.#timeout) || this.#timeout < 1) {
            throw new Error('Invalid timeout');
        }
        this.#fetch = (options.fetch ?? globalThis.fetch).bind(globalThis);
    }
    get token() {
        return this.#token;
    }
    setToken(token) {
        this.#token = token;
    }
    #signal(signal) {
        const timeout = AbortSignal.timeout(this.#timeout);
        return signal ? AbortSignal.any([timeout, signal]) : timeout;
    }
    async #request(path, method = 'GET', input, signal, requireAuth = true) {
        const headers = {
            Accept: 'application/json',
        };
        if (requireAuth) {
            if (!this.#token) {
                throw new Error('Public visitor session token required for this request');
            }
            headers['Authorization'] = `Bearer ${this.#token}`;
        }
        let body;
        if (input !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(input);
            if (new TextEncoder().encode(body).byteLength > 16 * 1024) {
                throw new Error('Request payload exceeds 16 KiB limit');
            }
        }
        try {
            const response = await this.#fetch(this.#base + '/public/v1' + path, {
                method,
                credentials: 'omit',
                redirect: 'error',
                signal: this.#signal(signal),
                headers,
                body,
            });
            if (!response.ok) {
                let errSnippet = '';
                try {
                    // 16 KiB: an already_resolved body carries up to 8 labels.
                    errSnippet = await readBodyText(response, 16 * 1024);
                }
                catch {
                    // ignore error reading body
                }
                await response.body?.cancel().catch(() => { });
                throw new SootPublicHTTPError(response.status, errSnippet);
            }
            const text = await readBodyText(response, 1024 * 1024);
            return text ? JSON.parse(text) : undefined;
        }
        catch (error) {
            if (error instanceof SootPublicHTTPError)
                throw error;
            // No automatic retry for POST requests; outcome is uncertain!
            throw new SootPublicTransportError(method !== 'GET', error?.message);
        }
    }
    // App & Session lifecycle
    getAppInfo(signal) {
        return this.#request(`/apps/${validSegment(this.#appKey)}`, 'GET', undefined, signal, false);
    }
    createSession(proof, signal) {
        const body = {};
        if (proof)
            body.proof = proof;
        return this.#request(`/apps/${validSegment(this.#appKey)}/sessions`, 'POST', body, signal, false);
    }
    renewSession(proof, signal) {
        const body = {};
        if (proof)
            body.proof = proof;
        return this.#request('/session/renew', 'POST', body, signal, true);
    }
    revokeSession(signal) {
        return this.#request('/session/revoke', 'POST', {}, signal, true);
    }
    getSoots(signal) {
        return this.#request('/soots', 'GET', undefined, signal, true);
    }
    getTeam(id, signal) {
        return this.#request(`/conversations/${validSegment(id)}/team`, 'GET', undefined, signal, true);
    }
    // Conversations
    createConversation(id, soot, language, signal, groupId) {
        validText(id, 128);
        validText(soot, 64);
        if (language !== undefined && language !== 'en' && language !== 'vi') {
            throw new TypeError('Invalid conversation language');
        }
        if (groupId !== undefined)
            validText(groupId, 64);
        const body = { id, soot };
        if (language)
            body.language = language;
        if (groupId)
            body.group_id = groupId;
        const send = () => this.#request('/conversations', 'POST', body, signal, true);
        return groupId ? this.getAppInfo(signal).then(info => { if (!info.capabilities?.includes(groupId === 'auto' ? 'groups.auto.v1' : 'groups.v1'))
            throw new TypeError('Server does not support group scope'); return send(); }).then(c => { if (c.group_id !== groupId)
            throw new TypeError('Conversation group differs'); return c; }) : send();
    }
    findCreatedConversation(createId, signal) {
        validText(createId, 128);
        return this.#request(`/conversations?create_id=${encodeURIComponent(createId)}`, 'GET', undefined, signal);
    }
    receipt(conversationId, requestId, signal) {
        return this.#request(`/conversations/${validSegment(conversationId)}/requests/${validSegment(requestId)}`, 'GET', undefined, signal);
    }
    listConversations(options = {}) {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error('Limit must be between 1 and 100');
        }
        const query = new URLSearchParams({ limit: String(limit) });
        if (options.after) {
            validText(options.after, 2048);
            query.set('after', options.after);
        }
        return this.#request(`/conversations?${query}`, 'GET', undefined, options.signal, true);
    }
    getConversation(id, signal) {
        return this.#request(`/conversations/${validSegment(id)}`, 'GET', undefined, signal, true);
    }
    // Messages
    /** Answers a question card (live-chat-attention-v1 runtimes only). */
    sendAnswer(conversationId, messageId, answer, signal) {
        validText(messageId, 128);
        validText(answer?.item, 128);
        if (!validChoices(undefined, answer.choices))
            throw new Error('Invalid answer');
        return this.#request(`/conversations/${validSegment(conversationId)}/messages`, 'POST', { id: messageId, text: '', answer: { item: answer.item, choices: answer.choices } }, signal, true);
    }
    sendMessage(conversationId, messageId, text, signal) {
        validText(messageId, 128);
        validText(text, 12 * 1024);
        return this.#request(`/conversations/${validSegment(conversationId)}/messages`, 'POST', { id: messageId, text }, signal, true);
    }
    getMessages(conversationId, options = {}) {
        const limit = options.limit ?? 50;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
            throw new Error('Limit must be between 1 and 100');
        }
        const after = options.after !== undefined ? validCursor(options.after) : 0;
        return this.#request(`/conversations/${validSegment(conversationId)}/messages?after=${after}&limit=${limit}`, 'GET', undefined, options.signal, true);
    }
    // Runs & Events
    getRuns(conversationId, options = {}) {
        const limit = options.limit ?? 50;
        const after = options.after !== undefined ? validCursor(options.after) : 0;
        return this.#request(`/conversations/${validSegment(conversationId)}/runs?after=${after}&limit=${limit}`, 'GET', undefined, options.signal, true);
    }
    getRun(conversationId, runId, signal) {
        return this.#request(`/conversations/${validSegment(conversationId)}/runs/${validRunID(runId)}`, 'GET', undefined, signal, true);
    }
    stopRun(conversationId, runId, signal) {
        return this.#request(`/conversations/${validSegment(conversationId)}/runs/${validRunID(runId)}/stop`, 'POST', {}, signal, true);
    }
    getEvents(conversationId, options = {}) {
        const limit = options.limit ?? 50;
        const after = options.after !== undefined ? validCursor(options.after) : 0;
        return this.#request(`/conversations/${validSegment(conversationId)}/events?after=${after}&limit=${limit}`, 'GET', undefined, options.signal, true);
    }
    // SSE Stream
    async *stream(conversationId, options = {}) {
        const cursor = options.after !== undefined ? validCursor(options.after) : 0;
        const path = `/conversations/${validSegment(conversationId)}/stream?after=${cursor}`;
        let reader;
        if (!this.#token) {
            throw new Error('Visitor session token required for stream');
        }
        try {
            const response = await this.#fetch(this.#base + '/public/v1' + path, {
                method: 'GET',
                credentials: 'omit',
                redirect: 'error',
                signal: options.signal,
                headers: {
                    Authorization: `Bearer ${this.#token}`,
                    Accept: 'text/event-stream',
                    'Last-Event-ID': String(cursor),
                },
            });
            if (!response.ok) {
                await response.body?.cancel().catch(() => { });
                throw new SootPublicHTTPError(response.status);
            }
            if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
                throw new Error('Invalid Soot event stream response');
            }
            reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: true });
            let buffer = '';
            const parseFrame = (frame) => {
                let eventID = '';
                let type = 'message';
                const data = [];
                for (const line of frame.split('\n')) {
                    if (line.startsWith(':') || !line.trim())
                        continue;
                    const colon = line.indexOf(':');
                    const key = colon < 0 ? line : line.slice(0, colon);
                    const val = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                    if (key === 'id')
                        eventID = val;
                    else if (key === 'event')
                        type = val;
                    else if (key === 'data')
                        data.push(val);
                }
                if (data.length === 0)
                    return undefined;
                try {
                    const parsed = JSON.parse(data.join('\n'));
                    if (typeof parsed === 'object' && parsed !== null) {
                        if (eventID && !parsed.id)
                            parsed.id = Number(eventID);
                        if (type && !parsed.type)
                            parsed.type = type;
                        return parsed;
                    }
                }
                catch {
                    // ignore malformed frame
                }
                return undefined;
            };
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                if (buffer.length > 128 * 1024)
                    throw new Error('Soot event frame byte limit exceeded');
                const parts = buffer.split('\n\n');
                buffer = parts.pop() ?? '';
                for (const part of parts) {
                    const ev = parseFrame(part);
                    if (ev)
                        yield ev;
                }
            }
        }
        finally {
            if (reader) {
                await reader.cancel().catch(() => { });
                reader.releaseLock();
            }
        }
    }
}
/**
 * High-level coordinator managing visitor session, durable draft/message receipts,
 * Web Lock multi-tab coordination, reconciliation, and Turnstile proof acquisition.
 */
export class SootChatSession {
    #client;
    #storageKey;
    #lockKey;
    #appInfo = null;
    #proofProvider;
    #language;
    #sootId;
    #groupId;
    #queue = Promise.resolve();
    // Cards seen by sync(), for the label text sent to a runtime without the capability.
    #cards = new Map();
    constructor(options) {
        this.#storageKey = options.storageKey ?? `soot.chat.v1:${new URL(options.baseUrl).origin}:${options.appKey}`;
        this.#sootId = options.sootId;
        this.#groupId = options.groupId;
        if (options.sootId !== undefined)
            validText(options.sootId, 64);
        if (options.groupId !== undefined)
            validText(options.groupId, 64);
        if (options.sootId || options.groupId)
            this.#storageKey += `:scope:${encodeURIComponent(options.sootId ?? '')}:${encodeURIComponent(options.groupId ?? '')}`;
        this.#lockKey = `soot_lock:${this.#storageKey}`;
        this.#proofProvider = options.proofProvider;
        this.#language = options.language;
        this.#client = new SootPublicClient(options);
    }
    get client() { return this.#client; }
    get appInfo() { return this.#appInfo; }
    /** The runtime serves question cards and accepts `answer` (D10). */
    get attention() { return !!this.#appInfo?.capabilities?.includes(LIVE_CHAT_ATTENTION_V1); }
    /** Select the language of future conversations without changing saved work. */
    setLanguage(language) {
        if (language !== 'en' && language !== 'vi')
            throw new TypeError('Invalid conversation language');
        this.#language = language;
    }
    readState() {
        const raw = localStorage.getItem(this.#storageKey);
        const parsed = raw ? JSON.parse(raw) : {};
        return {
            session: parsed.session ?? null,
            conversationId: parsed.conversationId ?? null,
            sootId: parsed.sootId ?? null,
            pendingCreate: parsed.pendingCreate ?? null,
            pendingMessage: parsed.pendingMessage ?? null,
            pendingAnswer: parsed.pendingAnswer ?? null,
            draft: typeof parsed.draft === 'string' ? parsed.draft : '',
        };
    }
    writeState(state) {
        // No send is admitted when its receipt cannot survive a document reload.
        localStorage.setItem(this.#storageKey, JSON.stringify(state));
    }
    async withLock(fn) {
        const invoke = async () => typeof navigator !== 'undefined' && navigator.locks?.request
            ? await navigator.locks.request(this.#lockKey, fn) : await fn();
        const result = this.#queue.then(invoke, invoke);
        this.#queue = result.catch(() => { });
        return result;
    }
    async #proof() {
        const challenge = this.#appInfo?.challenge;
        if (!challenge?.required)
            return undefined;
        if (!this.#proofProvider)
            throw new Error('Challenge proof required');
        const proof = await this.#proofProvider(challenge);
        if (!proof)
            throw new Error('Challenge proof unavailable');
        return proof;
    }
    #restoreToken(state) {
        if (!state.session || state.session.expires <= Date.now()) {
            throw new SootPublicHTTPError(401);
        }
        this.#client.setToken(state.session.token);
    }
    async init() {
        this.#appInfo = await this.#client.getAppInfo();
        const state = await this.withLock(async () => {
            const current = this.readState();
            if (current.session) {
                this.#restoreToken(current);
                if (current.session.expires <= Date.now() + 30_000) {
                    // Uncertain renewal must not silently switch identity or lose receipts.
                    current.session = await this.#client.renewSession(await this.#proof());
                    this.writeState(current);
                    // Renewal replaced the bearer; reconcile and direct calls use it.
                    this.#restoreToken(current);
                }
            }
            else {
                current.session = await this.#client.createSession(await this.#proof());
                this.writeState(current);
                this.#restoreToken(current);
            }
            await this.#reconcileState(current);
            return current;
        });
        return { appInfo: this.#appInfo, state };
    }
    async #reconcileState(state) {
        if (state.pendingCreate) {
            try {
                const page = await this.#client.findCreatedConversation(state.pendingCreate.id);
                const created = page.conversations[0];
                if (!created || created.soot !== state.pendingCreate.soot || (state.pendingCreate.group_id !== undefined && created.group_id !== state.pendingCreate.group_id))
                    throw new Error('Invalid creation receipt');
                state.conversationId = created.id;
                state.sootId = created.soot;
                state.pendingCreate = null;
                this.writeState(state);
            }
            catch (error) {
                if (!(error instanceof SootPublicHTTPError && error.status === 404))
                    throw error;
            }
        }
        if (state.conversationId && state.pendingMessage && await this.#reconcileMessage(state))
            this.writeState(state);
        if (state.conversationId && state.pendingAnswer && await this.#reconcileAnswer(state))
            this.writeState(state);
    }
    reconcile() {
        return this.withLock(async () => {
            const state = this.readState();
            this.#restoreToken(state);
            await this.#reconcileState(state);
            return state;
        });
    }
    async #ensureConversation() {
        const state = this.readState();
        this.#restoreToken(state);
        if (state.conversationId) {
            const existing = await this.#client.getConversation(state.conversationId);
            if ((this.#groupId && existing.group_id !== this.#groupId) || (this.#sootId && existing.soot !== this.#sootId))
                throw new Error('Conversation scope mismatch');
            return state.conversationId;
        }
        if (!state.pendingCreate) {
            const soot = this.#sootId ?? this.#appInfo?.soots[0]?.id;
            const choices = this.#appInfo?.soots.find(s => s.id === soot)?.groups ?? [];
            if (this.#groupId && !this.#appInfo?.capabilities?.includes(this.#groupId === 'auto' ? 'groups.auto.v1' : 'groups.v1'))
                throw new Error('Server does not support group scopes');
            const automatic = this.#appInfo?.capabilities?.includes('groups.auto.v1') && this.#appInfo.soots.find(s => s.id === soot)?.automatic_groups;
            const group = this.#groupId ?? (automatic ? 'auto' : choices.find(g => g.default)?.id);
            if (choices.length > 0 && !group)
                throw new Error('Group selection required');
            if (!soot)
                throw new Error('No public agent available');
            state.pendingCreate = { id: crypto.randomUUID(), soot, ...(group ? { group_id: group } : {}), ...(this.#language ? { language: this.#language } : {}) };
            this.writeState(state);
        }
        else {
            try {
                const page = await this.#client.findCreatedConversation(state.pendingCreate.id);
                const created = page.conversations[0];
                if (!created || created.soot !== state.pendingCreate.soot || (state.pendingCreate.group_id !== undefined && created.group_id !== state.pendingCreate.group_id))
                    throw new Error('Invalid creation receipt');
                state.conversationId = created.id;
                state.sootId = created.soot;
                state.pendingCreate = null;
                this.writeState(state);
                return created.id;
            }
            catch (error) {
                if (!(error instanceof SootPublicHTTPError && error.status === 404))
                    throw error;
            }
        }
        // Explicit send may retry the same durable create key; no work runs here.
        const pending = state.pendingCreate;
        const created = await this.#client.createConversation(pending.id, pending.soot, pending.language, undefined, pending.group_id);
        if (created.soot !== pending.soot || (pending.group_id !== undefined && created.group_id !== pending.group_id))
            throw new Error("Conversation scope mismatch");
        state.conversationId = created.id;
        state.sootId = created.soot;
        state.pendingCreate = null;
        this.writeState(state);
        return created.id;
    }
    ensureConversation() {
        return this.withLock(() => this.#ensureConversation());
    }
    async #reconcileMessage(state) {
        if (!state.conversationId || !state.pendingMessage)
            return null;
        try {
            const receipt = await this.#client.receipt(state.conversationId, state.pendingMessage.id);
            if (receipt.run && (receipt.run.request_id !== state.pendingMessage.id || receipt.run.input !== state.pendingMessage.text)) {
                throw new SootPublicHTTPError(409);
            }
            state.pendingMessage = null;
            state.draft = '';
            return receipt;
        }
        catch (error) {
            if (error instanceof SootPublicHTTPError && error.status === 404)
                return null;
            throw error;
        }
    }
    sendMessage(text) {
        const trimmed = text.trim();
        if (!trimmed)
            return Promise.reject(new Error('Message cannot be empty'));
        return this.withLock(async () => {
            let state = this.readState();
            this.#restoreToken(state);
            const existing = await this.#reconcileMessage(state);
            if (existing) {
                this.writeState(state);
                return existing;
            }
            if (!state.pendingMessage) {
                // Local validation happens before persistence so an invalid payload
                // never poisons the durable receipt or draft.
                validText(trimmed, 12 * 1024);
                state.pendingMessage = { id: crypto.randomUUID(), text: trimmed };
                state.draft = text;
                this.writeState(state);
            }
            const conversationId = await this.#ensureConversation();
            state = this.readState();
            const pending = state.pendingMessage;
            if (!pending)
                throw new Error('Pending receipt was removed before submission');
            let receipt;
            try {
                receipt = await this.#client.sendMessage(conversationId, pending.id, pending.text);
            }
            catch (error) {
                // A validation rejection is definitive: the server admitted no run.
                // Keep the draft editable. Transport failures and other statuses keep
                // the original receipt so an explicit retry cannot duplicate work.
                if (error instanceof SootPublicHTTPError && error.status === 400) {
                    state.pendingMessage = null;
                    this.writeState(state);
                }
                throw error;
            }
            state.pendingMessage = null;
            state.draft = '';
            this.writeState(state);
            return receipt;
        });
    }
    async #reconcileAnswer(state) {
        if (!state.conversationId || !state.pendingAnswer)
            return null;
        try {
            const receipt = await this.#client.receipt(state.conversationId, state.pendingAnswer.id);
            if (receipt.run && receipt.run.request_id !== state.pendingAnswer.id)
                throw new SootPublicHTTPError(409);
            state.pendingAnswer = null;
            return receipt;
        }
        catch (error) {
            if (error instanceof SootPublicHTTPError && error.status === 404)
                return null;
            throw error;
        }
    }
    async #card(conversationId, item) {
        const known = this.#cards.get(item);
        if (known)
            return known;
        const open = questionOf((await this.#client.getConversation(conversationId)).question);
        return open?.item === item ? open : undefined;
    }
    /**
     * Answers a question card with option indexes. Like sendMessage: the receipt
     * is persisted before the POST, a retry reuses its ID, and tabs serialize on
     * the Web Lock. A runtime without the capability gets the labels as text.
     * `409 already_resolved` / `moved_on` is not an error: the receipt clears
     * and the caller syncs to show the resolution or the current question.
     */
    answer(item, choices) {
        validText(item, 128);
        if (!validChoices(undefined, choices))
            return Promise.reject(new Error('Invalid answer'));
        return this.withLock(async () => {
            let state = this.readState();
            this.#restoreToken(state);
            // A committed earlier answer settles here; it is this call's only when it is for the same item.
            const earlier = state.pendingAnswer?.item;
            if (await this.#reconcileAnswer(state)) {
                this.writeState(state);
                if (earlier === item)
                    return;
            }
            if (state.pendingAnswer && state.pendingAnswer.item !== item)
                throw new Error('Another answer is pending');
            if (!state.pendingAnswer) {
                state.pendingAnswer = { id: crypto.randomUUID(), item, choices: [...choices] };
                this.writeState(state);
            }
            const conversationId = state.conversationId;
            if (!conversationId) {
                state.pendingAnswer = null;
                this.writeState(state);
                throw new Error('No conversation to answer');
            }
            const pending = state.pendingAnswer;
            try {
                if (this.attention)
                    await this.#client.sendAnswer(conversationId, pending.id, pending);
                else {
                    const card = await this.#card(conversationId, pending.item);
                    if (!card)
                        throw new SootPublicHTTPError(404, JSON.stringify({ code: 'item_gone' }));
                    await this.#client.sendMessage(conversationId, pending.id, answerText(card, pending.choices));
                }
            }
            catch (error) {
                // Definitive refusals admitted no run; transport failures and other
                // statuses keep the receipt so an explicit retry cannot duplicate work.
                const definitive = error instanceof SootPublicHTTPError && [400, 403, 404, 409, 422].includes(error.status);
                if (error instanceof Error && error.message === 'Invalid answer' || definitive) {
                    state = this.readState();
                    state.pendingAnswer = null;
                    this.writeState(state);
                }
                if (error instanceof SootPublicHTTPError && error.status === 409 && (error.code === 'already_resolved' || error.code === 'moved_on'))
                    return;
                throw error;
            }
            state = this.readState();
            state.pendingAnswer = null;
            this.writeState(state);
        });
    }
    /**
     * Reads the conversation once: messages past `after` (only when something
     * changed, or `force`), plus the derived attention state. Cards are
     * validated (non-question cards dropped) and pointers carry `afterMessage`
     * so a client places each line in the transcript.
     */
    async sync(options = {}) {
        const after = options.after ?? 0;
        const saved = this.readState();
        const state = saved.session ? await this.reconcile() : saved;
        const result = {
            conversationId: state.conversationId, conversation: null, messages: [], next_after: after,
            pendingMessage: state.pendingMessage, pendingAnswer: state.pendingAnswer, pointers: [],
        };
        if (!state.conversationId)
            return result;
        const conversation = await this.#client.getConversation(state.conversationId, options.signal);
        result.conversation = conversation;
        const unchanged = after > 0 && typeof conversation.message_cursor === 'number' && conversation.message_cursor <= after;
        if (options.force || !unchanged) {
            const page = await this.#client.getMessages(state.conversationId, { after, limit: options.limit ?? 50, signal: options.signal });
            result.messages = (page.messages ?? []).map(m => {
                const { question: raw, ...rest } = m;
                const question = raw === undefined ? undefined : questionOf(raw);
                if (question)
                    this.#cards.set(question.item, question);
                return question ? { ...rest, question } : rest;
            });
            result.next_after = page.next_after || after;
        }
        const open = questionOf(conversation.question);
        if (open && !open.resolution) {
            result.question = open;
            this.#cards.set(open.item, open);
        }
        const waiting = waitingOf(conversation.waiting);
        if (waiting)
            result.waiting = waiting;
        result.pointers = pointersOf(conversation.pointers);
        return result;
    }
    saveDraft(draft) {
        const state = this.readState();
        state.draft = draft;
        this.writeState(state);
    }
    reset() {
        return this.withLock(async () => {
            const state = this.readState();
            if (state.session) {
                // The server atomically revokes authority and fences outstanding work;
                // revoke is idempotent even when the stored bearer is already invalid.
                // Failure preserves identity, receipts and draft until confirmed.
                this.#client.setToken(state.session.token);
                await this.#client.revokeSession();
            }
            this.writeState({ session: null, conversationId: null, sootId: null, pendingCreate: null, pendingMessage: null, pendingAnswer: null, draft: '' });
            this.#cards.clear();
            this.#client.setToken(undefined);
        });
    }
}
