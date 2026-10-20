#!/usr/bin/env python3
"""Dragon86 shared-folder agent (runs INSIDE the CheerpX guest).

Started by the hoster page as a background process alongside the
interactive shell. Two jobs, looped forever:

1. Apply OS->guest plans: JSON files named plan-<seq>.json appear in
   the read-only inbox mount (written by the hoster page through a
   CheerpX DataDevice). Each plan is a list of ops (put/mkdir/remove/
   rename) applied into the shared folder. File contents arrive as
   content-addressed blobs ("blob-<sha256hex>") in the same inbox and
   are hash-verified before copying.

2. Publish a manifest of the shared folder (path/isDir/size/mtimeMs
   per entry, plus liveness fields) as a JSON file inside the shared
   folder itself, where the hoster page can read it back with
   IDBDevice.readFileAsBlob — CheerpX gives JS no directory listing
   for that device, so the manifest IS the listing.

The __TOKEN__ placeholders are substituted from src/config.ts before
this file is written into the inbox, so config stays the single
source of truth. stdio is redirected to the agent log (in the shared
folder) as the very first step: the interactive console belongs to
the user's shell and must never see this process, nor it the user's
keystrokes.
"""

import hashlib
import json
import os
import shutil
import sys
import time
import traceback

SHARED_DIR = "__SHARED_DIR__"
INBOX_DIR = "__INBOX_DIR__"
MANIFEST_NAME = "__MANIFEST_NAME__"
LOG_NAME = "__LOG_NAME__"
INTERVAL_S = float("__INTERVAL_S__")

MANIFEST_PATH = os.path.join(SHARED_DIR, MANIFEST_NAME)
MANIFEST_TMP = MANIFEST_PATH + ".tmp-agent"
LOG_PATH = os.path.join(SHARED_DIR, LOG_NAME)
TMP_SUFFIX = ".tmp-agent"
MAX_LOG_BYTES = 256 * 1024


def setup_stdio():
    """Detach from the console before doing anything observable."""
    devnull = os.open("/dev/null", os.O_RDONLY)
    os.dup2(devnull, 0)
    mode = "w"
    try:
        if os.path.getsize(LOG_PATH) < MAX_LOG_BYTES:
            mode = "a"
    except OSError:
        pass
    log = open(LOG_PATH, mode, buffering=1)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    sys.stdout = log
    sys.stderr = log


def log(msg):
    print("[agent %s] %s" % (time.strftime("%H:%M:%S"), msg), flush=True)


def safe_join(rel):
    """Resolve a share-relative path under SHARED_DIR; None = escape."""
    parts = []
    for seg in str(rel).split("/"):
        if seg in ("", "."):
            continue
        if seg == "..":
            if not parts:
                return None
            parts.pop()
        else:
            parts.append(seg)
    if not parts:
        return SHARED_DIR
    return os.path.join(SHARED_DIR, *parts)


def apply_op(op):
    kind = op.get("op")
    if kind == "put":
        target = safe_join(op["path"])
        staged = os.path.join(INBOX_DIR, os.path.basename(str(op["staged"])))
        if target is None or target == SHARED_DIR:
            raise ValueError("bad put path %r" % (op.get("path"),))
        with open(staged, "rb") as f:
            data = f.read()
        expected = os.path.basename(staged)
        if expected.startswith("blob-"):
            digest = hashlib.sha256(data).hexdigest()
            if digest != expected[len("blob-"):]:
                raise ValueError("staged blob hash mismatch for %s" % staged)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        tmp = target + TMP_SUFFIX
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, target)
        mtime_ms = op.get("mtimeMs")
        if isinstance(mtime_ms, (int, float)):
            ns = int(mtime_ms * 1_000_000)
            os.utime(target, ns=(ns, ns))
    elif kind == "mkdir":
        target = safe_join(op["path"])
        if target is None:
            raise ValueError("bad mkdir path %r" % (op.get("path"),))
        os.makedirs(target, exist_ok=True)
    elif kind == "remove":
        target = safe_join(op["path"])
        if target is None or target == SHARED_DIR:
            raise ValueError("bad remove path %r" % (op.get("path"),))
        if os.path.isdir(target) and not os.path.islink(target):
            shutil.rmtree(target)
        elif os.path.lexists(target):
            os.unlink(target)
    elif kind == "rename":
        src = safe_join(op["path"])
        dst = safe_join(op["to"])
        if src is None or dst is None or dst == SHARED_DIR:
            raise ValueError("bad rename %r -> %r" % (op.get("path"), op.get("to")))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.replace(src, dst)
    else:
        raise ValueError("unknown op %r" % (kind,))


