use axum::{
    extract::{Path, Query},
    Json,
};
use serde::Deserialize;

use crate::db::get_db;
use crate::ia::types::{MediaResult, Message, SendResult};
use crate::tools::wechat_keys::{get_stored_keys, get_image_keys};
use crate::tools::wechat_media::get_message_media;
use crate::tools::wechat_messages;
use crate::sessions::manager::get_session;

#[derive(Deserialize)]
pub struct ListParams {
    #[serde(default = "default_limit")]
    limit: i64,
    #[serde(default)]
    offset: i64,
}

fn default_limit() -> i64 {
    50
}

pub async fn list_messages(
    Path(chat_id): Path<String>,
    Query(params): Query<ListParams>,
) -> Json<Vec<Message>> {
    let session = match get_session("default") {
        Some(s) => s,
        None => return Json(Vec::new()),
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => return Json(Vec::new()),
    };

    let db = get_db();
    let keys = get_stored_keys(&db, &session.id, &logged_in_user);
    if !keys.contains_key("message_0.db") {
        return Json(Vec::new());
    }

    Json(wechat_messages::list_messages(
        &logged_in_user,
        &keys,
        &chat_id,
        params.limit,
        params.offset,
    ))
}

pub async fn get_media(Path((chat_id, local_id)): Path<(String, i64)>) -> Json<MediaResult> {
    let session = match get_session("default") {
        Some(s) => s,
        None => {
            return Json(MediaResult {
                media_type: "unsupported".to_string(),
                data: None,
                url: None,
                format: String::new(),
                filename: String::new(),
            })
        }
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => {
            return Json(MediaResult {
                media_type: "unsupported".to_string(),
                data: None,
                url: None,
                format: String::new(),
                filename: String::new(),
            })
        }
    };

    let db = get_db();
    let keys = get_stored_keys(&db, &session.id, &logged_in_user);
    let image_keys = get_image_keys(&db, &session.id, &logged_in_user);

    Json(get_message_media(
        &logged_in_user,
        &keys,
        &chat_id,
        local_id,
        image_keys,
    ))
}

#[derive(Deserialize)]
pub struct SendParams {
    #[serde(rename = "chatId")]
    chat_id: String,
    text: Option<String>,
    image: Option<ImageInput>,
    file: Option<FileInput>,
}

#[derive(Deserialize)]
pub struct ImageInput {
    data: String,
    #[serde(rename = "mimeType")]
    mime_type: String,
}

#[derive(Deserialize)]
pub struct FileInput {
    data: String,
    filename: String,
}

pub async fn send_message(Json(input): Json<SendParams>) -> Json<SendResult> {
    if input.text.is_none() && input.image.is_none() && input.file.is_none() {
        return Json(SendResult {
            success: false,
            error: Some("No text, image, or file provided".to_string()),
        });
    }

    // TODO: Run send-message FSM plan
    Json(SendResult {
        success: false,
        error: Some("Not yet implemented".to_string()),
    })
}
