// The micro-CRM: contacts, the ways to reach or recognize them, one deal per
// contact and product, and an append-only log of touches. Records are passive:
// nothing here starts a run, answers anyone or creates a record on its own; a
// Soot calls a tool, or a recurring task runs one and wakes a Soot on `notify`.
import { randomBytes } from 'node:crypto';
import { fail, CrmError, eq, gte, lte, inList, PAGE } from './store.mjs';
import { identity, product, principalOf, REACH_KINDS } from './norm.mjs';

export const OPEN = ['new', 'contacted', 'qualified', 'proposal'];
export const CLOSED = ['won', 'lost', 'churned'];
export const STAGES = [...OPEN, ...CLOSED];
const CONSENT = ['yes', 'no', 'unknown'];

const iso = ms => new Date(ms).toISOString();
/** Stored timestamps come back as `…05.000000Z`; compare instants, never strings. */
const ms = v => (v ? Date.parse(v) : -Infinity);
const newRef = prefix => `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;

function text(v, max, name, required = false) {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    if (required) fail('invalid_request', `${name} is required.`);
    return null;
  }
  if (typeof v !== 'string') fail('invalid_request', `${name} must be text.`);
  const s = v.trim();
  if ([...s].length > max) fail('invalid_request', `${name} is at most ${max} characters.`);
  return s;
}
function when(v, name) {
  if (v === undefined || v === null || v === '') return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) fail('invalid_request', `${name} must be a date and time (ISO 8601).`);
  return iso(t);
}
function oneOf(v, list, name) {
  if (v === undefined || v === null) return null;
  if (!list.includes(v)) fail('invalid_request', `${name} must be one of ${list.join(', ')}.`);
  return v;
}
function writable(ctx) {
  if (ctx.readOnly) fail('read_only', 'This run may only read; nothing was changed.');
}
function needProduct(input, ctx) {
  const p = product(input.product, ctx.product);
  if (!p) fail('product_required', 'Say which product this is for (product), or run it from a task or schedule of that product.');
  return p;
}

// ---------- views ----------

const dealView = d => d && ({
  key: d.key, contact: d.contact, product: d.product, stage: d.stage, since: d.stage_at,
  next_step: d.next_step, next_at: d.next_at, value: d.value, currency: d.currency,
  source: d.source, owner: d.owner, last_touch_at: d.last_touch_at, lost_reason: d.lost_reason,
});
const touchView = t => ({ at: t.at, product: t.product, channel: t.channel, direction: t.direction, summary: t.summary, link: t.link, by: t.by_soot });

async function contactByRef(store, ref) {
  const r = text(ref, 16, 'contact', true);
  const c = await store.one('contacts', [eq('ref', r)]);
  if (!c) fail('not_found', `No contact ${r}. Find it with crm_contact_find.`);
  return c;
}

async function card(store, c, recent = 5) {
  const ids = await store.query('identities', [eq('contact', c.ref)], { order: 'created_at', desc: false, limit: 50 });
  const deals = await store.query('deals', [eq('contact', c.ref)], { order: 'updated_at', desc: true, limit: 50 });
  const touches = recent ? await store.query('touches', [eq('contact', c.ref)], { order: 'at', desc: true, limit: recent }) : [];
  return {
    ref: c.ref, name: c.name, org: c.org, note: c.note, consent: c.consent, owner: c.owner,
    tags: c.tags ?? [], linked_person: !!c.principal, created_at: c.created_at,
    identities: ids.map(i => ({ kind: i.kind, value: i.value })),
    deals: deals.map(dealView), recent: touches.map(touchView),
  };
}

const conflict = (message, candidates) => ({
  ok: false, reason_code: 'identity_conflict', message,
  candidates: candidates.map(c => ({ ref: c.ref, name: c.name, org: c.org })),
  next: 'Nothing was saved. If these are the same person, a person decides and crm_contact_merge joins them; otherwise save without the shared identity.',
});

// ---------- contacts ----------

/** Create or update one contact. Joins an existing contact only on an exact
 * identity (or the conversation's signed-in person), never on a name. */
async function saveContact(input, ctx) {
  const { store, now } = ctx;
  const prod = product(input.product, ctx.product);
  const ids = [...new Map((input.identities ?? []).map(i => identity(i, prod)).map(i => [i.key, i])).values()];
  if (ids.length > 10) fail('invalid_request', 'At most 10 identities per call.');
  const principal = input.link_conversation_person ? principalOf(ctx) : null;
  if (input.link_conversation_person && !principal) fail('no_person', 'This conversation has no signed-in person to link; leave link_conversation_person out.');
  const name = text(input.name, 120, 'name'), org = text(input.org, 120, 'org'), note = text(input.note, 1000, 'note');
  const owner = text(input.owner, 64, 'owner');
  const consentIn = oneOf(input.consent, CONSENT, 'consent');
  if (input.tags !== undefined && (!Array.isArray(input.tags) || input.tags.length > 10 || input.tags.some(t => typeof t !== 'string' || t.length > 32))) fail('invalid_request', 'tags is a list of at most 10 short labels.');

  const hits = ids.length ? await store.query('identities', [inList('key', ids.map(i => i.key))], { limit: ids.length }) : [];
  const found = new Map();
  for (const h of hits) found.set(h.contact, h.kind);
  if (principal) {
    const byPerson = await store.one('contacts', [eq('principal', principal)]);
    if (byPerson && !found.has(byPerson.ref)) found.set(byPerson.ref, 'person');
  }

  let target = null, matchedBy = null;
  if (input.ref) {
    target = await contactByRef(store, input.ref);
    const others = [...found.keys()].filter(r => r !== target.ref);
    if (others.length) return conflict(`An identity in this call already belongs to another contact.`, await Promise.all(others.map(r => contactByRef(store, r))));
  } else {
    const rid = text(input.request_id, 64, 'request_id');
    if (rid) {
      const replay = await store.one('contacts', [eq('request_id', rid)]);
      if (replay) return { ok: true, replayed: true, created: false, contact: await card(store, replay) };
    }
    if (found.size > 1) return conflict('These identities belong to different contacts.', await Promise.all([...found.keys()].map(r => contactByRef(store, r))));
    if (found.size === 1) {
      const [[ref, kind]] = [...found];
      target = await contactByRef(store, ref);
      matchedBy = kind;
    }
  }
  if (target?.principal && principal && target.principal !== principal) return conflict('This contact is linked to another signed-in person.', [target]);

  const consent = consentIn ?? target?.consent ?? 'unknown';
  const reach = ids.filter(i => REACH_KINDS.includes(i.kind));
  if (reach.length && consent !== 'yes') fail('consent_required', `Storing ${reach.map(i => i.kind).join(', ')} needs the person's consent to be contacted (consent "yes"). Ask first, or save without it.`);

  let created = false, possible = [];
  if (!target) {
    const rid = text(input.request_id, 64, 'request_id');
    if (!rid) fail('invalid_request', 'A new contact needs request_id (any unique string; a repeat returns the same contact).');
    if (!name && !org && !ids.length && !principal) fail('invalid_request', 'A contact needs a name, an organization, an identity or the linked person.');
    if (name || org) possible = (await store.search('contacts', name ?? org, [], 5)).map(c => ({ ref: c.ref, name: c.name, org: c.org }));
    const ref = newRef('C');
    await store.insert('contacts', {
      ref, request_id: rid, name, org, note, owner, consent, consent_at: consentIn ? iso(now) : null,
      tags: input.tags ?? null, merged: null, principal,
    });
    target = await store.one('contacts', [eq('ref', ref)]);
    created = true;
  } else {
    const set = {};
    if (name !== null) set.name = name;
    if (org !== null) set.org = org;
    if (input.note !== undefined) set.note = note;
    if (input.owner !== undefined) set.owner = owner;
    if (input.tags !== undefined) set.tags = input.tags;
    if (consentIn && consentIn !== target.consent) Object.assign(set, { consent: consentIn, consent_at: iso(now) });
    if (principal && !target.principal) set.principal = principal;
    if (Object.keys(set).length) await store.update('contacts', target.id, set);
    if (set.principal) for (const t of ['identities', 'deals', 'touches']) await store.update(t, [eq('contact', target.ref)], { principal });
    target = { ...target, ...set };
  }

  const mine = new Set(hits.filter(h => h.contact === target.ref).map(h => h.key));
  for (const i of ids) {
    if (mine.has(i.key)) continue;
    try {
      await store.insert('identities', { key: i.key, contact: target.ref, kind: i.kind, value: i.value, product: i.kind === 'account' ? prod : null, principal: target.principal ?? null });
    } catch (e) {
      if (e instanceof CrmError && e.code === 'conflict') fail('identity_conflict', `${i.kind} ${i.value} was just saved on another contact; find it and decide.`);
      throw e;
    }
  }
  let forgotten = 0;
  if (consent === 'no') {
    // Consent withdrawn: the ways to reach them go; who they are and what happened stay.
    for (const r of await store.query('identities', [eq('contact', target.ref), inList('kind', REACH_KINDS)], { limit: 50 })) forgotten += await store.remove('identities', r.id);
  }
  return {
    ok: true, created, ...(matchedBy && { matched_by: matchedBy }), ...(forgotten && { forgotten_reach: forgotten }),
    contact: await card(store, target), ...(possible.length && { possible_duplicates: possible }),
  };
}

