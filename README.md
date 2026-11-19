# dsh-agent-link

> **开发中。** 当前 `0.0.1` 是占位版本，不包含任何功能，也不是可安装的 dsh 插件。

DeepSeek Harness（dsh）插件：把本地 dsh 与 Hermes、OpenClaw 等 Agent 连接起来，**不经过任何第三方中转服务器**。

- **dsh → 远端 Agent**：在 dsh 会话里把任务交给远端 Hermes / OpenClaw，并继续同一个对端会话。
- **远端 Agent → dsh**：远端 Agent 通过 MCP 读取、监听，并在授权后写入本地指定的 dsh 会话。
- **只需在 dsh 一端安装**：远端直接使用 Hermes Gateway、OpenClaw Gateway 等原生接口，最多只需修改一项 MCP 配置。

## 传输方式

| 传输 | 适用场景 |
|---|---|
| `local` | Agent 与 dsh 在同一台机器上 |
| `direct`（默认 Tailscale 预设） | 跨机器，通过 Tailscale / Headscale / 局域网直连 |
| `ssh` | 没有加入 tailnet 的服务器，通过系统 OpenSSH（`ssh -W`）转接 |

设计细节见 [docs/DESIGN.md](docs/DESIGN.md)。

## 包名

内容相同的两个包名：

- `@weaxs/dsh-agent-link`
- `dsh-agent-link`

## License

MIT
