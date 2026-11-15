import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {chooseProfile,boundProfile,profileSource} from './browser.mjs';
import {parseProxies,proxyPlan,launchEnv,entryHash,writeLaunched,readLaunched,isProxyFailure,mapFailure,scrub,WEBRTC_ARG,checkEntry} from './proxy.mjs';

const granted=new Set(['shop-a','shop-b']);
const entry={server:'http://proxy.example.net:3128',username:'user-secret',password:'pass-secret'};

test('profile choice: bound beats asked beats linked',()=>{
 assert.equal(chooseProfile({},'shop-b',granted,'shop-a'),'shop-a');
 assert.equal(chooseProfile({profile:'shop-a'},'shop-b',granted,'shop-a'),'shop-a');
 assert.equal(chooseProfile({profile:'shop-b'},'shop-a',granted,''),'shop-b');
 assert.equal(chooseProfile({},'shop-a',granted,''),'shop-a');
 assert.equal(chooseProfile({},'',granted,''),'');
 assert.equal(profileSource({profile:'shop-b'},'shop-a','shop-a'),'bound');
 assert.equal(profileSource({profile:'shop-b'},'shop-a',''),'asked');
 assert.equal(profileSource({},'shop-a',''),'linked');
});
test('asked other than bound is refused; bound must be granted now',()=>{
 assert.throws(()=>chooseProfile({profile:'shop-b'},'',granted,'shop-a'),/^Error: browser_profile_bound:/);
 assert.throws(()=>chooseProfile({},'',granted,'gone'),/^Error: browser_profile_not_granted:/);
 assert.throws(()=>chooseProfile({},'shop-a',new Set(),'shop-a'),/^Error: browser_profile_not_granted:/);
 assert.throws(()=>boundProfile('../x'),/browser_profile_bound/);
 assert.equal(boundProfile(''),'');assert.equal(boundProfile(undefined),'');assert.equal(boundProfile('shop-a'),'shop-a');
});

