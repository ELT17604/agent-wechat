use super::selectors::query_selector;
use super::types::{A11yNode, Bounds};

/// Generate a stable hash from a string.
fn hash_string(s: &str) -> String {
    let mut hash: i32 = 0;
    for ch in s.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(ch as i32);
    }
    format!("{}", hash.unsigned_abs())
}

/// Extract active chat ID from message view header.
pub fn extract_active_chat_id(a11y: &A11yNode) -> Option<String> {
    let header = query_selector(a11y, "label[name=/.+/]")?;
    if !header.name.is_empty() {
        Some(format!("chat_{}", hash_string(&header.name)))
    } else {
        None
    }
}

/// Check if bounds are valid (non-zero size).
pub fn has_valid_bounds(bounds: &Option<Bounds>) -> bool {
    bounds
        .as_ref()
        .map(|b| b.width > 0.0 && b.height > 0.0)
        .unwrap_or(false)
}

/// Calculate center point of bounds.
pub fn get_bounds_center(bounds: &Bounds) -> (f64, f64) {
    (
        (bounds.x + bounds.width / 2.0).round(),
        (bounds.y + bounds.height / 2.0).round(),
    )
}