export async function contact_save(input, ctx) {
  writable(ctx);
  return saveContact(input, ctx);
}

export async function contact_find(input, ctx) {
  const { store } = ctx;
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10);
  const prod = product(input.product, null);
  let contacts = [];
  if (input.ref) {
    const c = await store.one('contacts', [eq('ref', text(input.ref, 16, 'ref', true))]);
    contacts = c ? [c] : [];
  } else if (input.identity) {
    const i = identity(input.identity, product(input.product, ctx.product));
    const h = await store.one('identities', [eq('key', i.key)]);
    if (h) contacts = [await contactByRef(store, h.contact)];
  } else if (input.conversation_person) {
    const p = principalOf(ctx);
    if (!p) return { ok: true, contacts: [], note: 'This conversation has no signed-in person.' };
    const c = await store.one('contacts', [eq('principal', p)]);
    contacts = c ? [c] : [];
  } else {
    const q = text(input.query, 120, 'query', true);
    const byName = await store.search('contacts', q, [], 20);
    const byIdentity = await store.search('identities', q, [], 20);
    const refs = [...new Set([...byName.map(c => c.ref), ...byIdentity.map(i => i.contact)])];
    const rows = refs.length ? await store.query('contacts', [inList('ref', refs)], { limit: refs.length }) : [];
    const order = new Map(refs.map((r, n) => [r, n]));
    contacts = rows.sort((a, b) => order.get(a.ref) - order.get(b.ref));
  }
  let cards = await Promise.all(contacts.map(c => card(ctx.store, c, input.ref || input.identity || input.conversation_person ? 10 : 3)));
  if (prod) cards = cards.filter(c => c.deals.some(d => d.product === prod));
  return { ok: true, contacts: cards.slice(0, limit), ...(cards.length > limit && { more: cards.length - limit }) };
}

