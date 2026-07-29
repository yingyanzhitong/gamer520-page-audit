import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { CrawlerDatabase } from "./database.mjs";
import {
  DEFAULT_XIANYU_TEMPLATES,
  validateXianyuTemplates,
} from "./xianyu-templates.mjs";
const publicDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../public",
);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

const xianyuStatusExpression = `
  CASE
    WHEN publication.status IN ('publishing', 'unknown') THEN 'publishing'
    WHEN material.material_id IS NOT NULL
      AND material.status IN ('pending', 'failed')
    THEN 'material_update'
    WHEN publication.status = 'success' THEN 'published'
    WHEN material.material_id IS NOT NULL
      OR material.status IN ('synced', 'skipped')
    THEN 'material'
    ELSE 'none'
  END
`;

function mapRun(row) {
  if (!row) return null;
  return {
    taskType: "crawl",
    id: row.id,
    triggerType: row.trigger_type,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    listPagesSucceeded: row.list_pages_succeeded,
    listPagesFailed: row.list_pages_failed,
    discoveredCount: row.discovered_count,
    detailSucceeded: row.detail_succeeded,
    detailFailed: row.detail_failed,
    detailSkipped: row.detail_skipped,
    errorSummary: row.error_summary,
  };
}

function mapGame(row) {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    title: row.title,
    description: row.description,
    imageUrl: row.image_url,
    resourceCode: row.resource_code,
    detailPageUrl: row.detail_page_url,
    archivePassword: row.archive_password,
    hotPage: row.hot_page,
    hotPosition: row.hot_position,
    hotRank: row.hot_rank,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastScrapedAt: row.last_scraped_at,
    lastAttemptAt: row.last_attempt_at,
    sourceUpdatedAt: row.source_updated_at,
    salePrice: row.sale_price ?? null,
    effectivePrice: Number(
      row.effective_price ?? row.sale_price ?? 1,
    ),
    scrapeStatus: row.scrape_status,
    lastError: row.last_error,
    contentHash: row.content_hash,
    lastChangeType: row.last_change_type,
    lastChangedAt: row.last_changed_at,
    xianyuItemId:
      row.xianyu_item_id ?? row.publication_item_id ?? null,
    xianyuItemUrl:
      row.xianyu_item_url ?? row.publication_item_url ?? null,
    xianyuAccountId: row.xianyu_account_id ?? null,
    xianyuPublishedAt: row.xianyu_published_at ?? null,
    materialSyncStatus: row.material_sync_status ?? "pending",
    publicationStatus: row.publication_status ?? "pending",
    xianyuStatus: row.xianyu_status ?? "none",
    publishedItemId: row.publication_item_id ?? null,
    publishedItemUrl: row.publication_item_url ?? null,
    updatedAt: row.updated_at,
    downloadCount: row.download_count ?? 0,
  };
}

