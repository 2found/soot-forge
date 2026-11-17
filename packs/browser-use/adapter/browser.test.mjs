import {test} from 'node:test';
import assert from 'node:assert/strict';
import {identity,command,validateInput,commandSteps,compact,MAX_STEPS,MAX_SHOTS,localReopen,clearCache} from './browser.mjs';
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

test('steps run several checked commands in one call',()=>{
 assert.deepEqual(commandSteps({action:'command',steps:[['fill','@e2','Lan'],['click','@e9']]}),[['fill','@e2','Lan'],['click','@e9']]);
 assert.deepEqual(commandSteps({action:'command',args:['snapshot','-i']}),[['snapshot','-i']]);
 // Every step passes the same check as args: one bad step refuses the whole call before anything runs.
 for(const steps of [[],[['fill','@e2','x'],['open','file:///etc/passwd']],[['click','@e1','--executable-path']],[['session','list']],Array(MAX_STEPS+1).fill(['snapshot']),'snapshot',[['snapshot'],'click']])
  assert.throws(()=>validateInput({action:'command',steps}));
 assert.throws(()=>validateInput({action:'command',args:['snapshot'],steps:[['snapshot']]}),/args or steps/);
});

test('results drop the daemon launch bookkeeping',()=>{
 assert.deepEqual(compact({clicked:'@e6',lifecycle:{launched:false,reused:true}}),{clicked:'@e6'});
 assert.deepEqual(compact({enabled:true,port:9}),{enabled:true,port:9});
 assert.equal(compact('text'),'text');assert.equal(compact(null),null);
});

test('engine is chromium or cloak',()=>{
 assert.deepEqual(validateInput({action:'navigate',url:'https://example.com',engine:'cloak'}).engine,'cloak');
 assert.throws(()=>validateInput({action:'navigate',url:'https://example.com',engine:'firefox'}),/Invalid engine/);
});

