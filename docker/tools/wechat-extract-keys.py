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
import struct

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
    if (nonzero < 20 || unique.size < 10) return false;
    var printable = 0;
    for (var b = 0; b < 32; b++) {
        if (arr[b] >= 0x20 && arr[b] <= 0x7e) printable++;
    }
    if (printable > 26) return false;
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


FILTER_LEVELS = [
    # (max_printable, max_zeros, min_unique) — strict to relaxed
    (19, 6, 16),   # Level 0: strict
    (24, 12, 12),  # Level 1: moderate (previous default)
    (28, 18, 8),   # Level 2: relaxed
]


def filter_candidates(keys, level=1):
    max_printable, max_zeros, min_unique = FILTER_LEVELS[level]
    filtered = []
    for key in keys:
        if len(key) != 64:
            continue
        raw = bytes.fromhex(key)
        if sum(1 for b in raw if 0x20 <= b <= 0x7e) > max_printable:
            continue
        if raw.count(0) > max_zeros:
            continue
        if len(set(raw)) < min_unique:
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


# ── Image encryption key extraction (via /proc/pid/mem, no Frida needed) ──────
# WeChat Linux 4.x (BuildID: 71996acd55aadbb8cb3011344035702609180cf1)

GOT_CONFIG_OFFSET = 0x8034838       # GOT entry for config singleton pointer
CONFIG_VALUE_KEY_OFFSET = 0x1F8     # offset of obfuscated key string within ConfigValue
XOR_BYTE_GLOBAL_OFFSET = 0x8049530  # global: XOR key byte (lazy-init, zero before first use)

IMAGE_XOR_MASK = bytes.fromhex(
    "5e780583f2236b8540bfebb8ab903062"
    "fc5a071a767de41a637075835ebfac1e"
)


def get_wechat_module_base(pid):
    """Find the base address of the 'wechat' module from /proc/pid/maps."""
    with open(f"/proc/{pid}/maps") as f:
        for line in f:
            if "/wechat" in line:
                return int(line.split("-")[0], 16)
    raise RuntimeError("wechat module not found in /proc/pid/maps")


def read_mem(pid, addr, size):
    """Read `size` bytes from process memory at `addr`."""
    with open(f"/proc/{pid}/mem", "rb") as f:
        f.seek(addr)
        return f.read(size)


def read_u64(pid, addr):
    return struct.unpack("<Q", read_mem(pid, addr, 8))[0]


def read_u8(pid, addr):
    return read_mem(pid, addr, 1)[0]


def read_std_string(pid, addr):
    """Read a libc++ std::string (SSO format) from memory.

    Layout:
    - byte 0: flag byte. If bit 0 set -> "long" (heap-allocated).
      Otherwise -> "short" (inline, length = flag >> 1).
    - Long: bytes 8-15 = length (u64), bytes 16-23 = data pointer (u64)
    - Short: bytes 1..length = inline data
    """
    fb = read_u8(pid, addr)
    if fb & 1:  # long string
        length = read_u64(pid, addr + 8)
        data_ptr = read_u64(pid, addr + 16)
        return read_mem(pid, data_ptr, length)
    else:  # short string (SSO)
        length = fb >> 1
        if length == 0:
            return b""
        return read_mem(pid, addr + 1, length)


def deobfuscate_image_key(obfuscated):
    """XOR the obfuscated key bytes with the known mask."""
    result = bytearray(len(obfuscated))
    for i in range(len(obfuscated)):
        result[i] = obfuscated[i] ^ IMAGE_XOR_MASK[i % len(IMAGE_XOR_MASK)]
    return result.decode("ascii")


def extract_image_aes_key(pid):
    """Extract the image AES key from WeChat's config singleton in memory.

    Walks the config object at depth 2, looking for a std::string of length 32
    at offset +0x1F8 that XOR-deobfuscates to a valid 32-char hex string.

    Returns: 32-char hex string (e.g. "2db48e820850a7cff445fb86ce85a4fa")
    """
    base = get_wechat_module_base(pid)

    config_ptr = read_u64(pid, base + GOT_CONFIG_OFFSET)
    if config_ptr == 0:
        raise RuntimeError("Config singleton is NULL")

    # Scan depth-1 pointers in config object
    for off1 in range(0, 0x800, 8):
        try:
            ptr1 = read_u64(pid, config_ptr + off1)
            if ptr1 == 0 or ptr1 < 0x1000:
                continue
            # Scan depth-2 pointers
            for off2 in range(0, 0x200, 8):
                try:
                    ptr2 = read_u64(pid, ptr1 + off2)
                    if ptr2 == 0 or ptr2 < 0x1000:
                        continue
                    try:
                        raw = read_std_string(pid, ptr2 + CONFIG_VALUE_KEY_OFFSET)
                        if len(raw) == 32:
                            decoded = deobfuscate_image_key(raw)
                            if all(c in "0123456789abcdef" for c in decoded):
                                return decoded
                    except Exception:
                        pass
                except Exception:
                    pass
        except Exception:
            pass

    raise RuntimeError("Could not find AES key in config object. "
                       "Make sure WeChat has sent/received at least one image.")


