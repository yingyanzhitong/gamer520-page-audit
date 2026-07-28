# Gamer520 热度榜采集器

使用 Playwright + Chromium 每天采集 Gamer520 PC PLAY 热度榜前 100 页，并将标题、游戏简介、封面、来源更新时间、下载链接、提取码及解压密码保存到 SQLite。管理界面可查看采集状态、选择闲鱼发布账号、全量同步素材与查看发布结果。

## Docker Compose 部署

要求服务器已安装 Docker Engine 和 Docker Compose 插件。项目固定使用 Playwright `1.62.0` 官方 Noble 镜像内置的 Chromium，不需要额外安装 Chrome、Firefox 或 WebKit。

```bash
docker compose up -d --build
docker compose logs -f crawler
```

容器启动后默认立即执行一次，以后按 `Asia/Shanghai` 每天 03:00 执行。管理页面可修改采集和闲鱼同步的 Cron、时区与启用状态，设置写入 SQLite 并立即生效。SQLite 位于容器内 `/app/data/gamer520.sqlite`，由 `gamer520-data` 命名卷持久化。Compose 只应运行一个副本。

管理界面默认只监听宿主机回环地址 `127.0.0.1:13520`，避免把下载链接和密码直接暴露到公网。本机访问：

```text
http://127.0.0.1:13520
```

远程服务器建议使用 SSH 隧道：

```bash
ssh -L 13520:127.0.0.1:13520 ssh.xyyamsz.cn
```

随后在本机浏览器打开 `http://127.0.0.1:13520`。

停止服务不会删除数据：

```bash
docker compose down
```

只有显式执行 `docker compose down -v` 才会删除 SQLite 数据卷。

## 命令

```bash
# 立即完整采集热度前 100 页
npm run crawl:once

# 启动调度器：默认启动即跑，之后每天 03:00 跑
npm run scheduler

# 调试单个页面
npm run audit:playwright -- https://www.gamer520.com/118842.html

# 本地查看浏览器，仅适用于已安装 Chrome 的 macOS 开发机
SHOW_BROWSER=1 npm run audit:playwright -- https://www.gamer520.com/118842.html
```

在 Compose 服务中手动执行一轮：

```bash
docker compose exec crawler npm run crawl:once
```

调度器会阻止同一进程内的任务重叠。容器启动新一轮任务时，会把数据库中未正常结束的旧任务标记为 `interrupted`。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LIST_URL` | `https://www.gamer520.com/pcplay?order=hot` | 固定热度榜入口 |
| `PAGE_COUNT` | `100` | 列表页数量 |
| `DETAIL_CONCURRENCY` | `3` | 独立浏览器 context 并发数 |
| `MAX_RETRIES` | `2` | 单项失败后的最大重试次数 |
| `NAVIGATION_TIMEOUT_MS` | `30000` | 页面导航超时 |
| `LIST_DELAY_MS` | `250` | 列表页间隔 |
| `DETAIL_DELAY_MIN_MS` | `750` | 详情项最小随机延迟 |
| `DETAIL_DELAY_MAX_MS` | `1500` | 详情项最大随机延迟 |
| `ACCESS_BLOCK_THRESHOLD` | `10` | 连续访问限制后的熔断阈值 |
| `CRON_SCHEDULE` | `0 3 * * *` | Cron 表达式 |
| `CRON_TIMEZONE` | `Asia/Shanghai` | 调度时区 |
| `RUN_ON_START` | `true` | 启动时是否立即采集 |
| `CRAWL_ENABLED` | `true` | 首次启动时是否启用定时采集；之后以网页保存的设置为准 |
| `DB_PATH` | `/app/data/gamer520.sqlite` | 容器内数据库路径 |
| `DASHBOARD_HOST` | `0.0.0.0` | 容器内管理界面监听地址 |
| `DASHBOARD_PORT` | `3000` | 容器内管理界面端口 |
| `DASHBOARD_HOST_PORT` | `13520` | Compose 映射到宿主机回环地址的端口 |
| `XIANYU_BASE_URL` | `https://xianyu.xyyamsz.cn` | 闲鱼服务地址 |
| `XIANYU_API_KEY` | 无 | 闲鱼用户 API Key；页面账号配置和手动同步也使用此 Key |
| `GAMER520_READ_API_KEY` | 无 | 对外下载源查询接口的只读 API Key |
| `SYNC_CRON_SCHEDULE` | `0 */6 * * *` | 闲鱼自动同步 Cron 表达式 |
| `SYNC_RUN_LIMIT` | `20` | 全量同步的单批处理数，范围 1 到 20 |
| `SYNC_POLL_INTERVAL_MS` | `10000` | 发布批次状态轮询间隔 |
| `SYNC_BATCH_TIMEOUT_MS` | `7200000` | 发布批次最大等待时间 |
| `SYNC_ENABLED` | `true` | 首次启动时是否启用定时闲鱼同步；手动同步不受此开关限制 |

本地运行需要 Node.js 22.5 或更高版本：

```bash
npm ci
PLAYWRIGHT_CHANNEL=chrome PAGE_COUNT=1 npm run crawl:once
```

Linux 容器中正式支持 `PLAYWRIGHT_CHANNEL=chromium`。

## 数据

