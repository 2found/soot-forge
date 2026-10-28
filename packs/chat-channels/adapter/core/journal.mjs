// Delivery journal in SOOT_CHANNEL_STATE_DIR (channel-adapter.v1 §6.1–6.2). It holds
// ids only — finished inbound request ids, receipt_id → platform message ids, the
// outbox cursor and the platform offset — never message text or tokens.
import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const TTL_MS = 7 * 24 * 3600 * 1000;
const FILE = 'journal.json';

export class Journal {
  constructor(dir, {now = Date.now} = {}) {
    this.dir = dir;
    this.now = now;
    mkdirSync(dir, {recursive: true, mode: 0o700});
    this.state = {v: 1, inbound: {}, receipts: {}, cursor: null, offset: null};
    try {
      const loaded = JSON.parse(readFileSync(join(dir, FILE), 'utf8'));
      if (loaded?.v === 1) Object.assign(this.state, loaded);
    } catch {}
    this.prune();
  }

  prune() {
    const floor = this.now() - TTL_MS;
    for (const [id, at] of Object.entries(this.state.inbound)) if (at < floor) delete this.state.inbound[id];
    for (const [id, entry] of Object.entries(this.state.receipts)) if (entry.at < floor) delete this.state.receipts[id];
  }

  // Atomic replace: a crash leaves either the old or the new journal, never half of one.
  save() {
    const path = join(this.dir, FILE);
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.state), {mode: 0o600});
    renameSync(temp, path);
  }

  hasInbound(requestID) { return Object.hasOwn(this.state.inbound, requestID); }
  finishInbound(requestID) {
    this.state.inbound[requestID] = this.now();
    this.save();
  }

  delivered(receiptID) { return this.state.receipts[receiptID]?.ids ?? null; }
  recordDelivery(receiptID, chatID, ids) {
    this.state.receipts[receiptID] = {chat: String(chatID), ids: ids.map(String), at: this.now()};
    this.save();
  }

  // Which outbox item a platform message belongs to (for reply_to.receipt_id, §4.6).
  receiptFor(chatID, messageID) {
    for (const [receiptID, entry] of Object.entries(this.state.receipts))
      if (entry.chat === String(chatID) && entry.ids.includes(String(messageID))) return receiptID;
    return null;
  }

  get cursor() { return this.state.cursor; }
  setCursor(seq) {
    if (this.state.cursor !== null && seq <= this.state.cursor) return;
    this.state.cursor = seq;
    this.save();
  }

  get offset() { return this.state.offset; }
  setOffset(offset) {
    this.state.offset = offset;
    this.save();
  }
}
