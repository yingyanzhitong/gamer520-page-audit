# Gamer520 热度榜采集器

使用 Playwright + Chromium 每天采集 Gamer520 PC PLAY 热度榜前 50 页，并将标题、游戏简介、封面、来源更新时间、下载链接、提取码及解压密码保存到 SQLite。管理后台由 React、Tailwind CSS 与 shadcn-ui 风格组件构建，分为看板、任务、商品配置、游戏数据和 API Key 管理五个模块。看板顶部固定展示总游戏数据、有效游戏数据、已同步素材库数据和已发布数据。

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
| `XIANYU_API_KEY` | 无 | 首次启动时导入的闲鱼用户 API Key；之后可在后台验证并更新，页面只脱敏展示 |
| `GAMER520_READ_API_KEY` | 无 | 首次启动时导入为“默认下载 Key”；之后可在后台新增或删除多个 Gamer520 Key |
| `PUBLIC_BASE_URL` | `https://gamer520.xyyamsz.cn` | 闲鱼服务读取 Gamer520 稳定封面的公开地址 |
| `COVER_CACHE_DIR` | `/app/data/covers` | 发布封面 JPEG 缓存目录 |
| `COVER_CACHE_ENABLED` | `true` | 发布前是否下载、校验并缓存封面 |
| `SYNC_CRON_SCHEDULE` | `0 */6 * * *` | 闲鱼自动同步 Cron 表达式 |
| `SYNC_POLL_INTERVAL_MS` | `10000` | 批量发布状态查询间隔，允许 1–60 秒 |
| `SYNC_BATCH_TIMEOUT_MS` | `7200000` | 单个批量发布任务最长等待时间，默认 2 小时 |
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
- `task_operation_logs`：按采集或同步任务保存逐步操作、结果和结构化详情。
- `xianyu_sync_settings`：保留旧版本的全局默认配置和默认发布账号；`xianyu_account_settings`：按闲鱼账号保存售价、模板及可发布参数。
- `service_credentials`：保存后台验证通过的闲鱼服务 API Key。
- `download_api_keys`：明文保存可独立新增和撤销的 Gamer520 下载接口 Key。
- `scheduler_settings`：持久化采集任务，以及按账号保存的同步任务 Cron、启用状态、同步范围、排序和并发参数。
- `xianyu_account_material_sync`：按游戏和发布账号保存素材 ID、已同步哈希和错误；同一游戏可为多个账号各建一份素材。
- `xianyu_publications`：按游戏和账号保存发布状态、闲鱼商品 ID、链接及卡券关联结果。
- `xianyu_sync_runs`：保存每轮同步的逐商品进度、当前商品、素材、发布及卡券关联计数。

网页游戏详情只展示游戏凭证、图片链接、下载源和资源详情页。独立的 `/api/download-sources` 对外接口使用后台 API Key 管理页中的 Gamer520 Key；调用方通过请求头 `X-API-Key` 传入，后台登录 Cookie 不能替代该 Key。账号配置、价格、调度和任务控制可使用管理员登录会话；为兼容外部调用，也继续接受当前保存的闲鱼用户 API Key。闲鱼 Key 在页面只脱敏展示，Gamer520 Key 按要求明文展示并支持新增、复制和删除；密钥管理接口只接受管理员登录会话。

同一 ID 再次采集时，先批量调用 Gamer520 WordPress 接口的 `modified_gmt` 来源更新时间（每次最多 100 个文章 ID）；修改时间不晚于本地最后成功采集时间时直接跳过，不创建文章页。接口临时不可用时才回退读取文章页 `time[datetime]`，并在 `DOMContentLoaded` 后先判定，不再为跳过项等待整页 `load`。来源时间变化后才原子覆盖 `games` 的完整详情并整体替换 `downloads`。失败时不会用空值覆盖旧成功数据，只更新失败状态和错误。移出热度前 50 页的历史记录不会删除。

游戏列表的采集状态包含“成功、已更新、缺失、失败、违规”；缺少图片或下载资源、或图片链接无法访问时记为“缺失”。“违规”仅能由后台手动标记或手动恢复为成功，用于闲鱼认定违规的商品；采集任务不会自动改写该状态，且违规游戏不会进入任何发布候选列表。仅采集成功的游戏可单独同步。第一列只展示游戏标题和热度，不再显示有效性备注。游戏数据页可选择发布状态账号，列表的闲鱼状态筛选和详情均以所选账号为展示口径，基础状态分为“无、加入素材库、发布中、发布成功”；“可发布”筛选严格对应“全部待处理商品”的同步候选，包含可重试的发布失败项，两个筛选条件可以组合使用。

## 闲鱼同步与接口

商品配置页按发布账号保存默认售价、标题/简介/图片模板及发布参数；选择账号后会用 `xianyu-auto-reply` 的账号能力接口识别鱼小铺或普通账号。批量发布统一调用 `xianyu-auto-reply` 的 `/api/v1/product-publish/publish/batch`，由其按每个账号自动选择对应发布器。普通账号可配置原价、业务分类、成色、配送和运费方式、固定邮费、所在地、所在地期望文本、品牌、平台属性和是否支持自提，素材始终按单件发布且不会传库存、规格或 SKU；鱼小铺额外可配置库存、规格和 SKU，运费方式仅可选包邮或无需物流。每次素材同步还会用当前账号调用分类推荐接口，并写入完整的平台分类 ID、路径和频道信息，避免因缺少平台商品分类而被拒绝。任务页为每个发布账号维护一条独立的定时同步任务，各账号可以分别设置启用状态、Cron、同步范围、排序、素材并行数、批量发布数量和发布成功上限；同时触发的账号任务会进入队列依次执行。配置或游戏内容变更只会使对应账号的素材待更新，不会重新上架已发布商品。闲鱼 API Key 在独立的密钥管理页输入，服务端验证后保存，浏览器刷新时只接收脱敏值。模板支持 `{id}`、`{title}`、`{description}`、`{image_url}`、`{cloud_drives}`、`{price}`、`{resource_code}`、`{archive_password}` 和 `{detail_page_url}`；默认标题为 `【秒发】{title}`，默认图片为 `{image_url}`。页面使用数据库内真实有效游戏和同源缓存图片实时预览渲染结果。

