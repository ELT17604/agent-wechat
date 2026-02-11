pub mod actions;
pub mod helpers;
pub mod selectors;
pub mod states;
pub mod types;

use types::{A11yNode, IAState, IdentifiedState, IdentifiedStates, IdentifyArgs};

use states::chat::CHAT_STATES;
use states::contact_card::CONTACT_CARD_STATE;
use states::login::LOGIN_STATES;
use states::popup::POPUP_STATES;

/// Identify current states from a11y tree and screenshot.
///
/// Returns the identified states for all FSMs (mainWindow, popup, contactCard),
/// along with any metadata from the identify functions.
pub fn identify_states(a11y_tree: &A11yNode, screenshot: &str) -> IdentifiedStates {
    let mut main_window: Option<IdentifiedState> = None;
    let mut popup: Option<IdentifiedState> = None;
    let mut contact_card: Option<IdentifiedState> = None;

    let args = IdentifyArgs {
        a11y: a11y_tree,
        screenshot,
    };

    // Check chat states first (logged-in), then login states
    let all_states: Vec<&dyn IAState> = CHAT_STATES
        .iter()
        .map(|s| s.as_ref() as &dyn IAState)
        .chain(LOGIN_STATES.iter().map(|s| s.as_ref() as &dyn IAState))
        .chain(POPUP_STATES.iter().map(|s| s.as_ref() as &dyn IAState))
        .chain(std::iter::once(&*CONTACT_CARD_STATE as &dyn IAState))
        .collect();

    for state in &all_states {
        match state.identify(&args) {
            Ok(result) if result.identified => {
                let fsm = state.fsm();
                match fsm {
                    "mainWindow" if main_window.is_none() => {
                        main_window = Some(IdentifiedState {
                            state_id: state.id().to_string(),
                            fsm: fsm.to_string(),
                            metadata: result.metadata,
                        });
                    }
                    "popup" if popup.is_none() => {
                        popup = Some(IdentifiedState {
                            state_id: state.id().to_string(),
                            fsm: fsm.to_string(),
                            metadata: result.metadata,
                        });
                    }
                    "contactCard" if contact_card.is_none() => {
                        contact_card = Some(IdentifiedState {
                            state_id: state.id().to_string(),
                            fsm: fsm.to_string(),
                            metadata: result.metadata,
                        });
                    }
                    _ => {}
                }
            }
            _ => {}
        }

        // Stop if we found all three
        if main_window.is_some() && popup.is_some() && contact_card.is_some() {
            break;
        }
    }

    IdentifiedStates {
        main_window,
        popup,
        contact_card,
    }
}
