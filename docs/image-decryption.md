# WeChat Image Decryption

WeChat Linux encrypts all stored images as `.dat` files on disk. This document describes the encryption scheme and how we decrypt them.

## Encryption Scheme

Each `.dat` file uses a two-layer scheme:

1. **AES-128-ECB** on the first 1024 bytes of the original image (produces 1040 bytes with PKCS7 padding)
2. **Single-byte XOR** on all remaining bytes

Both keys are **per-account** — different accounts use different AES keys and XOR bytes.

## .dat File Format

```
Offset  Size   Description
0x00    6      Magic: 07 08 56 32 08 07
0x06    4      enc_chunk_size (uint32 LE, always 1024 for files > 1KB)
0x0A    4      remaining_size (uint32 LE = original_file_size - enc_chunk_size)
0x0E    1      Flag byte (0x01)
0x0F    1040   AES-128-ECB ciphertext (enc_chunk_size + 16 PKCS7 padding)
0x41F   N      Remaining data XOR'd with xor_byte
```

**Total: dat_file_size = original_file_size + 31** (15 header + 16 AES padding)

## AES Key Format

The AES key is derived from a 32-character hex string stored in WeChat's process memory. The key is the **raw ASCII bytes of the first 16 hex characters** (NOT hex-decoded).

Example: hex string `2db48e820850a7cff445fb86ce85a4fa`
- **Correct**: key bytes = `32 64 62 34 38 65 38 32 30 38 35 30 61 37 63 66` (ASCII of `"2db48e820850a7cf"`)
- **Wrong**: `bytes.fromhex("2db48e820850a7cf")` = `2d b4 8e 82 08 50 a7 cf`

## Key Extraction

Keys exist only in WeChat's process memory at runtime (not on disk). They are **lazy-initialized** — only populated after the first image operation.

### How We Extract

During login key extraction (`extract-keys.py`), we read `/proc/pid/mem` directly (no Frida needed):

1. **AES key**: Regex-based memory scan of all RW regions. The key is stored XOR-obfuscated with a per-build 32-byte mask (`IMAGE_XOR_MASK`). Since the plaintext must be 32 hex characters (0-9, a-f), each byte position has only 16 valid obfuscated values out of 256. We build a regex matching the first 4 obfuscated bytes (C-level speed), then verify the remaining 28 in Python. False positive probability is (16/256)^32 ≈ 3e-39 — any match is the real key.
2. **XOR byte**: Derived lazily at image access time (not during key extraction). On first image decryption, the AES-decrypted head reveals the image format, and the XOR byte is recovered by XOR-ing the file's tail bytes against known trailers (JPEG `FF D9`, PNG IEND `AE 42 60 82`, GIF `00 3B`). The result is persisted for subsequent queries.

### Storage

Image keys are stored in the `wechat_keys` table alongside DB encryption keys, using reserved `dbName` values:
- `_image_aes` — 32-char hex string (written by `extract-keys.py`)
- `_image_xor` — 2-char hex byte (e.g. `"85"`) — derived lazily on first image access, not during extraction

## File Locations

```
Full images:   ~/Documents/xwechat_files/<account>/msg/attach/<md5(chatId)>/<YYYY-MM>/Img/<hash>.dat
Thumbnails:    Same dir with _t.dat suffix
Cached thumbs: ~/Documents/xwechat_files/<account>/cache/<YYYY-MM>/Message/<md5(chatId)>/Thumb/
```

## .dat File Resolution

To find the `.dat` file for a specific message:

1. **Primary**: Parse message XML for `md5` attribute → query `hardlink.db` `image_hardlink_info_v4` by `md5` → resolve `dir1`/`dir2` via `dir2id` table → construct path
2. **Fallback**: Scan `msg/attach/<md5(chatId)>/<YYYY-MM>/Img/` for `.dat` files by filesystem mtime

### hardlink.db Schema

- `dir2id`: maps directory name strings → rowid. Stores md5(chatId) hashes and YYYY-MM strings.
- `image_hardlink_info_v4`: `md5` (image content md5), `file_name`, `file_size`, `modify_time`, `dir1` (chat dir rowid), `dir2` (date dir rowid)

**Note**: `modify_time` in hardlink.db does NOT correspond to message `create_time` — images are downloaded asynchronously. Always use the `md5` column for lookups, not time-based correlation.

## WXGF Format

Some full-size images decrypt to `wxgf` (WeChat Graphics Format) instead of JPEG/PNG. This is a proprietary format that we cannot render directly. When a full-size `.dat` decrypts to WXGF, we fall back to the corresponding `_t.dat` thumbnail, which always decrypts to standard JPEG.

## Decryption Flow (in `wechat-media.ts`)

```
getImageDecrypted()
  1. Try cached thumbnail (fast path, no decryption)
  2. Find .dat via hardlink.db (extract md5 from message XML → lookup)
  3. Fallback: find .dat via filesystem mtime scan
  4. decryptDat() → AES-128-ECB decrypt head + XOR tail
  5. If format is WXGF → try _t.dat thumbnail instead
  6. detectImageFormat() → jpeg/png/gif/webp/wxgf
  7. Return base64 data
```

XOR byte is derived lazily from the first decrypted JPEG (via FFD9 trailer) and persisted for subsequent queries.

