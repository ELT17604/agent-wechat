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

## 零起步安装指南（从 GitHub 搭建）

> 以下步骤在全新 Ubuntu 22.04+ 服务器上测试通过。需要：Docker、Node.js ≥22、OpenClaw。

### ① 克隆仓库
```bash
git clone git@github.com:ELT17604/agent-wechat.git ~/agent-wechat
cd ~/agent-wechat
```

### ② 构建共享库
```bash
cd ~/agent-wechat/packages/shared
npm install
npx tsc                          # 编译为 dist/
npm link                         # 注册全局 link
```

### ③ 构建 wx CLI
```bash
cd ~/agent-wechat/packages/cli
# 修改 package.json 中的 "workspace:*" 依赖为 "file:../shared"
npm install
npm install -g .                 # 全局注册 wx 命令
```

### ④ 启动 Docker 容器
```bash
mkdir -p ~/.config/agent-wechat
openssl rand -hex 32 > ~/.config/agent-wechat/token
chmod 600 ~/.config/agent-wechat/token

docker run -d --name agent-wechat \
  --restart unless-stopped \
  --security-opt seccomp=unconfined \
  --cap-add SYS_PTRACE \
  -p 6174:6174 \
  -v agent-wechat-data:/data \
  -v agent-wechat-home:/home/wechat \
  -v ~/.config/agent-wechat/token:/data/auth-token:ro \
  ghcr.io/thisnick/agent-wechat:latest
```

验证容器运行：
```bash
docker ps --filter name=agent-wechat
# → agent-wechat  Up  (正常)
```

### ⑤ 登录微信
```bash
wx auth login
# 终端显示登录流程，手机端会弹出确认
# 手机上点「确认」→ 登录成功
```

验证登录：
```bash
wx status          # → Login: logged in as wxid_xxx
wx chats list      # → 显示聊天列表
```

### ⑥ 构建 OpenClaw 插件
```bash
cd ~/agent-wechat/packages/openclaw-extension
# 修改 package.json 中 "workspace:*" 依赖为 "file:../shared"
npm link @agent-wechat/shared
npm install
npx esbuild index.ts --bundle --format=esm --platform=node --outfile=dist/index.js --external:openclaw
npm pack           # → 生成 agent-wechat-wechat-0.11.15.tgz
```

### ⑦ 安装到 OpenClaw
```bash
openclaw plugins install ~/agent-wechat/packages/openclaw-extension/agent-wechat-wechat-0.11.15.tgz
systemctl --user restart openclaw-gateway.service
```

### ⑧ 配置频道
```bash
# 直接写入 openclaw.json
python3 -c "
import json
with open('/home/USER/.openclaw/openclaw.json') as f:
    data = json.load(f)
data['plugins']['entries']['wechat'] = {'enabled': True}
token = open('/home/USER/.config/agent-wechat/token').read().strip()
data['channels']['wechat'] = {
    'enabled': True,
    'serverUrl': 'http://localhost:6174',
    'token': token,
    'dmPolicy': 'open',
    'groupPolicy': 'disabled',
    'pollIntervalMs': 1000,
    'allowFrom': ['*'],
    'groupAllowFrom': ['*']
}
with open('/home/USER/.openclaw/openclaw.json', 'w') as f:
    json.dump(data, f, indent=2)
"
systemctl --user restart openclaw-gateway.service
```

### ⑨ 安装 Skill
```bash
# 从工作空间加载技能
openclaw skills install path/to/wechat-agent
```

### ⑩ 安装日期记录
```bash
# 将今日流程写入 memory/
# 参考 memory/2026-06-30.md 中的完整记录
```

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
| `wechat_preview_send` | 预览发送：查登录→读最近5条→展示目标+内容 | ❌ |
| `wechat_execute_send` | 执行发送（preview后+用户确认+/approve） | ✅ |
| `wechat_list_chats` | 列聊天（可搜索名称、群聊/私聊区分） | ❌ |
| `wechat_read` | 读消息（锁屏下也能读） | ❌ |
| `wechat_screenshot` | 截图当前微信界面（返回 base64） | ❌ |
| `wechat_a11y` | 导出可访问性树（JSON/ARIA，检测UI状态） | ❌ |
| `wechat_unlock` | 触发解锁通知到手机 | ❌ |

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
