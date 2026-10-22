import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, readdir, stat, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

// A simulated society is passive state: the host's native delegation runs every
// persona, and this module only records what they said and counts it. Nothing
// here calls a model, starts an agent or reaches the network.

const ID = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const KINDS = ['product', 'feature', 'video', 'marketing', 'pricing', 'other'];
const MAX = { personas: 200, stimuli: 4, rounds: 4, feed: 8, batch: 12, write: 6, posts: 240, record: 4 * 1024 * 1024 };
const SCALE = ['attention', 'appeal', 'clarity', 'trust', 'intent'];
const VERDICTS = ['GO', 'ITERATE', 'NO_GO'];
const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
const PREVIEW = 30000;

const fail = message => { const error = new Error(message); error.safe = true; throw error; };
function keys(value, allowed, required = [], where = 'input') {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${where} must be an object`);
  const extra = Object.keys(value).filter(k => !allowed.includes(k));
  if (extra.length) fail(`${where}: unknown field ${extra[0]}`);
  const missing = required.filter(k => value[k] === undefined || value[k] === null);
  if (missing.length) fail(`${where}: missing ${missing[0]}`);
}
function text(value, max, where, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) fail(`${where} must be non-empty text`);
  if ([...value].length > max) fail(`${where} is longer than ${max} characters`);
  return value.trim();
}
function ident(value, where) { if (typeof value !== 'string' || !ID.test(value)) fail(`${where} must match ${ID.source}`); return value; }
function int(value, min, max, where, optional = false) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (!Number.isInteger(value) || value < min || value > max) fail(`${where} must be an integer ${min}–${max}`);
  return value;
}
function num(value, min, max, where, optional = false) {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${where} must be a number ${min}–${max}`);
  return value;
}
function list(value, max, where, item) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) fail(`${where} must be a list of at most ${max}`);
  return value.map((v, i) => item(v, `${where}[${i}]`));
}
const tag = (v, where) => text(v, 40, where).toLowerCase().replace(/\s+/g, '-');
const seeded = (...parts) => createHash('sha256').update(parts.join('\0')).digest();
const unit = (...parts) => seeded(...parts).readUInt32BE(0) / 0x100000000;

// Every conversation gets its own world: a delegated crowd member shares the
// conversation subject and root, so the whole team sees one simulation, while
// another conversation (or tenant root) can never read or overwrite it.
export function scope(call) {
  const subject = call?.event?.subject || call?.event?.id || 'direct';
  const root = call?.root || call?.soot || 'soot';
  return createHash('sha256').update(`${root}\0${subject}`).digest('hex').slice(0, 32);
}
export function stateDirectory(env = process.env) {
  const base = env.SOOT_PACK_STATE || env.SOCIETY_STATE_DIR;
  if (!base || !isAbsolute(base)) fail('This Soot host did not provide SOOT_PACK_STATE; update the Soot runtime');
  return join(base, 'worlds');
}

