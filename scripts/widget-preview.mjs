// Deterministic browser fixture for the real widget. No runtime, credentials or model.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const port=Number(process.env.PORT || 1439);
const assets=resolve('packs/live-chat/widget');
const files=new Set(['frame.html','frame.js','widget.css','theme.css','agent.css','agent-behavior.js','widget-composer.js']);
const host=`<!doctype html><html lang="vi"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Soot widget review</title>
<link rel="stylesheet" href="/public/widget/theme.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font:14px var(--font-sans)}iframe{display:block;width:min(100%,420px);height:calc(100dvh - 48px);margin:auto;border:0}nav{min-height:48px;display:flex;justify-content:center;align-items:center;gap:8px}button{font:inherit;padding:6px 8px;color:var(--color-text);background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)}</style>
<nav><button id="fail">Fail next send</button><button id="history">Add history</button><button id="theme">Toggle theme</button></nav>
<iframe title="Soot support" id="widget"></iframe><script>
const frame=document.getElementById('widget'),nonce='local-agent-ui-review';
let messages=[],pending=null,fail=false,dark=false;
window.fixture={sent:[],draft:'',ready:false};
const config=()=>({name:'Soot',greeting:'Bạn muốn cùng Soot giải quyết việc gì hôm nay?',quick_replies:['Lên kế hoạch cho dự án','Kiểm tra khả năng tiếp cận'],theme:dark?'dark':'light'});
function post(type,extra={}){frame.contentWindow.postMessage({soot_chat:1,type,nonce,...extra},location.origin)}
function sync(extra={}){post('sync',{messages,next_after:messages.length,activity:'connected',...extra})}
addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin||e.data?.soot_chat!==1)return;const m=e.data;
if(m.type==='ready'){post('init',{language:'vi',config:config()});post('open');post('layout',{mobile:innerWidth<700});window.fixture.ready=true;}
if(m.type==='sync')sync(pending?{pendingMessage:pending}:{});
if(m.type==='draft')window.fixture.draft=m.text;
if(m.type==='send'){window.fixture.sent.push(m);if(fail){pending={id:m.id,text:m.text};fail=false;sync({pendingMessage:pending,error:{kind:'send'}});}else{pending=null;messages.push({id:String(messages.length+1),role:'user',text:m.text,created:new Date().toISOString()},{id:String(messages.length+2),role:'assistant',text:'Đã nhận yêu cầu. Mình sẽ giữ các bước rõ ràng và báo lại nếu cần bạn quyết định.',created:new Date().toISOString()});sync();}}
if(m.type==='reset'){messages=[];pending=null;post('reset-done');}
});
document.getElementById('fail').onclick=()=>{fail=true};
document.getElementById('history').onclick=()=>{for(let i=0;i<12;i++)messages.push({id:String(messages.length+1),role:'assistant',text:'Bước '+(i+1)+': Kiểm tra các trạng thái kết nối, lựa chọn và khôi phục bản nháp. Nội dung dài giúp xác nhận rằng người đọc có thể xem lại lịch sử mà không bị kéo xuống cuối.',created:new Date().toISOString()});sync();};
document.getElementById('theme').onclick=()=>{dark=!dark;post('init',{language:'en',config:config()});};
frame.src='/public/widget/frame.html?parent='+encodeURIComponent(location.origin);
</script></html>`;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(host);return;}
 const name=url.pathname.replace('/public/widget/','');
 if(!files.has(name)){res.writeHead(404);res.end();return;}
 try{const data=await readFile(resolve(assets,name));res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(data);}catch{res.writeHead(404);res.end();}
});
server.listen(port,'127.0.0.1',()=>console.log('Widget fixture: http://127.0.0.1:'+port));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>process.exit(0)));
