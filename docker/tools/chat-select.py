#!/usr/bin/env python3
"""
Programmatic chat selection for WeChat Linux.

Selects a chat by username (e.g. "wxid_xxx", "123@chatroom", "filehelper")
without requiring manual user interaction. Works on both aarch64 and x86_64.

Usage:
    chat-select <username>          # Select a chat, output JSON result
    chat-select --list              # List all sessions as JSON

Output (JSON):
    {"ok": true, "username": "filehelper", "index": 3}
    {"ok": false, "error": "Chat not found in session list"}
    {"ok": true, "sessions": {"filehelper": 0, "wxid_xxx": 1, ...}}
"""
import subprocess
import time
import sys
import json
import os
import re
import shutil

# ── Per-build constants ──────────────────────────────────────────────────────
# Keyed by first 8 hex chars of ELF BuildID (same pattern as extract-keys.py).

BUILD_PROFILES = {
    # WeChat Linux 4.x aarch64 (BuildID: 71996acd...)
    "71996acd": {
        "SELECT_SESSION": 0x38bce80,
        "USERNAME_OFF": 0x120,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x7b39db8,
        "CTRL_OFF": 0xe8,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x120,
    },
    # WeChat Linux 4.x x86_64 (BuildID: 20420b6d...)
    "20420b6d": {
        "SELECT_SESSION": 0x3907960,
        "USERNAME_OFF": 0x138,
        "ELEM_SIZE": 16,
        "MANAGER_VT_OFF": 0x7fc2f50,
        "CTRL_OFF": 0x180,
        "CUR_SESS_OFF": 0x40,
        "CUR_SESS_UNAME_OFF": 0x98,
    },
}

FRIDA_BIN = shutil.which("frida") or "/usr/local/bin/frida"


def log(msg):
    """Log to stderr (not mixed with JSON stdout)."""
    print(msg, file=sys.stderr, flush=True)


_GH_RE = re.compile(r'^gh_[0-9a-f]+$')

def is_official_account(username):
    """WeChat official/service accounts match gh_<hex>."""
    return bool(_GH_RE.match(username))


def result_json(ok, **kwargs):
    """Print JSON result and exit."""
    out = {"ok": ok, **kwargs}
    print(json.dumps(out))
    sys.exit(0 if ok else 1)


def get_pid():
    """Get WeChat PID."""
    for cmd in [["pgrep", "-x", "wechat"], ["pgrep", "-f", "/opt/wechat/wechat"]]:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
            pids = r.stdout.strip().split()
            if pids:
                return pids[0]
        except Exception:
            pass
    return None


def get_build_id(pid):
    """Read the WeChat binary's BuildID from /proc/pid/maps + readelf."""
    wechat_path = None
    try:
        with open(f"/proc/{pid}/maps") as f:
            for line in f:
                if "/wechat" in line and line.strip().endswith("/wechat"):
                    wechat_path = line.split()[-1]
                    break
    except Exception:
        pass
    if not wechat_path:
        return None
    try:
        r = subprocess.run(["readelf", "-n", wechat_path], capture_output=True, text=True)
        for line in r.stdout.split("\n"):
            if "Build ID:" in line:
                return line.split("Build ID:")[1].strip()
    except Exception:
        pass
    return None


def get_profile(pid):
    """Look up build profile by BuildID prefix."""
    build_id = get_build_id(pid)
    if not build_id:
        return None, "Could not read WeChat BuildID"
    prefix = build_id[:8]
    log(f"[chat-select] BuildID: {build_id[:16]}... prefix={prefix}")
    profile = BUILD_PROFILES.get(prefix)
    if not profile:
        return None, f"Unknown BuildID prefix: {prefix}. Known: {list(BUILD_PROFILES.keys())}"
    log(f"[chat-select] Profile: SELECT_SESSION=0x{profile['SELECT_SESSION']:x} USERNAME_OFF=0x{profile['USERNAME_OFF']:x}")
    return profile, None


