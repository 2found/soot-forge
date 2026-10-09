#!/usr/bin/env python3
"""Optional loopback-only OmniVoice service. Started by the operator, never a tool.

The thin client has zero Python dependencies. This separate process owns the
heavy model, authorized reference files and serialized generation queue.
"""
import argparse
import io
import json
import logging
import math
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
import re


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="k2-fsa/OmniVoice")
    parser.add_argument("--voices", type=Path, required=True, help="Directory with authorized ID.wav + ID.txt pairs")
    parser.add_argument("--port", type=int, default=8042)
    parser.add_argument("--device", choices=("cpu", "mps", "cuda"), default="cpu")
    args = parser.parse_args()
    if not args.voices.is_dir() or not 1024 <= args.port <= 65535:
        parser.error("existing voices directory and port 1024..65535 required")
    import numpy as np
    import soundfile as sf
    import torch
    from omnivoice import OmniVoice
    logging.basicConfig(level=logging.INFO)
    # Explicit eager attention and float32 on MPS avoid the reported fp16/SDPA NaNs.
    kwargs = {"device_map": args.device, "dtype": torch.float16 if args.device == "cuda" else torch.float32}
    if args.device == "mps":
        kwargs["attn_implementation"] = "eager"
    model = OmniVoice.from_pretrained(args.model, **kwargs)
    prompts = {}
    references = {}
    for wav in args.voices.glob("*.wav"):
        transcript = wav.with_suffix(".txt")
        if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", wav.stem) and transcript.is_file() and not wav.is_symlink() and not transcript.is_symlink():
            text = transcript.read_text(encoding="utf-8").strip()
            if text and len(text) <= 6000:
                references[wav.stem] = (wav, text)
    if not references:
        raise SystemExit("No authorized WAV/transcript pairs; model cannot invent a reference voice")

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *values):
            pass  # never log spoken text, authorization headers or model exception bodies

        def reply(self, status, value, mime="application/json"):
            raw = value if isinstance(value, bytes) else json.dumps(value).encode()
            self.send_response(status)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            if self.path == "/health":
                self.reply(200, {"engine": "omnivoice", "model_loaded": True, "device": args.device})
            elif self.path == "/voices":
                self.reply(200, [{"id": name} for name in sorted(references)])
            else:
                self.reply(404, {"error": "not found"})

        def do_POST(self):
            if self.path != "/synthesize":
                self.reply(404, {"error": "not found"})
                return
            try:
                self.connection.settimeout(15)
                if self.headers.get("Origin") or self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
                    raise ValueError()
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 32*1024:
                    raise ValueError()
                data = json.loads(self.rfile.read(length))
                allowed = {"text", "voice_id", "language", "speed", "format", "num_steps", "guidance_scale", "position_temperature"}
                if not isinstance(data, dict) or set(data).difference(allowed):
                    raise ValueError()
                text, voice = data.get("text"), data.get("voice_id")
                if not isinstance(text, str) or not text.strip() or len(text) > 6000 or voice not in references:
                    raise ValueError()
                if data.get("format", "wav") != "wav":
                    raise ValueError()
                for key, default, low, high in (("speed", 1, .5, 2), ("guidance_scale", 2.5, 1, 5), ("position_temperature", 3, 0, 10)):
                    value = data.get(key, default)
                    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
                        raise ValueError()
                language = data.get("language", "vi")
                if not isinstance(language, str) or not re.fullmatch(r"[A-Za-z-]{2,20}", language):
                    raise ValueError()
                steps = data.get("num_steps", 32)
                if type(steps) is not int or not 8 <= steps <= 64:
                    raise ValueError()
            except (ValueError, TypeError, KeyError, OSError):
                self.reply(400, {"error": "invalid speech request"})
                return
            try:
                if voice not in prompts:
                    wav, transcript = references[voice]
                    prompts[voice] = model.create_voice_clone_prompt(ref_audio=str(wav), ref_text=transcript, preprocess_prompt=True)
                with torch.inference_mode():
                    audio = model.generate(text=text, language=data.get("language", "vi"), voice_clone_prompt=prompts[voice],
                                           speed=data.get("speed", 1), num_step=steps,
                                           guidance_scale=data.get("guidance_scale", 2.5),
                                           position_temperature=data.get("position_temperature", 3), class_temperature=0.0)[0]
                if hasattr(audio, "detach"):
                    audio = audio.detach().float().cpu().numpy()
                audio = np.asarray(audio).squeeze()
                if audio.ndim != 1 or not audio.size or not np.isfinite(audio).all() or audio.size > 24000*600:
                    raise ValueError("invalid waveform")
                b = io.BytesIO()
                sf.write(b, audio, 24000, format="WAV", subtype="PCM_16")
                self.reply(200, b.getvalue(), "audio/wav")
            except Exception:
                self.reply(503, {"error": "OmniVoice inference failed"})

    # HTTPServer serializes inference: no concurrent GPU model access or hidden worker loop.
    server = HTTPServer(("127.0.0.1", args.port), Handler)
    server.timeout = 310
    logging.info("OmniVoice ready on loopback port %s (%s authorized voices)", args.port, len(references))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
