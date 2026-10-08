"""Deterministic Soot v3 sprite assembly. No generated or interpolated poses."""
import hashlib
from statistics import median
from PIL import Image, ImageChops

CELL = (192, 208)

def transparent_cut(projection, nominal, radius):
    # Generation supplies art, not exact grid geometry. Find the real clear
    # gutter near the guide boundary before cutting (especially wide props).
    gaps = []
    start = None
    for index in range(max(1, nominal - radius), min(len(projection) - 1, nominal + radius)):
        if not projection[index] and start is None:
            start = index
        elif projection[index] and start is not None:
            gaps.append((start, index))
            start = None
    if start is not None:
        gaps.append((start, min(len(projection) - 1, nominal + radius)))
    gaps = [(a, b) for a, b in gaps if b - a >= 2]
    if not gaps:
        raise ValueError(f'No transparent gutter near {nominal}; inspect overlap')
    left, right = min(gaps, key=lambda gap: abs(sum(gap) / 2 - nominal))
    return (left + right) // 2

def pixels(image):
    return image.get_flattened_data() if hasattr(image, 'get_flattened_data') else image.getdata()

def clean_rgba(image):
    image.putdata([(0, 0, 0, 0) if a == 0 else (r, g, b, a) for r, g, b, a in pixels(image)])
    return image

cut = transparent_cut
clean = clean_rgba

def extract(path):
    image = Image.open(path)
    if image.size != (1536, 1024):
        raise ValueError(f'{path}: expected 1536x1024 source; got {image.size}')
    if image.format != 'PNG' or 'A' not in image.getbands():
        raise ValueError(f'{path}: expected PNG with real alpha')
    image = image.convert('RGBA')
    mask = image.getchannel('A').point(lambda a: 255 if a > 16 else 0)
    row_bounds = [0, *[cut(mask.getprojection()[1], round(y*image.height/3), 34) for y in (1,2)], image.height]
    frames = []
    for row in range(3):
        projection = mask.crop((0,row_bounds[row],image.width,row_bounds[row+1])).getprojection()[0]
        columns = [0, *[cut(projection, col*384, 45) for col in (1,2,3)], image.width]
        for col in range(4):
            frame = image.crop((columns[col],row_bounds[row],columns[col+1],row_bounds[row+1]))
            alpha = frame.getchannel('A')
            box = alpha.point(lambda a: 255 if a > 16 else 0).getbbox()
            if not box or min(box[0],box[1],frame.width-box[2],frame.height-box[3]) < 1:
                raise ValueError(f'{path}: empty/clipped frame {row*4+col+1}')
            frame.putalpha(alpha.point(lambda a: 0 if a <= 8 else a))
            bounds = frame.getchannel('A').getbbox()
            feet = frame.getchannel('A').crop((0,bounds[3]-28,frame.width,bounds[3])).getbbox()
            frames.append((frame, ((feet[0]+feet[2])/2,bounds[3])))
    return frames


def build(source, variant, states, durations, output, previews, orders=None):
    folder=output/variant
    folder.mkdir(exist_ok=True)
    rows = {state:extract(source/variant/f'{state}.png') for state in states}
    orders=orders or {}
    for state in states:
        order=orders.get(f'{variant}-{state}',list(range(12)))
        if (not isinstance(order, list) or any(type(index) is not int for index in order)
                or sorted(order)!=list(range(12))):
            raise ValueError(f'{variant}/{state}: order must retain all twelve unique source cels')
        if state != 'sleeping' and order[4:7] != [4,5,6]:
            raise ValueError(f'{variant}/{state}: preserve blink cels in slots 5–7')
        rows[state]=[rows[state][index] for index in order]
    heights = {state:median(frame.getchannel('A').getbbox()[3]-frame.getchannel('A').getbbox()[1]
                            for frame,_ in row) for state,row in rows.items()}
    # Independent generations can change the camera scale between states.
    # Register an entire row once to idle; never fit individual animation frames.
    registration = {state:heights['idle']/height for state,height in heights.items()}
    # Foot anchors prevent a waving hand from dragging the whole body sideways.
    extents = []
    for state,row in rows.items():
        for frame, (x,y) in row:
            a,b,c,d = frame.getchannel('A').getbbox()
            extents.append((max(x-a,c-x)*registration[state],(y-b)*registration[state]))
    scale = min((CELL[0]/2-8)/max(e[0] for e in extents),(CELL[1]-18)/max(e[1] for e in extents))
    atlas = Image.new('RGBA',(CELL[0]*12,CELL[1]*len(states)))
    review = []
    for row_index,state in enumerate(states):
        rendered = []
        contact = Image.new('RGBA',(CELL[0]*4,CELL[1]*3))
        row_scale=scale*registration[state]
        for index,(frame,(x,y)) in enumerate(rows[state]):
            sprite = frame.resize((round(frame.width*row_scale),round(frame.height*row_scale)),Image.Resampling.LANCZOS)
            tile = Image.new('RGBA',CELL)
            tile.alpha_composite(sprite,(round(CELL[0]/2-x*row_scale),round(CELL[1]-10-y*row_scale)))
            clean(tile)
            atlas.alpha_composite(tile,(index*CELL[0],row_index*CELL[1]))
            contact.alpha_composite(tile,((index%4)*CELL[0],(index//4)*CELL[1]))
            rendered.append(tile)
        if len({hashlib.sha256(frame.tobytes()).hexdigest() for frame in rendered}) < 12:
            raise ValueError(f'{variant}/{state}: insufficient distinct generated frames')
        contact.save(previews/f'{variant}-{state}-contact.png')
        clean(contact).save(folder/f'{state}.webp',lossless=True,exact=True,method=4)
        rendered[0].save(previews/f'{variant}-{state}.webp',save_all=True,append_images=rendered[1:],
                         duration=durations[state],loop=0,lossless=True,exact=True,method=4)
        changes = [sum(v>12 for v in pixels(ImageChops.difference(a,b).convert('RGB').convert('L')))
                   for a,b in zip(rendered,rendered[1:]+rendered[:1])]
        review.append({'state':state,'frames':12,'rowRegistrationScale':registration[state],'adjacentChangedPixels':changes,
                       'sourceFrameOrder':orders.get(f'{variant}-{state}',list(range(12))),
                       'sourceSha256':hashlib.sha256((source/variant/f'{state}.png').read_bytes()).hexdigest()})
    file=folder/'spritesheet.webp'
    clean(atlas).save(file,lossless=True,exact=True,method=4)
    decoded=Image.open(file).convert('RGBA')
    if decoded.size != atlas.size or any(a==0 and (r or g or b) for r,g,b,a in pixels(decoded)):
        raise ValueError(f'{variant}: encoded atlas geometry/alpha normalization failed')
    atlas.save(previews/f'{variant}-contact.png')
    return {'id':variant,'rows':review,'scale':scale,'bytes':file.stat().st_size,
            'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
