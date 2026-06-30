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
                AI Agent (收发消息/操作)
```

## 前置条件

- Docker 容器 `agent-wechat` 运行中，端口 6174 可达
- Token 文件 `~/.config/agent-wechat/token` 存在且与容器配置一致
- `wx` CLI 可用（来自 fork build）
- OpenClaw `wechat` 频道插件已安装并配置

## 核心操作

### 1️⃣ 状态检测

```bash
# 快速查看
wx status
# Container: up | Server: reachable | Login: logged in|out

# 精确查看（最可靠）— 从 a11y 树分析当前微信界面
wx a11y --format aria
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

### 2️⃣ 读取消息

```bash
# 列出所有聊天
wx chats list

# 搜索聊天
wx find <名称>

# 读消息（锁定状态下也能读！）
wx messages list <chatId> --limit 10
```

**锁定状态下读消息依然正常** — 消息从 WeChat 本地 SQLite 数据库读取，不依赖 GUI 操作。

### 3️⃣ 发送消息

```bash
# 发文本/图片/文件
wx messages send <chatId> --text "你好"
wx messages send <chatId> --image /path/to/image.png
wx messages send <chatId> --file /path/to/file.pdf
```

**发送前必须验证：**
1. 不是锁定状态（锁定状态下发送会报 `Unknown state`）
2. chatId 必须在 Frida 会话列表中（`chat-select --list` 可查）
3. API 列表看到的 chatId 不一定等于 Frida 内部 ID

```bash
# 验证 chatId 是否可用
docker exec agent-wechat chat-select --list | python3 -c "import sys,json;d=json.load(sys.stdin);print('✅' if '目标ChatId' in d.get('sessions',{}) else '❌ 不可发送')"
```

### 4️⃣ 登录

```bash
# 已有账号 → 直接点 Log In
wx auth login
# 手机收到确认 → 点确认 → 登录成功

# 切换新账号 → 扫码
wx auth login --new
# 终端显示 QR 码 → 手机微信扫码

# 登出
wx auth logout
```

### 5️⃣ 锁屏检测

#### 检测方法（a11y 树）
```python
# 检查 a11y 树是否包含以下特征
label "Weixin for Linux is locked."        # ← 锁定标题
label "你可以在手机微信聊天列表顶部的状态栏解锁。"  # ← 解锁指引
push-button "Unlock on Phone"              # ← 解锁按钮
```

只要有上述任意特征 → 已锁定。

#### 锁屏状态能力

| 操作 | 锁屏下 |
|------|--------|
| 读消息 | ✅ 正常 |
| 列聊天 | ✅ 正常 |
| 截图 | ✅ 正常 |
| 发消息 | ❌ `Unknown state` |
| a11y 树 | ✅ 显示锁屏界面 |

### 6️⃣ 解锁

#### 方法 A：手机上解锁（最可靠）
手机微信 → 聊天列表顶部状态栏 → 点击「Windows/Mac 微信已锁定」→ 解锁

#### 方法 B：点击 "Unlock on Phone" 按钮
```bash
# 触发解锁请求 → 手机会收到通知 → 手机上确认
docker exec agent-wechat click 640 490
# 或
docker exec agent-wechat xdotool mousemove 640 490 click 1
```

点击后仍需**在手机上确认**才能完成解锁。

### 7️⃣ 版本弹窗处理

WeChat 启动后可能弹出版本更新说明弹窗，阻挡发送操作。

```bash
# 检测
wx a11y --format aria | grep "Weixin 4.1.1"

# 关闭（Escape 键）
docker exec agent-wechat xdotool search --name "Weixin" | tail -1 | \
  xargs -I{} docker exec agent-wechat xdotool windowactivate --sync {}
docker exec agent-wechat xdotool key Escape
```

### 8️⃣ 截图与辅助树（调试）

```bash
wx screenshot /tmp/wechat.png
wx a11y                         # JSON 格式
wx a11y --format aria           # 可读格式
```

## 发送消息的标准流程

1. `wx a11y --format aria` — 检查当前界面状态（排除锁定/弹窗/未登录）
2. `docker exec agent-wechat chat-select --list` — 确认目标 chatId 在 Frida 列表中
3. 展示：目标 + 消息内容 → 经 El 确认
4. `wx messages send <chatId> --text "内容"` — 执行发送
5. 报告结果（成功/失败原因）

## 已知限制

- `wx status` 的 Login 状态不可靠（锁屏时仍显示 logged in，登录界面可能误报 logged out）
- 部分 chatId（API 列表中的）可能与 Frida 内部 ID 不同，无法通过 chat-select 发送
- 锁屏状态下 **只能读不能发**
- 解锁需要**手机上确认**，仅点 "Unlock on Phone" 按钮不够
- Xvfb 窗口大小可能小于实际 WeChat 窗口（默认 1024x768 vs 1280x778）
