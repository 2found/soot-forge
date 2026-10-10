# Prepare the native runtime

Explicit host preparation, separate from `soot add`. Never put the native build
or weights under packs_dir. The pack uses the sd-cli interface reviewed at
stable-diffusion.cpp commit `f89d9b13d730eabeede7314ce49dacd18d3c90c2`.

For Apple Silicon, build with Xcode command line tools, CMake and Ninja:

```sh
git clone https://github.com/leejet/stable-diffusion.cpp.git /absolute/host-runtimes/sd-source
cd /absolute/host-runtimes/sd-source
git checkout f89d9b13d730eabeede7314ce49dacd18d3c90c2
git submodule update --init --recursive
cmake -S . -B /absolute/host-runtimes/sd-build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSD_METAL=ON
cmake --build /absolute/host-runtimes/sd-build --target sd-cli -j 2
/absolute/host-runtimes/sd-build/bin/sd-cli --help
```

Use the runtime's [build guidance](https://github.com/leejet/stable-diffusion.cpp/blob/f89d9b13d730eabeede7314ce49dacd18d3c90c2/docs/build.md)
for toolchain details. A source build avoids requiring the macOS version used
to build a downloaded release. GPU support is optional: `backend: cpu` also
works but is slower. All OS/library dependencies are host responsibilities.

The reviewed CLI must support Qwen Image **2.1**, `--params-backend disk`,
`--max-vram`, `--sigmas`, and the Qwen prefix-cache configuration. Older Qwen
Image runtimes are not interchangeable. Use the 2.1 VAE; the older Qwen/Wan VAE
is incompatible. Q4 encoder weights come from Qwen's official GGUF repository;
text-only generation does not need the extra vision projector. For editing, run
`operator/download.py --directory /absolute/models --with-vision` and bind
`llm_vision` to the pinned `mmproj-Qwen3VL-8B-Instruct-F16.gguf`. The tool passes
`--llm_vision` and `-r` only for a validated workspace reference image.

The pack fixes CFG=1, Euler and the official Turbo sigmas (plus the sampler's
terminal zero). Upstream checkpoint scheduler has static shift=1, so the saved
sigma values need no resolution-dependent shift. The pack deliberately uses
that official schedule even though the conversion card suggests 4–8 steps.

For 16GB, disk-backed parameters plus bounded compute buffers are the memory
strategy. Offloading to CPU alone still consumes the Mac's shared RAM. Read
[upstream memory controls](https://github.com/leejet/stable-diffusion.cpp/blob/f89d9b13d730eabeede7314ce49dacd18d3c90c2/docs/performance.md)
before changing the host budget. Keep one shared lock_file for every Soot using
this model. Two independent locks would permit two simultaneous model loads.
The default Metal profile runs text encoding and VAE on Metal too; the host can
choose `text_backend: "cpu"` / `vae_backend: "cpu"` independently. A paired
512×512 edit on M1 Pro 16GB measured 165s / 3.9 GiB with Metal stages versus
278s / 5.7 GiB with CPU stages. Keep the same disk-backed parameters, disabled
prefetch and bounded budgets; moving a stage to CPU is not a shared-RAM saving
by itself. The wrapper's private lifetime pipe stops native inference even if
Soot hard-kills the wrapper; do not replace it with detached native execution.

Benchmark using a fixed prompt/seed and record dimensions, all three weight
hashes, runtime commit, wall time, child RSS, system memory pressure and swap
before/after. A completed image and visual review are required before claiming
local inference works. A process that succeeds through heavy swap has not
proved that inference fits comfortably in physical RAM.
