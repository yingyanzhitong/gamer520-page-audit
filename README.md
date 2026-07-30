# Gamer520 热度榜采集器

使用 Playwright + Chromium 每天采集 Gamer520 PC PLAY 热度榜前 50 页，并将标题、游戏简介、封面、来源更新时间、下载链接、提取码及解压密码保存到 SQLite。管理后台由 React、Tailwind CSS 与 shadcn-ui 风格组件构建，分为看板、任务、商品配置、游戏数据和 API Key 管理五个模块。

## Docker Compose 部署

要求服务器已安装 Docker Engine 和 Docker Compose 插件。项目固定使用 Playwright `1.62.0` 官方 Noble 镜像内置的 Chromium，不需要额外安装 Chrome、Firefox 或 WebKit。

```bash
docker compose up -d --build
docker compose logs -f crawler
```

容器启动后默认立即执行一次，以后按 `Asia/Shanghai` 每天 03:00 执行。管理页面可修改采集和闲鱼同步的 Cron、时区与启用状态，设置写入 SQLite 并立即生效。SQLite 位于容器内 `/app/data/gamer520.sqlite`，由 `gamer520-data` 命名卷持久化。Compose 只应运行一个副本。

管理界面默认只监听宿主机回环地址 `127.0.0.1:13520`。生产环境必须配置管理员密码和独立的会话签名密钥，登录成功后才能访问后台数据与操作接口。本机访问：

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
# 立即完整采集热度前 50 页
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
| `PAGE_COUNT` | `50` | 列表页数量，最大为 50 |
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
| `DASHBOARD_ADMIN_USERNAME` | `admin` | 后台管理员账号 |
| `DASHBOARD_ADMIN_PASSWORD` | 无 | 后台管理员密码；生产环境必填 |
| `DASHBOARD_SESSION_SECRET` | 无 | 后台会话 HMAC 签名密钥；生产环境必填并使用高强度随机值 |
| `DASHBOARD_SESSION_TTL_SECONDS` | `43200` | 登录会话有效期，默认 12 小时 |
| `XIANYU_BASE_URL` | `https://xianyu.xyyamsz.cn` | 闲鱼服务地址 |
| `XIANYU_API_KEY` | 无 | 闲鱼用户 API Key；仅由服务端用于账号配置、素材同步和商品发布 |
| `GAMER520_READ_API_KEY` | 无 | 对外下载源查询接口的独立只读 API Key；由部署者设置，不是闲鱼 `xyk_...` Key |
| `PUBLIC_BASE_URL` | `https://gamer520.xyyamsz.cn` | 闲鱼服务读取 Gamer520 稳定封面的公开地址 |
| `COVER_CACHE_DIR` | `/app/data/covers` | 发布封面 JPEG 缓存目录 |
| `COVER_CACHE_ENABLED` | `true` | 发布前是否下载、校验并缓存封面 |
| `SYNC_CRON_SCHEDULE` | `0 */6 * * *` | 闲鱼自动同步 Cron 表达式 |
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

- `games`：以详情 URL 的数字 ID 为主键，保存文章详情、资源信息、来源更新时间、售价覆盖、热度排名、成功/失败状态，以及最近成功发布的闲鱼商品编号、链接、账号和时间。
- `downloads`：保存一个游戏的全部下载源、链接、提取码、二维码地址及解析方式。
- `crawl_runs`：保存每轮采集的计数和最终状态。
- `crawl_errors`：保存列表或详情阶段的错误摘要。
- `xianyu_sync_settings`：持久化当前唯一发布 `account_id`、默认售卖价格以及标题、简介、图片模板。
- `scheduler_settings`：持久化采集、同步的 Cron、时区、启用状态和定时同步范围。
- `xianyu_material_sync`：保存每个游戏的素材 ID、已同步哈希和错误。
- `xianyu_publications`：按游戏和账号保存发布状态、闲鱼商品 ID、链接及卡券关联结果。
- `xianyu_sync_runs`：保存每轮同步的逐商品进度、当前商品、素材、发布及卡券关联计数。

网页游戏详情只展示游戏凭证、下载源和资源详情页。独立的 `/api/download-sources` 对外接口使用 `GAMER520_READ_API_KEY` 对应的只读 Key；调用方通过请求头 `X-API-Key` 传入，后台登录 Cookie 不能替代该 Key。账号配置、价格、调度和任务控制可使用管理员登录会话；为兼容外部调用，也继续接受服务器配置的闲鱼用户 API Key。API Key 管理页按要求明文展示两种服务端 Key，但该接口只接受管理员登录会话，不接受 API Key 自身读取。

同一 ID 再次采集时，先批量调用 Gamer520 WordPress 接口的 `modified_gmt` 来源更新时间（每次最多 100 个文章 ID）；修改时间不晚于本地最后成功采集时间时直接跳过，不创建文章页。接口临时不可用时才回退读取文章页 `time[datetime]`，并在 `DOMContentLoaded` 后先判定，不再为跳过项等待整页 `load`。来源时间变化后才原子覆盖 `games` 的完整详情并整体替换 `downloads`。失败时不会用空值覆盖旧成功数据，只更新失败状态和错误。移出热度前 50 页的历史记录不会删除。

游戏列表的采集状态筛选包含“已更新”，用于查看最近一次内容变更类型为更新的商品；闲鱼状态筛选按页面当前保存的发布账号统一分为“无、加入素材库、发布中、发布成功、更新素材库”，两个筛选条件可以组合使用。