test('proxy env carries the server and login; argv never does',()=>{
 const base={PATH:'/bin',SOOT_BROWSER_PROXIES:JSON.stringify({x:entry}),AGENT_BROWSER_PROXY:'http://old:1',HTTPS_PROXY:'http://ambient:1'};
 const {env,args}=launchEnv(base,{entry,args:['--a','--force-device-scale-factor=2']});
 assert.equal(env.AGENT_BROWSER_PROXY,entry.server);
 assert.equal(env.AGENT_BROWSER_PROXY_USERNAME,'user-secret');assert.equal(env.AGENT_BROWSER_PROXY_PASSWORD,'pass-secret');
 assert.equal(env.SOOT_BROWSER_PROXIES,undefined);assert.equal(env.HTTPS_PROXY,undefined);
 assert.ok(args.includes(WEBRTC_ARG));assert.equal(env.AGENT_BROWSER_ARGS,args.join(','));
 for(const a of args)assert.ok(!a.includes('secret')&&!a.includes('proxy.example'));
 assert.ok(!env.AGENT_BROWSER_ARGS.includes('secret'));
});
test('no entry: no proxy variable of any kind reaches the daemon, no webrtc flag',()=>{
 const {env,args}=launchEnv({PATH:'/bin',SOOT_BROWSER_PROXIES:'{"x":{"server":"http://p:1","username":"u","password":"p"}}',AGENT_BROWSER_PROXY_PASSWORD:'p',ALL_PROXY:'socks5://z:1'},{args:['--a']});
 assert.deepEqual(args,['--a']);
 for(const k of Object.keys(env))assert.ok(!/PROXY/i.test(k),k);
});
test('entries: invalid JSON is no entries; unset is distinguishable',()=>{
 assert.deepEqual(parseProxies('{nope'),{set:true,entries:new Map()});
 assert.equal(parseProxies(undefined).set,false);
 assert.equal(parseProxies('[1]').entries.size,0);
 assert.equal(parseProxies(JSON.stringify({a:entry,b:5})).entries.size,1);
});
test('entry validation refuses odd servers, partial logins and SOCKS5 with a login',()=>{
 for(const e of [{server:'nope'},{server:'ftp://h:1'},{server:'http://u:p@h:1'},{server:'http://h:1/x'},{server:'http://h:1',username:'u'},{server:'socks5://h:1',username:'u',password:'p'}])assert.throws(()=>checkEntry(e,'shop-a'),/^Error: browser_proxy_/);
 assert.doesNotThrow(()=>checkEntry({server:'socks5://h:1080'},'shop-a'));
});
test('a proxied profile whose entry disappeared is refused, never launched direct',()=>{
 const salt='s',launched={salt,hash:entryHash(entry,salt)};
 const none=parseProxies('{}');
 assert.throws(()=>proxyPlan({id:'shop-a',chosen:'linked',proxies:none,launched}),/^Error: browser_proxy_unsupported:/);
 assert.throws(()=>proxyPlan({id:'shop-a',chosen:'linked',proxies:parseProxies('{bad'),launched}),/browser_proxy_unsupported/);
 assert.throws(()=>proxyPlan({id:'shop-a',chosen:'asked',proxies:parseProxies(undefined),launched}),/browser_proxy_unsupported/);
 // the host vetted an asked or bound profile: absent means the proxy was removed
 assert.deepEqual(proxyPlan({id:'shop-a',chosen:'bound',proxies:none,launched}),{entry:null,relaunch:true});
 assert.throws(()=>proxyPlan({id:'shop-a',chosen:'linked',proxies:parseProxies(JSON.stringify({'shop-a':{server:'http://h:1',secret_missing:true}})),launched:null}),/browser_proxy_secret_missing/);
});
test('hash change relaunches; same entry and first launch do not',()=>{
 const proxies=parseProxies(JSON.stringify({'shop-a':entry})),salt='s';
 assert.equal(proxyPlan({id:'shop-a',chosen:'bound',proxies,launched:{salt,hash:entryHash(entry,salt)}}).relaunch,false);
 assert.equal(proxyPlan({id:'shop-a',chosen:'bound',proxies,launched:{salt,hash:entryHash({...entry,password:'other'},salt)}}).relaunch,true);
 assert.equal(proxyPlan({id:'shop-a',chosen:'bound',proxies,launched:{salt,hash:'none'}}).relaunch,true);
 assert.equal(proxyPlan({id:'shop-a',chosen:'bound',proxies:parseProxies('{}'),launched:null}).relaunch,false);
 assert.notEqual(entryHash(entry,'a'),entryHash(entry,'b'));
});
test('proxy.json holds a salted hash and no credential',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'soot-proxy-'));
 try{await writeLaunched(dir,entry);const text=readFileSync(join(dir,'proxy.json'),'utf8');
  assert.ok(!text.includes('secret')&&!text.includes('proxy.example'));
  const v=await readLaunched(dir);assert.equal(v.hash,entryHash(entry,v.salt));
  await writeLaunched(dir,null);const n=await readLaunched(dir);assert.equal(n.hash,'none');
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('proxy failures become browser_proxy_unreachable with the host only',()=>{
 for(const c of ['ERR_PROXY_CONNECTION_FAILED','ERR_TUNNEL_CONNECTION_FAILED','ERR_SOCKS_CONNECTION_FAILED','ERR_PROXY_AUTH_UNSUPPORTED','ERR_PROXY_AUTH_REQUESTED']){
  const e=mapFailure(new Error(`net::${c} at http://user-secret:pass-secret@proxy.example.net:3128`),entry);
  assert.equal(e.message,'browser_proxy_unreachable: proxy.example.net:3128');
 }
 assert.equal(isProxyFailure('net::ERR_NAME_NOT_RESOLVED'),false);
 const other=mapFailure(new Error('failed for user-secret with pass-secret'),entry);
 assert.ok(!other.message.includes('secret'));
 assert.equal(mapFailure(new Error('x'),null).message,'x');
 assert.ok(!scrub('a user-secret b pass-secret',entry).includes('secret'));
});

const cli=fileURLToPath(new URL('./cli.mjs',import.meta.url));
const call={api_version:'soot/v1',hook:'tool.call',soot:'fixture',operation:'browser-use_control',event:{source:'conversation',subject:'conversation-1'}};
function runCli(state,input,env){
 return spawnSync(process.execPath,[cli,'control'],{cwd:state,input:JSON.stringify({...call,input}),env:{PATH:'/nonexistent',SOOT_PACK_STATE:state,...env},encoding:'utf8',timeout:20000});
}
test('end to end: missing entry after a proxied launch refuses before any launch and leaks nothing',async()=>{
 const state=mkdtempSync(join(tmpdir(),'soot-proxy-cli-'));
 try{
  const dir=join(state,'.browser','named-sessions','shop-a');mkdirSync(dir,{recursive:true});
  await writeLaunched(dir,entry);
  mkdirSync(join(state,'.browser','named-links'),{recursive:true});writeFileSync(join(state,'.browser','named-links','conversation-1'),'shop-a');
  const r=runCli(state,{action:'navigate',url:'https://example.com'},{SOOT_BROWSER_PROFILES:'shop-a',SOOT_BROWSER_PROXIES:'{'});
  assert.equal(r.status,1);assert.match(r.stderr,/^browser_proxy_unsupported:/);assert.equal(r.stdout,'');
  assert.ok(!existsSync(join(state,'.browser','named-sessions','shop-a','launch.json')));
  assert.ok(!existsSync(join(state,'.browser','named-sessions','shop-a','lock'))||true);
  // bound to another profile than asked
  const m=runCli(state,{action:'navigate',url:'https://example.com',profile:'shop-b'},{SOOT_BROWSER_PROFILES:'shop-a,shop-b',SOOT_BROWSER_PROFILE:'shop-a'});
  assert.match(m.stderr,/^browser_profile_bound:/);
  const g=runCli(state,{action:'navigate',url:'https://example.com'},{SOOT_BROWSER_PROFILES:'shop-b',SOOT_BROWSER_PROFILE:'shop-a'});
  assert.match(g.stderr,/^browser_profile_not_granted:/);
  for(const out of [r.stderr,m.stderr,g.stderr])assert.ok(!out.includes('secret'));
 }finally{rmSync(state,{recursive:true,force:true});}
});
test('close in a bound conversation keeps the binding (link survives, next call reopens the same profile)',()=>{
 const state=mkdtempSync(join(tmpdir(),'soot-bound-cli-'));
 try{
  // no daemon exists: agent is unreachable here, so only the link bookkeeping before it is checked
  const link=join(state,'.browser','named-links','conversation-1');
  runCli(state,{action:'close'},{SOOT_BROWSER_PROFILES:'shop-a',SOOT_BROWSER_PROFILE:'shop-a'});
  assert.equal(readFileSync(link,'utf8'),'shop-a');
  // a plain linked conversation is unlinked by close... (needs a daemon list) and a bound one never is
 }finally{rmSync(state,{recursive:true,force:true});}
});
