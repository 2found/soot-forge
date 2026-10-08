import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, mkdirSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readPublication, publishPublication, validatePublication} from '../tools/content.mjs';
let directory;
beforeEach(()=>{directory=mkdtempSync(join(tmpdir(),'soot-publication-test-'));});
afterEach(()=>rmSync(directory,{recursive:true,force:true}));
const piece=(id='one')=>({id,title:'A small story',intro:'Chosen by a Soot.',blocks:[{type:'paragraph',text:'Plain text, not HTML.'},{type:'cta',href:'/download',label:'Get Soot'}]});
test('honest empty state, canonical duplicate and no rollback to older content',()=>{
  assert.equal(readPublication(directory),null);
  const first=publishPublication(directory,piece());
  publishPublication(directory,piece('two'));
  const reordered={blocks:piece().blocks,intro:piece().intro,title:piece().title,id:'one'};
  const duplicate=publishPublication(directory,reordered);
  assert.equal(duplicate.duplicate,true); assert.equal(duplicate.updatedAt,first.updatedAt);
  assert.equal(readPublication(directory).id,'two');
  assert.throws(()=>publishPublication(directory,{...piece(),title:'Conflict'}),/conflicts/);
  assert.equal(readPublication(directory).author,'website-marketer');
});
test('strict typed text blocks and CTA destinations, no coerced ids or raw execution',()=>{
  for (const bad of [{...piece(),id:42},{...piece(),id:undefined},{...piece(),blocks:[null]},{...piece(),blocks:[{type:'html',html:'<script>'}]},{...piece(),blocks:[{type:'cta',label:'bad',href:'javascript:alert(1)'}]},{...piece(),blocks:[{type:'paragraph'}]},{...piece(),extra:'bad'}]) assert.throws(()=>validatePublication(bad));
  assert.equal(validatePublication({...piece(),title:'<script>alert(1)</script>'}).title,'<script>alert(1)</script>'); // React renders this as text.
});
test('rollback keeps content and receipt together; retry may publish after a failed transaction',()=>{
  publishPublication(directory,piece());
  assert.throws(()=>publishPublication(directory,piece('two'),()=>{throw new Error('crash before commit');}),/crash/);
  assert.equal(readPublication(directory).id,'one');
  assert.equal(publishPublication(directory,piece('two')).duplicate,false);
});
test('process death before commit releases lock and SQLite recovers without uncertain replay',async()=>{
  publishPublication(directory,piece());
  const module=new URL('../tools/content.mjs',import.meta.url).href;
  const code=`import {publishPublication} from ${JSON.stringify(module)}; publishPublication(${JSON.stringify(directory)}, ${JSON.stringify(piece('crash'))}, ()=>{console.log('staged'); process.kill(process.pid,'SIGKILL');});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{assert.equal(signal,'SIGKILL');resolve();});});
  assert.equal(readPublication(directory).id,'one');
  assert.equal(publishPublication(directory,piece('crash')).duplicate,false);
});
test('fresh first-open writers serialize schema, rollback journal and the same receipt',async()=>{
  const module=new URL('../tools/content.mjs',import.meta.url).href;
  for(let round=0;round<5;round++) {
    const fresh=join(directory,'fresh-'+round);
    // IPC barrier releases six cold processes together. No schema prewarming.
    const code=`import {publishPublication} from ${JSON.stringify(module)}; process.send('ready'); process.once('message',()=>{console.log(JSON.stringify(publishPublication(${JSON.stringify(fresh)},${JSON.stringify(piece())}))); process.disconnect();});`;
    const children=Array.from({length:6},()=>spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe','ipc']}));
    const results=children.map(child=>new Promise((resolve,reject)=>{
      let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);
      child.once('error',reject);child.once('exit',c=>c===0?resolve(JSON.parse(out)):reject(new Error(err)));
    }));
    await Promise.all(children.map(child=>new Promise(resolve=>child.once('message',resolve))));
    children.forEach(child=>child.send('go'));
    const values=await Promise.all(results);
    assert.equal(values.filter(v=>v.duplicate).length,5);
    assert.equal(new Set(values.map(v=>v.updatedAt)).size,1);
    assert.equal(readPublication(fresh).id,'one');
  }
});
test('killed first writer rolls back schema and leaves legacy readable',async()=>{
  const legacy={...piece(),author:'website-marketer',updatedAt:'2026-01-01T00:00:00.000Z'};
  writeFileSync(join(directory,'marketing.json'),JSON.stringify(legacy));
  const module=new URL('../tools/content.mjs',import.meta.url).href;
  const code=`import {publishPublication} from ${JSON.stringify(module)}; publishPublication(${JSON.stringify(directory)},${JSON.stringify(piece('new'))},()=>process.kill(process.pid,'SIGKILL'));`;
  const child=spawn(process.execPath,['--input-type=module','-e',code]);
  await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{assert.equal(signal,'SIGKILL');resolve();});});
  assert.equal(readPublication(directory).id,'one');
  assert.equal(publishPublication(directory,piece('new')).duplicate,false);
});
test('migrate legacy receipts and repair published-without-receipt crash, without deleting old files',()=>{
  const legacy={...piece(),author:'website-marketer',updatedAt:'2026-01-01T00:00:00.000Z'};
  writeFileSync(join(directory,'marketing.json'),JSON.stringify(legacy));
  mkdirSync(join(directory,'publications'));
  const old=piece('old');writeFileSync(join(directory,'publications','old.json'),JSON.stringify({hash:createHash('sha256').update(JSON.stringify(old)).digest('hex'),updatedAt:legacy.updatedAt}));
  assert.equal(publishPublication(directory,piece()).duplicate,true);
  publishPublication(directory,piece('new'));
  assert.equal(publishPublication(directory,old).duplicate,true);
  assert.equal(readPublication(directory).id,'new');
});
test('tool envelope denies keeper/visitor/wrong operation, bounded stdin and inspect shape',()=>{
  const script=new URL('../tools/publish.mjs',import.meta.url).pathname;
  const envelope={api_version:'soot/v1',hook:'tool.call',soot:'website-marketer',operation:'website_publish',input:piece()};
  const run=(call,action='publish')=>spawnSync(process.execPath,[script,action],{input:typeof call==='string'?call:JSON.stringify(call),env:{WEBSITE_DATA:directory},encoding:'utf8'});
  for (const bad of [{...envelope,soot:'website-keeper'},{...envelope,soot:'visitor'},{...envelope,operation:'website_inspect'},{...envelope,hook:'public.task'}]) assert.equal(run(bad).status,1);
  assert.equal(run(' '.repeat(65537)).status,1);
  assert.equal(run(envelope).status,0);
  const inspect={...envelope,operation:'website_inspect',input:{}};
  assert.equal(run({...inspect,input:[]},'inspect').status,1);
  assert.equal(JSON.parse(run(inspect,'inspect').stdout).content.id,'one');
});
test('malformed provenance and oversized legacy files fail closed',()=>{
  writeFileSync(join(directory,'marketing.json'),' '.repeat(20001));assert.throws(()=>readPublication(directory),/limit/);
  writeFileSync(join(directory,'marketing.json'),JSON.stringify({...piece(),author:'visitor',updatedAt:new Date().toISOString()}));assert.throws(()=>readPublication(directory),/provenance/);
});

test('torn current receipt repairs from committed content; unknown older torn receipts fail closed',()=>{
  const legacy={...piece(),author:'website-marketer',updatedAt:'2026-01-01T00:00:00.000Z'};
  writeFileSync(join(directory,'marketing.json'),JSON.stringify(legacy));mkdirSync(join(directory,'publications'));
  writeFileSync(join(directory,'publications','one.json'),'{"hash":');
  assert.equal(publishPublication(directory,piece()).duplicate,true);
  assert.equal(readPublication(directory).id,'one');
  const other=mkdtempSync(join(tmpdir(),'soot-old-receipt-test-'));
  try {
    writeFileSync(join(other,'marketing.json'),JSON.stringify(legacy));mkdirSync(join(other,'publications'));
    writeFileSync(join(other,'publications','unknown-old.json'),'{"hash":');
    assert.throws(()=>publishPublication(other,piece('new')));
    assert.equal(readPublication(other).id,'one'); // failed migration cannot hide legacy publication
  }finally{rmSync(other,{recursive:true,force:true});}
});
test('receipt capacity fails closed, while old duplicates remain reconciliable',()=>{
  for(let i=0;i<256;i++)publishPublication(directory,piece('piece-'+i));
  assert.throws(()=>publishPublication(directory,piece('extra')),/capacity/);
  assert.equal(publishPublication(directory,piece('piece-0')).duplicate,true);
  assert.equal(readPublication(directory).id,'piece-255');
});
