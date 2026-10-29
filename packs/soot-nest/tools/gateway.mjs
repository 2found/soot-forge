// Copied into each standalone owner pack by sync-owner-support.mjs.
// No runtime state, credential cache, sibling import or automatic retry.
export const MAX_RESPONSE_BYTES = 60 * 1024;
const reads = new Set(['list', 'get', 'audit', 'sheets.status']);
const websiteActions = new Set(['create', 'save', 'publish', 'pause', 'resume', 'rollback']);
const sheetsActions = new Set(['sheets.connect', 'sheets.disconnect', 'sheets.check', 'sheets.retry']);

function unknown() {
  const error = new Error('Gateway outcome unknown; inspect the original request before retrying');
  error.uncertain = true;
  return error;
}

// The tool names each owner pack gives its read and write operation.
const owners = new Map([
  ['soot-nest', new Map([['website_view', 'view'], ['website_action', 'action']])],
  ['live-chat-sheets', new Map([['view', 'view'], ['action', 'action']])],
]);

export async function callOwner(pack, tool, call, endpoint, token, {fetcher = fetch, timeoutMs = 12000} = {}) {
  const mode = owners.get(pack)?.get(tool);
  if (!mode || call?.api_version !== 'soot/v1' || call?.hook !== 'tool.call' || call.operation !== `${pack}_${tool}` ||
      typeof call.soot !== 'string' || !call.soot) throw new Error('Invalid operation binding');
  const input = call.input;
  const allowed = pack === 'live-chat-sheets' ? ['action', 'site_id', 'binding', 'request_id'] :
    ['action', 'site_id', 'request_id', 'expected_revision', 'revision', 'after', 'limit', 'config', 'binding'];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Invalid operation');
  const read = reads.has(input.action);
  if (pack === 'live-chat-sheets' && ![...sheetsActions, 'sheets.status'].includes(input.action) ||
      mode === 'view' && !read || mode === 'action' && input.action !== 'sheets.status' && (read || !websiteActions.has(input.action) && !sheetsActions.has(input.action))) throw new Error('Invalid action');
  for (const key of ['site_id', 'request_id', 'binding']) {
    if (key in input && (typeof input[key] !== 'string' || !input[key] || input[key].length > (key === 'binding' ? 512 : 100) || /[\x00-\x1f]/.test(input[key]))) throw new Error('Invalid identifier');
  }
  for (const key of ['expected_revision', 'revision', 'after', 'limit']) {
    if (key in input && (!Number.isSafeInteger(input[key]) || input[key] < (key === 'limit' ? 1 : 0) || key === 'limit' && input[key] > 100)) throw new Error('Invalid revision or page');
  }
  if ('config' in input && (!input.config || typeof input.config !== 'object' || Array.isArray(input.config))) throw new Error('Invalid configuration');
  if (!read && input.action !== 'sheets.check' && !input.request_id) throw new Error('Mutation needs a stable request_id');
  const url = new URL(endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/admin/control' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
      typeof token !== 'string' || !token || token.length > 4096 || /[^\x21-\x7e]/.test(token) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 12000) throw new Error('Invalid binding');
  const controller = new AbortController();
  let timer, reader;
  const failure = () => read ? new Error('Gateway read unavailable') : unknown();
  const cancel = () => { controller.abort(); void reader?.cancel().catch(() => {}); };
  const load = async () => {
    const response = await fetcher(url, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + token},
      body: JSON.stringify(input), redirect: 'error', credentials: 'omit', signal: controller.signal});
    if (controller.signal.aborted || response.redirected || response.url && response.url !== url.href || !response.body) { void response.body?.cancel().catch(() => {}); throw failure(); }
    const sizeHeader = response.headers.get('content-length');
    if (sizeHeader !== null && (!/^\d+$/.test(sizeHeader) || Number(sizeHeader) > MAX_RESPONSE_BYTES)) { void response.body.cancel().catch(() => {}); throw failure(); }
    if (!response.ok) {
      void response.body.cancel().catch(() => {});
      if (!read && (response.status >= 500 || response.status === 408)) throw unknown();
      // Vendor bodies may contain credentials/private state. Project only status.
      return {error: {code: 'request_rejected', status: response.status}};
    }
    reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (!controller.signal.aborted) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw failure();
      chunks.push(chunk.value);
    }
    if (controller.signal.aborted) throw failure();
    const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
    return value;
  };
  try {
    return await Promise.race([load(), new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(failure()); }, timeoutMs); })]);
  } catch { throw failure(); }
  finally { clearTimeout(timer); cancel(); }
}
