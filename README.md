# cnb2api-panel

独立的 CNB 账号池面板和 API 网关。
前端使用 Vue，后端使用 Node.js。
面板负责账号路由、地址注册、用量统计和工作区唤醒。
CNB 工作区继续运行原来的 cnb2api。

同一个域名可以承载以下入口。

| 入口 | 用途 |
| --- | --- |
| `/` | 管理面板 |
| `/v1/*` | 统一 AI API |
| `/register` | 兼容旧地址注册 |
| `/ops/register` | 按注册密钥识别账号 |
| `/ops/register/<account-id>` | 指定账号的地址注册 |
| `/health` | 账号池可用状态 |

## 部署方式

Docker Compose 和普通 Node 均可部署。
两种方式使用相同的数据格式。
本项目自带后端、前端源码和部署模板。
服务器无需原项目的 `deploy/` 文件。

### Docker Compose

服务器需要 Docker Engine 和 Compose 插件。
宿主机无需安装 Node。
默认配置从 CNB 拉取已构建的镜像。
服务器无需保留源码和 `Dockerfile`。
镜像已包含后端、前端和 Node。

把项目放到以下目录。

```text
/data/platform2api/cnb2api-panel/
```

从仓库下载 `docker-compose.yaml` 和 `.env.example`。
将这两个文件放入项目目录。
首次部署时，复制配置模板。

```bash
cd /data/platform2api/cnb2api-panel
cp .env.example .env
chmod 600 .env
```

已有部署保留原 `.env`，无需复制模板。

运行两次以下命令，分别生成两个密钥。

```bash
openssl rand -hex 24
```

修改 `.env` 中的两个密钥和域名。

```dotenv
PANEL_ADMIN_KEY=replace-with-first-random-key
GATEWAY_KEY=replace-with-second-random-key
PANEL_PUBLIC_URL=https://ai.example.com
PANEL_PORT=9002
PANEL_BIND_HOST=127.0.0.1
```

两个密钥必须不同，且各有至少 12 个字符。
密钥应只含无空格的可打印 ASCII 字符。

启动面板。

```bash
docker compose pull
docker compose up -d
docker compose logs --tail=100 panel
```

默认镜像如下。

```text
docker.cnb.cool/azurekiln/cnb2api-panel:latest
```

需要固定版本时，在 `.env` 中配置镜像。

```dotenv
PANEL_IMAGE=docker.cnb.cool/azurekiln/cnb2api-panel:v1.0.1
```

GHCR 镜像也可通过 `PANEL_IMAGE` 指定。
使用前确认镜像已公开或完成仓库登录。
切换镜像后，重新运行拉取和启动命令。

默认端口映射为 `127.0.0.1:9002:9002`。
宿主机端口由 `.env` 的 `PANEL_PORT` 指定。
容器内部端口固定为 `9002`。
例如，`PANEL_PORT=19002` 映射为 `127.0.0.1:19002:9002`。
宿主机 Nginx 可连接此端口。
需要直接从外部访问时，配置 `PANEL_BIND_HOST=0.0.0.0`。

Compose 通过 `env_file` 将 `.env` 注入容器。
密钥和域名无需在 Compose 中重复声明。
`environment` 仅固定容器的监听地址、端口和数据目录。
这些固定值会覆盖 `.env` 中的同名变量。
普通 Node 仍使用 `.env` 中的原值。

Compose 将宿主机的 `./data` 挂载到 `/app/data`。
容器内固定使用 `PANEL_DATA_DIR=/app/data`。
实际数据仍在宿主机的以下目录。

```text
/data/platform2api/cnb2api-panel/data/
├── panel.json
└── master.key
```

镜像启动成功后，目录只需保留以下内容。

```text
cnb2api-panel/
├── docker-compose.yaml
├── .env
└── data/
    ├── panel.json
    └── master.key
```

手动更新时，运行 `pull` 和 `up -d`。
更新无需替换 `.env` 和 `data/`。

