import {open, readFile, access, stat, writeFile, rename, rm} from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';

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
export async function launchSettings(dir, resolve=async()=>{
  const cloak=await import('cloakbrowser');
  return {binary:await cloak.ensureBinary(),args:cloak.getDefaultStealthArgs()};
}) {
  const key=createHash('sha256').update(await readFile(new URL('./package.json',import.meta.url))).update(process.platform+process.arch).digest('hex');
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
