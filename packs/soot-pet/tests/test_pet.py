"""Deterministic assembly contract tests; no generation or external login."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from PIL import Image

TOOLS = Path(__file__).resolve().parents[1] / 'tools'
sys.path.insert(0,str(TOOLS))
import atlas
import pet
import codex_status


class PetTests(unittest.TestCase):
    def test_native_alpha_cleanup_is_byte_identical_for_all_alpha_values(self):
        pixels=[(31,127,255,a) for a in range(256)]*10
        image=Image.new('RGBA',(256,10));image.putdata(pixels)
        expected=bytes(v for r,g,b,a in pixels for v in ((r,g,b,a) if a else (0,0,0,0)))
        self.assertIs(atlas.clean_rgba(image),image)
        self.assertEqual(image.tobytes(),expected)

    def test_generated_gutters_must_be_clear_and_frame_order_retains_all_cels(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve(); image=Image.new('RGBA',(1536,1024),(20,20,20,255));image.save(root/'overlap.png')
            with self.assertRaises(ValueError):atlas.extract(root/'overlap.png')
        self.assertEqual(atlas.transparent_cut([1]*50+[0]*10+[1]*50,55,20),55)
        with self.assertRaises(ValueError):atlas.transparent_cut([1]*100,50,20)

    def test_prepare_is_repeatable_and_never_replaces_a_different_brief(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'jobs').mkdir()
            data={'id':'fixture','name':'Soot thử nghiệm','accessories':'ONE small book','action':'turn a page'}
            first=pet.prepare(root,data);second=pet.prepare(root,data)
            self.assertEqual(first,second)
            with self.assertRaises(ValueError):pet.prepare(root,{**data,'accessories':'a different prop'})
            self.assertEqual(len(first['missingStates']),7)
            with self.assertRaises(ValueError):pet.assemble(root,{'id':'fixture'})

    def test_pet_paths_reject_escape_and_symlinks(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder).resolve();(root/'link').symlink_to(root.parent,target_is_directory=True)
            for relative in ['../secret','/tmp/secret','link/secret']:
                with self.assertRaises(ValueError):pet.bounded(root,relative)

    def test_codex_preflight_keeps_account_details_private_and_does_not_generate(self):
        class Result:
            returncode=0
            stdout=b'Logged in using ChatGPT PRIVATE_ACCOUNT_TOKEN'
            stderr=b''
        with patch.dict('os.environ',{'PATH':'/fixture','HOME':'/fixture'},clear=True), patch.object(codex_status.shutil,'which',return_value='/fixture/codex'), patch.object(codex_status.subprocess,'run',return_value=Result()) as run:
            ready=codex_status.check_codex()
        self.assertTrue(ready['canPrepare']);self.assertEqual(ready['imageGeneration'],'not_checked')
        self.assertNotIn('PRIVATE',str(ready));self.assertEqual(run.call_args.args[0],['/fixture/codex','login','status'])


if __name__=='__main__':unittest.main(verbosity=2)
