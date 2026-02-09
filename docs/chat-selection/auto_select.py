#!/usr/bin/env python3
"""
Programmatic chat selection for WeChat Linux.

Selects a chat by username (e.g. "wxid_xxx", "123@chatroom", "filehelper")
without requiring manual user interaction. Works on both aarch64 and x86_64.

Usage:
    python3 auto_select.py <username>
    python3 auto_select.py filehelper
    python3 auto_select.py 119181695@chatroom
    python3 auto_select.py --list              # list all sessions

Requirements:
    - frida (via pipx: pipx install frida-tools)
    - xdotool (apt install xdotool)
    - WeChat Linux running and logged in

How it works:
    1. Scans heap for session vector, enumerates all sessions (no click needed)
    2. Hooks selectSession() + xdotool clicks → hook replaces index arg
    3. WeChat's own code runs the selection on the main thread
"""
import subprocess
import time
import sys
import re
import shutil
import platform

# ── Binary-specific offsets per architecture ─────────────────────────────────
ARCH = platform.machine()

if ARCH == "aarch64":
    SELECT_SESSION = 0x38bce80    # selectSession(manager, int index, pair* out)
    USERNAME_OFF   = 0x120
    ELEM_SIZE      = 16
elif ARCH == "x86_64":
    SELECT_SESSION = 0x3907960    # selectByIndex(controller, int index)
    USERNAME_OFF   = 0x138
    ELEM_SIZE      = 16
else:
    print(f"ERROR: Unsupported architecture: {ARCH}")
    sys.exit(1)

# ── UI constants ──────────────────────────────────────────────────────────────
CHAT_LIST_X   = 200    # x-coordinate in the chat list panel (left side)
CHAT_LIST_Y_1 = 300    # y for click (redirect)
CHAT_LIST_Y_2 = 400    # y for second attempt

FRIDA_BIN = shutil.which("frida") or str(__import__('pathlib').Path.home() / ".local/bin/frida")


def get_pid():
    """Get WeChat PID."""
    try:
        return subprocess.check_output(["pgrep", "-x", "wechat"]).decode().strip()
    except subprocess.CalledProcessError:
        print("ERROR: WeChat is not running")
        sys.exit(1)


def find_main_window(pid):
    """Find the main WeChat window ID via xdotool."""
    try:
        wids = subprocess.check_output(
            ["xdotool", "search", "--pid", pid], text=True
        ).strip().split('\n')
    except subprocess.CalledProcessError:
        print("ERROR: xdotool search failed. Is xdotool installed?")
        sys.exit(1)

    best = None
    best_area = 0
    for wid in wids:
        wid = wid.strip()
        if not wid:
            continue
        try:
            geo = subprocess.check_output(
                ["xdotool", "getwindowgeometry", wid], text=True
            )
            m = re.search(r'Geometry:\s+(\d+)x(\d+)', geo)
            if m:
                w, h = int(m.group(1)), int(m.group(2))
                area = w * h
                if area > best_area:
                    best_area = area
                    best = wid
        except subprocess.CalledProcessError:
            continue

    if not best:
        print("ERROR: Could not find WeChat window")
        sys.exit(1)
    return best


def xdotool_click(window_id, x, y):
    """Click at window-relative coordinates."""
    subprocess.run(["xdotool", "windowactivate", "--sync", window_id],
                   timeout=5, capture_output=True)
    time.sleep(0.3)
    subprocess.run(
        ["xdotool", "mousemove", "--window", window_id, str(x), str(y)],
        timeout=5,
    )
    time.sleep(0.2)
    subprocess.run(
        ["xdotool", "click", "--window", window_id, "1"],
        timeout=5,
    )


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


def read_frida_output(proc, timeout=10, stop_on=None):
    """Read lines from a running frida process."""
    lines = []
    start = time.time()
    while time.time() - start < timeout:
        line = proc.stdout.readline()
        if not line:
            break
        line = line.rstrip()
        lines.append(line)
        if stop_on and stop_on in line:
            break
    return lines


def kill_frida(proc):
    """Terminate a frida process."""
    try:
        proc.stdin.close()
    except:
        pass
    proc.terminate()
    try:
        proc.wait(timeout=3)
    except:
        proc.kill()


def run_frida_oneshot(pid, script_path, timeout=20, stop_on="SCRIPT_DONE"):
    """Run a frida script that exits on its own, return output lines."""
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
    except:
        pass
    finally:
        kill_frida(proc)
        time.sleep(1)  # ensure frida fully detaches before next attach
    return lines