def find_chat_item_from_a11y():
    """Use a11y-dump to find a clickable chat list item. Returns (x, y) or None."""
    try:
        log("[chat-select] Getting a11y tree...")
        r = subprocess.run(
            ["/opt/tools/a11y-dump", "--format", "json"],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "QT_ACCESSIBILITY": "1", "QT_LINUX_ACCESSIBILITY_ALWAYS_ON": "1"}
        )
        if r.returncode != 0:
            log(f"[chat-select] a11y-dump failed: {r.stderr}")
            return None

        tree = json.loads(r.stdout)
        # Walk tree to find: list[name="Chats"] > list-item with bounds
        items = []
        _find_chat_list_items(tree, items, in_chat_list=False)
        if not items:
            log("[chat-select] No list-item found in Chats list")
            return None

        # Return center of the first item with valid bounds
        item = items[0]
        b = item["bounds"]
        cx = b["x"] + b["width"] // 2
        cy = b["y"] + b["height"] // 2
        log(f"[chat-select] Found chat item: name={item.get('name', '?')!r} bounds={b} -> click ({cx}, {cy})")
        return (cx, cy)
    except Exception as e:
        log(f"[chat-select] a11y error: {e}")
        return None


def _find_chat_list_items(node, items, in_chat_list):
    """Recursively find list-item nodes inside the Chats list."""
    if not node or not isinstance(node, dict):
        return

    role = node.get("role", "")
    name = node.get("name", "")

    # Detect if we're inside the chat list
    if role == "list" and name == "Chats":
        in_chat_list = True

    if in_chat_list and role == "list-item" and node.get("bounds"):
        items.append(node)
        if len(items) >= 1:
            return  # Only need one

    for child in node.get("children", []):
        _find_chat_list_items(child, items, in_chat_list)
        if len(items) >= 1:
            return


def write_js(path, content):
    with open(path, "w") as f:
        f.write(content)


READ_STD_STRING_JS = """
function readStdString(addr) {
    try {
        if (!addr || addr.isNull() || addr.compare(ptr(0x10000)) < 0) return null;
        var b0 = addr.readU8();
        if (b0 & 1) {
            var len = Number(addr.add(8).readU64());
            var dp = addr.add(16).readPointer();
            if (len > 0 && len < 512 && dp && !dp.isNull()) return dp.readUtf8String(len);
        } else {
            var len = b0 >> 1;
            if (len > 0 && len <= 22) return addr.add(1).readUtf8String(len);
        }
    } catch(e) {}
    return null;
}
"""


