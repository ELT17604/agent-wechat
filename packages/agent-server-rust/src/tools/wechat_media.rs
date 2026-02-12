use crate::ia::types::MediaResult;
use crate::tools::wechat_db::{get_db_path, query_wechat_db};
use crate::tools::wechat_messages::{decode_message_content, find_message_db, get_msg_table_name};
use md5::{Digest, Md5};
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;

/// WeChat .dat file magic bytes: 07 08 56 32 08 07
const DAT_MAGIC: [u8; 6] = [0x07, 0x08, 0x56, 0x32, 0x08, 0x07];

struct ImageKeys {
    aes_key_hex: String,
    xor_byte: Option<u8>,
}

fn unsupported() -> MediaResult {
    MediaResult {
        media_type: "unsupported".into(),
        data: None,
        url: None,
        format: String::new(),
        filename: String::new(),
    }
}

fn account_base_paths(account_dir: &str) -> [String; 2] {
    [
        format!("/home/wechat/xwechat_files/{account_dir}"),
        format!("/home/wechat/Documents/xwechat_files/{account_dir}"),
    ]
}

/// Look up a single message's raw content by localId.
fn lookup_message_raw(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
) -> Option<(i32, i64, String)> {
    let table_name = get_msg_table_name(chat_id);
    let (db_name, key) = find_message_db(account_dir, keys, chat_id)?;
    let db_path = get_db_path(account_dir, &db_name);

    let rows = query_wechat_db(
        &db_path,
        key,
        &format!(
            "SELECT local_type, create_time,
                    hex(message_content) as hex_content,
                    WCDB_CT_message_content as is_compressed
             FROM \"{table_name}\"
             WHERE local_id = {local_id}
             LIMIT 1;"
        ),
    );

    let row = rows.first()?;
    let local_type = row.get("local_type")?.as_i64()? as i32;
    let create_time = row.get("create_time").and_then(|v| v.as_i64()).unwrap_or(0);
    let hex_content = row
        .get("hex_content")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let is_compressed = row
        .get("is_compressed")
        .and_then(|v| v.as_i64())
        .unwrap_or(0)
        != 0;

    let content = decode_message_content(hex_content, is_compressed);
    // Strip group sender prefix
    let body = if let Some(idx) = content.find(":\n") {
        if idx < 80 {
            content[idx + 2..].to_string()
        } else {
            content
        }
    } else {
        content
    };

    Some((local_type, create_time, body))
}

/// Extract an XML attribute value.
fn xml_attr(xml: &str, attr: &str) -> Option<String> {
    let pat = format!("{attr}=\"");
    let start = xml.find(&pat)? + pat.len();
    let end = xml[start..].find('"')? + start;
    let val = xml[start..end].trim().to_string();
    if val.is_empty() {
        None
    } else {
        Some(val)
    }
}

// ── Image thumbnail from filesystem cache ────────────────────────────────────

fn get_image_thumbnail(
    account_dir: &str,
    chat_id: &str,
    local_id: i64,
    create_time: i64,
) -> Option<MediaResult> {
    let hash = format!("{:x}", Md5::digest(chat_id.as_bytes()));
    let dt = chrono::DateTime::from_timestamp(create_time, 0)?;
    let year_month = dt.format("%Y-%m").to_string();
    let thumb_name = format!("{local_id}_{create_time}_thumb.jpg");

    for base in &account_base_paths(account_dir) {
        let thumb_path = Path::new(base)
            .join("cache")
            .join(&year_month)
            .join("Message")
            .join(&hash)
            .join("Thumb")
            .join(&thumb_name);
        if thumb_path.exists() {
            if let Ok(data) = fs::read(&thumb_path) {
                return Some(MediaResult {
                    media_type: "image".into(),
                    data: Some(base64::Engine::encode(
                        &base64::engine::general_purpose::STANDARD,
                        &data,
                    )),
                    url: None,
                    format: "jpeg".into(),
                    filename: format!("msg_{local_id}.jpg"),
                });
            }
        }

        // Fallback: find any thumbnail matching this localId
        let thumb_dir = Path::new(base)
            .join("cache")
            .join(&year_month)
            .join("Message")
            .join(&hash)
            .join("Thumb");
        if let Ok(entries) = fs::read_dir(&thumb_dir) {
            let prefix = format!("{local_id}_");
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with(&prefix) {
                    if let Ok(data) = fs::read(entry.path()) {
                        return Some(MediaResult {
                            media_type: "image".into(),
                            data: Some(base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                &data,
                            )),
                            url: None,
                            format: "jpeg".into(),
                            filename: format!("msg_{local_id}.jpg"),
                        });
                    }
                }
            }
        }
    }
    None
}

