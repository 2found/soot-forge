// Synthetic publication fixtures only. Never open the VM/native runtime store.
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, chownSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {validatePublication, publishPublication, readPublication, readPublicationSelection, preparePublication} from '../tools/content.mjs';
import {killedBeforeCommit, racePublications} from './publication-processes.mjs';
let directory;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'soot-region-languages-'));});
afterEach(()=>rmSync(directory,{recursive:true,force:true}));
const piece=(id='legacy')=>({id,title:'Fixture English title',intro:'Fixture introduction.',blocks:[{type:'paragraph',text:'Fixture English body.'},{type:'cta',label:'Fixture download',href:'/download'}]});
const vi=(id='vi-one')=>({...piece(id),language:'vi',title:'Tiêu đề thử nghiệm',blocks:[{type:'paragraph',text:'Nội dung tiếng Việt thử nghiệm.'},{type:'cta',label:'Tải bản thử nghiệm',href:'/vi/download'}]});
const stamp='2026-01-01T00:00:00.000Z';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const moduleURL=new URL('../tools/content.mjs',import.meta.url).href;
function seedSQLite() {
  const body={...piece(),author:'website-marketer',updatedAt:stamp};
  const db=new DatabaseSync(join(directory,'marketing.sqlite'));
  db.exec('CREATE TABLE publications (id TEXT PRIMARY KEY, hash TEXT NOT NULL, updated TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0); CREATE TABLE current (slot INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO publications VALUES (?,?,?,0)').run(body.id,digest(piece()),stamp);
  db.prepare('INSERT INTO publications VALUES (?,?,?,0)').run('older',digest(piece('older')),stamp);
  db.prepare('INSERT INTO current VALUES (1,?)').run(JSON.stringify(body));
  db.exec("INSERT INTO metadata VALUES ('imported')"); db.close();
  return body;
}
function inspectDB(fn) {
  const db=new DatabaseSync(join(directory,'marketing.sqlite'),{readOnly:true});
  try{return fn(db);}finally{db.close();}
}
test('default EN canonical bytes and provenance stay unchanged; presence is part of fingerprint',()=>{
  assert.equal(JSON.stringify(validatePublication(piece())),JSON.stringify(piece()));
  assert.notEqual(digest(validatePublication({...piece(),language:'en'})),digest(piece()));
  const first=publishPublication(directory,piece());
  const english=readPublication(directory);
  publishPublication(directory,vi());
  assert.deepEqual(readPublication(directory),english);
  assert.equal(readPublication(directory,'vi').title,vi().title);
  assert.equal(readPublication(directory,'vi').author,'website-marketer');
  assert.equal(publishPublication(directory,piece()).updatedAt,first.updatedAt);
  assert.throws(()=>publishPublication(directory,{...piece(),language:'en'}),/conflicts/);
  assert.throws(()=>publishPublication(directory,{...piece(),language:'vi'}),/conflicts/);
  publishPublication(directory,piece('en-new'));
  assert.equal(readPublication(directory,'vi').id,'vi-one');
  publishPublication(directory,vi('vi-new'));
  assert.equal(publishPublication(directory,vi()).duplicate,true);
  assert.equal(publishPublication(directory,piece()).duplicate,true);
  assert.equal(readPublication(directory).id,'en-new');
  assert.equal(readPublication(directory,'vi').id,'vi-new');
  const explicit={...piece('explicit-en'),language:'en'};
  publishPublication(directory,explicit);
  assert.throws(()=>publishPublication(directory,piece('explicit-en')),/conflicts/);
});
test('strict enum and only exact necessary VI CTA counterparts',()=>{
  for(const language of ['fr','EN','vi-VN','',null,1,undefined]) assert.throws(()=>validatePublication({...piece(),language}));
  for(const href of ['/vi/download','/vi/blog','/vi#how-it-works','/vi#nest','/vi#showcase']) assert.equal(validatePublication({...vi(),blocks:[{type:'cta',label:'fixture',href}]}).blocks[0].href,href);
  for(const href of ['/vi/download/','/vi/#showcase','/vi/../download','/vi/blog/article','/vi/download?next=x','//trysoot.com/vi/blog','https://trysoot.com/vi/blog','/%76i/blog','/vi%23nest']) assert.throws(()=>validatePublication({...vi(),blocks:[{type:'cta',label:'fixture',href}]}));
  assert.throws(()=>readPublication(directory,'fr'),/language/);
});
test('exact inspect has no VI fallback; public selection labels actual English without inventing provenance',()=>{
  assert.equal(readPublication(directory,'vi'),null);
  publishPublication(directory,piece());
  assert.equal(readPublication(directory,'vi'),null);
  assert.deepEqual(readPublicationSelection(directory,'vi'),{content:readPublication(directory),requestedLanguage:'vi',language:'en',fallback:true});
  publishPublication(directory,vi());
  assert.equal(readPublicationSelection(directory,'vi').fallback,false);
  assert.equal(readPublicationSelection(directory,'vi').language,'vi');
});
test('old SQLite upgrade keeps EN body and every receipt hash/timestamp; VI never steals old slot',()=>{
  const body=seedSQLite(), publishedHash=digest(body);
  const before=inspectDB(db=>db.prepare('SELECT * FROM publications ORDER BY id').all());
  preparePublication(directory);
  assert.equal(digest(readPublication(directory)),publishedHash);
  assert.equal(inspectDB(db=>db.prepare('SELECT body FROM current_locales WHERE language=?').get('en').body),JSON.stringify(body));
  const after=inspectDB(db=>db.prepare('SELECT id,hash,updated,legacy FROM publications ORDER BY id').all());
  assert.deepEqual(after,before);
  publishPublication(directory,vi());
  assert.equal(readPublication(directory).updatedAt,stamp);
  assert.equal(inspectDB(db=>db.prepare('SELECT body FROM current WHERE slot=1').get().body),JSON.stringify(body));
  assert.equal(publishPublication(directory,piece('older')).duplicate,true);
  assert.equal(readPublication(directory).id,'legacy');
  assert.equal(readPublication(directory,'vi').id,'vi-one');
  assert.throws(()=>publishPublication(directory,{...piece('older'),language:'en'}),/conflicts/);
});
test('JSON upgrade is atomic and preserves original file and old receipts, including raw fingerprint order',()=>{
  const original={...piece(),author:'website-marketer',updatedAt:stamp};
  const raw=JSON.stringify(original);
  writeFileSync(join(directory,'marketing.json'),raw); mkdirSync(join(directory,'publications'));
  const old={blocks:piece('older').blocks,intro:piece('older').intro,title:piece('older').title,id:'older'};
  const receipt=JSON.stringify({hash:digest(old),updatedAt:stamp});
  writeFileSync(join(directory,'publications','older.json'),receipt);
  assert.throws(()=>preparePublication(directory,()=>{throw new Error('fixture interruption');}),/interruption/);
  assert.deepEqual(readPublication(directory),original); assert.equal(readPublication(directory,'vi'),null);
  preparePublication(directory); publishPublication(directory,vi());
  assert.equal(digest(readPublication(directory)),digest(original));
  assert.equal(readFileSync(join(directory,'marketing.json'),'utf8'),raw);
  assert.equal(readFileSync(join(directory,'publications','older.json'),'utf8'),receipt);
  assert.equal(publishPublication(directory,old).duplicate,true);
  assert.throws(()=>publishPublication(directory,piece('older')),/conflicts/);
  assert.equal(readPublication(directory).id,'legacy');
});
test('killed SQLite migration rolls back marker/pointers; restart prepares without republishing',async()=>{
  const body=seedSQLite();
  await killedBeforeCommit(moduleURL,directory);
  preparePublication(directory);
  assert.deepEqual(readPublication(directory),body); assert.equal(readPublication(directory,'vi'),null);
  assert.equal(publishPublication(directory,piece()).duplicate,true);
  assert.equal(readPublication(directory).updatedAt,stamp);
});
test('killed VI transaction retains both previous snapshots and no receipt; explicit fixture reconciliation only',async()=>{
  publishPublication(directory,piece()); publishPublication(directory,vi());
  const en=readPublication(directory), previousVI=readPublication(directory,'vi');
  await killedBeforeCommit(moduleURL,directory,vi('interrupted'));
  preparePublication(directory);
  assert.deepEqual(readPublication(directory),en); assert.deepEqual(readPublication(directory,'vi'),previousVI);
  assert.equal(inspectDB(db=>db.prepare('SELECT id FROM publications WHERE id=?').get('interrupted')),undefined);
});
test('cold concurrent EN/VI writers atomically import JSON once and keep separate pointers',async()=>{
  writeFileSync(join(directory,'marketing.json'),JSON.stringify({...piece(),author:'website-marketer',updatedAt:stamp}));
  const results=await racePublications(moduleURL,directory,[piece('new-en'),vi('new-vi'),piece('new-en'),vi('new-vi')]);
  assert.equal(results.filter(r=>r.duplicate).length,2);
  assert.equal(readPublication(directory).id,'new-en'); assert.equal(readPublication(directory,'vi').id,'new-vi');
  assert.equal(publishPublication(directory,piece()).duplicate,true);
  assert.equal(readPublication(directory).id,'new-en');
});
test('inspect tool validates exact locale and no extra fields; old empty input remains EN',()=>{
  publishPublication(directory,piece());
  const script=new URL('../tools/publish.mjs',import.meta.url).pathname;
  const run=input=>spawnSync(process.execPath,[script,'inspect'],{input:JSON.stringify({api_version:'soot/v1',hook:'tool.call',soot:'website-marketer',operation:'website_inspect',input}),env:{WEBSITE_DATA:directory},encoding:'utf8',timeout:5000});
  assert.equal(JSON.parse(run({}).stdout).content.id,'legacy');
  assert.equal(JSON.parse(run({language:'vi'}).stdout).content,null);
  for(const input of [{language:'fr'},{language:null},{language:'vi',extra:true},[]]) assert.equal(run(input).status,1);
});
test('Linux actual UID1001 DAC read after stopped migration creates no sidecars and cannot write', {skip:process.platform!=='linux'||process.getuid?.()!==0},()=>{
  seedSQLite(); preparePublication(directory); publishPublication(directory,vi()); preparePublication(directory);
  chownSync(directory,1000,1001); chmodSync(directory,0o750);
  const path=join(directory,'marketing.sqlite'); chownSync(path,1000,1001); chmodSync(path,0o640);
  const before=readdirSync(directory).sort();
  const code=`import assert from 'node:assert/strict'; import {writeFileSync} from 'node:fs'; import {readPublication} from ${JSON.stringify(moduleURL)}; assert.equal(readPublication(${JSON.stringify(directory)}).id,'legacy'); assert.equal(readPublication(${JSON.stringify(directory)},'vi').id,'vi-one'); assert.throws(()=>writeFileSync(${JSON.stringify(path)},'denied'),{code:'EACCES'}); assert.throws(()=>writeFileSync(${JSON.stringify(join(directory,'denied'))},'denied'),{code:'EACCES'});`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{uid:1001,gid:1001,encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr); assert.deepEqual(readdirSync(directory).sort(),before);
});