def run_frida_script(pid, script_path, timeout=30, stop_on="SCRIPT_DONE"):
    """Run a frida script, return output lines."""
    proc = subprocess.Popen(
        [FRIDA_BIN, "-p", pid, "-l", script_path, "--runtime=v8", "-q"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE, text=True, bufsize=1,
    )
    lines = []
    start = time.time()
    try:
        while time.time() - start < timeout:
            line = proc.stdout.readline()
            if not line:
                break
            line = line.rstrip()
            lines.append(line)
            if stop_on and stop_on in line:
                break
    except Exception:
        pass
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
        time.sleep(1)  # ensure frida fully detaches
    return lines


def run_frida_bg(pid, script_path):
    """Start frida in background, wait for READY, return process."""
    proc = subprocess.Popen(
        [FRIDA_BIN, "-p", pid, "-l", script_path, "--runtime=v8"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE, text=True, bufsize=1,
    )
    start = time.time()
    while time.time() - start < 10:
        line = proc.stdout.readline()
        if not line:
            break
        if "READY" in line:
            break
    return proc


def kill_frida(proc):
    try:
        proc.stdin.close()
    except Exception:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except Exception:
        proc.kill()


def enumerate_sessions(pid, profile):
    """Scan heap for session vector + current selection.

    Returns (dict of {username: index}, vector_base_hex, vector_count, current_sel_username|None).
    """
    username_off = profile["USERNAME_OFF"]
    elem_size = profile["ELEM_SIZE"]
    manager_vt_off = profile.get("MANAGER_VT_OFF")
    ctrl_off = profile.get("CTRL_OFF")
    cur_sess_off = profile.get("CUR_SESS_OFF")
    cur_sess_uname_off = profile.get("CUR_SESS_UNAME_OFF")

    # Build current-selection detection JS (only if offsets available)
    current_sel_js = ""
    if manager_vt_off is not None:
        current_sel_js = f"""
// --- Current selection detection ---
var MANAGER_VT = b.add(0x{manager_vt_off:x});
var CTRL_OFF = 0x{ctrl_off:x};
var CUR_SESS_OFF = 0x{cur_sess_off:x};
var CUR_SESS_UNAME_OFF = 0x{cur_sess_uname_off:x};

function detectCurrentSelection() {{
    try {{
        // Heap scan for manager vtable pointer
        var vtPattern = ptrToPattern(MANAGER_VT);
        var found = null;
        Process.enumerateRanges("rw-").forEach(function(range) {{
            if (found || range.size > 200*1024*1024) return;
            try {{
                Memory.scanSync(range.base, range.size, vtPattern).forEach(function(hit) {{
                    if (found) return;
                    try {{
                        var ctrl = hit.address.add(CTRL_OFF).readPointer();
                        if (ctrl.isNull() || ctrl.compare(ptr(0x10000)) < 0) return;
                        var curSess = ctrl.add(CUR_SESS_OFF).readPointer();
                        if (curSess.isNull() || curSess.compare(ptr(0x10000)) < 0) return;
                        var uname = readStdString(curSess.add(CUR_SESS_UNAME_OFF));
                        if (uname && uname.length >= 2) {{
                            found = uname;
                        }}
                    }} catch(e) {{}}
                }});
            }} catch(e) {{}}
        }});
        return found;
    }} catch(e) {{
        return null;
    }}
}}

var curSel = detectCurrentSelection();
if (curSel) {{
    console.log("CURRENT_SEL " + curSel);
}} else {{
    console.log("CURRENT_SEL_NONE");
}}
"""

    write_js("/tmp/_cs_enum.js", f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var UNAME_OFF = 0x{username_off:x};
var ELEM_SZ = {elem_size};
{READ_STD_STRING_JS}

function ptrToPattern(p) {{
    var buf = Memory.alloc(8);
    buf.writePointer(p);
    var hex = [];
    for (var i = 0; i < 8; i++) hex.push(("0" + buf.add(i).readU8().toString(16)).slice(-2));
    return hex.join(" ");
}}

var fhPattern = "66 69 6c 65 68 65 6c 70 65 72 00";
var sessionElements = [];

Process.enumerateRanges("rw-").forEach(function(range) {{
    if (range.size > 200*1024*1024) return;
    try {{
        Memory.scanSync(range.base, range.size, fhPattern).forEach(function(hit) {{
            var cand = hit.address.sub(UNAME_OFF + 1);
            try {{
                var u = readStdString(cand.add(UNAME_OFF));
                if (u === "filehelper") sessionElements.push(cand);
            }} catch(e) {{}}
        }});
    }} catch(e) {{}}
}});

if (sessionElements.length === 0) {{
    console.log("ERROR: filehelper session element not found");
    console.log("SCRIPT_DONE");
}} else {{
    var vectorBegin = null;
    var vectorEnd = null;

    for (var sei = 0; sei < sessionElements.length && !vectorBegin; sei++) {{
        var sessElem = sessionElements[sei];
        var pattern = ptrToPattern(sessElem);

        Process.enumerateRanges("rw-").forEach(function(range) {{
            if (vectorBegin || range.size > 200*1024*1024) return;
            try {{
                Memory.scanSync(range.base, range.size, pattern).forEach(function(hit) {{
                    if (vectorBegin) return;
                    var elemAddr = hit.address;
                    var validNeighbors = 0;
                    for (var delta = -3; delta <= 3; delta++) {{
                        if (delta === 0) continue;
                        try {{
                            var neighbor = elemAddr.add(delta * ELEM_SZ).readPointer();
                            if (!neighbor.isNull() && neighbor.compare(ptr(0x10000)) >= 0) {{
                                var nu = readStdString(neighbor.add(UNAME_OFF));
                                if (nu && nu.length >= 2) validNeighbors++;
                            }}
                        }} catch(e) {{}}
                    }}
                    if (validNeighbors < 3) return;

                    var start = elemAddr;
                    for (var back = 1; back < 300; back++) {{
                        var prev = elemAddr.sub(back * ELEM_SZ);
                        try {{
                            var pp = prev.readPointer();
                            if (pp.isNull() || pp.compare(ptr(0x10000)) < 0) break;
                            start = prev;
                        }} catch(e) {{ break; }}
                    }}
                    var end = elemAddr.add(ELEM_SZ);
                    for (var fwd = 1; fwd < 300; fwd++) {{
                        var next = elemAddr.add(fwd * ELEM_SZ);
                        try {{
                            var np = next.readPointer();
                            if (np.isNull() || np.compare(ptr(0x10000)) < 0) break;
                            end = next.add(ELEM_SZ);
                        }} catch(e) {{ break; }}
                    }}
                    var count = end.sub(start).toInt32() / ELEM_SZ;
                    if (count > 10) {{
                        vectorBegin = start;
                        vectorEnd = end;
                    }}
                }});
            }} catch(e) {{}}
        }});
    }}

    if (!vectorBegin) {{
        console.log("ERROR: session vector not found");
        console.log("SCRIPT_DONE");
    }} else {{
        var count = vectorEnd.sub(vectorBegin).toInt32() / ELEM_SZ;
        console.log("VECTOR " + vectorBegin + " count=" + count);
        for (var i = 0; i < count; i++) {{
            var ep = vectorBegin.add(i * ELEM_SZ).readPointer();
            if (ep.isNull()) continue;
            var u = readStdString(ep.add(UNAME_OFF));
            if (u) console.log("SESSION " + i + " " + u);
        }}
{current_sel_js}
        console.log("SCRIPT_DONE");
    }}
}}
""")

    for attempt in range(3):
        if attempt > 0:
            log(f"[chat-select] Enumerate retry {attempt}...")
            time.sleep(2)
        log(f"[chat-select] Running Frida enumerate script (attempt {attempt})...")
        lines = run_frida_script(pid, "/tmp/_cs_enum.js", timeout=45)
        # Log all Frida output for debugging
        for line in lines:
            log(f"[frida-enum] {line}")
        # Parse raw sessions from Frida output (raw vector index -> username)
        raw_sessions = []  # [(raw_index, username), ...] in vector order
        vector_base = None
        vector_count = 0
        current_sel = None
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("VECTOR "):
                parts = stripped.split()
                vector_base = parts[1]
                vector_count = int(parts[2].split("=")[1])
            elif stripped.startswith("CURRENT_SEL ") and not stripped.startswith("CURRENT_SEL_NONE"):
                current_sel = stripped.split(None, 1)[1]
            elif stripped.startswith("SESSION"):
                parts = stripped.split(None, 2)
                if len(parts) >= 3:
                    raw_sessions.append((int(parts[1]), parts[2]))

        if raw_sessions:
            raw_sessions.sort(key=lambda x: x[0])

            # Log raw vector contents
            gh_count = sum(1 for _, u in raw_sessions if is_official_account(u))
            log(f"[chat-select] Raw vector: {len(raw_sessions)} sessions ({gh_count} official accounts), base={vector_base} count={vector_count}")
            for raw_idx, uname in raw_sessions:
                tag = " [official]" if is_official_account(uname) else ""
                log(f"[chat-select]   raw[{raw_idx:3d}] {uname}{tag}")

            # Build filtered index: skip official accounts, re-number from 0
            # selectSession() uses indices that exclude official accounts
            sessions = {}
            filtered_idx = 0
            for raw_idx, uname in raw_sessions:
                if is_official_account(uname):
                    continue
                sessions[uname] = filtered_idx
                filtered_idx += 1

            if current_sel:
                log(f"[chat-select] Current selection: {current_sel}")

            log(f"[chat-select] Filtered: {len(sessions)} sessions (excluded {gh_count} official accounts)")
            for i, (uname, idx) in enumerate(sorted(sessions.items(), key=lambda x: x[1])):
                if i < 15:
                    log(f"[chat-select]   [{idx:3d}] {uname}")
                elif i == 15:
                    log(f"[chat-select]   ... and {len(sessions) - 15} more")

            return sessions, vector_base, vector_count, current_sel
    return {}, None, 0, None


def select_by_index(pid, profile, target_index, click_coords, vector_base, vector_count):
    """Hook selectSession, click, hook replaces index. Returns True on success."""
    select_session = profile["SELECT_SESSION"]
    username_off = profile["USERNAME_OFF"]
    elem_size = profile["ELEM_SIZE"]

    log(f"[chat-select] Hooking selectSession at offset 0x{select_session:x}, target_index={target_index}")
    log(f"[chat-select] Vector base={vector_base} count={vector_count}")

    write_js("/tmp/_cs_select.js", f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var addr = b.add(0x{select_session:x});
var TARGET = {target_index};
var UNAME_OFF = 0x{username_off:x};
var ELEM_SZ = {elem_size};
var VECTOR_BASE = ptr("{vector_base}");
var VECTOR_COUNT = {vector_count};

{READ_STD_STRING_JS}

// Read username at RAW vector index
function readRawUsername(rawIdx) {{
    try {{
        if (rawIdx < 0 || rawIdx >= VECTOR_COUNT) return "<oob:" + rawIdx + "/" + VECTOR_COUNT + ">";
        var ep = VECTOR_BASE.add(rawIdx * ELEM_SZ).readPointer();
        if (ep.isNull()) return "<null>";
        var u = readStdString(ep.add(UNAME_OFF));
        return u || "<unreadable>";
    }} catch(e) {{
        return "<err:" + e + ">";
    }}
}}

// Map filtered index (excluding gh_ accounts) to username
function readFilteredUsername(filteredIdx) {{
    var fi = 0;
    for (var ri = 0; ri < VECTOR_COUNT; ri++) {{
        try {{
            var ep = VECTOR_BASE.add(ri * ELEM_SZ).readPointer();
            if (ep.isNull()) continue;
            var u = readStdString(ep.add(UNAME_OFF));
            if (!u) continue;
            if (/^gh_[0-9a-f]+$/.test(u)) continue;  // skip official accounts
            if (fi === filteredIdx) return u + " (raw=" + ri + ")";
            fi++;
        }} catch(e) {{}}
    }}
    return "<oob-filtered:" + filteredIdx + ">";
}}

console.log("HOOK at " + addr + " (base+0x{select_session:x})");
console.log("READY target_filtered=" + TARGET + " -> " + readFilteredUsername(TARGET));

// Also dump first few raw entries for cross-reference
for (var di = 0; di < Math.min(5, VECTOR_COUNT); di++) {{
    console.log("  raw[" + di + "] = " + readRawUsername(di));
}}

var count = 0;
Interceptor.attach(addr, {{
    onEnter: function(args) {{
        var orig = args[1].toInt32();
        var origFiltered = readFilteredUsername(orig);
        var targetFiltered = readFilteredUsername(TARGET);
        console.log("HOOK_CALL #" + count + " args[1]=" + orig + " (" + origFiltered + ")");
        if (count >= 2) {{
            console.log("SKIP (already redirected twice)");
            return;
        }}
        console.log("REDIRECT " + orig + " (" + origFiltered + ") -> " + TARGET + " (" + targetFiltered + ")");
        args[1] = ptr(TARGET);
        count++;
    }}
}});
""")

    proc = run_frida_bg(pid, "/tmp/_cs_select.js")
    time.sleep(0.5)

    # Click the chat item via the click tool
    cx, cy = click_coords
    log(f"[chat-select] Clicking at ({cx}, {cy})...")
    click_result = subprocess.run(["/opt/tools/click", str(cx), str(cy)],
                                 timeout=5, capture_output=True, text=True)
    log(f"[chat-select] Click result: {click_result.stdout.strip()}")

    # Read output looking for REDIRECT confirmation
    lines = []
    start = time.time()
    while time.time() - start < 5:
        line = proc.stdout.readline()
        if not line:
            break
        line = line.rstrip()
        lines.append(line)
        log(f"[frida-hook] {line}")
        if "REDIRECT" in line:
            break

    kill_frida(proc)

    redirected = any("REDIRECT" in l for l in lines)
    if not redirected:
        log(f"[chat-select] No REDIRECT seen in hook output. All lines: {lines}")
    return redirected


def main():
    # Parse args: chat-select [--force] [--click-xy X Y] [--list] <username>
    args = sys.argv[1:]
    if not args:
        result_json(False, error="Usage: chat-select [--force] [--click-xy X Y] <username> | chat-select --list")

    force = False
    click_xy = None
    positional = []

    i = 0
    while i < len(args):
        if args[i] == "--force":
            force = True
            i += 1
        elif args[i] == "--click-xy":
            if i + 2 >= len(args):
                result_json(False, error="--click-xy requires X Y arguments")
            click_xy = (int(args[i + 1]), int(args[i + 2]))
            i += 3
        else:
            positional.append(args[i])
            i += 1

    if not positional:
        result_json(False, error="Usage: chat-select [--force] [--click-xy X Y] <username> | chat-select --list")

    pid = get_pid()
    if not pid:
        result_json(False, error="WeChat is not running")
    log(f"[chat-select] WeChat PID={pid}")

    profile, err = get_profile(pid)
    if not profile:
        result_json(False, error=err)

    # Enumerate sessions
    log("[chat-select] Enumerating sessions...")
    sessions, vector_base, vector_count, current_sel = enumerate_sessions(pid, profile)
    if not sessions:
        result_json(False, error="No sessions found. Is WeChat logged in with chats visible?")

    # --list mode
    if positional[0] == "--list":
        result_json(True, sessions=sessions)

    target = positional[0]
    if is_official_account(target):
        result_json(False, error=f"'{target}' is an official account and cannot be opened")
    if target not in sessions:
        matches = [u for u in sessions if target.lower() in u.lower()]
        if matches:
            result_json(False, error=f"'{target}' not found. Close matches: {matches[:5]}")
        else:
            result_json(False, error=f"'{target}' not found in session list ({len(sessions)} sessions)")

    target_index = sessions[target]
    log(f"[chat-select] Target: {target} -> index {target_index}")

    # Current-selection skip: if not forced and target already selected, skip
    if not force and current_sel and current_sel == target:
        log(f"[chat-select] Target already selected (current_sel={current_sel}), skipping")
        result_json(True, username=target, index=target_index, skipped=True)

    # Find click coordinates: use --click-xy if provided, else fall back to a11y
    click_coords = click_xy
    if not click_coords:
        click_coords = find_chat_item_from_a11y()
    if not click_coords:
        result_json(False, error="No clickable chat item found in a11y tree. Is the chat list visible?")

    # Hook and click
    if not vector_base:
        result_json(False, error="Session vector base address not found")
    ok = select_by_index(pid, profile, target_index, click_coords, vector_base, vector_count)
    if ok:
        result_json(True, username=target, index=target_index)
    else:
        result_json(False, error="Hook did not fire. Click may not have landed on a chat item.")


if __name__ == "__main__":
    main()