async function load(dir, sim) {
  try {
    const raw = await readFile(join(dir, ident(sim, 'sim') + '.json'));
    return JSON.parse(raw);
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(dir, world) {
  world.revision = (world.revision || 0) + 1; world.updated_at = new Date().toISOString();
  const raw = JSON.stringify(world); if (Buffer.byteLength(raw) > MAX.record) fail('Simulation record is full; start a smaller simulation');
  const temp = join(dir, '.' + randomUUID()); const file = await open(temp, 'wx', 0o600);
  try { await file.writeFile(raw); await file.sync(); } finally { await file.close(); }
  await rename(temp, join(dir, world.id + '.json'));
  const parent = await open(dir, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
// Crowd members write in parallel, so a busy lock waits briefly. The record is
// replaced by rename, so a writer that died while holding the lock left a
// consistent file behind; a lock older than any tool timeout has no live owner.
async function locked(dir, sim, action) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `.${ident(sim, 'sim')}.lock`); const deadline = Date.now() + 10000;
  let lock;
  for (let delay = 15; !lock; delay = Math.min(delay * 2, 400)) {
    try { lock = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = await stat(path).then(s => Date.now() - s.mtimeMs, () => 0);
      if (age > 60000) { await unlink(path).catch(() => {}); continue; }
      if (Date.now() > deadline) fail('Simulation is busy; call again in a moment');
      await new Promise(r => setTimeout(r, delay + Math.floor(Math.random() * delay)));
    }
  }
  try { return await action(); } finally { await lock.close(); await unlink(path).catch(() => {}); }
}
async function need(dir, sim) { const world = await load(dir, sim); if (!world) fail(`No simulation "${sim}" in this conversation; call micro-fish_create first`); return world; }

function stimulus(v, where) {
  keys(v, ['id', 'label', 'content'], ['id', 'label', 'content'], where);
  return { id: ident(v.id, `${where}.id`), label: text(v.label, 80, `${where}.label`), content: text(v.content, 3000, `${where}.content`) };
}
function persona(v, where) {
  keys(v, ['id', 'name', 'segment', 'market', 'age', 'gender', 'occupation', 'income', 'traits', 'values', 'media', 'context', 'stance', 'influence', 'skepticism', 'bio'], ['id', 'name', 'segment', 'market', 'bio'], where);
  return {
    id: ident(v.id, `${where}.id`), name: text(v.name, 60, `${where}.name`), segment: tag(v.segment, `${where}.segment`), market: tag(v.market, `${where}.market`),
    age: int(v.age, 13, 99, `${where}.age`, true), gender: text(v.gender, 30, `${where}.gender`, true), occupation: text(v.occupation, 80, `${where}.occupation`, true),
    income: text(v.income, 60, `${where}.income`, true), traits: list(v.traits, 6, `${where}.traits`, (t, w) => text(t, 40, w)),
    values: list(v.values, 6, `${where}.values`, (t, w) => text(t, 40, w)), media: list(v.media, 6, `${where}.media`, (t, w) => text(t, 40, w)),
    context: text(v.context, 300, `${where}.context`, true), stance: text(v.stance, 200, `${where}.stance`, true),
    influence: num(v.influence ?? 0.3, 0, 1, `${where}.influence`), skepticism: num(v.skepticism ?? 0.5, 0, 1, `${where}.skepticism`),
    bio: text(v.bio, 500, `${where}.bio`),
  };
}

export async function create(dir, input) {
  keys(input, ['sim', 'goal', 'kind', 'language', 'markets', 'audience', 'stimuli', 'questions', 'rounds', 'feed_size'], ['sim', 'goal', 'kind']);
  if (!KINDS.includes(input.kind)) fail(`kind must be one of ${KINDS.join(', ')}`);
  const stimuli = list(input.stimuli, MAX.stimuli, 'stimuli', stimulus);
  if (new Set(stimuli.map(s => s.id)).size !== stimuli.length) fail('Stimulus ids must be unique');
  const world = {
    version: 1, id: ident(input.sim, 'sim'), created_at: new Date().toISOString(), revision: 0,
    brief: {
      goal: text(input.goal, 600, 'goal'), kind: input.kind, language: text(input.language, 20, 'language', true) || 'vi',
      markets: list(input.markets, 6, 'markets', tag), audience: text(input.audience, 600, 'audience', true),
      stimuli, questions: list(input.questions, 8, 'questions', (q, w) => text(q, 200, w)),
    },
    design: { rounds: int(input.rounds ?? 2, 0, MAX.rounds, 'rounds'), feed_size: int(input.feed_size ?? 5, 0, MAX.feed, 'feed_size') },
    personas: {}, reactions: {}, experts: {},
  };
  return locked(dir, world.id, async () => {
    if (await load(dir, world.id)) fail(`Simulation "${world.id}" already exists here; pick another id or call micro-fish_status`);
    await save(dir, world);
    return { sim: world.id, rounds: world.design.rounds, stimuli: stimuli.map(s => s.id), next: stimuli.length ? 'Ask the architect to add personas (24–60 across the segments that decide the outcome).' : 'Add the thing to evaluate with micro-fish_stimulus, then build the population.' };
  });
}

// A long stimulus (a full video script, a landing page) is added on its own so
// every call stays inside the host's 16 KiB tool-input limit.
export async function addStimulus(dir, input) {
  keys(input, ['sim', 'stimulus'], ['sim', 'stimulus']);
  const next = stimulus(input.stimulus, 'stimulus');
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim);
    if (Object.keys(world.reactions).length) fail('Reactions already exist; stimuli are fixed once round 0 starts. Create a new simulation for a revised version.');
    const at = world.brief.stimuli.findIndex(s => s.id === next.id);
    if (at >= 0) world.brief.stimuli[at] = next; else if (world.brief.stimuli.length >= MAX.stimuli) fail(`At most ${MAX.stimuli} stimuli`); else world.brief.stimuli.push(next);
    await save(dir, world);
    return { sim: world.id, stimuli: world.brief.stimuli.map(s => ({ id: s.id, label: s.label, characters: [...s.content].length })), replaced: at >= 0 };
  });
}