### 自动更新镜像

默认配置同时启动 Watchtower。
本项目使用仍在维护的 `nickfedor/watchtower` 分支。
Watchtower 每 10 分钟检查一次面板镜像。
镜像标签内容变化后，它拉取镜像并重建面板容器。
更新后，它清理替换下来的旧镜像。
它只更新同一个 Compose 项目内带启用标签的容器。
它不会更新自身。

面板继续使用原来的环境变量和数据挂载。
更新会短暂中断请求，登录会话也会失效。
修改 `.env` 后，仍需运行 `docker compose up -d`。
Watchtower 通过 Docker socket 管理容器。

自动跟随正式版时，保持以下镜像配置。

```dotenv
PANEL_IMAGE=docker.cnb.cool/azurekiln/cnb2api-panel:latest
WATCHTOWER_POLL_INTERVAL=600
```

检查间隔以秒为单位。
固定版本标签不会自动切换到另一个版本标签。
代码推送后，发布新正式版才会更新 `latest`。

查看自动更新日志。

```bash
docker compose logs --tail=100 watchtower
```

暂停自动更新。

```bash
docker compose stop watchtower
```

重新运行 `docker compose up -d` 可恢复自动更新。

### 迁移 Compose 文件名

`compose.yaml` 是 Docker 当前推荐的文件名。
`docker-compose.yaml` 是兼容名称。
本项目统一使用后者。
两种文件名都使用 `docker compose` 命令。

已有部署下载新配置后，删除旧的 `compose.yaml`。
如果保留两份，Compose 会优先读取 `compose.yaml`。
若旧的 `compose.override.yaml` 只用于 Watchtower，也请删除。
其他自定义覆盖配置应先合并。
本地构建用户同时替换旧的 `compose.build.yaml`。
保留原 `.env` 和 `data/`。
然后启动更新后的配置。

```bash
docker compose up -d --pull always
docker compose logs --tail=100 watchtower
```

### 从源码或发布包构建镜像

本地构建需要保留源码或完整发布包。
源码中的前端由 Docker 构建。
发布包自带前端构建结果。

使用发布包时，先上传到服务器。
同时上传对应的 `.sha256` 文件。
检查通过后再解压。

```bash
cd /tmp
sha256sum -c cnb2api-panel-v1.0.0-20261025.tar.gz.sha256
mkdir -p /data/platform2api
tar -xzf /tmp/cnb2api-panel-v1.0.0-20261025.tar.gz -C /data/platform2api
```

添加本地构建配置后启动。

```bash
cd /data/platform2api/cnb2api-panel
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build
```

此命令使用本地镜像 `cnb2api-panel:local`。
本地构建不能删除源码或 `Dockerfile`。
本地构建配置默认关闭 Watchtower 和面板自动更新。

### 普通 Node

后端需要 Node.js 26.12.1 或更高版本。
项目通过 `.node-version` 固定构建版本。
Docker 构建与 CI 使用同一版本。
后端没有第三方运行依赖。
发布包自带 `web/dist`，无需安装前端依赖。

进入项目目录，复制 `.env.example` 为 `.env`。
填写两个密钥和域名。
配置本机监听地址及数据目录。

```dotenv
PANEL_HOST=127.0.0.1
PANEL_PORT=9002
PANEL_DATA_DIR=/data/platform2api/cnb2api-panel/data
```

`PANEL_DATA_DIR=./data` 也可使用。
相对路径以进程的工作目录为准。
在项目根目录启动后端。

```bash
npm start
```

此命令自动读取项目根目录的 `.env`。
也可直接用 Node 启动。

```bash
node --env-file-if-exists=.env src/server.mjs
```

源码部署需先构建前端。

```bash
npm ci --prefix web
npm run build
npm start
```

生产环境请用进程管理器保持服务运行。
同一个数据目录只能运行一个面板进程。

## 域名与 Nginx

