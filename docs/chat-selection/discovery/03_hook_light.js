/**
 * Step 2: Ultra-light click detection.
 *
 * WHAT THIS DOES:
 * Hooks vtable function entries with counter-only onEnter callbacks (no memory
 * reads, no string parsing, no backtraces). Counts calls in two phases:
 *   Phase 0 (idle): 8 seconds of background counting
 *   Phase 1 (click): 10 seconds — user clicks a chat during this window
 *
 * Functions that fire ONLY in phase 1 (click>0, idle==0) are click-responsive.
 * The one with the LOWEST click count is the most selective — likely the actual
 * selection handler rather than a rendering/repaint callback.
 *
 * HOW TO USE:
 *   1. Update the vtables array below with addresses from steps 1/1b
 *   2. Update codeStart/codeEnd with the .text section boundaries
 *   3. Run: frida -p <PID> -l 03_hook_light.js --runtime=v8
 *      (NOTE: do NOT use -q, the event loop needs the interactive mode)
 *   4. Wait for "CLICK A CHAT NOW!" message
 *   5. Click a chat in the WeChat window
 *   6. Wait for results
 *
 * WHAT TO LOOK FOR:
 * Functions with idle=0, click>0, sorted by lowest click count:
 *   model_p40[1]: click=4      ← BEST: most selective, likely handler
 *   common[2]:    click=18
 *   model_p40[0]: click=44
 *   n16b[0]:      click=45
 *   ...
 *   model_p96[5]: click=1033   ← too many calls, probably rendering
 *
 * PORTING NOTES:
 * - Vtable offsets change with every binary build
 * - Code section boundaries change too
 * - On x86_64: function addresses might not be 4-byte aligned (remove that check)
 * - The counter-only approach is safe — it can't crash WeChat
 *
 * CRASH SAFETY:
 * This script is designed to never crash WeChat. Hooks only increment counters.
 * If WeChat crashes anyway, it's a Frida bug — reduce the number of hooked
 * vtables or skip ones that fail with "unable to intercept".
 */
var w = Process.getModuleByName("wechat");
var b = w.base;

// ── EDIT THESE: code section boundaries from ELF segments ────────────────────
var codeStart = b.add(0x35a3000);
var codeEnd = b.add(0x7b07590);
// ─────────────────────────────────────────────────────────────────────────────

console.log("[HOOK] base=" + b);

function tryRead(addr) { try { return addr.readPointer(); } catch(e) { return null; } }

var counters = {};
var hookedAddrs = {};
var phase = 0;

function isCodeAddr(addr) {
    return addr.compare(codeStart) >= 0 && addr.compare(codeEnd) < 0 &&
           (Number(addr) % 4 === 0);  // ARM64: 4-byte aligned. Remove for x86.
}

function hookFunc(funcAddr, label) {
    var key = funcAddr.toString();
    if (hookedAddrs[key]) return false;
    if (!isCodeAddr(funcAddr)) return false;
    hookedAddrs[key] = true;
    counters[label] = [0, 0];

    try {
        Interceptor.attach(funcAddr, {
            onEnter: function(args) {
                counters[label][phase]++;
            }
        });
        return true;
    } catch(e) {
        hookedAddrs[key] = false;
        return false;
    }
}

// ── EDIT THESE: vtable addresses from steps 1/1b ─────────────────────────────
var vtables = [
    {off: 0x7c09b00, label: "common"},
    {off: 0x7b3b038, label: "model_p40"},
    {off: 0x7b3b248, label: "model_p56"},
    {off: 0x7c72e18, label: "model_p96"},
    {off: 0x7b21dd8, label: "data_p40"},
    {off: 0x7b38b00, label: "n72"},
    {off: 0x7ba3f50, label: "n16"},
    {off: 0x7d08d70, label: "n16b"},
    {off: 0x7b2ec88, label: "n32"},
    {off: 0x7df3878, label: "p72"},
    {off: 0x7e2f3a0, label: "p104"},
];
// ─────────────────────────────────────────────────────────────────────────────

vtables.forEach(function(vt) {
    var vtAddr = b.add(vt.off);
    for (var i = 0; i < 6; i++) {
        var entry = tryRead(vtAddr.add(i * 8));
        if (!entry || entry.isNull()) break;
        hookFunc(entry, vt.label + "[" + i + "]");
    }
});

console.log("[HOOK] Hooked " + Object.keys(hookedAddrs).length + " functions");
console.log("[HOOK] Phase 0: idle counting for 8 seconds...");

setTimeout(function() {
    phase = 1;
    console.log("[HOOK] Phase 1: CLICK A CHAT NOW! (10 second window)");

    setTimeout(function() {
        console.log("\n[RESULTS] Click-only functions (idle=0, click>0):");
        var keys = Object.keys(counters);
        keys.sort();
        var clickOnly = [];
        keys.forEach(function(k) {
            var idle = counters[k][0], click = counters[k][1];
            if (click > 0 && idle === 0)
                clickOnly.push({label: k, count: click});
        });
        clickOnly.sort(function(a, b) { return a.count - b.count; });
        clickOnly.forEach(function(item) {
            console.log("  " + item.label + ": " + item.count + " calls");
        });

        console.log("\n[RESULTS] All counts:");
        keys.forEach(function(k) {
            console.log("  " + k + ": idle=" + counters[k][0] + " click=" + counters[k][1]);
        });
        console.log("\nHOOK_DONE");
    }, 10000);
}, 8000);