export async function contact_merge(input, ctx) {
  writable(ctx);
  const { store, now } = ctx;
  const keepRef = text(input.keep, 16, 'keep', true), dropRef = text(input.drop, 16, 'drop', true);
  if (keepRef === dropRef) fail('invalid_request', 'keep and drop are the same contact.');
  const keep = await contactByRef(store, keepRef);
  const drop = await store.one('contacts', [eq('ref', dropRef)]);
  if (!drop) {
    if ((keep.merged ?? []).includes(dropRef)) return { ok: true, replayed: true, contact: await card(store, keep) };
    fail('not_found', `No contact ${dropRef}.`);
  }
  if (keep.principal && drop.principal && keep.principal !== drop.principal) fail('identity_conflict', 'Both contacts are linked to different signed-in people; they are not the same person.');
  const principal = keep.principal ?? drop.principal ?? null;
  let dealsMoved = 0, dealsDropped = 0;
  for (const d of await store.query('deals', [eq('contact', dropRef)], { limit: 50 })) {
    const key = `${keepRef}@${d.product}`;
    if (await store.one('deals', [eq('key', key)])) { await store.remove('deals', d.id); dealsDropped++; }
    else { await store.update('deals', d.id, { key, contact: keepRef, principal }); dealsMoved++; }
  }
  const moved = {};
  for (const t of ['identities', 'touches']) moved[t] = await store.update(t, [eq('contact', dropRef)], { contact: keepRef, principal });
  const set = { merged: [...new Set([...(keep.merged ?? []), dropRef, ...(drop.merged ?? [])])], principal };
  for (const k of ['name', 'org', 'note', 'owner']) if (!keep[k] && drop[k]) set[k] = drop[k];
  if (ms(drop.consent_at) > ms(keep.consent_at)) Object.assign(set, { consent: drop.consent, consent_at: drop.consent_at });
  await store.update('contacts', keep.id, set);
  await store.remove('contacts', drop.id);
  await store.insert('touches', {
    request_id: `merge:${keepRef}:${dropRef}`, contact: keepRef, product: null, channel: 'crm', direction: 'note',
    summary: `Merged ${dropRef} into this contact${input.reason ? `: ${text(input.reason, 200, 'reason')}` : ''}.`, at: iso(now), by_soot: ctx.soot, principal,
  });
  return { ok: true, moved: { ...moved, deals: dealsMoved }, deals_dropped: dealsDropped, contact: await card(store, { ...keep, ...set }) };
}