管理、注册回调和 AI API 可共用一个 HTTPS 域名。
例如，统一使用 `https://ai.example.com`。
将这个域名填入 `PANEL_PUBLIC_URL`。
该值只填写域名，不附带路径。

根目录的 `nginx.conf` 提供完整模板。
替换域名和证书路径后使用。
核心代理配置如下。

```nginx
client_max_body_size 4m;

location / {
    proxy_pass http://127.0.0.1:9002;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_intercept_errors off;
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 1800s;
    proxy_send_timeout 1800s;
}
```

旧的精确匹配规则可能优先处理注册请求。
检查 `/register` 和 `/ops/register` 的旧规则。
将这些入口的上游也指向面板的 `9002` 端口。
也可删除旧规则，统一交给 `location /`。

配置完成后，打开域名访问管理面板。
使用 `PANEL_ADMIN_KEY` 登录。
客户端填写 API 基址 `https://ai.example.com/v1`。
客户端密钥填写 `GATEWAY_KEY`。

## SSO 登录

面板支持标准 OIDC 授权码登录。
已适配 `azurekiln-oauth2` 的接口协议。
面板使用 S256 PKCE 和 RS256 签名验证。
SSO 登录只控制管理面板入口。
客户端调用 API 仍使用 `GATEWAY_KEY`。

先在 SSO 管理后台生成机密客户端。
将以下地址登记为回调地址。
把示例域名替换为面板域名。

```text
https://ai.example.com/api/auth/oidc/callback
```

在面板的“接入配置”中填写 SSO 参数。

| 配置项 | 填写内容 |
| --- | --- |
| Issuer | SSO 的公开根地址，如 `https://login.example.com` |
| Client ID | SSO 后台生成的客户端 ID |
| Client Secret | SSO 后台签发的客户端密钥 |
| Scope | `openid profile email` |
| 管理员 Subject | 允许管理面板的 SSO 用户 ID |
| 管理员邮箱 | 可替代 Subject，要求邮箱已验证 |

至少填写一种管理员白名单。
仅白名单中的身份可登录管理面板。
`azurekiln-oauth2` 的 Subject 对应用户 ID。
生产客户端密钥应满足 SSO 的长度要求。
该 SSO 当前要求至少 32 字节。

保存后，登录页显示 SSO 按钮。
右上角头像菜单显示当前身份。
先成功通过 SSO 登录，再关闭普通 Key 登录。
关闭后，登录页隐藏管理密钥表单。
后端也会拒绝新的 Key 登录请求。
关闭 Key 登录不会改变 API 的网关密钥。

面板将 SSO 配置保存到 `data/panel.json`。
`.env` 无需重复填写 SSO 参数。
已有部署可删除 `.env` 中的 SSO 变量。
删除这些变量不会关闭已保存的 SSO。

首次部署也可通过 `.env` 初始化 SSO。
以下配置仅用于尚未配置 SSO 的面板。

```dotenv
PANEL_SSO_ENABLED=true
PANEL_KEY_LOGIN_ENABLED=true
PANEL_OIDC_ISSUER=https://login.example.com
PANEL_OIDC_CLIENT_ID=replace-with-client-id
PANEL_OIDC_CLIENT_SECRET=replace-with-client-secret
PANEL_OIDC_SCOPES=openid profile email
PANEL_OIDC_PROVIDER_NAME=SSO
PANEL_OIDC_ALLOWED_SUBJECTS=replace-with-admin-user-id
PANEL_OIDC_ALLOWED_EMAILS=
```

面板保存的 SSO 配置优先于初始环境变量。
`PANEL_PUBLIC_URL` 应填写面板的公开 HTTPS 地址。
SSO 客户端密钥使用现有 `master.key` 加密保存。
Client Secret 不会通过配置接口返回浏览器。
编辑时留空会保留已保存的客户端密钥。

## 密钥和账号接入

### 两个系统密钥

