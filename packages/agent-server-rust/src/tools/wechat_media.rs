use crate::ia::types::MediaResult;
use std::collections::HashMap;

/// Get media attachment for a message.
/// This is a stub that mirrors the TS implementation structure.
pub fn get_message_media(
    _account_dir: &str,
    _keys: &HashMap<String, String>,
    _chat_id: &str,
    _local_id: i64,
    _image_keys: Option<(String, Option<u8>)>,
) -> MediaResult {
    // TODO: Implement full media extraction (WXGF decode, image thumbnail, emoji, voice)
    MediaResult {
        media_type: "unsupported".to_string(),
        data: None,
        url: None,
        format: String::new(),
        filename: String::new(),
    }
}
