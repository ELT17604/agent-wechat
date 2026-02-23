---
"@agent-wechat/wechat": patch
---

Fix group message mention gating not working

The monitor was not checking `msg.isMentioned` before dispatching group messages, so all group messages were processed regardless of `requireMention` config. Now:
- Skips group messages that require mention but weren't mentioned
- Sets `WasMentioned` in the inbound context for framework-level mention awareness