| 配置项 | 用途 | 保存位置 |
| --- | --- | --- |
| `PANEL_ADMIN_KEY` | 登录管理面板 | `.env` 或进程环境变量 |
| `GATEWAY_KEY` | 客户端调用统一 API | `.env` 或进程环境变量 |

### 每个账号的三个凭据

| 凭据 | 用途 | 是否必填 |
| --- | --- | --- |
| `PROXY_KEY` | 面板访问 CNB 工作区代理 | 必填，与工作区一致 |
| `REG_TOKEN` | 地址注册时识别账号 | 页面要求填写或随机生成 |
| CNB 个人令牌 | 查询 Credits、唤醒工作区 | 按需填写 |

仓库路径不影响地址注册和 API 路由。
查询 Credits 或唤醒工作区时，需要仓库路径。
Credits 查询和工作区唤醒需要各自的 CNB 权限。
工作区的临时 `CNB_TOKEN` 继续由 CNB 流水线提供。

先在面板添加一次账号。
填写工作区的 `PROXY_KEY`。
填写原来的 `REG_TOKEN`，或点击“随机生成”。
每个账号必须使用不同的 `REG_TOKEN`。
工作区地址可先留空，等待注册回调更新。
也可手动填写地址。

未知的 `REG_TOKEN` 会收到 `403`。
注册回调不会自动添加未知账号。

### CNB 工作区注册

CNB 端仍使用原 cnb2api 的 `.cnb.yml` 和启动脚本。
面板不会替你修改 CNB 仓库。
把以下变量填入实际导入的 `proxy.yml`。
示例按本项目的平铺变量文件格式编写。

```yaml
PROXY_KEY: "replace-with-worker-key"
REGISTER_URL: "https://ai.example.com/ops/register/replace-with-account-id"
REG_TOKEN: "replace-with-registration-token"
FIXED: ""
```

所有示例值均需替换。
账号 ID 和注册配置可从面板复制。

原 `.cnb.yml` 可通过共享导入配置读取变量。
下面只示意导入位置。
请使用自己的变量文件地址。

```yaml
.proxy-imports: &proxy-imports
  - https://cnb.cool/replace-org/replace-repo/-/blob/main/replace-path/proxy.yml

main:
  "crontab: */5 * * * *":
    - name: keepalive
      imports: *proxy-imports
      # 保留原来的其余流水线配置。

$:
  vscode:
    - imports: *proxy-imports
      # 保留原来的其余工作区配置。
```

共享变量应供两段流水线复用。
检查内联 `env`，避免它覆盖导入的同名变量。

已有工作区可保留原 `REGISTER_URL` 和 `REG_TOKEN`。
先将原注册密钥填入面板的对应账号。
再将原注册地址转发到面板。
面板兼容 `/register` 和 `/ops/register`。
指定账号时也可使用 `/ops/register/<account-id>`。

号池部署应将旧 `FIXED` 留空。
不要将它指向全局号池的 `/health`。
其他账号健康时，全局探活无法识别当前工作区离线。
CNB 自身的定时保活仍可使用。

VPS 上的旧 Python 注册服务不再是面板依赖。
完成注册和 API 验收后，可停用旧注册服务。
旧动态 Nginx 上游也不再负责面板路由。

### 查看和替换凭据

编辑账号时，三个凭据均支持显示、隐藏和复制。
点击查看时，面板才通过登录会话读取凭据。
只查看再保存不会轮换凭据。
编辑时留空会保留原来的代理密钥和注册密钥。
明确替换 `REG_TOKEN` 后，原值立即失效。
同步更新 CNB 变量文件中的值。

## Token、Credits 与工作区用量

运行概览顶部始终显示 Token 和 Credits 卡片。
没有账号时也保留空态卡片。

| 数据 | 来源 | 含义 |
| --- | --- | --- |
| 本地 Token | 经过网关的 JSON 或 SSE `usage` | 输入、输出、缓存读取和缓存写入 |
| 工作区用量 | 工作区代理的 `/usage` | 与本地用量比较 |
| Credits | CNB 组织接口 | 组织额度快照 |

