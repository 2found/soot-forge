import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const id = /^[a-z0-9][a-z0-9_-]{0,95}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = message => { const error = new Error(message); error.safe = true; throw error; };
function keys(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(k => !allowed.includes(k))) fail('Invalid fields');
}
function text(value, max) { if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0')) fail('Invalid text'); return value; }
function identifier(value) { if (typeof value !== 'string' || !id.test(value)) fail('Invalid identifier'); return value; }
function revision(value) { if (!Number.isSafeInteger(value) || value < 0) fail('Invalid revision'); return value; }
export function binding(value) {
  keys(value, ['soot', 'directory', 'channels']); identifier(value.soot);
  if (typeof value.directory !== 'string' || !isAbsolute(value.directory)) fail('Host must bind an absolute marketing directory');
  if (value.channels && (Array.isArray(value.channels) || typeof value.channels !== 'object' || Object.keys(value.channels).length > 8)) fail('Invalid channel bindings');
  for (const [channel, v] of Object.entries(value.channels ?? {})) {
    identifier(channel); keys(v, ['endpoint', 'destination', 'token', 'automatic']); text(v.destination, 200);
    const u = new URL(v.endpoint);
    if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || !(u.protocol === 'https:' || u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) fail('Channel gateway requires a fixed HTTPS origin');
    if (typeof v.token !== 'string' || v.token.length < 16 || /[\r\n]/.test(v.token)) fail('Invalid gateway credential');
    if (v.automatic !== undefined && typeof v.automatic !== 'boolean') fail('Invalid automatic publication policy');
  }
  return value;
}
async function load(directory, draft) {
  try { const raw = await readFile(join(directory, identifier(draft) + '.json')); if (raw.length > 256 * 1024) fail('Record too large'); return JSON.parse(raw); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(directory, draft, record) {
  const raw = JSON.stringify(record); if (Buffer.byteLength(raw) > 256 * 1024) fail('Record too large');
  const temp = join(directory, '.' + randomUUID()); const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
  await rename(temp, join(directory, identifier(draft) + '.json'));
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
async function locked(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // A crashed writer leaves a lock: recovery is explicit, never a timer guessing
  // that an in-flight publisher is dead. No concurrent process may steal it.
  let lock; try { lock = await open(join(directory, '.marketing.lock'), 'wx', 0o600); } catch (error) { if (error.code === 'EEXIST') fail('Marketing ledger busy or interrupted; inspect before removing its lock'); throw error; }
  try { return await action(); } finally { await lock.close(); await unlink(join(directory, '.marketing.lock')); }
}
function view(record) {
  if (!record) return { draft: null };
  // Gateway credentials and host bindings never enter this ledger/projection.
  return structuredClone(record);
}
function content(input) {
  text(input.title, 240); text(input.body, 12000);
  if (!Array.isArray(input.sources) || input.sources.length < 1 || input.sources.length > 40) fail('A draft needs 1–40 source references');
  const sources = input.sources.map(source => {
    keys(source, ['pool', 'document', 'revision', 'url']); identifier(source.pool); identifier(source.document);
    if (revision(source.revision) < 1) fail('Source revision required');
    const url = new URL(source.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) fail('Invalid source URL');
    return { pool: source.pool, document: source.document, revision: source.revision, url: url.href };
  });
  return { title: input.title, body: input.body, sources };
}
function current(record, expected) { if (!record || record.revision !== revision(expected)) fail('Draft revision conflict; inspect before editing'); }
function publicationKey(record, channel, publisher, binding, at) { return hash([record.id, record.revision, record.hash, channel, publisher, binding.endpoint, binding.destination, at]); }
function rowFor(record, channel, soot) { const row = record.plan.find(row => row.channel === channel && row.publisher === soot); if (!row) fail('No plan for this publisher/channel'); return row; }
function remoteReceipt(value, key) {
  keys(value, ['idempotency_key', 'status', 'url', 'receipt']);
  if (value.idempotency_key !== key || value.status !== 'published') fail('Gateway outcome is not a proven publication');
  text(value.receipt, 512); const url = new URL(value.url); if (url.protocol !== 'https:' || url.username || url.password) fail('Invalid remote publication URL');
  return { status: 'published', url: url.href, receipt: value.receipt };
}
export async function execute(host, call, action, input, fetcher = fetch) {
  binding(host);
  if (call.soot !== host.soot || call.api_version !== 'soot/v1' || call.hook !== 'tool.call' || call.operation !== `marketing_${action}`) fail('Invalid Soot operation binding');
  keys(input, action === 'draft' ? ['id', 'expected_revision', 'title', 'body', 'sources'] : action === 'plan' ? ['id', 'expected_revision', 'expected_plan_revision', 'entries'] : ['id', 'expected_revision', 'channel']);
  const draft = identifier(input.id);
  if (action === 'inspect') return view(await load(host.directory, draft));
  if (!['draft', 'plan', 'publish', 'reconcile'].includes(action)) fail('Unknown operation');
  return locked(host.directory, async () => {
    const record = await load(host.directory, draft);
    if (action === 'draft') {
      const expected = revision(input.expected_revision); if ((record?.revision ?? 0) !== expected) fail('Draft revision conflict; inspect before editing');
      const next = content(input), digest = hash(next);
      if (record?.hash === digest) return view(record);
      // Never discard publication evidence when a draft changes.
      if (record && Object.values(record.publications).some(p => p.status === 'uncertain')) fail('Reconcile uncertain publication before revising');
      if (!record && (await readdir(host.directory)).filter(x => x.endsWith('.json')).length >= 1000) fail('Marketing ledger at capacity');
      const changed = { id: draft, revision: expected + 1, hash: digest, ...next, plan: [], plan_revision: 0, approvals: {}, publications: record?.publications ?? {}, updated_at: new Date().toISOString() };
      await save(host.directory, draft, changed); return view(changed);
    }
    current(record, input.expected_revision);
    if (action === 'plan') {
      if ((record.plan_revision ?? 0) !== revision(input.expected_plan_revision)) fail('Plan revision conflict; inspect before editing');
      if (!Array.isArray(input.entries) || input.entries.length > 32) fail('Plan requires at most 32 channels');
      const seen = new Set();
      const entries = input.entries.map(row => {
        keys(row, ['publisher', 'channel', 'at', 'timezone']); identifier(row.publisher); identifier(row.channel);
        if (!call.team?.some(member => member.id === row.publisher && member.channels?.includes(row.channel))) fail('Publisher/channel is outside this session team');
        if (seen.has(row.publisher+"/"+row.channel)) fail('Duplicate channel'); seen.add(row.publisher+"/"+row.channel);
        if (typeof row.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(row.at) || !Number.isFinite(Date.parse(row.at))) fail('Plan time must be UTC ISO timestamp');
        text(row.timezone, 80); new Intl.DateTimeFormat('en', { timeZone: row.timezone });
        return { ...row, scheduled: false };
      });
      if (Object.values(record.publications).some(p => p.status === 'uncertain')) fail('Reconcile uncertain publication before replanning');
      if (JSON.stringify(record.plan) !== JSON.stringify(entries)) { record.plan = entries; record.plan_revision = (record.plan_revision ?? 0) + 1; record.approvals = {}; await save(host.directory, draft, record); }
      return view(record);
    }
    identifier(input.channel);
    const channel = host.channels?.[input.channel]; if (!channel) fail('Publisher channel requires host setup');
    const row = rowFor(record, input.channel, call.soot);
    if (!call.team?.some(member => member.id === call.soot && member.channels?.includes(input.channel))) fail("Publisher is outside this session team");
    const key = publicationKey(record, input.channel, call.soot, channel, row.at);
    const unresolved = Object.values(record.publications).find(p => p.status === 'uncertain' && p.publisher === call.soot && p.channel === input.channel);
    if (unresolved && unresolved.key !== key) fail('Original publication binding changed; restore it and reconcile the existing attempt before sending');
    const previous = record.publications[key]; if (previous?.status === 'published') return previous;
    if (action === 'reconcile') {
      if (!previous || previous.status !== 'uncertain') fail('No uncertain publication to reconcile');
      const response = await fetcher(new URL('/v1/publications/' + key, channel.endpoint), { headers: { Authorization: 'Bearer ' + channel.token }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok) fail('Gateway has not proven publication; uncertainty retained');
      const receipt = remoteReceipt(await boundedJSON(response), key);
      record.publications[key] = { ...previous, ...receipt }; await save(host.directory, draft, record); return record.publications[key];
    }
    if (previous) fail('Publication is uncertain; reconcile its original key, never resend');
    if (Date.parse(row.at) > Date.now()) fail('Publication not due; a plan is not a scheduled job');
    if (!channel.automatic && record.approvals[key]?.hash !== record.hash) fail('Operator approval required for this exact revision, channel, destination and time');
    record.publications[key] = { key, channel: input.channel, publisher: call.soot, revision: record.revision, hash: record.hash, status: 'uncertain', attempted_at: new Date().toISOString() };
    await save(host.directory, draft, record); // durable BEFORE sending
    try {
      const response = await fetcher(new URL('/v1/publications', channel.endpoint), { method: 'POST', headers: { Authorization: 'Bearer ' + channel.token, 'Content-Type': 'application/json', 'Idempotency-Key': key }, redirect: 'error', signal: AbortSignal.timeout(20000), body: JSON.stringify({ idempotency_key: key, destination: channel.destination, channel: input.channel, draft: { title: record.title, body: record.body, sources: record.sources, revision: record.revision, hash: record.hash } }) });
      if (!response.ok) fail('Publication response not successful');
      const receipt = remoteReceipt(await boundedJSON(response), key);
      record.publications[key] = { ...record.publications[key], ...receipt }; await save(host.directory, draft, record);
    } catch { /* retain uncertainty, including HTTP errors; gateway may have committed */ }
    return record.publications[key];
  });
}
async function boundedJSON(response) {
  let size = 0; const chunks = []; for await (const chunk of response.body) { size += chunk.length; if (size > 16384) { await response.body.cancel?.().catch(() => {}); fail('Gateway response too large'); } chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
// Operator-only API, deliberately absent from pack tools and model schemas.
export async function approve(host, input) {
  binding(host); keys(input, ['id', 'revision', 'plan_revision', 'hash', 'channel']); identifier(input.id); identifier(input.channel);
  return locked(host.directory, async () => {
    const record = await load(host.directory, input.id); current(record, input.revision);
    if ((record.plan_revision ?? 0) !== revision(input.plan_revision)) fail('Approval plan revision changed');
    if (record.hash !== input.hash) fail('Approval content hash changed');
    const channel = host.channels?.[input.channel]; if (!channel) fail('Missing destination binding');
    const row = rowFor(record, input.channel, host.soot);
    const key = publicationKey(record, input.channel, host.soot, channel, row.at);
    record.approvals[key] = { hash: record.hash, approved_at: new Date().toISOString() };
    await save(host.directory, input.id, record); return { approved: true, key, revision: record.revision, hash: record.hash };
  });
}
