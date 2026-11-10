import { run } from '../tools/loop.mjs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { fakeStore } from './fake-store.mjs';

export const T0 = Date.parse('2026-11-09T01:30:00Z'); // Monday 08:30 in Asia/Ho_Chi_Minh
export const DAY = 86_400_000;

/** One workspace: an in-memory pack store, a clock and the env the host would grant. */
export function world({ env = {}, home } = {}) {
  const w = { now: T0 };
  w.store = fakeStore({ clock: () => w.now });
  w.env = { PATH: process.env.PATH, HOME: home ?? '/nonexistent-home', BABYSIT_HOME: mkdtempSync(join(tmpdir(), 'babysit-home-')), ...env };
  /** Where a Go writes the requirement of a ticket: beside the tickets, never in the product repo. */
  w.reqPath = (repo, ref) => join(w.env.BABYSIT_HOME, 'requirements', basename(repo), `REQ-${ref}.md`);
  w.call = (name, input = {}, extra = {}) => run(name, { input, ...extra }, { store: w.store, now: w.now, env: w.env, fetchImpl: fetch, apiTimeoutMs: 500 });
  w.rows = table => w.store.data[table];
  return w;
}

export const ITEM = {
  content: {
    title: 'Truyện tiên hiệp full được tìm nhiều', product: 'lohi', kind: 'content', query: 'truyện tiên hiệp full',
    evidence_refs: ['source:google', 'metric:signups'], signal_count: 3, est_effort: 'S', est_value: 'medium', confidence: 0.6,
    part: 'marketing', awareness: 'problem', target_outcome: 'signups', expected_delta: 20, check_after_days: 7,
  },
  product: {
    title: 'Hoàn tiền tự động trong 7 ngày', product: 'lohi', kind: 'product', summary: 'Cho khách tự yêu cầu hoàn tiền trong ứng dụng để giảm số cuộc chuyển người.',
    evidence_refs: ['reason:refund', 'gap:hoan-tien'], signal_count: 5, est_effort: 'M', est_value: 'high', confidence: 0.7,
    part: 'delivery', pain: 'Khách muốn hoàn tiền phải chờ người trả lời nhiều ngày', moat: 'switching', target_outcome: 'support_handoffs', expected_delta: -3, check_after_days: 30,
  },
};
