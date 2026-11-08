import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identity,command,validateInput} from './browser.mjs';
const call={api_version:'soot/v1',hook:'tool.call',soot:'fixture',operation:'browser-use_view',event:{source:'conversation',subject:'conversation-1'}};
test('host conversation selects stable isolated profile and daemon',()=>{
 const a=identity(call,'/nest/packs.d/browser-use');
 assert.deepEqual(a,identity({...call,input:{session:'evil',profile:'/tmp/evil'}},'/nest/packs.d/browser-use'));
 assert.notEqual(a.session,identity({...call,event:{...call.event,subject:'conversation-2'}},'/nest/packs.d/browser-use').session);
 assert.notEqual(a.session,identity(call,'/another/packs.d/browser-use').session);
 assert.ok(a.profile.endsWith('/profiles/conversation-1'));
});
test('all browser action inputs are validated before launching or changing a session',()=>{
 for(const input of [{action:'unknown'},{action:'resize',width:0,height:240},{action:'click',x:'1',y:1},{action:'key'},{action:'tab_select',tab:'../other'},{action:'scroll',direction:'up',x:-1},{action:'navigate',url:'file:///private/file'},{action:'command',args:['open','javascript:alert(1)']},{action:'command',args:['tab','new','file:///private/file']}])assert.throws(()=>validateInput(input));
 assert.deepEqual(validateInput({action:'navigate',url:'https://example.com'}),{action:'navigate',url:'https://example.com'});
 assert.deepEqual(command({action:'command',args:['tab','new']}),['tab','new']);
});

