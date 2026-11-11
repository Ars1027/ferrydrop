# Linux 服务器部署记录

部署日期：2026-11-11。

入口：<https://43.173.127.94:8443>。服务独立运行，保留服务器原有应用及端口。

## 布局

- `/opt/ferrydrop/app`：发布源码、编译产物、Dockerfile.release 与 compose.release.yaml。
- `/opt/ferrydrop/data`：SQLite 和文件暂存，独立持久化挂载。
- `/opt/ferrydrop/certs`：运行服务使用的证书链与私钥，只读挂载。
- `/opt/ferrydrop/acme`：仅 root 管理的 ACME 配置、工作目录与日志。
- `/opt/ferrydrop/renew-ip-cert.sh`：证书续期及更新后容器重启。

容器名 `ferrydrop`，镜像 `ferrydrop:release`。Node.js 24，使用本地构建的前端与服务端 JS；服务器只安装运行依赖。运行用户 UID/GID 1000，根文件系统只读，数据目录可写，内存上限 256 MiB，容器设置 `unless-stopped` 重启策略。

## 登录

初始化两个独立账户：`admin`（管理员、VIP）和 `member`（普通用户）。随机口令只保存在本地被 Git 忽略的 `runtime/SERVER-LOGIN.md`，不写进本文、镜像、Compose 或远程发布文件。

浏览器测试创建的“部署验证”设备为自动化会话名称；测试浏览器关闭后不在线。实际使用时请登记自己的设备名称。

## HTTPS 与续期

已签发 Let's Encrypt 公网 IP 证书，浏览器无需安装项目自签 CA。证书的首次有效期至 2026-11-17，续期由 `ferrydrop-certificate.timer` 每天检查两次，成功更换证书后重启 FerryDrop 加载新证书。续期验证需要公网 80 端口保持可达，服务本身使用 8443。

IP 证书采用短有效期，Certbot 配置参考 [Let's Encrypt 官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)。首次签发及实际访问均已验证。

## 管理命令

```sh
sudo docker logs --tail 100 ferrydrop
sudo docker stats --no-stream ferrydrop
sudo docker restart ferrydrop
sudo systemctl list-timers ferrydrop-certificate.timer
sudo systemctl start ferrydrop-certificate.service
sudo journalctl -u ferrydrop-certificate.service --no-pager -n 30
```

更新发布：本地运行 npm ci、npm run build，上传源码和 `apps/server/dist`、`apps/web/dist`；保留 data、certs、acme。然后在 `/opt/ferrydrop/app` 执行：

```sh
sudo docker build --pull -f Dockerfile.release -t ferrydrop:release .
sudo docker compose -f compose.release.yaml up -d
```

本地仓库中的模板是 `deploy/Dockerfile.release` 与 `deploy/compose.release.yaml`。实际服务器把这两个文件放到 app 根目录。

## 已执行验证

- 从外部 Windows 客户端访问健康接口，TLS 正常验证。
- Chrome 两个独立上下文在公网受信 HTTPS 下登记设备、公钥认证、房间审批，进行双向 WSS 传输，逐字节核对收到的文本。
- 真实服务非 root 运行，可写 data，不能写 app 根目录。
- 两次交付后暂存目录无残留文件。
- 重启容器后账户仍保留，公网健康检查继续通过。
- 续期服务已成功运行，定时器已启用。
- Certbot 续期模拟（renew --dry-run）成功，公网 HTTP 验证链路可用。

Android 真机操作与 Windows 专用账户 ACL 仍按原验证记录单独验收。公网浏览器窄屏视口不替代 Android 真机测试。
