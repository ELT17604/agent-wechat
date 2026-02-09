# WeChat Linux Programmatic Chat Selection

Select any chat in WeChat Linux by username, without manual clicking.

## Quick Start

```bash
# Select a chat by username
python3 auto_select.py filehelper
python3 auto_select.py wxid_lo9qzwfafwug22
python3 auto_select.py 119181695@chatroom

# List all sessions
python3 auto_select.py --list
```

Requirements: `frida` (via pipx), `xdotool`, WeChat running and logged in.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    auto_select.py                         │
│                                                           │
│  Step 1: Enumerate sessions (no click, pure heap scan)    │
│    ├─ Scan heap for "filehelper\0" → find session element │
│    ├─ Scan heap for pointer to element → find vector      │
│    ├─ Walk vector boundaries (validate neighbors)         │
│    └─ Read username from each element at +USERNAME_OFF    │
│                                                           │
│  Step 2: Select target chat (1 click)                     │
│    ├─ Frida hooks selectSession()                         │
│    ├─ xdotool clicks any chat in list (triggers hook)     │
│    └─ Hook replaces index arg → WeChat selects our target │
└──────────────────────────────────────────────────────────┘
```

### Why hook + click instead of direct call?

Direct `NativeFunction` calls crash because Qt functions require main-thread context
(thread-local storage, event loop state, etc.). The hook-replacement approach runs
our logic *inside* WeChat's existing call on the main thread — all Qt state is correct.

### What offsets are needed

Only **two** binary-specific offsets:

| Constant | aarch64 | x86_64 | What |
|----------|---------|--------|------|
| `SELECT_SESSION` | `0x38bce80` | `0x3907960` | Function that takes `(controller, int index, ...)` |
| `USERNAME_OFF` | `0x120` | `0x138` | Username string offset inside session element |
| `ELEM_SIZE` | `16` | `16` | Session vector element size (unlikely to change) |

Session enumeration uses **heap scanning** — no function offsets needed for that step.

### Session vector layout

```
Vector is a contiguous array in heap memory.
Elements are 16 bytes each (shared_ptr<SessionItem>):
  [+0x00] SessionItem* raw pointer
  [+0x08] refcount block*

SessionItem layout (partial):
  [+0x120] username (std::string, libc++ SSO) — aarch64
  [+0x138] username (std::string, libc++ SSO) — x86_64
```

---

## Finding Offsets for a New Binary

When WeChat updates, the function offsets change. You need to find two things:
1. `USERNAME_OFF` — where the username lives in session elements
2. `SELECT_SESSION` — the function to hook for index replacement

### Finding USERNAME_OFF

This is easy and should be done first. Use Frida to scan for a known username:

```js
// find_username_off.js — run with: frida -p <PID> -l find_username_off.js --runtime=v8 -q
var SEARCH = "filehelper";
var pattern = "";
for (var i = 0; i < SEARCH.length; i++)
    pattern += ("0" + SEARCH.charCodeAt(i).toString(16)).slice(-2) + " ";
pattern += "00";

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

var hits = [];
Process.enumerateRanges("rw-").forEach(function(range) {
    if (range.size > 200*1024*1024) return;
    try {
        Memory.scanSync(range.base, range.size, pattern).forEach(function(hit) {
            hits.push(hit.address);
        });
    } catch(e) {}
});

console.log("Found " + hits.length + " hits for '" + SEARCH + "'");
// For each hit, check what offset from a plausible struct base yields this string
hits.slice(0, 10).forEach(function(addr) {
    // SSO string: the string starts at addr, but the std::string object starts 1 byte before (byte0 = len<<1)
    var ssoBase = addr.sub(1);
    // Try reading as std::string to confirm
    var s = readStdString(ssoBase);
    if (s !== SEARCH) return;
    // Now scan nearby for other strings (wxid_*, @chatroom) to find neighboring session fields
    for (var baseOff = 0x80; baseOff <= 0x200; baseOff += 8) {
        var elemBase = ssoBase.sub(baseOff);
        var u = readStdString(elemBase.add(baseOff));
        if (u !== SEARCH) continue;
        // Check if there's a second username copy nearby
        for (var off2 = baseOff + 8; off2 <= baseOff + 0x40; off2 += 8) {
            var u2 = readStdString(elemBase.add(off2));
            if (u2 === SEARCH)
                console.log("  USERNAME_OFF=0x" + baseOff.toString(16) + " (copy at +0x" + off2.toString(16) + ") elem=" + elemBase);
        }
    }
});
console.log("DONE");
```

### Finding SELECT_SESSION

Two approaches, in order of recommendation:

#### Approach A: QMetaObject::activate (recommended)

This was the breakthrough on x86_64. Every chat click emits a Qt signal
(`mmui::ChatSessionList::SessionListActivated`) that fires exactly once per click
with zero background noise.

**Step A1: Find QMetaObject::activate**

```bash
# Search for the string in the binary
strings -t x /opt/wechat/wechat | grep -i "QMetaObject::activate"
# Or search for ChatSessionList meta-object
strings -t x /opt/wechat/wechat | grep -i "mmui::ChatSessionList"
```

Since Qt is statically linked, `activate` won't be in exports. Use Frida runtime
string search to find it:

```js
// Scan binary .rodata for "QMetaObject::activate" at runtime
var w = Process.getModuleByName("wechat");
Memory.scanSync(w.base, w.size, "514d 6574 614f 626a 6563 743a 3a61 6374 6976 6174 65")
    .forEach(function(hit) { console.log("activate string at base+0x" + hit.address.sub(w.base).toString(16)); });
