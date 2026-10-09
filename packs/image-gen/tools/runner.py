"""Bounded local Qwen Image 2.1 Turbo Q4_K_M generation, public soot/v1 only."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import *
import fcntl
import resource
import signal
import subprocess
import time

MODEL = json.loads((Path(__file__).resolve().parent.parent / "model.json").read_text())


def image_info(p):
    from PIL import Image
    with Image.open(p) as im:
        require(im.format == "PNG" and getattr(im, "n_frames", 1) == 1, "expected a single PNG")
        require(im.width * im.height <= 32_000_000, "image exceeds pixel limit")
        im.load()  # Detect truncated files, not just valid headers.
        alpha = im.getchannel("A").getextrema() if "A" in im.getbands() else None
        return {"width": im.width, "height": im.height, "mode": im.mode,
                "has_transparency": bool(alpha and alpha[0] < 255)}


def inspect(args):
    fields(args, ("path",), ("path",))
    p = path(args["path"], suffixes={".png"})
    return {**receipt(p), **image_info(p), "visual_qa": "pending prompt/text/layout review"}


def host_file(value, label, executable=False):
    require(isinstance(value, str) and Path(value).is_absolute(), f"host must bind absolute {label}")
    p = Path(value)
    require(p.is_file() and not p.is_symlink() and (not executable or os.access(p, os.X_OK)),
            f"host must prepare {label} outside packs_dir")
    return p


def configuration(edit=False):
    cfg = binding("IMAGE_GEN_BINDING")
    fields(cfg, ("sd_cli", "diffusion", "llm", "vae", "llm_vision", "lock_file", "backend", "max_pixels", "max_vram_gib", "max_ram_gib", "timeout_sec"),
           ("sd_cli", "diffusion", "llm", "vae", "lock_file"))
    host_file(cfg["sd_cli"], "sd-cli", executable=True)
    weights = {**MODEL["weights"], **(MODEL["optional_weights"] if edit else {})}
    for key, weight in weights.items():
        require(key in cfg, "host must prepare llm_vision for reference-image editing")
        p = host_file(cfg[key], key)
        require(p.stat().st_size == weight["bytes"] and digest(p) == weight["sha256"],
                f"{key} does not match pinned Qwen Turbo Q4_K_M weights; prepare the reviewed model.json files")
    require(cfg.get("backend", "metal") in ("metal", "cpu"), "backend must be metal or cpu")
    integer(cfg.get("max_pixels", 512*512), "host pixel limit", 256*256, 768*768)
    number(cfg.get("max_vram_gib", 3), "host Metal budget", 1, 8)
    number(cfg.get("max_ram_gib", 2), "host CPU budget", 1, 4)
    integer(cfg.get("timeout_sec", 1700), "host inference timeout", 1, 1700)
    lock = cfg["lock_file"]
    require(isinstance(lock, str) and Path(lock).is_absolute() and Path(lock).parent.is_dir()
            and not Path(lock).is_symlink(), "host must bind an absolute lock_file with an existing parent")
    return cfg


def command(argv, directory, timeout):
    # Native inference writes verbose output. Bound the log and kill descendants
    # on timeout; never propagate host paths or the model prompt in an error.
    log = Path(directory) / "inference.log"
    started = time.monotonic()
    with log.open("wb") as stream, subprocess.Popen(
            argv, cwd=directory, stdin=subprocess.DEVNULL, stdout=stream, stderr=stream,
            start_new_session=True, env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}) as process:
        completed = False
        try:
            while process.poll() is None:
                require(time.monotonic() - started < timeout, "inference timed out; no image published")
                require(log.stat().st_size <= 8*1024*1024, "inference log exceeds limit; no image published")
                time.sleep(.1)
            require(log.stat().st_size <= 8*1024*1024, "inference log exceeds limit")
            require(process.returncode == 0, "inference failed; verify the host runtime and available memory")
            completed = True
        finally:
            if not completed:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
    rss = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
    return {"seconds": round(time.monotonic() - started, 3),
            "peak_child_rss_bytes": int(rss if sys.platform == "darwin" else rss*1024),
            "memory_measurement": "OS child RSS high-water mark; excludes other processes, not a total unified-memory guarantee"}


def arguments(cfg, args, destination):
    prompt = args["prompt"]
    if args.get("transparent", False):
        prompt = "This is an RGBA image with transparency. " + prompt + " The image has alpha channel and the background is transparent."
    memory_budget = "cpu=" + str(cfg.get("max_ram_gib", 2))
    if cfg.get("backend", "metal") == "metal":
        memory_budget = "metal=" + str(cfg.get("max_vram_gib", 3)) + "," + memory_budget
    # No model-controlled argv, model paths, URLs, schedules, extra flags or shell.
    argv = [cfg["sd_cli"], "--diffusion-model", cfg["diffusion"], "--llm", cfg["llm"], "--vae", cfg["vae"],
            "--backend", "diffusion=" + cfg.get("backend", "metal") + ",te=cpu,vae=cpu",
            "--params-backend", "disk", "--disable-prefetch", "--max-vram",
            memory_budget,
            "--fa", "--vae-tiling", "--vae-tile-size", "256x256", "--vae-tile-overlap", "0.5",
            "--model-args", "qwen_image_2_1_prefix_cache_type=f16", "--cfg-scale", "1",
            "--sampling-method", "euler", "--steps", "8", "--sigmas", ",".join(map(str, MODEL["sample_sigmas"])),
            "--width", str(args["width"]), "--height", str(args["height"]),
            "--seed", str(args["seed"]), "-p", prompt, "-o", str(destination)]
    if args.get("reference"):
        argv += ["--llm_vision", cfg["llm_vision"], "-r", str(args["reference"])]
    return argv


def generate(args):
    fields(args, ("prompt", "output", "width", "height", "seed", "transparent", "reference"), ("prompt", "output"))
    string(args["prompt"], "prompt", 4000)
    path(args["output"], existing=False, suffixes={".png"})  # Refuse conflicts before inference.
    args = {"width": 512, "height": 512, "seed": 42, "transparent": False, **args}
    for key in ("width", "height"):
        integer(args[key], key, 256, 768)
        require(args[key] % 32 == 0, "dimensions must be multiples of 32")
    integer(args["seed"], "seed", 0, 2147483647)
    require(type(args["transparent"]) is bool, "transparent must be boolean")
    reference = None
    if "reference" in args:
        reference = path(args["reference"], suffixes={".png", ".jpg", ".jpeg"}, max_bytes=2*1024*1024)
        from PIL import Image
        with Image.open(reference) as im:
            require(im.format in ("PNG", "JPEG") and im.width*im.height <= 16_000_000
                    and getattr(im, "n_frames", 1) == 1, "unsupported reference image")
            im.load()
    cfg = configuration(edit=reference is not None)
    require(args["width"]*args["height"] <= cfg.get("max_pixels", 512*512), "image exceeds host pixel budget")
    # One inference at a time across Soots using this host model; do not queue
    # another memory-heavy process behind a lock with an unbounded timeout.
    fd = os.open(cfg["lock_file"], os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ToolError("image runtime busy; retry after the current generation finishes") from None
        with tempfile.TemporaryDirectory(prefix="soot-image-") as directory:
            generated = Path(directory) / "image.png"
            metrics = command(arguments(cfg, {**args, "reference": reference}, generated), directory, cfg.get("timeout_sec", 1700))
            require(generated.is_file() and generated.stat().st_size <= 32*1024*1024, "missing or oversized generated image")
            info = image_info(generated)
            require((info["width"], info["height"]) == (args["width"], args["height"]), "runtime returned wrong dimensions")
            require(not args["transparent"] or info["has_transparency"], "model did not produce transparency; no image published")
            with output(args["output"], {".png"}) as staged:
                staged.write_bytes(generated.read_bytes())
    return {**receipt(path(args["output"])), **info, **metrics,
            "model": MODEL["model"], "quantization": MODEL["quantization"], "seed": args["seed"],
            "steps": 8, "cfg": 1, "reference": receipt(reference) if reference else None, "weights_sha256": {k: v["sha256"] for k, v in MODEL["weights"].items()},
            "visual_qa": "pending prompt/text/layout review; quantization and tiling may affect quality"}


if __name__ == "__main__":
    invoke("image-gen", {"inspect": inspect, "generate": generate})