test('invalid control action does not create state or require browser dependencies',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-invalid-'));
 try {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'control'],{cwd:dir,input:JSON.stringify({...call,operation:'browser-use_control',input:{action:'click',x:-1,y:0}}),env:{PATH:'/nonexistent'},encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/Invalid x/);assert.equal(result.stdout,'');
  assert.equal(existsSync(join(dir,'.browser')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('non-conversation and path traversal contexts fail closed',()=>{
 for(const c of [{...call,event:{source:'event',subject:'conversation-1'}},{...call,event:{source:'conversation',subject:'../elsewhere'}},{...call,api_version:'soot/v2'}])assert.throws(()=>identity(c));
});
test('refs are arguments and launch/session flags cannot be overridden',()=>{
 assert.deepEqual(command({action:'command',args:['click','@e2']}),['click','@e2']);
 assert.deepEqual(command({action:'command',args:['snapshot','-i']}),['snapshot','-i']);
 for(const args of [['@e2'],['connect','9222'],['open','--session=default'],['open','--profile','/tmp/shared'],['open','--executable-path','evil'],['close','--all'],['session','list']])assert.throws(()=>command({action:'command',args}));
});

import {mkdtempSync,mkdirSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('view after explicit close never starts a browser even if daemon listing is stale',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-closed-'));
 try {
  const state=join(dir,'.browser','sessions',call.event.subject);mkdirSync(state,{recursive:true});writeFileSync(join(state,'closed'),'closed');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'view'],{cwd:dir,input:JSON.stringify({...call,input:{}}),env:{PATH:'/nonexistent'},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{session:call.event.subject,tabs:[],closed:true,resource:{state:'closed'}});
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('missing stream is unavailable and a view never waits on an agent command lock',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-probe-'));
 try {
  const state=join(dir,'.browser','sessions',call.event.subject);mkdirSync(state,{recursive:true});writeFileSync(join(state,'lock'),String(process.pid));
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'view'],{cwd:dir,input:JSON.stringify({...call,input:{}}),env:{PATH:'/nonexistent'},encoding:'utf8',timeout:2500});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).resource.state,'unavailable');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('state lives in the host-kept Pack state directory, not the working directory',()=>{
 const state=mkdtempSync(join(tmpdir(),'soot-browser-state-')), cwd=mkdtempSync(join(tmpdir(),'soot-browser-revision-'));
 try {
  const session=join(state,'.browser','sessions',call.event.subject);mkdirSync(session,{recursive:true});writeFileSync(join(session,'closed'),'closed');
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'view'],{cwd,input:JSON.stringify({...call,input:{}}),env:{PATH:'/nonexistent',SOOT_PACK_STATE:state},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).resource.state,'closed');
  assert.equal(existsSync(join(cwd,'.browser')),false);
 }finally{rmSync(state,{recursive:true,force:true});rmSync(cwd,{recursive:true,force:true});}
});

import {persistentSoots} from './browser.mjs';
import {lock} from './launch.mjs';
test('a host-listed Soot keeps one profile across its conversations; other Soots stay per conversation (AC-T6-1)',()=>{
 const root='/nest/packs.d/browser-use', listed=persistentSoots('lohi-editor, ,../x,other_soot');
 assert.deepEqual([...listed],['lohi-editor','other_soot']);
 const pub=c=>identity({...call,soot:'lohi-editor',event:{...call.event,subject:c}},root,listed);
 const a=pub('conversation-1'),b=pub('conversation-2');
 assert.deepEqual(a,b);assert.equal(a.persistent,true);
 assert.ok(a.profile.endsWith('/soot-profiles/lohi-editor'));assert.ok(a.state.endsWith('/soot-sessions/lohi-editor'));
 // Model input never selects it, and another Soot never reaches it.
 assert.deepEqual(identity({...call,soot:'lohi-editor',input:{profile:'/tmp/x',session:'sootp-x'}},root,listed),a);
 const other=identity({...call,soot:'helper'},root,listed);
 assert.equal(other.persistent,false);assert.ok(other.profile.endsWith('/profiles/conversation-1'));
 assert.notEqual(other.session,a.session);
 assert.notEqual(identity({...call,soot:'helper',event:{...call.event,subject:'conversation-2'}},root,listed).profile,other.profile);
 // A conversation id spelled like the Soot's never reaches its profile or daemon.
 const spoof=identity({...call,soot:'helper',event:{...call.event,subject:'soot-lohi-editor'}},root,listed);
 assert.notEqual(spoof.profile,a.profile);assert.notEqual(spoof.session,a.session);assert.notEqual(spoof.state,a.state);
 // Unset or empty env: nothing is persistent.
 assert.equal(identity({...call,soot:'lohi-editor'},root,persistentSoots(undefined)).persistent,false);
 assert.equal(identity({...call,soot:'lohi-editor'},root,persistentSoots('')).persistent,false);
});
test('two conversations of a persistent Soot share one command lock on its profile',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-shared-'));
 try {
  const listed=persistentSoots('lohi-editor');
  const a=identity({...call,soot:'lohi-editor'},dir,listed),b=identity({...call,soot:'lohi-editor',event:{...call.event,subject:'conversation-2'}},dir,listed);
  const release=await lock(a.state);
  await assert.rejects(lock(b.state,{attempts:2,busy:'busy'}),/busy/);
  // A non-persistent Soot's conversation is not held up by it.
  await (await lock(identity({...call,soot:'helper'},dir,listed).state,{attempts:2}))();
  await release();
  await (await lock(b.state,{attempts:2}))();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('view maps a persistent Soot to its kept session from any conversation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-pview-'));
 try {
  const state=join(dir,'.browser','soot-sessions','lohi-editor');mkdirSync(state,{recursive:true});writeFileSync(join(state,'closed'),'closed');
  const env={PATH:'/nonexistent',SOOT_PACK_STATE:dir,SOOT_BROWSER_PERSISTENT_SOOTS:'lohi-editor'};
  const view=(soot,subject)=>JSON.parse(spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'view'],{input:JSON.stringify({...call,soot,event:{...call.event,subject},input:{}}),env,encoding:'utf8'}).stdout);
  assert.equal(view('lohi-editor','conversation-7').resource.state,'closed');
  assert.equal(view('lohi-editor','conversation-7').session,'soot-lohi-editor');
  assert.equal(view('helper','conversation-7').resource.state,'unavailable');
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import {uploadSpec,uploadFile} from './browser.mjs';
import {symlinkSync} from 'node:fs';
import {createHash as sha} from 'node:crypto';
test('upload takes only a clean workspace media path, checked against the real disk',async()=>{
  const root=mkdtempSync(join(tmpdir(),'soot-upload-'));
  try {
    mkdirSync(join(root,'mv','08-delivery'),{recursive:true});
    writeFileSync(join(root,'mv','08-delivery','v.mp4'),'video-bytes');
    writeFileSync(join(root,'secret.txt'),'x');
    const ok={action:'upload',selector:'@e3',path:'mv/08-delivery/v.mp4'};
    assert.equal(validateInput(ok),ok);
    for (const path of ['/etc/passwd','../x.mp4','mv/../v.mp4','.hidden/v.mp4','mv/.v.mp4','secret.txt','mv//v.mp4','mv\\v.mp4'])
      assert.throws(()=>uploadSpec({...ok,path}),undefined,path);
    assert.throws(()=>uploadSpec({...ok,selector:'--profile'}));
    assert.throws(()=>uploadSpec({...ok,sha256:'nothex'}));
    const up=await uploadFile(ok,root);
    assert.equal(up.selector,'@e3'); assert.equal(up.bytes,11); assert.ok(up.file.endsWith('/mv/08-delivery/v.mp4'));
    const digest=sha('sha256').update('video-bytes').digest('hex');
    assert.equal((await uploadFile({...ok,sha256:'sha256:'+digest},root)).bytes,11);
    await assert.rejects(uploadFile({...ok,sha256:'0'.repeat(64)},root),/sha256 does not match/);
    await assert.rejects(uploadFile({...ok,path:'mv/none.mp4'},root),/not found/);
    await assert.rejects(uploadFile(ok,undefined),/FILE_ROOT/);
    symlinkSync('/etc/hosts',join(root,'mv','link.png'));
    await assert.rejects(uploadFile({...ok,path:'mv/link.png'},root),/symlink/);
    symlinkSync(join(root,'mv'),join(root,'alias'));
    await assert.rejects(uploadFile({...ok,path:'alias/08-delivery/v.mp4'},root),/symlink/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
