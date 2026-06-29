# TODO

## High Priority
- [ ] Auto-dismiss WeChat 4.1.1 version changelog dialog
- [ ] Implement Tesseract OCR fallback for forwarded chat records (type 49)
- [ ] Publish `@agent-wechat/shared@0.1.0` to npm (GitHub #156)

## Medium Priority
- [ ] Add WebSocket fallback hint to REST `POST /api/auth/login` response
  (currently returns QR screen only, doesn't start FSM execution loop)
- [ ] Expose raw message XML/content for type 49 messages via REST API
- [ ] Add `channelConfigs` to npm package `openclaw.plugin.json`
  (already in GitHub source, missing from v0.11.15 npm package)

## Low Priority
- [ ] WeChat window starts at 3×3 pixels on fresh container — auto-resize
- [ ] Docker registry proxy documentation for GFW users
- [ ] Session persistence across container restarts (skip re-login)
