#!/usr/bin/env python3
"""Real installed group -> Soot native delegation -> pool -> publication journey.

Pass explicit binary/archive paths. All accounts, endpoints, stores and processes
are disposable and local; no published platform account is contacted.
"""
import argparse, hashlib, http.server, json, os, secrets, signal, socket, subprocess, tempfile, threading, time, urllib.request, urllib.error
from pathlib import Path


def port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]


def private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False)); path.chmod(0o600)


def request(url, value=None, token=None):
    headers={'Content-Type':'application/json'}
    if token: headers['Authorization']='Bearer '+token
    r=urllib.request.Request(url, data=None if value is None else json.dumps(value).encode(), headers=headers)
    with urllib.request.urlopen(r,timeout=30) as response: return json.load(response)


class Wire(http.server.BaseHTTPRequestHandler):
    calls=[];samples=[]
    def log_message(self,*_): pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        messages=body['messages']; task=None; start=0
        if len(self.samples)<3:self.samples.append(messages)
        for i,m in enumerate(messages):
            if m['role']!='user': continue
            raw=m.get('content','')
            if isinstance(raw,list): raw=''.join(x.get('text','') for x in raw)
            try: candidate=json.JSONDecoder().raw_decode(raw[raw.index('{'):])[0]
            except (ValueError,TypeError): continue
            if isinstance(candidate,dict) and isinstance(candidate.get('text'),str):
                candidate=json.loads(candidate['text'])
            if isinstance(candidate,dict) and ('steps' in candidate or 'calls' in candidate): task=candidate;start=i
        n=sum(1 for m in messages[start+1:] if m['role']=='tool')
        call=None; content='Finished fixture step.\nSTATUS: DONE'
        if str(messages[0].get('content','')).startswith('Distill reusable lessons'): content='{"changes":[]}'
        elif task:
            steps=task.get('steps',task.get('calls',[]))
            if n<len(steps):
                step=steps[n]
                if 'agent' in step: name='spawn_subagent';args={'agent':step['agent'],'task':json.dumps({'calls':step['calls']})}
                else: name=step['tool'];args=step['input']
                call={'index':0,'id':'step-'+str(n),'type':'function','function':{'name':name,'arguments':json.dumps(args)}}
                self.calls.append({'model':body['model'],'tool':name})
        delta={'role':'assistant','tool_calls':[call]} if call else {'role':'assistant','content':content}
        self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
        try:
            for choice in [{'delta':delta,'finish_reason':None},{'delta':{},'finish_reason':'tool_calls' if call else 'stop'}]:
                self.wfile.write(('data: '+json.dumps({'id':'fixture','object':'chat.completion.chunk','model':body['model'],'choices':[{'index':0,**choice}]})+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        except (BrokenPipeError,ConnectionResetError): pass


class Gateway(http.server.BaseHTTPRequestHandler):
    records={};posts=0;reads=0
    def log_message(self,*_):pass
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        key=body['idempotency_key'];assert self.headers['Idempotency-Key']==key
        assert self.headers['Authorization']=='Bearer synthetic-gateway-token-12345'
        if key not in self.records:
            self.posts+=1;type(self).posts+=1
            self.records[key]={'idempotency_key':key,'status':'published','url':'https://fixture.example/posts/'+key,'receipt':'fixture-'+key}
        if body['channel']=='x':
            self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
        self.send_response(200);self.end_headers();self.wfile.write(json.dumps(self.records[key]).encode())
    def do_GET(self):
        type(self).reads+=1
        key=self.path.rsplit('/',1)[-1]
        self.send_response(200 if key in self.records else 404);self.end_headers();self.wfile.write(json.dumps(self.records.get(key,{})).encode())


def main():
    ap=argparse.ArgumentParser();ap.add_argument('--soot',required=True,type=Path);ap.add_argument('--group',required=True,type=Path);ap.add_argument('--meili',required=True,type=Path);ap.add_argument('--evidence',required=True,type=Path);a=ap.parse_args()
    a.soot=a.soot.resolve();a.group=a.group.resolve();a.meili=a.meili.resolve();a.evidence.mkdir(parents=True,exist_ok=True)
    children=[];servers=[];threads=[];cases=[]
    with tempfile.TemporaryDirectory(prefix='marketing-runtime-') as temp:
        root=Path(temp);log=open(a.evidence/'runtime.log','wb');env={**os.environ,'SOOT_HOME':str(root/'home'),'MARKETING_QA_TOKEN':secrets.token_hex(24),'MARKETING_QA_MODEL':'synthetic-model-key'}
        def run(*args,**kwargs):
            result=subprocess.run([str(x) for x in args],cwd=root,env=env,capture_output=True,text=True,timeout=180,**kwargs)
            if result.returncode:raise AssertionError(result.stderr[-3000:]+result.stdout[-1000:])
            return result.stdout
        def boot(*args):
            p=subprocess.Popen([str(x) for x in args],cwd=root,env=env,stdout=log,stderr=log);children.append(p);return p
        def server(cls):
            s=http.server.ThreadingHTTPServer(('127.0.0.1',0),cls);s.daemon_threads=True;t=threading.Thread(target=s.serve_forever);t.start();servers.append(s);threads.append(t);return 'http://127.0.0.1:'+str(s.server_port)
        def ready(url,p):
            until=time.monotonic()+40
            while time.monotonic()<until:
                assert p.poll() is None,'fixture process exited; see runtime.log'
                try:request(url);return
                except (OSError,ValueError):time.sleep(.1)
            raise AssertionError('fixture readiness timeout')
        try:
            provider=server(Wire);gateway=server(Gateway)
            archive_digest=hashlib.sha256(a.group.read_bytes()).hexdigest()
            installed=json.loads(run(a.soot,'group','add',a.group,'--library',root/'groups','--sha256',archive_digest))
            template=Path(installed['directory'])
            again=json.loads(run(a.soot,'group','add',a.group,'--library',root/'groups','--sha256',archive_digest));assert again['sha256']==archive_digest
            private(root/'ai.json',{'providers':{'qa':{'type':'openai','base_url':provider,'key_env':'MARKETING_QA_MODEL'}},'model':{'provider':'qa','name':'qa','stream':True}})
            run(a.soot,'group','create',template,'--name','qa','--output',root/'workspace','--ai-config',root/'ai.json')
            workspace=root/'workspace';pack=workspace/'packs.d'/'data-pool';runner=pack/'bin'/'soot-data-pool';runner.parent.mkdir(exist_ok=True)
            build=subprocess.run(['go','build','-o',str(runner),'.'],cwd=pack/'runner',capture_output=True,text=True,timeout=180);assert build.returncode==0,build.stderr
            cases.append('Verified whole group install is idempotent; explicit creation stays inactive')
            meili_url='http://127.0.0.1:'+str(port());meili=boot(a.meili,'--db-path',root/'meili','--http-addr',meili_url.removeprefix('http://'),'--master-key','synthetic-meili-key-123456789012345','--no-analytics','--log-level','ERROR');ready(meili_url+'/health',meili)
            roles=['qa-radar','qa-creator','qa-editor','qa-manager'];pool_url='http://127.0.0.1:'+str(port())
            private(root/'pool.json',{'endpoint':meili_url,'api_key':'synthetic-meili-key-123456789012345','namespace':'marketing-qa','state_dir':str(root/'pool-state'),'soots':roles,'managers':['qa-manager']})
            run('python3',pack/'operator'/'configure-service.py','--backend-config',root/'pool.json','--service-url',pool_url,'--listen',pool_url.removeprefix('http://'),'--output-dir',root/'pool-service','--writer','qa-radar')
            pool=boot(runner,'serve','--config',root/'pool-service'/'service.json');ready(pool_url+'/healthz',pool)
            def pool_op(actor,action,data):
                binding=(root/'pool-service'/'bindings'/(actor+'.json')).read_text()
                call={'api_version':'soot/v1','hook':'tool.call','soot':actor,'root':actor,'operation':'data-pool_'+action,'input':data}
                result=subprocess.run([str(runner),action],input=json.dumps(call),text=True,env={**env,'DATA_POOL':binding},capture_output=True,timeout=30)
                assert result.returncode==0,result.stderr+result.stdout
                return json.loads(result.stdout)
            pool_op('qa-manager','manage',{'action':'pool_create','pool':'sources','name':'Sources','request_id':'pool'})
            for actor,level in [('qa-radar','write'),('qa-creator','read'),('qa-editor','read')]:pool_op('qa-manager','manage',{'action':'grant','pool':'sources','soot':actor,'level':level,'request_id':'grant-'+actor})
            deployment=json.loads((workspace/'deployment.json').read_text());runtime_url='http://127.0.0.1:'+str(port());deployment.update(listen=runtime_url.removeprefix('http://'),token_env='MARKETING_QA_TOKEN',run_timeout='90s',credentials={})
            ledger=root/'ledger'
            for role in ['coordinator','radar','creator','editor','blog','x']:
                actor='qa-'+role;path=workspace/'soots'/actor/'soot.json';definition=json.loads(path.read_text());definition['model']={'provider':'qa','name':actor};private(path,definition)
                scopes={}
                if role!='radar':
                    host={'soot':actor,'directory':str(ledger)}
                    if role in ['blog','x']:host['channels']={role:{'endpoint':gateway,'destination':'fixture-'+role,'token':'synthetic-gateway-token-12345'}}
                    private(root/'bindings'/(actor+'.json'),host)
                    operations=['marketing_inspect']+({'creator':['marketing_draft'],'editor':['marketing_plan'],'blog':['marketing_publish','marketing_reconcile'],'x':['marketing_publish','marketing_reconcile']}.get(role,[]))
                    scopes['MARKETING_TEAM']={'file':str(root/'bindings'/(actor+'.json')),'operations':operations}
                if role in ['radar','creator','editor']:scopes['DATA_POOL']={'file':str(root/'pool-service'/'bindings'/(actor+'.json')),'operations':['data-pool_pools','data-pool_query','data-pool_status']+(['data-pool_write'] if role=='radar' else [])}
                deployment['credentials'][actor]=scopes
            private(workspace/'deployment.json',deployment)
            run(a.soot,'check','--config',workspace/'deployment.json','--secrets','--json')
            runtime=boot(a.soot,'serve','--config',workspace/'deployment.json');ready(runtime_url+'/readyz',runtime)
            api=lambda path,data=None:request(runtime_url+'/v1'+path,data,env['MARKETING_QA_TOKEN'])
            def journey(label,steps,members):
                conv=api('/conversations',{'id':label,'soot':'qa-coordinator','team':members});cid=conv['id']
                receipt=api('/conversations/'+cid+'/messages',{'id':'request-'+label,'text':json.dumps({'steps':steps})});rid=receipt.get('run',receipt)['id']
                deadline=time.monotonic()+100
                while time.monotonic()<deadline:
                    row=api('/conversations/'+cid+'/runs/'+rid)
                    if row['state'] in ['completed','failed','stopped','blocked']:break
                    time.sleep(.1)
                assert row['state']=='completed',row
                delegations=api('/conversations/'+cid+'/runs/'+rid+'/delegations')['delegations']
                assert len(delegations)==len(steps) and all(d['state']=='completed' for d in delegations),delegations
                return cid,rid
            def step(role,*calls):return {'agent':'qa-'+role,'calls':list(calls)}
            def call(tool,**data):return {'tool':tool,'input':data}
            members=['qa-radar','qa-creator','qa-editor','qa-blog','qa-x']
            source={'pool':'sources','document':'release','revision':1,'url':'https://fixture.example/release'}
            journey('prepare',[
                step('radar',call('data-pool_write',action='upsert',pool='sources',id='release',title='Verified release evidence',content='Soot supports task-specific teams. Fixture source snapshot.',source=source['url'],request_id='release-source')),
                step('creator',call('data-pool_query',action='read',pool='sources',id='release'),call('marketing_draft',id='launch',expected_revision=0,title='A cited team update',body='Soot supports task-specific teams. [Source](https://fixture.example/release)',sources=[source])),
            ],members)
            record=json.loads((ledger/'launch.json').read_text());assert record['revision']==1 and record['sources']==[source]
            cases.append('Native named Radar writes actual shared pool; Creator reads its revision and saves cited draft using independent credentials')
            due='2026-01-01T00:00:00Z'
            for n in [0,1,2]:
                selected=members[:3]+members[3:3+n];entries=[{'publisher':'qa-'+channel,'channel':channel,'at':due,'timezone':'Asia/Ho_Chi_Minh'} for channel in ['blog','x'][:n]]
                journey('plan-'+str(n),[step('editor',call('marketing_plan',id='launch',expected_revision=1,expected_plan_revision=json.loads((ledger/'launch.json').read_text()).get('plan_revision',0),entries=entries))],selected)
                assert len(json.loads((ledger/'launch.json').read_text())['plan'])==n
            cases.append('Editor plans 0/1/2 publisher channels against actual session roster; plans never claim a scheduled job')
            for channel in ['blog','x']:
                private(root/('approval-'+channel+'.json'),{'id':'launch','revision':1,'plan_revision':json.loads((ledger/'launch.json').read_text())['plan_revision'],'hash':record['hash'],'channel':channel})
                approved=subprocess.run(['node',str(workspace/'packs.d'/'marketing'/'tools'/'marketing.mjs'),'approve',str(root/('approval-'+channel+'.json'))],env={**env,'MARKETING_TEAM':(root/'bindings'/('qa-'+channel+'.json')).read_text()},capture_output=True,text=True,timeout=15)
                assert approved.returncode==0,approved.stderr
            journey('publish',[step('blog',call('marketing_publish',id='launch',expected_revision=1,channel='blog')),step('x',call('marketing_publish',id='launch',expected_revision=1,channel='x'))],members)
            states={p['channel']:p['status'] for p in json.loads((ledger/'launch.json').read_text())['publications'].values()};assert states=={'blog':'published','x':'uncertain'},states
            assert Gateway.posts==2,Gateway.posts
            journey('recover',[step('x',call('marketing_reconcile',id='launch',expected_revision=1,channel='x')),step('blog',call('marketing_publish',id='launch',expected_revision=1,channel='blog'))],members)
            assert Gateway.posts==2 and Gateway.reads==1
            assert all(p['status']=='published' for p in json.loads((ledger/'launch.json').read_text())['publications'].values())
            cases.append('Real executable publishers: approved Blog succeeds, X loses committed response, GET reconciles original key; no duplicate POST')
            (a.evidence/'provider-calls.json').write_text(json.dumps(Wire.calls,indent=2))
            (a.evidence/'result.json').write_text(json.dumps({'cases':cases,'posts':Gateway.posts,'reconciliations':Gateway.reads,'source':'deterministic supplied source snapshot; no live X crawl','group_sha256':archive_digest},indent=2))
            print(json.dumps({'status':'PASS','cases':cases},indent=2))
        finally:
            (a.evidence/'provider-debug.json').write_text(json.dumps(Wire.samples,ensure_ascii=False,indent=2))
            for p in reversed(children):
                if p.poll() is None:
                    p.send_signal(signal.SIGTERM)
                    try:p.wait(timeout=12)
                    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
            for s in servers:s.shutdown();s.server_close()
            for t in threads:t.join(timeout=5)
            log.close()
            print('CLEANUP: all owned runtime, pool, search and fixture servers stopped')

if __name__=='__main__':main()
