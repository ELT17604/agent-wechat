use axum::{
    extract::{ws::{Message, WebSocket, WebSocketUpgrade}, Query},
    response::IntoResponse,
    Json,
};
use serde::Deserialize;

use crate::ia::types::LoginSubscriptionEvent;
use crate::tools::exec::ExecOptions;
use crate::tools::qr::{decode_qr_from_base64, to_data_url};
use crate::tools::screenshot::capture_screenshot;
use crate::sessions::manager::get_session;

pub async fn get_status() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "container": "running",
        "loginState": { "status": "logged_out" },
        "version": "0.1.0"
    }))
}

pub async fn auth_status() -> Json<serde_json::Value> {
    let session = get_session("default");
    let logged_in_user = session.and_then(|s| s.logged_in_user);
    Json(serde_json::json!({
        "isLoggedIn": logged_in_user.is_some(),
        "loggedInUser": logged_in_user
    }))
}

pub async fn login() -> Json<serde_json::Value> {
    let screenshot = capture_screenshot(&ExecOptions::default()).await;

    match screenshot {
        Ok(b64) => {
            if let Some(qr_result) = decode_qr_from_base64(&b64) {
                let data_url = to_data_url(&qr_result.data).ok();
                return Json(serde_json::json!({
                    "success": false,
                    "state": { "status": "qr_pending" },
                    "qrDataUrl": data_url
                }));
            }

            Json(serde_json::json!({
                "success": false,
                "state": { "status": "qr_pending" }
            }))
        }
        Err(_) => Json(serde_json::json!({
            "success": false,
            "state": { "status": "logged_out" }
        })),
    }
}

#[derive(Deserialize)]
pub struct LoginWsParams {
    #[serde(rename = "timeoutMs", default = "default_timeout")]
    timeout_ms: u64,
    #[serde(rename = "newAccount", default)]
    _new_account: bool,
}

fn default_timeout() -> u64 {
    300_000
}

pub async fn login_ws(
    ws: WebSocketUpgrade,
    Query(params): Query<LoginWsParams>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_login_ws(socket, params))
}

async fn handle_login_ws(mut socket: WebSocket, params: LoginWsParams) {
    // Send initial status
    let msg = serde_json::to_string(&LoginSubscriptionEvent::Status {
        message: "Navigating login flow...".to_string(),
    })
    .unwrap();
    let _ = socket.send(Message::Text(msg.into())).await;

    // TODO: Run the login FSM execution loop here
    // For now, just keep the connection open until timeout
    let timeout = tokio::time::sleep(std::time::Duration::from_millis(params.timeout_ms));
    tokio::pin!(timeout);

    loop {
        tokio::select! {
            _ = &mut timeout => {
                let msg = serde_json::to_string(&LoginSubscriptionEvent::LoginTimeout).unwrap();
                let _ = socket.send(Message::Text(msg.into())).await;
                break;
            }
            msg = socket.recv() => {
                match msg {
                    Some(Ok(_)) => continue,
                    _ => break,
                }
            }
        }
    }
}