// ── .dat file decryption ─────────────────────────────────────────────────────

fn aligned_aes_size(enc_chunk_size: u32) -> u32 {
    let rem = enc_chunk_size % 16;
    if rem == 0 {
        enc_chunk_size + 16
    } else {
        enc_chunk_size + (16 - rem)
    }
}

fn decrypt_dat_head(dat: &[u8], aes_key_hex: &str) -> Option<(Vec<u8>, u32)> {
    if dat.len() < 15 || dat[..6] != DAT_MAGIC {
        return None;
    }
    let enc_chunk_size = u32::from_le_bytes(dat[6..10].try_into().ok()?);
    let aes_key = &aes_key_hex.as_bytes()[..16]; // first 16 ASCII chars

    let aligned = aligned_aes_size(enc_chunk_size) as usize;
    if dat.len() < 15 + aligned {
        return None;
    }
    let ct = &dat[15..15 + aligned];

    // AES-128-ECB decrypt via openssl CLI (no native Rust AES dep needed)
    let mut child = Command::new("openssl")
        .args(["enc", "-d", "-aes-128-ecb", "-K"])
        .arg(hex_encode(aes_key))
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    use std::io::Write;
    child.stdin.take()?.write_all(ct).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }

    Some((output.stdout, enc_chunk_size))
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

fn derive_xor_byte(dat: &[u8], dec_head: &[u8]) -> Option<u8> {
    if dec_head.len() >= 2 && dec_head[0] == 0xff && dec_head[1] == 0xd8 {
        // JPEG: last 2 bytes should be FF D9
        let c1 = dat[dat.len() - 2] ^ 0xFF;
        let c2 = dat[dat.len() - 1] ^ 0xD9;
        if c1 == c2 {
            return Some(c1);
        }
    }
    if dec_head.len() >= 4 && dec_head[..4] == [0x89, 0x50, 0x4e, 0x47] {
        // PNG: last 8 bytes are IEND chunk
        let expected = [0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82];
        if dat.len() >= 8 {
            let ts = dat.len() - 8;
            let xb = dat[ts] ^ expected[0];
            if expected
                .iter()
                .enumerate()
                .all(|(i, &e)| (dat[ts + i] ^ xb) == e)
            {
                return Some(xb);
            }
        }
    }
    if dec_head.len() >= 4 && &dec_head[..4] == b"GIF8" {
        // GIF: last 2 bytes are 00 3B
        let c1 = dat[dat.len() - 2] ^ 0x00;
        let c2 = dat[dat.len() - 1] ^ 0x3B;
        if c1 == c2 {
            return Some(c1);
        }
    }
    None
}

fn resolve_xor_byte(
    dat_path: &str,
    dat: &[u8],
    image_keys: &ImageKeys,
) -> Option<u8> {
    if let Some(xb) = image_keys.xor_byte {
        return Some(xb);
    }
    let (dec_head, _) = decrypt_dat_head(dat, &image_keys.aes_key_hex)?;
    let xb = derive_xor_byte(dat, &dec_head);
    if xb.is_some() {
        return xb;
    }
    // Try sibling _t.dat files (JPEG thumbnails are reliable for XOR derivation)
    let dir = Path::new(dat_path).parent()?;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with("_t.dat") {
                continue;
            }
            if let Ok(sib) = fs::read(entry.path()) {
                if sib.len() < 15 || sib[..6] != DAT_MAGIC {
                    continue;
                }
                if let Some((sib_head, _)) =
                    decrypt_dat_head(&sib, &image_keys.aes_key_hex)
                {
                    if let Some(xb) = derive_xor_byte(&sib, &sib_head) {
                        return Some(xb);
                    }
                }
            }
        }
    }
    None
}

