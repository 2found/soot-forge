import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identity,command} from './browser.mjs';
const call={api_version:'soot/v1',hook:'tool.call',event:{source:'conversation',subject:'conversation-1'}};
test('host conversation selects stable isolated profile and daemon',()=>{
 const a=identity(call,'/nest/packs.d/browser-use');
 assert.deepEqual(a,identity({...call,input:{session:'evil',profile:'/tmp/evil'}},'/nest/packs.d/browser-use'));
 assert.notEqual(a.session,identity({...call,event:{...call.event,subject:'conversation-2'}},'/nest/packs.d/browser-use').session);
 assert.notEqual(a.session,identity(call,'/another/packs.d/browser-use').session);
 assert.ok(a.profile.endsWith('/profiles/conversation-1'));
});
test('non-conversation and path traversal contexts fail closed',()=>{
 for(const c of [{...call,event:{source:'event',subject:'conversation-1'}},{...call,event:{source:'conversation',subject:'../elsewhere'}},{...call,api_version:'soot/v2'}])assert.throws(()=>identity(c));
});
test('refs are arguments and launch/session flags cannot be overridden',()=>{
 assert.deepEqual(command({action:'command',args:['click','@e2']}),['click','@e2']);
 assert.deepEqual(command({action:'command',args:['snapshot','-i']}),['snapshot','-i']);
 for(const args of [['@e2'],['connect','9222'],['open','--session=default'],['open','--profile','/tmp/shared'],['open','--executable-path','evil'],['close','--all'],['session','list']])assert.throws(()=>command({action:'command',args}));
});

import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('view after explicit close never starts a browser even if daemon listing is stale',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-closed-'));
 try {
  const state=join(dir,'.browser','sessions',call.event.subject);mkdirSync(state,{recursive:true});writeFileSync(join(state,'closed'),'closed');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./browser.mjs',import.meta.url)),'view'],{cwd:dir,input:JSON.stringify({...call,input:{}}),env:{PATH:'/nonexistent'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{session:call.event.subject,tabs:[],closed:true,resource:{state:'closed'}});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('missing stream is unavailable and a view never waits on an agent command lock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-probe-'));
 try {
  const state=join(dir,'.browser','sessions',call.event.subject);mkdirSync(state,{recursive:true});writeFileSync(join(state,'lock'),String(process.pid));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./browser.mjs',import.meta.url)),'view'],{cwd:dir,input:JSON.stringify({...call,input:{}}),env:{PATH:'/nonexistent'},encoding:'utf8',timeout:2500});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).resource.state,'unavailable');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