function mapSyncRun(row) {
  return {
    taskType: "sync",
    id: row.id,
    triggerType: row.trigger_type,
    accountId: row.account_id,
    syncMode: row.sync_mode ?? "all",
    requestedLimit: row.requested_limit,
    status: row.status,
    selectedCount: row.selected_count,
    materialCreated: row.material_created,
    materialUpdated: row.material_updated,
    materialUnchanged: row.material_unchanged,
    materialSkipped: row.material_skipped ?? 0,
    materialFailed: row.material_failed ?? 0,
    materialProcessedCount: row.material_processed_count ?? 0,
    publishSelectedCount: row.publish_selected_count ?? 0,
    publishProcessedCount: row.publish_processed_count ?? 0,
    publishSubmitted: row.publish_submitted,
    publishSuccess: row.publish_success,
    publishFailed: row.publish_failed,
    cardBound: row.card_bound ?? 0,
    cardBindFailed: row.card_bind_failed ?? 0,
    batchCount: row.batch_count ?? 0,
    batchId: row.batch_id,
    processedCount: row.processed_count ?? 0,
    currentGameId: row.current_game_id ?? null,
    currentTitle: row.current_title ?? null,
    errorSummary: row.error_summary,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function mapDownload(row) {
  return {
    provider: row.provider,
    url: row.url,
    password: row.password,
    extractionCode: row.extraction_code,
    qrImageUrl: row.qr_image_url,
    decodeMethod: row.decode_method,
  };
}

function normalizeDownloadLookupTitle(value) {
  return String(value ?? "")
    .trim()
    .replace(/【\s*秒发\s*】/gu, "")
    .trim();
}

function buildDownloadData(archivePassword, downloads) {
  return [
    `解压密码：${archivePassword ?? ""}`,
    ...downloads.map((download) => {
      const extractionCode =
        download.extractionCode ?? download.password;
      return `${download.provider}：${download.url}${
        extractionCode ? ` 提取码：${extractionCode}` : ""
      }`;
    }),
  ].join("\n");
}

function integerParameter(value, fallback, min, max) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function salePrice(value, { allowNull = false } = {}) {
  if (allowNull && (value === null || value === "")) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0.01 || parsed > 999_999) {
    const error = new Error("售价必须在 0.01 到 999999 元之间");
    error.statusCode = 422;
    throw error;
  }
  return Math.round(parsed * 100) / 100;
}

function syncMode(value, fallback = "all") {
  const normalized = String(value ?? fallback).trim();
  if (!new Set(["all", "pending", "updated"]).has(normalized)) {
    const error = new Error("同步范围必须是 all、pending 或 updated");
    error.statusCode = 422;
    throw error;
  }
  return normalized;
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function keyMatches(provided, expected) {
  if (!provided || !expected) return false;
  const left = createHash("sha256").update(String(provided)).digest();
  const right = createHash("sha256").update(String(expected)).digest();
  return timingSafeEqual(left, right);
}

function requireKey(request, response, expected, headerName) {
  if (!expected) {
    sendError(response, 503, `${headerName} 尚未在服务器配置`);
    return false;
  }
  const provided = request.headers[headerName.toLowerCase()];
  if (!keyMatches(provided, expected)) {
    sendError(response, 401, "API Key 无效");
    return false;
  }
  return true;
}

async function readJsonBody(request, maximumBytes = 64 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximumBytes) {
      const error = new Error("请求体过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("请求体不是有效 JSON");
    error.statusCode = 422;
    throw error;
  }
}

function withDatabase(databasePath, callback) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 5000;");
    return callback(database);
  } finally {
    database.close();
  }
}

