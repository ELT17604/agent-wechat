pub mod actions;

use crate::context::Context;
use crate::ia::identify_states;
use crate::ia::types::*;
use crate::tools::a11y::get_a11y_desktop;
use crate::tools::exec::ExecOptions;
use crate::tools::screenshot::capture_screenshot;
use crate::effects::collect_effects;
use crate::db::get_db;
use tokio_util::sync::CancellationToken;

pub struct ExecutionResult {
    pub success: bool,
    pub error: Option<String>,
}

const MAX_STEPS: u32 = 200;

/// Run the FSM execution loop with a generic plan.
///
/// 1. OBSERVE    → a11y tree + screenshot
/// 2. IDENTIFY   → match IAState from tree
/// 3. REDUCE     → update AppState
/// 4. EFFECTS    → emit events on state change
/// 5. PERSIST    → save AppState to SQLite
/// 6. SELECT     → plan picks next action
/// 7. EXECUTE    → run action via tool scripts
/// 8. GOAL?      → plan checks if done
/// 9. LOOP
pub async fn run_execution_loop<P, PS, PA>(
    plan: &P,
    params: &PA,
    context: &mut Context,
    emit: &dyn Fn(SubscriptionEvent),
    cancel: CancellationToken,
) -> ExecutionResult
where
    P: crate::plans::Plan<PlanState = PS, Params = PA>,
    PS: Send,
    PA: Send,
{
    let mut plan_state = plan.initial_plan_state();
    let session_id = context.session_id.clone();

    let exec_options = ExecOptions {
        session: Some(context.session.clone()),
        timeout_ms: 60_000,
    };

    for step in 0..MAX_STEPS {
        if cancel.is_cancelled() {
            return ExecutionResult {
                success: false,
                error: Some("Aborted".to_string()),
            };
        }

        // 1. OBSERVE: get a11y tree + screenshot
        let a11y_result = get_a11y_desktop(&exec_options).await;
        let a11y = match a11y_result {
            Ok(tree) => tree,
            Err(e) => {
                tracing::warn!("[exec] a11y failed on step {step}: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                continue;
            }
        };

        let screenshot = capture_screenshot(&exec_options).await.unwrap_or_default();

        // 2. IDENTIFY: find current states
        let identified = identify_states(&a11y, &screenshot);

        // 3. REDUCE: update app state
        let prev_state = context.state.clone();
        // Apply reductions from identified states
        // (simplified — in full impl each state's reduce is called)
        // For now the plan drives state transitions based on identified states.

        // 4. EFFECTS
        let effects = collect_effects(&prev_state, &context.state);
        for effect in effects {
            match effect {
                Effect::Emit { event } => emit(event),
            }
        }

        // 5. PERSIST
        {
            let db = get_db();
            context.save(&db);
        }

        // 6. SELECT: plan picks next action
        let selected = plan
            .select_action(
                &context.state,
                params,
                &identified,
                &mut plan_state,
                &a11y,
                &session_id,
            )
            .await;

        // 7. EXECUTE: run the action
        if let Some(sel) = &selected {
            actions::execute_action(&sel.action, &exec_options).await;
        }

        // 8. GOAL CHECK (after action)
        if plan.is_goal_reached(&context.state, &plan_state) {
            return ExecutionResult {
                success: true,
                error: None,
            };
        }

        // Handle emit actions from the plan
        if let Some(sel) = &selected {
            emit_from_action(&sel.action, emit);
        }
    }

    ExecutionResult {
        success: false,
        error: Some("Max steps reached".to_string()),
    }
}

/// Extract and emit any Emit actions from a potentially nested action tree.
fn emit_from_action(action: &Action, emit: &dyn Fn(SubscriptionEvent)) {
    match action {
        Action::Emit { event } => {
            emit(event.clone());
        }
        Action::Sequence { actions: acts } => {
            for a in acts {
                emit_from_action(a, emit);
            }
        }
        _ => {}
    }
}
