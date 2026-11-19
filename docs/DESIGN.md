# dsh-agent-link 设计

状态：草案。本文记录已确定的架构，以及开工前需要先验证的事项。

## 目标

1. 在 dsh 会话中调用远端 Hermes、OpenClaw 等 Agent：新建或继续对端会话、接收流式结果、转发审批、取消运行。
2. 让远端 Agent 读取、监听，并在授权后写入本地指定的 dsh 会话。
3. **不使用第三方 Relay**，且**只需在 dsh 一端安装插件**；远端只使用自身的原生 Gateway 接口。

不在本项目范围内的方案：云端中转、WebRTC 打洞、frp / ngrok 一类公网隧道，以及在各个 Harness 上分别安装插件的 Mesh 方案。

## 架构

```text
┌──────────────────────── 本地 dsh ─────────────────────────┐
│ dsh-agent-link                                             │
│  ├─ adapters/   协议层：Hermes Gateway、OpenClaw Gateway     │
│  ├─ transports/ 传输层：ssh（默认）、direct（Tailscale 预设）、local │
│  ├─ tools/      模型工具：agent_list / agent_ask / …        │
│  ├─ mcp/        会话出口：自建监听器，仅提供 /mcp            │
│  ├─ policy/     共享白名单、Token、脱敏、防循环              │
│  └─ store/      会话映射、jobId、事件游标                    │
└────────────┬─────────────────────────────────▲────────────┘
             │ 正向：dsh → Agent                │ 反向：Agent → dsh（MCP）
     ┌───────▼────────┐                ┌───────┴─────────┐
     │ 远端 Hermes     │                │ 远端 OpenClaw    │
     │ Gateway         │                │ Gateway :18789  │
     └────────────────┘                └─────────────────┘
```

协议与传输分为两层：适配器只关心消息格式，传输层只负责“如何连到对端”。

## 协议层

| 对端 | 协议 | 认证 |
|---|---|---|
| Hermes | TUI Gateway JSON-RPC（WebSocket `/api/ws`，子协议 `hermes-gateway-v1`）；备选 API Server（`/v1/runs` + SSE） | 单次 ticket，或 API Server 的 Bearer Key |
| OpenClaw | Gateway WebSocket（默认 `:18789`），JSON-RPC 风格方法 | 设备配对 + Ed25519 签名（可参考 ODSH-Bridge 的握手实现） |

不以 ACP 作为主协议：`hermes acp` 本身就是 Gateway daemon 的一个 viewer，直接连接 Gateway 可以获得完整的会话列表、断线续读（`session.events.since`）和未答复请求恢复（`open_requests`）等能力。

### 适配器接口

```ts
interface AgentAdapter {
  id: string                         // 例如 "hermes-gpu"
  kind: 'hermes' | 'openclaw'
  connect(signal: AbortSignal): Promise<void>
  health(): Promise<AgentHealth>
  listSessions(): Promise<AgentSessionSummary[]>
  newSession(opts?: { cwd?: string }): Promise<AgentSessionId>
  prompt(sid: AgentSessionId, content: string, signal: AbortSignal): AsyncIterable<AgentEvent>
  answer(requestId: string, choice: string): Promise<void>
  cancel(sid: AgentSessionId): Promise<void>
  close(): Promise<void>
}

type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; phase: 'start' | 'end'; name: string; summary?: string }
  | { type: 'approval'; id: string; command: string; options: string[] }
  | { type: 'final'; text: string; stopReason: string }
  | { type: 'error'; code: string; message: string }
```

## 传输层

| 传输 | 方式 | 说明 |
|---|---|---|
| `ssh`（**默认**） | 调用系统 OpenSSH：`ssh -W 127.0.0.1:<端口> <别名>` | 主机列表读取 `~/.ssh/config`；加密、密钥、跳板机全部交给 OpenSSH，插件不实现 SSH 协议 |
| `direct` | `ws(s)` / `http(s)` + 主机名 + 端口 | 提供 **Tailscale 预设**：通过 `tailscale status --json` 发现节点，使用 MagicDNS 寻址；推荐已组建 tailnet 的用户使用 |
| `local` | 连接 `127.0.0.1`，或 Unix socket | 同一台机器 |

