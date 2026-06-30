---
name: "wechat-agent"
description: "WeChat 接管技能：基于 ELT17604/agent-wechat fork 全场景实测"
---

# WeChat Agent — 微信接管技能

## 概述

通过 `@agent-wechat/wechat` OpenClaw 插件 + `wx` CLI + Docker 容器 `agent-wechat` 操作微信 Linux 桌面客户端（Xvfb + AT-SPI 辅助功能），实现消息收发、登录、锁屏检测与解锁。

**源码仓库：** `github.com/ELT17604/agent-wechat`  
**CLI 安装：** `npm install -g @agent-wechat/cli`（从 fork `packages/cli` build）  
**插件安装：** OpenClaw `wechat` 频道插件（从 fork `packages/openclaw-extension` build 安装）  
**Docker 镜像：** `ghcr.io/thisnick/agent-wechat:latest`

## 架构

```
  你手机微信 ← 同步 → Docker WeChat Linux (Xvfb:99 + AT-SPI)
                        ↕ REST API/WS (:6174)
              wx CLI + OpenClaw wechat 插件
                        ↕
                AI Agent (3个原生 Tool + wx CLI)
```

## 前置条件

- Docker 容器 `agent-wechat` 运行中，端口 6174 可达
- Token 文件 `~/.config/agent-wechat/token` 存在且与容器配置一致
- `wx` CLI 可用（来自 fork build）
- OpenClaw `wechat` 频道插件已安装并配置

## OpenClaw 原生工具（推荐使用）

| Tool | 功能 | 需审批 |
|------|------|--------|
| `wechat_login` | 登录/登出/查状态 | ❌ |
| `wechat_preview_send` | 预览发送：查登录→读最近5条消息→展示目标+内容 | ❌ |
| `wechat_execute_send` | 执行发送（必须在 preview 之后 + 用户确认） | ✅ → `/approve` |

### 发消息标准流程（使用 Tool）

```
你：给 XXX 发 "YYYY"

我：① wechat_preview_send(chatId, "YYYY")
    → ✅ 已登录 | 📜 最近5条: [...]
    → 🎯 XXX | 📝 YYYY
    → 可以发吗？

你：可以 / 发吧 / 行

我：② exec(ask:always) wechat_execute_send(chatId, "YYYY")
       ↓
    你回 /approve <id> allow-once
       ↓
    ✅ 发送成功 / ❌ 失败原因
```

### 其他工具操作

```
# 登录
wechat_login(action: "status")       → 查登录状态
wechat_login(action: "start")        → 登录（推手机 / 扫二维码）
wechat_login(action: "logout")       → 登出
```

## wx CLI 命令（备用）

### 状态检测

```bash
wx status                          # 快速查看
wx a11y --format aria              # 精确判断（最可靠）
```

### A11y 树状态对照表

| a11y 特征 | 识别状态 | 能读 | 能发 |
|---|---|---|---|
| `push-button "Weixin"` + `"Contacts"` + `list "Chats"` | **chat / chat_open** (已登录聊天界面) | ✅ | ✅ |
| `label "Current User нал"` + `push-button "Log In"` | **login_account** (已保存账号) | ⚠️ 有限 | ❌ |
| `label "Scan to log in"` + `"Transfer files only"` | **login_qr** (扫码登录) | ❌ | ❌ |
| `label "Comfirm on phone"` + `push-button "Cancel"` | **login_phone_confirm** (等待手机确认) | ❌ | ❌ |
| `label "Weixin for Linux is locked."` + `"Unlock on Phone"` | **locked** (手机端锁定) | ✅ **可读** | ❌ |
| `label "Weixin 4.1.1"` + 额外 `frame @(364,194)` | **版本弹窗** (更新说明) | ✅ | ❌ |
| `wx status` 显示 logged out 但 API sessions 显示 logged_in | **误报状态** | ✅ | ⚠️ 视情况 |

### 读取消息

```bash
wx chats list                              # 聊天列表
wx find <名称>                             # 搜索聊天
wx messages list <chatId> --limit 10       # 读消息（锁定下也能读）
```

### 登录

```bash
wx auth login          # 已有账号 → 点 Log In → 手机确认
wx auth login --new    # 新账号 → 扫码
wx auth logout         # 登出
```

### 锁屏检测

```bash
# a11y 特征:
#   - "Weixin for Linux is locked."
#   - "你可以在手机微信聊天列表顶部的状态栏解锁。"
#   - push-button "Unlock on Phone"
```

### 解锁

```bash
# 方法A：手机微信 → 顶部状态栏 → 解锁（最可靠）
# 方法B：点按钮触发手机通知
docker exec agent-wechat click 640 490
docker exec agent-wechat xdotool mousemove 640 490 click 1
```

### 版本弹窗处理

```bash
# 检测
wx a11y --format aria | grep "Weixin 4.1.1"

# 关闭（Escape 键）
docker exec agent-wechat xdotool search --name "Weixin" | tail -1 | \
  xargs -I{} docker exec agent-wechat xdotool windowactivate --sync {}
docker exec agent-wechat xdotool key Escape
```

### 截图与辅助树

```bash
wx screenshot /tmp/wechat.png
wx a11y                         # JSON 格式
wx a11y --format aria           # 可读格式
```

## Frida 会话验证

```bash
docker exec agent-wechat chat-select --list
# 确认目标 chatId 在返回的 JSON keys 中才能发送
```

## 已知限制

- `wx status` 的 Login 状态不可靠（锁屏时仍显示 logged in，登录界面可能误报 logged out）
- 部分 chatId（API 列表中的）可能与 Frida 内部 ID 不同，无法通过 chat-select 发送
- 锁屏状态下 **只能读不能发**
- 解锁需要**手机上确认**，仅点 "Unlock on Phone" 按钮不够
- Xvfb 窗口大小可能小于实际 WeChat 窗口（默认 1024x768 vs 1280x778）
