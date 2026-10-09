#!/usr/bin/env python3
"""Explicit real-model generation via the pack envelope, with host measurements."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=Path,required=True,help='New evidence directory')
parser.add_argument('--binding-file',type=Path,required=True)
parser.add_argument('--size',type=int,default=512,choices=[256,384,512])
args=parser.parse_args()
root=args.output.resolve();root.mkdir()
repo=Path(__file__).resolve().parent.parent
binding=args.binding_file.read_text()
env={'FILE_ROOT':str(root),'PYTHON_EXECUTABLE':sys.executable,'IMAGE_GEN_BINDING':binding}


def snapshot():
    results={}
    if sys.platform=='darwin':
        for key,cmd in [('swap',['/usr/sbin/sysctl','vm.swapusage']),
                        ('memory_pressure',['/usr/bin/memory_pressure','-Q'])]:
            result=subprocess.run(cmd,capture_output=True,text=True,timeout=15)
            results[key]=result.stdout.strip()
    return results


call={'api_version':'soot/v1','hook':'tool.call','soot':'image-gen-qa','operation':'image-gen_generate',
      'input':{'prompt':'A red ceramic teapot on a wooden table, soft window daylight, simple studio photograph, no text.',
               'output':'teapot.png','width':args.size,'height':args.size,'seed':42}}
report={'status':'FAIL','request':call,'before':snapshot(),
        'host_profile':{k:v for k,v in json.loads(binding).items() if k in ('backend','max_pixels','max_vram_gib','max_ram_gib','timeout_sec')}}
(root/'request.json').write_text(json.dumps(call,indent=2)+'\n')
try:
    cmd=[str(repo/'packs/image-gen/tools/run'),'generate']
    if sys.platform=='darwin':cmd=['/usr/bin/time','-l',*cmd]
    result=subprocess.run(cmd,input=json.dumps(call),capture_output=True,text=True,env=env,timeout=1800)
    (root/'stdout.json').write_text(result.stdout)
    (root/'stderr.log').write_text(result.stderr)
    report['exit_code']=result.returncode
    report['after']=snapshot()
    for key,pattern in [('maximum_rss_bytes',r'(\d+)\s+maximum resident set size'),
                        ('peak_footprint_bytes',r'(\d+)\s+peak memory footprint')]:
        match=re.search(pattern,result.stderr)
        if match:report[key]=int(match[1])
    assert result.returncode==0, 'Real inference failed; inspect stderr.log and the native runtime'
    receipt=json.loads(result.stdout)
    from PIL import Image,ImageStat
    import hashlib
    image=root/'teapot.png'
    with Image.open(image) as im:
        im.load();assert im.size==(args.size,args.size)
        assert max(ImageStat.Stat(im.convert('RGB')).stddev)>10, 'Output is blank/flat'
    assert hashlib.sha256(image.read_bytes()).hexdigest()==receipt['sha256']
    assert receipt['quantization']=='Q4_K_M' and receipt['steps']==8
    report['receipt']=receipt
    report['status']='PASS: actual inference; visual prompt review pending'
finally:
    (root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
