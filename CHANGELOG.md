# Changelog

## [Unreleased]

### Documentation
- Add `TROUBLESHOOTING.md` with guides for common deployment issues:
  - Login FSM stall after QR scan (REST vs WebSocket login flow)
  - Channel not appearing in OpenClaw channels list
  - WeChat window rendering at 3×3 pixels
  - Docker registry pull failures behind GFW
  - @agent-wechat/shared npm publish issue (#156)

### Known Issues
- `POST /api/auth/login` REST endpoint only captures QR snapshot; use
  `wx auth login` (WebSocket) to start the full FSM login execution loop
- `@agent-wechat/shared@0.1.0` not published to npm (#156)

## [0.11.15] - 2026-04-01
- Initial npm release