export async function addPersonas(dir, input) {
  keys(input, ['sim', 'personas', 'replace'], ['sim', 'personas']);
  const incoming = list(input.personas, 10, 'personas', persona);
  if (!incoming.length) fail('personas is empty');
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim);
    if (Object.keys(world.reactions).length && !input.replace) fail('Reactions already exist; the population is fixed once round 0 starts');
    for (const p of incoming) {
      if (world.personas[p.id] && !input.replace) fail(`Persona "${p.id}" already exists`);
      world.personas[p.id] = p;
    }
    if (Object.keys(world.personas).length > MAX.personas) fail(`At most ${MAX.personas} personas per simulation`);
    await save(dir, world);
    return { sim: world.id, personas: Object.keys(world.personas).length, mix: mix(Object.values(world.personas)) };
  });
}
function mix(people) {
  const count = field => Object.fromEntries(Object.entries(people.reduce((a, p) => ({ ...a, [p[field]]: (a[p[field]] || 0) + 1 }), {})).sort((a, b) => b[1] - a[1]));
  return { segment: count('segment'), market: count('market') };
}

const reacted = (world, round) => new Set(Object.keys(world.reactions[round] || {}));
export async function planRound(dir, input) {
  keys(input, ['sim', 'round', 'batch_size'], ['sim', 'round']);
  const world = await need(dir, input.sim);
  const round = int(input.round, 0, world.design.rounds, 'round'), size = int(input.batch_size ?? 6, 1, MAX.batch, 'batch_size');
  const all = Object.keys(world.personas).sort();
  if (!world.brief.stimuli.length) fail('No stimulus yet; add one with micro-fish_stimulus');
  if (!all.length) fail('No personas yet; ask the architect to add them');
  if (round > 0) {
    const previous = reacted(world, round - 1), missing = all.filter(id => !previous.has(id));
    if (missing.length) return { sim: world.id, round, ready: false, waiting_on_round: round - 1, missing: missing.length, next: `Finish round ${round - 1} first: ${missing.length} personas have not reacted.` };
  }
  const done = reacted(world, round), todo = all.filter(id => !done.has(id));
  const batches = []; for (let i = 0; i < todo.length; i += size) batches.push(todo.slice(i, i + size));
  return { sim: world.id, round, ready: true, social: round > 0, done: done.size, remaining: todo.length, batches,
    next: todo.length ? `Delegate each batch to the crowd member in parallel: "round ${round}, personas <ids>".` : round < world.design.rounds ? `Round ${round} complete; plan round ${round + 1}.` : 'All rounds complete; ask the analyst to call micro-fish_tally.' };
}