fn decrypt_dat(dat: &[u8], aes_key_hex: &str, xor_byte: u8) -> Option<Vec<u8>> {
    let (dec_head, enc_chunk_size) = decrypt_dat_head(dat, aes_key_hex)?;
    let xor_size = u32::from_le_bytes(dat[10..14].try_into().ok()?) as usize;
    let aes_ct_end = 15 + aligned_aes_size(enc_chunk_size) as usize;
    let remaining = &dat[aes_ct_end..];

    let raw_length = remaining.len().saturating_sub(xor_size);
    let raw_data = &remaining[..raw_length];
    let xor_data = &remaining[raw_length..];

    let dec_tail: Vec<u8> = xor_data.iter().map(|b| b ^ xor_byte).collect();

    let mut result = Vec::with_capacity(dec_head.len() + raw_data.len() + dec_tail.len());
    result.extend_from_slice(&dec_head);
    result.extend_from_slice(raw_data);
    result.extend_from_slice(&dec_tail);
    Some(result)
}

fn detect_image_format(data: &[u8]) -> (&'static str, &'static str) {
    if data.len() >= 2 && data[0] == 0xff && data[1] == 0xd8 {
        return ("jpeg", "jpg");
    }
    if data.len() >= 4 && data[..4] == [0x89, 0x50, 0x4e, 0x47] {
        return ("png", "png");
    }
    if data.len() >= 4 && &data[..4] == b"GIF8" {
        return ("gif", "gif");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return ("webp", "webp");
    }
    if data.len() >= 4 && &data[..4] == b"wxgf" {
        return ("wxgf", "wxgf");
    }
    ("unknown", "bin")
}

/// Convert media via the media-convert tool.
fn convert_media(mode: &str, input: &[u8]) -> Option<(Vec<u8>, String)> {
    use std::io::Write;
    let mut child = Command::new("media-convert")
        .arg(mode)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .ok()?;
    child.stdin.take()?.write_all(input).ok()?;
    let output = child.wait_with_output().ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let format = stderr
        .lines()
        .find_map(|l| l.strip_prefix("FORMAT:"))
        .unwrap_or(if mode == "silk2mp3" { "mp3" } else { "jpeg" })
        .to_string();
    Some((output.stdout, format))
}

// ── .dat file resolution via hardlink.db ─────────────────────────────────────

fn find_dat_via_hardlink(
    account_dir: &str,
    keys: &HashMap<String, String>,
    _chat_id: &str,
    content: &str,
) -> Option<String> {
    let hardlink_key = keys.get("hardlink.db")?;
    let image_md5 = xml_attr(content, "md5")?;
    let hardlink_db = get_db_path(account_dir, "hardlink.db");

    let file_rows = query_wechat_db(
        &hardlink_db,
        hardlink_key,
        &format!(
            "SELECT file_name, dir1, dir2 FROM image_hardlink_info_v4
             WHERE md5 = '{image_md5}' LIMIT 2;"
        ),
    );
    let row = file_rows.first()?;
    let file_name = row.get("file_name")?.as_str()?;
    let dir1 = row.get("dir1")?.as_i64()?;
    let dir2 = row.get("dir2")?.as_i64()?;

    let dir_rows = query_wechat_db(
        &hardlink_db,
        hardlink_key,
        &format!("SELECT rowid, username FROM dir2id WHERE rowid IN ({dir1}, {dir2});"),
    );
    let dir_map: HashMap<i64, String> = dir_rows
        .iter()
        .filter_map(|r| {
            let rid = r.get("rowid")?.as_i64()?;
            let name = r.get("username")?.as_str()?.to_string();
            Some((rid, name))
        })
        .collect();

    let chat_dir = dir_map.get(&dir1)?;
    let date_dir = dir_map.get(&dir2)?;

    for base in &account_base_paths(account_dir) {
        let dat_path = Path::new(base)
            .join("msg/attach")
            .join(chat_dir)
            .join(date_dir)
            .join("Img")
            .join(file_name);
        if dat_path.exists() {
            return Some(dat_path.to_string_lossy().to_string());
        }
    }
    None
}

