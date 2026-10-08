// Bounded IPC races over synthetic old-schema SQLite, never live state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {readPublication} from '../tools/content.mjs';
const moduleURL=new URL('../tools/content.mjs',import.meta.url).href;
const piece=(id,language)=>({id,title:'Synthetic race fixture',intro:'No real publication.',blocks:[{type:'paragraph',text:'Fixture only.'}],...(language?{language}:{})});
function seed(directory) {
  const input=piece('legacy'),updatedAt='2026-01-01T00:00:00.000Z',body={...input,author:'website-marketer',updatedAt};
  const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const db=new DatabaseSync(join(directory,'marketing.sqlite'));
  db.exec('CREATE TABLE publications (id TEXT PRIMARY KEY, hash TEXT NOT NULL, updated TEXT NOT NULL, legacy INTEGER NOT NULL DEFAULT 0); CREATE TABLE current (slot INTEGER PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE metadata (key TEXT PRIMARY KEY);');
  db.prepare('INSERT INTO publications VALUES (?,?,?,0)').run(input.id,hash,updatedAt); db.prepare('INSERT INTO current VALUES (1,?)').run(JSON.stringify(body)); db.exec("INSERT INTO metadata VALUES ('imported')"); db.close();
  return {body,hash,updatedAt};
}
async function race(directory,values) {
  const children=values.map(value=>spawn(process.execPath,['--input-type=module','-e',`import {publishPublication} from ${JSON.stringify(moduleURL)}; process.send('ready'); process.once('message',()=>{try{console.log(JSON.stringify({receipt:publishPublication(${JSON.stringify(directory)},${JSON.stringify(value)})}));}catch(e){console.log(JSON.stringify({conflict:/conflicts/.test(e.message),error:e.message}));}process.disconnect();});`],{stdio:['ignore','pipe','pipe','ipc']}));
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture race exceeded 10 seconds')),10000);});
  const completed=Promise.all(children.map(child=>new Promise((resolve,reject)=>{
    let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
    child.once('error',reject);child.once('exit',code=>{try{if(code!==0)throw new Error(err);resolve(JSON.parse(out));}catch(e){reject(e);}});
  })));
  completed.catch(()=>{});
  try {
    const ready=Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('Fixture child exited before IPC release')));})));
    await Promise.race([ready,deadline]); children.forEach(child=>child.send('go'));
    return await Promise.race([completed,deadline]);
  } finally {clearTimeout(timer);children.forEach(child=>child.kill('SIGKILL'));}
}
test('old SQLite cold migration races EN and VI, preserving old receipt and never mixing pointers',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'soot-old-schema-race-'));
  try {
    const old=seed(directory);
    const results=await race(directory,[piece('new-en'),piece('new-vi','vi'),piece('new-en'),piece('new-vi','vi')]);
    assert.ok(results.every(r=>r.receipt)); assert.equal(results.filter(r=>r.receipt.duplicate).length,2);
    assert.equal(readPublication(directory).id,'new-en');assert.equal(readPublication(directory,'vi').id,'new-vi');
    const db=new DatabaseSync(join(directory,'marketing.sqlite'),{readOnly:true});
    try {const receipt=db.prepare('SELECT hash,updated FROM publications WHERE id=?').get('legacy');assert.equal(receipt.hash,old.hash);assert.equal(receipt.updated,old.updatedAt);}finally{db.close();}
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('same global ID racing across locales commits only one fingerprint, never two current snapshots',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'soot-global-id-race-'));
  try {
    const old=seed(directory);
    const results=await race(directory,[piece('shared','en'),piece('shared','vi')]);
    assert.equal(results.filter(r=>r.receipt).length,1);assert.equal(results.filter(r=>r.conflict).length,1);
    const en=readPublication(directory),vi=readPublication(directory,'vi');
    assert.notEqual(en?.id==='shared',vi?.id==='shared');
    if(vi?.id==='shared')assert.deepEqual(en,old.body);else assert.equal(vi,null);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
