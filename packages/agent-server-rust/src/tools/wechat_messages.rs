use super::wechat_db::{get_db_path, query_wechat_db};
use crate::ia::types::Message;
use std::collections::HashMap;

/// List messages for a specific chat.
pub fn list_messages(
    account_dir: &str,
    keys: &HashMap<String, String>,
    chat_id: &str,
    limit: i64,
    offset: i64,
) -> Vec<Message> {
    let message_key = match keys.get("message_0.db") {
        Some(k) => k,
        None => return Vec::new(),
    };

    let message_db = get_db_path(account_dir, "message_0.db");
    let escaped = chat_id.replace('\'', "''");

    let rows = query_wechat_db(
        &message_db,
        message_key,
        &format!(
            "SELECT local_id, server_id, local_type, sort_seq, content, sender, create_time
             FROM message
             WHERE chat_name = '{escaped}'
             ORDER BY sort_seq DESC
             LIMIT {limit} OFFSET {offset};"
        ),
    );

    rows.iter()
        .filter_map(|row| {
            let local_id = row.get("local_id")?.as_i64()?;
            let server_id = row.get("server_id").and_then(|v| v.as_i64()).unwrap_or(0);
            let msg_type = row.get("local_type").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let content = row
                .get("content")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let sender = row
                .get("sender")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from);
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