```

Cross-reference the string to find the function that uses it (look for LEA/ADRP+ADD
instructions referencing that address).

**Step A2: Hook activate, click a chat**

```js
// Hook QMetaObject::activate — find the right overload (4 or 5 args)
var w = Process.getModuleByName("wechat");
var activate = w.base.add(ACTIVATE_OFFSET);

function readQt5ClassName(metaObj) {
    try {
        var stringdata = metaObj.add(8).readPointer();
        var offset = stringdata.add(16).readS32();
        return stringdata.add(offset).readUtf8String();
    } catch(e) { return null; }
}

var phase = 0;
Interceptor.attach(activate, {
    onEnter: function(args) {
        if (phase === 0) return;
        var cls = readQt5ClassName(args[1]);
        if (cls && cls.indexOf("Chat") >= 0)
            console.log("SIGNAL cls=" + cls + " idx=" + args[2]);
    }
});

// Wait for idle, then enable
setTimeout(function() { phase = 1; console.log("CLICK NOW"); }, 5000);
```

Look for `mmui::ChatSessionList` with a specific signal index. That's the selection signal.

**Step A3: Backtrace from the signal to find selectSession**

Once you know which signal fires, add a backtrace:

```js
var bt = Thread.backtrace(this.context, Backtracer.ACCURATE).slice(0, 8);
```

The backtrace reveals the call chain. Disassemble each return address to find the
function that takes `(controller, int index)` — that's your `SELECT_SESSION`.

**What the call chain looks like:**

The full chain is the same on both architectures (same codebase). We discovered
different portions depending on the approach used:

```
QMetaObject::activate                        ← Approach A starts here
  → qt_static_metacall
  → delegate call
  → outerHandler / delegate function         ← Approach B starts here
    → internal logic (getVector / getIndex)
    → selectSession(controller, index)       ← SELECT_SESSION (hook target)
