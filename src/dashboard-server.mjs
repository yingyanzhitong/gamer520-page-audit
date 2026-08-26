import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { cacheCoverImage } from "./cover-cache.mjs";
import {
  ALL_SYNC_CANDIDATE_CONDITION,
  CrawlerDatabase,
  VALID_GAME_DATA_CONDITION,
} from "./database.mjs";
import {
  clearDashboardSessionCookieHeader,
  createDashboardSession,
  dashboardAuthEnabled,
  dashboardSessionCookieHeader,
  dashboardSessionFromRequest,
  verifyDashboardCredentials,
} from "./dashboard-auth.mjs";
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
    WHEN publication.status = 'success' THEN 'published'
    WHEN publication.item_id IS NOT NULL
      OR publication.status IN ('publishing', 'unknown')
    THEN 'publishing'
    WHEN publication.material_id IS NOT NULL
      AND (
        material.material_id IS NOT NULL
        OR material.status IN ('synced', 'skipped')
      )
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

function mapXianyuSettings(row) {
  const defaultPublishOptions = {
    cardId: null,
    originalPrice: null,
    category: "虚拟商品",
    condition: "全新",
    deliveryMethod: "express",
    shippingMethod: "free",
    postage: 0,
    address: null,
    addressExpectedText: null,
    supportPickup: false,
    brand: null,
    platformAttributes: [],
    fish: { quantity: Number(row?.default_stock ?? 999), specifications: [], skuRows: [] },
  };
  let storedPublishOptions = row?.publish_options;
  if (typeof storedPublishOptions === "string") {
    try {
      storedPublishOptions = JSON.parse(storedPublishOptions);
    } catch {
      storedPublishOptions = {};
    }
  }
  const publishOptions =
    storedPublishOptions && typeof storedPublishOptions === "object"
      ? {
          ...defaultPublishOptions,
          ...storedPublishOptions,
          fish: {
            ...defaultPublishOptions.fish,
            ...(storedPublishOptions.fish ?? {}),
          },
        }
      : defaultPublishOptions;
  return {
    accountId: row?.account_id ?? null,
    defaultPrice: Number(row?.default_price ?? 1),
    defaultStock: Number(row?.default_stock ?? 999),
    publishMode: "account-auto",
    titleTemplate:
      row?.title_template ?? DEFAULT_XIANYU_TEMPLATES.titleTemplate,
    descriptionTemplate:
      row?.description_template ??
      DEFAULT_XIANYU_TEMPLATES.descriptionTemplate,
    imageTemplate:
      row?.image_template ?? DEFAULT_XIANYU_TEMPLATES.imageTemplate,
    publishOptions,
    updatedAt: row?.updated_at ?? null,
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
    xianyuItemId: row.publication_item_id ?? null,
    xianyuItemUrl: row.publication_item_url ?? null,
    xianyuAccountId: row.publication_account_id ?? null,
    xianyuPublishedAt: row.publication_published_at ?? null,
    materialSyncStatus: row.material_sync_status ?? "pending",
    publicationStatus: row.publication_status ?? "pending",
    xianyuStatus: row.xianyu_status ?? "none",
    publishedItemId: row.publication_item_id ?? null,
    publishedItemUrl: row.publication_item_url ?? null,
    isValid: Boolean(row.is_valid),
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

function stockQuantity(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999_999) {
    const error = new Error("库存必须是 1 到 999999 的整数");
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function syncMode(value, fallback = "all") {
  const normalized = String(value ?? fallback).trim();
  if (
    !new Set(["all", "pending", "updated", "selected-force"]).has(
      normalized,
    )
  ) {
    const error = new Error(
      "同步范围必须是 all、pending、updated 或 selected-force",
    );
    error.statusCode = 422;
    throw error;
  }
  return normalized;
}

function selectedGameIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    const error = new Error("请至少选择一个游戏");
    error.statusCode = 422;
    throw error;
  }
  const ids = new Set();
  for (const valueItem of value) {
    const gameId = Number(valueItem);
    if (!Number.isSafeInteger(gameId) || gameId <= 0) {
      const error = new Error("游戏 ID 必须是正整数");
      error.statusCode = 422;
      throw error;
    }
    ids.add(gameId);
  }
  return [...ids];
}

function sendJson(response, status, payload, headers = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
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
  if (request.adminAuthenticated) return true;
  const expectedKeys = (Array.isArray(expected) ? expected : [expected]).filter(
    Boolean,
  );
  if (expectedKeys.length === 0) {
    sendError(response, 503, `${headerName} 尚未在服务器配置`);
    return false;
  }
  const provided = request.headers[headerName.toLowerCase()];
  if (!expectedKeys.some((expectedKey) => keyMatches(provided, expectedKey))) {
    sendError(response, 401, "API Key 无效");
    return false;
  }
  return true;
}

function maskApiKey(value) {
  const key = String(value ?? "").trim();
  if (!key) return "";
  if (key.length <= 12) return `${key.slice(0, 3)}••••${key.slice(-2)}`;
  return `${key.slice(0, 8)}••••••••${key.slice(-4)}`;
}

function requireAdmin(request, response, config) {
  if (!dashboardAuthEnabled(config)) {
    return true;
  }
  const session = dashboardSessionFromRequest(config, request);
  const apiKey = request.headers["x-api-key"];
  if (session || keyMatches(apiKey, config.xianyuApiKey)) {
    request.adminAuthenticated = true;
    request.dashboardSession = session;
    return true;
  }
  sendError(response, 401, "请先登录后台");
  return false;
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

function taskAccountIds(database) {
  const stored = database
    .prepare("SELECT sync_account_ids FROM scheduler_settings WHERE id = 1")
    .get()?.sync_account_ids;
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        const accountIds = [
          ...new Set(
            parsed
              .map((accountId) => String(accountId ?? "").trim())
              .filter(Boolean),
          ),
        ];
        if (accountIds.length > 0) return accountIds;
      }
    } catch {
      // 旧的异常配置回退到兼容单账号。
    }
  }
  const fallback = String(
    database
      .prepare("SELECT account_id FROM xianyu_sync_settings WHERE id = 1")
      .get()?.account_id ?? "",
  ).trim();
  return fallback ? [fallback] : [];
}

