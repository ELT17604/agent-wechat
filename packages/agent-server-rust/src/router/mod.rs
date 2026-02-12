mod chats;
mod debug;
mod events;
mod messages;
mod sessions;
mod status;

use axum::{
    http::Method,
    routing::{get, post},
    Router,
};
use tower_http::cors::{Any, CorsLayer};

/// Build the full axum Router.
pub fn build_router() -> Router {
    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_origin(Any)
        .allow_headers(Any);

    Router::new()
        // Status
        .route("/api/status", get(status::get_status))
        .route("/api/status/auth", get(status::auth_status))
        .route("/api/status/login", post(status::login))
        // Chats
        .route("/api/chats", get(chats::list_chats))
        .route("/api/chats/{id}", get(chats::get_chat))
        .route("/api/chats/find", get(chats::find_chats))
        .route("/api/chats/{id}/open", post(chats::open_chat))
        // Messages
        .route("/api/messages/{chat_id}", get(messages::list_messages))
        .route(
            "/api/messages/{chat_id}/media/{local_id}",
            get(messages::get_media),
        )
        .route("/api/messages/send", post(messages::send_message))
        // Debug
        .route("/api/debug/screenshot", get(debug::screenshot))
        .route("/api/debug/a11y", get(debug::a11y))
        // Sessions
        .route("/api/sessions", get(sessions::list_sessions).post(sessions::create_session))
        .route("/api/sessions/{id}", get(sessions::get_session).delete(sessions::delete_session))
        .route("/api/sessions/{id}/start", post(sessions::start_session))
        .route("/api/sessions/{id}/stop", post(sessions::stop_session))
        // WebSocket for login subscription
        .route("/api/ws/login", get(status::login_ws))
        // Events WebSocket
        .route("/api/ws/events", get(events::events_ws))
        .layer(cors)
}