export async function contact_forget(input, ctx) {
  writable(ctx);
  const { store } = ctx;
  const ref = text(input.contact, 16, 'contact', true);
  text(input.reason, 200, 'reason', true);
  const c = await store.one('contacts', [eq('ref', ref)]);
  if (!c) return { ok: true, removed: { contacts: 0, identities: 0, deals: 0, touches: 0, inbox: 0 }, note: `Nothing is stored under ${ref}.` };
  const removed = {};
  for (const t of ['identities', 'deals', 'touches', 'inbox']) removed[t] = await store.remove(t, [eq('contact', ref)]);
  removed.contacts = await store.remove('contacts', c.id);
  return { ok: true, removed, note: 'Conversations, memory and other packs keep their own copies; erasing a signed-in person through Nest removes those too.' };
}

// ---------- leads, touches, deals ----------

async function touch(ctx, row) {
  const { store } = ctx;
  try {
    await store.insert('touches', row);
  } catch (e) {
    if (!(e instanceof CrmError && e.code === 'conflict')) throw e;
  }
}

export async function lead_record(input, ctx) {
  writable(ctx);
  const { store, now } = ctx;
  const rid = text(input.request_id, 64, 'request_id', true);
  const prod = needProduct(input, ctx);
  const summary = text(input.summary, 500, 'summary', true);
  const channel = text(input.channel, 32, 'channel') ?? 'chat';
  const link = text(input.link, 500, 'link'), source = text(input.source, 64, 'source');
  const nextStep = text(input.next_step, 200, 'next_step') ?? 'Reply to this lead';
  const nextAt = when(input.next_at, 'next_at') ?? iso(now);
  const replay = await store.one('touches', [eq('request_id', `lead:${rid}`)]);
  if (replay) {
    const c = await contactByRef(store, replay.contact);
    return { ok: true, replayed: true, contact: await card(store, c), deal: dealView(await store.one('deals', [eq('key', `${c.ref}@${prod}`)])) };
  }
  const saved = await saveContact({
    name: input.name, org: input.org, note: input.note, identities: input.identities, consent: input.consent,
    link_conversation_person: input.link_conversation_person, product: prod, request_id: rid, owner: input.owner,
  }, ctx);
  if (!saved.ok) return saved;
  const ref = saved.contact.ref, key = `${ref}@${prod}`;
  const principal = (await store.one('contacts', [eq('ref', ref)]))?.principal ?? null;
  let deal = await store.one('deals', [eq('key', key)]), dealState;
  if (!deal) {
    await store.insert('deals', {
      key, contact: ref, product: prod, stage: 'new', stage_at: iso(now), source, owner: text(input.owner, 64, 'owner'),
      next_step: nextStep, next_at: nextAt, last_touch_at: iso(now), value: null, currency: null, won_at: null, closed_at: null, lost_reason: null, principal,
    });
    await touch(ctx, { request_id: `stage:${key}:new:${now}`, contact: ref, product: prod, channel: 'crm', direction: 'stage', stage: 'new', summary: `— → new${source ? ` (source ${source})` : ''}`, at: iso(now), by_soot: ctx.soot, principal });
    dealState = 'created';
  } else {
    await store.update('deals', deal.id, { last_touch_at: iso(now) });
    dealState = OPEN.includes(deal.stage) ? 'open' : 'closed';
  }
  await touch(ctx, { request_id: `lead:${rid}`, contact: ref, product: prod, channel, direction: 'in', stage: null, summary, link, at: iso(now), by_soot: ctx.soot, principal });
  deal = await store.one('deals', [eq('key', key)]);
  return {
    ok: true, deal_state: dealState, ...(saved.matched_by && { matched_by: saved.matched_by }),
    contact: await card(store, await contactByRef(store, ref)), deal: dealView(deal),
    ...(saved.possible_duplicates && { possible_duplicates: saved.possible_duplicates }),
    ...(dealState === 'closed' && { next: `This contact already has a ${deal.stage} deal for ${prod}; reopen it with crm_deal_update only if this is a new buying intent.` }),
  };
}

