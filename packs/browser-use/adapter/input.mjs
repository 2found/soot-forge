// CDP dispatchKeyEvent has a short text limit. Unicode code points preserve
// surrogate pairs and let pasted/coalesced text reach the page in order.
export const textEvents=text=>Array.from(text,text=>({type:'input_keyboard',eventType:'char',text}));

// Human assistance uses the existing browser input transport, independently of
// an agent's long wait. Pong confirms prior messages reached the receiver;
// this is never proof that a site business action succeeded.
export async function sendInput(url, events, tab) {
  const {default:WebSocket}=await import('ws');
  return new Promise((resolve,reject)=>{
    const socket=new WebSocket(url,{perMessageDeflate:false,maxPayload:3*1024*1024});
    const nonce=crypto.randomUUID();
    let sent=false,settled=false;
    const finish=error=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){error.uncertain=sent;reject(error);}else resolve();
      socket.terminate();
    };
    const timer=setTimeout(()=>finish(Error('Input transport timed out')),3000);
    const dispatch=()=>{
      if(sent||settled)return;
      try {
        sent=true;
        for(const event of events)socket.send(JSON.stringify(event));
        // The peer reads the ping after the input messages on this connection.
        // agent-browser does not flush a close reply; use its automatic Pong
        // instead. Never turn a timeout into success or replay the input.
        socket.ping(nonce);
      }catch(error){finish(error);}
    };
    socket.on('open',()=>{if(!tab)dispatch();});
    socket.on('pong',data=>{if(sent&&data.toString()===nonce)finish();});
    socket.on('message',(data,isBinary)=>{
      if(sent||settled||!tab)return;
      try {
        if(isBinary||data.length>3*1024*1024)throw Error('Invalid input transport message');
        const message=JSON.parse(data.toString());
        if(message.type!=='tabs')return;
        if(!Array.isArray(message.tabs)||message.tabs.find(t=>t.active)?.tabId!==tab)throw Error('Tab changed before input; inspect the current page');
        dispatch();
      }catch(error){finish(error);}
    });
    socket.on('close',()=>finish(Error('Input transport disconnected')));
    socket.on('error',()=>finish(Error('Input transport disconnected')));
  });
}
