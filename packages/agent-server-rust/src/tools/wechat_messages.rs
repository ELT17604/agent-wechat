use super::wechat_db::{get_db_path, query_wechat_db};
use crate::ia::types::Message;
use md5::{Digest, Md5};
use std::collections::HashMap;

/// ZSTD magic number (little-endian): 0xFD2FB528
const ZSTD_MAGIC: &str = "28b52ffd";

/// Get the Msg table name for a given chat username.
/// WeChat uses MD5(username) as the table suffix.
pub fn get_msg_table_name(chat_id: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(chat_id.as_bytes());
    let hash = hasher.finalize();
    format!("Msg_{:x}", hash)
}

/// Decode hex-encoded message content, decompressing zstd if needed.
pub fn decode_message_content(hex: &str, is_compressed: bool) -> String {
    if hex.is_empty() {
        return String::new();
    }
    let bytes = match hex_decode(hex) {
        Some(b) => b,
        None => return String::new(),
    };
    if is_compressed && hex.len() >= 8 && hex[..8].eq_ignore_ascii_case(ZSTD_MAGIC) {
        match zstd::decode_all(bytes.as_slice()) {
            Ok(decompressed) => String::from_utf8_lossy(&decompressed).to_string(),
            Err(_) => "[compressed content - decompression failed]".to_string(),
        }
    } else {
        String::from_utf8_lossy(&bytes).to_string()
    }
}

/// Decode a hex string to bytes.
pub fn hex_decode(hex: &str) -> Option<Vec<u8>> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(hex.len() / 2);
    for i in (0..hex.len()).step_by(2) {
        let byte = u8::from_str_radix(&hex[i..i + 2], 16).ok()?;
        bytes.push(byte);
    }
    Some(bytes)
}

/// Extract sender from group message content.
/// Group messages have format "sender_wxid:\nmessage_content".
fn extract_group_sender(content: &str) -> (Option<String>, String) {
    if let Some(idx) = content.find(":\n") {
        if idx < 80 {
            let sender = content[..idx].to_string();
            let msg = content[idx + 2..].to_string();
            return (Some(sender), msg);
        }
    }
    (None, content.to_string())
}

/// Clean message content for display based on message type.
/// Replaces verbose XML with concise summaries.
fn clean_content(content: &str, msg_type: i32) -> String {
    let base = msg_type & 0x7FFFFFFF;
    match base {
        // Image (type 3): replace XML with empty string
        3 if content.contains("<img") => String::new(),
        // Emoji (type 47): extract description or clear
        47 if content.contains("<emoji") => {
            extract_xml_attr(content, "desc").unwrap_or_default()
        }
        // Appmsg (type 49): extract title
        49 if content.contains("<msg>") => {
            extract_xml_tag(content, "title").unwrap_or_else(|| content.to_string())
        }
        _ => content.to_string(),
    }
}

/// Extract an XML attribute value: attr="value"
fn extract_xml_attr(xml: &str, attr: &str) -> Option<String> {
    let pattern = format!("{attr}=\"");
    let start = xml.find(&pattern)? + pattern.len();
    let end = xml[start..].find('"')? + start;
    let val = xml[start..end].trim().to_string();
    if val.is_empty() { None } else { Some(val) }
}

/// Extract text between XML tags: <tag>text</tag>
fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    let val = xml[start..end].trim().to_string();
    if val.is_empty() { None } else { Some(val) }
}

/// Find which message DB contains a chat and return (db_name, key).
pub fn find_message_db<'a>(
    account_dir: &str,
    keys: &'a HashMap<String, String>,
    chat_id: &str,
) -> Option<(String, &'a str)> {
    let table_name = get_msg_table_name(chat_id);
    let mut message_dbs: Vec<(&str, &str)> = keys
        .iter()
        .filter(|(k, _)| {
            k.starts_with("message_")
                && k.ends_with(".db")
                && !k.contains("fts")
                && !k.contains("resource")
        })
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    message_dbs.sort_by_key(|(k, _)| k.to_string());

    for (db_name, key) in &message_dbs {
        let db_path = get_db_path(account_dir, db_name);
        let check = query_wechat_db(
            &db_path,
            key,
            &format!(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='{table_name}';"
            ),
        );
        if !check.is_empty() {
            return Some((db_name.to_string(), key));
        }
    }
    None
}

/// List messages for a specific chat.
///
/// Messages may be spread across message_0.db, message_1.db, etc.
/// Each chat's messages are in a `Msg_{MD5(username)}` table.
pub fn list_messages(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    limit: i64,
    offset: i64,
) -> Vec<Message> {
    let table_name = get_msg_table_name(chat_id);
    let is_group = chat_id.contains("@chatroom");

    let (db_name, key) = match find_message_db(account_dir, keys, chat_id) {
        Some(dk) => dk,
        None => return Vec::new(),
    };
    let db_path = get_db_path(account_dir, &db_name);

    // Query messages using hex() for safe binary/compressed content extraction
    let rows = query_wechat_db(
        &db_path,
        key,
        &format!(
            "SELECT local_id, server_id, local_type, create_time,
                    hex(message_content) as hex_content,
                    WCDB_CT_message_content as is_compressed
             FROM \"{table_name}\"
             ORDER BY create_time DESC
             LIMIT {limit} OFFSET {offset};"
        ),
    );

    rows.iter()
        .filter_map(|row| {
            let local_id = row.get("local_id")?.as_i64()?;
            let server_id = row
                .get("server_id")
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let msg_type = row
                .get("local_type")
                .and_then(|v| v.as_i64())
                .unwrap_or(0) as i32;

            let hex_content = row
                .get("hex_content")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let is_compressed = row
                .get("is_compressed")
                .and_then(|v| v.as_i64())
                .unwrap_or(0)
                != 0;

            let raw_content = decode_message_content(hex_content, is_compressed);

            // Extract sender for group messages ("wxid:\ncontent" format)
            let (sender, body) = if is_group {
                extract_group_sender(&raw_content)
            } else {
                (None, raw_content)
            };

            // Clean content for display (replace XML with summaries)
            let content = clean_content(&body, msg_type);

            let timestamp = row
                .get("create_time")
                .and_then(|v| v.as_i64())
                .map(|t| {
                    chrono::DateTime::from_timestamp(t, 0)
                        .map(|dt| dt.to_rfc3339())
                        .unwrap_or_default()
                })
                .unwrap_or_default();

            Some(Message {
                local_id,
                server_id,
                chat_id: chat_id.to_string(),
                sender,
                msg_type,
                content,
                timestamp,
            })
        })
        .collect()
}
