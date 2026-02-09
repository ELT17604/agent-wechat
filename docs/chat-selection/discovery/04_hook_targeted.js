/**
 * Step 3: Targeted hook on lowest-count click functions.
 *
 * WHAT THIS DOES:
 * Hooks the 3-4 functions with the lowest click count from step 2.
 * On each call, logs: raw args, nearby strings, and backtrace.
 * The backtrace reveals the full call chain from Qt event to selection handler.
 *
 * HOW TO USE:
 *   1. Update the targets array with vtable + index from step 2 results
 *   2. Update codeStart/codeEnd
 *   3. Run: frida -p <PID> -l 04_hook_targeted.js --runtime=v8
 *   4. Wait for "CLICK A CHAT NOW!" then click a chat
 *
 * WHAT TO LOOK FOR:
 * - Args containing username strings (wxid_*, @chatroom) → identifies the session
 * - Backtrace addresses → the CALL CHAIN from click to handler:
 *     base+0x38ceda0 → base+0x38c835c → base+0x38c71c8 → base+0x38bd0fc → base+0x38a2148
 *   These return addresses point to the calling functions.
 *   Disassemble the BL instruction at (return_addr - 4) to find the call target.
 *
 * CRASH WARNING:
 * This script CAN crash WeChat if the string scanner dereferences bad memory.
 * If it crashes, reduce the scan range (change -32..128 to 0..64) or remove
 * string scanning entirely and just keep the backtrace.
 *
 * PORTING NOTES:
 * - Backtrace format is the same on x86_64 (Frida abstracts it)
 * - On x86_64: return address is at [rsp] after CALL, not LR
 * - String scanning offsets may differ due to struct padding differences
 */
var w = Process.getModuleByName("wechat");
var b = w.base;
var wEnd = b.add(w.size);

// ── EDIT THESE ───────────────────────────────────────────────────────────────
var codeStart = b.add(0x35a3000);
var codeEnd = b.add(0x7b07590);

var targets = [
    {vtable: 0x7b3b038, idx: 1, label: "model_p40[1]_4calls"},
    {vtable: 0x7b3b038, idx: 0, label: "model_p40[0]_44calls"},
    {vtable: 0x7c09b00, idx: 2, label: "common[2]_18calls"},
    {vtable: 0x7d08d70, idx: 0, label: "n16b[0]_45calls"},
];
// ─────────────────────────────────────────────────────────────────────────────

function tryRead(addr) { try { return addr.readPointer(); } catch(e) { return null; } }

function readStdString(addr) {
    try {
        if (!addr || addr.isNull() || addr.compare(ptr(0x10000)) < 0) return null;
        var b0 = addr.readU8();
        if (b0 & 1) {
            var len = Number(addr.add(8).readU64());
            var dp = addr.add(16).readPointer();
            if (len > 0 && len < 1024 && dp && !dp.isNull())
                return dp.readUtf8String(len);
        } else {
            var len = b0 >> 1;
            if (len > 0 && len <= 22)
                return addr.add(1).readUtf8String(len);
        }
    } catch(e) {}
    return null;
}

console.log("[HOOK] base=" + b);
var phase = 0;

targets.forEach(function(t) {
    var vtAddr = b.add(t.vtable);
    var funcAddr = tryRead(vtAddr.add(t.idx * 8));
    if (!funcAddr) { console.log("[HOOK] Can't read " + t.label); return; }

    var inCode = funcAddr.compare(codeStart) >= 0 && funcAddr.compare(codeEnd) < 0;
    console.log("[HOOK] " + t.label + " = base+0x" + funcAddr.sub(b).toString(16) +
               (inCode ? " (code)" : " (NOT code)"));
    if (!inCode) return;

    try {
        Interceptor.attach(funcAddr, {
            onEnter: function(args) {
                if (phase === 0) return;

                console.log("\n>>> " + t.label + " base+0x" + funcAddr.sub(b).toString(16));
                console.log("    a0=" + args[0] + " a1=" + args[1] + " a2=" + args[2]);

                // Search for strings near first 3 args (CAUTION: can crash!)
                [args[0], args[1], args[2]].forEach(function(arg, ai) {
                    if (!arg || arg.isNull() || arg.compare(ptr(0x10000)) < 0) return;
                    try {
                        for (var off = 0; off <= 128; off += 8) {
                            var s = readStdString(arg.add(off));
                            if (s && s.length > 2 && s.length < 80)
                                console.log("    a" + ai + "+" + off + "=\"" + s.substring(0, 60) + "\"");
                        }
                    } catch(e) {}
                });

                // Backtrace — THE KEY OUTPUT
                var bt = Thread.backtrace(this.context, Backtracer.ACCURATE)
                    .slice(0, 8).map(function(a) {
                        return (a.compare(b) >= 0 && a.compare(wEnd) < 0)
                            ? "base+0x" + a.sub(b).toString(16)
                            : a.toString();
                    });
                console.log("    bt: " + bt.join(", "));
            }
        });
        console.log("[HOOK] Hooked " + t.label);
    } catch(e) {
        console.log("[HOOK] FAIL " + t.label + ": " + e);
    }
});

console.log("\n[HOOK] Waiting 5s idle...");
setTimeout(function() {
    phase = 1;
    console.log("[HOOK] CLICK A CHAT NOW! (10s window)");
    setTimeout(function() {
        phase = 0;
        console.log("\nHOOK_DONE");
    }, 10000);
}, 5000);
