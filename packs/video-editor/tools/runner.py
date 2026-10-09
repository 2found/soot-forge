"""FFmpeg editor with bounded timelines, captions and decoded-frame evidence."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
import math
import shutil
import subprocess
import tempfile
import selectors
import signal
import time


MEDIA = {".mp4", ".mov", ".mkv", ".webm", ".wav", ".mp3", ".m4a", ".png", ".jpg", ".jpeg"}
IMAGES = {".png", ".jpg", ".jpeg"}


def binaries():
    cfg = binding("VIDEO_BINDING")
    for key in ("ffmpeg", "ffprobe"):
        p = Path(cfg.get(key, ""))
        require(p.is_absolute() and p.is_file() and os.access(p, os.X_OK), f"host must bind absolute executable {key}")
    return cfg


def command(args, timeout=300, cwd=None, extra_env=None, allowed_codes=(0,)):
    # Bound output while reading. Discard unused stderr; terminate the whole
    # process group on timeout/overflow, including CLI browser/FFmpeg children.
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                          stdin=subprocess.DEVNULL, cwd=cwd, start_new_session=True,
                          env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", **(extra_env or {})}) as process:
        chunks, size, deadline, completed = [], 0, time.monotonic() + timeout, False
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while selector.get_map():
                    remaining = deadline - time.monotonic()
                    require(remaining > 0, "media command timed out; inspect the project before retrying")
                    for key, _ in selector.select(remaining):
                        block = os.read(key.fd, 65536)
                        if not block:
                            selector.unregister(key.fileobj)
                            continue
                        size += len(block)
                        require(size <= 2*1024*1024, "command output too large")
                        chunks.append(block)
            process.wait(timeout=max(.01, deadline-time.monotonic()))
            require(process.returncode in allowed_codes, "media command failed; verify codec, assets, font and timing")
            completed = True
            return b"".join(chunks)
        except subprocess.TimeoutExpired:
            raise ToolError("media command timed out; inspect the project before retrying") from None
        finally:
            # Also clean descendant processes holding a pipe after their parent
            # exited, or left behind by an unsuccessful invocation.
            if not completed:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()


def probe_file(p, cfg):
    raw = command([cfg["ffprobe"], "-v", "error", "-protocol_whitelist", "file,pipe", "-show_format",
                   "-show_streams", "-of", "json", str(p)], timeout=30)
    data = json.loads(raw)
    streams = data.get("streams", [])
    require(isinstance(streams, list) and len(streams) <= 100, "invalid media streams")
    videos = [s for s in streams if s.get("codec_type") == "video"]
    audios = [s for s in streams if s.get("codec_type") == "audio"]
    duration = data.get("format", {}).get("duration")
    duration = number(float(duration), "measured duration", 0, 86400*7) if duration is not None else None
    for stream in videos:
        width = integer(stream.get("width"), "source width", 1, 32768)
        height = integer(stream.get("height"), "source height", 1, 32768)
        require(width*height <= 64_000_000, "source picture exceeds pixel limit")
    return {"duration": duration,
            "video": [{k: s.get(k) for k in ("codec_name", "width", "height", "avg_frame_rate", "nb_frames", "pix_fmt")}
                      for s in videos],
            "audio": [{k: s.get(k) for k in ("codec_name", "sample_rate", "channels")} for s in audios]}


def probe(args):
    fields(args, ("path",), ("path",))
    p = path(args["path"], suffixes=MEDIA, max_bytes=512*1024*1024)
    return {"file": receipt(p), **probe_file(p, binaries())}


def timeline(args):
    fields(args, ("spec", "output"), ("spec",))
    p = path(args["spec"], suffixes={".json"}, max_bytes=2*1024*1024)
    value = json.loads(p.read_text())
    fields(value, ("width", "height", "fps", "clips", "audio", "captions", "font", "safe_area", "caption_size"),
           ("clips",))
    width = integer(value.get("width", 1080), "width", 128, 3840)
    height = integer(value.get("height", 1920), "height", 128, 3840)
    require(width % 2 == 0 and height % 2 == 0, "H.264 dimensions must be even")
    fps = integer(value.get("fps", 30), "fps", 12, 60)
    clips = value["clips"]
    require(isinstance(clips, list) and 0 < len(clips) <= 100, "timeline needs 1..100 clips")
    cfg = binaries()
    probed = {}
    def measured(file):
        info = file.stat()
        key = (file, info.st_size, info.st_mtime_ns)
        if key not in probed:
            probed[key] = probe_file(file, cfg)
        return probed[key]
    cursor = 0
    prepared = []
    for clip in clips:
        fields(clip, ("path", "duration", "source_start", "fit", "zoom_start", "zoom_end", "fade_in", "fade_out"),
               ("path", "duration"))
        file = path(clip["path"], suffixes=MEDIA - {".wav", ".mp3", ".m4a"}, max_bytes=512*1024*1024)
        duration = number(clip["duration"], "clip duration", .1, 600)
        frames = max(1, round(duration*fps))
        duration = frames / fps
        start = number(clip.get("source_start", 0), "source start", 0, 86400)
        require(clip.get("fit", "cover") in ("cover", "contain"), "fit must be cover or contain")
        zoom_start = number(clip.get("zoom_start", 1), "zoom_start", 1, 1.5)
        zoom_end = number(clip.get("zoom_end", 1), "zoom_end", 1, 1.5)
        fade_in = number(clip.get("fade_in", 0), "fade_in", 0, duration/2)
        fade_out = number(clip.get("fade_out", 0), "fade_out", 0, duration/2)
        media = measured(file)
        require(media["video"], "clip must contain picture")
        require(file.suffix.lower() in IMAGES or (media["duration"] is not None and start+duration <= media["duration"]+.04),
                "clip source range exceeds measured media duration")
        require(file.suffix.lower() in IMAGES or (zoom_start == 1 and zoom_end == 1), "zoom is supported on still images; use HyperFrames for video camera moves")
        prepared.append({**clip, "file": file, "start": cursor, "duration": duration, "frames": frames,
                         "source_start": start, "zoom_start": zoom_start, "zoom_end": zoom_end,
                         "fade_in": fade_in, "fade_out": fade_out})
        cursor += duration
    require(cursor <= 600, "timeline limited to 10 minutes; split longer projects")
    audios = value.get("audio", [])
    require(isinstance(audios, list) and len(audios) <= 30, "audio needs at most 30 tracks")
    prepared_audio = []
    for track in audios:
        fields(track, ("path", "start", "source_start", "duration", "gain", "role", "fade_in", "fade_out"), ("path", "role"))
        require(track["role"] in ("voice", "music", "sfx"), "invalid audio role")
        file = path(track["path"], suffixes=MEDIA-IMAGES, max_bytes=512*1024*1024)
        media = measured(file)
        require(media["audio"] and media["duration"] is not None, "audio track has no measurable audio")
        start = number(track.get("start", 0), "track start", 0, cursor)
        source_start = number(track.get("source_start", 0), "audio source start", 0, media["duration"])
        duration = number(track.get("duration", min(media["duration"]-source_start, cursor-start)), "audio duration", .01, cursor-start)
        require(source_start+duration <= media["duration"]+.01, "audio range exceeds measured recording")
        prepared_audio.append({**track, "file": file, "start": start, "source_start": source_start,
                               "duration": duration, "gain": number(track.get("gain", 1), "gain", 0, 2),
                               "fade_in": number(track.get("fade_in", 0), "fade_in", 0, duration/2),
                               "fade_out": number(track.get("fade_out", 0), "fade_out", 0, duration/2)})
    captions = value.get("captions", [])
    require(isinstance(captions, list) and len(captions) <= 1000, "too many captions")
    previous = 0
    for caption in captions:
        fields(caption, ("start", "end", "text", "timing"), ("start", "end", "text", "timing"))
        start = number(caption["start"], "caption start", previous, cursor)
        end = number(caption["end"], "caption end", start+.01, cursor)
        previous = end
        string(caption["text"], "caption text", 240)
        require(caption["timing"] in ("manual", "aligned"), "captions require manual or acoustic alignment, not proportional estimates")
        require("{" not in caption["text"] and "}" not in caption["text"] and "\\" not in caption["text"],
                "caption text cannot contain ASS directives")
    font = path(value["font"], suffixes={".ttf", ".otf"}) if captions else None
    size = integer(value.get("caption_size", max(18, round(height*.029))), "caption size", 12, 120)
    safe = value.get("safe_area", {"top": .125, "bottom": .1771, "left": .0593, "right": .1296})
    fields(safe, ("top", "bottom", "left", "right"), ("top", "bottom", "left", "right"))
    for edge in safe:
        number(safe[edge], "safe area", 0, .4)
    require(safe["left"]+safe["right"] < .7 and safe["top"]+safe["bottom"] < .7, "safe rectangle too small")
    return {"width": width, "height": height, "fps": fps, "duration": cursor, "clips": prepared,
            "audio": prepared_audio, "captions": captions, "font": font, "caption_size": size,
            "safe_area": safe, "cfg": cfg, "spec_sha256": digest(p)}


def validate(args):
    fields(args, ("spec",), ("spec",))
    data = timeline(args)
    layout = caption_layout(data) if data["captions"] else []
    return {"valid": True, "duration": data["duration"], "width": data["width"], "height": data["height"],
            "fps": data["fps"], "clips": len(data["clips"]), "audio_tracks": len(data["audio"]),
            "caption_boxes": [row["box"] for row in layout], "spec_sha256": data["spec_sha256"],
            "review": "structural and local caption bounds only; creative review and final playback pending"}


def caption_layout(data):
    from PIL import ImageFont
    font = ImageFont.truetype(str(data["font"]), data["caption_size"])
    w, h, safe = data["width"], data["height"], data["safe_area"]
    left, right = math.ceil(w*safe["left"])+12, math.floor(w*(1-safe["right"]))-12
    top, bottom = math.ceil(h*safe["top"])+12, math.floor(h*(1-safe["bottom"]))-12
    result = []
    for caption in data["captions"]:
        lines = []
        for paragraph in caption["text"].split("\n"):
            line = ""
            for word in paragraph.split():
                require(font.getlength(word) <= right-left-12, "caption word too wide; choose a shorter caption or larger canvas")
                trial = (line + " " + word).strip()
                if line and font.getlength(trial) > right-left-12:
                    lines.append(line)
                    line = word
                else:
                    line = trial
            if line:
                lines.append(line)
        require(0 < len(lines) <= 3, "caption needs more than three lines; split it into timed phrases")
        height = len(lines) * round(data["caption_size"] * 1.4) + 12
        require(bottom-height >= top, "caption exceeds safe area")
        result.append({"caption": caption, "lines": lines, "box": [left, bottom-height, right, bottom],
                       "center_x": (left+right)//2, "bottom": bottom-6})
    return result


def ass_time(seconds):
    centiseconds = round(seconds*100)
    return f"{centiseconds//360000}:{centiseconds//6000%60:02d}:{centiseconds//100%60:02d}.{centiseconds%100:02d}"


def captions_ass(data, directory):
    from PIL import ImageFont
    font = ImageFont.truetype(str(data["font"]), data["caption_size"])
    family = font.getname()[0].replace(",", "")
    font_dir = directory / "fonts"
    font_dir.mkdir()
    shutil.copyfile(data["font"], font_dir / ("caption-font" + data["font"].suffix))
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {data['width']}
PlayResY: {data['height']}
WrapStyle: 2
[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,{family},{data['caption_size']},&H00FFFFFF,&H00FFFFFF,&H00101010,&H80101010,0,0,0,0,100,100,0,0,1,2,1,2,0,0,0,1
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    events = []
    for row in caption_layout(data):
        c = row["caption"]
        text = "\\N".join(row["lines"])
        events.append(f"Dialogue: 0,{ass_time(c['start'])},{ass_time(c['end'])},Caption,,0,0,0,,{{\\an2\\pos({row['center_x']},{row['bottom']})}}{text}")
    (directory / "captions.ass").write_text(header + "\n".join(events), encoding="utf-8")


def render(args):
    fields(args, ("spec", "output"), ("spec", "output"))
    path(args["output"], existing=False, suffixes={".mp4"})
    data = timeline(args)
    w, h, fps, cfg = data["width"], data["height"], data["fps"], data["cfg"]
    with tempfile.TemporaryDirectory(prefix="soot-video-") as folder:
        directory = Path(folder)
        segments = []
        for index, clip in enumerate(data["clips"]):
            target = directory / f"clip-{index:03d}.mp4"
            file, duration = clip["file"], clip["duration"]
            cmd = [cfg["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-protocol_whitelist", "file,pipe"]
            if file.suffix.lower() in IMAGES:
                cmd += ["-loop", "1", "-framerate", str(fps)]
            else:
                cmd += ["-ss", str(clip["source_start"])]
            cmd += ["-i", str(file)]
            fit = clip.get("fit", "cover")
            if fit == "cover":
                vf = f"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}"
            else:
                vf = f"scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2"
            if file.suffix.lower() in IMAGES and (clip["zoom_start"] != 1 or clip["zoom_end"] != 1):
                z0, z1 = clip["zoom_start"], clip["zoom_end"]
                frames = max(clip["frames"]-1, 1)
                vf += f",zoompan=z='{z0}+({z1}-{z0})*on/{frames}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s={w}x{h}:fps={fps}"
            vf += f",fps={fps},setsar=1,format=yuv420p"
            if clip["fade_in"]:
                vf += f",fade=t=in:st=0:d={clip['fade_in']}"
            if clip["fade_out"]:
                vf += f",fade=t=out:st={duration-clip['fade_out']}:d={clip['fade_out']}"
            cmd += ["-vf", vf, "-an", "-frames:v", str(clip["frames"]), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", str(target)]
            command(cmd)
            segments.append(target)
        (directory / "clips.txt").write_text("\n".join(f"file '{p.name}'" for p in segments))
        command([cfg["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                 "-f", "concat", "-safe", "1", "-i", "clips.txt", "-c", "copy", "picture.mp4"], cwd=directory)
        cmd = [cfg["ffmpeg"], "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", "picture.mp4"]
        filters = []
        labels = []
        for index, track in enumerate(data["audio"], 1):
            cmd += ["-protocol_whitelist", "file,pipe", "-i", str(track["file"])]
            audio = f"[{index}:a]atrim=start={track['source_start']}:duration={track['duration']},asetpts=PTS-STARTPTS,aresample=48000,volume={track['gain']}"
            if track["fade_in"]:
                audio += f",afade=t=in:st=0:d={track['fade_in']}"
            if track["fade_out"]:
                audio += f",afade=t=out:st={track['duration']-track['fade_out']}:d={track['fade_out']}"
            audio += f",adelay={round(track['start']*1000)}:all=1[a{index}]"
            filters.append(audio)
            labels.append((f"[a{index}]", track["role"]))
        if labels:
            # Explicit track gain, then peak limiting. Automatic ducking needs separate buses.
            filters.append("".join(label for label, role in labels) +
                           f"amix=inputs={len(labels)}:duration=longest:normalize=0,alimiter=limit=0.95:latency=1,apad,atrim=duration={data['duration']}[mix]")
            cmd += ["-filter_complex", ";".join(filters), "-map", "0:v:0", "-map", "[mix]", "-c:a", "aac", "-b:a", "192k"]
        else:
            cmd += ["-map", "0:v:0", "-an"]
        if data["captions"]:
            captions_ass(data, directory)
            cmd += ["-vf", "ass=captions.ass:fontsdir=fonts", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        else:
            cmd += ["-c:v", "copy"]
        cmd += ["-t", str(data["duration"]), "-movflags", "+faststart", "final.mp4"]
        command(cmd, cwd=directory)
        final = directory / "final.mp4"
        measured = probe_file(final, cfg)
        require(measured["duration"] is not None and abs(measured["duration"]-data["duration"]) <= max(.1, 2/fps),
                "encoded duration differs from timeline")
        require(measured["video"] and measured["video"][0]["width"] == w and measured["video"][0]["height"] == h,
                "encoded canvas differs from timeline")
        with output(args["output"], {".mp4"}) as temp:
            shutil.copyfile(final, temp)
    return {"output": receipt(path(args["output"])), **measured, "spec_sha256": data["spec_sha256"],
            "source_audio": "source clip audio excluded; only explicit audio tracks are mixed",
            "qa": "decode samples with contact_sheet; inspect phone-size captions and listen before delivery"}


def contact_sheet(args):
    fields(args, ("path", "output", "times"), ("path", "output", "times"))
    from PIL import Image, ImageDraw
    p = path(args["path"], suffixes={".mp4", ".mov", ".webm", ".mkv"}, max_bytes=512*1024*1024)
    cfg = binaries()
    media = probe_file(p, cfg)
    require(media["duration"] and media["video"], "video has no duration")
    times = args["times"]
    require(isinstance(times, list) and 0 < len(times) <= 12, "select 1..12 sample times")
    frames = []
    with tempfile.TemporaryDirectory(prefix="soot-frames-") as folder:
        for index, t in enumerate(times):
            number(t, "sample time", 0, max(0, media["duration"]-1/60))
            target = Path(folder) / f"{index}.png"
            command([cfg["ffmpeg"], "-v", "error", "-nostdin", "-y", "-ss", str(t), "-i", str(p),
                     "-frames:v", "1", "-vf", "scale=320:320:force_original_aspect_ratio=decrease", str(target)], timeout=30)
            require(target.exists(), "sample decoded zero frames")
            with Image.open(target) as im:
                frames.append(im.convert("RGB"))
        cols = min(4, len(frames))
        sheet = Image.new("RGB", (cols*340, math.ceil(len(frames)/cols)*360), "#181818")
        draw = ImageDraw.Draw(sheet)
        for index, im in enumerate(frames):
            x, y = index % cols * 340, index // cols * 360
            sheet.paste(im, (x+(340-im.width)//2, y+24))
            draw.text((x+10, y+4), f"{times[index]:.3f}s", fill="white")
        with output(args["output"], {".png"}) as temp:
            sheet.save(temp)
    return receipt(path(args["output"]), samples=len(frames), times=times, all_frames_decoded=True)


def hyperframes(args):
    fields(args, ("project", "action", "output", "times"), ("project", "action"))
    cfg = binding("HYPERFRAMES_BINDING")
    node = Path(cfg.get("node", ""))
    cli = Path(cfg.get("cli", ""))
    require(node.is_absolute() and node.is_file() and cli.is_absolute() and cli.is_file(), "host must bind installed Node and pinned HyperFrames CLI")
    host_env = {"PATH": str(node.parent) + ":/usr/bin:/bin", "HYPERFRAMES_SKIP_SKILLS": "1", "DO_NOT_TRACK": "1"}
    for key, env_name in (("ffmpeg", "HYPERFRAMES_FFMPEG_PATH"), ("ffprobe", "HYPERFRAMES_FFPROBE_PATH"), ("browser", "HYPERFRAMES_BROWSER_PATH")):
        if key in cfg:
            executable = Path(cfg[key])
            require(executable.is_absolute() and executable.is_file() and os.access(executable, os.X_OK), "invalid HyperFrames host executable")
            host_env[env_name] = str(executable)
            host_env["PATH"] = str(executable.parent) + ":" + host_env["PATH"]
    relative = string(args["project"], "project", 512)
    # Resolve the index via the same workspace boundary, then use its parent.
    project = path(relative + "/index.html").parent
    action = args["action"]
    require(action in ("lint", "check", "snapshot", "render"), "unsupported HyperFrames action")
    cmd = [str(node), str(cli), action]
    if action == "render":
        require("output" in args, "render requires output")
        require("times" not in args, "times only applies to snapshot")
        destination = path(args["output"], existing=False, suffixes={".mp4"})
        with output(args["output"], {".mp4"}) as temp:
            cmd += ["--quality", "looks", "--output", str(temp)]
            command(cmd, cwd=project, timeout=540, extra_env=host_env)
        return receipt(destination, engine="hyperframes", qa="run check and inspect decoded frames before delivery")
    require("output" not in args, "output only applies to render")
    if action in ("lint", "check"):
        require("times" not in args, "times only applies to snapshot")
        # Upstream returns exit 1 for valid QA findings. Preserve its structured
        # report so the Soot can diagnose/repair the project instead of guessing.
        raw = command(cmd + ["--json"], cwd=project, timeout=300,
                      extra_env=host_env, allowed_codes=(0, 1))
        report = json_response(raw)
        require(type(report.get("ok")) is bool, "HyperFrames returned no QA verdict")
        return {"engine": "hyperframes", "action": action, "passed": report["ok"], "report": report}
    if action == "snapshot":
        times = args.get("times", [0])
        require(isinstance(times, list) and 0 < len(times) <= 12, "select 1..12 times")
        cmd += ["--at", ",".join(str(number(t, "snapshot time", 0, 600)) for t in times)]
    else:
        require("times" not in args, "times only applies to snapshot")
    result = command(cmd, cwd=project, timeout=300, extra_env=host_env).decode(errors="replace")
    return {"engine": "hyperframes", "action": action, "output": result[:24000]}


if __name__ == "__main__":
    invoke("video-editor", {"probe": probe, "validate": validate, "render": render,
                            "contact_sheet": contact_sheet, "hyperframes": hyperframes})