function posts(world, round) {
  return Object.entries(world.reactions[round] || {}).filter(([, r]) => r.post).map(([pid, r]) => ({ id: `r${round}-${pid}`, round, author: pid, text: r.post, shared: r.share || null, sentiment: avg(Object.values(r.stimuli).map(s => s.sentiment)) }));
}
function citations(world) {
  const cited = {};
  for (const rows of Object.values(world.reactions)) for (const r of Object.values(rows)) for (const id of r.influenced_by || []) cited[id] = (cited[id] || 0) + 1;
  return cited;
}
// A persona's feed is what its own corner of the society said last round: posts
// from the same segment and market, louder authors and widely cited posts
// surface more, and the draw is seeded so a re-run shows the same feed.
export function feed(world, pid, round) {
  const me = world.personas[pid], size = world.design.feed_size;
  if (round === 0 || !size) return [];
  const cited = citations(world);
  const pool = posts(world, round - 1).filter(p => p.author !== pid).map(p => {
    const author = world.personas[p.author] || {};
    const weight = 1 + 2 * (author.influence ?? 0.3) + (author.segment === me.segment ? 1.5 : 0) + (author.market === me.market ? 1 : 0) + Math.min(cited[p.id] || 0, 5) * 0.5;
    return { p, key: -Math.log(unit(world.id, pid, String(round), p.id) || 1e-9) / weight };
  });
  return pool.sort((a, b) => a.key - b.key).slice(0, size).map(({ p }) => {
    const author = world.personas[p.author] || {};
    return { id: p.id, author: author.name || p.author, segment: author.segment, market: author.market, text: p.text, ...(p.shared ? { shared: p.shared } : {}) };
  });
}
function memory(world, pid, round) {
  const out = [];
  for (let r = 0; r < round; r++) {
    const row = world.reactions[r]?.[pid]; if (!row) continue;
    out.push({ round: r, post: row.post || null, preferred: row.preferred || null, intent: Object.fromEntries(Object.entries(row.stimuli).map(([sid, s]) => [sid, s.intent])), quotes: Object.fromEntries(Object.entries(row.stimuli).map(([sid, s]) => [sid, s.quote])) });
  }
  return out;
}
function order(world, pid, round) { return world.brief.stimuli.map(s => s.id).sort((a, b) => unit(world.id, pid, String(round), a) - unit(world.id, pid, String(round), b)); }

export async function packet(dir, input) {
  keys(input, ['sim', 'round', 'personas'], ['sim', 'round', 'personas']);
  const world = await need(dir, input.sim);
  const round = int(input.round, 0, world.design.rounds, 'round');
  const ids = list(input.personas, MAX.batch, 'personas', ident);
  for (const id of ids) if (!world.personas[id]) fail(`Unknown persona "${id}"`);
  const build = feedLimit => ({
    sim: world.id, round, social: round > 0, brief: { goal: world.brief.goal, kind: world.brief.kind, language: world.brief.language, questions: world.brief.questions },
    stimuli: world.brief.stimuli,
    personas: ids.map(id => ({ ...world.personas[id], stimulus_order: order(world, id, round), already_reacted: Boolean(world.reactions[round]?.[id]), memory: memory(world, id, round), feed: feed(world, id, round).slice(0, feedLimit) })),
    record_with: 'micro-fish_react: one entry per persona, every stimulus scored, in each persona\'s own voice.',
  });
  // Stay inside one tool preview so a crowd member never has to page a spill.
  let limit = world.design.feed_size, out = build(limit);
  while (limit > 0 && Buffer.byteLength(JSON.stringify(out)) > PREVIEW) out = build(--limit);
  if (Buffer.byteLength(JSON.stringify(out)) > PREVIEW) fail('Packet too large; request fewer personas');
  return out;
}