## 闲鱼同步与接口

商品配置页从服务端加载闲鱼账号并保存一个真实 `account_id`；账号、默认售价和商品模板会持久化到 SQLite，刷新页面和服务重启后仍然保留。浏览器不提交或保存闲鱼 API Key。模板支持 `{id}`、`{title}`、`{description}`、`{image_url}`、`{cloud_drives}`、`{price}`、`{resource_code}`、`{archive_password}` 和 `{detail_page_url}`；默认标题为 `【秒发】{title}`，默认图片为 `{image_url}`。页面展示可用占位符并实时预览渲染结果。

手动同步可选择 `all`（全部有效商品）、`pending`（未发布商品）或 `updated`（内容标记为更新且尚无商品/素材记录），定时同步也会保存其中一种范围。同步按每 20 个候选商品循环处理：先以最多 4 个并行请求完成当前组的素材库同步，随后批量发布该组，再继续下一组。页面分别展示“导入素材库进度”和“发布商品进度”。已有闲鱼商品编号、已有本地素材编号或已有发布编号的游戏在候选阶段直接跳过；远程素材库存在同名标题时也跳过，不重复创建或发布。封面在素材同步阶段从模板结果下载，经过重试、图片解码和 JPEG 标准化后保存到持久卷，闲鱼发布器读取 Gamer520 自身的稳定封面地址。每个发布批次前后都会刷新当前账号商品列表，通过新增商品编号和标题前缀核对实际结果；页面未跳转但商品已出现时会纠正为成功。单件发布失败或批次明确返回参数错误时记录失败并跳过，继续处理后续商品；鉴权错误或结果未知时停止，避免无权限重试或重复发布。发布成功后会逐件关联卡券 ID `6`，并把闲鱼商品编号和链接写回对应 `games` 记录；卡券关联失败只重试关联，不会重复发布商品。

采集任务的实时进度与任务记录展示来源更新时间未变化而跳过的数量；同步任务的实时进度、最近任务摘要与任务记录展示素材库同名跳过数量。

```bash
# 获取可选账号
curl -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/xianyu/accounts

# 保存发布账号
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"account_id":"账号ID","default_price":1,"title_template":"【秒发】{title}","description_template":"{description}\n\n支持网盘：{cloud_drives}","image_template":"{image_url}"}' \
  http://127.0.0.1:13520/api/settings/xianyu

# 保存采集和同步调度
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"cron_timezone":"Asia/Shanghai","crawl":{"cron_schedule":"0 3 * * *","enabled":true},"sync":{"cron_schedule":"0 */6 * * *","enabled":true,"mode":"all"}}' \
  http://127.0.0.1:13520/api/settings/schedule

# 立即完整采集
curl -X POST \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/crawl/run

# 启动同步；mode 可选 all、pending、updated
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"mode":"all"}' \
  http://127.0.0.1:13520/api/sync/run

# 中断和恢复当前采集任务；同步任务把 crawl 改为 sync
curl -X POST -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/tasks/crawl/interrupt
curl -X POST -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/tasks/crawl/resume

# 设置单商品售价；price 传 null 恢复使用默认售价
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"price":6.8}' \
  http://127.0.0.1:13520/api/games/118842/price

# 按闲鱼商品标题查询；【秒发】会在匹配前自动移除
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <下载只读Key>' \
  -d '{"item_title":"【秒发】游戏名称"}' \
  'http://127.0.0.1:13520/api/download-sources'

# 按闲鱼商品编号查询
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <下载只读Key>' \
  -d '{"item_id":"1067769058126"}' \
  'http://127.0.0.1:13520/api/download-sources'

# 可以同时提供三个条件；未匹配时按 item_id → item_title → id 逐级回退
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <下载只读Key>' \
  -d '{"item_id":"1067769058126","item_title":"【秒发】游戏名称","id":118842}' \
  'http://127.0.0.1:13520/api/download-sources'
```

下载源接口仅接受 `POST` JSON；旧 `GET` 请求返回 `405`。请求体的 `id`（Gamer520 游戏编号）、`item_id`（闲鱼商品编号）和 `item_title`（闲鱼商品标题）至少提供一个，也可以同时提供。查询按 `item_id → item_title → id` 的优先级执行：当前条件没有匹配结果时才尝试下一个条件。`item_title` 会先移除 `【秒发】`（兼容括号内空格），再做精确名称匹配；旧字段 `name` 已废弃，不再作为查询条件。名称重名返回 `409` 和候选 ID；无效 Key 返回 `401`；商品或账号不存在返回 `404`；任务冲突或当前没有可控制任务返回 `409`；参数或素材不可发布返回 `422`。

成功响应同时提供顶层资源凭证和完整下载源：

```json
{
  "lookup": {
    "strategy": "item_title",
    "requestedItemTitle": "【秒发】游戏名称",
    "normalizedItemTitle": "游戏名称"
  },
  "resourceCode": "资源编号",
  "archivePassword": "解压密码",
  "itemId": "1067769058126",
  "data": "解压密码：解压密码\n百度网盘：https://pan.example/example 提取码：abcd",
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

`data` 是可直接用于自动发货的字符串：第一行固定为
`解压密码：<密码>`，后续每个下载源一行，格式为
`<网盘名称>：<下载地址> 提取码：<提取码>`；没有提取码时省略同行的提取码部分。

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
