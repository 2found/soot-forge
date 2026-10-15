import {open, readFile, access, stat, writeFile, rename, rm, mkdir} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
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

// Chromium is downloaded once per host (about 140 MB). `soot browser install`
// warms it with `soot-browser prepare`; a conversation's first command may
// arrive mid-download and must wait for that one download, not start another
// into the same directory.
export async function resolveBrowser() {
  const release=await lock(join(process.env.CLOAKBROWSER_CACHE_DIR||join(homedir(),'.cloakbrowser'),'.soot-install'),
    {attempts:850,busy:'The browser is still downloading for first use; try again in a minute'});
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

// Loading cloakbrowser also imports its Playwright launch stack. Resolve it
// once per conversation; ordinary agent commands only need the executable and
// flags. Cache no cookies, credentials, provider data, or model-authored argv.
export async function launchSettings(dir, resolve=resolveBrowser) {
  const key=createHash('sha256').update(JSON.stringify(manifest)).update(process.platform+process.arch).digest('hex');
  const path=join(dir,'launch.json');
  const executable=async binary=>{if(!(await stat(binary)).isFile())throw Error('Browser executable is not a file');await access(binary,constants.X_OK);};
  const valid=value=>value && typeof value.binary==='string' && value.binary.length<=4096 && isAbsolute(value.binary) && Array.isArray(value.args) && value.args.length<=64 && value.args.every(a=>typeof a==='string'&&a.length<=2048);
  // Explicit host overrides may carry policy/credentials; never cache them.
  const cacheable=!Object.keys(process.env).some(k=>k.startsWith('CLOAKBROWSER_'));
  if(cacheable)try {
    const cached=await boundedJSON(path);
    if(cached.key===key&&valid(cached)) {await executable(cached.binary);return cached;}
  }catch { /* Re-resolve missing/stale state before any browser action. */ }
  const value=await resolve();
  if(!valid(value))throw Error('Invalid browser launch settings');
  await executable(value.binary);
  if(cacheable) {
    const temporary=path+`.${process.pid}.tmp`;
    try {await writeFile(temporary,JSON.stringify({key,...value}),{mode:0o600});await rename(temporary,path);}
    finally {await rm(temporary,{force:true});}
  }
  return value;
}
