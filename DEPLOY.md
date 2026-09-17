# 公网中继部署

局域网直接用同一 Wi-Fi。公网部署后，手机打开自己的 HTTPS 域名即可，不依赖 Tailscale。电脑通过出站 WebSocket 连接服务器，无需给电脑做端口映射。

服务器只运行网页、中继和 HTTPS 入口；Codex、模型认证、完整工作区和原生历史由开发电脑管理。手机查看的会话、文件预览、差异及控制消息会经过中继，中继能读取这些内容，但不写入业务数据库。Caddy 的数据卷保存证书和相关配置。部署前请读 [隐私与信任边界](PRIVACY.md#简体中文)。

## 准备

- 一台可联网的 Linux 服务器，已安装 Docker Engine 和 Docker Compose v2，能拉取 `node:24-alpine` 和 `caddy:2-alpine` 官方镜像。部署包已带构建结果，不需要服务器安装 Node、npm 或 Codex，也不运行 `npm install`。
- 一个域名，例如 `codex.your-domain.com`，A 记录指向服务器公网 IPv4。只有服务器确实支持 IPv6 时才配置 AAAA。
- 服务器的 TCP 80、443 可从外部访问，且没有其他程序占用。3340 只监听服务器回环地址，不需要开放。
- 没有域名时先准备好文件，待域名解析完成后再开启公网 HTTPS；本说明不使用 IP 自签证书。

此部署包需要联网拉取两个基础镜像，不是离线镜像包。镜像拉取失败时先解决服务器到官方镜像仓库的连通性，不替换为来历不明的镜像。

## 首次启动

把 `codex-mobile-relay-*.tar.gz` 和相邻的 `.sha256` 文件上传到服务器同一个目录。下列 `<部署包名>` 替换为实际文件名，不含 `.tar.gz`。

```sh
sha256sum -c <部署包名>.tar.gz.sha256
tar -xzf <部署包名>.tar.gz
cd <部署包名>
sha256sum -c SHA256SUMS
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

编辑 `.env`，填写域名和上一步生成的 Token。域名不带 `https://`、端口或路径；Token 只用于自己的手机和电脑连接这个中继，不是模型 Key。不要把 Token 发到聊天、工单或公开仓库。这个实例按个人自托管设计，持有 Token 的设备拥有相同访问能力。

```dotenv
DOMAIN=codex.your-domain.com
BRIDGE_TOKEN=这里替换为刚生成的64位随机字符串
```

启动：

```sh
docker compose -f compose.yaml -f compose.https.yaml config --quiet
docker compose -f compose.yaml -f compose.https.yaml up -d --build
docker compose -f compose.yaml -f compose.https.yaml ps
curl --fail https://codex.your-domain.com/health
```

最后应返回 `{"ok":true}`。首次启动需等待镜像拉取和证书签发。Caddy 自动申请、续期证书，并将 HTTP 跳转到 HTTPS；反向代理自动支持 WebSocket，无需另配 Upgrade 请求头。[自动 HTTPS](https://caddyserver.com/docs/automatic-https)、[反向代理](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)。

## 连接 Windows 电脑

1. 等连接器管理的任务完成，双击原安装目录的 `stop.cmd`。
2. 打开 `configure.cmd`，选择“连接自己的中继（已部署的公网地址）”。地址填 `https://codex.your-domain.com`，Token 填服务器 `.env` 中的相同值。
3. 保存后双击 `start.cmd`。此模式只启动电脑连接器；无需迁移模型配置或项目目录。
4. 手机扫码，或打开域名填写同一个 Token。关闭手机 Wi-Fi、用移动数据验证，能看到电脑在线和原有项目才算公网链路通过。

电脑需要保持开机和联网。电脑离线时服务器仍能显示网页，但无法代替电脑执行 Codex。原来的 Wi-Fi 模式仍可通过配置窗口切回。

## 日常操作

下列命令都在解压后的部署目录运行：

```sh
# 状态与最近错误
docker compose -f compose.yaml -f compose.https.yaml ps
docker compose -f compose.yaml -f compose.https.yaml logs --tail=80

# 重新启动中继；电脑连接器保持运行，正在执行的本机任务可以继续
docker compose -f compose.yaml -f compose.https.yaml restart relay

# 停止部署，保留 HTTPS 证书卷
docker compose -f compose.yaml -f compose.https.yaml down
```

修改 `.env` 后使用 `up -d` 重新创建容器，`restart` 不会应用新的环境变量。换 Token 时同步更新电脑配置并重新扫码。[Compose 环境变量](https://docs.docker.com/compose/how-tos/environment-variables/set-environment-variables/)。

升级时将新包解压到新目录，核对 SHA256，把旧目录 `.env` 复制到新目录，进入新目录执行启动命令。固定 Compose 项目名 `codex-mobile-relay` 会更新原部署并复用证书卷。保留旧包；回退时进入旧目录执行同样的 `up -d --build`。同一台服务器默认只运行一个实例，不要对复用中的部署执行 `down -v`。

服务器需保留 `.env` 和 Caddy 证书卷，电脑需保留自己的 `.local/`。程序包中不包含这些运行数据。默认中继状态日志不主动记录聊天或文件正文，附带代理配置未启用访问日志；容器日志做大小轮换。自定义代理、云平台及诊断设置可能另行留存信息；错误日志也应检查后再分享。

## 已有 HTTPS 反向代理

如果服务器已经有 Nginx 或 Caddy，占用了 80/443，只启动中继：

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3340/health
```

在现有代理上将域名根路径转到 `127.0.0.1:3340`，并允许 `/ws` 的 WebSocket 长连接。不要同时启动本包的 Caddy。若现有代理也在 Docker 容器里，回环地址指向代理容器自身，需要把代理接到中继的 Docker 网络后用 `relay:3340`。

## 排查与验收

| 现象 | 检查 |
| --- | --- |
| 配置检查失败 | `.env` 是否填写 DOMAIN、BRIDGE_TOKEN；Compose 是否为 v2 |
| 证书签发失败 | 域名 A/AAAA、80/443 的安全组和防火墙、端口占用；查看 Caddy 日志 |
| 网页打开但电脑离线 | 电脑是否启动连接器；两边域名和 Token 是否一致；出站 WSS 是否被代理拦截 |
| 网页连接反复中断 | 反向代理是否支持 `/ws`；先看连接器错误日志，不要重新发送结果不明的操作 |
| 502 | `docker compose ps` 中 relay 是否 healthy；用回环 `/health` 区分中继与 HTTPS 问题 |

公网部署的完成条件：HTTPS 健康检查通过；手机用移动数据连接；能打开项目和原有任务；在测试会话发送一条消息并收到回复；中继重启后恢复连接。仅 `/health` 成功不代表整条链路已经通过。

2026-09-17 更新：已通过另一条部署路径，在 Linux 上用独立 Node 24 + systemd 运行公网中继，并将 Windows 连接器接入；使用者已确认中继版本使用正常。该实例使用 IP 直连 HTTP/WS，传输未加密。本页的 Docker + Caddy HTTPS 路径仍未完成真实容器与证书签发验收，不能用前者的成功代替后者。实际 Node + systemd 步骤尚待整理为通用部署说明；开源收尾见 [开源分享方案](OPEN_SOURCE.md)。

源码重新生成部署包：`npm ci` 后运行 `npm run package:relay`。源码直接部署仍使用根目录 Dockerfile，构建过程中需要访问 npm；预构建发布包使用只复制程序和网页的 Dockerfile。
