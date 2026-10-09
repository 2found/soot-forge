"""Native CLI transport fixtures; not a model accuracy or RAM benchmark."""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

PACK = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("image_gen", PACK / "tools/runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
from common import ToolError


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        from PIL import Image
        Image.new("RGBA", (512, 512), (30, 100, 160, 255)).save(self.root / "template.png")
        self.binary = self.root / "sd-cli"
        self.binary.write_text(f"#!{sys.executable}\nimport sys,json,shutil\nfrom pathlib import Path\na=sys.argv[1:]\nPath({str(self.root/'argv.json')!r}).write_text(json.dumps(a))\nshutil.copyfile({str(self.root/'template.png')!r},a[a.index('-o')+1])\n")
        self.binary.chmod(0o700)
        weights = {}
        self.cfg = {"sd_cli": str(self.binary), "lock_file": str(self.root / "runtime.lock")}
        for key in ("diffusion", "llm", "vae"):
            data = (key + " fixture").encode()
            file = self.root / key
            file.write_bytes(data)
            self.cfg[key] = str(file)
            weights[key] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        self.model = patch.object(runner, "MODEL", {**runner.MODEL, "weights": weights})
        self.env = patch.dict(os.environ, {"FILE_ROOT": str(self.root), "IMAGE_GEN_BINDING": json.dumps(self.cfg)})
        self.model.start(); self.env.start()

    def tearDown(self):
        self.model.stop(); self.env.stop(); self.temp.cleanup()

    def test_cli_receipt_fixed_turbo_schedule_no_shell_and_real_pixels(self):
        prompt = "a cat; $(touch stolen) `echo bad` --steps 50"
        result = runner.generate({"prompt": prompt, "output": "result.png", "seed": 123})
        argv = json.loads((self.root / "argv.json").read_text())
        self.assertEqual(argv[argv.index("-p")+1], prompt)
        self.assertEqual(argv[argv.index("--steps")+1], "8")
        self.assertEqual(argv[argv.index("--sigmas")+1], "1.0,0.978453,0.95418,0.926626,0.89508,0.845148,0.704534,0.414568,0.0")
        self.assertEqual(argv[argv.index("--cfg-scale")+1], "1")
        self.assertEqual(argv[argv.index("--params-backend")+1], "disk")
        self.assertEqual(argv[argv.index("--max-vram")+1], "metal=3,cpu=2")
        self.assertIn("--disable-prefetch", argv)
        self.assertEqual(argv[argv.index("--backend")+1], "diffusion=metal,te=cpu,vae=cpu")
        self.assertIn("--vae-tiling", argv)
        self.assertEqual(result["sha256"], hashlib.sha256((self.root/"result.png").read_bytes()).hexdigest())
        self.assertEqual((result["width"], result["height"], result["seed"]), (512, 512, 123))
        self.assertEqual(result["quantization"], "Q4_K_M")
        self.assertEqual((self.root/"result.png").stat().st_mode & 0o777, 0o600)
        self.assertFalse((self.root/"stolen").exists())

    def test_existing_output_bad_arguments_and_paths_never_invoke_cli(self):
        (self.root/"exists.png").write_bytes(b"original")
        for value in ({"output":"exists.png"}, {"output":"../escape.png"}, {"width":513},
                      {"width":True}, {"seed":-1}, {"transparent":"true"}, {"extra_flags":"--steps 50"}):
            with self.subTest(value=value), self.assertRaises(ToolError):
                runner.generate({"prompt":"cat", "output":"out.png", **value})
        self.assertFalse((self.root/"argv.json").exists())
        self.assertEqual((self.root/"exists.png").read_bytes(), b"original")

    def test_cpu_profile_needs_no_metal_device_and_limits_cpu_working_set(self):
        with patch.dict(os.environ, {"IMAGE_GEN_BINDING":json.dumps({**self.cfg,"backend":"cpu","max_ram_gib":1.5})}):
            runner.generate({"prompt":"cat","output":"cpu.png"})
        argv=json.loads((self.root/"argv.json").read_text())
        self.assertEqual(argv[argv.index("--backend")+1],"diffusion=cpu,te=cpu,vae=cpu")
        self.assertEqual(argv[argv.index("--max-vram")+1],"cpu=1.5")

    def test_host_budget_unknown_flags_and_wrong_hash_rejected(self):
        for cfg in ({**self.cfg,"max_pixels":65536}, {**self.cfg,"extra_flags":["--steps","1"]},
                    {**self.cfg,"backend":"cuda"}):
            with patch.dict(os.environ,{"IMAGE_GEN_BINDING":json.dumps(cfg)}), self.assertRaises(ToolError):
                runner.generate({"prompt":"cat","output":"out.png"})
        (self.root/"diffusion").write_bytes(b"broken fixture!!!")
        with self.assertRaises(ToolError):
            runner.generate({"prompt":"cat","output":"out.png"})
        self.assertFalse((self.root/"argv.json").exists())

    def test_busy_runtime_never_launches_second_inference(self):
        with (self.root/"runtime.lock").open("w") as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with self.assertRaisesRegex(ToolError,"busy"):
                runner.generate({"prompt":"cat","output":"out.png"})
        self.assertFalse((self.root/"argv.json").exists())

    def test_transparency_requires_actual_alpha_and_wrong_dimensions_never_publish(self):
        from PIL import Image
        with self.assertRaisesRegex(ToolError,"transparency"):
            runner.generate({"prompt":"cutout","output":"out.png","transparent":True})
        self.assertFalse((self.root/"out.png").exists())
        Image.new("RGBA",(512,512),(20,30,40,0)).save(self.root/"template.png")
        result=runner.generate({"prompt":"cutout","output":"alpha.png","transparent":True})
        self.assertTrue(result["has_transparency"])
        prompt=json.loads((self.root/"argv.json").read_text())
        self.assertIn("RGBA",prompt[prompt.index("-p")+1])
        Image.new("RGB",(256,256)).save(self.root/"template.png")
        with self.assertRaisesRegex(ToolError,"dimensions"):
            runner.generate({"prompt":"cat","output":"wrong.png"})
        self.assertFalse((self.root/"wrong.png").exists())

    def test_failed_and_timed_out_cli_never_publish_or_leave_lock_held(self):
        self.binary.write_text(f"#!{sys.executable}\nimport sys\nsys.exit(1)\n")
        with self.assertRaisesRegex(ToolError,"inference failed"):
            runner.generate({"prompt":"cat","output":"fail.png"})
        self.binary.write_text(f"#!{sys.executable}\nimport time\ntime.sleep(30)\n")
        with patch.dict(os.environ,{"IMAGE_GEN_BINDING":json.dumps({**self.cfg,"timeout_sec":1})}):
            with self.assertRaisesRegex(ToolError,"timed out"):
                runner.generate({"prompt":"cat","output":"timeout.png"})
        with (self.root/"runtime.lock").open("w") as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        self.assertFalse((self.root/"fail.png").exists())
        self.assertFalse((self.root/"timeout.png").exists())

    def test_inspect_needs_no_model_binding_and_rejects_truncation(self):
        with patch.dict(os.environ,{"IMAGE_GEN_BINDING":""}):
            result=runner.inspect({"path":"template.png"})
        self.assertEqual(result["width"],512)
        self.assertFalse(result["has_transparency"])
        (self.root/"truncated.png").write_bytes((self.root/"template.png").read_bytes()[:100])
        with self.assertRaises(OSError): runner.inspect({"path":"truncated.png"})

    def test_public_wrapper_envelope_and_mismatch(self):
        call={"api_version":"soot/v1","hook":"tool.call","soot":"test","operation":"image-gen_inspect",
              "input":{"path":"template.png"},"future_v1":True}
        env={"FILE_ROOT":str(self.root),"PYTHON_EXECUTABLE":sys.executable}
        result=subprocess.run([str(PACK/"tools/run"),"inspect"],input=json.dumps(call),text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)["width"],512)
        call["operation"]="image-gen_generate"
        result=subprocess.run([str(PACK/"tools/run"),"inspect"],input=json.dumps(call),text=True,capture_output=True,env=env)
        self.assertEqual(result.returncode,1)
        self.assertIn("operation mismatch",result.stderr)


if __name__ == "__main__": unittest.main(verbosity=2)
