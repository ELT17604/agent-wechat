/**
 * Step 1b: Find session items in memory by searching for a known username.
 *
 * WHAT THIS DOES:
 * Searches heap memory for a known WeChat username (SSO-encoded std::string).
 * Session items are structs that contain the username. By examining the memory
 * around hits, we can find vtable pointers that identify the session classes.
 *
 * HOW TO USE:
 *   1. Find a username from the session database (e.g. "wxid_xxx" or "NNN@chatroom")
 *   2. Edit SEARCH_USERNAME below
 *   3. Run: frida -p <PID> -l 02_find_session_items.js --runtime=v8 -q
 *
 * WHAT TO LOOK FOR:
 * - SSO hits: locations where the username is stored as a libc++ short string
 * - Binary pointers near those hits: these are vtable pointers
 * - Group vtables by offset from the SSO hit to find the session item structure
 *
 * The vtable addresses found here feed into step 2 (hook_light.js).
 *
 * PORTING NOTES:
 * libc++ std::string SSO layout is the same on both arm64 and x86_64:
 *   Short string (≤22 chars): byte0 = len<<1, bytes 1-22 = chars
 *   Long string: byte0 = 1|flag, +8 = length, +16 = data pointer
 */
var w = Process.getModuleByName("wechat");
var b = w.base;

// ── EDIT THIS ────────────────────────────────────────────────────────────────
var SEARCH_USERNAME = "wxid_lo9qzwfafwug22";  // a username you know exists
// ─────────────────────────────────────────────────────────────────────────────

console.log("base=" + b);
console.log("Searching for SSO string: \"" + SEARCH_USERNAME + "\"");

// Build SSO pattern: byte0 = len<<1, then the string bytes
var len = SEARCH_USERNAME.length;
var ssoBytes = [("0" + (len << 1).toString(16)).slice(-2)];
for (var i = 0; i < len; i++) {
    ssoBytes.push(("0" + SEARCH_USERNAME.charCodeAt(i).toString(16)).slice(-2));
}
var pattern = ssoBytes.join(" ");
console.log("SSO pattern: " + pattern);

var hits = [];
Process.enumerateRanges("rw-").forEach(function(range) {
    if (range.size > 200 * 1024 * 1024) return;
    try {
        Memory.scanSync(range.base, range.size, pattern).forEach(function(hit) {
            hits.push(hit.address);
        });
    } catch(e) {}
});

console.log("Found " + hits.length + " SSO hits\n");

// For each hit, scan nearby memory for binary pointers (vtables)
var vtableCounts = {};
hits.forEach(function(addr, idx) {
    if (idx >= 20) return; // only analyze first 20 hits
    // Scan -128 to +256 bytes around the hit for binary pointers
    for (var off = -128; off <= 256; off += 8) {
        try {
            var val = addr.add(off).readPointer();
            if (val.compare(b) >= 0 && val.compare(b.add(w.size)) < 0) {
                var relOff = "base+0x" + val.sub(b).toString(16);
                var key = relOff + " (at username" + (off >= 0 ? "+" : "") + off + ")";
                vtableCounts[key] = (vtableCounts[key] || 0) + 1;
            }
        } catch(e) {}
    }
});

console.log("Binary pointers near username hits (likely vtables):");
Object.keys(vtableCounts)
    .sort(function(a, b) { return vtableCounts[b] - vtableCounts[a]; })
    .forEach(function(k) {
        if (vtableCounts[k] >= 2) // only show recurring ones
            console.log("  " + k + " (" + vtableCounts[k] + "x)");
    });

console.log("\nDONE");
