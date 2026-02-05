#!/usr/bin/env python3
"""
WeChat Linux SQLCipher Key Extractor
Extracts encryption keys for all WeChat databases from process memory.

Requirements:
  - frida-tools: pipx install frida-tools (or pip install frida-tools)
  - sqlcipher: sudo apt install sqlcipher
  - ptrace enabled: sudo sysctl kernel.yama.ptrace_scope=0
  - WeChat must be running and logged in

Usage:
  python3 wechat-extract-keys.py [--output db_keys.json]
"""

import subprocess
import json
import os
import sys
import glob
import argparse
import tempfile
import time

# ── Frida script: find cipher_ctx, walk pointer chains, print candidates ───
FRIDA_JS = r"""
var pattern = "20 00 00 00 10 00 00 00 10 00 00 00 00 10 00 00";
var ranges = Process.enumerateRanges("rw-");
var ctxList = [];

for (var i = 0; i < ranges.length; i++) {
    try {
        var matches = Memory.scanSync(ranges[i].base, ranges[i].size, pattern);
        matches.forEach(function(m) { ctxList.push(m.address); });
    } catch(e) {}
}

var allKeys = {};

function isKeyLike(arr) {
    var nonzero = 0, unique = new Set();
    for (var b = 0; b < 32; b++) {
        if (arr[b] !== 0) nonzero++;
        unique.add(arr[b]);
    }
    if (nonzero < 26 || unique.size < 16) return false;
    var printable = 0;
    for (var b = 0; b < 32; b++) {
        if (arr[b] >= 0x20 && arr[b] <= 0x7e) printable++;
    }
    if (printable > 19) return false;
    return true;
}

function tryReadKey(addr) {
    try {
        var data = addr.readByteArray(32);
        var arr = new Uint8Array(data);
        if (isKeyLike(arr)) {
            var hex = Array.from(arr).map(function(b) {
                return ("0" + b.toString(16)).slice(-2);
            }).join("");
            allKeys[hex] = 1;
        }
    } catch(e) {}
}

ctxList.forEach(function(ctx) {
    for (var off = -128; off <= 256; off += 8) {
        try {
            var val = ctx.add(off).readPointer();
            if (!val.isNull() && val.compare(ptr("0x10000")) > 0 &&
                val.compare(ptr("0xffffffffffff")) < 0) {
                for (var koff = 0; koff <= 128; koff += 8)
                    tryReadKey(val.add(koff));
                for (var poff = 0; poff <= 64; poff += 8) {
                    try {
                        var val2 = val.add(poff).readPointer();
                        if (!val2.isNull() && val2.compare(ptr("0x10000")) > 0 &&
                            val2.compare(ptr("0xffffffffffff")) < 0) {
                            tryReadKey(val2);
                            for (var koff2 = 8; koff2 <= 64; koff2 += 8)
                                tryReadKey(val2.add(koff2));
                        }
                    } catch(e2) {}
                }
            }
        } catch(e) {}
    }
    for (var off = -256; off <= 512; off += 8)
        tryReadKey(ctx.add(off));
});

console.log("CTX_COUNT:" + ctxList.length);
var keys = Object.keys(allKeys);
keys.forEach(function(k) { console.log("KEY:" + k); });
console.log("DONE");
"""


def find_wechat_pid():
    for cmd in [["pgrep", "-x", "wechat"], ["pgrep", "-f", "/opt/wechat/wechat"]]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
            pids = r.stdout.strip().split()
            if pids:
                return int(pids[0])
        except Exception:
            pass
    return None


def find_active_account(pid):
    """Detect which wxid account is active by checking open file descriptors."""
    try:
        fd_dir = f"/proc/{pid}/fd"
        for fd in os.listdir(fd_dir):
            try:
                target = os.readlink(os.path.join(fd_dir, fd))
                if "db_storage" in target and target.endswith(".db"):
                    # Path: .../xwechat_files/<account_dir>/db_storage/...
                    idx = target.find("xwechat_files/")
                    if idx >= 0:
                        rest = target[idx + len("xwechat_files/"):]
                        account_dir = rest.split("/")[0]
                        if account_dir:
                            return account_dir
            except (OSError, PermissionError):
                continue
    except (OSError, PermissionError):
        pass
    return None


def find_databases(account_dir=None):
    """Find all WeChat SQLCipher databases, optionally for a specific account."""
    # Try both paths: direct ~/xwechat_files and ~/Documents/xwechat_files
    for candidate in ["~/xwechat_files", "~/Documents/xwechat_files"]:
        base = os.path.expanduser(candidate)
        if os.path.isdir(base):
            break
    if account_dir:
        search = os.path.join(base, account_dir, "db_storage/**/*.db")
    else:
        search = os.path.join(base, "*/db_storage/**/*.db")
    dbs = sorted(glob.glob(search, recursive=True))
    return dbs


