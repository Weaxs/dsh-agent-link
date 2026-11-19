# SSH setup guide

SSH is the default transport for dsh-agent-link. This guide helps you make a remote agent host reachable without interactive prompts.

## How the plugin uses SSH

- The plugin invokes the **system OpenSSH client**. It does not implement SSH algorithms, key exchange, host-key verification, jump hosts, or authentication itself.
- Background connections use `BatchMode=yes`, so they cannot ask for a password or private-key passphrase.
- Connections use `ssh -W 127.0.0.1:<gateway-port> <alias>`. The remote gateway can stay on `127.0.0.1`; no additional remote port needs to be exposed.
- The plugin reads but never modifies `~/.ssh/config`. It may generate a snippet for you to review and paste yourself.

The simplest readiness test is:

```bash
ssh -o BatchMode=yes -o ConnectTimeout=10 <alias> echo ok
```

If this prints `ok` without asking for input, the plugin can use the host.

## 1. Add the host to `~/.ssh/config`

```sshconfig
Host gpu-box
  HostName 203.0.113.10
  User ubuntu
  IdentityFile ~/.ssh/gpu-box.pem
  IdentitiesOnly yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
```

Restrict private-key permissions or OpenSSH will refuse it:

```bash
chmod 600 ~/.ssh/gpu-box.pem
```

## 2. Handle a private-key passphrase

Background connections cannot answer a passphrase prompt. On macOS, add the key to the system keychain:

```bash
ssh-add --apple-use-keychain ~/.ssh/gpu-box.pem
```

Add this near the top of `~/.ssh/config`:

```sshconfig
Host *
  AddKeysToAgent yes
  UseKeychain yes
```

On Linux, use `ssh-agent` or the desktop environment's key manager.

## 3. Verify the host key once

```bash
ssh gpu-box
```

Review the fingerprint on first use. OpenSSH saves it in `~/.ssh/known_hosts`. The plugin does not automatically accept an unknown fingerprint.

## 4. Check the remote agent in a login shell

```bash
ssh gpu-box -- '$SHELL -lc "command -v hermes || command -v openclaw"'
```

The API server or gateway must also be listening on its expected loopback port.

## Cloud provider differences

These are common defaults, not guarantees. Confirm the username and connection method in the provider's console.

| Provider                       | Common default user                                            | Key material                           | Alternative login path                                      |
| ------------------------------ | -------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Alibaba Cloud ECS              | `root`; newer images may use `ecs-user`                        | Downloaded `.pem` key pair             | Workbench is browser-only and cannot be used by this plugin |
| Tencent Cloud CVM / Lighthouse | `ubuntu` for Ubuntu images; often `root` otherwise             | Downloaded `.pem` key pair             | OrcaTerm is browser-only                                    |
| Huawei Cloud ECS               | `root`                                                         | `.pem` key pair                        | CloudShell is browser-only                                  |
| AWS EC2                        | `ec2-user` (Amazon Linux), `ubuntu` (Ubuntu), `admin` (Debian) | `.pem` key pair                        | SSM Session Manager, below                                  |
| Google Cloud                   | Determined by `gcloud` or OS Login                             | Usually `~/.ssh/google_compute_engine` | `gcloud compute config-ssh`, IAP, below                     |
| Azure                          | Chosen at VM creation; often `azureuser`                       | Generated `.pem` key pair              | `az ssh config` / Entra ID, below                           |

Browser-based shells cannot be reused by the plugin. Configure key-based OpenSSH or one of the following ProxyCommand integrations.

### AWS through SSM Session Manager

Install AWS CLI and the Session Manager plugin, and give the instance the required SSM permissions:

```sshconfig
Host aws-box
  HostName i-0123456789abcdef0
  User ec2-user
  IdentityFile ~/.ssh/aws-box.pem
  ProxyCommand sh -c "aws ssm start-session --target %h --document-name AWS-StartSSHSession --parameters 'portNumber=%p'"
```

### Google Cloud

Generate SSH configuration for project instances:

```bash
gcloud compute config-ssh
```

For an instance without a public IP, use IAP:

```sshconfig
Host gcp-box
  HostName my-instance
  User your-user
  IdentityFile ~/.ssh/google_compute_engine
  ProxyCommand gcloud compute start-iap-tunnel %h %p --listen-on-stdin --zone=asia-east1-b --project=my-project
```

### Azure with Entra ID

```bash
az ssh config --resource-group my-rg --name my-vm --file ~/.ssh/config
```

### Through a bastion

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

## Troubleshooting

`agent_link_doctor` recognizes these failures and returns a targeted hint.

| Error                                                   | Likely cause                                                        | Fix                                                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `Permission denied (publickey)`                         | Wrong user or key, or the public key is not authorized              | Check `User`, `IdentityFile`, and the server's `authorized_keys`.                                                               |
| `Too many authentication failures`                      | ssh-agent offers too many keys                                      | Set `IdentitiesOnly yes` and one `IdentityFile` for this host.                                                                  |
| `UNPROTECTED PRIVATE KEY FILE`                          | Private-key permissions are too broad                               | Run `chmod 600 <key>`.                                                                                                          |
| `Load key ...: invalid format`                          | The key is a PuTTY `.ppk` file                                      | Run `puttygen key.ppk -O private-openssh -o key.pem`.                                                                           |
| `no matching host key type found. Their offer: ssh-rsa` | An old server offers only SHA-1 RSA host keys                       | For this host only, add `HostKeyAlgorithms +ssh-rsa` and `PubkeyAcceptedAlgorithms +ssh-rsa`; upgrade the server when possible. |
| `no matching key exchange method found`                 | The server offers only old key-exchange algorithms                  | For this host only, add the offered `KexAlgorithms`; plan a server upgrade.                                                     |
| `Host key verification failed`                          | The host has not been trusted yet                                   | Connect manually once and verify its fingerprint.                                                                               |
| `REMOTE HOST IDENTIFICATION HAS CHANGED`                | The host was rebuilt or its key changed; it could also be an attack | Verify the cause first, then remove the old entry with `ssh-keygen -R <host>`.                                                  |
| `Could not resolve hostname`                            | Incorrect alias, hostname, or DNS                                   | Check `~/.ssh/config`.                                                                                                          |
| `Connection timed out`                                  | Security group, firewall, address, or routing problem               | Allow your source IP to reach TCP 22; do not open it to `0.0.0.0/0`.                                                            |
| `Connection refused`                                    | sshd is stopped or uses another port                                | Check sshd and set `Port` explicitly.                                                                                           |
| `Enter passphrase for key` followed by failure          | The key needs a passphrase unavailable in background mode           | Add the key to ssh-agent or the macOS keychain.                                                                                 |
| Login works but `hermes` or `openclaw` is missing       | Non-login PATH differs from the interactive PATH                    | Use a login shell or configure the absolute executable path on the server.                                                      |

Never weaken algorithms globally under `Host *` to accommodate one old server.

## Security checklist

1. Use a separate key for each server so revocation is targeted.
2. Prefer an unprivileged user over `root`.
3. Restrict port 22 to your source IP, SSM, IAP, a bastion, or Tailscale.
4. Keep the agent gateway on loopback or a trusted tailnet interface.
5. If sshd sets `AllowTcpForwarding no`, use Tailscale or ask the administrator to permit forwarding for this account.
