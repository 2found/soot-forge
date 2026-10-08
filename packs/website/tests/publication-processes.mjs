// Bounded child-process helpers for synthetic publication fixtures only.
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
async function cleanup(children) {
  await Promise.all(children.map(child=>new Promise(resolve=>{
    if(child.exitCode!==null||child.signalCode!==null)return resolve();
    const timer=setTimeout(resolve,1000);
    child.once('exit',()=>{clearTimeout(timer);resolve();}); child.kill('SIGKILL');
  })));
}
export async function killedBeforeCommit(moduleURL,directory,value) {
  const action=value===undefined?`preparePublication(${JSON.stringify(directory)},stop)`:`publishPublication(${JSON.stringify(directory)},${JSON.stringify(value)},stop)`;
  const code=`import {writeSync} from 'node:fs';import {preparePublication,publishPublication} from ${JSON.stringify(moduleURL)};const stop=()=>{writeSync(1,'fixture-before-commit\\n');process.kill(process.pid,'SIGKILL');};${action};`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{},stdio:['ignore','pipe','pipe']});
  let marker='',timer;
  child.stdout.on('data',chunk=>marker+=chunk);
  try {
    await new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(new Error('Fixture kill check exceeded 5 seconds')),5000);
      child.once('error',reject);
      child.once('exit',(_code,signal)=>{try{assert.equal(signal,'SIGKILL');assert.ok(marker.includes('fixture-before-commit'));resolve();}catch(error){reject(error);}});
    });
  }finally{clearTimeout(timer);await cleanup([child]);}
}
export async function racePublications(moduleURL,directory,values) {
  const children=values.map(value=>spawn(process.execPath,['--input-type=module','-e',`import {publishPublication} from ${JSON.stringify(moduleURL)};process.send('ready');process.once('message',()=>{console.log(JSON.stringify(publishPublication(${JSON.stringify(directory)},${JSON.stringify(value)})));process.disconnect();});`],{env:{},stdio:['ignore','pipe','pipe','ipc']}));
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Fixture race exceeded 10 seconds')),10000);});
  const completed=Promise.all(children.map(child=>new Promise((resolve,reject)=>{
    let out='',err='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>err+=chunk);
    child.once('error',reject);child.once('exit',code=>{try{if(code!==0)throw new Error(err);resolve(JSON.parse(out));}catch(error){reject(error);}});
  })));
  completed.catch(()=>{});
  try {
    const ready=Promise.all(children.map(child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('Fixture child exited before release')));})));
    await Promise.race([ready,deadline]);children.forEach(child=>child.send('go'));
    return await Promise.race([completed,deadline]);
  }finally{clearTimeout(timer);await cleanup(children);}
}
