/**
 * Step 1: Find session-related vtables in the WeChat binary.
 *
 * WHAT THIS DOES:
 * Searches for Qt meta-object class name strings (mmui::ChatSessionList, etc.)
 * in the binary's readable memory. These strings are near vtable pointers in
 * the .data section. The vtable addresses are used in step 2.
 *
 * HOW TO USE:
 *   frida -p <PID> -l 01_find_vtables.js --runtime=v8 -q
 *
 * WHAT TO LOOK FOR:
 * Qt meta-object string tables contain class names and signal/slot names.
 * Key strings:
 *   mmui::ChatSessionList           — the session list widget
 *   mmui::ChatSessionCellViewModel  — individual session cell
 *   SelectChatChanged               — signal emitted on selection
 *   OnSelectChatChanged             — slot handler
 *   SessionListActivated            — signal
 *
 * Once you find these strings, the vtables are nearby in the .data section.
 * You can also find them by looking at memory regions near session items
 * (see step 1b).
 *
 * PORTING NOTES:
 * The string names are likely stable across versions. The vtable offsets change
 * with every build. On x86_64, the same strings exist but at different addresses.
 */
var w = Process.getModuleByName("wechat");
var b = w.base;
console.log("base=" + b + " size=0x" + w.size.toString(16));

// Search for key class name strings in readable memory
var searchStrings = [
    "mmui::ChatSessionList",
    "mmui::ChatSessionCellViewModel",
    "mmui::ChatMasterView",
    "SelectChatChanged",
    "OnSelectChatChanged",
    "SessionListActivated",
    "OpenChatSingleWindow",
    "OnSelectedSession",
];

searchStrings.forEach(function(needle) {
    var pattern = "";
    for (var i = 0; i < needle.length; i++) {
        pattern += ("0" + needle.charCodeAt(i).toString(16)).slice(-2) + " ";
    }
    pattern = pattern.trim();

    Process.enumerateRanges("r--").forEach(function(range) {
        // Only scan binary's own ranges
        if (range.base.compare(b) < 0 || range.base.compare(b.add(w.size)) >= 0) return;
        try {
            var hits = Memory.scanSync(range.base, range.size, pattern);
            hits.forEach(function(hit) {
                console.log("\"" + needle + "\" at base+0x" + hit.address.sub(b).toString(16));
            });
        } catch(e) {}
    });
});

// Also dump ELF segment info for address mapping
console.log("\nMemory ranges in wechat module:");
var ranges = Process.enumerateRanges("---");
var prevEnd = b;
ranges.forEach(function(r) {
    if (r.base.compare(b) >= 0 && r.base.compare(b.add(w.size)) < 0) {
        console.log("  base+0x" + r.base.sub(b).toString(16) +
                    " size=0x" + r.size.toString(16) +
                    " " + r.protection);
    }
});

console.log("\nDONE");