def apply_plans(applied):
    """Apply every plan with seq > applied, in order. Returns new applied."""
    try:
        names = os.listdir(INBOX_DIR)
    except OSError:
        return applied
    seqs = []
    for name in names:
        if name.startswith("plan-") and name.endswith(".json"):
            try:
                seqs.append(int(name[len("plan-"):-len(".json")]))
            except ValueError:
                continue
    for seq in sorted(seqs):
        if seq <= applied:
            continue
        path = os.path.join(INBOX_DIR, "plan-%d.json" % seq)
        with open(path, "r", encoding="utf-8") as f:
            plan = json.load(f)
        for op in plan.get("ops", []):
            try:
                apply_op(op)
            except Exception:
                # One bad op must not wedge sync: log it, keep going.
                # The hoster re-diffs next cycle and re-plans what is
                # still out of sync.
                log("op failed in plan %d: %r" % (seq, op))
                traceback.print_exc()
        applied = seq
        log("applied plan %d (%d ops)" % (seq, len(plan.get("ops", []))))
    return applied


def encodable(name):
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def scan():
    entries = []
    for dirpath, dirnames, filenames in os.walk(SHARED_DIR):
        dirnames.sort()
        # Never descend into symlinked dirs; skip symlinks entirely
        # (the protocol has no link concept in v1).
        dirnames[:] = [
            d for d in dirnames
            if not os.path.islink(os.path.join(dirpath, d)) and encodable(d)
        ]
        rel_dir = os.path.relpath(dirpath, SHARED_DIR)
        for d in dirnames:
            full = os.path.join(dirpath, d)
            st = os.stat(full)
            rel = d if rel_dir == "." else rel_dir + "/" + d
            entries.append({
                "path": rel, "isDir": True, "size": 0,
                "mtimeMs": st.st_mtime_ns // 1_000_000,
            })
        for name in sorted(filenames):
            if not encodable(name):
                continue
            if rel_dir == "." and name in (MANIFEST_NAME, LOG_NAME):
                continue
            if name == MANIFEST_NAME + ".tmp-agent" or name.endswith(TMP_SUFFIX):
                continue
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                continue
            try:
                st = os.stat(full)
            except OSError:
                continue
            if not os.path.isfile(full):
                continue
            rel = name if rel_dir == "." else rel_dir + "/" + name
            entries.append({
                "path": rel, "isDir": False, "size": st.st_size,
                "mtimeMs": st.st_mtime_ns // 1_000_000,
            })
    entries.sort(key=lambda e: e["path"])
    return entries


def read_applied_from_manifest():
    try:
        with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
            return int(json.load(f).get("appliedPlan", 0))
    except Exception:
        return 0


def main():
    setup_stdio()
    boot_id = hashlib.sha256(
        ("%d-%d" % (time.time_ns(), os.getpid())).encode()
    ).hexdigest()[:12]
    applied = read_applied_from_manifest()
    cycle = 0
    log("agent up bootId=%s appliedPlan=%d shared=%s inbox=%s"
        % (boot_id, applied, SHARED_DIR, INBOX_DIR))
    while True:
        last_error = None
        try:
            applied = apply_plans(applied)
            entries = scan()
        except Exception as exc:  # keep the loop alive no matter what
            last_error = "%s: %s" % (type(exc).__name__, exc)
            log("cycle failed: %s" % last_error)
            traceback.print_exc()
            entries = None
        if entries is not None:
            manifest = {
                "v": 1,
                "bootId": boot_id,
                "cycle": cycle,
                "appliedPlan": applied,
                "generatedAtMs": int(time.time() * 1000),
                "lastError": last_error,
                "entries": entries,
            }
            try:
                with open(MANIFEST_TMP, "w", encoding="utf-8") as f:
                    json.dump(manifest, f, separators=(",", ":"))
                os.replace(MANIFEST_TMP, MANIFEST_PATH)
            except Exception:
                traceback.print_exc()
        cycle += 1
        time.sleep(INTERVAL_S)


if __name__ == "__main__":
    main()