默认选择 SSH，是因为几乎所有服务器都已经能通过 SSH 登录，不需要额外部署网络组件。

### SSH 传输细节

- 始终使用 `BatchMode=yes`、`ConnectTimeout`、`ServerAliveInterval` / `ServerAliveCountMax`，**不接受交互输入**：不支持密码登录，带口令的私钥需提前加入 `ssh-agent` 或钥匙串。
- 不自动接受未知主机指纹（保持 `StrictHostKeyChecking` 默认值），首次连接需要用户手动确认。
- 远端命令使用登录 shell 执行（`$SHELL -lc`），避免 `PATH` 不完整。
- 插件**不修改** `~/.ssh/config`，只生成配置片段，由用户确认后粘贴。
- 各云厂商的登录用户、密钥格式、SSM / IAP / Entra ID 等特殊登录方式，以及常见报错，见 [SSH 配置指引](SSH.md)。

### 连接自检（`agent_link_doctor`）

添加 Agent 时，以及连接失败时，按以下步骤逐项检查，**每一步失败都给出明确原因和修复建议**：

| 步骤 | 命令 | 检查内容 |
|---|---|---|
| 1. 解析配置 | `ssh -G <别名>` | 实际使用的 HostName、User、IdentityFile、ProxyJump / ProxyCommand |
| 2. 本地私钥 | 读取 IdentityFile | 文件是否存在、权限是否为 600、是否为 `.ppk` 格式 |
| 3. 非交互登录 | `ssh -o BatchMode=yes <别名> echo ok` | 按 stderr 识别错误：公钥被拒、旧算法、指纹未确认或已变化、超时、拒绝连接、需要口令 |
| 4. 远端程序 | `$SHELL -lc 'command -v hermes'` | Agent 命令是否在登录 shell 的 PATH 中 |
| 5. Gateway 端口 | `ssh -W 127.0.0.1:<端口> <别名>` | Gateway 是否在远端回环地址上监听 |
| 6. 协议握手 | 适配器 `health()` | 认证信息是否有效，版本是否兼容 |

对于旧服务器的 `ssh-rsa`、旧 KEX 等问题，自检**只生成针对该主机的配置片段**，绝不建议在 `Host *` 下全局放宽算法。

要求：

- 远端 Gateway 只监听回环地址或 Tailscale 网卡，**不要监听 `0.0.0.0`**。
- Tailscale ACL 只放行指定设备和端口。
- 网络可达不代表有权限：始终保留应用层认证。
- 不想依赖 Tailscale 官方协调服务时，可改用自建 Headscale；插件代码不需要改动。

## 正向：dsh 调用远端 Agent

模型工具：

| 工具 | 作用 |
|---|---|
| `agent_list` | 列出已配置的 Agent 及在线状态 |
| `agent_ask(agent, task, session?)` | 新建或复用对端会话并投递任务，立即返回 `jobId` |
| `agent_continue(agent, session, message)` | 在同一个对端会话中继续 |
| `agent_status(jobId)` | 查询运行状态和最近输出 |
| `agent_cancel(jobId)` | 中断运行 |

- 长任务在后台接收事件，完成后通过 `agent.followup()` 唤醒当前 dsh 会话；工具调用本身不长时间阻塞。
- 对端发起的审批请求转为 dsh 的用户审批，**默认拒绝，绝不自动允许**。

## 反向：远端 Agent 访问本地 dsh 会话

插件自建监听器，只提供 `/mcp`（Streamable HTTP），不在 dsh 自带的 Web 服务器上挂路由：后者只监听回环地址并依赖浏览器 Cookie 认证，开放它会暴露整个 GUI 和 API。

| MCP 工具 | 作用 | 权限 |
|---|---|---|
| `dsh_sessions_list` | 列出允许共享的会话 | read |
| `dsh_session_read(id, cursor?)` | 分页读取事件 | read |
| `dsh_session_watch(id, since, timeout)` | 长轮询新事件，实现“监听” | read |
| `dsh_session_post(id, text)` | 向会话投递消息，**默认关闭** | write |

远端只需修改配置，不安装插件。MCP 端口默认只监听本机 `127.0.0.1`，远端通过以下任一方式访问：

