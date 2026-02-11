use crate::ia::types::Action;
use crate::tools::exec::{exec_command, ExecOptions};
use std::future::Future;
use std::pin::Pin;

/// Execute a single action against the WeChat UI.
/// Returns a BoxFuture to support recursive calls (Sequence action).
pub fn execute_action<'a>(
    action: &'a Action,
    options: &'a ExecOptions,
) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        match action {
            Action::ClickSelector { selector } => {
                tracing::debug!("[action] click selector: {selector}");
                // Would need a11y tree context to resolve selector to coordinates
            }

            Action::ClickCoords { x, y } => {
                let x_str = (*x as i32).to_string();
                let y_str = (*y as i32).to_string();
                exec_command("click", &[&x_str, &y_str], options).await;
            }

            Action::Type { text, selector: _ } => {
                exec_command("input", &[text.as_str()], options).await;
            }

            Action::Key { combo } => {
                exec_command("key", &[combo.as_str()], options).await;
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

            Action::Emit { .. } => {
                // Emit actions are handled by the execution loop, not here
            }

            Action::Sequence { actions } => {
                for a in actions {
                    execute_action(a, options).await;
                }
            }
        }
    })
}