function reaction(world, v, round, where) {
  keys(v, ['persona', 'stimuli', 'preferred', 'post', 'share', 'influenced_by', 'changed', 'change_reason'], ['persona', 'stimuli'], where);
  const pid = ident(v.persona, `${where}.persona`); if (!world.personas[pid]) fail(`${where}: unknown persona "${pid}"`);
  const valid = new Set(world.brief.stimuli.map(s => s.id)), seen = {};
  for (const [i, s] of list(v.stimuli, MAX.stimuli, `${where}.stimuli`, x => x).entries()) {
    const w = `${where}.stimuli[${i}]`;
    keys(s, ['stimulus', ...SCALE, 'price_ok', 'watch_through', 'sentiment', 'emotions', 'objections', 'quote'], ['stimulus', ...SCALE, 'sentiment', 'quote'], w);
    if (!valid.has(s.stimulus) || seen[s.stimulus]) fail(`${w}: unknown or repeated stimulus "${s.stimulus}"`);
    seen[s.stimulus] = {
      ...Object.fromEntries(SCALE.map(k => [k, int(s[k], 1, 5, `${w}.${k}`)])),
      ...(s.price_ok === undefined || s.price_ok === null ? {} : { price_ok: typeof s.price_ok === 'boolean' ? s.price_ok : fail(`${w}.price_ok must be true/false`) }),
      ...(s.watch_through === undefined || s.watch_through === null ? {} : { watch_through: int(s.watch_through, 0, 100, `${w}.watch_through`) }),
      sentiment: int(s.sentiment, -2, 2, `${w}.sentiment`), emotions: list(s.emotions, 3, `${w}.emotions`, tag),
      objections: list(s.objections, 4, `${w}.objections`, tag), quote: text(s.quote, 200, `${w}.quote`),
    };
  }
  if (Object.keys(seen).length !== valid.size) fail(`${where}: score every stimulus (${[...valid].join(', ')})`);
  if (v.preferred !== undefined && v.preferred !== null && !valid.has(v.preferred)) fail(`${where}.preferred must be a stimulus id`);
  if (v.share !== undefined && v.share !== null && !valid.has(v.share)) fail(`${where}.share must be a stimulus id`);
  const known = new Set(round > 0 ? posts(world, round - 1).map(p => p.id) : []);
  const influenced = list(v.influenced_by, 3, `${where}.influenced_by`, (x, w) => { if (!known.has(x) || x.endsWith(`-${pid}`)) fail(`${w}: "${x}" is not another persona's post from round ${round - 1}`); return x; });
  if (v.changed !== undefined && typeof v.changed !== 'boolean') fail(`${where}.changed must be true/false`);
  return [pid, {
    stimuli: seen, ...(valid.size > 1 && v.preferred ? { preferred: v.preferred } : {}), post: text(v.post, MAX.posts, `${where}.post`, true) || null,
    share: v.share || null, influenced_by: influenced, changed: round > 0 ? Boolean(v.changed) : false,
    change_reason: text(v.change_reason, 200, `${where}.change_reason`, true) || null, at: new Date().toISOString(),
  }];
}
export async function react(dir, input) {
  keys(input, ['sim', 'round', 'reactions'], ['sim', 'round', 'reactions']);
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim);
    const round = int(input.round, 0, world.design.rounds, 'round');
    if (!world.brief.stimuli.length) fail('No stimulus to react to yet');
    if (round > 0) { const prev = reacted(world, round - 1); const missing = Object.keys(world.personas).filter(id => !prev.has(id)); if (missing.length) fail(`Round ${round - 1} is not complete (${missing.length} missing)`); }
    const rows = list(input.reactions, MAX.write, 'reactions', (v, w) => reaction(world, v, round, w));
    if (!rows.length) fail('reactions is empty');
    if (new Set(rows.map(([pid]) => pid)).size !== rows.length) fail('A persona appears twice in one batch');
    world.reactions[round] ||= {};
    const replaced = rows.filter(([pid]) => world.reactions[round][pid]).map(([pid]) => pid);
    for (const [pid, row] of rows) world.reactions[round][pid] = row;
    await save(dir, world);
    const done = Object.keys(world.reactions[round]).length, total = Object.keys(world.personas).length;
    return { sim: world.id, round, recorded: rows.length, replaced, round_progress: `${done}/${total}` };
  });
}

export async function expert(dir, input) {
  keys(input, ['sim', 'expert', 'lens', 'verdict', 'overall', 'scores', 'findings', 'strengths', 'coverage'], ['sim', 'expert', 'lens', 'verdict', 'overall', 'findings', 'coverage']);
  if (!VERDICTS.includes(input.verdict)) fail(`verdict must be one of ${VERDICTS.join(', ')}`);
  const scores = input.scores ?? {};
  if (Array.isArray(scores) || typeof scores !== 'object' || Object.keys(scores).length > 12) fail('scores must map up to 12 dimensions to 0–10');
  return locked(dir, input.sim, async () => {
    const world = await need(dir, input.sim);
    const valid = new Set(world.brief.stimuli.map(s => s.id));
    const id = ident(input.expert, 'expert');
    world.experts[id] = {
      lens: text(input.lens, 160, 'lens'), verdict: input.verdict, overall: num(input.overall, 0, 10, 'overall'),
      scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [tag(k, 'scores key'), num(v, 0, 10, `scores.${k}`)])),
      findings: list(input.findings, 12, 'findings', (f, w) => {
        keys(f, ['severity', 'stimulus', 'issue', 'evidence', 'fix'], ['severity', 'issue', 'fix'], w);
        if (!SEVERITIES.includes(f.severity)) fail(`${w}.severity must be P0–P3`);
        if (f.stimulus && !valid.has(f.stimulus)) fail(`${w}.stimulus is unknown`);
        return { severity: f.severity, stimulus: f.stimulus || null, issue: text(f.issue, 240, `${w}.issue`), evidence: text(f.evidence, 240, `${w}.evidence`, true) || null, fix: text(f.fix, 240, `${w}.fix`) };
      }),
      strengths: list(input.strengths, 8, 'strengths', (s, w) => text(s, 200, w)), coverage: text(input.coverage, 400, 'coverage'), at: new Date().toISOString(),
    };
    await save(dir, world);
    return { sim: world.id, expert: id, experts: Object.keys(world.experts).length };
  });
}