export async function touch_record(input, ctx) {
  writable(ctx);
  const { store, now } = ctx;
  const rid = text(input.request_id, 64, 'request_id', true);
  const replay = await store.one('touches', [eq('request_id', rid)]);
  if (replay) return { ok: true, replayed: true, touch: touchView(replay) };
  const c = await contactByRef(store, input.contact);
  const prod = product(input.product, ctx.product);
  const direction = oneOf(input.direction, ['in', 'out', 'note'], 'direction') ?? 'note';
  const at = when(input.at, 'at') ?? iso(now);
  const row = {
    request_id: rid, contact: c.ref, product: prod, channel: text(input.channel, 32, 'channel', true), direction, stage: null,
    summary: text(input.summary, 500, 'summary', true), link: text(input.link, 500, 'link'), at, by_soot: ctx.soot, principal: c.principal ?? null,
  };
  await store.insert('touches', row);
  let deal = null;
  if (prod) {
    deal = await store.one('deals', [eq('key', `${c.ref}@${prod}`)]);
    if (deal && ms(deal.last_touch_at) < ms(at)) {
      await store.update('deals', deal.id, { last_touch_at: at });
      deal = { ...deal, last_touch_at: at };
    }
  }
  return { ok: true, touch: touchView(row), deal: dealView(deal) };
}

export async function deal_update(input, ctx) {
  writable(ctx);
  const { store, now } = ctx;
  const c = await contactByRef(store, input.contact);
  const prod = needProduct(input, ctx);
  const key = `${c.ref}@${prod}`;
  const before = await store.one('deals', [eq('key', key)]);
  const from = before?.stage ?? null;
  const to = oneOf(input.stage, STAGES, 'stage') ?? from ?? 'new';
  if (to === 'churned' && from !== 'won' && from !== 'churned') fail('invalid_transition', 'Only a won deal can churn.');
  if (from === 'won' && OPEN.includes(to)) fail('invalid_transition', 'A won deal does not go back to an open stage; it churns, or a new buying intent is a note on it.');
  const set = {};
  const lostReason = text(input.lost_reason, 200, 'lost_reason');
  if ((to === 'lost' || to === 'churned') && to !== from && !lostReason) fail('reason_required', `Moving to ${to} needs lost_reason (why, in a few words).`);
  if (input.next_step !== undefined) set.next_step = text(input.next_step, 200, 'next_step');
  if (input.next_at !== undefined) set.next_at = when(input.next_at, 'next_at');
  if (input.value !== undefined) {
    if (input.value !== null && (typeof input.value !== 'number' || !Number.isFinite(input.value) || input.value < 0)) fail('invalid_request', 'value is a number ≥ 0.');
    set.value = input.value;
  }
  if (input.currency !== undefined) set.currency = text(input.currency, 8, 'currency')?.toUpperCase() ?? null;
  if (input.source !== undefined) set.source = text(input.source, 64, 'source');
  if (input.owner !== undefined) set.owner = text(input.owner, 64, 'owner');
  if (to !== from) {
    set.stage = to;
    set.stage_at = iso(now);
    if (to === 'won') Object.assign(set, { won_at: iso(now), closed_at: iso(now), lost_reason: null });
    if (to === 'lost' || to === 'churned') Object.assign(set, { closed_at: iso(now), lost_reason: lostReason, next_step: null, next_at: null });
    if (OPEN.includes(to)) Object.assign(set, { closed_at: null, lost_reason: null });
  } else if (lostReason && CLOSED.includes(to)) set.lost_reason = lostReason;
  const effective = { ...(before ?? {}), ...set };
  if (OPEN.includes(to) && (!effective.next_step || !effective.next_at)) fail('next_step_required', 'An open deal always has a next step and when (next_step, next_at).');
  if (!before) {
    await store.insert('deals', {
      key, contact: c.ref, product: prod, stage: to, stage_at: iso(now), source: null, owner: null, value: null, currency: null,
      next_step: null, next_at: null, last_touch_at: null, won_at: null, closed_at: null, lost_reason: null, principal: c.principal ?? null, ...set,
    });
  } else if (Object.keys(set).length) {
    await store.update('deals', before.id, set);
  }
  const changed = to !== from;
  const note = text(input.note, 300, 'note');
  if (changed) await touch(ctx, { request_id: `stage:${key}:${to}:${now}`, contact: c.ref, product: prod, channel: 'crm', direction: 'stage', stage: to, summary: `${from ?? '—'} → ${to}${note ? `: ${note}` : ''}`, at: iso(now), by_soot: ctx.soot, principal: c.principal ?? null });
  const deal = await store.one('deals', [eq('key', key)]);
  const outcome = changed && to === 'won' ? 'deal_won' : changed && to === 'qualified' && (from === null || from === 'new' || from === 'contacted') ? 'lead_qualified' : null;
  return { ok: true, changed, deal: dealView(deal), ...(outcome && { record_outcome: { id: outcome, ref: `crm:${key}` } }) };
}

