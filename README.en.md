<div align="center">
  <h1>FRP-ALL-IN-ONE</h1>
  <p>Container-based tunnel management for privately owned devices in mainland China.</p>
  <p>Linux/NAS clients · TCP/UDP mappings · Web console · Public Tencent Cloud images</p>
  <p><a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <a href="README.zh-TW.md">繁體中文</a></p>
</div>

## Preview

<p align="center"><img src="demo1.png" alt="Dashboard preview" width="850" /></p>

<details>
  <summary>More screenshots</summary>
  <table>
    <tr>
      <td width="50%"><img src="demo2.png" alt="Devices and tunnels" /></td>
      <td width="50%"><img src="demo3.png" alt="Device onboarding" /></td>
    </tr>
    <tr>
      <td width="50%"><img src="demo4.png" alt="Settings" /></td>
      <td width="50%"><img src="demo5.png" alt="Mobile UI" /></td>
    </tr>
  </table>
</details>

## Scope

- **Primary use**: a mainland China Linux server connecting to Linux/NAS devices in mainland China that you own or are authorized to manage. Examples include SSH, remote desktop and internal service maintenance.
- **Core features**: FRPS configuration, container client onboarding, TCP/UDP mappings, device status and logs. The Agent embeds the repository's customized FRP v0.71.1 core.
- **Distribution**: servers and clients independently pull images from `sgccr.ccs.tencentyun.com/frp-all-in-one`. End users do not clone or compile source, or download client binaries through the VPS.
- **Optional**: panel domain and HTTPS settings are collapsed under advanced settings. HTTP/HTTPS website tunneling requires additional configuration and compliance preparation.
- **Platform boundary**: Linux host networking is the primary deployment target. Windows/macOS use container VMs; confirm image platform support, host service addresses and host networking settings. They are not guaranteed to behave like Linux.
- **Not provided**: automatic regulatory filing, bypassing filing/provider restrictions, unauthorized access, cross-border proxy services or a public commercial tunnel platform.

## Mainland hosting, filing and HTTPS

**HTTPS alone does not determine whether filing is required.** Requirements depend on the service, hosting location and applicable regulations, not merely HTTP versus HTTPS. Providing internet information services in mainland China requires the applicable filing or licensing procedures. Using an IP address or a nonstandard port is not an automatic exemption. Nor should all TCP/UDP device connections be categorically described as exempt.

A domain-based website hosted in mainland China generally needs ICP filing through its hosting provider; additional licensing may apply to particular services. A TLS certificate provides encryption and identity validation, **not regulatory approval**. This project does not verify filing status automatically.

- [MIIT filing regulations](https://www.miit.gov.cn/gyhxxhb/jgsj/cyzcyfgs/bmgz/xxtxl/art/2024/art_84a0cfa0ebd049bbbe751dca9a008e56.html)
- [MIIT filing portal](https://beian.miit.gov.cn/)
- [Tencent Cloud filing requirements](https://cloud.tencent.com/document/product/243/19630)

The default `http://SERVER_IP:8080` is for initial setup or restricted access, **not long-term plaintext public administration**. Restrict trusted source addresses in security groups. Use compliant HTTPS or a protected access channel for long-term remote management. Panel HTTPS does not automatically secure every tunneled application; configure application authentication and encryption separately.

## Server deployment

Prepare a mainland China Linux server with a public address and reuse an existing container runtime where possible. The installer detects Docker/Podman. Backend container control currently uses the Podman API, so an existing Podman setup is preferred; verify management API compatibility separately when using Docker.

1. Create an OAuth App in [GitHub Developer Settings](https://github.com/settings/developers):
   - Homepage: `http://SERVER_IP:8080`
   - Callback: `http://SERVER_IP:8080/api/auth/github/callback`
   - Save the Client ID and generate a Client Secret.
2. Run:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/deploy.sh | sudo bash
   ```

3. Enter OAuth settings and the **initial administrator's numeric GitHub ID**. Find the `id` field at `https://api.github.com/users/YOUR_USERNAME`; usernames are also accepted. Do not skip the administrator restriction or share secrets/tokens.
4. Initialize FRPS in the panel. Under Devices → Add device, obtain and run the target OS's container installer, then configure port mappings.

Default server directory: `/opt/frp-all-in-one`; an existing Compose directory may be reused—check installer output. Client directories: Linux `/opt/frp`, macOS `~/.frp-all-in-one`, Windows `C:\frp`.

**Network prerequisites**: browsers and servers need GitHub OAuth access; script downloads require GitHub Raw; runtimes need access to the registry. Mainland hosting does not guarantee access to these external services. This project provides no public download proxy or availability guarantee.

### Ports

| Port | Purpose | Exposure |
| --- | --- | --- |
| TCP 8080 | Initial HTTP panel and Agent management | Trusted administrators and clients only |
| TCP 7000 | FRP connections | Restrict to clients where possible |
| Custom TCP/UDP | Mapped services | Open as needed; applications need authentication |
| TCP 80 / 443 | Optional validation / HTTPS | Open after meeting applicable requirements |
| TCP 7500 | Local FRPS management | Do not expose publicly |

Update OAuth Homepage/Callback URLs and client management connections when enabling a domain or HTTPS. Certificate issuance requires correct DNS, reachable port 80 validation and access to the certificate authority.

## Uninstall

Use the **same user, privileges and container context as deployment**. Enter `REMOVE` to confirm. Explicit `--yes` (PowerShell: `-Force`) skips confirmation. By default only project containers are removed; data, images, runtimes and unrelated containers/processes remain. No global prune is performed.

### Server

```bash
# Remove containers, keeping database, certificates and configuration
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server

# Permanently remove verified project data and OAuth credentials
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- server --purge
```

For a nondefault directory, append `--dir /actual/directory`; use `--project NAME` for a custom Compose project name. Only verified project containers, volumes and known files are removed; unrelated files remain. Clients on other machines are not uninstalled by removing the server.

### Client

Linux with a rootful runtime:

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | sudo bash -s -- client
```

macOS, as the Docker Desktop/Podman user without sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall.sh | bash -s -- client
```

Windows PowerShell, as the container desktop user:

```powershell
& ([scriptblock]::Create((Invoke-RestMethod 'https://raw.githubusercontent.com/newbietan/FRP-ALL-IN-ONE/main/deploy/uninstall-client.ps1')))
```

Append `--purge` / `-Purge` to remove verified client configuration and logs. Custom directories use `--dir /path` / `-InstallDir 'D:\frp'`. For Linux rootless deployment, omit sudo. Select a runtime with `--runtime docker|podman` or PowerShell `-Runtime docker|podman`.

**After uninstalling, unregister the device and its tunnels in the panel. Unregistering only deletes management records; it does not uninstall the remote container.** Legacy native binary services are outside this container uninstaller's scope. The old `uninstall-frpc.sh` URL is only a compatibility entry for current container removal.

## Maintainer publishing

Set all four TCR repositories (`frps`, `frp-backend`, `frp-frontend`, `frp-agent`) to **public**. Actions secrets `TCR_USERNAME` / `TCR_PASSWORD` are for maintainer pushes only; end users need no registry login.

```bash
bash deploy/build-and-push.sh latest
```

CI builds changed images, then pulls all four anonymously on separate runners with empty credentials. Versioned releases check both the version tag and `latest`. Failed verification fails the workflow without changing TCR permissions. Correct visibility and rerun failed jobs rather than moving published tags. Check individually with `bash deploy/check-public-images.sh FULL_IMAGE:TAG`.

## License

[Apache-2.0](LICENSE). The customized FRP source retains its [upstream license](core/frp_custom/LICENSE).
