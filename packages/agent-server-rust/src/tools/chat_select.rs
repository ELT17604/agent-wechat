use super::exec::{exec_command, ExecOptions};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OpenChatResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Open a chat in the WeChat UI using the chat-select tool.
pub async fn open_chat(
    chat_id: &str,
    force: bool,
    click_xy: Option<(f64, f64)>,
) -> OpenChatResult {
    let mut args = vec!["--chat-id", chat_id];

    let xy_str;
    if let Some((x, y)) = click_xy {
        xy_str = format!("{},{}", x as i32, y as i32);
        args.push("--click-xy");
        args.push(&xy_str);
    }

    if force {
        args.push("--force");
    }

    let args_str: Vec<&str> = args.iter().copied().collect();

    let result = exec_command(
        "python3",
        &[&["/opt/tools/chat-select.py"], args_str.as_slice()].concat(),
        &ExecOptions::default(),
    )
    .await;

    if result.exit_code != 0 {
        return OpenChatResult {
            ok: false,
            skipped: None,
            error: Some(result.stderr),
        };
    }

    // Parse JSON output
    serde_json::from_str(&result.stdout).unwrap_or(OpenChatResult {
        ok: true,
        skipped: None,
        error: None,
    })
}
