"""Tests for scripts/check_outputs.py (no network; each case builds a throwaway git repo in a temp dir).

Run from the repo root:
    python -m unittest discover -s tests -v
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_outputs.py"
HAVE_GIT = shutil.which("git") is not None

spec = importlib.util.spec_from_file_location("check_outputs", SCRIPT)
check_outputs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_outputs)   # nothing runs at import: main() is behind __name__


@unittest.skipUnless(HAVE_GIT, "git not available")
class CheckOutputsTests(unittest.TestCase):
    def setUp(self):
        self.repo = Path(tempfile.mkdtemp(prefix="test_check_outputs_"))
        self.addCleanup(shutil.rmtree, self.repo, ignore_errors=True)
        self.git("init", "-q")
        # same bytes on every OS: no CRLF conversion, no user hooks or signing
        for k, v in (("core.autocrlf", "false"), ("core.safecrlf", "false"), ("commit.gpgsign", "false"),
                     ("core.hooksPath", os.devnull), ("user.name", "test"), ("user.email", "test@example.com")):
            self.git("config", k, v)
        self.write("out.json", '{"x": 1.0, "v": [1, 2.5, null], "s": "a"}\n')
        self.write("data.js", 'const DATA = {"x": 1.0};\n')
        self.write("out.csv", "a,b\n1,2\n")
        self.write("code.py", "print('hi')\n")
        self.write("a b.txt", "spaces\n")
        self.git("add", "-A")
        self.git("commit", "-q", "-m", "init")

    # helpers
    def git(self, *args):
        return subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True)

    def write(self, rel, text):
        p = self.repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(text.encode("utf-8"))

    def run_check(self, *args, cwd=None):
        r = subprocess.run([sys.executable, str(SCRIPT), *args], cwd=cwd or self.repo,
                           capture_output=True, text=True, timeout=60)
        return r.returncode, r.stdout + r.stderr

    def assertCheck(self, code, *args):
        got, out = self.run_check(*args)
        self.assertEqual(got, code, out)
        return out

    # porcelain parsing
    def test_porcelain_rename_and_spaces(self):
        self.git("mv", "a b.txt", "c d.txt")             # staged rename: "R  c d.txt\0a b.txt\0"
        self.write("new dir/new file.txt", "x\n")         # untracked, path with spaces
        self.write("code.py", "print('changed')\n")       # plain modification
        old = os.getcwd()
        os.chdir(self.repo)
        try:
            paths = check_outputs.dirty_paths()
        finally:
            os.chdir(old)
        self.assertEqual(sorted(paths), ["c d.txt", "code.py", "new dir/new file.txt"])

    # numeric tolerance
    def test_clean_repo_passes(self):
        self.assertIn("baseline: HEAD", self.assertCheck(0))

    def test_json_float_within_tolerance_passes(self):
        self.write("out.json", json.dumps({"x": 1.0 + 1e-12, "v": [1, 2.5, None], "s": "a"}) + "\n")
        self.assertIn("within float tolerance: out.json", self.assertCheck(0))

    def test_json_float_off_by_one_percent_fails(self):
        self.write("out.json", json.dumps({"x": 1.01, "v": [1, 2.5, None], "s": "a"}) + "\n")
        out = self.assertCheck(1)
        self.assertIn("out.json", out)
        self.assertIn("$.x", out)

    def test_json_structure_change_fails(self):
        self.write("out.json", json.dumps({"x": 1.0, "v": [1, 2.5], "s": "a"}) + "\n")
        self.assertIn("length 2 != 3", self.assertCheck(1))
        self.write("out.json", json.dumps({"x": 1.0, "v": [1, 2.5, 0], "s": "a"}) + "\n")
        self.assertIn("$.v[2]", self.assertCheck(1))   # null -> 0 is not "within tolerance"

    def test_js_const_form(self):
        self.write("data.js", 'const DATA = {"x": 1.000000000001};\n')
        self.assertIn("within float tolerance: data.js", self.assertCheck(0))
        self.write("data.js", 'const DATA = {"x": 1.01};\n')
        self.assertIn("$.x", self.assertCheck(1))
        self.write("data.js", 'export default {"x": 1.0};\n')
        self.assertIn("could not compare", self.assertCheck(1))

    # byte-exact and new files
    def test_csv_byte_change_fails(self):
        self.write("out.csv", "a,b\n1,3\n")
        out = self.assertCheck(1)
        self.assertIn("out.csv", out)
        self.assertIn("byte for byte", out)

    def test_deleted_output_fails(self):
        (self.repo / "out.csv").unlink()
        self.assertIn("deleted", self.assertCheck(1))

    def test_new_untracked_file_fails(self):
        self.write("site/new.csv", "x\n")
        out = self.assertCheck(1)
        self.assertIn("site/new.csv", out)
        self.assertIn("new file", out)

    def test_ignored_file_is_not_checked(self):
        self.write(".gitignore", "*.part\n")
        self.git("add", ".gitignore")
        self.git("commit", "-q", "-m", "ignore")
        self.write("out.json.part", "half-written")
        self.assertCheck(0)

    # snapshot baseline
    def test_snapshot_keeps_an_uncommitted_code_edit(self):
        self.write("code.py", "print('work in progress')\n")
        self.assertCheck(1)                                    # against HEAD the edit is a change
        self.assertIn("snapshot saved: 1 dirty path", self.assertCheck(0, "--snapshot"))
        self.write("out.json", json.dumps({"x": 1.0 + 1e-12, "v": [1, 2.5, None], "s": "a"}) + "\n")
        out = self.assertCheck(0)
        self.assertIn("baseline: snapshot", out)
        self.assertFalse((self.repo / ".git" / check_outputs.SNAPSHOT_NAME).exists(), "snapshot not removed")

    def test_snapshot_still_catches_a_changed_output(self):
        self.write("code.py", "print('work in progress')\n")
        self.assertCheck(0, "--snapshot")
        self.write("out.csv", "a,b\n9,9\n")
        self.assertIn("out.csv", self.assertCheck(1))

    def test_path_restored_to_head_passes(self):
        self.write("out.csv", "a,b\nedited,before snapshot\n")
        self.assertCheck(0, "--snapshot")
        self.git("checkout", "--", "out.csv")                 # pipeline wrote the committed bytes back
        self.assertCheck(0)

    # arguments and environment
    def test_unknown_argument_exits_2(self):
        for args in (["--bogus"], ["--snapshot", "extra"]):
            code, out = self.run_check(*args)
            self.assertEqual(code, 2, out)
            self.assertIn("usage:", out)

    def test_runs_from_a_subdirectory(self):
        (self.repo / "sub").mkdir()
        self.write("out.csv", "a,b\n1,3\n")
        code, out = self.run_check(cwd=self.repo / "sub")
        self.assertEqual(code, 1, out)
        self.assertIn("out.csv", out)

    def test_outside_a_git_repo_exits_2(self):
        empty = tempfile.mkdtemp(prefix="test_check_outputs_nogit_")
        self.addCleanup(shutil.rmtree, empty, ignore_errors=True)
        env = dict(os.environ, GIT_CEILING_DIRECTORIES=str(Path(empty).parent))
        r = subprocess.run([sys.executable, str(SCRIPT)], cwd=empty, capture_output=True, text=True,
                           timeout=60, env=env)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("not inside a git repository", r.stderr)


if __name__ == "__main__":
    unittest.main()