// ---------- the loop: what is due, what came in, how the pipeline does ----------

export async function followups_due(input, ctx) {
  const { store, now } = ctx;
  const prod = product(input.product, null);
  const horizon = Math.min(Math.max(Number(input.horizon_hours) || 0, 0), 168);
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
  const where = [lte('next_at', iso(now + horizon * 3600e3))];
  if (prod) where.push(eq('product', prod));
  const rows = await store.query('deals', where, { order: 'next_at', desc: false, limit: limit + 1 });
  const due = rows.slice(0, limit);
  const refs = [...new Set(due.map(d => d.contact))];
  const people = new Map((refs.length ? await store.query('contacts', [inList('ref', refs)], { limit: refs.length }) : []).map(c => [c.ref, c]));
  const held = await store.query('inbox', [eq('state', 'held')], { order: 'created_at', desc: false, limit: 20 });
  const items = due.map(d => ({
    ...dealView(d), name: people.get(d.contact)?.name ?? null, org: people.get(d.contact)?.org ?? null,
    overdue_hours: Math.max(0, Math.floor((now - Date.parse(d.next_at)) / 3600e3)),
  }));
  const notify = items.length > 0 || held.length > 0;
  return {
    ok: true, notify, wake: notify, due: items, ...(rows.length > limit && { more: true }),
    held: held.map(h => ({ request_id: h.request_id, kind: h.kind, product: h.product, from_team: h.from_team, reason: h.reason })),
  };
}

export async function pipeline_report(input, ctx) {
  const { store, now } = ctx;
  const prod = product(input.product, null);
  const days = Math.min(Math.max(Number(input.days) || 30, 1), 365);
  const since = iso(now - days * 86400e3);
  const scope = prod ? [eq('product', prod)] : [];
  let truncated = false;
  const page = async (table, where, order) => {
    const rows = await store.query(table, [...scope, ...where], { order, desc: true, limit: PAGE });
    if (rows.length >= PAGE) truncated = true;
    return rows;
  };
  const open = {};
  for (const stage of OPEN) {
    const rows = await page('deals', [eq('stage', stage)], 'stage_at');
    open[stage] = { count: rows.length, value: sumBy(rows) };
  }
  const created = await page('deals', [gte('created_at', since)], 'created_at');
  const closed = await page('deals', [gte('closed_at', since)], 'closed_at');
  const moves = await page('touches', [eq('direction', 'stage'), gte('at', since)], 'at');
  const entered = Object.fromEntries(STAGES.map(s => [s, 0]));
  for (const m of moves) if (m.stage in entered) entered[m.stage]++;
  const won = closed.filter(d => d.stage === 'won'), lost = closed.filter(d => d.stage === 'lost'), churned = closed.filter(d => d.stage === 'churned');
  const sources = new Map();
  for (const d of created) {
    const s = d.source ?? '(none)';
    const row = sources.get(s) ?? { source: s, new: 0, qualified_or_later: 0, won: 0 };
    row.new++;
    if (['qualified', 'proposal', 'won'].includes(d.stage) || (d.stage === 'churned')) row.qualified_or_later++;
    if (d.stage === 'won' || d.stage === 'churned') row.won++;
    sources.set(s, row);
  }
  const lostReasons = {};
  for (const d of lost) lostReasons[d.lost_reason ?? '(none)'] = (lostReasons[d.lost_reason ?? '(none)'] ?? 0) + 1;
  return {
    ok: true, product: prod, days, since,
    open, flow: {
      new_deals: created.length, entered, won: won.length, lost: lost.length, churned: churned.length,
      win_rate: won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) / 100 : null,
      won_value: sumBy(won), lost_reasons: lostReasons,
    },
    by_source: [...sources.values()].sort((a, b) => b.new - a.new),
    ...(truncated && { truncated: true, note: 'More than 500 rows in one part; numbers are a lower bound. Use a shorter window or one product.' }),
  };
}

