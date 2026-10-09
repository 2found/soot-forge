"""Thin OmniVoice client. A resident host-owned service holds the model once."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
import io
import wave


def config():
    cfg = binding("TTS_BINDING")
    cfg["base_url"] = endpoint(cfg.get("base_url", ""))
    require(cfg.get("engine") == "omnivoice", "TTS_BINDING must explicitly select engine omnivoice")
    require(cfg.get("transport", "studio") in ("studio", "openai"), "unknown OmniVoice transport")
    return cfg


def voices(args):
    fields(args, ())
    cfg = config()
    route = "/voices" if cfg.get("transport", "studio") == "studio" else "/audio/voices"
    raw, _ = http(cfg["base_url"] + route, token=cfg.get("api_key"), maximum=256*1024)
    value = json.loads(raw)
    require(isinstance(value, (list, dict)), "invalid voice inventory")
    return {"engine": "omnivoice", "voices": value,
            "note": "Only listed host-owned references are usable; do not invent voice IDs."}


def wav_info(source):
    with wave.open(source, "rb") as f:
        frames, rate, channels, width = f.getnframes(), f.getframerate(), f.getnchannels(), f.getsampwidth()
        require(rate > 0 and frames > 0 and channels in (1, 2) and width in (1, 2, 3, 4), "invalid PCM WAV")
        # Check that the declared frames actually exist, without reading all at once.
        read, silent = 0, True
        while block := f.readframes(65536):
            read += len(block)
            silent = silent and block.count(128 if width == 1 else 0) == len(block)
        require(read == frames * channels * width, "truncated WAV")
    return {"duration": frames/rate, "sample_rate": rate, "channels": channels,
            "digital_silence": silent, "alignment": "none", "listening": "pending"}


def inspect(args):
    fields(args, ("path",), ("path",))
    p = path(args["path"], suffixes={".wav"}, max_bytes=128*1024*1024)
    return receipt(p, **wav_info(str(p)))


def synthesize(args):
    fields(args, ("text", "voice", "language", "speed", "output"), ("text", "voice", "output"))
    text = string(args["text"], "spoken text", 6000)
    voice = string(args["voice"], "voice ID", 100)
    require(re.fullmatch(r"[A-Za-z0-9_-]+", voice), "invalid voice ID")
    language = string(args.get("language", "vi"), "language", 30)
    speed = number(args.get("speed", 1), "speed", .5, 2)
    path(args["output"], existing=False, suffixes={".wav"})
    cfg = config()
    allowed = cfg.get("voices")
    require(isinstance(allowed, list) and voice in allowed, "voice not authorized by host TTS_BINDING.voices")
    if cfg.get("transport", "studio") == "studio":
        payload = {"text": text, "voice_id": voice, "language": language, "speed": speed,
                   "format": "wav", "num_steps": 32, "guidance_scale": 2.5, "position_temperature": 3.0}
        route = "/synthesize"
    else:
        payload = {"model": cfg.get("model", "omnivoice"), "input": text,
                   "voice": voice, "response_format": "wav", "speed": speed}
        # Language support varies between OpenAI-compatible servers; avoid made-up fields.
        require(language == cfg.get("language", "vi"), "language differs from bound OpenAI server language")
        route = "/audio/speech"
    raw, _ = http(cfg["base_url"] + route, method="POST", data=payload, token=cfg.get("api_key"),
                  maximum=128*1024*1024, timeout=300)
    info = wav_info(io.BytesIO(raw))
    require(info["duration"] <= 600, "audio longer than 10 minutes")
    require(not info["digital_silence"], "OmniVoice returned digital silence; no speech file published")
    with output(args["output"], {".wav"}) as temp:
        temp.write_bytes(raw)
    result = receipt(path(args["output"]), **info)
    result.update(engine="omnivoice", voice=voice, language=language,
                  text_sha256=hashlib.sha256(text.encode()).hexdigest(),
                  transcript=text, transcript_source="requested text; not verified against waveform",
                  quality="listening/ASR comparison pending", alignment="not supplied; duration is measured from samples")
    return result


if __name__ == "__main__":
    invoke("tts", {"voices": voices, "inspect": inspect, "synthesize": synthesize})
