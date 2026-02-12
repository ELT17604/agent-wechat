use crate::ia::selectors::query_selector;
use crate::ia::types::{A11yNode, Action, SubscriptionEvent};
use crate::tools::exec::{exec_command, ExecOptions};
use std::future::Future;
use std::pin::Pin;

/// Find the first frame node with window info in the a11y tree.
/// Used for window activation before clicking/typing.
fn find_frame_with_window(node: &A11yNode) -> Option<&A11yNode> {
    if node.role == "frame" && node.window.is_some() && node.bounds.is_some() {
        return Some(node);
    }
    if let Some(children) = &node.children {
        for child in children {
            if let Some(found) = find_frame_with_window(child) {
                return Some(found);
            }
        }
    }
    None
}

/// Build --window activation args from a frame node.
fn window_activate_args(frame: &A11yNode) -> Vec<String> {
    if let (Some(win), Some(fb)) = (&frame.window, &frame.bounds) {
        vec![
            "--window".to_string(),
            win.pid.to_string(),
            (fb.x as i32).to_string(),
            (fb.y as i32).to_string(),
            (fb.width as i32).to_string(),
            (fb.height as i32).to_string(),
            "--".to_string(),
        ]
    } else {
        vec![]
    }
}

/// Execute a single action against the WeChat UI.
/// Returns a BoxFuture to support recursive calls (Sequence action).
pub fn execute_action<'a>(
    action: &'a Action,
    options: &'a ExecOptions,
    a11y: &'a A11yNode,
    emit: &'a (dyn Fn(SubscriptionEvent) + Send + Sync),
) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        match action {
            Action::ClickSelector { selector } => {
                // Find frame for window activation and scoped queries
                let frame = find_frame_with_window(a11y);
                let query_root = frame.unwrap_or(a11y);

                if let Some(node) = query_selector(query_root, selector) {
                    if let Some(bounds) = &node.bounds {
                        let cx = (bounds.x + bounds.width / 2.0).round() as i32;
                        let cy = (bounds.y + bounds.height / 2.0).round() as i32;
                        tracing::info!("[action] click selector '{selector}' → ({cx}, {cy})");

                        let mut args = frame
                            .map(|f| window_activate_args(f))
                            .unwrap_or_default();
                        args.push(cx.to_string());
                        args.push(cy.to_string());
                        let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                        exec_command("click", &args_ref, options).await;
                    } else {
                        tracing::warn!("[action] click selector '{selector}' matched but no bounds");
                    }
                } else {
                    tracing::warn!("[action] click selector '{selector}' — no match");
                }
            }

            Action::ClickCoords { x, y } => {
                let frame = find_frame_with_window(a11y);
                let mut args = frame
                    .map(|f| window_activate_args(f))
                    .unwrap_or_default();
                args.push((*x as i32).to_string());
                args.push((*y as i32).to_string());
                let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                exec_command("click", &args_ref, options).await;
            }

            Action::Type { text, selector: _ } => {
                exec_command("input", &[text.as_str()], options).await;
            }

            Action::Key { combo } => {
                let frame = find_frame_with_window(a11y);
                let mut args = frame
                    .map(|f| window_activate_args(f))
                    .unwrap_or_default();
                args.push(combo.clone());
                let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                exec_command("key", &args_ref, options).await;
            }

            Action::Scroll {
                direction,
                x: _,
                y: _,
                amount,
            } => {
                let dir = match direction {
                    crate::ia::types::ScrollDirection::Up => "up",
                    crate::ia::types::ScrollDirection::Down => "down",
                };
                let mut args = vec![dir.to_string()];
                if let Some(amt) = amount {
                    args.push(amt.to_string());
                }
                let args_ref: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                exec_command("scroll", &args_ref, options).await;
            }

            Action::Wait { ms } => {
                tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
            }

            Action::Emit { event } => {
                emit(event.clone());
            }

            Action::Sequence { actions } => {
                for a in actions {
                    execute_action(a, options, a11y, emit).await;
                }
            }
        }
    })
}