function dashboardPayload(database, config, runtimeState) {
  const currentRun = database
    .prepare(
      "SELECT * FROM crawl_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1",
    )
    .get();
  const latestRun = database
    .prepare("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT 1")
    .get();
  const totals = database
    .prepare(`
      SELECT
        COUNT(*) AS games,
        SUM(CASE WHEN scrape_status = 'success' THEN 1 ELSE 0 END) AS successful_games,
        SUM(CASE WHEN scrape_status = 'failed' THEN 1 ELSE 0 END) AS failed_games,
        SUM(CASE WHEN description IS NOT NULL AND description != '' THEN 1 ELSE 0 END) AS described_games,
        (SELECT COUNT(*) FROM downloads) AS downloads,
        SUM(CASE WHEN EXISTS (
          SELECT 1 FROM downloads WHERE downloads.game_id = games.id
        ) THEN 1 ELSE 0 END) AS eligible_games,
        (SELECT COUNT(*) FROM xianyu_material_sync WHERE status = 'synced') AS material_synced,
        (SELECT COUNT(*) FROM xianyu_publications WHERE status = 'success') AS published_games,
        (SELECT COUNT(*) FROM xianyu_publications WHERE status IN ('failed', 'unknown')) AS publish_attention
      FROM games
    `)
    .get();
  const errors = database
    .prepare(`
      SELECT
        id,
        run_id,
        game_id,
        target_url,
        stage,
        attempt_count,
        error_name,
        error_message,
        created_at
      FROM crawl_errors
      ORDER BY id DESC
      LIMIT 6
    `)
    .all()
    .map((row) => ({
      id: row.id,
      runId: row.run_id,
      gameId: row.game_id,
      targetUrl: row.target_url,
      stage: row.stage,
      attemptCount: row.attempt_count,
      errorName: row.error_name,
      errorMessage: row.error_message,
      createdAt: row.created_at,
    }));
  const syncSettings =
    database
      .prepare(
        `SELECT
           account_id,
           default_price,
           title_template,
           description_template,
           image_template,
           updated_at
         FROM xianyu_sync_settings
         WHERE id = 1`,
      )
      .get() ?? {
        account_id: null,
        default_price: 1,
        updated_at: null,
      };
  const latestSyncRun = database
    .prepare("SELECT * FROM xianyu_sync_runs ORDER BY id DESC LIMIT 1")
    .get();

  return {
    generatedAt: new Date().toISOString(),
    scheduler: runtimeState(),
    pageCount: config.pageCount,
    currentRun: mapRun(currentRun),
    latestRun: mapRun(latestRun),
    totals: {
      games: totals.games,
      successfulGames: totals.successful_games ?? 0,
      failedGames: totals.failed_games ?? 0,
      describedGames: totals.described_games ?? 0,
      downloads: totals.downloads,
      eligibleGames: totals.eligible_games ?? 0,
      materialSynced: totals.material_synced ?? 0,
      publishedGames: totals.published_games ?? 0,
      publishAttention: totals.publish_attention ?? 0,
    },
    recentErrors: errors,
    xianyu: {
      accountId: syncSettings.account_id,
      defaultPrice: Number(syncSettings.default_price ?? 1),
      titleTemplate:
        syncSettings.title_template ??
        DEFAULT_XIANYU_TEMPLATES.titleTemplate,
      descriptionTemplate:
        syncSettings.description_template ??
        DEFAULT_XIANYU_TEMPLATES.descriptionTemplate,
      imageTemplate:
        syncSettings.image_template ??
        DEFAULT_XIANYU_TEMPLATES.imageTemplate,
      settingsUpdatedAt: syncSettings.updated_at,
      latestSyncRun: latestSyncRun ? mapSyncRun(latestSyncRun) : null,
    },
  };
}

