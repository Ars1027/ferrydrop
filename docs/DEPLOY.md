# 启动与部署

## Windows 主路径

准备 Node.js 24、npm 和 OpenSSL。PowerShell 在仓库根目录执行：

```powershell
npm ci
npm run build
npm run cert -- 192.168.1.20
```

将示例 IP 改成这台电脑的实际局域网 IPv4 地址。证书包含 localhost、127.0.0.1 和传入地址；IP 改变后应重新生成适用证书。证书脚本拒绝覆盖现有密钥，先妥善备份已有目录。生成的 `certs/` 不进 Git。

信任 `certs/ca.pem`：

- Windows：导入当前用户的“受信任的根证书颁发机构”。只在你控制的测试设备安装本项目 CA。
- Android：将 CA 证书传到手机，在系统“安装证书/CA 证书”中安装，具体入口随厂商变化。必要时将 `ca.pem` 复制为 `.crt` 后安装，保留原内容。浏览器必须真正信任此 CA，且访问 IP 必须匹配 SAN。
- CA 私钥 `ca-key.pem` 仅保存在签发环境；服务端运行只需要 `server.pem` 与 `server-key.pem`。不要把私钥发到手机。

使用本地 CLI 创建至少两个不同的账户，然后启动：

```powershell
$env:FD_USER_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '设置 alice 的密码' -AsSecureString)).Password
npm run user -- alice --tier standard --admin
Remove-Item Env:FD_USER_PASSWORD
$env:FD_USER_PASSWORD = [System.Net.NetworkCredential]::new('', (Read-Host '设置 bob 的密码' -AsSecureString)).Password
npm run user -- bob --tier vip
Remove-Item Env:FD_USER_PASSWORD
.\scripts\start.ps1
```

CLI 从进程环境 `FD_USER_PASSWORD` 读取口令；设置后用完应移除，不写进 `.env.example` 或仓库。默认不创建共享管理员口令。

电脑与手机打开 `https://192.168.1.20:8443`。Windows 防火墙只对可信局域网配置所需入站端口；不要将开发入口暴露公网。手机不能用 `localhost` 指代电脑。遇到证书警告应修复信任和地址匹配，不能以跳过警告作为安全验收。

## 第一次传输

1. 各设备用对应账户口令登记设备，后续用本机公钥认证。
2. 一方创建房间，另一方扫码或输入房间码申请加入。
3. 房主批准，在设备列表选收件方，选择或拖入文件。
4. 接收方检查文件名、大小和发送设备，接受文件。
5. 等待上传与下载校验完成，点击保存文件。任务回执显示服务端清理结果。
6. 中断后保持相同访问入口，重连继续；发送端刷新后可能需要重选同一文件。

## 开发与自动测试

仅本机开发时可以显式开启 localhost HTTP。此入口依赖浏览器对 localhost 安全上下文的处理，不可用于手机局域网安全验收。

```powershell
$env:FD_INSECURE_LOCALHOST = '1'
$env:HOST = '127.0.0.1'
npm run dev
```

测试命令：

```powershell
npm run typecheck
npm test
npm run test:e2e
```

测试浏览器需要先安装：`npx playwright install chromium`。端到端测试使用隔离的临时用户与数据目录，不依赖正式账户。

## 配置

可在仓库根目录建立仅本机保存的 `.env`，或使用进程环境变量。相对路径均以仓库根目录解析。

| 变量 | 默认值/用途 |
| --- | --- |
| DATA_DIR | runtime/data |
| HOST / PORT | 127.0.0.1 / 8443；start.ps1 默认监听 0.0.0.0 |
| TLS_CERT / TLS_KEY | 必须配置；start.ps1 使用 certs/server.pem 与 certs/server-key.pem |
| STANDARD_RATE / VIP_RATE | 每方向 1048576 / 4194304 字节每秒 |
| MAX_FILE_SIZE | 268435456 字节 |
| RETENTION_MS | 86400000 毫秒 |
| ROOM_TTL_MS | 900000 毫秒 |
| WEB_ROOT | apps/web/dist |

数值配置必须是正整数。测试本地 HTTP 还需显式设置 FD_INSECURE_LOCALHOST=1，且只允许回环地址。

## 最小权限与容器

Windows 使用专用标准用户运行服务，安装 Node 及依赖，明确程序目录只读、runtime 数据目录可写、证书私钥仅只读。执行 `scripts/acl.ps1 -ServiceAccount '<机器名>\<专用账户>'` 前应检查脚本和该账户现有权限。该脚本只操作仓库子目录，不修改父目录；它不负责创建系统用户，也不能撤销账户已有的其他目录权限。

以受限账户实际测试：可在 runtime/data 创建文件，不能写程序源码、读取 CA 私钥或向指定禁止目录写入。配置成功与越权失败证据都要记录。

Linux 容器部署前，创建仅 UID 1000 可写的 `runtime/container-data`，服务端证书需允许容器用户读取。容器只挂载服务证书，不挂载 CA 私钥：

```sh
mkdir -p runtime/container-data
sudo chown 1000:1000 runtime/container-data
docker compose -f deploy/compose.yaml build
read -s -p '设置 alice 的密码: ' FD_USER_PASSWORD; echo
export FD_USER_PASSWORD
docker compose -f deploy/compose.yaml run --rm -e FD_USER_PASSWORD ferrydrop npm run user -- alice --tier standard --admin
unset FD_USER_PASSWORD
docker compose -f deploy/compose.yaml up -d
```

容器根文件系统只读，data 挂载可写，临时空间有界。当前机器未运行 Docker 时，不把配置文件存在当作容器验证通过。

## 停用

停止服务，删除不再需要的临时文件，并从测试设备中移除 FerryDrop Local Development CA。浏览器站点数据包含设备密钥和未导出接收文件，清除前先保存需要的文件。重新安装或换访问域名/端口后，需要重新登记设备。
