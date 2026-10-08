#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm, open, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
const agentBrowser=fileURLToPath(new URL('./node_modules/agent-browser/bin/agent-browser.js',import.meta.url));
const agent=(args,options)=>exec(process.execPath,[agentBrowser,...args],options);
// The executable's cwd is the declaring pack, so installations and deployments
// never share profiles merely because they use the same adapter binary.
const root = process.cwd();
export function identity(call, packRoot = root) {
  const id = call?.event?.subject;
  if (call?.api_version !== 'soot/v1' || call?.hook !== 'tool.call' || call?.event?.source !== 'conversation' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id || '')) throw new Error('A host conversation context is required');
  const scope = createHash('sha256').update(packRoot).digest('hex').slice(0,12);
  return { session: `soot-${scope}-${id}`, profile: join(packRoot,'.browser','profiles',id), id };
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
  return args;
}
async function lock(dir) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,'lock');
  for(let n=0;n<600;n++) {
    try {const f=await open(path,'wx',0o600);await f.writeFile(String(process.pid));await f.close();return ()=>rm(path,{force:true});}
    catch(e) {
      if(e.code!=='EEXIST') throw e;
      try {const pid=Number(await readFile(path,'utf8'));if(pid>0) {try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH')await rm(path,{force:true});}}}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
  }
  throw new Error('Browser is busy; try again after the current command finishes');
}
async function main() {
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>131072)throw new Error('Envelope too large');}
  const call=JSON.parse(text), ident=identity(call), input=call.input||{};
  const readonly=process.argv[2]==='view';
  if (!readonly && input.action==='command') command(input);
  const sessionDir=join(root,'.browser','sessions',ident.id);
  // A viewer never takes the control lock: it must connect while an agent is
  // navigating/waiting, and it must never launch or resurrect a dead session.
  if (readonly) {
    let state='unavailable', endpoint;
    try { await access(join(sessionDir,'closed')); state='closed'; } catch {
      try {
        endpoint=JSON.parse(await readFile(join(sessionDir,'stream.json'),'utf8')).url;
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
    const {url}=JSON.parse(await readFile(join(sessionDir,'stream.json'),'utf8'));
    const u=new URL(url);if(u.protocol!=='ws:'||u.hostname!=='127.0.0.1'||!u.port)throw new Error('Invalid stream endpoint');
    const events=[];
    if(input.action==='click') {
      if(!Number.isInteger(input.x)||!Number.isInteger(input.y)||input.x<0||input.x>2400||input.y<0||input.y>2400)throw new Error('Invalid pointer');
      for(const eventType of ['mouseMoved','mousePressed','mouseReleased'])events.push({type:'input_mouse',eventType,x:input.x,y:input.y,button:'left',clickCount:1});
    } else if(input.action==='scroll') {
      if(!['up','down'].includes(input.direction))throw new Error('Invalid direction');
      events.push({type:'input_mouse',eventType:'mouseWheel',x:input.x||0,y:input.y||0,deltaX:0,deltaY:input.direction==='up'?-400:400});
    } else {
      if(typeof input.text!=='string'||input.text.length>8000)throw new Error('Invalid text');
      if(input.action==='text') events.push({type:'input_keyboard',eventType:'char',text:input.text});
      else {
        const parts=input.text.split('+'),key=parts.pop();
        const modifiers=parts.reduce((n,k)=>n|({Alt:1,Control:2,Meta:4,Shift:8}[k]||0),0);
        const codes={Backspace:8,Tab:9,Enter:13,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Delete:46,Home:36,End:35,PageUp:33,PageDown:34};
        const windowsVirtualKeyCode=codes[key]||(/^[a-z]$/i.test(key)?key.toUpperCase().charCodeAt(0):0);
        const code=/^[a-z]$/i.test(key)?`Key${key.toUpperCase()}`:key;
        for(const eventType of ['keyDown','keyUp'])events.push({type:'input_keyboard',eventType,key,code,windowsVirtualKeyCode,modifiers});
      }
    }
    await new Promise((resolve,reject)=>{
      const socket=new WebSocket(url);
      const timer=setTimeout(()=>{socket.close();const e=new Error('Input transport timed out');e.uncertain=true;reject(e);},3000);
      socket.onopen=()=>{
        for(const event of events)socket.send(JSON.stringify(event));
        // Upstream input has no completion ack. Receipt means delivered to the
        // input transport, not that a site's business action succeeded.
        setTimeout(()=>{clearTimeout(timer);socket.close();resolve();},50);
      };
      socket.onerror=()=>{clearTimeout(timer);const e=new Error('Input transport disconnected');e.uncertain=true;reject(e);};
    });
    process.stdout.write(JSON.stringify({session:ident.id,result:{accepted:true},resource:{state:'active'}}));return;
  }
  let interactiveRunning=false;
  if(call.interaction===true)try{await access(join(sessionDir,'stream.json'));await access(join(sessionDir,'closed')).then(()=>{},()=>{interactiveRunning=true;});}catch{}
  const unlock=interactiveRunning?async()=>{}:await lock(sessionDir);
  try {
    const closedFile=join(sessionDir,'closed');
    const {stdout:listed} = await agent(['--session',ident.session,'--json','session','list'],{timeout:10000});
    const listedResult=JSON.parse(listed);
    if(!listedResult.success) throw new Error('Cannot inspect browser sessions');
    const running=(listedResult.data?.sessions||[]).some(s=>(typeof s==='string'?s:s.name||s.session)===ident.session);
    // Resolve the pinned adapter dependency lazily: installing a pack never
    // launches or downloads a browser. No upstream default session is used.
    // Library banners must not corrupt the executable JSON contract.
    console.log=console.info=console.warn=console.error=()=>{};
    const cloak=await import('cloakbrowser');
    const binary=await cloak.ensureBinary();
    const seed=10000+parseInt(createHash('sha256').update(ident.session).digest('hex').slice(0,8),16)%90000;
    const env={...process.env, AGENT_BROWSER_SESSION:ident.session, AGENT_BROWSER_EXECUTABLE_PATH:binary,
      AGENT_BROWSER_ARGS:cloak.getDefaultStealthArgs().map(a=>a.startsWith('--fingerprint=')?`--fingerprint=${seed}`:a).join(','),
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
    const url=()=>{const u=new URL(input.url||'about:blank');if(!['http:','https:','about:'].includes(u.protocol)||u.protocol==='about:'&&u.href!=='about:blank')throw new Error('Use an http or https URL');return u.href;};
    const number=(key,min,max)=>{const n=input[key];if(!Number.isInteger(n)||n<min||n>max)throw new Error(`Invalid ${key}`);return String(n);};
    const value=()=>{if(typeof input.text!=='string'||input.text.length>8000)throw new Error('Invalid text');return input.text;};
    const tab=()=>{if(typeof input.tab!=='string'||!/^t[0-9]+$/.test(input.tab))throw new Error('Invalid tab');return input.tab;};
    if(input.action!=='close') await rm(closedFile,{force:true});
    if(!running && input.action!=='close') {
      await run(['open','about:blank']);
      let size;
      try {size=JSON.parse(await readFile(join(sessionDir,'viewport.json'),'utf8'));} catch {
        let area; try {area=JSON.parse(await readFile(join(root,'pack.json'),'utf8')).interface?.tool_area;} catch {}
        size={width:1280,height:Math.max(240,Math.min(2400,Math.round(1280*(area?.aspect_height||10)/(area?.aspect_width||16))))};
      }
      await run(['set','viewport',String(size.width),String(size.height)]);
    }
    if(input.action!=='close') {
      let stream=await run(['stream','status']);
      if(!stream.enabled) {await run(['stream','enable']);stream=await run(['stream','status']);}
      if(!Number.isInteger(stream.port)||stream.port<1||stream.port>65535) throw new Error('Browser stream is unavailable');
      await writeFile(join(sessionDir,'stream.json'),JSON.stringify({url:`ws://127.0.0.1:${stream.port}/`}),{mode:0o600});
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
        result=await run(['set','viewport',width,height]);
        await writeFile(join(sessionDir,'viewport.json'),JSON.stringify({width:Number(width),height:Number(height)}),{mode:0o600});break;
      }
      case 'click':await run(['mouse','move',number('x',0,2400),number('y',0,2400)]);await run(['mouse','down']);result=await run(['mouse','up']);break;
      case 'key':result=await run(['press',value()]);break;
      case 'text':result=await run(['keyboard','inserttext',value()]);break;
      case 'scroll':if(!['up','down'].includes(input.direction))throw new Error('Invalid direction');result=await run(['scroll',input.direction,'400']);break;
      case 'close':result=running?await run(['close']):{closed:true};await writeFile(closedFile,'closed',{mode:0o600});break;
      default:throw new Error('Unknown browser action');
    }
    process.stdout.write(JSON.stringify({session:ident.id,result,resource:{state:input.action==='close'?'closed':'active'}}));
  } finally {await unlock();}
}
if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{process.stderr.write(e.message+'\n');process.exitCode=e.uncertain?2:1;});