- **SSH（默认）**：插件在已建立的 SSH 连接上附加反向转发 `-R 127.0.0.1:19400:127.0.0.1:19400`，远端访问自己的 `127.0.0.1:19400` 即可；无需额外隧道，也不开放任何端口。
- **Tailscale**：MCP 监听本机 Tailscale 地址，远端通过 MagicDNS 名称访问。

```yaml
# 远端 ~/.hermes/config.yaml
mcp_servers:
  dsh:
    url: http://127.0.0.1:19400/mcp          # SSH 反向转发；使用 Tailscale 时改为 http://<本机 tailnet 名称>:19400/mcp
    headers: { Authorization: "Bearer ${env:DSH_AGENT_LINK_TOKEN}" }
    trust: untrusted
```

注意：SSH 反向转发只在连接存在时有效；需要远端随时可访问时，Agent 的 SSH 连接应保持常驻并自动重连。远端服务器 `sshd` 若设置了 `AllowTcpForwarding no`，正向和反向转发都不可用，自检会提示改用 Tailscale。

## 安全

1. **共享白名单**：只有显式标记为共享的会话才能被访问，默认一个都不开放。
2. **读写分离**：Token 分为 read 和 write 两种。
3. **脱敏**：输出前过滤 API Key、Cookie、JWT 等敏感内容。
4. **防循环**：经由插件进入 dsh 会话的消息标记 `source: agent:<id>`，并限制每轮最多调用 N 次 `agent_ask`。
5. **凭据**：Token 等密钥存入 dsh Credentials，不写入 `cordis.patch.yml`。

## 连接生命周期

吸取 Codex 远程连接的教训（openai/codex#29809：重连时反复启动远端进程并留下孤儿进程）：

- 复用远端常驻的 Gateway，不在每次连接时启动新服务。
- 只连接已启用的 Agent，不在启动时同时连接全部主机。
- 重连采用指数退避，并设置次数上限。
- `ssh` 传输设置 `ServerAliveInterval` / `ServerAliveCountMax`，断开后清理本地子进程。

## 配置示例

```yaml
- id: agent-link
  name: '@weaxs/dsh-agent-link'
  config:
    agents:
      - id: hermes-gpu
        kind: hermes
        transport: ssh           # 默认，可省略
        ssh: gpu-box             # ~/.ssh/config 别名
        port: 8642               # 远端 Gateway 在 127.0.0.1 上的端口
      - id: claw-prod
        kind: openclaw
        transport: direct
        host: claw-server        # Tailscale MagicDNS 名称
        port: 18789
    mcp:
      bind: loopback             # 默认，经 SSH 反向转发访问；使用 Tailscale 时改为 tailnet
      port: 19400
      allowWrite: false
    limits:
      maxAgentCallsPerTurn: 5
      jobTimeoutSec: 1800
```

## 里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 验证 | 连接 Hermes Gateway 完成 `session.create` → `prompt.submit` → `message.delta`；完成 OpenClaw 设备配对并调用一个方法；分别走 `ssh` 和 `direct` | 两端都能连通并收到回复 |
| M1 正向最小可用 | 适配器、SSH 传输、连接自检、`agent_list`、`agent_ask` | 在 dsh 中让 Hermes 完成任务并返回结果；自检能识别 SSH 配置指引中列出的常见错误 |
| M2 正向完整 | `agent_continue`、`cancel`、后台 jobId、`followup` 唤醒、审批转发 | 30 分钟长任务不超时，审批由用户决定 |
| M3 反向只读 | MCP、`list`、`read`、`watch`、白名单、脱敏 | 远端 Hermes 能实时看到本地会话的新消息 |
| M4 反向写入 | `post`、write Token、来源标记、防循环 | 远端可投递消息，且不会形成无限互调 |
| M5 体验 | 侧栏状态面板、Tailscale 节点发现、`doctor` 自检 | 断网可自动恢复，问题可快速定位 |

## 待验证

- OpenClaw Gateway 当前版本的配对握手与方法名。
- Hermes Gateway 远程连接时的 ticket 获取方式（`hermes gateway attach --json` 只适用于本机）；必要时改用 API Server 的 Bearer Key。
- 使用 dsh 公开的 `sessionController`、`tools`、`subprocess`、`storage` 接口实现，并在启动时自检所需方法是否存在。
