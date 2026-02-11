use super::Plan;
use crate::ia::actions;
use crate::ia::selectors::query_selector;
use crate::ia::types::*;
use crate::tools::chat_select::{open_chat, OpenChatResult};

pub struct ChatOpenPlan;

pub struct ChatOpenParams {
    pub chat_id: String,
}

pub struct ChatOpenPlanState {
    pub phase: ChatOpenPhase,
    pub result: Option<OpenChatResult>,
}

pub enum ChatOpenPhase {
    Pending,
    Done,
}

#[async_trait::async_trait]
impl Plan for ChatOpenPlan {
    type PlanState = ChatOpenPlanState;
    type Params = ChatOpenParams;

    fn id(&self) -> &str { "chat_open" }

    fn initial_plan_state(&self) -> ChatOpenPlanState {
        ChatOpenPlanState {
            phase: ChatOpenPhase::Pending,
            result: None,
        }
    }

    fn is_goal_reached(&self, _state: &AppState, plan_state: &ChatOpenPlanState) -> bool {
        matches!(plan_state.phase, ChatOpenPhase::Done)
    }

    async fn select_action(
        &self,
        state: &AppState,
        params: &ChatOpenParams,
        identified: &IdentifiedStates,
        plan_state: &mut ChatOpenPlanState,
        a11y: &A11yNode,
        _session_id: &str,
    ) -> Option<SelectedAction> {
        // Dismiss popups
        if state.popup.is_some() && identified.popup.is_some() {
            return Some(SelectedAction {
                action: actions::dismiss_popup(),
                metadata: None,
            });
        }

        let main_state_id = identified.main_window.as_ref().map(|m| m.state_id.as_str());
        if main_state_id != Some("chat") && main_state_id != Some("chat_open") {
            return None;
        }

        // Find click target
        let chat_list_item = query_selector(a11y, r#"list[name="Chats"] > list-item"#);
        let click_xy = chat_list_item.and_then(|item| {
            item.bounds.as_ref().map(|b| {
                (
                    (b.x + b.width / 2.0).round(),
                    (b.y + b.height / 2.0).round(),
                )
            })
        });

        let force = main_state_id == Some("chat");

        let result = open_chat(&params.chat_id, force, click_xy).await;
        plan_state.result = Some(result);
        plan_state.phase = ChatOpenPhase::Done;

        Some(SelectedAction {
            action: actions::wait_short(),
            metadata: None,
        })
    }
}
