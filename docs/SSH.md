# SSH 配置指引

dsh-agent-link 默认使用 SSH 连接远端 Agent。本文帮助你把一台服务器配置成**无需交互即可连接**的状态。

## 先了解插件如何使用 SSH

- 插件**直接调用系统自带的 `ssh` 命令（OpenSSH）**，不自己实现 SSH 协议。加密算法、密钥类型、跳板机都由 OpenSSH 负责；插件读取的就是你的 `~/.ssh/config`。
- 后台连接使用 `BatchMode=yes`，**不会弹出密码或私钥口令的输入框**。因此必须满足：
  - 使用**密钥登录**，不支持密码登录；
  - 如果私钥有口令，要提前加入 `ssh-agent`，或者在 macOS 上保存到钥匙串。
- 插件使用 `ssh -W 127.0.0.1:<端口> <别名>` 把连接转接到远端的 Agent Gateway。远端**不需要开放额外端口**，Gateway 也只需监听 `127.0.0.1`。
- 插件**不会修改**你的 `~/.ssh/config`，只生成配置片段供你确认后自行粘贴。

**判断标准很简单**：在终端执行下面这条命令，不需要任何输入就能打印 `ok`，插件就能正常连接。

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 <别名> echo ok
```

## 第 1 步：在 `~/.ssh/config` 中添加主机

```sshconfig
Host gpu-box                       # 别名，插件配置里使用这个名字
  HostName 203.0.113.10            # 公网 IP 或域名
  User ubuntu                      # 登录用户，见下文的“各云厂商差异”
  IdentityFile ~/.ssh/gpu-box.pem  # 私钥路径
  IdentitiesOnly yes               # 只使用这把私钥，避免“尝试次数过多”被拒绝
  ServerAliveInterval 30           # 每 30 秒发送一次心跳
  ServerAliveCountMax 3            # 连续 3 次无响应即视为断开
```

私钥权限必须收紧，否则 OpenSSH 会拒绝使用：

```bash
chmod 600 ~/.ssh/gpu-box.pem
```

## 第 2 步：处理带口令的私钥

插件无法在后台输入口令。macOS 上可以把口令存入钥匙串：

```bash
ssh-add --apple-use-keychain ~/.ssh/gpu-box.pem
```

并在 `~/.ssh/config` 顶部加入：

```sshconfig
Host *
  AddKeysToAgent yes
  UseKeychain yes
```

Linux 可以使用 `ssh-agent` 或桌面环境自带的密钥管理器。

## 第 3 步：首次手动连接，确认主机指纹

```bash
ssh gpu-box
```

首次连接会询问是否信任主机指纹。确认后指纹会写入 `~/.ssh/known_hosts`，之后插件就能在后台连接。插件**不会**自动接受未知指纹。

## 第 4 步：在远端确认 Agent 已就绪

```bash
# 使用登录 shell，确保 PATH 中能找到命令（例如 nvm、pyenv 安装的程序）
ssh gpu-box -- '$SHELL -lc "command -v hermes || command -v openclaw"'
```

## 各云厂商差异

下表是常见的默认值，**请以云控制台中实例详情或连接页面显示的用户名为准**。

| 云厂商 | 常见默认用户 | 密钥 | 特殊登录方式 |
|---|---|---|---|
| 阿里云 ECS | `root`；部分新镜像为 `ecs-user` | 创建密钥对时下载的 `.pem` | 控制台 Workbench（浏览器登录，插件无法使用） |
| 腾讯云 CVM / 轻量应用服务器 | Ubuntu 镜像为 `ubuntu`，其他常为 `root` | 创建密钥时下载的 `.pem` | 控制台 OrcaTerm（浏览器登录，插件无法使用） |
| 华为云 ECS | `root` | 密钥对 `.pem` | 控制台 CloudShell（浏览器登录，插件无法使用） |
| AWS EC2 | Amazon Linux 为 `ec2-user`，Ubuntu 为 `ubuntu`，Debian 为 `admin` | 密钥对 `.pem` | SSM Session Manager，见下文 |
| Google Cloud | 由 `gcloud` 或 OS Login 决定 | `~/.ssh/google_compute_engine` | `gcloud compute config-ssh`、IAP 隧道，见下文 |
| Azure | 创建虚拟机时填写，默认常为 `azureuser` | 创建时生成的 `.pem` | `az ssh config`（Entra ID 登录），见下文 |

浏览器内的登录工具都无法供插件使用，必须开放 SSH 密钥登录，或者使用下面几种 **ProxyCommand 方案**。

### AWS：通过 SSM Session Manager 登录（无需开放 22 端口）

前提：本机已安装 AWS CLI 和 Session Manager Plugin，实例已绑定 SSM 权限。

```sshconfig
Host aws-box
  HostName i-0123456789abcdef0          # 实例 ID
  User ec2-user
  IdentityFile ~/.ssh/aws-box.pem
  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'"
