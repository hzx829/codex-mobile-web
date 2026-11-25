# 公网中继部署

局域网直接用同一 Wi-Fi。公网部署后，手机打开自己的 HTTPS 域名即可，不依赖 Tailscale。电脑通过出站 WebSocket 连接服务器，无需给电脑做端口映射。

服务器只运行网页、中继和 HTTPS 入口；Codex、模型认证、完整工作区和原生历史由开发电脑管理。手机查看的会话、文件预览、差异及控制消息会经过中继，中继能读取这些内容，但不写入业务数据库。Caddy 的数据卷保存证书和相关配置。部署前请读 [隐私与信任边界](PRIVACY.md#简体中文)。

## 准备

- 一台可联网的 Linux 服务器，已安装 Docker Engine 和 Docker Compose v2，能拉取 `node:24-alpine` 和 `caddy:2-alpine` 官方镜像。部署包已带构建结果，不需要服务器安装 Node、npm 或 Codex，也不运行 `npm install`。
- 一个域名，例如 `codex.your-domain.com`，A 记录指向服务器公网 IPv4。只有服务器确实支持 IPv6 时才配置 AAAA。
- 服务器的 TCP 80、443、3341 可从外部访问，且没有其他程序占用。3341 用于 HTTPS 网页预览；中继自己的 3340/3341 只监听服务器回环地址。
- 本节 Docker + Caddy 配置使用域名；没有域名时，也可使用下文的受信任 IP 证书方案。

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

1. 等连接器管理的任务完成。便携包在托盘图标菜单选择“修改连接配置”（会先停止服务）；源码目录先运行 `stop.cmd` 再打开 `configure.cmd`。
2. 在配置窗口选择“连接自己的中继（已部署的公网地址）”。地址填 `https://codex.your-domain.com`，Token 填服务器 `.env` 中的相同值。
3. 保存后托盘会自动重新启动（源码目录运行 `start.cmd`）。此模式只启动电脑连接器；无需迁移模型配置或项目目录。
4. 手机扫码，或打开域名填写同一个 Token。关闭手机 Wi-Fi、用移动数据验证，能看到电脑在线和原有项目才算公网链路通过。

电脑需要保持开机和联网。电脑离线时服务器仍能显示网页，但无法代替电脑执行 Codex。原来的 Wi-Fi 模式仍可通过配置窗口切回。

## 访客包部署

先升级中继和网页端，再在 Windows 构建访客包。

```powershell
npm run package:guest -- --name "借用电脑" --relay https://codex.your-domain.com
```

把生成的 `guest-*.zip` 交给电脑主人。保留同名的 `.relay.json`，将其中的记录追加到中继配置的 `connectorTokens` 数组。Compose 部署把数组写入 `.env` 的环境变量，保留已有记录。

```dotenv
BRIDGE_CONNECTOR_TOKENS='[{"machineId":"guest-…","token":"…"}]'
```

Compose 部署运行 `docker compose -f compose.yaml -f compose.https.yaml up -d --build` 应用配置。直接运行 Node 的中继可使用 `BRIDGE_CONNECTOR_TOKENS`，也可用打包参数 `--relay-config <路径>` 追加到已有的中继 JSON 配置，再重启中继。手机继续使用原有的主 Token。

电脑主人解压后双击「启动.cmd」。网页的「电脑」菜单会在电脑名旁显示「借用」。停止连接用「停止.cmd」，清空该包里的项目、会话和登录副本用「清除访客数据.cmd」。要撤销访客包，从中继配置删除对应的 Token 并重新应用配置。

## 团队成员（可选）

默认整个中继只有一个共享 Token。多人一起用时可以启用团队：每人用自己的邀请链接登录，每台设备可以单独移除，会话列表标出是谁开的会话，管理员能看到操作记录。启用后的日常使用见 [团队使用说明](docs/team/GUIDE.md)，设计见 [团队账号与会话归属](docs/team/DESIGN.md)。一个中继只能有一个团队；要服务多个互相隔离的团队，见 [一台服务器运行多个团队](#一台服务器运行多个团队)。

1. 先升级中继和网页端。Compose 部署新增 `relay_data` 数据卷，数据库在 `/data/relay.sqlite`。直接用 Node 运行的实例（例如 systemd）默认写在工作目录的 `.local/relay.sqlite`，可用 `BRIDGE_DATA` 指定其他目录；该目录需要可写。
2. 启用团队并创建所有者，`--url` 填手机访问的地址：

   ```sh
   docker compose -f compose.yaml -f compose.https.yaml exec relay node build/relay.mjs team init --name 你的名字 --url https://codex.your-domain.com
   ```

   直接用 Node 运行的实例，以运行中继的系统用户、用与中继相同的 `BRIDGE_DATA` 和 Node 运行 `build/relay.mjs team init …`，例如 systemd 服务：

   ```sh
   runuser -u codex-relay -- env BRIDGE_DATA=/var/lib/codex-mobile-relay /opt/codex-mobile-relay/runtime/node24/bin/node /opt/codex-mobile-relay/app/build/relay.mjs team init --name 你的名字 --url https://你的地址
   ```
3. 在手机或电脑浏览器打开输出的邀请链接，即以所有者身份登录。之后在“选项 → 团队 → 成员”添加成员，把生成的链接或二维码发给对方。每个邀请链接 24 小时内有效，只能用一次。
4. 启用后，手机不能再用共享 Token 登录，已打开的网页会回到登录页。电脑连接器继续用原 Token 连接，不需要修改。若要给某台电脑换成专用 Token，在“团队 → 电脑”中生成，再在那台电脑的“修改连接配置”里替换；生成后，那台电脑就不能再用共享 Token 连接。
5. 所有者的设备全部丢失时，在服务器上运行 `team invite --user <名字>` 重新生成邀请链接；`team list` 列出成员。

“团队 → 用量”按人统计轮次和 token。只有更新后的电脑连接器才会上报，更新前完成的轮次不会补算。

### 备份和恢复

`relay.sqlite` 保存成员、设备、会话归属、操作记录和每轮用量，不保存消息正文。所有者的设备丢了，可以用 `team invite` 找回；这个文件丢了，团队就没了：中继回到个人模式，手机又能用共享 Token 登录，所有人都要重新邀请，用量和操作记录也找不回来。所以要定期备份，并把备份放到服务器以外的地方。

文件位置：Compose 部署在 `relay_data` 数据卷里，路径 `/data/relay.sqlite`；直接用 Node 运行的实例在 `BRIDGE_DATA` 目录下，没有设置时是程序目录下的 `.local/relay.sqlite`。

**备份**不用停中继。数据库用 WAL 模式，最近的改动可能还在旁边的 `relay.sqlite-wal` 里，直接复制 `relay.sqlite` 会漏掉，要让 SQLite 导出一份完整副本。导出的目标文件不能已经存在。

Compose 部署，在部署目录运行，得到当前目录下的 `relay-backup-<日期>.sqlite`：

```sh
docker compose -f compose.yaml -f compose.https.yaml exec relay node -e "new (require('node:sqlite').DatabaseSync)('/data/relay.sqlite').exec(\"VACUUM INTO '/data/backup.sqlite'\")"
docker compose -f compose.yaml -f compose.https.yaml cp relay:/data/backup.sqlite ./relay-backup-$(date +%F).sqlite
docker compose -f compose.yaml -f compose.https.yaml exec relay rm /data/backup.sqlite
```

直接用 Node 运行的实例，以运行中继的系统用户执行，避免数据目录里多出属于 root、中继打不开的文件。下例是 systemd 服务用户 `codex-relay`、数据目录 `/var/lib/codex-mobile-relay`，需要服务器有 `sqlite3` 命令：

```sh
cd /var/lib/codex-mobile-relay
runuser -u codex-relay -- sqlite3 relay.sqlite ".backup 'backup.sqlite'"
mv backup.sqlite /root/relay-backup-$(date +%F).sqlite
```

没有 `sqlite3` 时，把第二行换成用中继自己的 Node 24 运行上面 Compose 第一条命令里的 `node -e …`，路径改成数据目录。系统自带的旧版 Node 可能没有 `node:sqlite`。可以用 cron 每天运行一次，再把文件拷到别的机器。

**恢复**：停止中继，把数据目录里的 `relay.sqlite`、`relay.sqlite-wal`、`relay.sqlite-shm` 移到别处（留着，以防恢复错了），把备份复制成 `relay.sqlite` 并交给运行中继的用户，再启动中继。

Compose 部署（把备份文件名换成实际的）：

```sh
docker compose -f compose.yaml -f compose.https.yaml stop relay
docker compose -f compose.yaml -f compose.https.yaml run --rm --no-deps -v "$PWD/relay-backup-2026-11-22.sqlite:/restore.sqlite:ro" --entrypoint sh relay -c 'mkdir -p /data/before-restore && (mv /data/relay.sqlite* /data/before-restore/ || true) && cp /restore.sqlite /data/relay.sqlite'
docker compose -f compose.yaml -f compose.https.yaml start relay
docker compose -f compose.yaml -f compose.https.yaml exec relay node build/relay.mjs team list
```

直接用 Node 运行的实例：

```sh
systemctl stop codex-mobile-relay
cd /var/lib/codex-mobile-relay
mkdir -p before-restore && mv relay.sqlite* before-restore/
install -o codex-relay -g codex-relay -m 600 /root/relay-backup-2026-11-22.sqlite relay.sqlite
systemctl start codex-mobile-relay
runuser -u codex-relay -- env BRIDGE_DATA=/var/lib/codex-mobile-relay /opt/codex-mobile-relay/runtime/node24/bin/node /opt/codex-mobile-relay/app/build/relay.mjs team list
```

恢复后，数据回到备份那一刻：

- 备份之后加入的成员、登录的设备要重新邀请；备份之后生成的电脑专用 Token 失效，那台电脑要重新生成，或改回共享 Token。
- 备份之后移除的设备、停用的成员会重新生效，要到“团队”里再移除或停用一次。
- 备份之后的用量会缺：电脑连接器在中继确认收到后就删掉了自己的副本，不会重发。

## 一台服务器运行多个团队

一个中继只能有一个团队：成员、电脑、用量都在同一个 `relay.sqlite` 里，所有者和管理员能看到这个中继上的全部电脑。要让几个团队互相隔离，就给每个团队运行一个独立的中继实例。每个实例有自己的 Token、数据目录、端口和网址，彼此不共享数据：一个团队的 Token 和邀请链接进不了另一个团队的中继，各团队自己的所有者管理自己的成员。能登录服务器的人仍然能看到所有实例的数据（见 [隐私与信任边界](PRIVACY.md#简体中文)）。

下面的步骤适用于直接用 Node + systemd 运行的中继，2026-11-25 在现有 IP 证书实例上加第二个团队时验证过。Compose 部署见本节末尾。

### 规划

每个实例要定下团队代号和三个端口。下例代号 `acme`：

| 项目 | 第一个实例 | 新实例（示例） | 说明 |
| --- | --- | --- | --- |
| systemd 服务 | `codex-mobile-relay` | `codex-mobile-relay-acme` | |
| 系统用户 | `codex-relay` | `codex-relay-acme` | 每个实例单独的用户，读不到别的实例的数据 |
| 中继端口 `PORT` | 3340 | 3350 | 只监听服务器回环地址 |
| 网页预览端口 | 3341 | 3351 | 中继固定用 `PORT+1`，并按这个端口号生成预览地址，所以**对外也必须是同一个端口** |
| 对外 HTTPS 端口 | 443 | 8443 | 有域名时也可以给每个团队一个子域名，都用 443 |
| 数据目录 `BRIDGE_DATA` | `/var/lib/codex-mobile-relay` | `/var/lib/codex-mobile-relay-acme` | |
| Token 文件 | `/etc/codex-mobile-relay/relay.env` | `/etc/codex-mobile-relay-acme/relay.env` | |

先在云服务器的安全组和本机防火墙放行新实例的对外 HTTPS 端口和预览端口（例中 8443、3351），并确认这几个端口没有被占用：

```sh
ss -ltn | grep -E ':(3350|3351|8443) '
```

没有输出才能继续。

### 1. 系统用户和 Token

```sh
useradd --system --no-create-home --home-dir /nonexistent --shell /sbin/nologin codex-relay-acme
install -d -m 750 -o root -g codex-relay-acme /etc/codex-mobile-relay-acme
printf 'BRIDGE_TOKEN=%s\n' "$(openssl rand -hex 32)" > /etc/codex-mobile-relay-acme/relay.env
chown root:codex-relay-acme /etc/codex-mobile-relay-acme/relay.env
chmod 640 /etc/codex-mobile-relay-acme/relay.env
```

这个 Token 只给这个团队的电脑第一次连接用（见下文第 5 步），不要用第一个实例的 Token。

### 2. systemd 服务

程序和 Node 运行时与第一个实例共用 `/opt/codex-mobile-relay`，只有用户、端口、数据目录和 Token 不同。`BRIDGE_CONFIG` 指向一个不存在的文件，免得读到程序目录里别的配置。

```ini
# /etc/systemd/system/codex-mobile-relay-acme.service
[Unit]
Description=Codex Mobile Web relay (acme)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex-relay-acme
Group=codex-relay-acme
WorkingDirectory=/opt/codex-mobile-relay/app
EnvironmentFile=/etc/codex-mobile-relay-acme/relay.env
Environment=HOST=127.0.0.1
Environment=PORT=3350
Environment=NODE_ENV=production
Environment=BRIDGE_DATA=/var/lib/codex-mobile-relay-acme
Environment=BRIDGE_CONFIG=/etc/codex-mobile-relay-acme/config.json
StateDirectory=codex-mobile-relay-acme
StateDirectoryMode=0750
ExecStart=/opt/codex-mobile-relay/runtime/node24/bin/node /opt/codex-mobile-relay/app/build/relay.mjs
Restart=on-failure
RestartSec=3
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/codex-mobile-relay-acme

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload
systemctl enable --now codex-mobile-relay-acme.service
curl --fail http://127.0.0.1:3350/health
```

### 3. Nginx

照第一个实例的配置复制一份，改成新端口，例如 `/etc/nginx/conf.d/41-codex-mobile-acme.conf`。`$codex_connection_upgrade` 用第一个实例配置里已有的 `map`，不要重复定义。证书沿用第一个实例的（IP 证书或域名证书都对所有端口有效）。

```nginx
server {
    listen 8443 ssl http2;
    server_name 你的IP或域名;
    ssl_certificate     <与第一个实例相同>/fullchain.pem;
    ssl_certificate_key <与第一个实例相同>/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    # /blob-feed/ 和 /blob/ 两段与“已有 HTTPS 反向代理”一节相同，proxy_pass 改为 http://127.0.0.1:3350
    location / {
        proxy_pass http://127.0.0.1:3350;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $codex_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
    }
}

server {
    # 中继自己在回环地址上占着 3351，所以这里绑定服务器网卡的地址
    listen <网卡地址>:3351 ssl;
    server_name 你的IP或域名;
    ssl_certificate     <与第一个实例相同>/fullchain.pem;
    ssl_certificate_key <与第一个实例相同>/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    access_log off;
    location / {
        proxy_pass http://127.0.0.1:3351;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $codex_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        proxy_buffering off;
        client_max_body_size 32m;
    }
}
```

```sh
nginx -t && systemctl reload nginx
```

在服务器以外的地方检查：`curl --fail https://你的地址:8443/health` 返回 `{"ok":true}`；`https://你的地址:3351/` 返回 401 说明预览端口已通。

### 4. 启用团队

以新实例的系统用户、新实例的数据目录运行 `team init`，`--name` 填对方负责人，`--url` 填带端口的地址：

```sh
cd /tmp && runuser -u codex-relay-acme -- env BRIDGE_DATA=/var/lib/codex-mobile-relay-acme \
  /opt/codex-mobile-relay/runtime/node24/bin/node /opt/codex-mobile-relay/app/build/relay.mjs \
  team init --name 对方负责人 --url https://你的地址:8443
```

把输出的邀请链接交给负责人（24 小时内有效，只能用一次），他就是这个团队的所有者，之后自己添加成员。以后找回、列成员也用同样的用户和 `BRIDGE_DATA` 运行 `team invite` / `team list`。

### 5. 接入电脑

1. 电脑的连接设置里选“连接自己的中继”，地址填 `https://你的地址:8443`，Token 填第 1 步生成的那个。Token 不要发到聊天里，最好当面或远程输入。
2. 电脑连上后，团队管理员在“团队 → 电脑”中给它生成专用 Token，换到那台电脑的连接设置里。
3. 这个团队的电脑都换成专用 Token 后，重新生成第 1 步的 Token 并 `systemctl restart codex-mobile-relay-acme`，让交出去的共享 Token 作废。以后再加电脑时，临时把新的共享 Token 交给对方，接完再换掉。

### 6. 备份

每个实例的 `relay.sqlite` 都要备份，方法同上文“备份和恢复”，用各自的系统用户和数据目录。可以用一个脚本每天备份全部实例，每加一个实例在末尾加一行 `backup`：

```sh
#!/bin/sh
# /opt/codex-mobile-relay/relay-backup.sh，cron：30 4 * * * /bin/sh /opt/codex-mobile-relay/relay-backup.sh >>/var/log/relay-backup.log 2>&1
set -eu
node=/opt/codex-mobile-relay/runtime/node24/bin/node
out=/root/relay-backups
day=$(date +%F)
mkdir -p "$out"; chmod 700 "$out"
backup() { # <系统用户> <数据目录> <文件名前缀>
  db="$2/relay.sqlite"; [ -f "$db" ] || return 0
  tmp="$2/backup-$day.sqlite"; rm -f "$tmp"
  (cd /tmp && runuser -u "$1" -- "$node" -e "new (require('node:sqlite').DatabaseSync)(process.argv[1]).exec(\"VACUUM INTO '\"+process.argv[2]+\"'\")" "$db" "$tmp")
  mv "$tmp" "$out/$3-$day.sqlite"; chmod 600 "$out/$3-$day.sqlite"
}
backup codex-relay /var/lib/codex-mobile-relay main
backup codex-relay-acme /var/lib/codex-mobile-relay-acme acme
find "$out" -name '*.sqlite' -mtime +30 -delete
```

备份仍在同一台服务器上，要定期拷到别的机器。

### 升级和移除

- **只更新网页**：各实例共用 `/opt/codex-mobile-relay/app/dist`，按 `scripts/web-deploy.sh` 更新一次，所有实例就都是新页面了。
- **更新中继程序**（`build/relay.mjs`）：替换后要重启**所有**实例，否则没重启的实例还在跑旧程序：`systemctl restart 'codex-mobile-relay*.service'`。
- **移除一个团队**：先按第 6 步做最后一次备份，再 `systemctl disable --now codex-mobile-relay-acme`，删掉它的服务文件、Nginx 配置（`nginx -t && systemctl reload nginx`）、`/etc/codex-mobile-relay-acme`、数据目录和系统用户，从备份脚本里删掉那一行，并在安全组关闭它的端口。

### Compose 部署

本包的 Compose 文件按单实例编写：项目名固定为 `codex-mobile-relay`，端口固定 3340/3341，Caddy 独占 80/443。多实例的做法与上面相同，但没有实际验收：每个团队一个目录，用 `-p` 指定不同的项目名（数据卷因此分开）；在 `relay` 的 `environment` 里设 `PORT`，并同步修改端口映射和健康检查里的端口；只启动一个 Caddy 或 Nginx，按域名或端口转到各实例，预览端口同样要对外保持 `PORT+1`。

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

### 只更新网页或电脑连接器

只改了手机网页、中继没变时，不必重建中继：按 `scripts/web-deploy.sh` 开头的说明在电脑上打包 `dist`，上传后在服务器上运行这个脚本。它只替换网页文件，保留旧的带哈希资源给还开着旧页面的手机，核对通过前中继进程不动，失败时换回原来的页面。这个脚本按直接运行 Node 的中继（`/opt/codex-mobile-relay`，systemd 服务）编写，目录、服务名和端口可用 `CODEX_RELAY_ROOT`、`CODEX_RELAY_SERVICE`、`CODEX_RELAY_PORT` 改。

电脑上实际运行的连接器如果是安装包（由 `Codex Mobile Web.exe` 启动），`npm run update:deploy` 检查的是仓库自己的安装，会拒绝。这时先 `npm run build`，再运行 `npm run deploy:package-connector -- <安装包文件夹>`：只替换安装包里的 `build/connector.mjs`，等 Claude Code 和 Codex 空闲才重启，保留安装包自己的设置和 Codex 版本，新构建没起来就换回原来的。

## 已有 HTTPS 反向代理

如果服务器已经有 Nginx 或 Caddy，占用了 80/443，只启动中继：

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:3340/health
```

在现有代理上将域名根路径转到 `127.0.0.1:3340`，并允许 `/ws` 的 WebSocket 长连接。另将同一域名的 HTTPS 3341 端口完整转到 `127.0.0.1:3341`，保留普通 HTTP 和 WebSocket 转发。不要同时启动本包的 Caddy。若现有代理也在 Docker 容器里，回环地址指向代理容器自身，需要把代理接到中继的 Docker 网络后用 `relay:3340` 和 `relay:3341`。

文件走中继的数据通道（[设计](docs/sync/DESIGN.md#8-数据通道)）。下载时电脑把文件作为一个 HTTP 请求体上传到 `/blob-feed/`；上传时手机把每段（最多 8 MiB）用 `PUT` 发到 `/blob/<电脑>/upload`。中继都是边收边转。现有代理要对这两个路径关闭请求缓冲、放开请求体大小，否则大于默认 1 MB 的请求会被拒绝（网页会退回分块上传），或者要等整个请求传到代理才开始转发。Nginx 示例，放在主入口的 `server` 里：

```nginx
location /blob-feed/ {
    proxy_pass http://127.0.0.1:3340;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering off;
    proxy_buffering off;
    client_max_body_size 110m;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
location /blob/ {
    proxy_pass http://127.0.0.1:3340;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_request_buffering off;
    proxy_buffering off;
    client_max_body_size 9m;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

手机端的 `/blob/` 下载同样经这一段转发，需要 `proxy_buffering off`（上面已有），并建议开启 HTTP/2，同一页面的多张图片和视频分段请求可以并行。Caddy 默认流式转发且不限制请求体，不需要额外配置。

### 没有域名：使用 IP 证书

Let’s Encrypt 已支持受信任的公网 IP 证书。使用 Certbot 5.4 或更新版本，通过 `certonly --webroot --webroot-path <验证目录> --ip-address <公网IP> --required-profile shortlived` 申请，并由 Nginx 加载证书；80 端口的 `/.well-known/acme-challenge/` 必须能从公网访问。先用 `--dry-run` 验证，再正式签发。[官方说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot.html)。

IP 证书有效期约 6 天，必须自动续期，并设置部署钩子执行 `nginx -t` 和 `systemctl reload nginx`。当前 Node + systemd 实例使用独立 Certbot 配置和每 6 小时检查一次的定时器，已通过续期演练。HTTPS 主入口和 3341 预览端口均代理到回环地址；Nginx 若与中继使用相同端口，应绑定服务器实际网卡地址，避免与中继的回环监听冲突。

电脑连接地址也需改成 `https://<公网IP>`，在连接器任务空闲后重启并恢复会话。重新生成连接二维码；HTTPS 是新的浏览器来源，首次连接需要重新扫码或输入原 Token。确认电脑已通过 WSS 连接后，关闭旧 HTTP WebSocket，只保留到 HTTPS 的跳转。

## 排查与验收

| 现象 | 检查 |
| --- | --- |
| 配置检查失败 | `.env` 是否填写 DOMAIN、BRIDGE_TOKEN；Compose 是否为 v2 |
| 证书签发失败 | 域名 A/AAAA、80/443 的安全组和防火墙、端口占用；查看 Caddy 日志 |
| 网页打开但电脑离线 | 电脑是否启动连接器；两边域名和 Token 是否一致；出站 WSS 是否被代理拦截 |
| 网页连接反复中断 | 反向代理是否支持 `/ws`；先看连接器错误日志，不要重新发送结果不明的操作 |
| 预览新标签页无法打开 | 公网 TCP 3341 是否开放、该端口是否配置 HTTPS 和 WebSocket 转发；电脑上的开发服务是否仍在运行 |
| 502 | `docker compose ps` 中 relay 是否 healthy；用回环 `/health` 区分中继与 HTTPS 问题 |
| `team init` 提示无法打开数据库 | Compose 是否已加 `relay_data` 数据卷并重新 `up -d`；直接运行时 `BRIDGE_DATA` 目录是否可写 |
| 团队成员看不到某台电脑 | 管理员在“团队 → 成员 → 编辑”中检查该成员的可用电脑 |

公网部署的完成条件：HTTPS 健康检查通过；手机用移动数据连接；能打开项目和原有任务；在测试会话发送一条消息并收到回复；中继重启后恢复连接。仅 `/health` 成功不代表整条链路已经通过。

2026-10-19 更新：Linux 上的 Node 24 + systemd 实例已增加 Nginx 和 Let’s Encrypt IP 证书。已验证公开 HTTPS 的证书信任、网页文件、WSS 认证和请求路由、预览端口及自动续期；手机录音交互由使用者实测。本页的 Docker + Caddy 路径仍未完成真实容器与证书签发验收。开源收尾见 [开源分享方案](OPEN_SOURCE.md)。

源码重新生成部署包：`npm ci` 后运行 `npm run package:relay`。源码直接部署仍使用根目录 Dockerfile，构建过程中需要访问 npm；预构建发布包使用只复制程序和网页的 Dockerfile。
