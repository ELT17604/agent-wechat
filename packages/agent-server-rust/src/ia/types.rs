use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================
// A11y Tree Types (from a11y-dump)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yWindowInfo {
    pub pid: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A11yNode {
    pub role: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<A11yNode>>,
    /// Parent is not serialized — set via add_parent_refs after deserialization
    #[serde(skip)]
    pub parent_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window: Option<A11yWindowInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub states: Option<Vec<String>>,
}

// ============================================
// Actions
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum Action {
    #[serde(rename = "click")]
    ClickSelector { selector: String },
    #[serde(rename = "click")]
    ClickCoords { x: f64, y: f64 },
    #[serde(rename = "type")]
    Type {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        selector: Option<String>,
    },
    #[serde(rename = "key")]
    Key { combo: String },
    #[serde(rename = "scroll")]
    Scroll {
        direction: ScrollDirection,
        #[serde(skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        amount: Option<i32>,
    },
    #[serde(rename = "wait")]
    Wait { ms: u64 },
    #[serde(rename = "emit")]
    Emit { event: SubscriptionEvent },
    #[serde(rename = "sequence")]
    Sequence { actions: Vec<Action> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScrollDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(flatten)]
    pub data: HashMap<String, serde_json::Value>,
}

// ============================================
// Multi-Window State Model
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MainWindowView {
    LoginQr,
    LoginAccount,
    LoginPhoneConfirm,
    LoginLoading,
    Chat,
    ChatOpen,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<Bounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MainWindowState {
    pub view: MainWindowView,
    pub is_logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub qr_binary_data: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_chat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub search_results: Option<Vec<SearchResult>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_chat_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_chat_is_group: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_chat_bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_button_bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimize_button_bounds: Option<Bounds>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximize_button_bounds: Option<Bounds>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PopupState {
    #[serde(rename = "type")]
    pub popup_type: PopupType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum PopupType {
    Error,
    Confirm,
    Info,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContactCardState {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wechat_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contact_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppState {
    pub main_window: MainWindowState,
    pub popup: Option<PopupState>,
    pub contact_card: Option<ContactCardState>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            main_window: MainWindowState {
                view: MainWindowView::LoginQr,
                is_logged_in: false,
                qr_data: None,
                qr_binary_data: None,
                account_name: None,
                selected_chat_id: None,
                search_query: None,
                search_results: None,
                opened_chat_name: None,
                opened_chat_is_group: None,
                selected_chat_bounds: None,
                close_button_bounds: None,
                minimize_button_bounds: None,
                maximize_button_bounds: None,
            },
            popup: None,
            contact_card: None,
        }
    }
}

// ============================================
// State Definition
// ============================================

pub struct IdentifyArgs<'a> {
    pub a11y: &'a A11yNode,
    pub screenshot: &'a str,
}

pub struct IdentifyResult {
    pub identified: bool,
    pub metadata: Option<serde_json::Value>,
}

pub struct ReduceArgs<'a> {
    pub prev: &'a AppState,
    pub a11y: &'a A11yNode,
    pub screenshot: &'a [u8],
    pub metadata: Option<&'a serde_json::Value>,
}

/// IAState defines a UI state in the FSM.
pub trait IAState: Send + Sync {
    fn fsm(&self) -> &str;
    fn id(&self) -> &str;
    fn identify(&self, args: &IdentifyArgs) -> Result<IdentifyResult, String>;
    fn reduce(&self, args: &ReduceArgs) -> AppState;
}

// ============================================
// Identified States
// ============================================

#[derive(Debug, Clone)]
pub struct IdentifiedState {
    pub state_id: String,
    pub fsm: String,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct IdentifiedStates {
    pub main_window: Option<IdentifiedState>,
    pub popup: Option<IdentifiedState>,
    pub contact_card: Option<IdentifiedState>,
}

// ============================================
// Effects
// ============================================

pub enum Effect {
    Emit { event: SubscriptionEvent },
}

// ============================================
// Plan
// ============================================

pub struct SelectedAction {
    pub action: Action,
    pub metadata: Option<serde_json::Value>,
}

// ============================================
// Execution status
// ============================================

#[derive(Debug, Clone, PartialEq)]
pub enum ExecutionStatus {
    Running,
    Succeeded,
    Failed,
    Aborted,
}

// ============================================
// Session types (shared)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub name: String,
    pub linux_user: String,
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbus_address: Option<String>,
    pub vnc_port: i32,
    pub status: String,
    pub login_state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logged_in_user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wechat_pid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xvfb_pid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dbus_pid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

// ============================================
// Chat types (shared)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Chat {
    pub id: String,
    pub username: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remark: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_preview: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_message_sender: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    pub unread_count: i32,
    pub is_group: bool,
}

// ============================================
// Message types (shared)
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub local_id: i64,
    pub server_id: i64,
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender: Option<String>,
    #[serde(rename = "type")]
    pub msg_type: i32,
    pub content: String,
    pub timestamp: String,
}

// ============================================
// Login subscription event types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum LoginSubscriptionEvent {
    #[serde(rename = "status")]
    Status { message: String },
    #[serde(rename = "qr")]
    Qr {
        #[serde(rename = "qrData")]
        qr_data: String,
        #[serde(rename = "qrBinaryData", skip_serializing_if = "Option::is_none")]
        qr_binary_data: Option<Vec<u8>>,
        #[serde(rename = "qrDataUrl", skip_serializing_if = "Option::is_none")]
        qr_data_url: Option<String>,
    },
    #[serde(rename = "phone_confirm")]
    PhoneConfirm {
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    #[serde(rename = "login_success")]
    LoginSuccess {
        #[serde(rename = "userId", skip_serializing_if = "Option::is_none")]
        user_id: Option<String>,
    },
    #[serde(rename = "login_timeout")]
    LoginTimeout,
    #[serde(rename = "error")]
    Error { message: String },
}

// ============================================
// Send types
// ============================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendParams {
    #[serde(rename = "chatId")]
    pub chat_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<FileData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageData {
    pub data: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileData {
    pub data: String,
    pub filename: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MediaResult {
    #[serde(rename = "type")]
    pub media_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub format: String,
    pub filename: String,
}