### 本地 Token

面板提供今日和累计统计。
输入与输出相加得到总 Token。
缓存 Token 属于输入，不能重复加到总数。
面板不会估算历史请求的用量。
缺少 `usage` 或数据不完整时，页面会标明。
直接访问工作区的请求不计入本地统计。
`/v1/messages/count_tokens` 不计入消耗。

### 工作区用量比较

面板使用账号的 `PROXY_KEY` 查询 `/usage`。
首次同步确定比较起点。
工作区重启或计数重置后，面板重新确定起点。
地址或代理密钥变化也会重置起点。
差值等于工作区用量减去同期本地用量。
直接请求、未结束请求或缺失用量可能产生差值。
工作区数据不会覆盖本地累计统计。

### Credits 与页面刷新

后端每 60 秒同步组织 Credits。
同一组织的账号共用一次查询结果。
同步独立于浏览器和工作区健康状态。
查询失败时保留上次成功的快照。
页面显示错误和下次重试时间。
失败退避最长为 15 分钟。

登录后，可见页面每 15 秒刷新。
回到页面、恢复网络或切换页面时会补刷。
页面刷新时间与 Credits 成功查询时间分别显示。
刷新页面不会强制绕过后端同步周期。

## 探活与唤醒

自动唤醒默认关闭。
自动唤醒需要仓库路径和有权限的 CNB 个人令牌。
手动唤醒失败后，可立即重试。
同一账号的并发唤醒请求会合并。
自动唤醒成功后，间隔至少 30 分钟。
这是面板策略，不代表 CNB 的接口限制。

探活失败后，面板按指数退避延长冷却。
页面显示冷却原因和结束时间。
冷却结束后，面板按探活周期重试。

至少有一个可路由账号时，`/health` 返回 `200`。
否则返回 `503` 和 `degraded` 状态。
空号池也会返回 `503`。
这不表示面板进程停止运行。
Docker 健康检查使用管理页面的可访问状态。

## 数据位置与加密边界

默认数据目录是 `./data`。
普通 Node 可用 `PANEL_DATA_DIR` 指定其他目录。
Docker 使用 Compose 的宿主机 `./data` 挂载。
数据无需放在 `/var/lib`。

| 文件 | 内容 | 加密情况 |
| --- | --- | --- |
| `data/panel.json` | 账号、配置、事件、用量 | 账号凭据和 SSO 客户端密钥加密 |
| `data/master.key` | 解密账号凭据的本地密钥 | 原始密钥文件 |
| `.env` | 两个系统密钥及启动配置 | 明文配置 |

`PROXY_KEY`、`REG_TOKEN` 和 CNB 个人令牌使用 AES-256-GCM。
SSO 客户端密钥也使用 AES-256-GCM。
账号名称、仓库、工作区地址和配置仍为明文。
事件和用量统计也为明文。
整个 JSON 文件没有加密。

同时取得 `panel.json` 和 `master.key` 即可解密凭据。
丢失 `master.key` 后，原有凭据无法恢复。
Linux 首次生成的数据目录权限为 `0700`。
首次生成的数据文件和密钥权限为 `0600`。
已有目录权限需自行管理。

面板保留最近 1,000 条事件和 30 天小时统计。
累计 Token 单独保存，不随这些记录清理而减少。
请求日志记录首条用户消息，最多 4,000 个字符。
消息过长时，面板标记截断。
图片、音频和文件只保留类型占位。
消息摘要与事件明文保存在 `panel.json`。
更新前的日志没有消息摘要，无法补回。
请求日志不保存系统消息、工具正文和回复正文。
请求详情还包含上游地址、收发大小与首字节耗时。
登录会话只保存在内存中。
重启后需要重新登录。

面板通过临时文件和原子替换写入数据。
此文件方案用于单进程部署。
多个面板进程不能共享同一数据目录。