手动同步可对当前选择的账号执行 `all`（除发布成功外的全部待处理商品）、`pending`（未发布且未发布失败的商品）或 `updated`（新增或已更新，且仍需同步素材或发布的商品）；每个账号的定时任务也会独立保存其中一种范围。游戏数据页的“查询发布状态”只会刷新所选账号的商品列表，优先以已有商品 ID 精确核对；本地没有商品 ID 时，使用当前账号的标题模板生成名称进行唯一精确匹配（忽略空白与全半角差异），核对成功即保存商品 ID 并标记为发布成功。未匹配或同名多个商品的发布中记录会清除未核验商品 ID 并回退为加入素材库。同步数据池与看板“有效游戏数据”复用同一条件：标题、简介、有效 `http/https` 图片链接及至少一个有效 `http/https` 下载地址完整；没有下载记录、空地址、非网页协议资源或缺少图片的记录会在任务创建前过滤。素材导入和商品发布是两条独立异步流水线：素材导入并行数可在任务页面配置为 `1–12`，发布线程发现已有可发布素材后立即提交批量发布，不等待队列凑满；每批发布商品数可在页面配置为 `1–20`，单批实际数量取当前已就绪数量与配置上限的较小值，批次之间仍按顺序确认结果。页面分别展示素材和发布的分段进度：本轮成功为绿色、已有数据跳过为黄色、失败为红色，并以本轮有效游戏总量为分母。已有闲鱼商品编号或已有发布编号的游戏在候选阶段直接跳过；已有本地素材编号且内容未变化的游戏只跳过素材上传，并复用该素材进入发布线程；内容哈希变化时仍会更新素材库。远程素材通过“账号 ID:游戏 ID”作为外部来源标识；不同账号、或同账号内同名的游戏均不会因标题相同而误复用素材。封面从模板结果下载，经过重试、图片解码和 JPEG 标准化后保存到持久卷。批次状态默认每 10 秒查询，状态变化或持续等待满 1 分钟时写入日志；明确失败会跳过当前批并继续下一批，结果未知则停止后续批次以避免重复发布。发布成功后会按当前账号商品配置中选择的 `xianyu-auto-reply` 卡券关联商品；选择“不绑定卡券”时不自动关联。商品编号和链接会写回对应 `games` 记录；卡券关联失败只重试关联，不会重复发布商品。

每次同步任务都会在候选筛选前分页查询 `xianyu-auto-reply` 的素材库，并刷新当前发布账号的商品管理列表：远端素材已删除时将本地素材状态回退为待导入；远端商品已删除时清除本地商品编号并回退为待发布；远端仍存在时则写回素材或发布状态。

采集和同步任务会把账号校验、网络读取、跳过判定、详情保存、封面缓存、素材写入、批次提交、状态轮询、结果回写和卡券关联等步骤写入持久化日志。看板当前任务和任务记录均可打开详细日志弹窗；运行中的日志每 2 秒自动追加，历史任务也可随时回看。旧版本已经结束的任务不会补写详细操作日志。

```bash
# 获取可选账号
curl -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/xianyu/accounts

# 保存某个账号的独立发布配置（可为多个 account_id 分别调用）
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"account_id":"账号ID","default_price":1,"default_stock":999,"title_template":"【秒发】{title}","description_template":"{description}\n\n支持网盘：{cloud_drives}","image_template":"{image_url}","publish_options":{"shippingMethod":"free","address":"上海市","fish":{"quantity":999,"specifications":[],"skuRows":[]}}}' \
  http://127.0.0.1:13520/api/settings/xianyu

# 保存采集和同步调度
curl -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"cron_timezone":"Asia/Shanghai","crawl":{"cron_schedule":"0 3 * * *","enabled":true,"concurrency":3},"sync":{"cron_schedule":"0 */6 * * *","enabled":true,"mode":"all","account_ids":["账号A","账号B"],"material_concurrency":4,"publish_batch_size":8}}' \
  http://127.0.0.1:13520/api/settings/schedule

# 立即完整采集
curl -X POST \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/crawl/run

# 启动同步；mode 可选 all、pending、updated、selected-force。
# selected-force 需先通过定时配置的 sync.selected_game_ids 选择游戏；每次执行均以闲鱼实际商品列表为准，商品仍存在时不重复发布。
curl -X POST \
  -H 'Content-Type: application/json' \
  -H 'X-API-Key: <闲鱼用户API Key>' \
  -d '{"mode":"all"}' \
  http://127.0.0.1:13520/api/sync/run

# 立即暂停、恢复或真正终止当前采集任务；同步任务把 crawl 改为 sync
curl -X POST -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/tasks/crawl/pause
curl -X POST -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/tasks/crawl/resume
curl -X POST -H 'X-API-Key: <闲鱼用户API Key>' \
  http://127.0.0.1:13520/api/tasks/crawl/terminate

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

`pause` 后可以使用 `resume` 继续；`terminate` 会取消当前请求、关闭采集浏览器并等待任务真正退出，终止后的任务不能恢复。终止当前任务不会修改定时任务的启用状态，后续 Cron 仍按页面配置运行。

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