```

The key pattern: find the function where `args[1]` is an integer index into the
session list. That's what you hook and replace.

#### Approach B: Vtable hooking (original method)

If QMetaObject::activate is hard to find, use the vtable approach:

```
Step 1: Find vtables near session data         → vtable addresses
Step 2: Hook vtable entries, count click calls  → click-responsive functions
Step 3: Hook top candidates with backtraces     → call chain addresses
Step 4: Disassemble call chain                  → selectSession offset
```

See `discovery/` scripts for the implementation of each step.

**Step B1: Find vtables**

Two approaches (use both):

*String search in binary:*
```bash
strings -t x /opt/wechat/wechat | grep -E "mmui::ChatSession|SelectChatChanged|OnSelectedSession"
```

*Memory scan for known username (discovery/02_find_session_items.js):*
```
frida -p <PID> -l discovery/02_find_session_items.js --runtime=v8 -q
```

**Step B2: Light hook to find click-responsive functions (discovery/03_hook_light.js)**

```
frida -p <PID> -l discovery/03_hook_light.js --runtime=v8
```

Do NOT use `-q`. Edit the `vtables` array. Click a chat when prompted.
The function with the **lowest click count** (idle=0, click>0) is the best candidate.

On x86_64: remove the `addr % 4 === 0` alignment check (x86 has variable-length instructions).

**Step B3: Targeted hook with backtraces (discovery/04_hook_targeted.js)**

Hook the top 3-4 lowest-count functions. The backtrace reveals the call chain.

**Step B4: Disassemble the call chain (discovery/05_disasm_chain.js)**

Read-only, zero crash risk. Look for the function that:
- Takes `(something, int index)` as arguments
- Uses the index to select from a session list

**What to look for (aarch64):**
```asm
mov w19, w1                  ; saves index argument
mov x20, x0                  ; saves this/manager pointer
...
bl selectSession             ; ← SELECT_SESSION offset
```

**What to look for (x86_64):**
```asm
mov esi, eax                 ; index into esi (arg2)
mov rdi, rbx                 ; controller into rdi (arg1)
call selectByIndex           ; ← SELECT_SESSION offset
```

### Verifying the offset

Quick test — hook the candidate and click a chat:

```js
var w = Process.getModuleByName("wechat");
Interceptor.attach(w.base.add(CANDIDATE_OFFSET), {
    onEnter: function(args) {
        console.log("HIT a0=" + args[0] + " a1=" + args[1].toInt32());
    }
});
```

If `args[1]` changes to match the chat you clicked, you found it.

### Update auto_select.py

Edit the constants at the top:
```python
SELECT_SESSION = 0x38bce80   # new offset
USERNAME_OFF   = 0x120       # from find_username_off.js
ELEM_SIZE      = 16          # unlikely to change
```

---

## Architecture Differences

### aarch64 vs x86_64

| Aspect | aarch64 | x86_64 |
|--------|---------|--------|
| Calling convention | x0-x7 | rdi, rsi, rdx, rcx, r8, r9 |
| Frida `args[]` | Same — `args[0]`=x0, `args[1]`=x1 | Same — `args[0]`=rdi, `args[1]`=rsi |
| Function prologue | `STP x29, x30, [sp, #-N]!` | `PUSH RBP; MOV RBP, RSP` |
| Direct call | `BL target` | `CALL target` |
| Address load | `ADRP + ADD` | `LEA reg, [RIP+offset]` |
| Instruction alignment | 4-byte aligned | Variable length |
| Struct offsets | May differ | May differ |

### What's architecture-independent

- Heap scan for session enumeration (same logic, only USERNAME_OFF changes)
- `readStdString` (libc++ SSO layout is the same)
- Hook + xdotool click + index replacement approach
- Session vector structure (16-byte shared_ptr elements)
- Frida `Interceptor.attach` API

---

## Troubleshooting

### Hooks don't fire
- Frida's event loop needs interactive mode. Don't use `-q` for timer-based scripts.
- The `auto_select.py` script handles this by using `subprocess.Popen` with stdin open.
- If running manually: use `frida -p PID -l script.js --runtime=v8` (no `-q`).

### WeChat crashes during hooking
- **Never hook mid-function**: vtable entries that are only 4 bytes apart are NOT
  separate functions. Only hook the first 5-6 entries per vtable.
- **Use counter-only hooks first**: no memory reads, no string parsing, no backtraces.
- **Validate addresses**: check that hook targets are in the .text section.
- **Reduce scan range**: if string scanning crashes, narrow from `-32..128` to `0..64`.

### Direct NativeFunction calls crash
- Qt functions must run on the main thread. Frida's script thread lacks thread-local state.
- **Solution**: use hook-based argument replacement instead of direct calls.

### xdotool click doesn't land on a chat
- The chat list must be visible (not covered by another window).
- Adjust `CHAT_LIST_X` if the window layout is different.
- Try clicking at multiple Y positions.
- Use `xdotool getmouselocation` to verify click coordinates.

### Session not found
- The session must be in the chat list (visible or scrolled off-screen, but loaded).
- Sessions not in the recent list won't appear. Open the chat manually first.
- Use `--list` to see all available sessions.

### Frida gotchas
- **No `-q` with setTimeout**: `-q` mode doesn't run the event loop for timers.
- **Multiple frida attaches**: Wait 1-2 seconds between detach and re-attach.
- **Output redirect**: Use `> file 2>&1` (not `2>&1 > file`).
- **Frida from pipx**: Use full path or `shutil.which("frida")` to find the binary.

## Files

```
chat-selection/
├── auto_select.py              # Main script (aarch64 + x86_64) — run this
├── GUIDE.md                    # This file
└── discovery/                  # Scripts for finding offsets in new binaries
    ├── 01_find_vtables.js      # Find class name strings + vtable addresses (Approach B)
    ├── 02_find_session_items.js # Find vtables via known username in memory (Approach B)
    ├── 03_hook_light.js        # Ultra-light counter hooks → click-responsive funcs (Approach B)
    ├── 04_hook_targeted.js     # Detailed hooks with backtraces → call chain (Approach B)
    └── 05_disasm_chain.js      # Disassemble call chain → function offsets (both approaches)
```