function dashboardPayload(database, config, runtimeState) {
  const runtime = runtimeState();
  const primaryAccountId =
    runtime.sync?.accountIds?.[0] ?? taskAccountIds(database)[0] ?? null;
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
        SUM(CASE WHEN ${VALID_GAME_DATA_CONDITION}
          THEN 1 ELSE 0 END) AS valid_games,
        (SELECT COUNT(*) FROM xianyu_account_material_sync
          WHERE account_id = ? AND status = 'synced') AS material_synced,
        (SELECT COUNT(*) FROM xianyu_publications
          WHERE account_id = ?
            AND status = 'success') AS published_games,
        (SELECT COUNT(*) FROM xianyu_publications
          WHERE account_id = ?
            AND status IN ('failed', 'unknown')) AS publish_attention
      FROM games
    `)
    .get(primaryAccountId, primaryAccountId, primaryAccountId);
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
  const accountSyncSettings = primaryAccountId
    ? database
        .prepare(
          `SELECT account_id, default_price, default_stock, publish_mode,
                  title_template, description_template, image_template, updated_at
           FROM xianyu_account_settings WHERE account_id = ?`,
        )
        .get(primaryAccountId)
    : null;
  const syncSettings = accountSyncSettings ?? database
        .prepare(
          `SELECT account_id, default_price, default_stock, publish_mode,
                  title_template, description_template, image_template, updated_at
           FROM xianyu_sync_settings WHERE id = 1`,
        )
        .get() ?? {
          account_id: null,
          default_price: 1,
          default_stock: 999,
          updated_at: null,
        };
  const latestSyncRun = database
    .prepare("SELECT * FROM xianyu_sync_runs ORDER BY id DESC LIMIT 1")
    .get();

  return {
    generatedAt: new Date().toISOString(),
    scheduler: runtime,
    pageCount: config.pageCount,
    currentRun: mapRun(currentRun),
    latestRun: mapRun(latestRun),
    totals: {
      games: totals.games,
      successfulGames: totals.successful_games ?? 0,
      failedGames: totals.failed_games ?? 0,
      describedGames: totals.described_games ?? 0,
      downloads: totals.downloads,
      validGames: totals.valid_games ?? 0,
      eligibleGames: totals.valid_games ?? 0,
      materialSynced: totals.material_synced ?? 0,
      publishedGames: totals.published_games ?? 0,
      publishAttention: totals.publish_attention ?? 0,
    },
    recentErrors: errors,
    xianyu: {
      accountId: primaryAccountId,
      accountIds: runtime.sync?.accountIds ?? [],
      defaultPrice: Number(syncSettings.default_price ?? 1),
      defaultStock: Number(syncSettings.default_stock ?? 999),
      publishMode: "account-auto",
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
  const requestedAccountId = String(
    requestUrl.searchParams.get("accountId") ?? "",
  ).trim();
  const primaryAccountId =
    requestedAccountId || taskAccountIds(database)[0] || null;
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
    "missing",
    "failed",
    "violation",
    "updated",
  ]).has(requestedStatus)
    ? requestedStatus
    : "all";
  const requestedXianyuStatus =
    requestUrl.searchParams.get("xianyuStatus") ?? "all";
  const requestedSort = requestUrl.searchParams.get("sort") ?? "hot";
  const sort = new Set(["created", "updated", "hot"]).has(requestedSort)
    ? requestedSort
    : "hot";
  const validOnly = requestUrl.searchParams.get("validOnly") === "true";
  const xianyuStatus = new Set([
    "none",
    "publishable",
    "material",
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
    LEFT JOIN xianyu_account_material_sync AS material
      ON material.game_id = games.id
     AND material.account_id = ?
    LEFT JOIN xianyu_publications AS publication
      ON publication.game_id = games.id
     AND publication.account_id = ?
  `;
  const joinParameters = [primaryAccountId, primaryAccountId];

  if (query) {
    conditions.push(
      "(CAST(games.id AS TEXT) LIKE ? OR games.title LIKE ? OR publication.item_id LIKE ?)",
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
  if (xianyuStatus === "publishable") {
    conditions.push(`(${VALID_GAME_DATA_CONDITION})`);
    conditions.push(`(${ALL_SYNC_CANDIDATE_CONDITION})`);
  } else if (xianyuStatus !== "all") {
    conditions.push(`(${xianyuStatusExpression}) = ?`);
    parameters.push(xianyuStatus);
  }
  if (validOnly) {
    conditions.push(`(${VALID_GAME_DATA_CONDITION})`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sortClause = {
    created: "games.first_seen_at DESC, games.id DESC",
    updated: "games.updated_at DESC, games.id DESC",
    hot: `
      CASE WHEN games.hot_rank IS NULL THEN 1 ELSE 0 END,
      games.hot_rank ASC,
      games.updated_at DESC,
      games.id DESC
    `,
  }[sort];
  const total = database
    .prepare(`
      SELECT COUNT(DISTINCT games.id) AS count
      ${joinedTables}
      ${whereClause}
    `)
    .get(...joinParameters, ...parameters).count;
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
        CASE WHEN ${VALID_GAME_DATA_CONDITION} THEN 1 ELSE 0 END AS is_valid,
        (${xianyuStatusExpression}) AS xianyu_status,
        material.status AS material_sync_status,
        publication.status AS publication_status,
        publication.account_id AS publication_account_id,
        publication.item_id AS publication_item_id,
        publication.item_url AS publication_item_url,
        publication.published_at AS publication_published_at
      ${joinedTables}
      ${whereClause}
      ORDER BY ${sortClause}
      LIMIT ? OFFSET ?
    `)
    .all(
      ...joinParameters,
      ...parameters,
      pageSize,
      (page - 1) * pageSize,
    );

  return {
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
    sort,
    accountId: primaryAccountId,
    items: rows.map(mapGame),
  };
}

function gameDetail(database, gameId, requestedAccountId = null) {
  const primaryAccountId =
    String(requestedAccountId ?? "").trim() ||
    taskAccountIds(database)[0] ||
    null;
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
        CASE WHEN ${VALID_GAME_DATA_CONDITION} THEN 1 ELSE 0 END AS is_valid,
        (${xianyuStatusExpression}) AS xianyu_status,
        material.status AS material_sync_status,
        publication.status AS publication_status,
        publication.account_id AS publication_account_id,
        publication.item_id AS publication_item_id,
        publication.item_url AS publication_item_url,
        publication.published_at AS publication_published_at
      FROM games
      LEFT JOIN xianyu_sync_settings AS settings
        ON settings.id = 1
      LEFT JOIN xianyu_account_material_sync AS material
        ON material.game_id = games.id
       AND material.account_id = ?
      LEFT JOIN xianyu_publications AS publication
        ON publication.game_id = games.id
       AND publication.account_id = ?
      WHERE games.id = ?
    `)
    .get(primaryAccountId, primaryAccountId, gameId);
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

function listRecentTaskErrors(database, requestUrl) {
  const limit = integerParameter(
    requestUrl.searchParams.get("limit"),
    50,
    1,
    200,
  );
  const crawlLogs = database
    .prepare(`
      SELECT
        id,
        run_id,
        game_id,
        stage,
        error_name,
        error_message,
        created_at
      FROM crawl_errors
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => ({
      id: `crawl-${row.id}`,
      taskType: "crawl",
      runId: row.run_id,
      gameId: row.game_id,
      level: "error",
      stage: row.stage,
      title: row.error_name ?? "采集失败",
      message: row.error_message,
      createdAt: row.created_at,
    }));
  const syncLogs = database
    .prepare(`
      SELECT id, status, error_summary, finished_at, started_at
      FROM xianyu_sync_runs
      WHERE error_summary IS NOT NULL
        AND length(trim(error_summary)) > 0
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => ({
      id: `sync-${row.id}`,
      taskType: "sync",
      runId: row.id,
      gameId: null,
      level: row.status === "failed" ? "error" : "warning",
      stage: "publish",
      title: `同步任务 #${row.id}`,
      message: row.error_summary,
      createdAt: row.finished_at ?? row.started_at,
    }));
  return [...crawlLogs, ...syncLogs]
    .sort(
      (left, right) =>
        new Date(right.createdAt).getTime() -
        new Date(left.createdAt).getTime(),
    )
    .slice(0, limit);
}

function taskOperationLogs(database, requestUrl) {
  const taskType = requestUrl.searchParams.get("task_type");
  const runId = Number.parseInt(
    requestUrl.searchParams.get("run_id") ?? "",
    10,
  );
  const afterId = integerParameter(
    requestUrl.searchParams.get("after_id"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const limit = integerParameter(
    requestUrl.searchParams.get("limit"),
    500,
    1,
    500,
  );
  if (!new Set(["crawl", "sync"]).has(taskType)) {
    const error = new Error("task_type 必须是 crawl 或 sync");
    error.statusCode = 422;
    throw error;
  }
  if (!Number.isInteger(runId) || runId <= 0) {
    const error = new Error("run_id 必须是正整数");
    error.statusCode = 422;
    throw error;
  }
  const rows = database
    .prepare(`
      SELECT *
      FROM task_operation_logs
      WHERE task_type = ?
        AND run_id = ?
        AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `)
    .all(taskType, runId, afterId, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => {
    let details = null;
    try {
      details = row.detail_json ? JSON.parse(row.detail_json) : null;
    } catch {
      details = { raw: row.detail_json };
    }
    return {
      id: row.id,
      taskType: row.task_type,
      runId: row.run_id,
      gameId: row.game_id,
      level: row.level,
      stage: row.stage,
      action: row.action,
      message: row.message,
      details,
      createdAt: row.created_at,
    };
  });
  return {
    items,
    nextAfterId: items.at(-1)?.id ?? afterId,
    hasMore,
  };
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

function serveCachedCover(requestUrl, response, cacheDirectory) {
  const match = requestUrl.pathname.match(
    /^\/covers\/(\d+-[a-f0-9]{20}\.jpg)$/,
  );
  if (!match) {
    sendError(response, 404, "封面不存在");
    return;
  }
  const filePath = path.join(cacheDirectory, match[1]);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendError(response, 404, "封面不存在");
    return;
  }
  response.writeHead(200, {
    "content-type": "image/jpeg",
    "content-length": fs.statSync(filePath).size,
    "cache-control": "public, max-age=31536000, immutable",
  });
  fs.createReadStream(filePath).pipe(response);
}

export async function startDashboardServer(
  config,
  runtimeState = () => ({}),
  handlers = {},
) {
  const credentialsDatabase = new CrawlerDatabase(config.dbPath);
  try {
    const storedXianyuApiKey = credentialsDatabase.getXianyuApiKey(
      config.xianyuApiKey,
    );
    if (
      storedXianyuApiKey &&
      !credentialsDatabase.getXianyuApiKey()
    ) {
      credentialsDatabase.setXianyuApiKey(
        storedXianyuApiKey,
        new Date().toISOString(),
      );
    }
    config.xianyuApiKey = storedXianyuApiKey;
    if (config.downloadReadApiKey) {
      credentialsDatabase.ensureDownloadApiKey({
        id: "environment-default",
        name: "默认下载 Key",
        apiKey: config.downloadReadApiKey,
        createdAt: new Date().toISOString(),
      });
    }
  } finally {
    credentialsDatabase.close();
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader(
      "content-security-policy",
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "strict-origin-when-cross-origin");

    const requestUrl = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && requestUrl.pathname === "/healthz") {
        sendJson(response, 200, { ok: true });
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname.startsWith("/covers/")
      ) {
        serveCachedCover(
          requestUrl,
          response,
          config.coverCacheDir,
        );
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/auth/session"
      ) {
        const session = dashboardSessionFromRequest(config, request);
        sendJson(response, 200, {
          enabled: dashboardAuthEnabled(config),
          authenticated:
            !dashboardAuthEnabled(config) || Boolean(session),
          username:
            session?.username ??
            (!dashboardAuthEnabled(config)
              ? config.dashboardAdminUsername
              : null),
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/auth/login"
      ) {
        if (!dashboardAuthEnabled(config)) {
          sendError(response, 503, "后台登录尚未在服务器配置");
          return;
        }
        const body = await readJsonBody(request);
        if (
          !verifyDashboardCredentials(
            config,
            body.username,
            body.password,
          )
        ) {
          sendError(response, 401, "账号或密码错误");
          return;
        }
        const token = createDashboardSession(config);
        sendJson(
          response,
          200,
          {
            success: true,
            username: config.dashboardAdminUsername,
          },
          {
            "set-cookie": dashboardSessionCookieHeader(
              config,
              request,
              token,
            ),
          },
        );
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/auth/logout"
      ) {
        sendJson(
          response,
          200,
          { success: true },
          {
            "set-cookie":
              clearDashboardSessionCookieHeader(request),
          },
        );
        return;
      }
      if (
        requestUrl.pathname.startsWith("/api/") &&
        requestUrl.pathname !== "/api/download-sources" &&
        !requireAdmin(request, response, config)
      ) {
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
      const gameCoverMatch = requestUrl.pathname.match(
        /^\/api\/games\/(\d+)\/cover$/,
      );
      if (request.method === "GET" && gameCoverMatch) {
        const game = withDatabase(config.dbPath, (database) =>
          database
            .prepare("SELECT id, image_url, source_url FROM games WHERE id = ?")
            .get(Number(gameCoverMatch[1])),
        );
        if (!game?.image_url) {
          sendError(response, 404, "该游戏没有可用封面");
          return;
        }
        let cached;
        try {
          cached = await cacheCoverImage({
            gameId: game.id,
            imageUrl: game.image_url,
            referer: game.source_url,
            cacheDirectory: config.coverCacheDir,
            publicBaseUrl: config.publicBaseUrl,
          });
        } catch (error) {
          if (error.code === "COVER_NOT_FOUND") {
            withDatabase(config.dbPath, (database) =>
              database.markGameImageMissing(game.id, new Date().toISOString()),
            );
          }
          throw error;
        }
        serveCachedCover(
          new URL(cached.publicUrl),
          response,
          config.coverCacheDir,
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
      if (request.method === "GET" && requestUrl.pathname === "/api/logs") {
        sendJson(
          response,
          200,
          withDatabase(config.dbPath, (database) =>
            listRecentTaskErrors(database, requestUrl),
          ),
        );
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/task-logs"
      ) {
        sendJson(
          response,
          200,
          withDatabase(config.dbPath, (database) =>
            taskOperationLogs(database, requestUrl),
          ),
        );
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/admin/api-keys"
      ) {
        if (
          dashboardAuthEnabled(config) &&
          !request.dashboardSession
        ) {
          sendError(response, 403, "仅后台登录会话可以查看明文 Key");
          return;
        }
        const keySettings = withDatabase(config.dbPath, (database) => {
          const xianyuApiKey = database
            .prepare(
              "SELECT xianyu_api_key, updated_at FROM service_credentials WHERE id = 1",
            )
            .get();
          const downloadKeys = database
            .prepare(
              "SELECT id, name, api_key, created_at FROM download_api_keys ORDER BY created_at, id",
            )
            .all();
          return {
            xianyu: {
              configured: Boolean(xianyuApiKey?.xianyu_api_key),
              maskedValue: maskApiKey(xianyuApiKey?.xianyu_api_key),
              updatedAt: xianyuApiKey?.updated_at ?? null,
            },
            downloadKeys: downloadKeys.map((item) => ({
              id: item.id,
              name: item.name,
              value: item.api_key,
              createdAt: item.created_at,
            })),
          };
        });
        sendJson(response, 200, keySettings);
        return;
      }
      if (
        request.method === "PUT" &&
        requestUrl.pathname === "/api/admin/api-keys/xianyu"
      ) {
        if (dashboardAuthEnabled(config) && !request.dashboardSession) {
          sendError(response, 403, "仅后台登录会话可以修改闲鱼 API Key");
          return;
        }
        const body = await readJsonBody(request);
        const apiKey = String(body.api_key ?? "").trim();
        if (apiKey.length < 16 || apiKey.length > 500) {
          sendError(response, 422, "闲鱼 API Key 长度必须在 16 到 500 个字符之间");
          return;
        }
        if (!handlers.updateXianyuApiKey) {
          sendError(response, 503, "闲鱼密钥服务尚未启用");
          return;
        }
        await handlers.updateXianyuApiKey(apiKey);
        config.xianyuApiKey = apiKey;
        sendJson(response, 200, {
          success: true,
          configured: true,
          maskedValue: maskApiKey(apiKey),
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/admin/api-keys/download"
      ) {
        if (dashboardAuthEnabled(config) && !request.dashboardSession) {
          sendError(response, 403, "仅后台登录会话可以新增 Gamer520 API Key");
          return;
        }
        const body = await readJsonBody(request);
        const name = String(body.name ?? "").trim();
        const apiKey =
          String(body.api_key ?? "").trim() ||
          `g5k_${randomBytes(24).toString("base64url")}`;
        if (!name || name.length > 80) {
          sendError(response, 422, "Key 名称不能为空且不能超过 80 个字符");
          return;
        }
        if (apiKey.length < 16 || apiKey.length > 500) {
          sendError(response, 422, "API Key 长度必须在 16 到 500 个字符之间");
          return;
        }
        const item = {
          id: randomUUID(),
          name,
          value: apiKey,
          createdAt: new Date().toISOString(),
        };
        const database = new CrawlerDatabase(config.dbPath);
        try {
          database.addDownloadApiKey({
            id: item.id,
            name: item.name,
            apiKey: item.value,
            createdAt: item.createdAt,
          });
        } finally {
          database.close();
        }
        sendJson(response, 200, { success: true, item });
        return;
      }
      const downloadKeyMatch = requestUrl.pathname.match(
        /^\/api\/admin\/api-keys\/download\/([^/]+)$/,
      );
      if (request.method === "DELETE" && downloadKeyMatch) {
        if (dashboardAuthEnabled(config) && !request.dashboardSession) {
          sendError(response, 403, "仅后台登录会话可以删除 Gamer520 API Key");
          return;
        }
        const database = new CrawlerDatabase(config.dbPath);
        let deleted;
        try {
          deleted = database.deleteDownloadApiKey(
            decodeURIComponent(downloadKeyMatch[1]),
          );
        } finally {
          database.close();
        }
        if (!deleted) {
          sendError(response, 404, "API Key 不存在");
          return;
        }
        sendJson(response, 200, { success: true });
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/settings/xianyu"
      ) {
        const requestedAccountId = String(
          requestUrl.searchParams.get("accountId") ?? "",
        ).trim();
        const settingsPayload = withDatabase(config.dbPath, (database) => {
          const globalSettings = database
            .prepare(
              `SELECT account_id, default_price, default_stock, publish_mode,
                      title_template, description_template, image_template,
                      updated_at
               FROM xianyu_sync_settings WHERE id = 1`,
            )
            .get();
          const accountSettings = requestedAccountId
            ? database
                .prepare(
                  `SELECT account_id, default_price, default_stock, publish_mode,
                          title_template, description_template, image_template,
                          publish_options, updated_at
                   FROM xianyu_account_settings WHERE account_id = ?`,
                )
                .get(requestedAccountId)
            : null;
          const settings = {
            ...(accountSettings ?? globalSettings ?? {}),
            account_id:
              requestedAccountId ||
              accountSettings?.account_id ||
              globalSettings?.account_id ||
              null,
          };
          const preview = database
            .prepare(`
              SELECT
                games.id,
                games.title,
                games.description,
                games.image_url,
                GROUP_CONCAT(DISTINCT downloads.provider) AS providers
              FROM games
              JOIN downloads ON downloads.game_id = games.id
              WHERE ${VALID_GAME_DATA_CONDITION}
              GROUP BY games.id
              ORDER BY games.hot_rank ASC, games.id ASC
              LIMIT 1
            `)
            .get();
          return { settings, preview };
        });
        const settings = settingsPayload.settings;
        const preview = settingsPayload.preview;
        sendJson(response, 200, {
          ...mapXianyuSettings(settings),
          configured: Boolean(settings.account_id),
          preview: preview
            ? {
                id: preview.id,
                title: preview.title,
                description: preview.description,
                imageUrl: `/api/games/${preview.id}/cover`,
                cloudDrives: String(preview.providers ?? "")
                  .split(",")
                  .filter(Boolean)
                  .join(" / "),
              }
            : null,
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
            concurrency: Number(state.concurrency ?? 3),
          },
          sync: {
            enabled: Boolean(state.sync?.enabled),
            accountIds: state.sync?.accountIds ?? [],
            nextRun: state.sync?.nextRun ?? null,
            active: Boolean(state.sync?.active),
            interrupted: Boolean(state.sync?.interrupted),
            deferred: Boolean(state.sync?.deferred),
            deferredCount: Number(state.sync?.deferredCount ?? 0),
            tasks: (state.sync?.tasks ?? []).map((task) => ({
              accountId: task.accountId,
              enabled: Boolean(task.enabled),
              cronSchedule: task.cronSchedule,
              mode: task.mode ?? "all",
              gameIds: task.gameIds ?? [],
              nextRun: task.nextRun ?? null,
              materialConcurrency: Number(task.materialConcurrency ?? 4),
              publishBatchSize: Number(task.publishBatchSize ?? 20),
              publishLimit: Number(task.publishLimit ?? 0),
              sort: task.sort ?? "created",
            })),
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
          crawlConcurrency: body.crawl?.concurrency,
          syncTasks: Array.isArray(body.sync?.tasks)
            ? body.sync.tasks.map((task) => ({
                accountId: task.account_id,
                enabled: task.enabled,
                cronSchedule: task.cron_schedule,
                mode: task.mode,
                gameIds: task.selected_game_ids,
                materialConcurrency: task.material_concurrency,
                publishBatchSize: task.publish_batch_size,
                publishLimit: task.publish_limit,
                sort: task.sort,
              }))
            : undefined,
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
        request.method === "GET" &&
        requestUrl.pathname === "/api/xianyu/cards"
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
        if (!handlers.listXianyuCards) {
          sendError(response, 503, "闲鱼卡券服务尚未启用");
          return;
        }
        const cards = await handlers.listXianyuCards();
        sendJson(response, 200, { items: cards });
        return;
      }
      if (
        request.method === "GET" &&
        requestUrl.pathname === "/api/xianyu/accounts/capability"
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
        const accountId = String(
          requestUrl.searchParams.get("accountId") ?? "",
        ).trim();
        if (!accountId) {
          sendError(response, 422, "请选择要识别类型的闲鱼账号");
          return;
        }
        if (!handlers.getXianyuAccountPublishCapability) {
          sendError(response, 503, "闲鱼账号能力服务尚未启用");
          return;
        }
        const capability = await handlers.getXianyuAccountPublishCapability(
          accountId,
        );
        sendJson(response, 200, capability);
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/xianyu/items/sync"
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
        if (!accountId) {
          sendError(response, 422, "请选择要核对发布状态的闲鱼账号");
          return;
        }
        const state = runtimeState();
        if (state.active || state.sync?.active) {
          sendError(response, 409, "采集或同步任务正在运行");
          return;
        }
        if (!handlers.syncXianyuPublishedItems) {
          sendError(response, 503, "闲鱼商品同步服务尚未启用");
          return;
        }
        const result = await handlers.syncXianyuPublishedItems(accountId);
        sendJson(response, 200, {
          success: true,
          message: `闲鱼状态核对完成：素材确认 ${result.materialConfirmedCount ?? 0} 个，失效 ${result.materialResetCount ?? 0} 个；商品确认发布 ${result.confirmedCount} 个（名称匹配 ${result.titleMatchedCount} 个），回退素材库 ${result.materialFallbackCount} 个`,
          ...result,
        });
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
        if (!accountId) {
          sendError(response, 422, "请选择要保存商品配置的闲鱼账号");
          return;
        }
        let defaultPrice;
        const database = new CrawlerDatabase(config.dbPath);
        let templates;
        let defaultStock;
        let saved;
        const publishMode = "account-auto";
        try {
          const current = database.getXianyuSyncSettings(accountId);
          defaultPrice = salePrice(
            body.default_price ?? current.default_price,
          );
          defaultStock = stockQuantity(
            body.default_stock ?? current.default_stock,
          );
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
            defaultStock,
            "batch",
            body.publish_options ?? current.publish_options,
          );
          saved = database.getXianyuSyncSettings(accountId);
        } finally {
          database.close();
        }
        sendJson(response, 200, {
          success: true,
          defaultPrice,
          defaultStock,
          publishMode,
          ...templates,
          ...mapXianyuSettings(saved),
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
        sendJson(response, 200, {
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
        const accountIds = body.account_ids ?? state.sync?.accountIds ?? [];
        const accountOptions =
          Array.isArray(accountIds) && accountIds.length > 0
            ? { accountIds }
            : {};
        const useConfiguredTask = body.use_configured_task === true;
        let mode = syncMode(body.mode);
        let configuredTask = null;
        if (useConfiguredTask) {
          if (!Array.isArray(accountIds) || accountIds.length !== 1) {
            sendError(response, 422, "请指定一个已设定同步任务的发布账号");
            return;
          }
          configuredTask = (state.sync?.tasks ?? []).find(
            (task) => task.accountId === accountIds[0],
          );
          if (!configuredTask) {
            sendError(response, 422, "该账号尚未设定同步任务");
            return;
          }
          mode = syncMode(configuredTask.mode);
        }
        const configuredTaskOptions = useConfiguredTask
          ? { useConfiguredTask: true, tasks: [configuredTask] }
          : {};
        if (
          mode === "selected-force" &&
          (!(useConfiguredTask ? configuredTask?.gameIds : state.sync?.gameIds)
            ?.length)
        ) {
          sendError(response, 422, "请先配置至少一个自选游戏");
          return;
        }
        const accepted = handlers.triggerSync(
          "manual",
          mode,
          mode === "selected-force"
            ? {
                ...accountOptions,
                ...configuredTaskOptions,
                gameIds: useConfiguredTask
                  ? configuredTask.gameIds
                  : state.sync.gameIds,
              }
            : {
                ...accountOptions,
                ...configuredTaskOptions,
              },
        );
        sendJson(response, 200, {
          success: true,
          message: useConfiguredTask
            ? "已按设定启动同步任务"
            : `${mode === "pending" ? "未发布商品" : mode === "updated" ? "已更新商品" : mode === "selected-force" ? "自选游戏强制发布" : "全部待处理商品"}同步任务已启动`,
          ...accepted,
        });
        return;
      }
      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/games/sync-selected"
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
        const gameIds = selectedGameIds(body.gameIds ?? body.game_ids);
        const accountIds = body.accountIds ?? body.account_ids;
        const validIds = withDatabase(config.dbPath, (database) =>
          database
            .prepare(
              `SELECT games.id
               FROM games
               WHERE games.id IN (${gameIds.map(() => "?").join(", ")})
                 AND ${VALID_GAME_DATA_CONDITION}`,
            )
            .all(...gameIds)
            .map((row) => row.id),
        );
        if (validIds.length !== gameIds.length) {
          const validIdSet = new Set(validIds);
          const invalidIds = gameIds.filter((gameId) => !validIdSet.has(gameId));
          sendError(
            response,
            422,
            `选中的游戏不存在或缺少有效图片、下载资源：${invalidIds.join(", ")}`,
          );
          return;
        }
        const state = runtimeState();
        if (state.active || state.sync?.active) {
          sendError(response, 409, "采集或同步任务正在运行");
          return;
        }
        if (!handlers.triggerSync) {
          sendError(response, 503, "闲鱼同步服务尚未启用");
          return;
        }
        const accepted = handlers.triggerSync("manual-selected", "all", {
          gameIds,
          ...(Array.isArray(accountIds) && accountIds.length > 0
            ? { accountIds }
            : {}),
        });
        sendJson(response, 200, {
          success: true,
          selectedCount: gameIds.length,
          gameIds,
          message: `已启动 ${gameIds.length} 个有效游戏的同步任务`,
          ...accepted,
        });
        return;
      }
      const taskControlMatch = requestUrl.pathname.match(
        /^\/api\/tasks\/(crawl|sync)\/(pause|interrupt|resume|terminate)$/,
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
        const scheduler = await handlers.controlTask(task, action);
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
        const downloadApiKeys = withDatabase(
          config.dbPath,
          (database) =>
            database
              .prepare("SELECT api_key FROM download_api_keys")
              .all()
              .map((item) => item.api_key),
        );
        if (!requireKey(request, response, downloadApiKeys, "X-API-Key")) {
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
      const gameScrapeStatusMatch = requestUrl.pathname.match(
        /^\/api\/games\/(\d+)\/scrape-status$/,
      );
      if (request.method === "PUT" && gameScrapeStatusMatch) {
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
        const status = String(body.status ?? "").trim();
        if (!new Set(["violation", "success"]).has(status)) {
          sendError(response, 422, "仅支持手动标记违规或恢复为采集成功");
          return;
        }
        const gameId = Number(gameScrapeStatusMatch[1]);
        const database = new CrawlerDatabase(config.dbPath);
        let error = null;
        try {
          const game = database.queryOne(
            "SELECT scrape_status FROM games WHERE id = ?",
            gameId,
          );
          if (!game) {
            error = { status: 404, message: "没有找到该游戏" };
          } else if (status === "success" && game.scrape_status !== "violation") {
            error = { status: 422, message: "只有违规游戏可以手动恢复" };
          } else if (
            !database.setGameViolationStatus(
              gameId,
              status,
              new Date().toISOString(),
            )
          ) {
            error = {
              status: 422,
              message: "游戏数据不完整，不能恢复为采集成功",
            };
          }
        } finally {
          database.close();
        }
        if (error) {
          sendError(response, error.status, error.message);
          return;
        }
        sendJson(response, 200, { success: true, gameId, scrapeStatus: status });
        return;
      }
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

      const gameSyncMatch = requestUrl.pathname.match(
        /^\/api\/games\/(\d+)\/sync$/,
      );
      if (request.method === "POST" && gameSyncMatch) {
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
        const accountId = String(
          body.account_id ?? body.accountId ?? "",
        ).trim();
        if (!accountId) {
          sendError(response, 422, "请选择要发布的闲鱼账号");
          return;
        }
        const gameId = Number(gameSyncMatch[1]);
        const game = withDatabase(config.dbPath, (database) =>
          database
            .prepare(
              `SELECT
                 games.id,
                 games.scrape_status
               FROM games
               WHERE games.id = ?`,
            )
            .get(gameId),
        );
        if (!game) {
          sendError(response, 404, "没有找到该游戏");
          return;
        }
        if (game.scrape_status !== "success") {
          sendError(response, 422, "该游戏采集状态不是成功，不能同步");
          return;
        }
        const state = runtimeState();
        if (state.active || state.sync?.active) {
          sendError(response, 409, "采集或同步任务正在运行");
          return;
        }
        if (!handlers.triggerSync) {
          sendError(response, 503, "闲鱼同步服务尚未启用");
          return;
        }
        const accepted = handlers.triggerSync(
          "manual-game",
          "all",
          { gameIds: [gameId], accountIds: [accountId] },
        );
        sendJson(response, 200, {
          success: true,
          gameId,
          accountId,
          message: `游戏 ${gameId} 已向账号 ${accountId} 启动同步`,
          ...accepted,
        });
        return;
      }

      const gameMatch = requestUrl.pathname.match(
        /^\/api\/games\/(\d+)$/,
      );
      if (request.method === "GET" && gameMatch) {
        const detail = withDatabase(config.dbPath, (database) =>
          gameDetail(
            database,
            Number(gameMatch[1]),
            requestUrl.searchParams.get("accountId"),
          ),
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
