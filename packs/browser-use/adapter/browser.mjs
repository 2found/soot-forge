import { agent } from './agent.mjs';
import { sendInput, textEvents } from './input.mjs';
import { launchSettings, boundedJSON, lock, resolveBrowser } from './launch.mjs';
import { readFile, writeFile, rm, access, lstat, realpath, open } from 'node:fs/promises';
import { join, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Profiles, daemon names and session files live in the Pack's state directory,
// which the host keeps across configuration revisions; the working directory
// is a revision's execution cache, replaced on every activation, so state kept
// there loses the conversation's login and orphans its browser. A host without
// SOOT_PACK_STATE runs the Pack from its install, which is then the root.
// Installations never share profiles merely because they share this binary.
const root = process.env.SOOT_PACK_STATE || process.cwd();
const SAFE_ID = /^[a-zA-Z0-9_-]{1,128}$/;
// Frames the viewer shows on a Retina screen must carry 2x the pixels of the
// CSS viewport, or text is a blur. The screencast captures the window at the
// browser's own scale (an emulated scale alone leaves frames at 1x), so the
// browser starts at 2x, the stream's size caps leave room for it, and JPEG
// quality is high enough to keep small text legible.
export const DENSITY='2';
export const DENSITY_ARGS=['--force-device-scale-factor='+DENSITY];
export const STREAM_ENV={AGENT_BROWSER_STREAM_MAX_WIDTH:'4800',AGENT_BROWSER_STREAM_MAX_HEIGHT:'4800',AGENT_BROWSER_STREAM_QUALITY:'85'};

/** Soot ids the host lists in SOOT_BROWSER_PERSISTENT_SOOTS (comma separated). */
export function persistentSoots(value = process.env.SOOT_BROWSER_PERSISTENT_SOOTS) {
  return new Set(String(value ?? '').split(',').map(s => s.trim()).filter(s => SAFE_ID.test(s)));
}
// A Soot the host lists keeps one profile across all its conversations (a
// Publisher signed in once); every other Soot keeps one per conversation.
// Only host context decides: the model's input never names a profile.
export function identity(call, packRoot = root, persistent = persistentSoots()) {
  const conversation = call?.event?.subject;
  if (call?.api_version !== 'soot/v1' || call?.hook !== 'tool.call' || call?.event?.source !== 'conversation' || !SAFE_ID.test(conversation || '')) throw new Error('A host conversation context is required');
  const scope = createHash('sha256').update(packRoot).digest('hex').slice(0,12);
  // Persistent state has its own directories and daemon prefix, so no
  // conversation id (whatever its spelling) can reach a Soot's profile.
  if (typeof call.soot === 'string' && SAFE_ID.test(call.soot) && persistent.has(call.soot)) {
    const id = call.soot;
    return { session: `sootp-${scope}-${id}`, profile: join(packRoot,'.browser','soot-profiles',id), state: join(packRoot,'.browser','soot-sessions',id), id: `soot-${id}`, persistent: true };
  }
  return { session: `soot-${scope}-${conversation}`, profile: join(packRoot,'.browser','profiles',conversation), state: join(packRoot,'.browser','sessions',conversation), id: conversation, persistent: false };
}
// Input is data only. Restrict global launch/connection flags so a model cannot
// change the host-selected browser, profile, executable, or daemon identity.
export function command(input) {
  if (input.action !== 'command') throw new Error('Expected command');
  const args = input.args;
  const verbs = new Set(['open','snapshot','click','dblclick','fill','type','press','hover','select','check','uncheck','scroll','scrollintoview','get','eval','back','forward','reload','tab','wait','errors','console','find']);
  const flags = new Set(['-i','-c','-d','-s','--interactive','--compact','--depth','--selector','--name','--exact','--new-tab','--url','--load','--fn','--text','--timeout']);
  if (!Array.isArray(args) || !args.length || args.length>32 || !verbs.has(args[0]) || args.some(x=>typeof x!=='string'||x.length>8000)) throw new Error('Unsupported browser command');
  for (const arg of args.slice(1)) if (arg.startsWith('-') && !flags.has(arg)) throw new Error('Unsupported browser flag');
  if(args[0]==='open') navigationUrl(args[1]);
  if(args[0]==='tab' && args[1]==='new') navigationUrl(args[2]??'about:blank');
  return args;
}
export function navigationUrl(value='about:blank') {
  if(typeof value!=='string'||value.length>4096)throw new Error('Invalid URL');
  const url=new URL(value);
  if(!['http:','https:','about:'].includes(url.protocol)||url.protocol==='about:'&&url.href!=='about:blank'||url.username||url.password)throw new Error('Use an http or https URL without credentials');
  return url.href;
}
// Upload (marketing video posts): only a clean workspace-relative file under
// the host-bound FILE_ROOT, never a model-chosen absolute path, hidden file or
// symlink, of a media type a post can carry, at most 512 MiB.
export const UPLOAD_EXT = new Set(['.mp4','.mov','.m4v','.jpg','.jpeg','.png','.webp']);
export const UPLOAD_MAX = 512 * 1024 * 1024;
export function uploadSpec(input) {
  const {selector, path, sha256} = input;
  if (typeof selector!=='string'||!selector||selector.length>500||selector.startsWith('-')) throw new Error('Invalid upload selector');
  if (typeof path!=='string'||!path||path.length>512||path.startsWith('/')||path.includes('\\')||path.includes('\0')) throw new Error('Upload path must be relative to the workspace');
  const parts=path.split('/');
  if (parts.some(p=>!p||p==='.'||p==='..'||p.startsWith('.'))) throw new Error('Upload path must be a clean workspace path without hidden parts');
  if (!UPLOAD_EXT.has(extname(path).toLowerCase())) throw new Error('Upload accepts mp4, mov, m4v, jpg, jpeg, png or webp');
  // The claim's hash is required: the file uploaded is the one the Editor checked.
  if (typeof sha256!=='string'||!/^(sha256:)?[0-9a-f]{64}$/.test(sha256)) throw new Error('Upload needs the sha256 from the claim');
  return {selector, parts, sha256: sha256.replace(/^sha256:/,'')};
}
/** The absolute file to upload, after the same checks against the real disk. */
export async function uploadFile(input, fileRoot = process.env.FILE_ROOT) {
  const spec=uploadSpec(input);
  if (typeof fileRoot!=='string'||!fileRoot.startsWith('/')) throw new Error('The host gave this Soot no workspace for uploads (FILE_ROOT)');
  const root=await realpath(fileRoot);
  let at=root;
  for (const part of spec.parts) {
    at=join(at,part);
    const st=await lstat(at).catch(()=>null);
    if (!st) throw new Error('Upload file not found');
    if (st.isSymbolicLink()) throw new Error('Upload path must not contain a symlink');
  }
  const st=await lstat(at);
  if (!st.isFile()) throw new Error('Upload path is not a file');
  if (st.size>UPLOAD_MAX) throw new Error('Upload file is larger than 512 MiB');
  if (!resolve(at).startsWith(root+sep)) throw new Error('Upload path leaves the workspace');
  const hash=createHash('sha256'), fh=await open(at,'r');
  try { for await (const chunk of fh.createReadStream()) hash.update(chunk); } finally { await fh.close().catch(()=>{}); }
  if (hash.digest('hex')!==spec.sha256) throw new Error('Upload file changed: sha256 does not match the claim');
  return {selector: spec.selector, file: at, bytes: st.size};
}
export function validateInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid browser input');
  if(input.tab!==undefined && (typeof input.tab!=='string'||!/^t[0-9]+$/.test(input.tab)))throw new Error('Invalid tab');
  const number=(key,min,max)=>{const n=input[key];if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}`);};
  switch(input.action) {
    case 'command':command(input);break;
    case 'navigate':case 'tab_new':navigationUrl(input.url??'about:blank');break;
    case 'tab_select':case 'tab_close':if(typeof input.tab!=='string'||!/^t[0-9]+$/.test(input.tab))throw new Error('Invalid tab');break;
    case 'resize':number('width',240,2400);number('height',240,2400);break;
    case 'click':number('x',0,2400);number('y',0,2400);break;
    case 'key':case 'text':if(typeof input.text!=='string'||input.text.length>8000)throw new Error('Invalid text');break;
    case 'scroll':if(!['up','down'].includes(input.direction))throw new Error('Invalid direction');for(const key of ['x','y'])if(key in input)number(key,0,2400);for(const key of ['delta_x','delta_y'])if(key in input)number(key,-2400,2400);break;
    case 'upload':uploadSpec(input);break;
    case 'close':break;
    default:throw new Error('Unknown browser action');
  }
  return input;
}
export async function main() {
  if(process.argv[2]==='prepare') {
    // Host warm-up only: no conversation, no session, nothing launched.
    console.log=console.info=console.warn=console.error=()=>{};
    await resolveBrowser();
    process.stdout.write(JSON.stringify({ready:true}));
    return;
  }
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>131072)throw new Error('Envelope too large');}
  const call=JSON.parse(text), ident=identity(call), input=call.input||{};
  const readonly=process.argv[2]==='view';
  if(!['view','control'].includes(process.argv[2])||call.operation!==`browser-use_${process.argv[2]}`||typeof call.soot!=='string'||!call.soot)throw new Error('Invalid browser operation binding');
  if(!readonly)validateInput(input);
  else if(!input||Array.isArray(input)||typeof input!=='object'||Object.keys(input).length)throw new Error('View expects empty input');
  const sessionDir=ident.state;
  // A viewer never takes the control lock: it must connect while an agent is
  // navigating/waiting, and it must never launch or resurrect a dead session.
  if (readonly) {
    let state='unavailable', endpoint;
    try { await access(join(sessionDir,'closed')); state='closed'; } catch {
      try {
        endpoint=(await boundedJSON(join(sessionDir,'stream.json'))).url;
        const u=new URL(endpoint);
        if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||!u.port) throw new Error('Invalid stream endpoint');
        await new Promise((resolve,reject)=>{
          const socket=new WebSocket(endpoint);
          const timer=setTimeout(()=>{socket.close();reject(new Error('Stream unavailable'));},1500);
          socket.onopen=()=>{clearTimeout(timer);socket.close();resolve();};
          socket.onerror=()=>{clearTimeout(timer);reject(new Error('Stream unavailable'));};
        });
        state='active';
      } catch {}
    }
    process.stdout.write(JSON.stringify({session:ident.id,tabs:[],closed:state!=='active',resource:{state},...(state==='active'?{stream_url:endpoint}:{})}));
    return;
  }
  // Human input has its own host receipt and must remain usable while a model
  // command is waiting for OAuth. Never infer this flag from model input.
  if(call.interaction===true && ['click','key','text','scroll'].includes(input.action)) {
    try{await access(join(sessionDir,'closed'));throw Object.assign(new Error('Browser is closed'),{closed:true});}catch(e){if(e.closed)throw e;}
    const {url}=await boundedJSON(join(sessionDir,'stream.json'));
    const u=new URL(url);if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||!u.port)throw new Error('Invalid stream endpoint');
    const events=[];
    if(input.action==='click') {
      if(!Number.isInteger(input.x)||!Number.isInteger(input.y)||input.x<0||input.x>2400||input.y<0||input.y>2400)throw new Error('Invalid pointer');
      for(const eventType of ['mouseMoved','mousePressed','mouseReleased'])events.push({type:'input_mouse',eventType,x:input.x,y:input.y,button:'left',clickCount:1});
    } else if(input.action==='scroll') {
      if(!['up','down'].includes(input.direction))throw new Error('Invalid direction');
      events.push({type:'input_mouse',eventType:'mouseWheel',x:input.x||0,y:input.y||0,deltaX:input.delta_x??0,deltaY:input.delta_y??(input.direction==='up'?-400:400)});
    } else {
      if(typeof input.text!=='string'||input.text.length>8000)throw new Error('Invalid text');
      if(input.action==='text') events.push(...textEvents(input.text));
      else {
        const parts=input.text.split('+'),key=parts.pop();
        const modifiers=parts.reduce((n,k)=>n|({Alt:1,Control:2,Meta:4,Shift:8}[k]||0),0);
        const codes={Backspace:8,Tab:9,Enter:13,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Delete:46,Home:36,End:35,PageUp:33,PageDown:34};
        const windowsVirtualKeyCode=codes[key]||(/^[a-z]$/i.test(key)?key.toUpperCase().charCodeAt(0):0);
        const code=/^[a-z]$/i.test(key)?`Key${key.toUpperCase()}`:key;
        for(const eventType of ['keyDown','keyUp'])events.push({type:'input_keyboard',eventType,key,code,windowsVirtualKeyCode,modifiers});
      }
    }
    await sendInput(url,events,input.tab);
    process.stdout.write(JSON.stringify({session:ident.id,result:{accepted:true},resource:{state:'active'}}));return;
  }
  let interactiveRunning=false;
  if(call.interaction===true)try{await access(join(sessionDir,'stream.json'));await access(join(sessionDir,'closed')).then(()=>{},()=>{interactiveRunning=true;});}catch{}
  const unlock=interactiveRunning?async()=>{}:await lock(sessionDir);
  try {
    const closedFile=join(sessionDir,'closed');
    // A close must not start a daemon just to discover that it was already gone.
    let running = true;
    if (input.action==='close') {
      const {stdout:listed} = await agent(['--session',ident.session,'--json','session','list'],{timeout:10000,maxBuffer:131072});
      const listedResult=JSON.parse(listed);
      if(!listedResult.success) throw new Error('Cannot inspect browser sessions');
      running=(listedResult.data?.sessions||[]).some(s=>(typeof s==='string'?s:s.name||s.session)===ident.session);
      if (!running) {
        await writeFile(closedFile,'closed',{mode:0o600});
        process.stdout.write(JSON.stringify({session:ident.id,result:{closed:true},resource:{state:'closed'}}));
        return;
      }
    }
    // Resolve the pinned adapter dependency lazily: installing a pack never
    // launches or downloads a browser. No upstream default session is used.
    // Library banners must not corrupt the executable JSON contract.
    console.log=console.info=console.warn=console.error=()=>{};
    const launch=await launchSettings(sessionDir);
    const binary=launch.binary;
    const seed=10000+parseInt(createHash('sha256').update(ident.session).digest('hex').slice(0,8),16)%90000;
    const env={...process.env, AGENT_BROWSER_SESSION:ident.session, AGENT_BROWSER_EXECUTABLE_PATH:binary,
      AGENT_BROWSER_ARGS:[...launch.args.map(a=>a.startsWith('--fingerprint=')?`--fingerprint=${seed}`:a),...DENSITY_ARGS].join(','),
      ...STREAM_ENV,
      AGENT_BROWSER_PROFILE:ident.profile, AGENT_BROWSER_HEADED:'0', AGENT_BROWSER_IDLE_TIMEOUT_MS:'0'};
    const run=async args=> {
      let stdout;
      try { ({stdout}=await agent(['--session',ident.session,'--json',...args],{env,timeout:60000,maxBuffer:2*1024*1024})); }
      catch(error) {
        if(error.stdout) {try {const result=JSON.parse(error.stdout);if(result.success===false)throw Object.assign(new Error(result.error||'Browser command failed'),{decided:true});}catch(parsed){if(parsed.decided)throw parsed;}}
        error.uncertain=true; throw error;
      }
      let result;try{result=JSON.parse(stdout);}catch{const error=new Error('Invalid agent-browser response');error.uncertain=!readonly;throw error;}
      if(!result.success) throw new Error(result.error||'Browser command failed');
      return result.data;
    };
    const url=()=>navigationUrl(input.url??'about:blank');
    const number=(key,min,max)=>{const n=input[key];if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}`);return String(n);};
    const value=()=>{if(typeof input.text!=='string'||input.text.length>8000)throw new Error('Invalid text');return input.text;};
    const tab=()=>{if(typeof input.tab!=='string'||!/^t[0-9]+$/.test(input.tab))throw new Error('Invalid tab');return input.tab;};
    if(input.action!=='close') await rm(closedFile,{force:true});
    if(input.action!=='close') {
      // stream status also proves the named persistent daemon is reachable.
      // Avoid a separate global session enumeration for every agent command.
      let stream=await run(['stream','status']);
      if(!stream.enabled) {
        await run(['open','about:blank']);
        let size;
        try {size=await boundedJSON(join(sessionDir,'viewport.json'));} catch {
          let area; try {area=JSON.parse(await readFile(join(root,'pack.json'),'utf8')).interface?.tool_area;} catch {}
          size={width:1280,height:Math.max(240,Math.min(2400,Math.round(1280*(area?.aspect_height||10)/(area?.aspect_width||16))))};
        }
        // State on disk is not an alternate source of unbounded CLI arguments.
        validateInput({action:'resize',width:size.width,height:size.height});
        await run(['set','viewport',String(size.width),String(size.height),DENSITY]);
        await run(['stream','enable']);
        stream=await run(['stream','status']);
      }
      if(!Number.isInteger(stream.port)||stream.port<1||stream.port>65535) throw new Error('Browser stream is unavailable');
      const descriptor=JSON.stringify({url:`ws://127.0.0.1:${stream.port}/`});
      const path=join(sessionDir,'stream.json');
      if(await readFile(path,'utf8').catch(()=>null)!==descriptor) await writeFile(path,descriptor,{mode:0o600});
    }
    let result;
    switch(input.action) {
      case 'command':result=await run(command(input));break;
      case 'navigate':result=await run(['open',url()]);break;
      case 'tab_new':result=await run(['tab','new',url()]);break;
      case 'tab_select':result=await run(['tab',tab()]);break;
      case 'tab_close':result=await run(['tab','close',tab()]);break;
      case 'resize': {
        const width=number('width',240,2400),height=number('height',240,2400);
        result=await run(['set','viewport',width,height,DENSITY]);
        await writeFile(join(sessionDir,'viewport.json'),JSON.stringify({width:Number(width),height:Number(height)}),{mode:0o600});break;
      }
      case 'click':await run(['mouse','move',number('x',0,2400),number('y',0,2400)]);await run(['mouse','down']);result=await run(['mouse','up']);break;
      case 'key':result=await run(['press',value()]);break;
      case 'text':result=await run(['keyboard','inserttext',value()]);break;
      case 'scroll':
        if(input.x!==undefined&&input.y!==undefined)await run(['mouse','move',String(input.x),String(input.y)]);
        result=('delta_x' in input||'delta_y' in input)?await run(['mouse','wheel',String(input.delta_y??(input.direction==='up'?-400:400)),String(input.delta_x??0)]):await run(['scroll',input.direction,'400']);break;
      case 'upload': {
        const up=await uploadFile(input);
        result={...(await run(['upload',up.selector,up.file])),uploaded:{path:input.path,bytes:up.bytes}};break;
      }
      case 'close':result=running?await run(['close']):{closed:true};await writeFile(closedFile,'closed',{mode:0o600});break;
      default:throw new Error('Unknown browser action');
    }
    process.stdout.write(JSON.stringify({session:ident.id,result,resource:{state:input.action==='close'?'closed':'active'}}));
  } finally {await unlock();}
}
export function run() { main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=e.uncertain?2:1;}); }
