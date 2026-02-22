---
"@agent-wechat/cli": patch
"@agent-wechat/wechat": patch
---

Fix image media retrieval for newly received images by using message_resource.db as the primary file lookup instead of hardlink.db, which has an indexing delay.
