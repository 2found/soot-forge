// Opt-in installed-pack journey: real Soot/provider/Chromium, local fixture only.
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {createServer} from 'node:http';
import {randomBytes} from 'node:crypto';
import assert from 'node:assert/strict';
import {materialize,readCatalog} from './catalog.mjs';
import {archivePack} from './archive.mjs';

const options={};for(let i=2;i<process.argv.length;i+=2){if(!['--soot','--output','--provider','--model','--desktop'].includes(process.argv[i])||!process.argv[i+1])throw Error('Usage: node scripts/live-browser.mjs --soot BINARY --output NEW_DIRECTORY --provider ID --model NAME');options[process.argv[i].slice(2)]=process.argv[i+1];}
for(const key of ['soot','output','provider','model'])if(!options[key])throw Error(`Missing ${key}`);
const root=resolve(import.meta.dirname,'..'),output=resolve(options.output),binary=resolve(options.soot),exec=promisify(execFile);
await mkdir(output);const config=join(output,'deployment.json');
const env={...process.env,PATH:dirname(process.execPath)+':'+join(output,'host/bin')+':'+process.env.PATH,FORGE_BROWSER_TOKEN:randomBytes(32).toString('hex')};
let submitted='',runtime,desktop,conversation,logs='',api,headers;
const page=createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');res.setHeader('Content-Type','text/html;charset=utf-8');
 if(url.pathname==='/submit')submitted=url.searchParams.get('name')||'';
 res.end('<title>Soot browser fixture</title><h1>Local browser verification</h1><form action="/submit"><label>Name <input name="name"></label><button>Confirm</button></form><output id="result"></output><p id="clock"></p><div style="height:4000px">Scroll fixture</div><script>document.querySelector("output").textContent='+JSON.stringify(submitted)+';setInterval(()=>document.querySelector("#clock").textContent=Date.now(),100)</script>');
});
await new Promise(r=>page.listen(0,'127.0.0.1',r));
const portProbe=createServer();await new Promise(r=>portProbe.listen(0,'127.0.0.1',r));const port=portProbe.address().port;await new Promise(r=>portProbe.close(r));
const invoke=(program,args,extra={})=>exec(program,args,{cwd:output,env,timeout:420000,maxBuffer:4*1024*1024,...extra});
const post=async(path,body)=>{const response=await fetch(api+path,{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(`${response.status}: ${JSON.stringify(data)}`);return data;};
try {
 await writeFile(join(output,'SOUL.md'),'Use real tools on the authorized local fixture. Never invent success.\n');
 await writeFile(join(output,'MISSION.md'),'Verify the conversation browser. No external writes or messages.\n');
 await writeFile(join(output,'review.json'),JSON.stringify({id:'review',soul:'SOUL.md',mission:'MISSION.md',packs:['browser-use'],model:{provider:options.provider,name:options.model,fallbacks:[]}}));
 await writeFile(config,JSON.stringify({listen:`127.0.0.1:${port}`,token_env:'FORGE_BROWSER_TOKEN',packs_dir:'packs',data_dir:'data',default_soot:'review',soots:['review.json'],pack_grants:{'browser-use':{env:['PATH','HOME']}},execution:{max_turns:16,max_tool_calls:24,tool_timeout:'90s',subagents:0,advisor:false,memory_consolidation:false,todo_nudges:0}}));
 const catalog=await readCatalog(root),source=await materialize(catalog.packs.find(p=>p.id==='browser-use'),root,join(output,'materialized'));
 const archive=join(output,'browser-use.tar.gz');await archivePack(source,archive,'browser-use');
 await writeFile(join(output,'install.json'),(await invoke(binary,['add',archive,'--config',config,'--json'])).stdout);
 await invoke('npm',['install','--global','--install-links','--ignore-scripts','--no-audit','--no-fund','--prefix',join(output,'host'),join(output,'packs/browser-use/adapter')]);
 runtime=spawn(binary,['serve','--config',config],{cwd:output,env,stdio:['ignore','pipe','pipe']});for(const pipe of [runtime.stdout,runtime.stderr])pipe.on('data',chunk=>logs+=chunk);
 api=`http://127.0.0.1:${port}`;headers={Authorization:`Bearer ${env.FORGE_BROWSER_TOKEN}`};
 for(let i=0;i<100;i++){if(runtime.exitCode!==null)throw Error('Runtime exited');try{if((await fetch(api+'/v1/conversations/soots',{headers})).ok)break;}catch{}if(i===99)throw Error('Runtime unavailable');await new Promise(r=>setTimeout(r,200));}
 const started=Date.now(),marker='Soot browser đã kiểm chứng';
 const prompt=`Read the browser-use skill and use real browser-use_control tools. Open http://127.0.0.1:${page.address().port}/ , snapshot interactive refs, fill Name with exactly "${marker}", click Confirm and inspect the resulting page to verify the exact text. Do not use shell/network tools instead of browser interactions. Leave this conversation browser open for the test harness. This local form submission is authorized; no external websites or messages.`;
 const result=JSON.parse((await invoke(binary,['run','--config',config,'--soot','review','--json','--timeout','6m',prompt])).stdout);conversation=result.conversation_id;
 await writeFile(join(output,'run.json'),JSON.stringify(result,null,2));assert.equal(result.state,'completed');assert.equal(submitted,marker);
 const base=`/v1/conversations/${conversation}/interface`,action=input=>post(base,{interface:'browser-use/browser',read:false,input});
 // Actual upstream ACK pacing: animation generates frames even while withheld.
 const controller=new AbortController(),events=[];let pending='';
 const stream=await fetch(api+base+'/stream?interface=browser-use%2Fbrowser&pacing=ack',{headers,signal:controller.signal});assert.equal(stream.status,200);
 const reader=stream.body.getReader(),decoder=new TextDecoder();
 const consume=(async()=>{try{while(true){const {done,value}=await reader.read();if(done)break;pending+=decoder.decode(value,{stream:true});let end;while((end=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,end);pending=pending.slice(end+2);const type=block.match(/^event: (.+)$/m)?.[1],data=block.match(/^data: (.+)$/m)?.[1];if(type&&data)events.push({type,data:JSON.parse(data)});}}}catch(error){if(!controller.signal.aborted)throw error;}})();
 const until=async(fn)=>{for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out waiting for stream evidence');};
 let first,viewer;
 try {
  await until(()=>events.some(e=>e.type==='frame'));first=events.find(e=>e.type==='frame').data;viewer=events.find(e=>e.type==='viewer').data.id;assert.ok(Number.isInteger(first.seq));
  await new Promise(r=>setTimeout(r,350));assert.equal(events.filter(e=>e.type==='frame').length,1);
  await post(base+'/stream/ack',{interface:'browser-use/browser',viewer,seq:first.seq});await until(()=>events.filter(e=>e.type==='frame').length>=2);
 }finally{controller.abort();await consume;}
 // The authenticated human path guards the current tab before any input.
 await assert.rejects(action({action:'text',text:'must not appear',tab:'t999999'}));
 const check=await action({action:'command',args:['get','value','input']});assert.ok(!JSON.stringify(check).includes('must not appear'));
 const listed=await action({action:'command',args:['tab','list']});
 const tab=listed.result.tabs.find(t=>t.active).tabId;
 await action({action:'command',args:['click','input']});
 await action({action:'text',text:'Nhập trực tiếp',tab});
 const typed=await action({action:'command',args:['get','value','input']});assert.ok(JSON.stringify(typed).includes('Nhập trực tiếp'));

 const summary={status:'completed',provider:options.provider,model:options.model,seconds:(Date.now()-started)/1000,conversation,submitted,checks:['archive install + isolated operator dependency prefix','real provider snapshot/fill/submit/read','real animated Chromium stream: one unacknowledged frame','host ACK releases next frame','stale human target rejected','human WebSocket text confirmed in actual DOM'],scope:'Local fixture only; real Soot, provider and pinned browser dependencies. No native desktop UI assertion.'};
 await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
 if(options.desktop){
  const home=join(output,'desktop-home');await mkdir(home,{mode:0o700});
  await writeFile(join(home,'connections.json'),JSON.stringify({default:'fixture',connections:{fixture:{url:api,token:env.FORGE_BROWSER_TOKEN}}}),{mode:0o600});
  desktop=spawn(resolve(options.desktop),[],{env:{...env,SOOT_HOME:home},stdio:'ignore'});
  console.log(`Native QA window PID ${desktop.pid}; write ${join(output,'ui.done')} after verification to clean up.`);
  for(let i=0;i<600;i++){if(desktop.exitCode!==null)throw Error('Native QA app exited');try{await readFile(join(output,'ui.done'));break;}catch{}if(i===599)throw Error('Native QA deadline');await new Promise(r=>setTimeout(r,1000));}
 }

} finally {
 if(desktop)desktop.kill('SIGTERM');
 if(conversation&&api)try{await post(`/v1/conversations/${conversation}/interface`,{interface:'browser-use/browser',read:false,input:{action:'close'}});}catch(error){console.error('Owned browser cleanup failed:',error.message);process.exitCode=1;}
 if(runtime){runtime.kill('SIGTERM');await Promise.race([new Promise(r=>runtime.once('exit',r)),new Promise(r=>setTimeout(r,5000))]);if(runtime.exitCode===null&&runtime.signalCode===null)runtime.kill('SIGKILL');}
 await new Promise(r=>page.close(r));await writeFile(join(output,'runtime.log'),logs,{mode:0o600});
}
