import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {sendInput,textEvents} from './input.mjs';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

// A real loopback WebSocket peer, including clean/abrupt transport shutdown.
async function fixture(run,{abrupt=false}={}) {
 const received=[],sockets=new Set();const server=createServer();
 server.on('upgrade',(req,socket)=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  const tabs=Buffer.from(JSON.stringify({type:'tabs',tabs:[{tabId:'t1',active:true}]}));socket.write(Buffer.concat([Buffer.from([0x81,tabs.length]),tabs]));
  let buffer=Buffer.alloc(0);
  socket.on('data',chunk=>{
   buffer=Buffer.concat([buffer,chunk]);
   while(buffer.length>=2){
    const opcode=buffer[0]&15,masked=!!(buffer[1]&128);let length=buffer[1]&127,offset=2;
    if(length===126){if(buffer.length<4)return;length=buffer.readUInt16BE(2);offset=4;}
    assert.notEqual(length,127);if(buffer.length<offset+(masked?4:0)+length)return;
    const mask=buffer.subarray(offset,offset+4);offset+=masked?4:0;
    const payload=Buffer.from(buffer.subarray(offset,offset+length));if(masked)for(let i=0;i<length;i++)payload[i]^=mask[i%4];buffer=buffer.subarray(offset+length);
    if(opcode===9){socket.write(Buffer.concat([Buffer.from([0x8a,payload.length]),payload]));continue;}
    if(opcode===8){socket.end(Buffer.from([0x88,0]));return;}
    if(opcode===1){received.push(JSON.parse(payload));if(abrupt){socket.destroy();return;}}
   }
  });
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{await run(`ws://127.0.0.1:${server.address().port}`,received);}
 finally{for(const socket of sockets)socket.destroy();await new Promise(r=>server.close(r));}
}
test('input waits for the intended tab and completes an ordered ping/pong confirmation',()=>fixture(async(url,received)=>{
 const events=[{type:'input_keyboard',eventType:'char',text:'Xin chào'},{type:'input_keyboard',eventType:'keyDown',key:'Enter'}];
 await sendInput(url,events,'t1');assert.deepEqual(received,events);
}));
test('changed tab fails before dispatch with no uncertain effect',()=>fixture(async(url,received)=>{
 await assert.rejects(sendInput(url,[{type:'input_keyboard',text:'wrong tab'}],'t2'),error=>/Tab changed/.test(error.message)&&error.uncertain===false);
 assert.equal(received.length,0);
}));
test('disconnect after send is uncertain and never replays input',()=>fixture(async(url,received)=>{
 await assert.rejects(sendInput(url,[{type:'input_keyboard',text:'once'}],'t1'),error=>error.uncertain===true);
 assert.equal(received.length,1);
},{abrupt:true}));

test('pasted/coalesced Unicode is split below the CDP key text limit without breaking surrogate pairs',()=>{
 const text='Nhập tiếng Việt 😀 e\u0301\n'+'x'.repeat(800);
 const events=textEvents(text);assert.equal(events.map(e=>e.text).join(''),text);
 assert.ok(events.every(e=>Array.from(e.text).length===1&&e.text.length<=2));
 assert.deepEqual(events.find(e=>e.text==='😀'),{type:'input_keyboard',eventType:'char',text:'😀'});
});

test('real soot/v1 executable sends all Unicode input through the bounded transport',()=>fixture(async(url,received)=>{
 const root=await mkdtemp(join(tmpdir(),'browser-input-exec-'));
 try {
  const state=join(root,'.browser/sessions/fixture');await mkdir(state,{recursive:true});
  await writeFile(join(state,'stream.json'),JSON.stringify({url}));
  const text='Nhập tiếng Việt 😀 e\u0301';
  const child=promisify(execFile)(process.execPath,[fileURLToPath(new URL('./browser.mjs',import.meta.url)),'control'],{cwd:root,timeout:5000,maxBuffer:32768});
  child.child.stdin.end(JSON.stringify({api_version:'soot/v1',hook:'tool.call',soot:'fixture',operation:'browser-use_control',interaction:true,event:{source:'conversation',subject:'fixture'},input:{action:'text',text,tab:'t1'}}));
  const result=JSON.parse((await child).stdout);assert.equal(result.result.accepted,true);
  assert.equal(received.map(e=>e.text).join(''),text);assert.equal(received.length,Array.from(text).length);
 }finally{await rm(root,{recursive:true,force:true});}
}));