fn decrypt_and_return(
    dat_path: &str,
    image_keys: &ImageKeys,
    local_id: i64,
) -> MediaResult {
    let dat = match fs::read(dat_path) {
        Ok(d) => d,
        Err(_) => {
            return MediaResult {
                media_type: "image".into(),
                data: None,
                url: None,
                format: "jpeg".into(),
                filename: format!("msg_{local_id}.jpg"),
            }
        }
    };

    let xor_byte = match resolve_xor_byte(dat_path, &dat, image_keys) {
        Some(xb) => xb,
        None => {
            return MediaResult {
                media_type: "image".into(),
                data: None,
                url: None,
                format: "jpeg".into(),
                filename: format!("msg_{local_id}.jpg"),
            }
        }
    };

    let decrypted = match decrypt_dat(&dat, &image_keys.aes_key_hex, xor_byte) {
        Some(d) => d,
        None => {
            return MediaResult {
                media_type: "image".into(),
                data: None,
                url: None,
                format: "jpeg".into(),
                filename: format!("msg_{local_id}.jpg"),
            }
        }
    };

    let (format, ext) = detect_image_format(&decrypted);

    // WXGF → convert via ffmpeg, fall back to thumbnail
    if format == "wxgf" {
        if let Some((converted, cfmt)) = convert_media("wxgf2img", &decrypted) {
            let cext = if cfmt == "jpeg" {
                "jpg".to_string()
            } else {
                cfmt.clone()
            };
            return MediaResult {
                media_type: "image".into(),
                data: Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &converted,
                )),
                url: None,
                format: cfmt,
                filename: format!("msg_{local_id}.{cext}"),
            };
        }
        // Try _t.dat thumbnail
        let thumb_path = dat_path.replace(".dat", "_t.dat");
        if Path::new(&thumb_path).exists() {
            if let Ok(thumb_dat) = fs::read(&thumb_path) {
                if let Some(xb2) = resolve_xor_byte(&thumb_path, &thumb_dat, image_keys) {
                    if let Some(dec) =
                        decrypt_dat(&thumb_dat, &image_keys.aes_key_hex, xb2)
                    {
                        let (tf, te) = detect_image_format(&dec);
                        return MediaResult {
                            media_type: "image".into(),
                            data: Some(base64::Engine::encode(
                                &base64::engine::general_purpose::STANDARD,
                                &dec,
                            )),
                            url: None,
                            format: tf.into(),
                            filename: format!("msg_{local_id}.{te}"),
                        };
                    }
                }
            }
        }
    }

    MediaResult {
        media_type: "image".into(),
        data: Some(base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &decrypted,
        )),
        url: None,
        format: format.into(),
        filename: format!("msg_{local_id}.{ext}"),
    }
}

// ── Emoji ────────────────────────────────────────────────────────────────────

fn get_emoji_media(
    account_dir: &str,
    keys: &HashMap<String, String>,
    content: &str,
    _local_id: i64,
) -> MediaResult {
    let md5_val = match xml_attr(content, "md5") {
        Some(m) => m,
        None => return unsupported(),
    };

    // Look up CDN URL from emoticon.db
    if let Some(emoticon_key) = keys.get("emoticon.db") {
        let emoticon_db = get_db_path(account_dir, "emoticon.db");
        let rows = query_wechat_db(
            &emoticon_db,
            emoticon_key,
            &format!(
                "SELECT cdn_url FROM kNonStoreEmoticonTable WHERE md5 = '{md5_val}' LIMIT 1;"
            ),
        );
        if let Some(row) = rows.first() {
            if let Some(url) = row.get("cdn_url").and_then(|v| v.as_str()) {
                if !url.is_empty() {
                    return MediaResult {
                        media_type: "emoji".into(),
                        data: None,
                        url: Some(url.to_string()),
                        format: "gif".into(),
                        filename: format!("emoji_{md5_val}.gif"),
                    };
                }
            }
        }
    }

    // Fallback: extract cdnurl from message XML
    if let Some(url) = xml_attr(content, "cdnurl") {
        if url.starts_with("http") {
            return MediaResult {
                media_type: "emoji".into(),
                data: None,
                url: Some(url),
                format: "gif".into(),
                filename: format!("emoji_{md5_val}.gif"),
            };
        }
    }

    MediaResult {
        media_type: "emoji".into(),
        data: None,
        url: None,
        format: "unknown".into(),
        filename: format!("emoji_{md5_val}"),
    }
}

