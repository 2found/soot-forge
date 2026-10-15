import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,chmod,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchSettings,boundedJSON,lock} from './launch.mjs';
import {agentInvocation,agent,useBundledAgent} from './agent.mjs';

test('launch cache avoids repeated resolution and refreshes stale, oversized or missing executable state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-launch-'));let resolutions=0;
 const binary=join(dir,'chromium'),cache=join(dir,'launch.json');
 const resolve=async()=>{resolutions++;await writeFile(binary,'fixture',{mode:0o700});return {binary,args:['--fixture']};};
 try {
  await launchSettings(dir,resolve);await launchSettings(dir,resolve);assert.equal(resolutions,1);
  const saved=JSON.parse(await readFile(cache));assert.deepEqual(saved.args,['--fixture']);
  await writeFile(cache,JSON.stringify({...saved,key:'outdated'}));await launchSettings(dir,resolve);assert.equal(resolutions,2);
  await rm(binary);await launchSettings(dir,resolve);assert.equal(resolutions,3);
  await writeFile(cache,' '.repeat(32769));await assert.rejects(boundedJSON(cache),/too large/);
  await launchSettings(dir,resolve);assert.equal(resolutions,4);
  await rm(binary);await mkdir(binary);await assert.rejects(launchSettings(dir,async()=>({binary,args:[]})),/not a file/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('host CloakBrowser overrides bypass the launch cache',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-override-'));const key='CLOAKBROWSER_TEST_CACHE';const previous=process.env[key];let calls=0;
 try {
  process.env[key]='fixture';const binary=join(dir,'chromium');await writeFile(binary,'fixture',{mode:0o700});
  const resolve=async()=>{calls++;return {binary,args:[]};};
  await launchSettings(dir,resolve);await launchSettings(dir,resolve);assert.equal(calls,2);
  await assert.rejects(readFile(join(dir,'launch.json')), {code:'ENOENT'});
 }finally{if(previous===undefined)delete process.env[key];else process.env[key]=previous;await rm(dir,{recursive:true,force:true});}
});
test('pinned executable selection preserves argv and falls back to its own wrapper',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'browser-bin-'));const args=['fill','@e1','literal $() text'];
 try {
  const native=join(directory,'agent-browser-darwin-arm64');await writeFile(native,'fixture',{mode:0o700});
  assert.deepEqual(agentInvocation(args,{directory,platform:'darwin',arch:'arm64',musl:false}),{program:native,args});
  await chmod(native,0o600);
  assert.deepEqual(agentInvocation(args,{directory,platform:'darwin',arch:'arm64',musl:false}),{program:process.execPath,args:[join(directory,'agent-browser.js'),...args]});
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('one first-use download at a time, and a dead holder never blocks it',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-install-'));
 try {
  const release=await lock(dir);
  await assert.rejects(lock(dir,{attempts:2,busy:'still downloading'}),/still downloading/);
  await release();
  await (await lock(dir,{attempts:2}))();
  await writeFile(join(dir,'lock'),'999999999');
  await (await lock(dir,{attempts:3}))();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('the single-file build runs the agent-browser shipped beside it',{skip:process.platform==='win32'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'browser-bundled-'));
 try {
  const program=join(dir,'agent-browser');await writeFile(program,'#!/bin/sh\nprintf "%s|" "$@"\n',{mode:0o700});
  useBundledAgent(program);
  assert.equal((await agent(['open','literal $() text'])).stdout,'open|literal $() text|');
 }finally{useBundledAgent(undefined);await rm(dir,{recursive:true,force:true});}
});