def extract_image_xor_byte(pid):
    """Read the XOR byte directly from WeChat's global config memory.

    Returns the byte value, or None if not yet initialized (zero).
    """
    base = get_wechat_module_base(pid)
    xor_byte = read_u8(pid, base + XOR_BYTE_GLOBAL_OFFSET)
    if xor_byte == 0:
        return None  # not yet initialized (lazy-init)
    return xor_byte


def find_xor_byte_from_dat(dat_path, aes_key_16):
    """Derive the XOR byte from a .dat file by AES-decrypting the head
    and checking known image trailers (JPEG FFD9, PNG IEND)."""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding

    with open(dat_path, "rb") as f:
        dat = f.read()

    if dat[:6] != bytes.fromhex("070856320807"):
        raise ValueError("Not a WeChat .dat file")

    enc_chunk = int.from_bytes(dat[6:10], "little")
    aes_ct = dat[15:15 + enc_chunk + 16]

    cipher = Cipher(algorithms.AES(aes_key_16), modes.ECB())
    dec = cipher.decryptor()
    dec_padded = dec.update(aes_ct) + dec.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    dec_head = unpadder.update(dec_padded) + unpadder.finalize()

    # JPEG: last 2 bytes are FF D9
    if dec_head[:2] == b"\xff\xd8":
        c1 = dat[-2] ^ 0xFF
        c2 = dat[-1] ^ 0xD9
        if c1 == c2:
            return c1

    # PNG: last 8 bytes are IEND chunk (49 45 4E 44 AE 42 60 82)
    if dec_head[:4] == b"\x89PNG":
        expected = bytes([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82])
        tail = dat[-8:]
        xb = tail[0] ^ expected[0]
        if all(tail[i] ^ xb == expected[i] for i in range(8)):
            return xb

    raise RuntimeError("Could not determine XOR byte from file trailer")


def find_any_dat_file(account_dir):
    """Find any full-size .dat image file for the account."""
    for candidate in ["~/xwechat_files", "~/Documents/xwechat_files"]:
        base = os.path.expanduser(candidate)
        search = os.path.join(base, account_dir, "msg/attach/**/Img/*.dat")
        files = glob.glob(search, recursive=True)
        for f in files:
            if not f.endswith(("_t.dat", "_h.dat", "_b.dat")):
                return f
    return None


def extract_image_keys(pid, account_dir):
    """Extract image encryption keys from memory.

    AES key is always extracted from config singleton.
    XOR byte is attempted from memory (may be zero if lazy-init not triggered).
    If XOR byte unavailable, it will be derived lazily at media query time.

    Returns: dict with "_image_aes" and optionally "_image_xor".
    """
    print("\nExtracting image encryption keys from memory...")
    result = {}

    aes_key_hex = extract_image_aes_key(pid)
    result["_image_aes"] = aes_key_hex
    print(f"  AES key: {aes_key_hex[:16]}... (32-char hex string)")

    # Try memory for XOR byte (may be 0 if lazy-init not triggered)
    xor_byte = extract_image_xor_byte(pid)
    if xor_byte is not None:
        result["_image_xor"] = f"{xor_byte:02x}"
        print(f"  XOR byte: 0x{xor_byte:02x} (from memory)")
    else:
        print("  XOR byte: not yet initialized (will derive on first image access)")

    return result


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

    results = {}
    tests = 0
    remaining_dbs = list(databases)
    prev_candidates = set()

    for level in range(len(FILTER_LEVELS)):
        candidates = filter_candidates(raw_keys, level=level)
        # Only try candidates not already tested in a previous pass
        new_candidates = [k for k in candidates if k not in prev_candidates]
        prev_candidates.update(candidates)

        if not new_candidates and level == 0:
            print("ERROR: No candidates found. Is WeChat logged in?")
            sys.exit(1)

        if not new_candidates:
            continue

        label = ["strict", "moderate", "relaxed"][level]
        print(f"\n  Pass {level} ({label}): {len(new_candidates)} new candidates, {len(remaining_dbs)} DBs remaining")

        still_remaining = []
        for db_path in remaining_dbs:
            db_name = os.path.basename(db_path)
            found = False
            for key in new_candidates:
                tests += 1
                count = test_key(db_path, key)
                if count is not None:
                    results[db_name] = {"key": key, "tables": count, "path": db_path}
                    print(f"  {db_name}: {key[:16]}... ({count} tables)")
                    found = True
                    break
            if not found:
                still_remaining.append(db_path)
        remaining_dbs = still_remaining

        if not remaining_dbs:
            break

    for db_path in remaining_dbs:
        print(f"  {os.path.basename(db_path)}: NOT FOUND")

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

    # Image encryption keys (from process memory, not Frida)
    try:
        image_keys = extract_image_keys(pid, account_dir)
        output["keys"].update(image_keys)
    except Exception as e:
        print(f"  Image key extraction failed: {e}")

    with open(out_path, 'w') as f:
        json.dump(output, f, indent=2)
    print(f"Saved to: {out_path}")

    not_found = [os.path.basename(db) for db in databases if os.path.basename(db) not in results]
    if not_found:
        print(f"NOT FOUND: {', '.join(not_found)}")
        sys.exit(1)


if __name__ == "__main__":
    main()