const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const r2 = x => x === null || x === undefined ? null : Math.round(x * 100) / 100;
const pct = (k, n) => n ? Math.round(1000 * k / n) / 10 : null;
function wilson(k, n) {
  if (!n) return null; const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [pct(Math.max(0, c - m) * n, n), pct(Math.min(1, c + m) * n, n)];
}
function cell(rows, sid) {
  const xs = rows.map(r => r.stimuli[sid]).filter(Boolean), n = xs.length; if (!n) return { n: 0 };
  const top2 = k => pct(xs.filter(x => x[k] >= 4).length, n);
  const priced = xs.filter(x => x.price_ok !== undefined), watched = xs.filter(x => x.watch_through !== undefined);
  return {
    n, ...Object.fromEntries(SCALE.map(k => [`${k}_mean`, r2(avg(xs.map(x => x[k])))])),
    appeal_top2: top2('appeal'), intent_top2: top2('intent'), trust_top2: top2('trust'), clarity_top2: top2('clarity'),
    intent_ci95: wilson(xs.filter(x => x.intent >= 4).length, n), intent_sd: r2(Math.sqrt(avg(xs.map(x => (x.intent - avg(xs.map(y => y.intent))) ** 2)))),
    intent_dist: [1, 2, 3, 4, 5].map(v => xs.filter(x => x.intent === v).length), sentiment_mean: r2(avg(xs.map(x => x.sentiment))),
    share_rate: pct(rows.filter(r => r.share === sid).length, n),
    ...(priced.length ? { price_ok: pct(priced.filter(x => x.price_ok).length, priced.length) } : {}),
    ...(watched.length ? { watch_through_mean: r2(avg(watched.map(x => x.watch_through))) } : {}),
  };
}
function counts(values, limit) {
  const c = {}; for (const v of values) c[v] = (c[v] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, limit);
}
export async function tally(dir, input) {
  keys(input, ['sim', 'by'], ['sim']);
  const world = await need(dir, input.sim);
  const by = input.by ?? 'segment'; if (!['segment', 'market'].includes(by)) fail('by must be segment or market');
  const stimuli = world.brief.stimuli.map(s => s.id), people = world.personas;
  const rounds = Object.keys(world.reactions).map(Number).sort((a, b) => a - b);
  if (!rounds.length) fail('No reactions recorded yet');
  const first = rounds[0], last = rounds.at(-1), lastRows = Object.entries(world.reactions[last]);
  const out = {
    sim: world.id, goal: world.brief.goal, kind: world.brief.kind, population: Object.keys(people).length, mix: mix(Object.values(people)),
    rounds_recorded: rounds.map(r => ({ round: r, reacted: Object.keys(world.reactions[r]).length })), complete: rounds.length === world.design.rounds + 1 && rounds.every(r => Object.keys(world.reactions[r]).length === Object.keys(people).length),
    by_round: Object.fromEntries(rounds.map(r => [r, Object.fromEntries(stimuli.map(sid => [sid, cell(Object.values(world.reactions[r]), sid)]))])),
    [`by_${by}`]: {}, shift: {}, preference: null, objections: {}, emotions: {}, quotes: {}, influential_posts: [], experts: null, warnings: [],
  };
  const groups = {}; for (const [pid, row] of lastRows) (groups[people[pid]?.[by] || 'unknown'] ||= []).push(row);
  for (const [g, rows] of Object.entries(groups)) out[`by_${by}`][g] = Object.fromEntries(stimuli.map(sid => { const c = cell(rows, sid); return [sid, { n: c.n, intent_top2: c.intent_top2, appeal_mean: c.appeal_mean, trust_mean: c.trust_mean, sentiment_mean: c.sentiment_mean }]; }));
  for (const sid of stimuli) {
    const pairs = Object.keys(people).map(pid => [world.reactions[first]?.[pid]?.stimuli[sid], world.reactions[last]?.[pid]?.stimuli[sid]]).filter(([a, b]) => a && b);
    const d = pairs.map(([a, b]) => b.intent - a.intent), m = avg(d), sd = d.length > 1 ? Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (d.length - 1)) : 0;
    out.shift[sid] = last === first ? null : {
      from_round: first, to_round: last, n: pairs.length, intent_delta: r2(m), intent_delta_ci95: d.length > 1 ? [r2(m - 1.96 * sd / Math.sqrt(d.length)), r2(m + 1.96 * sd / Math.sqrt(d.length))] : null,
      won: pairs.filter(([a, b]) => a.intent < 4 && b.intent >= 4).length, lost: pairs.filter(([a, b]) => a.intent >= 4 && b.intent < 4).length,
      changed_mind: pct(lastRows.filter(([, r]) => r.changed).length, lastRows.length),
    };
    // The report states this verdict rather than reading movement into noise.
    if (out.shift[sid]) { const ci = out.shift[sid].intent_delta_ci95; out.shift[sid].direction = !ci ? 'unknown' : ci[0] > 0 ? 'up' : ci[1] < 0 ? 'down' : 'no clear change'; }
    out.objections[sid] = { first: counts(Object.values(world.reactions[first]).flatMap(r => r.stimuli[sid]?.objections || []), 8), last: counts(lastRows.flatMap(([, r]) => r.stimuli[sid]?.objections || []), 8) };
    out.emotions[sid] = counts(lastRows.flatMap(([, r]) => r.stimuli[sid]?.emotions || []), 6);
    const voiced = lastRows.map(([pid, r]) => ({ who: `${people[pid]?.name} (${people[pid]?.segment}, ${people[pid]?.market})`, s: r.stimuli[sid] })).filter(x => x.s);
    const pick = xs => { const seen = new Set(); return xs.filter(x => !seen.has(x.who.split('(')[1]) && seen.add(x.who.split('(')[1])).slice(0, 3).map(x => `${x.who}: ${x.s.quote}`); };
    out.quotes[sid] = { positive: pick(voiced.filter(x => x.s.sentiment > 0).sort((a, b) => b.s.sentiment - a.s.sentiment || b.s.intent - a.s.intent)), negative: pick(voiced.filter(x => x.s.sentiment < 0).sort((a, b) => a.s.sentiment - b.s.sentiment || a.s.intent - b.s.intent)) };
    const c = out.by_round[last][sid];
    if (c.n && c.n < 30) out.warnings.push(`${sid}: n=${c.n} — read rates as directional, not as a forecast`);
    if (c.n >= 10 && c.intent_sd < 0.6) out.warnings.push(`${sid}: intent is unusually uniform (sd ${c.intent_sd}); the crowd may be speaking in one voice — check persona diversity`);
    if (c.n >= 10 && c.appeal_top2 >= 85) out.warnings.push(`${sid}: ${c.appeal_top2}% top-2 appeal; simulated crowds skew positive — weigh objections and the skeptic segments`);
  }
  if (stimuli.length > 1) {
    const prefs = lastRows.map(([, r]) => r.preferred).filter(Boolean), n = prefs.length;
    out.preference = { n, shares: Object.fromEntries(stimuli.map(sid => { const k = prefs.filter(p => p === sid).length; return [sid, { pct: pct(k, n), ci95: wilson(k, n) }]; })) };
    const ranked = Object.entries(out.preference.shares).filter(([, v]) => v.ci95).sort((a, b) => b[1].pct - a[1].pct);
    if (ranked.length) { const [leader, top] = ranked[0]; out.preference.leader = leader; out.preference.clear = ranked.slice(1).every(([, v]) => top.ci95[0] > v.ci95[1]); }
    if (n && n < lastRows.length) out.warnings.push(`${lastRows.length - n} personas stated no preference`);
  }
  const cited = citations(world), authored = Object.fromEntries(rounds.flatMap(r => posts(world, r)).map(p => [p.id, p]));
  out.influential_posts = Object.entries(cited).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, k]) => ({ id, cited: k, author: `${people[authored[id]?.author]?.name} (${people[authored[id]?.author]?.segment})`, text: authored[id]?.text }));
  const panel = Object.entries(world.experts);
  if (panel.length) out.experts = {
    n: panel.length, verdicts: counts(panel.map(([, e]) => e.verdict), 3), overall_mean: r2(avg(panel.map(([, e]) => e.overall))),
    blocking: panel.flatMap(([id, e]) => e.findings.filter(f => ['P0', 'P1'].includes(f.severity)).map(f => ({ expert: id, ...f }))).slice(0, 12),
    other: panel.reduce((s, [, e]) => s + e.findings.filter(f => !['P0', 'P1'].includes(f.severity)).length, 0),
  };
  if (!out.complete) out.warnings.push('Simulation is incomplete; these numbers cover recorded reactions only');
  out.caveat = 'Simulated personas from one model family: use for direction, objections and wording, never as a market-size or conversion forecast. Validate the decision with real people.';
  while (Buffer.byteLength(JSON.stringify(out)) > PREVIEW && out.influential_posts.length) out.influential_posts.pop();
  return out;
}