### 备份、迁移与更新

备份前先停止面板写入。
一起备份以下三个文件。

```text
.env
data/panel.json
data/master.key
```

建议备份 `.env` 和整个 `data/`。
备份应按密钥文件管理访问权限。
只复制 `panel.json` 不足以恢复账号凭据。

迁移旧面板时，先停止原面板进程。
找到原进程实际使用的 `PANEL_DATA_DIR`。
将整个数据目录复制到新项目的 `data/`。
保留原 `.env` 中的两个密钥和域名。
普通 Node 需同步修改绝对数据路径。
Docker 继续使用 `/app/data` 容器路径。

使用远程镜像时，保留 `docker-compose.yaml`、`.env` 和 `data/`。
拉取镜像后，更新容器。

```bash
docker compose pull
docker compose up -d
```

本地构建时，替换程序文件。
解压发布包时，务必覆盖隐藏文件 `.dockerignore`。
发布包会排除残留的旧前端源码。
Docker 直接使用包内的 `web/dist`。

```bash
docker compose -f docker-compose.yaml -f docker-compose.build.yaml up -d --build
```

普通 Node 更新后重新运行 `npm start`。

更新后仍显示旧界面时，先检查本机返回的资源名。

```bash
curl -fsS http://127.0.0.1:9002/ | grep '/assets/index-'
```

远程镜像仍旧时，检查 `PANEL_IMAGE` 和拉取结果。
本地构建仍旧时，检查解压路径和 `.dockerignore`。
同时检查自定义 Compose 的镜像和挂载目录。
本机已更新而域名未更新时，检查 CDN 和反向代理缓存。

## 本地开发与发布包

项目结构如下。

```text
cnb2api-panel/
├── src/
│   ├── server.mjs
│   ├── app.mjs
│   ├── pool.mjs
│   ├── store.mjs
│   ├── token-usage.mjs
│   ├── worker-usage.mjs
│   └── quota.mjs
├── web/                 # Vue 源码，构建结果位于 web/dist
├── test/
├── scripts/package.mjs
├── Dockerfile
├── docker-compose.yaml
├── docker-compose.build.yaml
├── .env.example
└── nginx.conf
```

先安装前端依赖。

```bash
npm ci --prefix web
```

在一个终端启动后端。

```bash
npm start
```

在另一个终端启动前端。

```bash
npm run dev
```

开发页面默认位于 `http://127.0.0.1:5173`。
前端将 `/api` 请求转发到本机 `9002` 端口。

以下命令均在项目根目录运行。

| 命令 | 用途 |
| --- | --- |
| `npm start` | 启动后端 |
| `npm run dev` | 启动前端开发服务器 |
| `npm run build` | 检查类型并构建前端 |
| `npm test` | 运行后端测试 |
| `npm run test:e2e` | 运行浏览器测试 |
| `npm run package` | 构建前端并导出发布包 |

浏览器测试需要 Playwright Chromium。

```bash
cd web
npx playwright install chromium
cd ..
npm run build
npm run test:e2e
```

导出发布包。

```bash
npm run package
```

包名包含版本号和 UTC 构建日期。
通用格式如下。

```text
cnb2api-panel-v<版本>-<UTC年月日>.tar.gz
```

版本号来自根目录的 `package.json`。
例如，`1.0.0` 在 UTC 2026-10-25 构建时产生以下文件。

```text
dist/
├── cnb2api-panel-v1.0.0-20261025.tar.gz
├── cnb2api-panel-v1.0.0-20261025.tar.gz.sha256
└── build-manifest.json
```

`.sha256` 文件记录发布包的 SHA-256 值。
`build-manifest.json` 记录版本、时间和 SHA-256 值。
发布包包含后端和 `web/dist`。
发布包不包含真实 `.env`、`data/` 和前端依赖。
服务器解压后可选择 Docker 或普通 Node 启动。

### GitHub 与 CNB 自动构建

