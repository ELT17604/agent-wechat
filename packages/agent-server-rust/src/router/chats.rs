use axum::{extract::{Path, Query}, Json};
use serde::Deserialize;

use crate::db::get_db;
use crate::ia::types::Chat;
use crate::tools::wechat_chats;
use crate::tools::wechat_keys::get_stored_keys;
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

pub async fn list_chats(Query(params): Query<ListParams>) -> Json<Vec<Chat>> {
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
    if !keys.contains_key("session.db") || !keys.contains_key("contact.db") {
        return Json(Vec::new());
    }

    Json(wechat_chats::list_chats(
        &logged_in_user,
        &keys,
        params.limit,
        params.offset,
    ))
}

pub async fn get_chat(Path(id): Path<String>) -> Json<Option<Chat>> {
    let session = match get_session("default") {
        Some(s) => s,
        None => return Json(None),
    };
    let logged_in_user = match &session.logged_in_user {
        Some(u) => u.clone(),
        None => return Json(None),
    };

    let db = get_db();
    let keys = get_stored_keys(&db, &session.id, &logged_in_user);
    Json(wechat_chats::get_chat_by_username(&logged_in_user, &keys, &id))
}

#[derive(Deserialize)]
pub struct FindParams {
    name: String,
}

pub async fn find_chats(Query(params): Query<FindParams>) -> Json<Vec<Chat>> {
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
    Json(wechat_chats::find_chats_by_name(
        &logged_in_user,
        &keys,
        &params.name,
    ))
}

pub async fn open_chat(Path(_chat_id): Path<String>) -> Json<serde_json::Value> {
    // TODO: Run chat-open FSM plan
    Json(serde_json::json!({
        "ok": false,
        "error": "Not yet implemented"
    }))
}