function listGames(database, requestUrl) {
  const page = integerParameter(requestUrl.searchParams.get("page"), 1, 1, 100_000);
  const pageSize = integerParameter(
    requestUrl.searchParams.get("pageSize"),
    20,
    1,
    100,
  );
  const query = requestUrl.searchParams.get("query")?.trim().slice(0, 200) ?? "";
  const requestedStatus = requestUrl.searchParams.get("status") ?? "all";
  const status = new Set([
    "pending",
    "running",
    "success",
    "failed",
    "updated",
  ]).has(requestedStatus)
    ? requestedStatus
    : "all";
  const requestedXianyuStatus =
    requestUrl.searchParams.get("xianyuStatus") ?? "all";
  const xianyuStatus = new Set([
    "none",
    "material",
    "material_update",
    "published",
    "publishing",
  ]).has(requestedXianyuStatus)
    ? requestedXianyuStatus
    : "all";
  const conditions = [];
  const parameters = [];
  const joinedTables = `
    FROM games
    LEFT JOIN xianyu_sync_settings AS settings
      ON settings.id = 1
    LEFT JOIN xianyu_material_sync AS material
      ON material.game_id = games.id
    LEFT JOIN xianyu_publications AS publication
      ON publication.game_id = games.id
     AND publication.account_id = (
       SELECT account_id FROM xianyu_sync_settings WHERE id = 1
     )
  `;

  if (query) {
    conditions.push(
      "(CAST(games.id AS TEXT) LIKE ? OR games.title LIKE ? OR games.xianyu_item_id LIKE ?)",
    );
    const pattern = `%${query}%`;
    parameters.push(pattern, pattern, pattern);
  }
  if (status !== "all") {
    conditions.push(
      status === "updated"
        ? "games.last_change_type = ?"
        : "games.scrape_status = ?",
    );
    parameters.push(status);
  }
  if (xianyuStatus !== "all") {
    conditions.push(`(${xianyuStatusExpression}) = ?`);
    parameters.push(xianyuStatus);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const total = database
    .prepare(`
      SELECT COUNT(DISTINCT games.id) AS count
      ${joinedTables}
      ${whereClause}
    `)
    .get(...parameters).count;
  const rows = database
    .prepare(`
      SELECT
        games.*,
        COALESCE(
          games.sale_price,
          settings.default_price,
          1
        ) AS effective_price,
        (SELECT COUNT(*) FROM downloads WHERE game_id = games.id) AS download_count,
        (${xianyuStatusExpression}) AS xianyu_status,
        material.status AS material_sync_status,
        publication.status AS publication_status,
        publication.item_id AS publication_item_id,
        publication.item_url AS publication_item_url
      ${joinedTables}
      ${whereClause}
      ORDER BY
        CASE WHEN hot_rank IS NULL THEN 1 ELSE 0 END,
        hot_rank ASC,
        updated_at DESC
      LIMIT ? OFFSET ?
    `)
    .all(...parameters, pageSize, (page - 1) * pageSize);

  return {
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    items: rows.map(mapGame),
  };
}

function gameDetail(database, gameId) {
  const row = database
    .prepare(`
      SELECT
        games.*,
        COALESCE(
          games.sale_price,
          settings.default_price,
          1
        ) AS effective_price,
        (SELECT COUNT(*) FROM downloads WHERE game_id = games.id) AS download_count,
        (${xianyuStatusExpression}) AS xianyu_status,
        material.status AS material_sync_status,
        publication.status AS publication_status,
        publication.item_id AS publication_item_id,
        publication.item_url AS publication_item_url
      FROM games
      LEFT JOIN xianyu_sync_settings AS settings
        ON settings.id = 1
      LEFT JOIN xianyu_material_sync AS material
        ON material.game_id = games.id
      LEFT JOIN xianyu_publications AS publication
        ON publication.game_id = games.id
       AND publication.account_id = (
         SELECT account_id FROM xianyu_sync_settings WHERE id = 1
       )
      WHERE games.id = ?
    `)
    .get(gameId);
  if (!row) return null;

  return {
    game: mapGame(row),
    downloads: database
      .prepare(
        "SELECT * FROM downloads WHERE game_id = ? ORDER BY provider, url",
      )
      .all(gameId)
      .map(mapDownload),
  };
}

function downloadSources(database, input) {
  const idValue = String(input?.id ?? "").trim();
  const itemIdValue = String(input?.item_id ?? "").trim();
  const requestedItemTitle = String(input?.item_title ?? "").trim();
  if (![idValue, itemIdValue, requestedItemTitle].some(Boolean)) {
    return {
      status: 422,
      error: "id、item_id 和 item_title 至少提供一个",
    };
  }

  const itemTitleValue = normalizeDownloadLookupTitle(
    requestedItemTitle,
  );
  if (requestedItemTitle && !itemTitleValue) {
    return {
      status: 422,
      error: "item_title 去除【秒发】后不能为空",
    };
  }
  if (itemIdValue.length > 100) {
    return { status: 422, error: "item_id 不能超过 100 个字符" };
  }
  if (idValue && !/^\d+$/.test(idValue)) {
    return { status: 422, error: "id 必须是数字" };
  }

  let rows = [];
  let strategy = null;
  if (itemIdValue) {
    rows = database
      .prepare(`
        SELECT DISTINCT games.*
        FROM games
        LEFT JOIN xianyu_publications AS publication
          ON publication.game_id = games.id
        WHERE games.xianyu_item_id = ?
           OR (
             publication.item_id = ?
             AND publication.status = 'success'
           )
        ORDER BY games.id
      `)
      .all(itemIdValue, itemIdValue);
    if (rows.length > 0) strategy = "item_id";
  }
  if (rows.length === 0 && requestedItemTitle) {
    rows = database
      .prepare(
        "SELECT * FROM games WHERE trim(title) = ? COLLATE NOCASE ORDER BY id",
      )
      .all(itemTitleValue);
    if (rows.length > 0) strategy = "item_title";
  }
  if (rows.length === 0 && idValue) {
    rows = database
      .prepare("SELECT * FROM games WHERE id = ?")
      .all(Number(idValue));
    if (rows.length > 0) strategy = "id";
  }

  if (rows.length === 0) {
    return { status: 404, error: "没有找到该游戏" };
  }
  if (rows.length > 1) {
    return {
      status: 409,
      error: "存在同名游戏，请改用 id 查询",
      candidates: rows.map((row) => ({ id: row.id, title: row.title })),
    };
  }

  const row = rows[0];
  const downloads = database
    .prepare(
      "SELECT * FROM downloads WHERE game_id = ? ORDER BY provider, url",
    )
    .all(row.id)
    .map(mapDownload);
  return {
    status: 200,
    payload: {
      lookup: {
        strategy,
        ...(itemIdValue ? { itemId: itemIdValue } : {}),
        ...(requestedItemTitle
          ? {
              requestedItemTitle,
              normalizedItemTitle: itemTitleValue,
            }
          : {}),
        ...(idValue ? { id: Number(idValue) } : {}),
      },
      itemId:
        strategy === "item_id"
          ? itemIdValue
          : row.xianyu_item_id || null,
      resourceCode: row.resource_code,
      archivePassword: row.archive_password,
      data: buildDownloadData(row.archive_password, downloads),
      game: mapGame({
        ...row,
        download_count: downloads.length,
      }),
      downloads,
    },
  };
}

function listRuns(database, requestUrl) {
  const limit = integerParameter(
    requestUrl.searchParams.get("limit"),
    20,
    1,
    100,
  );
  const crawlRuns = database
    .prepare("SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map(mapRun);
  const syncRuns = database
    .prepare("SELECT * FROM xianyu_sync_runs ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map(mapSyncRun);
  return [...crawlRuns, ...syncRuns]
    .sort(
      (left, right) =>
        new Date(right.startedAt).getTime() -
        new Date(left.startedAt).getTime(),
    )
    .slice(0, limit);
}

function listSyncRuns(database, requestUrl) {
  const limit = integerParameter(
    requestUrl.searchParams.get("limit"),
    20,
    1,
    100,
  );
  return database
    .prepare("SELECT * FROM xianyu_sync_runs ORDER BY id DESC LIMIT ?")
    .all(limit)
    .map(mapSyncRun);
}

function serveStatic(requestUrl, response) {
  const relativePath =
    requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    sendError(response, 400, "请求路径无效");
    return;
  }

  const filePath = path.resolve(publicDirectory, decodedPath);
  if (!filePath.startsWith(`${publicDirectory}${path.sep}`)) {
    sendError(response, 403, "禁止访问");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendError(response, 404, "页面不存在");
    return;
  }

  response.writeHead(200, {
    "content-type":
      contentTypes.get(path.extname(filePath)) ??
      "application/octet-stream",
    "cache-control":
      path.extname(filePath) === ".html"
        ? "no-store"
        : "public, max-age=3600",
  });
  fs.createReadStream(filePath).pipe(response);
}

export async function startDashboardServer(
  config,
  runtimeState = () => ({}),
  handlers = {},
) {
  const server = http.createServer(async (request, response) => {
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "strict-origin-when-cross-origin");

    const requestUrl = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/dashboard") {
        sendJson(
          response,
          200,
          withDatabase(config.dbPath, (database) =>
            dashboardPayload(database, config, runtimeState),
          ),
        );
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/games") {
        sendJson(
          response,
          200,
          withDatabase(config.dbPath, (database) =>
            listGames(database, requestUrl),
          ),
        );
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/runs") {
        sendJson(
          response,
          200,
          withDatabase(config.dbPath, (database) =>
            listRuns(database, requestUrl),
          ),
        );
        return;
      }
      if (request.method === "GET" && requestUrl.pathname === "/api/sync/runs") {
        sendJson(
          response,
          200,
          withDatabase(config.dbPath, (database) =>
            listSyncRuns(database, requestUrl),
          ),
        );
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/settings/xianyu"
      ) {
        const settings = withDatabase(config.dbPath, (database) =>
          database
            .prepare(
              `SELECT
                 account_id,
                 default_price,
                 title_template,
                 description_template,
                 image_template,
                 updated_at
               FROM xianyu_sync_settings
               WHERE id = 1`,
            )
            .get(),
        );
        sendJson(response, 200, {
          accountId: settings?.account_id ?? null,
          defaultPrice: Number(settings?.default_price ?? 1),
          titleTemplate:
            settings?.title_template ??
            DEFAULT_XIANYU_TEMPLATES.titleTemplate,
          descriptionTemplate:
            settings?.description_template ??
            DEFAULT_XIANYU_TEMPLATES.descriptionTemplate,
          imageTemplate:
            settings?.image_template ??
            DEFAULT_XIANYU_TEMPLATES.imageTemplate,
          updatedAt: settings?.updated_at ?? null,
          configured: Boolean(settings?.account_id),
          runtime: runtimeState().sync ?? {},
        });
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/settings/schedule"
      ) {
        const state = runtimeState();
        sendJson(response, 200, {
          cronTimezone: state.cronTimezone,
          updatedAt: state.updatedAt ?? null,
          crawl: {
            enabled: Boolean(state.enabled),
            cronSchedule: state.cronSchedule,
            nextRun: state.nextRun ?? null,
            active: Boolean(state.active),
            interrupted: Boolean(state.interrupted),
          },
          sync: {
            enabled: Boolean(state.sync?.enabled),
            cronSchedule: state.sync?.cronSchedule,
            mode: state.sync?.mode ?? "all",
            nextRun: state.sync?.nextRun ?? null,
            active: Boolean(state.sync?.active),
            interrupted: Boolean(state.sync?.interrupted),
            progress: state.sync?.progress ?? null,
          },
        });
        return;
      }
      if (
        request.method === "PUT" &&
        requestUrl.pathname === "/api/settings/schedule"
      ) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        if (!handlers.updateScheduleSettings) {
          sendError(response, 503, "任务调度服务尚未启用");
          return;
        }
        const body = await readJsonBody(request);
        const saved = await handlers.updateScheduleSettings({
          cronTimezone: body.cron_timezone,
          crawlCronSchedule: body.crawl?.cron_schedule,
          crawlEnabled: body.crawl?.enabled,
          syncCronSchedule: body.sync?.cron_schedule,
          syncEnabled: body.sync?.enabled,
          syncMode: syncMode(body.sync?.mode),
        });
        sendJson(response, 200, {
          success: true,
          scheduler: saved,
        });
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/xianyu/accounts"
      ) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        if (!handlers.listXianyuAccounts) {
          sendError(response, 503, "闲鱼账号服务尚未启用");
          return;
        }
        const accounts = await handlers.listXianyuAccounts();
        sendJson(response, 200, { items: accounts });
        return;
      }
      if (
        request.method === "PUT" &&
        requestUrl.pathname === "/api/settings/xianyu"
      ) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        const body = await readJsonBody(request);
        const accountId = String(body.account_id ?? "").trim();
        const defaultPrice = salePrice(body.default_price ?? 1);
        if (!accountId || accountId.length > 80) {
          sendError(response, 422, "account_id 不能为空且不能超过 80 个字符");
          return;
        }
        if (!handlers.validateXianyuAccount) {
          sendError(response, 503, "闲鱼账号服务尚未启用");
          return;
        }
        const account = await handlers.validateXianyuAccount(accountId);
        const database = new CrawlerDatabase(config.dbPath);
        let templates;
        try {
          const current = database.getXianyuSyncSettings();
          templates = validateXianyuTemplates({
            titleTemplate:
              body.title_template ?? current.title_template,
            descriptionTemplate:
              body.description_template ??
              current.description_template,
            imageTemplate:
              body.image_template ?? current.image_template,
          });
          database.setXianyuSettings(
            accountId,
            defaultPrice,
            new Date().toISOString(),
            templates,
          );
        } finally {
          database.close();
        }
        sendJson(response, 200, {
          success: true,
          accountId,
          defaultPrice,
          ...templates,
          account,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/crawl/run"
      ) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        await readJsonBody(request);
        const state = runtimeState();
        if (state.active || state.sync?.active) {
          sendError(response, 409, "采集或同步任务正在运行");
          return;
        }
        if (!handlers.triggerCrawl) {
          sendError(response, 503, "采集服务尚未启用");
          return;
        }
        const accepted = handlers.triggerCrawl("manual");
        sendJson(response, 202, {
          success: true,
          message: "手动采集任务已启动",
          ...accepted,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/sync/run"
      ) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        const body = await readJsonBody(request);
        const state = runtimeState();
        if (state.active || state.sync?.active) {
          sendError(response, 409, "采集或同步任务正在运行");
          return;
        }
        if (!handlers.triggerSync) {
          sendError(response, 503, "闲鱼同步服务尚未启用");
          return;
        }
        const mode = syncMode(body.mode);
        const accepted = handlers.triggerSync("manual", mode);
        sendJson(response, 202, {
          success: true,
          message: `${mode === "pending" ? "未发布商品" : mode === "updated" ? "已更新商品" : "全部商品"}同步任务已启动`,
          ...accepted,
        });
        return;
      }
      const taskControlMatch = requestUrl.pathname.match(
        /^\/api\/tasks\/(crawl|sync)\/(interrupt|resume)$/,
      );
      if (request.method === "POST" && taskControlMatch) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        if (!handlers.controlTask) {
          sendError(response, 503, "任务控制服务尚未启用");
          return;
        }
        const [, task, action] = taskControlMatch;
        const scheduler = handlers.controlTask(task, action);
        sendJson(response, 200, {
          success: true,
          task,
          action,
          scheduler,
        });
        return;
      }
      if (requestUrl.pathname === "/api/download-sources") {
        if (request.method !== "POST") {
          sendError(response, 405, "下载源接口仅支持 POST");
          return;
        }
        if (
          !requireKey(
            request,
            response,
            config.downloadReadApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        const body = await readJsonBody(request);
        const result = withDatabase(config.dbPath, (database) =>
          downloadSources(database, body),
        );
        if (result.status !== 200) {
          sendJson(response, result.status, {
            error: result.error,
            ...(result.candidates
              ? { candidates: result.candidates }
              : {}),
          });
          return;
        }
        sendJson(response, 200, result.payload);
        return;
      }

      const gamePriceMatch = requestUrl.pathname.match(
        /^\/api\/games\/(\d+)\/price$/,
      );
      if (request.method === "PUT" && gamePriceMatch) {
        if (
          !requireKey(
            request,
            response,
            config.xianyuApiKey,
            "X-API-Key",
          )
        ) {
          return;
        }
        const body = await readJsonBody(request);
        const price = salePrice(body.price, { allowNull: true });
        const gameId = Number(gamePriceMatch[1]);
        const database = new CrawlerDatabase(config.dbPath);
        let result;
        try {
          const updated = database.setGameSalePrice(
            gameId,
            price,
            new Date().toISOString(),
          );
          if (updated) {
            const settings = database.getXianyuSyncSettings();
            result = {
              gameId,
              salePrice: price,
              effectivePrice: Number(
                price ?? settings.default_price ?? 1,
              ),
            };
          }
        } finally {
          database.close();
        }
        if (!result) {
          sendError(response, 404, "没有找到该游戏");
          return;
        }
        sendJson(response, 200, {
          success: true,
          ...result,
        });
        return;
      }

      const gameMatch = requestUrl.pathname.match(
        /^\/api\/games\/(\d+)$/,
      );
      if (request.method === "GET" && gameMatch) {
        const detail = withDatabase(config.dbPath, (database) =>
          gameDetail(database, Number(gameMatch[1])),
        );
        if (!detail) {
          sendError(response, 404, "没有找到该游戏");
          return;
        }
        sendJson(response, 200, detail);
        return;
      }

      if (requestUrl.pathname.startsWith("/api/")) {
        if (!["GET", "POST", "PUT"].includes(request.method ?? "")) {
          sendError(response, 405, "请求方法不受支持");
        } else {
          sendError(response, 404, "接口不存在");
        }
        return;
      }
      if (request.method !== "GET") {
        sendError(response, 405, "静态页面只支持 GET");
        return;
      }
      serveStatic(requestUrl, response);
    } catch (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "dashboard_request_failed",
          path: requestUrl.pathname,
          error: {
            name: error.name,
            message: error.message,
          },
        }),
      );
      sendError(
        response,
        Number(error.statusCode) || 500,
        Number(error.statusCode) ? error.message : "服务处理请求失败",
      );
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      config.dashboardPort,
      config.dashboardHost,
      resolve,
    );
  });

  return {
    address: server.address(),
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
