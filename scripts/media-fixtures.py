"""Portable live-test fixture setup. Contains synthetic data and synthetic tone.

No pack imports: Office artifacts must be authored by the real Soot tools.
"""
import io
import json
import math
from pathlib import Path
import shutil
import struct
import sys
import wave
from PIL import Image, ImageDraw, ImageFont

root = Path(sys.argv[1])
fonts = [Path('/System/Library/Fonts/Supplemental/Arial.ttf'), Path('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')]
font = next((f for f in fonts if f.is_file()), None)
if font is None:
    raise SystemExit('Local TrueType font required for Vietnamese fixtures')
def spec(name, data):
    (root/name).write_text(json.dumps(data, ensure_ascii=False, indent=2))

if '--narrated' in sys.argv[2:]:
    with wave.open(str(root/'narration.wav')) as wav:
        duration = wav.getnframes()/wav.getframerate()
    if duration < 2.6:
        raise SystemExit('Live narration is unexpectedly short; inspect before captioning')
    spec('narrated-timeline.json', {'width':360,'height':640,'fps':24,
        'clips':[{'path':'frame.png','duration':math.ceil((duration+.2)*24)/24,'zoom_end':1.1}],
        'audio':[{'path':'narration.wav','role':'voice','start':0,'gain':1}],
        'font':'font.ttf','caption_size':22,
        'captions':[{'start':.05,'end':.95,'text':'Xin chào Việt Nam.','timing':'manual'},
            {'start':.95,'end':duration,'text':'Soot giúp bạn làm việc với tài liệu và video.','timing':'manual'}]})
    raise SystemExit(0)

shutil.copyfile(font, root / 'font.ttf')
spec('word.json', {'title':'Báo cáo Soot Forge','blocks':[
    {'kind':'heading','text':'Báo cáo tiếng Việt','level':1},
    {'kind':'paragraph','runs':[{'text':'Ngân sách: ','bold':True},{'text':'1.650.000 đồng'}]},
    {'kind':'table','rows':[['Hạng mục','Chi phí'],['Máy chủ','1.200.000 đồng'],['Âm thanh','450.000 đồng']]}]})
spec('excel.json', {'sheets':[{'name':'Chi phí','freeze':'A2','widths':{'A':24,'B':18},'table':True,
    'rows':[['Hạng mục','VND'],['Máy chủ',1200000],['Âm thanh',450000],['Tổng',{'formula':'=SUM(B2:B3)'}]]}]})
spec('slides.json', {'slides':[{'title':'Soot Forge','bullets':['Office và PDF','OCR theo nhu cầu','Giọng đọc OmniVoice'],
                              'notes':'Tổng ngân sách kiểm thử: 1.650.000 đồng.'}]})
spec('pdf.json', {'title':'Báo cáo','font':'font.ttf','blocks':[
    {'kind':'heading','text':'Báo cáo Soot Forge'},
    {'kind':'paragraph','text':'Tổng ngân sách: 1.650.000 đồng. Tài liệu, giọng đọc và video tiếng Việt.'}]})
scan = Image.new('RGB',(900,300),'white')
draw = ImageDraw.Draw(scan); large = ImageFont.truetype(str(root/'font.ttf'),42)
draw.text((40,45),'Báo cáo Soot Forge',font=large,fill='black')
draw.text((40,135),'Tổng ngân sách: 1.650.000 đồng.',font=large,fill='black')
scan.save(root/'scan.png')
frame = Image.new('RGB',(360,640),(24,30,40));draw=ImageDraw.Draw(frame)
draw.rounded_rectangle((32,90,310,425),radius=18,fill=(242,211,93))
draw.text((52,120),'SOOT FORGE',font=ImageFont.truetype(str(root/'font.ttf'),28),fill=(20,24,30))
draw.text((52,185),'Office / PDF',font=ImageFont.truetype(str(root/'font.ttf'),24),fill=(20,24,30))
draw.text((52,235),'Voice / Video',font=ImageFont.truetype(str(root/'font.ttf'),24),fill=(20,24,30))
frame.save(root/'frame.png')
with wave.open(str(root/'fixture.wav'),'wb') as wav:
    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(24000)
    wav.writeframes(b''.join(struct.pack('<h',round(3000*math.sin(2*math.pi*440*i/24000))) for i in range(24000)))
timeline = {'width':360,'height':640,'fps':24,
    'clips':[{'path':'frame.png','duration':.6,'zoom_end':1.08},{'path':'frame.png','duration':.6,'fade_out':.1}],
    'audio':[{'path':'fixture.wav','role':'sfx','start':.05,'gain':.8}],
    'font':'font.ttf','caption_size':24,
    'captions':[{'start':.1,'end':1.05,'text':'Xin chào Việt Nam','timing':'manual'}]}
spec('timeline.json',timeline)
timeline['captions'][0]['text']='{\\pos(1,1)}'+'X'*100
spec('invalid-timeline.json',timeline)