GitHub 使用 `.github/workflows/build-and-release.yml`。
push 和 PR 均触发测试与构建。
验证包括后端测试、浏览器测试和前端构建。
验证成功后，工作流上传发布包和 `.sha256` 文件。
从本次运行的 Artifacts 下载构建产物。

CNB 使用根目录的 `.cnb.yml`。
`main` 的 push 和 PR 运行相同验证。
`main` 的 push 还会上传构建附件。
从本次构建的附件下载发布包和 `.sha256` 文件。
这里的 CNB 流水线只负责面板构建。
工作区代理仍使用 cnb2api 仓库的配置。

标签 `v*` 触发两端的 Release 工作流。
标签必须与 `package.json` 的版本一致。
例如，版本 `1.0.0` 对应标签 `v1.0.0`。
版本检查和测试通过后，两端发布 Release。
Release 包含发布包和 `.sha256` 文件。
只推送 `main` 不会发布 Release。

版本标签还会触发两端的镜像发布。
正式版镜像同时更新版本标签和 `latest`。
预发布镜像只更新版本标签。
CNB 镜像使用以下地址。

```text
docker.cnb.cool/azurekiln/cnb2api-panel:v1.0.1
```

GitHub 镜像发布到 GHCR。

```text
ghcr.io/azurekiln2333/cnb2api-panel:v1.0.1
```

代码更新后，发布新版本标签才会更新镜像。

### 同步两个远程与发布版本

GitHub 远程名为 `origin`。
首次同步前，添加 CNB 远程。

```bash
git remote add cnb https://cnb.cool/azurekiln/cnb2api-panel.git
```

提交代码后，分别推送两个远程。

```bash
git push origin main
git push cnb main
```

发布前，更新 `package.json` 中的版本号。
提交修改。
再将 `main` 推送到两个远程。
版本 `1.0.0` 使用以下标签。

```bash
git tag v1.0.0
git push origin v1.0.0
git push cnb v1.0.0
```

两端接收标签后各自构建并发布。

## 许可证

本项目采用 `AGPL-3.0-only`。
完整条款见 [LICENSE](LICENSE)。
分发本项目或修改版时，须遵守许可证。
修改版提供网络交互服务时，须向用户提供对应源码。
对应源码应包含构建、安装和运行所需的材料。
未分发且未提供网络交互的私用修改无需公开。
仅调用网关 API 的独立项目无需因此开源。
字体和图标保留各自的第三方许可证。

## 排查问题

### 工作区没有出现在账号池

检查面板是否先添加了对应账号。
检查两端的 `REG_TOKEN` 是否一致。
检查 `REGISTER_URL` 是否转发到面板。
确认每个账号使用不同的注册密钥。
已有账号才会接收注册回调。

### 工作区唤醒失败

CNB 上游调用失败时，面板返回 `424` JSON。
响应包含脱敏后的上游状态和错误信息。
在“请求与事件”中查看唤醒结果。
同时检查个人令牌、仓库路径和唤醒权限。
`/health` 成功不能证明唤醒操作成功。

### 收到 HTML 502

Nginx 或 Cloudflare 也可能返回 HTML `502`。
仅凭此响应无法判断 CNB 是否收到请求。
点击“诊断详情”查看实际错误。
使用“复制诊断”保留排查信息。
诊断包括路径、HTTP 状态、时间和请求标识。
页面不会运行上游 HTML 内容。

先检查本机面板。

```bash
curl -i http://127.0.0.1:9002/health
docker compose logs --tail=100 panel
```

返回 JSON `503` 且 `ready=0` 时，检查账号池。
继续检查 Nginx 错误日志和实际代理端口。
保留 `proxy_intercept_errors off` 以传递面板 JSON。

### Credits 未变化

查看 Credits 上次成功查询时间。
查看同步错误和下次重试时间。
页面的 15 秒刷新不等于重新查询 CNB。
后端按组织同步，并对失败查询退避重试。
