/**
 * Step 4: Disassemble the selection call chain.
 *
 * WHAT THIS DOES:
 * Takes the backtrace return addresses from step 3 and disassembles the code
 * around each one. For each return address, it:
 *   1. Shows the BL/BLR instruction at (retaddr - 4) to find the call target
 *   2. Disassembles the target function's prologue (first 20-30 instructions)
 *   3. Finds the function start by scanning backwards for STP x29,x30 (arm64)
 *      or PUSH RBP (x86_64)
 *
 * HOW TO USE:
 *   1. Fill in the backtrace addresses from step 3
 *   2. Run: frida -p <PID> -l 05_disasm_chain.js --runtime=v8 -q
 *   (This is READ-ONLY — no hooks, zero crash risk)
 *
 * WHAT TO LOOK FOR:
 * The outermost function in the chain typically:
 *   - Takes (this, int index) as arguments
 *   - Reads a session vector from this+SOME_OFFSET
 *   - Validates the index against the vector size
 *   - Calls the next function in the chain with (this, session_item, output)
 *
 * Key patterns to identify:
 *   mov w19, w1          → saves index argument
 *   mov x20, x0          → saves this pointer
 *   ldp x0, x21, [x20, #OFFSET]  → loads session vector (shared_ptr pair)
 *   lsr x22, x8, #4      → count = size / 16 (element size)
 *   add x22, x8, w19, uxtw #4  → element = begin + index * 16
 *   bl FUNC              → call to selectSession
 *
 * The OFFSET where the vector is stored (e.g., +0x180) and the function
 * address of selectSession are the key outputs of this step.
 *
 * PORTING NOTES:
 * - On x86_64: look for MOV EDI/ESI/RDI/RSI patterns instead of ARM regs
 * - On x86_64: function prologues are PUSH RBP; MOV RBP, RSP
 * - Frida's Instruction.parse() works on both architectures
 */
var w = Process.getModuleByName("wechat");
var b = w.base;
console.log("[DISASM] base=" + b);

// ── EDIT THESE: backtrace return addresses from step 3 ───────────────────────
var selectionChain = [
    {off: 0x38ceda0, label: "sel[0] immediate caller"},
    {off: 0x38c835c, label: "sel[1]"},
    {off: 0x38c71c8, label: "sel[2]"},
    {off: 0x38bd0fc, label: "sel[3]"},
    {off: 0x38a2148, label: "sel[4] outermost"},
];
// ─────────────────────────────────────────────────────────────────────────────

function disasmAt(addr, label, count) {
    console.log("\n=== " + label + " base+0x" + addr.sub(b).toString(16) + " ===");
    try {
        var cur = addr;
        for (var i = 0; i < count; i++) {
            var insn = Instruction.parse(cur);
            console.log("  base+0x" + cur.sub(b).toString(16) + "  " + insn.mnemonic + " " + insn.opStr);
            cur = insn.next;
        }
    } catch(e) { console.log("  ERROR: " + e); }
}

// For each return address: show the call instruction and resolve the target
selectionChain.forEach(function(entry) {
    var retAddr = b.add(entry.off);
    console.log("\n--- " + entry.label + " (return addr base+0x" + entry.off.toString(16) + ") ---");

    // Show context around the call
    try {
        for (var delta = -16; delta <= 8; delta += 4) {
            var a = retAddr.add(delta);
            var insn = Instruction.parse(a);
            var marker = (delta === -4) ? " <<<CALL" : (delta === 0) ? " <<<RET" : "";
            console.log("  base+0x" + a.sub(b).toString(16) + "  " + insn.mnemonic + " " + insn.opStr + marker);
        }
    } catch(e) { console.log("  ERROR: " + e); }

    // If the call is a BL (direct), resolve target and disassemble
    try {
        var callInsn = Instruction.parse(retAddr.sub(4));
        if (callInsn.mnemonic === "bl") {
            var target = ptr(callInsn.opStr.replace("#", ""));
            console.log("  Call target: base+0x" + target.sub(b).toString(16));
            disasmAt(target, entry.label + " TARGET", 20);
        } else if (callInsn.mnemonic === "blr") {
            console.log("  Indirect call via register: " + callInsn.opStr);
        }
    } catch(e) {}
});

// Find the outermost function's prologue
console.log("\n=== Finding outermost function start ===");
var outerRet = b.add(selectionChain[selectionChain.length - 1].off);
for (var scan = 0; scan < 200; scan++) {
    var a = outerRet.sub(scan * 4);
    try {
        var insn = Instruction.parse(a);
        // ARM64: look for SUB SP, SP, #N (stack allocation) before STP
        if (insn.mnemonic === "sub" && insn.opStr.indexOf("sp, sp") >= 0) {
            console.log("Found stack alloc at base+0x" + a.sub(b).toString(16));
            disasmAt(a, "OUTERMOST FUNCTION", 80);
            break;
        }
    } catch(e) { break; }
}

console.log("\nDISASM_DONE");
