#!/usr/bin/env python3
import base64
import json
import os
import math
import re
import subprocess
import sys

REL_TOL = 1e-6
ABS_TOL = 1e-9
MAX_DIFFS = 5
FIX = ("Regenerate the outputs (`python build.py portugal` then `python model.py` from the "
       "repo root, as CI does) on your branch and commit them together with the code change.")
JS_RE = re.compile(r"\A\s*(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(.*?)\s*;?\s*\Z", re.S)


SNAPSHOT_NAME = "check_outputs_snapshot.json"


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True).stdout


def snapshot_path():
    gd = git("rev-parse", "--git-dir").decode("utf-8", "replace").strip()
    return os.path.join(gd, SNAPSHOT_NAME)


def dirty_paths():
    out = git("status", "--porcelain", "-z", "--untracked-files=all").decode("utf-8", "replace")
    parts = out.split("\0")
    paths = []
    i = 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        code, path = entry[:2], entry[3:]
        if "R" in code or "C" in code:
            i += 1
        paths.append(path.replace("\\", "/"))
    return paths


def read_current(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except (FileNotFoundError, IsADirectoryError):
        return None


def read_head(path):
    try:
        return git("show", "HEAD:" + path)
    except subprocess.CalledProcessError:
        return None


def parse(path, data):
    text = data.decode("utf-8")
    if path.lower().endswith(".js"):
        m = JS_RE.match(text)
        if not m:
            raise ValueError("not a single `const NAME = <json>;` statement")
        text = m.group(1)
    return json.loads(text)


def compare(a, b, where, diffs):
    if len(diffs) >= MAX_DIFFS:
        return
    if isinstance(a, bool) or isinstance(b, bool) or a is None or b is None:
        if type(a) is not type(b) or a != b:
            diffs.append(f"{where}: {a!r} != {b!r}")
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if a == b:
            return
        if (isinstance(a, float) and math.isnan(a)) and (isinstance(b, float) and math.isnan(b)):
            return
        if not math.isclose(a, b, rel_tol=REL_TOL, abs_tol=ABS_TOL):
            diffs.append(f"{where}: {a!r} != {b!r}")
    elif isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            diffs.append(f"{where}: keys differ (only baseline: {sorted(set(b) - set(a))[:5]}, "
                         f"only new: {sorted(set(a) - set(b))[:5]})")
            return
        for k in a:
            compare(a[k], b[k], f"{where}.{k}", diffs)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            diffs.append(f"{where}: length {len(a)} != {len(b)}")
            return
        for i, (x, y) in enumerate(zip(a, b)):
            compare(x, y, f"{where}[{i}]", diffs)
    elif type(a) is not type(b) or a != b:
        diffs.append(f"{where}: {a!r} != {b!r}")


def check_path(path, cur, base):
    if cur is None:
        return ["deleted"]
    if base is None:
        return ["new file produced by the pipeline (not in the baseline)"]
    low = path.lower()
    if not (low.endswith(".json") or low.endswith(".js")):
        return ["changed, and not a .json/.js file, so it must match byte for byte"]
    try:
        new, old = parse(path, cur), parse(path, base)
    except (ValueError, UnicodeDecodeError) as e:
        return [f"could not compare: {e}"]
    diffs = []
    compare(new, old, "$", diffs)
    return diffs


def take_snapshot():
    snap = {}
    for path in dirty_paths():
        data = read_current(path)
        snap[path] = None if data is None else base64.b64encode(data).decode("ascii")
    sp = snapshot_path()
    with open(sp, "w", encoding="utf-8") as f:
        json.dump(snap, f)
    print(f"snapshot saved: {len(snap)} dirty path(s) recorded in {sp}")
    return 0


def main():
    args = sys.argv[1:]
    if args not in ([], ["--snapshot"]):
        print("usage: python scripts/check_outputs.py [--snapshot]", file=sys.stderr)
        return 2
    try:
        os.chdir(git("rev-parse", "--show-toplevel").decode("utf-8", "replace").strip())
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"check_outputs: not inside a git repository: {e}", file=sys.stderr)
        return 2
    if args == ["--snapshot"]:
        try:
            return take_snapshot()
        except (OSError, subprocess.CalledProcessError) as e:
            print(f"check_outputs: could not snapshot: {e}", file=sys.stderr)
            return 2
    try:
        sp = snapshot_path()
        snap = None
        if os.path.exists(sp):
            with open(sp, encoding="utf-8") as f:
                snap = {k: (None if v is None else base64.b64decode(v)) for k, v in json.load(f).items()}
        baseline_name = "snapshot" if snap is not None else "HEAD"
        snap = snap or {}
        paths = sorted(set(dirty_paths()) | set(snap))
        problems, tolerated = [], []
        for path in paths:
            cur = read_current(path)
            head = read_head(path)
            base = snap[path] if path in snap else head
            if cur == base or cur == head:
                continue
            diffs = check_path(path, cur, base)
            if diffs:
                problems.append((path, diffs))
            else:
                tolerated.append(path)
    except (OSError, ValueError, subprocess.CalledProcessError) as e:
        print(f"check_outputs: failed: {e}", file=sys.stderr)
        return 2
    finally:
        try:
            os.remove(snapshot_path())
        except (OSError, subprocess.CalledProcessError):
            pass
    if problems:
        print(f"Generated outputs do not match the committed versions (baseline: {baseline_name}):")
        for path, diffs in problems:
            print(f"  {path}")
            for d in diffs[:MAX_DIFFS]:
                print(f"    - {d}")
        print()
        print(FIX)
        return 1
    extra = f" ({len(tolerated)} within float tolerance: {', '.join(tolerated)})" if tolerated else ""
    print(f"outputs match committed versions (baseline: {baseline_name}){extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