- `games`：以详情 URL 的数字 ID 为主键，保存文章详情、资源信息、来源更新时间、售价覆盖、热度排名、成功/失败状态和时间。
- `downloads`：保存一个游戏的全部下载源、链接、提取码、二维码地址及解析方式。
- `crawl_runs`：保存每轮采集的计数和最终状态。
- `crawl_errors`：保存列表或详情阶段的错误摘要。
- `xianyu_sync_settings`：持久化当前唯一发布 `account_id` 和默认售卖价格。
- `scheduler_settings`：持久化采集、同步的 Cron、时区和启用状态。
- `xianyu_material_sync`：保存每个游戏的素材 ID、已同步哈希和错误。
- `xianyu_publications`：按游戏和账号保存发布状态、闲鱼商品 ID 与链接。
- `xianyu_sync_runs`：保存每轮同步的素材和发布计数。

网页游戏详情只展示游戏凭证、下载源和资源详情页，不要求输入 Key。独立的 `/api/download-sources` 对外接口仍使用只读 Key；账号配置、价格和调度操作使用闲鱼用户管理生成的 API Key，该 Key 仅保存在当前浏览器会话且不会由服务端返回。

同一 ID 再次采集时，先读取文章页绝对更新时间；已有完整详情且来源时间未变化时跳过资源详情解析。来源时间变化后才原子覆盖 `games` 的完整详情并整体替换 `downloads`。失败时不会用空值覆盖旧成功数据，只更新失败状态和错误。移出热度前 100 页的历史记录不会删除。

## 闲鱼同步与接口

页面先输入闲鱼用户管理生成的 API Key，加载闲鱼账号并保存一个真实 `account_id`；账号与默认售价会持久化到 SQLite，刷新页面和服务重启后仍然保留。页面提交的 Key 必须与服务端 `XIANYU_API_KEY` 一致，确保手动和定时任务使用同一用户权限。每次手动或定时任务会读取全部待处理商品，并按每批最多 20 条执行。新商品会以 `【秒发】原名称`、商品实际售价和数据库 `games.image_url` 唯一封面创建素材并发布；商品介绍在原简介后根据下载源动态追加支持网盘、24 小时自动发货和咨询提示。素材库已有同名商品时跳过；已在当前账号发布过的更新商品只更新素材，不重新上架。

```bash
# 获取可选账号
curl -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/xianyu/accounts

# 保存发布账号
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"account_id":"账号ID","default_price":1}' \
  http://127.0.0.1:13520/api/settings/xianyu

# 保存采集和同步调度
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"cron_timezone":"Asia/Shanghai","crawl":{"cron_schedule":"0 3 * * *","enabled":true},"sync":{"cron_schedule":"0 */6 * * *","enabled":true}}' \
  http://127.0.0.1:13520/api/settings/schedule

# 立即完整采集
curl -X POST \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/crawl/run

# 启动全量同步
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{}' \
  http://127.0.0.1:13520/api/sync/run

# 设置单商品售价；price 传 null 恢复使用默认售价
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"price":6.8}' \
  http://127.0.0.1:13520/api/games/118842/price

# 按名称查询；开头的【秒发】或【秒发 】会自动移除
curl -H 'X-API-Key: <下载只读Key>' \
  --get \
  --data-urlencode 'name=【秒发 】游戏名称' \
  'http://127.0.0.1:13520/api/download-sources'
```

下载源接口的 `id` 和 `name` 必须且只能提供一个。`name` 会先移除开头的 `【秒发】` 或 `【秒发 】` 及相邻空格，再做精确名称匹配。名称重名返回 `409` 和候选 ID；无效 Key 返回 `401`；商品或账号不存在返回 `404`；任务冲突返回 `409`；参数或素材不可发布返回 `422`。

成功响应同时提供顶层资源凭证和完整下载源：

```json
{
  "lookup": {
    "requestedName": "【秒发 】游戏名称",
    "normalizedName": "游戏名称"
  },
  "resourceCode": "资源编号",
  "archivePassword": "解压密码",
  "game": {
    "id": 118842,
    "title": "游戏名称"
  },
  "downloads": [
    {
      "provider": "百度网盘",
      "url": "https://pan.example/example",
      "password": "abcd",
      "extractionCode": "abcd"
    }
  ]
}
```

数据库启用了 WAL、外键和 `busy_timeout`。可直接查询命名卷中的数据库：

```bash
docker compose exec crawler node --input-type=module -e \
  "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync('/app/data/gamer520.sqlite',{readOnly:true}); console.table(db.prepare('SELECT id,title,scrape_status,hot_rank,last_scraped_at FROM games ORDER BY hot_rank LIMIT 20').all())"
```

备份前可先在容器中执行 SQLite 在线备份；也可以在采集任务结束后复制数据库文件：

```bash
docker compose cp crawler:/app/data/gamer520.sqlite ./gamer520.sqlite
```

## 验证

```bash
npm run check
npm test
docker compose config
```

一页 Docker 冒烟测试：

```bash
docker compose run --rm \
  -e PAGE_COUNT=1 \
  -e DETAIL_CONCURRENCY=1 \
  -e MAX_RETRIES=0 \
  crawler npm run crawl:once
```

## 生产服务器部署

`deploy/docker-compose.yml` 仅拉取已经发布的 Docker Hub 镜像，不会在服务器编译源码：

```bash
mkdir -p ~/gamer520
cd ~/gamer520
cp .env.example .env
docker compose pull
docker compose up -d
docker compose ps
```

服务器端管理界面仍只绑定 `127.0.0.1:13520`。更新版本时修改 `.env` 中的 `IMAGE_TAG`，重新执行 `docker compose pull && docker compose up -d`。
