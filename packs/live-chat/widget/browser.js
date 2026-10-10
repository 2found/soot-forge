export class SootPublicHTTPError extends Error {
    status;
    errorBody;
    constructor(status, errorBody) {
        super(`Soot public API rejected request (${status})${errorBody ? `: ${errorBody}` : ''}`);
        this.status = status;
        this.errorBody = errorBody;
        this.name = 'SootPublicHTTPError';
    }
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
                    errSnippet = await readBodyText(response, 1024);
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
            this.writeState({ session: null, conversationId: null, sootId: null, pendingCreate: null, pendingMessage: null, draft: '' });
            this.#client.setToken(undefined);
        });
    }
}