def write_js(path, content):
    with open(path, "w") as f:
        f.write(content)


# ── Shared JS helpers ────────────────────────────────────────────────────────

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


# ── Step 1: Enumerate sessions via heap scan ─────────────────────────────────

def enumerate_sessions(pid):
    """Scan heap for session vector, return dict of {username: index}."""
    write_js("/tmp/_cs_enum.js", f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var UNAME_OFF = 0x{USERNAME_OFF:x};
var ELEM_SZ = {ELEM_SIZE};
{READ_STD_STRING_JS}

function ptrToPattern(p) {{
    var buf = Memory.alloc(8);
    buf.writePointer(p);
    var hex = [];
    for (var i = 0; i < 8; i++) hex.push(("0" + buf.add(i).readU8().toString(16)).slice(-2));
    return hex.join(" ");
}}

// Phase 1: Find session elements by scanning for "filehelper" string
var fhPattern = "66 69 6c 65 68 65 6c 70 65 72 00"; // "filehelper\\0"
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
    // Phase 2: For each session element, find all heap refs to its pointer
    // Then check if the ref is inside a vector of session elements
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
                    // Check neighbors: elem-16 and elem+16 should also be valid sessions
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

                    // Found a vector element! Scan to find boundaries
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
        console.log("SCRIPT_DONE");
    }}
}}
""")
    for attempt in range(3):
        if attempt > 0:
            time.sleep(2)
        lines = run_frida_oneshot(pid, "/tmp/_cs_enum.js", timeout=45)
        sessions = {}
        for line in lines:
            if line.strip().startswith("SESSION"):
                parts = line.strip().split(None, 2)
                if len(parts) >= 3:
                    sessions[parts[2]] = int(parts[1])
        if sessions:
            return sessions
    return {}  # all retries failed


# ── Step 2: Select chat by replacing hook arg ────────────────────────────────

def select_by_index(pid, window_id, target_index):
    """Hook selectSession, click, hook replaces index. Returns True on success."""
    write_js("/tmp/_cs_select.js", f"""
var w = Process.getModuleByName("wechat");
var b = w.base;
var addr = b.add(0x{SELECT_SESSION:x});
var TARGET = {target_index};
console.log("READY target=" + TARGET);
var count = 0;
Interceptor.attach(addr, {{
    onEnter: function(args) {{
        if (count >= 2) return;
        var orig = args[1].toInt32();
        console.log("REDIRECT " + orig + " -> " + TARGET);
        args[1] = ptr(TARGET);
        count++;
    }}
}});
""")
    proc = run_frida_bg(pid, "/tmp/_cs_select.js")
    time.sleep(0.5)
    xdotool_click(window_id, CHAT_LIST_X, CHAT_LIST_Y_1)
    lines = read_frida_output(proc, timeout=5, stop_on="REDIRECT")
    kill_frida(proc)
    time.sleep(1)  # ensure frida fully detaches
    return any("REDIRECT" in l for l in lines)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 auto_select.py <username>")
        print("       python3 auto_select.py --list")
        sys.exit(1)

    pid = get_pid()
    window_id = find_main_window(pid)
    print(f"WeChat PID={pid} window={window_id} arch={ARCH}")

    # Enumerate sessions
    print("\n[1/2] Enumerating sessions...")
    sessions = enumerate_sessions(pid)
    if not sessions:
        print("ERROR: No sessions found")
        sys.exit(1)
    print(f"  {len(sessions)} sessions found")

    if sys.argv[1] == "--list":
        for uname, idx in sorted(sessions.items(), key=lambda x: x[1]):
            print(f"  [{idx:3d}] {uname}")
        return

    target = sys.argv[1]
    if target not in sessions:
        print(f"ERROR: '{target}' not found in session list")
        matches = [u for u in sessions if target.lower() in u.lower()]
        if matches:
            print(f"  Close matches: {matches[:10]}")
        sys.exit(1)

    target_index = sessions[target]
    print(f"  Target: {target} (index {target_index})")

    # Select
    print(f"\n[2/2] Selecting {target}...")
    ok = select_by_index(pid, window_id, target_index)
    if ok:
        print(f"\n  Done. Chat switched to: {target}")
    else:
        print(f"\n  Failed. Click may not have landed on a chat item. Try again.")
        sys.exit(1)


if __name__ == "__main__":
    main()