## Binary Version Dependency

The `IMAGE_XOR_MASK` is a compile-time constant that differs per binary build. Known masks are stored in `BUILD_PROFILES` in `extract-keys.py`, keyed by the first 8 hex chars of the ELF BuildID:

| BuildID prefix | Architecture | IMAGE_XOR_MASK |
|---------------|-------------|----------------|
| `71996acd` | aarch64 | `5e780583f2236b85...` |
| `20420b6d` | x86_64 | `5155035200510d06...` |

The decryption algorithm itself (AES-ECB + XOR) and the `.dat` file format are stable across versions.

### Discovering IMAGE_XOR_MASK for a new build

When WeChat updates and the BuildID changes, you need to extract a new mask. There are three approaches, from easiest to most involved.

#### Approach A: Shortcut (if you already have the plaintext key)

If the same account was previously running on a known build, the AES key is per-account and unchanged. You already know the plaintext. Just find the obfuscated copy and XOR:

1. Read the obfuscated key from the config singleton in BSS (pointer walk from GOT, offset `+0x1F8` for std::string)
2. Compute: `mask[i] = obfuscated[i] ^ plaintext_ascii[i]` for all 32 bytes
3. Verify the mask appears in `.rodata`: `objdump -s -j .rodata /opt/wechat/wechat | grep "<first 4 bytes hex>"`

This is how the amd64 mask was discovered — the key was already known from the aarch64 build.

#### Approach B: Static/dynamic reverse engineering

This is how the aarch64 mask was originally found. The mask is a 32-byte compile-time constant in `.rodata`, used by a deobfuscation function:

```
# The deobfuscation function does:
#   load ptr from GOT (config singleton)
#   walk 2 levels of pointers
#   read std::string at fixed offset (+0x1F8)
#   XOR each byte with .rodata constant
#   check if result is valid hex chars [0-9a-f]
```

**Dynamic**: Hook the image encrypt orchestrator (e.g. `0x568a040` on aarch64). Set a breakpoint where the XOR loop loads bytes from a fixed `.rodata` address. The source operand is the mask.

**Static**: Disassemble and find the XOR loop pattern:
```asm
# x86_64 pattern:
movzx eax, byte [rsi + rcx]    ; load obfuscated byte
xor   al, byte [rdi + rcx]     ; XOR with mask byte from .rodata
; ...compare against '0'-'9', 'a'-'f'...
```
The mask address (`rdi` source) points into `.rodata`. Dump 32 bytes from that address.

#### Approach C: Brute-force memory scan (no prior key, no RE needed)

Requires a running WeChat instance (new binary), logged into any account, with at least one image sent or received.

**Step 1: Find the plaintext AES key.**

Scan all RW regions of `/proc/pid/mem` for 32-byte sequences where every byte is an ASCII hex char (`0x30-0x39`, `0x61-0x66`). Test each as AES-128-ECB key (first 16 ASCII bytes) against any `.dat` file. Valid image header (JPEG `FF D8`, PNG `89 50 4E 47`) = correct key.

```python
hex_chars = set(range(0x30, 0x3a)) | set(range(0x61, 0x67))
for region in rw_regions:
    data = read_region(region)
    for i in range(len(data) - 31):
        if all(data[i+j] in hex_chars for j in range(32)):
            candidate = data[i:i+32]
            if aes_ecb_decrypt(dat_file, candidate[:16]) starts with known magic:
                plaintext_key = candidate  # found it
```

Slow (~minutes) but only needs to be done once per build.

**Step 2: Find the obfuscated key.**

The obfuscated key lives in the binary's BSS/data segment (not heap). Filter `/proc/pid/maps` for regions backed by the `wechat` binary. For each 32-byte window, XOR with the known plaintext ASCII bytes.

```python
plaintext_ascii = plaintext_key.encode("ascii")  # 32 bytes
for region in wechat_binary_regions:  # from /proc/pid/maps
    data = read_region(region)
    for i in range(len(data) - 31):
        candidate_mask = bytes(data[i+j] ^ plaintext_ascii[j] for j in range(32))
        if candidate_mask != b'\x00' * 32:  # not the plaintext itself
            masks.append(candidate_mask)
```

**Step 3: Verify the mask.**

Use each candidate mask with the regex scan algorithm (`extract_image_aes_key`). The correct mask will re-discover the plaintext key. Wrong masks find nothing (false positive probability ~3e-39).

```python
found_key = extract_image_aes_key(pid, {"image_xor_mask": candidate_mask})
assert found_key == plaintext_key_string
```

Optionally confirm the mask exists in `.rodata`:
```bash
objdump -s -j .rodata /opt/wechat/wechat | grep "<first 4 bytes hex>"
```

#### Adding to BUILD_PROFILES

Get the BuildID with `readelf -n /opt/wechat/wechat`, take the first 8 hex chars as the key, and add the verified mask to `BUILD_PROFILES` in `extract-keys.py`.

## Verified Against

- JPEG, PNG, and WXGF images across multiple chats
- Both aarch64 and x86_64 (Rosetta 2) builds
- XOR byte derivation from JPEG trailer (0x85 confirmed for test account)
- WXGF → thumbnail fallback returns valid JPEG