test('a click without coordinates names the element-level command',()=>{
 assert.throws(()=>validateInput({action:'click',text:'Travel'}),/Invalid x: .*\["find","text","Sign in","click"\]/);
 assert.throws(()=>validateInput({action:'click',x:-1,y:0}),/^Error: Invalid x$/);
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
    const digest=sha('sha256').update('video-bytes').digest('hex');
    const ok={action:'upload',selector:'@e3',path:'mv/08-delivery/v.mp4',sha256:'sha256:'+digest};
    assert.equal(validateInput(ok),ok);
    const {sha256:_, ...nohash}=ok;
    assert.throws(()=>uploadSpec(nohash),/sha256/,'the claim hash is required');
    for (const path of ['/etc/passwd','../x.mp4','mv/../v.mp4','.hidden/v.mp4','mv/.v.mp4','secret.txt','mv//v.mp4','mv\\v.mp4'])
      assert.throws(()=>uploadSpec({...ok,path}),undefined,path);
    assert.throws(()=>uploadSpec({...ok,selector:'--profile'}));
    assert.throws(()=>uploadSpec({...ok,sha256:'nothex'}));
    const up=await uploadFile(ok,root);
    assert.equal(up.selector,'@e3'); assert.equal(up.bytes,11); assert.ok(up.file.endsWith('/mv/08-delivery/v.mp4'));
    assert.equal((await uploadFile({...ok,sha256:digest},root)).bytes,11);
    await assert.rejects(uploadFile({...ok,sha256:'0'.repeat(64)},root),/sha256 does not match/);
    await assert.rejects(uploadFile({...ok,path:'mv/none.mp4'},root),/not found/);
    await assert.rejects(uploadFile(ok,undefined),/FILE_ROOT/);
    symlinkSync('/etc/hosts',join(root,'mv','link.png'));
    await assert.rejects(uploadFile({...ok,path:'mv/link.png'},root),/symlink/);
    symlinkSync(join(root,'mv'),join(root,'alias'));
    await assert.rejects(uploadFile({...ok,path:'alias/08-delivery/v.mp4'},root),/symlink/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});

import {DENSITY,DENSITY_ARGS,STREAM_ENV} from './browser.mjs';
test('frames are captured at 2x with room under the stream caps and legible quality',()=>{
 assert.equal(DENSITY,'2');
 assert.deepEqual(DENSITY_ARGS,['--force-device-scale-factor=2']);
 // The viewport tops out at 2400 CSS px; the cap must not shrink a 2x frame of it.
 assert.ok(Number(STREAM_ENV.AGENT_BROWSER_STREAM_MAX_WIDTH)>=2400*Number(DENSITY));
 assert.ok(Number(STREAM_ENV.AGENT_BROWSER_STREAM_MAX_HEIGHT)>=2400*Number(DENSITY));
 assert.ok(Number(STREAM_ENV.AGENT_BROWSER_STREAM_QUALITY)>=80);
});

import {chooseProfile,grantedProfiles,profileLink} from './browser.mjs';
test('a named profile opens only when the host grants it now',()=>{
 const granted=grantedProfiles('social, founder,../evil,');
 assert.deepEqual([...granted],['social','founder']);
 assert.equal(chooseProfile({},'' ,granted),'');
 assert.equal(chooseProfile({profile:'social'},'',granted),'social');
 assert.equal(chooseProfile({},'social',granted),'social',"a conversation's link is followed");
 assert.equal(chooseProfile({profile:'founder'},'social',granted),'founder','asking switches the link');
 assert.throws(()=>chooseProfile({profile:'other'},'',granted),/browser_profile_not_granted/);
 assert.throws(()=>chooseProfile({},'social',grantedProfiles('')),/browser_profile_not_granted/,'a revoked link stops');
 assert.throws(()=>chooseProfile({profile:'social'},'',grantedProfiles(undefined)),/browser_profile_not_granted/,'an older host grants nothing');
 assert.throws(()=>chooseProfile({profile:'../x'},'',granted),/Invalid browser profile/);
 assert.throws(()=>validateInput({action:'navigate',url:'https://x.com',profile:'/tmp/p'}),/Invalid browser profile/);
});
test('a named profile is one shared browser apart from conversation and Soot profiles',()=>{
 const a=identity(call,'/nest/packs.d/browser-use',new Set(),'social');
 const b=identity({...call,event:{...call.event,subject:'conversation-2'}},'/nest/packs.d/browser-use',new Set(['fixture']),'social');
 assert.equal(a.session,b.session);assert.equal(a.profile,b.profile);assert.equal(a.named,'social');
 assert.ok(a.profile.endsWith('/.browser/named-profiles/social'));
 const own=identity(call,'/nest/packs.d/browser-use'), soot=identity(call,'/nest/packs.d/browser-use',new Set(['fixture']));
 assert.notEqual(a.session,own.session);assert.notEqual(a.session,soot.session);assert.notEqual(a.profile,soot.profile);
 assert.throws(()=>identity(call,'/nest/packs.d/browser-use',new Set(),'../evil'));
 assert.ok(profileLink('/s','conversation-1').endsWith('/.browser/named-links/conversation-1'));
});
test('an ungranted profile is refused before any state or browser exists',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-profile-'));
 try {
  const result=spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'control'],{cwd:dir,input:JSON.stringify({...call,operation:'browser-use_control',input:{action:'navigate',url:'https://x.com',profile:'social'}}),env:{PATH:'/nonexistent',SOOT_BROWSER_PROFILES:'founder'},encoding:'utf8'});
  assert.equal(result.status,1);assert.match(result.stderr,/browser_profile_not_granted/);assert.equal(result.stdout,'');
  assert.equal(existsSync(join(dir,'.browser')),false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a view follows the conversation link and stops when the grant is revoked',()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-browser-link-'));
 try {
  mkdirSync(join(dir,'.browser','named-links'),{recursive:true});writeFileSync(profileLink(dir,call.event.subject),'social');
  const state=join(dir,'.browser','named-sessions','social');mkdirSync(state,{recursive:true});writeFileSync(join(state,'closed'),'closed');
  const view=env=>spawnSync(process.execPath,[fileURLToPath(new URL('./cli.mjs',import.meta.url)),'view'],{cwd:dir,input:JSON.stringify({...call,input:{}}),env:{PATH:'/nonexistent',...env},encoding:'utf8'});
  let result=view({SOOT_BROWSER_PROFILES:'social'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{session:'profile-social',tabs:[],closed:true,resource:{state:'closed'},profiles:['social']});
  result=view({SOOT_BROWSER_PROFILES:''});
  assert.equal(result.status,1);assert.match(result.stderr,/browser_profile_not_granted/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

import {screenshotSpec,saveScreenshot} from './browser.mjs';
import {symlinkSync as linkFile,readFileSync as readBytes,lstatSync as lstatFile} from 'node:fs';
test('screenshot writes a PNG only to a clean workspace path, never through a symlink',async()=>{
  const root=mkdtempSync(join(tmpdir(),'soot-shot-')), outside=mkdtempSync(join(tmpdir(),'soot-out-'));
  const ihdr=Buffer.alloc(16); ihdr.writeUInt32BE(13,0); ihdr.write('IHDR',4); ihdr.writeUInt32BE(2560,8); ihdr.writeUInt32BE(1600,12);
  const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),ihdr,Buffer.from('pixels')]);
  try {
    assert.deepEqual(validateInput({action:'screenshot',path:'tmp/s.png'}).path,'tmp/s.png');
    for (const path of ['/etc/x.png','../x.png','a/../x.png','.hidden/x.png','tmp/.x.png','x.jpg','x','tmp//x.png','a\\b.png'])
      assert.throws(()=>screenshotSpec({path}),undefined,path);
    assert.throws(()=>screenshotSpec({path:'x.png',full_page:'yes'}));
    assert.equal(validateInput({action:'screenshot',path:'tmp/s.png',url:'http://127.0.0.1:8000/p.html'}).url,'http://127.0.0.1:8000/p.html');
    assert.throws(()=>validateInput({action:'screenshot',path:'tmp/s.png',url:'file:///etc/passwd'}));
    const saved=await saveScreenshot({path:'tmp/deep/s.png'},png,root);
    assert.deepEqual(saved,{path:'tmp/deep/s.png',bytes:png.length,width:2560,height:1600,scale:2});
    assert.deepEqual(readBytes(join(root,'tmp/deep/s.png')),png);
    assert.equal(lstatFile(join(root,'tmp/deep/s.png')).mode&0o777,0o600);
    await saveScreenshot({path:'tmp/deep/s.png'},png,root); // replaced in place
    await assert.rejects(saveScreenshot({path:'n.png'},Buffer.from('not a png'),root),/PNG/);
    await assert.rejects(saveScreenshot({path:'n.png'},png,undefined),/FILE_ROOT/);
    // A symlinked folder or file never carries the write out of the workspace.
    linkFile(outside,join(root,'link'));
    await assert.rejects(saveScreenshot({path:'link/s.png'},png,root),/symlink/);
    writeFileSync(join(outside,'target.png'),'keep');
    linkFile(join(outside,'target.png'),join(root,'f.png'));
    await assert.rejects(saveScreenshot({path:'f.png'},png,root),/symlink/);
    assert.equal(readBytes(join(outside,'target.png'),'utf8'),'keep');
    assert.equal(existsSync(join(outside,'s.png')),false);
  } finally { rmSync(root,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
});

import {pageLog,PAGE_LOG_SCRIPT} from './browser.mjs';
test('the page log shows a loopback page its script errors and console, and records nothing on another site',()=>{
  const log=pageLog(JSON.stringify([{text:"Uncaught SyntaxError: Unexpected token ';'",url:'http://127.0.0.1:8000/p.html',line:4,column:26},{type:'warn',text:'slow'}]));
  assert.deepEqual(log.errors,[{text:"Uncaught SyntaxError: Unexpected token ';'",url:'http://127.0.0.1:8000/p.html',line:4,column:26}]);
  assert.deepEqual(log.messages,[{type:'warn',text:'slow'}]);
  assert.equal(pageLog('null'),null); assert.equal(pageLog('not json'),null); assert.equal(pageLog(undefined),null);
  // The script runs in a page; here, a stand-in window per hostname.
  const run=hostname=>{const listeners={};const w={location:{hostname},addEventListener:(k,f)=>{listeners[k]=f;},console:{log(){},info(){},warn(){},error(){},debug(){}}};
    new Function('window','location','addEventListener','console','ErrorEvent',PAGE_LOG_SCRIPT)(w,w.location,w.addEventListener,w.console,class{});
    return {w,listeners};};
  const other=run('example.com');
  assert.equal(other.w[Symbol.for('soot.page.log')],undefined); assert.deepEqual(Object.keys(other.listeners),[]);
  const own=run('127.0.0.1');
  own.w.console.warn('slow',{a:1});
  assert.deepEqual(own.w[Symbol.for('soot.page.log')],[{type:'warn',text:'slow {"a":1}'}]);
});
test('screenshot steps capture frames between commands, checked and bounded',()=>{
  const list=commandSteps({action:'command',steps:[['open','http://127.0.0.1:8000/'],['screenshot','tmp/f0.png'],['eval','go()'],['screenshot','tmp/f1.png','--full']]});
  assert.deepEqual(list[1],['screenshot','tmp/f0.png']);
  assert.throws(()=>commandSteps({action:'command',steps:[['screenshot','/etc/x.png']]}),/relative/);
  assert.throws(()=>commandSteps({action:'command',steps:[['screenshot','tmp/a.png','--other']]}),/screenshot step/);
  assert.throws(()=>commandSteps({action:'command',steps:Array.from({length:MAX_SHOTS+1},(_,i)=>['screenshot',`tmp/${i}.png`])}),/at most/);
  // A viewport change between frames; a bad size or an unknown verb says what is allowed.
  assert.deepEqual(commandSteps({action:'command',steps:[['screenshot','tmp/a.png'],['resize','900','700'],['screenshot','tmp/b.png']]})[1],['resize','900','700']);
  assert.throws(()=>commandSteps({action:'command',steps:[['resize','9000','700']]}),/Invalid width/);
  assert.throws(()=>commandSteps({action:'command',steps:[['resize','900']]}),/resize step/);
  assert.throws(()=>commandSteps({action:'command',steps:[['zoom','2']]}),/Unsupported browser command "zoom"; commands: open, .*screenshot and resize/);
  assert.throws(()=>command({action:'command',args:['zoom']}),err=>/"zoom"/.test(err.message)&&!/as steps/.test(err.message));
  // A lone args screenshot still goes through action screenshot.
  assert.throws(()=>command({action:'command',args:['screenshot','x.png']}),/Unsupported/);
});
test('only reopening a loopback page clears the cache',()=>{
  assert.equal(localReopen(['open','http://127.0.0.1:8000/p.html']),true);
  assert.equal(localReopen(['open','http://localhost:3000/']),true);
  assert.equal(localReopen(['reload']),true);
  assert.equal(localReopen(['open','https://example.com/']),false);
  assert.equal(localReopen(['eval','1']),false);
});
test('clearCache speaks to the session endpoint only and never fails the open',async()=>{
  const sent=[];
  const fake=url=>{const ws={send:m=>{const r=JSON.parse(m);sent.push(r.method);const result=r.method==='Target.getTargets'?{targetInfos:[{type:'page',targetId:'T'}]}:r.method==='Target.attachToTarget'?{sessionId:'S'}:{};queueMicrotask(()=>ws.onmessage({data:JSON.stringify({id:r.id,result})}));},close(){}};assert.equal(url,'ws://127.0.0.1:9/devtools/browser/x');queueMicrotask(()=>ws.onopen());return ws;};
  assert.equal(await clearCache(async()=>({cdpUrl:'ws://127.0.0.1:9/devtools/browser/x'}),fake),true);
  assert.deepEqual(sent,['Target.getTargets','Target.attachToTarget','Network.clearBrowserCache']);
  assert.equal(await clearCache(async()=>({cdpUrl:'ws://10.0.0.5:9/x'}),()=>{throw new Error('dialed');}),false);
  assert.equal(await clearCache(async()=>{throw new Error('no daemon');}),false);
});
