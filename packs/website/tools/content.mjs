import { openSync, readSync, closeSync, existsSync, mkdirSync, readdirSync, lstatSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const destinations = new Set(['/download', '/#how-it-works', '/#nest', '/#showcase', '/blog', '/vi/download', '/vi/blog', '/vi#how-it-works', '/vi#nest', '/vi#showcase']);
export function publicationLanguage(value = 'en') {
  if (value !== 'en' && value !== 'vi') throw new Error('Invalid publication language');
  return value;
}
function text(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid content text');
  return value;
}
function keys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== allowed.length || Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Invalid content fields');
}
export function validatePublication(value) {
  const hasLanguage = value && Object.hasOwn(value, 'language');
  keys(value, ['id', 'title', 'intro', 'blocks', ...(hasLanguage ? ['language'] : [])]);
  if (hasLanguage && (value.language !== 'en' && value.language !== 'vi')) throw new Error('Invalid publication language');
  if (typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(value.id)) throw new Error('Invalid publication id');
  text(value.title, 100); text(value.intro, 400);
  if (!Array.isArray(value.blocks) || value.blocks.length < 1 || value.blocks.length > 6) throw new Error('Expected 1–6 content blocks');
  const blocks = value.blocks.map(block => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) throw new Error('Invalid block');
    if (block.type === 'paragraph' || block.type === 'note') {
      keys(block, ['type', 'text']); return {type: block.type, text: text(block.text, 1200)};
    } else if (block.type === 'list') {
      keys(block, ['type', 'title', 'items']); text(block.title, 100);
      if (!Array.isArray(block.items) || block.items.length < 1 || block.items.length > 5) throw new Error('Expected 1–5 list items');
      return {type: 'list', title: block.title, items: block.items.map(item => text(item, 200))};
    } else if (block.type === 'cta') {
      keys(block, ['type', 'label', 'href']); text(block.label, 80);
      if (!destinations.has(block.href)) throw new Error('Invalid content destination');
      return {type: 'cta', label: block.label, href: block.href};
    }
    throw new Error('Unknown content block');
  });
  // Do not insert language:"en" into omitted legacy input. Its canonical bytes,
  // hash, and replay discipline must remain exactly the old four-key contract.
  const content = {id: value.id, title: value.title, intro: value.intro, blocks, ...(hasLanguage ? {language: value.language} : {})};
  if (Buffer.byteLength(JSON.stringify(content)) > 16384) throw new Error('Content exceeds 16 KiB');
  return content;
}
export function boundedFile(path, max) {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(max + 1); let size = 0, n;
    while (size <= max && (n = readSync(fd, buffer, size, max + 1 - size, null))) size += n;
    if (size > max) throw new Error('File exceeds limit');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid publication');
  const {author, updatedAt, ...content} = value;
  const clean = validatePublication(content);
  if (author !== 'website-marketer' || typeof updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(updatedAt) || !Number.isFinite(Date.parse(updatedAt))) throw new Error('Invalid publication provenance');
  return {...clean, author, updatedAt};
}
function legacyPublication(directory) {
  try {
    const content = record(JSON.parse(boundedFile(join(directory, 'marketing.json'), 20000)));
    if ((content.language ?? 'en') !== 'en') throw new Error('Legacy publication must be English');
    return content;
  } catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
function readSnapshots(directory) {
  const path = join(directory, 'marketing.sqlite');
  if (!publicationExists(path)) return {en: legacyPublication(directory), vi: null};
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    db.exec('PRAGMA busy_timeout=3000; BEGIN;');
    // One read snapshot spans schema detection and both locale pointers. A cold
    // or killed uncommitted writer must not hide the last legacy publication.
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'").get() || !db.prepare("SELECT key FROM metadata WHERE key='imported'").get()) return {en: legacyPublication(directory), vi: null};
    if (!db.prepare("SELECT key FROM metadata WHERE key='locales-v1'").get()) {
      const row = db.prepare('SELECT body FROM current WHERE slot=1').get();
      const en = row ? record(JSON.parse(row.body)) : null;
      if (en && (en.language ?? 'en') !== 'en') throw new Error('Invalid legacy pointer');
      return {en, vi: null};
    }
    const snapshots = {en: null, vi: null};
    for (const row of db.prepare('SELECT language,body FROM current_locales').all()) {
      const language = publicationLanguage(row.language), content = record(JSON.parse(row.body));
      if ((content.language ?? 'en') !== language) throw new Error('Publication language does not match pointer');
      snapshots[language] = content;
    }
    return snapshots;
  } finally {try {db.exec('ROLLBACK');} finally {db.close();}}
}
// Exact-locale inspect: missing VI is null, never an implicit English publication.
export function readPublication(directory, language = 'en') {
  const selected = publicationLanguage(language);
  return readSnapshots(directory)[selected];
}
// Public selection explicitly labels the English fallback; no synthetic translation.
export function readPublicationSelection(directory, language = 'en') {
  const requestedLanguage = publicationLanguage(language), snapshots = readSnapshots(directory);
  const fallback = requestedLanguage === 'vi' && !snapshots.vi && Boolean(snapshots.en);
  return {content: snapshots[requestedLanguage] ?? (fallback ? snapshots.en : null), requestedLanguage, language: fallback ? 'en' : requestedLanguage, fallback};
}
function hash(content) {return createHash('sha256').update(JSON.stringify(content)).digest('hex');}
function publicationExists(path) {
  try {lstatSync(path);return true;} catch(error) {if(error.code==='ENOENT')return false;throw error;}
}
function rollbackJournal(db) {
  // DELETE journaling supports genuinely read-only UID/directory reads. Retry
  // lock acquisition only; never retry an uncertain publication transaction.
  db.exec('PRAGMA busy_timeout=100');
  const deadline=Date.now()+3000,pause=new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const mode=db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
      if(mode!=='delete')throw new Error('Publication requires rollback journaling');
      break;
    } catch(error) {
      if((error.errcode&255)!==5 || Date.now()>=deadline)throw error;
      Atomics.wait(pause,0,0,Math.min(25,deadline-Date.now()));
    }
  }
  db.exec('PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
}
function migrate(db, directory) {
  // Caller owns BEGIN IMMEDIATE. Schema, legacy import, locale column/pointers
  // and marker commit together; no old receipt hash/body/timestamp is rewritten.
  db.exec('CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, hash TEXT NOT NULL, updated TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS current (slot INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);');
  if (!db.prepare("SELECT key FROM metadata WHERE key='imported'").get()) {
    const previous = legacyPublication(directory);
    let previousLegacyHash;
    if (previous) {
      const {author, updatedAt, ...original} = JSON.parse(boundedFile(join(directory, 'marketing.json'), 20000));
      previousLegacyHash = hash(original);
    }
    const receipts = join(directory, 'publications');
    if (existsSync(receipts)) {
      const files = readdirSync(receipts);
      if (files.length > 256) throw new Error('Legacy receipt capacity');
      for (const file of files) {
        if (!/^[a-zA-Z0-9-]{1,64}\.json$/.test(file)) throw new Error('Invalid legacy receipt');
        let receipt;
        try {
          receipt = JSON.parse(boundedFile(join(receipts, file), 1024));
          if (!/^[0-9a-f]{64}$/.test(receipt.hash) || !Number.isFinite(Date.parse(receipt.updatedAt))) throw new Error('Invalid legacy receipt');
        } catch (error) {
          if (file.slice(0, -5) === previous?.id) continue;
          throw error;
        }
        if (file.slice(0, -5) === previous?.id && receipt.hash !== previousLegacyHash) throw new Error('Legacy publication conflicts with receipt');
        db.prepare('INSERT INTO publications(id,hash,updated,legacy) VALUES (?,?,?,1)').run(file.slice(0, -5), receipt.hash, receipt.updatedAt);
      }
    }
    if (previous) {
      const {author, updatedAt, ...body} = previous;
      // Retain a valid old receipt verbatim; repair only an absent/torn current
      // receipt from its committed content, not a historical unknown payload.
      db.prepare('INSERT INTO publications(id,hash,updated,legacy) VALUES (?,?,?,0) ON CONFLICT(id) DO NOTHING').run(body.id, hash(body), updatedAt);
      db.prepare('INSERT INTO current(slot,body) VALUES (1,?)').run(boundedFile(join(directory, 'marketing.json'), 20000));
    }
    db.prepare("INSERT INTO metadata(key) VALUES ('imported')").run();
  }
  if (!db.prepare("SELECT key FROM metadata WHERE key='locales-v1'").get()) {
    if (!db.prepare('PRAGMA table_info(publications)').all().some(column => column.name === 'language')) db.exec("ALTER TABLE publications ADD COLUMN language TEXT NOT NULL DEFAULT 'en' CHECK(language IN ('en','vi'));");
    db.exec("CREATE TABLE current_locales (language TEXT PRIMARY KEY CHECK(language IN ('en','vi')), body TEXT NOT NULL);");
    const previous = db.prepare('SELECT body FROM current WHERE slot=1').get();
    if (previous) {
      const content = record(JSON.parse(previous.body));
      if ((content.language ?? 'en') !== 'en') throw new Error('Invalid legacy pointer');
      db.prepare("INSERT INTO current_locales(language,body) VALUES ('en',?)").run(previous.body);
    }
    db.prepare("INSERT INTO metadata(key) VALUES ('locales-v1')").run();
  }
}
export function preparePublication(directory, beforeCommit) {
  // Stopped startup, runtime UID only; recover old WAL and atomically upgrade
  // publication-owned SQLite/JSON before the DAC read-only Next child starts.
  const path=join(directory,'marketing.sqlite');
  if(!publicationExists(path) && !publicationExists(join(directory,'marketing.json')))return;
  const db=new DatabaseSync(path);
  try {
    rollbackJournal(db); chmodSync(path,0o640); db.exec('BEGIN IMMEDIATE;');
    migrate(db,directory); beforeCommit?.(); db.exec('COMMIT;');
  } catch(error) {try {db.exec('ROLLBACK');} catch {} throw error;}
  finally {db.close();}
}
export function publishPublication(directory, value, beforeCommit) {
  const input = validatePublication(value), language = input.language ?? 'en';
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const db = new DatabaseSync(join(directory, 'marketing.sqlite'));
  try {
    chmodSync(join(directory, 'marketing.sqlite'),0o640);
    rollbackJournal(db);
    db.exec('BEGIN IMMEDIATE;'); migrate(db,directory);
    const previous = db.prepare('SELECT hash,updated,legacy,language FROM publications WHERE id=?').get(input.id);
    if (previous) {
      if (previous.language !== language || previous.hash !== hash(previous.legacy ? value : input)) throw new Error('Publication id conflicts with different content');
      db.exec('COMMIT');
      // An identical historical replay never changes either current pointer.
      return {id: input.id, duplicate: true, updatedAt: previous.updated};
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM publications').get().n >= 256) throw new Error('Publication receipt capacity reached; retain receipts and raise the reviewed limit');
    const updatedAt = new Date().toISOString(), body = JSON.stringify({...input, author: 'website-marketer', updatedAt});
    db.prepare('INSERT INTO publications(id,hash,updated,language) VALUES (?,?,?,?)').run(input.id, hash(input), updatedAt, language);
    db.prepare('INSERT INTO current_locales(language,body) VALUES (?,?) ON CONFLICT(language) DO UPDATE SET body=excluded.body').run(language,body);
    // Retain the legacy English slot; VI never writes it. Do not mix versions
    // of the writer after migration or assume an older image can be restarted.
    if (language === 'en') db.prepare('INSERT INTO current(slot,body) VALUES (1,?) ON CONFLICT(slot) DO UPDATE SET body=excluded.body').run(body);
    beforeCommit?.(); db.exec('COMMIT');
    return {id: input.id, duplicate: false, updatedAt};
  } catch (error) {try {db.exec('ROLLBACK');} catch {} throw error;}
  finally {db.close();}
}