```

### Google Cloud：自动生成配置

```bash
gcloud compute config-ssh
```

该命令会把项目内的实例写入 `~/.ssh/config`，别名形如 `实例名.可用区.项目ID`。没有公网 IP 时，可以通过 IAP 隧道连接：

```sshconfig
Host gcp-box
  HostName my-instance
  User your-user
  IdentityFile ~/.ssh/google_compute_engine
  ProxyCommand gcloud compute start-iap-tunnel %h %p --listen-on-stdin --zone=asia-east1-b --project=my-project
```

### Azure：使用 Entra ID 登录

```bash
az ssh config --resource-group my-rg --name my-vm --file ~/.ssh/config
```

### 通过跳板机连接

```sshconfig
Host bastion
  HostName bastion.example.com
  User ops
  IdentityFile ~/.ssh/bastion.pem

Host inner-box
  HostName 10.0.1.20
  User ubuntu
  IdentityFile ~/.ssh/inner.pem
  ProxyJump bastion
```

## 常见错误与修复

插件的自检功能会识别以下错误，并给出对应修复建议。

| 错误信息 | 原因 | 修复方法 |
|---|---|---|
| `Permission denied (publickey)` | 用户名错误、私钥不对，或公钥未加入服务器 | 核对 `User` 和 `IdentityFile`；确认公钥已在服务器的 `~/.ssh/authorized_keys` 中 |
| `Too many authentication failures` | `ssh-agent` 中的密钥太多，在使用正确密钥前就达到了尝试上限 | 在该 Host 中加入 `IdentitiesOnly yes` |
| `UNPROTECTED PRIVATE KEY FILE` | 私钥权限过宽 | `chmod 600 <私钥路径>` |
| `Load key ...: invalid format` | 私钥是 PuTTY `.ppk` 格式 | `puttygen key.ppk -O private-openssh -o key.pem` |
| `no matching host key type found. Their offer: ssh-rsa` | 服务器较老，只支持 SHA-1 的 `ssh-rsa`，OpenSSH 8.8 起默认禁用 | **仅对该主机**加入 `HostKeyAlgorithms +ssh-rsa` 和 `PubkeyAcceptedAlgorithms +ssh-rsa`；长期方案是升级服务器 |
| `no matching key exchange method found` | 服务器密钥交换算法过旧 | **仅对该主机**加入对方提供的算法，例如 `KexAlgorithms +diffie-hellman-group14-sha1` |
| `Host key verification failed` | 首次连接，还没有确认主机指纹 | 先手动执行一次 `ssh <别名>` 并确认 |
| `REMOTE HOST IDENTIFICATION HAS CHANGED` | 实例重装或更换后指纹改变；**也可能是中间人攻击** | 先确认确实重装过，再执行 `ssh-keygen -R <主机>` 删除旧指纹 |
| `Could not resolve hostname` | 别名或 `HostName` 写错，或 DNS 无法解析 | 检查 `~/.ssh/config` |
| `Connection timed out` | 安全组或防火墙未放行 22 端口，或 IP 不对 | 在云控制台安全组中放行**你的出口 IP** 访问 22 端口，不要放行 `0.0.0.0/0` |
| `Connection refused` | sshd 未运行，或 SSH 不在 22 端口 | 确认 sshd 状态；非标准端口需在配置中加入 `Port` |
| `Enter passphrase for key` 后失败 | 私钥有口令，但后台无法输入 | 按上文“第 2 步”加入 `ssh-agent` 或钥匙串 |
| 连接成功但找不到 `hermes` 或 `openclaw` | 非登录 shell 中 `PATH` 不完整 | 插件会使用 `$SHELL -lc`；如仍失败，在配置中填写远端程序的绝对路径 |

**不要全局降低安全设置**。旧算法只应写在具体的 `Host` 段中，不要放在 `Host *` 下。

## 安全建议

1. 为每台服务器使用单独的密钥，泄露时便于单独撤销。
2. 尽量使用普通用户，不直接使用 `root`。
3. 安全组只放行你的 IP；条件允许时，优先使用 SSM、IAP、跳板机或 Tailscale，不直接暴露 22 端口。
4. 远端 Agent Gateway 只监听 `127.0.0.1`，由 SSH 转接访问。
