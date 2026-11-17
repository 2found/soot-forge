import {open, readFile, readdir, access, stat, writeFile, rename, rm, mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {agent} from './agent.mjs';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
// Imported rather than read from disk: the single-file build has no
// package.json beside it, and the launch cache must still follow its version.
import manifest from './package.json' with {type:'json'};

// One holder per directory across processes; a holder that died is replaced.
export async function lock(dir, {attempts=600, busy='Browser is busy; try again after the current command finishes'}={}) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,'lock');
  for(let n=0;n<attempts;n++) {
    try {const f=await open(path,'wx',0o600);await f.writeFile(String(process.pid));await f.close();return ()=>rm(path,{force:true});}
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      try {const pid=Number(await readFile(path,'utf8'));if(pid>0) {try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')await rm(path,{force:true});}}}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
  }
  throw new Error(busy);
}

// The browser a session runs on. Chromium is Chrome for Testing, the build
// agent-browser installs (~/.agent-browser/browsers): current, sandboxed, and
// its DevTools report page errors. CloakBrowser (a patched Chromium that hides
// automation) is used only when asked for: the call's `engine`, the host's
// SOOT_BROWSER_ENGINE, or a sign-in profile made with it.
export const ENGINES=['chromium','cloak'];
export function defaultEngine(env=process.env) {return ENGINES.includes(env.SOOT_BROWSER_ENGINE)?env.SOOT_BROWSER_ENGINE:'chromium';}

const CFT_EXE={darwin:['Google Chrome for Testing.app','Contents','MacOS','Google Chrome for Testing'],linux:['chrome'],win32:['chrome.exe']};
// The newest installed Chrome for Testing, or null. Never the person's own Chrome.
export async function chromeForTesting(home=homedir(), platform=process.platform) {
  const dir=join(home,'.agent-browser','browsers'), exe=CFT_EXE[platform];
  if(!exe) return null;
  let names=[];try{names=await readdir(dir);}catch{return null;}
  const versions=names.map(n=>/^chrome-(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(n)).filter(Boolean)
    .sort((a,b)=>{for(let i=1;i<=4;i++){const d=Number(b[i])-Number(a[i]);if(d)return d;}return 0;});
  for(const m of versions) {
    const binary=join(dir,m[0],...exe);
    try{if((await stat(binary)).isFile()){await access(binary,constants.X_OK);return binary;}}catch{}
  }
  return null;
}

// A browser is downloaded once per host (Chromium about 190 MB, CloakBrowser
// about 140 MB). `soot browser install` warms the default one with
// `soot-browser prepare`; a conversation's first command may arrive
// mid-download and must wait for that one download, not start another into
// the same directory.
export async function resolveBrowser(engine=defaultEngine()) {
  if(!ENGINES.includes(engine)) throw Error('Unknown browser engine');
  const busy={attempts:850,busy:'The browser is still downloading for first use; try again in a minute'};
  if(engine==='chromium') {
    const release=await lock(join(homedir(),'.agent-browser','.soot-install'),busy);
    try {
      let binary=await chromeForTesting();
      if(!binary) {await agent(['install'],{timeout:20*60000,maxBuffer:8*1024*1024});binary=await chromeForTesting();}
      if(!binary) throw Error('Chromium could not be installed');
      return {binary,args:[]};
    } finally {await release();}
  }
  const release=await lock(join(process.env.CLOAKBROWSER_CACHE_DIR||join(homedir(),'.cloakbrowser'),'.soot-install'),busy);
  try {
    const cloak=await import('cloakbrowser');
    return {binary:await cloak.ensureBinary(),args:cloak.getDefaultStealthArgs()};
  } finally {await release();}
}

export async function boundedJSON(path, limit=32768) {
  const file=await open(path,'r');
  try {
    const buffer=Buffer.alloc(limit+1);
    let size=0;
    while(size<buffer.length) {const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);if(!bytesRead)break;size+=bytesRead;}
    if(size>limit)throw Error('Browser state is too large');
    return JSON.parse(buffer.subarray(0,size).toString('utf8'));
  }finally{await file.close();}
}

// Resolving a browser can download it, and loading cloakbrowser imports its
// Playwright launch stack. Resolve it once per session and engine; ordinary agent commands only need the executable and
// flags. Cache no cookies, credentials, provider data, or model-authored argv.
export async function launchSettings(dir, resolve=resolveBrowser, engine=defaultEngine()) {
  if(!ENGINES.includes(engine)) throw Error('Unknown browser engine');
  const key=createHash('sha256').update(JSON.stringify(manifest)).update(process.platform+process.arch+engine).digest('hex');
  const path=join(dir,`launch-${engine}.json`);
  const executable=async binary=>{if(!(await stat(binary)).isFile())throw Error('Browser executable is not a file');await access(binary,constants.X_OK);};
  const valid=value=>value && typeof value.binary==='string' && value.binary.length<=4096 && isAbsolute(value.binary) && Array.isArray(value.args) && value.args.length<=64 && value.args.every(a=>typeof a==='string'&&a.length<=2048);
  // Explicit host overrides may carry policy/credentials; never cache them.
  const cacheable=engine!=='cloak'||!Object.keys(process.env).some(k=>k.startsWith('CLOAKBROWSER_'));
  if(cacheable)try {
    const cached=await boundedJSON(path);
    if(cached.key===key&&valid(cached)) {await executable(cached.binary);return cached;}
  }catch { /* Re-resolve missing/stale state before any browser action. */ }
  const value=await resolve(engine);
  if(!valid(value))throw Error('Invalid browser launch settings');
  await executable(value.binary);
  if(cacheable) {
    const temporary=path+`.${process.pid}.tmp`;
    try {await writeFile(temporary,JSON.stringify({key,...value}),{mode:0o600});await rename(temporary,path);}
    finally {await rm(temporary,{force:true});}
  }
  return value;
}
