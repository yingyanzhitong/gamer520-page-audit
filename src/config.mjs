import path from "node:path";

function integerValue(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function booleanValue(value, fallback) {
  if (value == null || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value);
}

function stringValue(value, fallback = "") {
  const normalized = String(value ?? "").trim();
  return normalized || fallback;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const dbPath =
    overrides.dbPath ??
    env.DB_PATH ??
    path.resolve("data/gamer520.sqlite");
  const channel =
    overrides.playwrightChannel ??
    env.PLAYWRIGHT_CHANNEL ??
    (process.platform === "darwin" ? "chrome" : "chromium");

  const config = {
    listUrl:
      overrides.listUrl ??
      env.LIST_URL ??
      "https://www.gamer520.com/pcplay?order=hot",
    pageCount: integerValue(
      overrides.pageCount ?? env.PAGE_COUNT,
      50,
      { min: 1, max: 50 },
    ),
    detailConcurrency: integerValue(
      overrides.detailConcurrency ?? env.DETAIL_CONCURRENCY,
      3,
      { min: 1, max: 12 },
    ),
    maxRetries: integerValue(
      overrides.maxRetries ?? env.MAX_RETRIES,
      2,
      { min: 0, max: 5 },
    ),
    navigationTimeoutMs: integerValue(
      overrides.navigationTimeoutMs ?? env.NAVIGATION_TIMEOUT_MS,
      30_000,
      { min: 5_000, max: 120_000 },
    ),
    listDelayMs: integerValue(
      overrides.listDelayMs ?? env.LIST_DELAY_MS,
      250,
      { min: 0, max: 10_000 },
    ),
    detailDelayMinMs: integerValue(
      overrides.detailDelayMinMs ?? env.DETAIL_DELAY_MIN_MS,
      750,
      { min: 0, max: 60_000 },
    ),
    detailDelayMaxMs: integerValue(
      overrides.detailDelayMaxMs ?? env.DETAIL_DELAY_MAX_MS,
      1_500,
      { min: 0, max: 60_000 },
    ),
    accessBlockThreshold: integerValue(
      overrides.accessBlockThreshold ?? env.ACCESS_BLOCK_THRESHOLD,
      10,
      { min: 1, max: 100 },
    ),
    dbPath,
    cronSchedule:
      overrides.cronSchedule ?? env.CRON_SCHEDULE ?? "0 3 * * *",
    cronTimezone:
      overrides.cronTimezone ?? env.CRON_TIMEZONE ?? "Asia/Shanghai",
    runOnStart: booleanValue(
      overrides.runOnStart ?? env.RUN_ON_START,
      true,
    ),
    crawlEnabled: booleanValue(
      overrides.crawlEnabled ?? env.CRAWL_ENABLED,
      true,
    ),
    headless:
      overrides.headless ??
      (env.SHOW_BROWSER !== "1" &&
        booleanValue(env.HEADLESS, true)),
    playwrightChannel: channel,
    dashboardHost:
      overrides.dashboardHost ??
      env.DASHBOARD_HOST ??
      "0.0.0.0",
    dashboardPort: integerValue(
      overrides.dashboardPort ?? env.DASHBOARD_PORT,
      3_000,
      { min: 1, max: 65_535 },
    ),
    dashboardAdminUsername: stringValue(
      overrides.dashboardAdminUsername ??
        env.DASHBOARD_ADMIN_USERNAME,
      "admin",
    ),
    dashboardAdminPassword: stringValue(
      overrides.dashboardAdminPassword ??
        env.DASHBOARD_ADMIN_PASSWORD,
    ),
    dashboardSessionSecret: stringValue(
      overrides.dashboardSessionSecret ??
        env.DASHBOARD_SESSION_SECRET,
    ),
    dashboardSessionTtlSeconds: integerValue(
      overrides.dashboardSessionTtlSeconds ??
        env.DASHBOARD_SESSION_TTL_SECONDS,
      12 * 60 * 60,
      { min: 15 * 60, max: 7 * 24 * 60 * 60 },
    ),
    xianyuBaseUrl: stringValue(
      overrides.xianyuBaseUrl ?? env.XIANYU_BASE_URL,
      "https://xianyu.xyyamsz.cn",
    ).replace(/\/+$/, ""),
    xianyuApiKey: stringValue(
      overrides.xianyuApiKey ?? env.XIANYU_API_KEY,
    ),
    downloadReadApiKey: stringValue(
      overrides.downloadReadApiKey ?? env.GAMER520_READ_API_KEY,
    ),
    publicBaseUrl: stringValue(
      overrides.publicBaseUrl ?? env.PUBLIC_BASE_URL,
      "https://gamer520.xyyamsz.cn",
    ).replace(/\/+$/, ""),
    coverCacheDir:
      overrides.coverCacheDir ??
      env.COVER_CACHE_DIR ??
      path.join(path.dirname(dbPath), "covers"),
    coverCacheEnabled: booleanValue(
      overrides.coverCacheEnabled ?? env.COVER_CACHE_ENABLED,
      true,
    ),
    syncCronSchedule:
      overrides.syncCronSchedule ??
      env.SYNC_CRON_SCHEDULE ??
      "0 */6 * * *",
    syncPollIntervalMs: integerValue(
      overrides.syncPollIntervalMs ?? env.SYNC_POLL_INTERVAL_MS,
      10_000,
      { min: 1_000, max: 60_000 },
    ),
    syncBatchTimeoutMs: integerValue(
      overrides.syncBatchTimeoutMs ?? env.SYNC_BATCH_TIMEOUT_MS,
      2 * 60 * 60 * 1_000,
      { min: 60_000, max: 6 * 60 * 60 * 1_000 },
    ),
    syncEnabled: booleanValue(
      overrides.syncEnabled ?? env.SYNC_ENABLED,
      true,
    ),
  };

  const listUrl = new URL(config.listUrl);
  if (
    !/(^|\.)gamer520\.com$/i.test(listUrl.hostname) ||
    !/^\/pcplay\/?$/.test(listUrl.pathname) ||
    listUrl.searchParams.get("order") !== "hot"
  ) {
    throw new Error(
      "LIST_URL 必须是 gamer520.com/pcplay?order=hot",
    );
  }

  if (config.detailDelayMaxMs < config.detailDelayMinMs) {
    config.detailDelayMaxMs = config.detailDelayMinMs;
  }

  const xianyuUrl = new URL(config.xianyuBaseUrl);
  if (!["http:", "https:"].includes(xianyuUrl.protocol)) {
    throw new Error("XIANYU_BASE_URL 必须是 HTTP/HTTPS 地址");
  }
  const publicUrl = new URL(config.publicBaseUrl);
  if (!["http:", "https:"].includes(publicUrl.protocol)) {
    throw new Error("PUBLIC_BASE_URL 必须是 HTTP/HTTPS 地址");
  }
  if (
    env.NODE_ENV === "production" &&
    (!config.dashboardAdminPassword ||
      !config.dashboardSessionSecret)
  ) {
    throw new Error(
      "生产环境必须配置 DASHBOARD_ADMIN_PASSWORD 和 DASHBOARD_SESSION_SECRET",
    );
  }

  return config;
}

export function publicConfig(config) {
  return {
    listUrl: config.listUrl,
    pageCount: config.pageCount,
    detailConcurrency: config.detailConcurrency,
    maxRetries: config.maxRetries,
    navigationTimeoutMs: config.navigationTimeoutMs,
    cronSchedule: config.cronSchedule,
    cronTimezone: config.cronTimezone,
    runOnStart: config.runOnStart,
    crawlEnabled: config.crawlEnabled,
    headless: config.headless,
    playwrightChannel: config.playwrightChannel,
    dbPath: config.dbPath,
    dashboardHost: config.dashboardHost,
    dashboardPort: config.dashboardPort,
    dashboardAuthConfigured: Boolean(
      config.dashboardAdminPassword &&
        config.dashboardSessionSecret,
    ),
    xianyuBaseUrl: config.xianyuBaseUrl,
    xianyuConfigured: Boolean(config.xianyuApiKey),
    downloadReadApiConfigured: Boolean(config.downloadReadApiKey),
    publicBaseUrl: config.publicBaseUrl,
    coverCacheEnabled: config.coverCacheEnabled,
    syncCronSchedule: config.syncCronSchedule,
    syncEnabled: config.syncEnabled,
  };
}