// ── Voice ────────────────────────────────────────────────────────────────────

fn get_voice_data(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
) -> MediaResult {
    // Try media_0.db, media_1.db, etc.
    let mut media_dbs: Vec<(&str, &str)> = keys
        .iter()
        .filter(|(k, _)| k.starts_with("media_") && k.ends_with(".db"))
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    media_dbs.sort_by_key(|(k, _)| k.to_string());

    for (db_name, media_key) in &media_dbs {
        let media_db = get_db_path(account_dir, db_name);

        let name_rows = query_wechat_db(
            &media_db,
            media_key,
            &format!(
                "SELECT rowid FROM Name2Id WHERE user_name = '{}';",
                chat_id.replace('\'', "''")
            ),
        );
        let chat_name_id = match name_rows.first().and_then(|r| r.get("rowid")?.as_i64()) {
            Some(id) => id,
            None => continue,
        };

        let voice_rows = query_wechat_db(
            &media_db,
            media_key,
            &format!(
                "SELECT hex(voice_data) as hex_data FROM VoiceInfo
                 WHERE chat_name_id = {chat_name_id} AND local_id = {local_id}
                 LIMIT 1;"
            ),
        );
        let hex_data = match voice_rows
            .first()
            .and_then(|r| r.get("hex_data")?.as_str())
        {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => continue,
        };

        let silk_bytes = match crate::tools::wechat_messages::hex_decode(&hex_data) {
            Some(b) => b,
            None => continue,
        };

        // Try SILK → MP3 conversion
        if let Some((mp3, _)) = convert_media("silk2mp3", &silk_bytes) {
            return MediaResult {
                media_type: "voice".into(),
                data: Some(base64::Engine::encode(
                    &base64::engine::general_purpose::STANDARD,
                    &mp3,
                )),
                url: None,
                format: "mp3".into(),
                filename: format!("msg_{local_id}.mp3"),
            };
        }

        // Fall back to raw SILK
        return MediaResult {
            media_type: "voice".into(),
            data: Some(base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                &silk_bytes,
            )),
            url: None,
            format: "silk".into(),
            filename: format!("msg_{local_id}.silk"),
        };
    }

    unsupported()
}

// ── Public entry point ───────────────────────────────────────────────────────

/// Get media attachment for a message.
pub fn get_message_media(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    local_id: i64,
    image_keys_raw: Option<(String, Option<u8>)>,
) -> MediaResult {
    let (local_type, create_time, content) =
        match lookup_message_raw(account_dir, keys, chat_id, local_id) {
            Some(t) => t,
            None => return unsupported(),
        };

    let base = local_type & 0x7FFFFFFF;

    match base {
        3 => {
            // Image
            // Try cached thumbnail first
            if let Some(thumb) =
                get_image_thumbnail(account_dir, chat_id, local_id, create_time)
            {
                return thumb;
            }

            // Try .dat decryption if we have image keys
            if let Some((aes_hex, xor_byte)) = image_keys_raw {
                let image_keys = ImageKeys {
                    aes_key_hex: aes_hex,
                    xor_byte,
                };

                // Try hardlink.db path resolution
                if let Some(dat_path) =
                    find_dat_via_hardlink(account_dir, keys, chat_id, &content)
                {
                    return decrypt_and_return(&dat_path, &image_keys, local_id);
                }
            }

            // Image exists but can't be retrieved
            MediaResult {
                media_type: "image".into(),
                data: None,
                url: None,
                format: "jpeg".into(),
                filename: format!("msg_{local_id}.jpg"),
            }
        }
        34 => {
            // Voice
            get_voice_data(account_dir, keys, chat_id, local_id)
        }
        47 => {
            // Emoji
            get_emoji_media(account_dir, keys, &content, local_id)
        }
        _ => {
            // Other types: check for cached thumbnail
            if let Some(thumb) =
                get_image_thumbnail(account_dir, chat_id, local_id, create_time)
            {
                return thumb;
            }
            unsupported()
        }
    }
}