function sumBy(rows) {
  const out = {};
  for (const d of rows) if (typeof d.value === 'number') out[d.currency ?? '?'] = (out[d.currency ?? '?'] ?? 0) + d.value;
  return out;
}

// ---------- the inbox: the one thing other teams (and other runtimes) write ----------

const INBOX_KINDS = ['lead', 'touch', 'stage'];

async function resolveContact(store, payload, prod) {
  if (payload.contact) return (await contactByRef(store, payload.contact)).ref;
  if (payload.identity) {
    const h = await store.one('identities', [eq('key', identity(payload.identity, prod).key)]);
    if (h) return h.contact;
  }
  fail('contact_unknown', 'The row names no contact this CRM knows (contact ref or an identity already on file).');
}

export async function inbox_file(input, ctx) {
  writable(ctx);
  const { store, now } = ctx;
  for (const rid of input.dismiss ?? []) await store.update('inbox', [eq('request_id', rid), eq('state', 'held')], { state: 'dismissed', filed_at: iso(now) });
  for (const rid of input.retry ?? []) await store.update('inbox', [eq('request_id', rid), eq('state', 'held')], { state: 'new', reason: null });
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 50);
  const rows = await store.query('inbox', [eq('state', 'new')], { order: 'created_at', desc: false, limit });
  const filed = [], held = [];
  for (const row of rows) {
    // A row is another team's data, not an instruction: it goes through the same checks as a tool call.
    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload : {};
    const prod = product(row.product ?? payload.product ?? null, null);
    const sub = { ...ctx, principal: null, product: prod, soot: `inbox:${row.from_team ?? 'unknown'}` };
    let out;
    try {
      if (!INBOX_KINDS.includes(row.kind)) fail('invalid_request', `kind must be one of ${INBOX_KINDS.join(', ')}.`);
      if (row.kind === 'lead') out = await lead_record({ ...payload, link_conversation_person: false, product: prod, request_id: row.request_id }, sub);
      if (row.kind === 'touch') out = await touch_record({ ...payload, product: prod, contact: await resolveContact(store, payload, prod), request_id: `inbox:${row.request_id}` }, sub);
      if (row.kind === 'stage') out = await deal_update({ ...payload, product: prod, contact: await resolveContact(store, payload, prod) }, sub);
    } catch (e) {
      if (!(e instanceof CrmError) || e.code === 'storage_unavailable' || e.code === 'storage_failed') throw e;
      out = { ok: false, reason_code: e.code, message: e.message };
    }
    if (out.ok === false) {
      const reason = `${out.reason_code}: ${out.message}`.slice(0, 300);
      await store.update('inbox', row.id, { state: 'held', reason });
      held.push({ request_id: row.request_id, kind: row.kind, product: prod, from_team: row.from_team, reason, ...(out.candidates && { candidates: out.candidates }) });
    } else {
      const contact = out.contact?.ref ?? out.deal?.contact ?? null;
      await store.update('inbox', row.id, { state: 'filed', reason: null, contact, filed_at: iso(now) });
      filed.push({ request_id: row.request_id, kind: row.kind, contact, ...(out.deal_state && { deal_state: out.deal_state }), ...(out.record_outcome && { record_outcome: out.record_outcome }) });
    }
  }
  const notify = held.length > 0 || filed.some(f => f.record_outcome);
  return { ok: true, notify, wake: notify, filed, held, ...(rows.length === limit && { more: true }) };
}
