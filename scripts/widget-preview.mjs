// Deterministic browser fixture for the real widget. No runtime, credentials or model.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const port=Number(process.env.PORT || 1439);
const assets=resolve('packs/live-chat/widget');
const files=new Set(['frame.html','frame.js','widget.css','theme.css','agent.css','agent-behavior.js','widget-composer.js']);
const host=`<!doctype html><html lang="vi"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Soot widget review</title>
<link rel="stylesheet" href="/public/widget/theme.css"><style>body{margin:0;background:var(--color-bg);color:var(--color-text);font:14px var(--font-sans)}iframe{display:block;width:min(100%,420px);height:calc(100dvh - 48px);margin:auto;border:0}nav{min-height:48px;display:flex;justify-content:center;align-items:center;gap:8px}button{font:inherit;padding:6px 8px;color:var(--color-text);background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-sm)}</style>
<nav><button id="fail">Fail next send</button><button id="nores">Fail next reply</button><button id="slow">Slow reply</button><button id="history">Add history</button><button id="theme">Toggle theme</button></nav>
<iframe title="Soot support" id="widget"></iframe><script>
const frame=document.getElementById('widget'),nonce='local-agent-ui-review';
let messages=[],pending=null,fail=false,noReply=false,slow=false,progress=null,activity='connected',dark=false;
// Question cards and pointers (live-chat-attention v1): ?state=<prototype id>, ?lang=en|vi, ?theme=dark.
const q=new URLSearchParams(location.search),lang=q.get('lang')==='en'?'en':'vi';dark=q.get('theme')==='dark';
let question=null,waiting=null,pointers=[],refusing=false;
const at='2026-10-31T03:04:00Z',plan=[{label:'Cá nhân',description:'1 người, 199.000 đ/tháng'},{label:'Nhóm',description:'tối đa 5 người'},{label:'Doanh nghiệp',description:'SSO, hoá đơn VAT'}];
const ask=resolution=>({id:String(messages.length+1),role:'assistant',intent:'assistant_reply',run:'r_ask',text:'Bạn muốn chuyển sang gói nào?\\n- Cá nhân\\n- Nhóm\\n- Doanh nghiệp',created:at,question:{item:'r_ask',prompt:'Bạn muốn chuyển sang gói nào?',options:plan,multi:false,...(resolution?{resolution}:{})}});
const me=text=>({id:String(messages.length+1),role:'user',text,created:at});
const bot=(text,extra={})=>({id:String(messages.length+1),role:'assistant',text,created:at,...extra});
const ptr=(cls,extra={})=>({item:'p'+pointers.length,class:cls,reply:false,after_message:messages.length,...extra});
const states={
 'widget-open':()=>{messages.push(me('Mình muốn đổi gói'));{const a=ask();messages.push(a);question=a.question;}waiting={on:'asker',reason:'question'};activity='waiting_input';},
 'widget-answered':()=>{messages.push(me('Mình muốn đổi gói'));messages.push(ask({outcome:'answered',labels:['Nhóm'],by:'asker',at}));messages.push(me('Nhóm'));messages.push(bot('Đã chuyển sang gói Nhóm từ kỳ thanh toán tới. Bạn muốn thêm thành viên luôn không?'));activity='completed';},
 'widget-typed':()=>{messages.push(me('Mình muốn đổi gói'));messages.push(ask({outcome:'answered',by:'asker',at}));messages.push(me('gói nào rẻ nhất mà có hoá đơn?'));activity='running';},
 'widget-closed':()=>{messages.push(me('Mình muốn đổi gói'));messages.push(ask({outcome:'closed',by:'team',at}));activity='stopped';},
 'widget-refused':()=>{states['widget-open']();refusing=true;},
 'widget-pointer-approval':()=>{messages.push(me('Hoàn tiền tháng này cho mình được không?'));pointers.push(ptr('approval'));waiting={on:'team',reason:'approval'};activity='waiting_human';},
 'widget-pointer-team':()=>{messages.push(me('Tài khoản mình bị khoá sau khi đổi email'));pointers.push(ptr('team'));messages.push(bot('Chào bạn, mình là Long ở đội hỗ trợ. Mình đã mở khoá tài khoản, bạn đăng nhập lại thử nhé.',{role:'user',actor_role:'member'}));activity='completed';},
 'widget-not-ready':()=>{messages.push(me('Cho mình hỏi về API'));pointers.push(ptr('not_ready'));messages.push(me('alo?'));waiting={on:'team',reason:'not_ready'};activity='queued';},
 'widget-unavailable':()=>{messages.push(me('Cho mình hỏi thêm'));pointers.push(ptr('unavailable'));activity='failed';},
};
states[q.get('state')]?.();
window.fixture={sent:[],draft:'',ready:false};
const config=()=>({name:'Soot',greeting:'Bạn muốn cùng Soot giải quyết việc gì hôm nay?',quick_replies:['Lên kế hoạch cho dự án','Kiểm tra khả năng tiếp cận'],theme:dark?'dark':'light'});
function post(type,extra={}){frame.contentWindow.postMessage({soot_chat:1,type,nonce,...extra},location.origin)}
function sync(extra={}){post('sync',{messages,next_after:messages.length,activity,progress,question:question||undefined,waiting:waiting||undefined,pointers:pointers.map(p=>({item:p.item,class:p.class,reply:p.reply,afterMessage:p.after_message})),pendingAnswer:null,...extra})}
addEventListener('message',e=>{if(e.source!==frame.contentWindow||e.origin!==location.origin||e.data?.soot_chat!==1)return;const m=e.data;
if(m.type==='answer'){window.fixture.answers=(window.fixture.answers||[]).concat([{item:m.item,choices:m.choices}]);const card=messages.find(x=>x.question?.item===m.item);
// The fixture runtime applies the answer, or (state widget-refused) another tab's answer won first.
const labels=refusing?[plan[(m.choices[0]+1)%plan.length].label]:m.choices.map(i=>plan[i].label);card.question={...card.question,resolution:{outcome:'answered',labels,by:'asker',at}};question=null;waiting=null;
if(!refusing){messages.push(me(labels.join(', ')));activity='running';}refusing=false;setTimeout(()=>sync({submission:true,answer:{item:m.item}}),300);}
if(m.type==='ready'){post('init',{language:lang,config:config()});post('open');post('layout',{mobile:innerWidth<700});window.fixture.ready=true;}
if(m.type==='sync')sync(pending?{pendingMessage:pending}:{});
if(m.type==='draft')window.fixture.draft=m.text;
if(m.type==='send'){window.fixture.sent.push(m);if(slow){slow=false;pending=null;const run='r'+messages.length,since=new Date().toISOString();messages.push({id:String(messages.length+1),role:'user',text:m.text,created:since,run});activity='running';
// The phases a real run reports: queued, thinking, two lookups, then the reply being written.
const steps=[['queued',0],['thinking',0],['working',1],['thinking',1],['working',2],['writing',2]];progress={run,phase:'queued',steps:0,since};sync({submission:true});
steps.forEach(([phase,n],i)=>setTimeout(()=>{progress={run,phase,steps:n,since};if(i===1)messages.push({id:String(messages.length+1),role:'assistant',intent:'acknowledgement',text:'Mình đang kiểm tra thông tin, bạn chờ một chút nhé.',created:new Date().toISOString(),run});},1500*i));
setTimeout(()=>{progress=null;activity='completed';messages.push({id:String(messages.length+1),role:'assistant',run,text:'Gói **Pro** là 150.000₫/tháng, gồm 3 luồng dịch song song.',created:new Date().toISOString()});},1500*steps.length+800);}else if(fail){pending={id:m.id,text:m.text};fail=false;sync({submission:true,pendingMessage:pending,error:{kind:'send'}});}else if(noReply){noReply=false;pending=null;const run='r'+messages.length;messages.push({id:String(messages.length+1),role:'user',text:m.text,created:new Date().toISOString(),run},{id:String(messages.length+2),role:'assistant',intent:'acknowledgement',text:'Mình đang kiểm tra, chờ mình một chút nhé.',created:new Date().toISOString(),run});activity='failed';sync({submission:true});}else{pending=null;activity='connected';messages.push({id:String(messages.length+1),role:'user',text:m.text,created:new Date().toISOString()},{id:String(messages.length+2),role:'assistant',text:'Đã nhận yêu cầu. Mình sẽ giữ các bước rõ ràng và báo lại nếu cần bạn quyết định.',created:new Date().toISOString()});sync({submission:true});}}
if(m.type==='reset'){messages=[];pending=null;post('reset-done');}
});
document.getElementById('fail').onclick=()=>{fail=true};
// The next message is answered like a real run: its phases show while it works.
document.getElementById('slow').onclick=()=>{slow=true};
// The run behind the next message ends without a reply: its holding message stays in history and the conversation reads failed.
document.getElementById('nores').onclick=()=>{noReply=true};
document.getElementById('history').onclick=()=>{for(let i=0;i<12;i++)messages.push({id:String(messages.length+1),role:'assistant',text:'Bước '+(i+1)+': Kiểm tra các trạng thái kết nối, lựa chọn và khôi phục bản nháp. Nội dung dài giúp xác nhận rằng người đọc có thể xem lại lịch sử mà không bị kéo xuống cuối.',created:new Date().toISOString()});sync();};
document.getElementById('theme').onclick=()=>{dark=!dark;post('init',{language:lang,config:config()});};
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