export async function status(dir, input) {
  keys(input, ['sim'], []);
  if (!input.sim) {
    const files = await readdir(dir).catch(() => []);
    const sims = [];
    for (const f of files.filter(f => f.endsWith('.json') && !f.startsWith('.')).slice(0, 50)) { const w = await load(dir, f.slice(0, -5)).catch(() => null); if (w) sims.push({ sim: w.id, goal: w.brief.goal, kind: w.brief.kind, personas: Object.keys(w.personas).length, updated_at: w.updated_at }); }
    return { sims };
  }
  const world = await need(dir, input.sim), total = Object.keys(world.personas).length;
  const rounds = Array.from({ length: world.design.rounds + 1 }, (_, r) => ({ round: r, reacted: Object.keys(world.reactions[r] || {}).length, of: total }));
  const current = rounds.find(r => r.reacted < r.of);
  return { sim: world.id, goal: world.brief.goal, kind: world.brief.kind, stimuli: world.brief.stimuli.map(s => ({ id: s.id, label: s.label })), personas: total, mix: mix(Object.values(world.personas)), rounds, experts: Object.keys(world.experts), next: !total ? 'add personas' : current ? `run round ${current.round}` : 'tally and report' };
}

export async function profile(dir, input) {
  keys(input, ['sim', 'persona'], ['sim', 'persona']);
  const world = await need(dir, input.sim), p = world.personas[ident(input.persona, 'persona')];
  if (!p) fail(`Unknown persona "${input.persona}"`);
  const history = Object.keys(world.reactions).map(Number).sort((a, b) => a - b).filter(r => world.reactions[r][p.id]).map(r => ({ round: r, ...world.reactions[r][p.id], feed_seen: feed(world, p.id, r).map(f => `${f.author}: ${f.text}`) }));
  return { sim: world.id, persona: p, stimuli: world.brief.stimuli.map(s => ({ id: s.id, label: s.label })), history, interview: 'Answer as this persona: same voice, same knowledge, same objections. Say "I would not know" rather than invent facts the persona could not have.' };
}

const OPERATIONS = { create, stimulus: addStimulus, add_personas: addPersonas, plan_round: planRound, packet, react, expert, tally, status, profile };
export async function execute(call, operation, env = process.env) {
  if (!call || call.api_version !== 'soot/v1') fail('Unsupported Soot contract');
  const run = OPERATIONS[operation]; if (!run) fail('Unknown Micro Fish operation');
  const input = typeof call.input === 'string' ? JSON.parse(call.input || '{}') : (call.input ?? {});
  return run(join(stateDirectory(env), scope(call)), input);
}