def extract_candidates(pid):
    """Run frida CLI to extract key candidates."""
    with tempfile.NamedTemporaryFile(mode='w', suffix='.js', delete=False) as f:
        f.write(FRIDA_JS)
        js_path = f.name

    try:
        r = subprocess.run(
            ["frida", "-p", str(pid), "-l", js_path],
            capture_output=True, text=True, timeout=30,
            input="exit\n"  # auto-exit the REPL
        )
        output = r.stdout + r.stderr
    except subprocess.TimeoutExpired:
        output = ""
    finally:
        os.unlink(js_path)

    ctx_count = 0
    keys = []
    for line in output.split('\n'):
        line = line.strip()
        if line.startswith("CTX_COUNT:"):
            ctx_count = int(line.split(":")[1])
        elif line.startswith("KEY:"):
            keys.append(line[4:])

    return ctx_count, keys


def filter_candidates(keys):
    filtered = []
    for key in keys:
        if len(key) != 64:
            continue
        raw = bytes.fromhex(key)
        # Relaxed filters — original thresholds were too aggressive
        if sum(1 for b in raw if 0x20 <= b <= 0x7e) > 24:
            continue
        if raw.count(0) > 16:
            continue
        if len(set(raw)) < 12:
            continue
        filtered.append(key)
    return list(dict.fromkeys(filtered))


def test_key(db_path, key):
    try:
        sql = f"PRAGMA key = \"x'{key}'\";\nPRAGMA cipher_compatibility = 4;\nSELECT count(*) FROM sqlite_master;"
        r = subprocess.run(
            ["sqlcipher", db_path],
            input=sql, capture_output=True, text=True, timeout=5
        )
        if r.returncode == 0:
            lines = [l.strip() for l in r.stdout.strip().split('\n')
                     if l.strip() and l.strip() != 'ok']
            return lines[-1] if lines else "0"
    except subprocess.TimeoutExpired:
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description="Extract WeChat SQLCipher keys")
    parser.add_argument("--output", "-o", default=None,
                        help="Output JSON path (default: db_keys.json next to databases)")
    parser.add_argument("--pid", type=int, default=None,
                        help="WeChat PID (auto-detected if not specified)")
    args = parser.parse_args()

    pid = args.pid or find_wechat_pid()
    if not pid:
        print("ERROR: WeChat not running. Launch it and log in first.")
        sys.exit(1)
    print(f"WeChat PID: {pid}")

    # Detect active account from open file descriptors
    account_dir = find_active_account(pid)
    if account_dir:
        print(f"Active account: {account_dir}")
    databases = find_databases(account_dir)
    if not databases:
        # Fallback: try all accounts
        databases = find_databases()
    if not databases:
        print("ERROR: No WeChat databases found in ~/Documents/xwechat_files/")
        sys.exit(1)
    print(f"Databases: {len(databases)}")

    print("Extracting key candidates from memory...")
    ctx_count, raw_keys = extract_candidates(pid)
    print(f"  cipher_ctx structures: {ctx_count}")
    print(f"  Raw candidates: {len(raw_keys)}")

    candidates = filter_candidates(raw_keys)
    print(f"  After filtering: {len(candidates)}")

    if not candidates:
        print("ERROR: No candidates found. Is WeChat logged in?")
        sys.exit(1)

    results = {}
    tests = 0
    for db_path in databases:
        db_name = os.path.basename(db_path)
        for key in candidates:
            tests += 1
            count = test_key(db_path, key)
            if count is not None:
                results[db_name] = {"key": key, "tables": count, "path": db_path}
                print(f"  {db_name}: {key[:16]}... ({count} tables)")
                break
        else:
            print(f"  {db_name}: NOT FOUND")

    print(f"\nDone: {len(results)}/{len(databases)} databases cracked ({tests} tests)")

    if args.output:
        out_path = args.output
    else:
        db_dir = os.path.dirname(os.path.dirname(databases[0]))
        out_path = os.path.join(db_dir, "db_keys.json")

    # Extract account ID from path
    account = "unknown"
    for p in databases[0].split("/"):
        if p.startswith("wxid_"):
            account = p.split("_", 2)
            account = account[0] + "_" + account[1] if len(account) > 1 else p
            break

    output = {
        "account": account,
        "extracted_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "note": "SQLCipher raw hex keys. Use with: PRAGMA key = \"x'<key>'\"",
        "keys": {name: info["key"] for name, info in sorted(results.items())},
    }

    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"Saved to: {out_path}")

    not_found = [os.path.basename(db) for db in databases if os.path.basename(db) not in results]
    if not_found:
        print(f"NOT FOUND: {', '.join(not_found)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
