import { Cron } from "croner";

import { loadConfig } from "./config.mjs";
import { runCrawl } from "./crawler.mjs";
import { CrawlerDatabase } from "./database.mjs";
import { startDashboardServer } from "./dashboard-server.mjs";
import { XianyuSyncService } from "./sync-service.mjs";
import { nowIso, serializeError } from "./utils.mjs";

const config = loadConfig();
let activeRun = null;
let activeSync = null;
let deferredSync = null;
let deferredCrawl = null;
let stopping = false;
let dashboard;
let crawlJob = null;
let syncJob = null;
let schedulerSettings;
const syncService = new XianyuSyncService(config);

function log(event, fields = {}) {
  console.log(
    JSON.stringify({
      timestamp: nowIso(),
      event,
      ...fields,
    }),
  );
}

function settingsFromRow(row) {
  return {
    cronTimezone: row.cron_timezone,
    crawlCronSchedule: row.crawl_cron_schedule,
    crawlEnabled: Boolean(row.crawl_enabled),
    syncCronSchedule: row.sync_cron_schedule,
    syncEnabled: Boolean(row.sync_enabled),
    updatedAt: row.updated_at,
  };
}

function normalizeScheduleSettings(input) {
  const normalized = {
    cronTimezone: String(input.cronTimezone ?? "").trim(),
    crawlCronSchedule: String(input.crawlCronSchedule ?? "").trim(),
    crawlEnabled: input.crawlEnabled,
    syncCronSchedule: String(input.syncCronSchedule ?? "").trim(),
    syncEnabled: input.syncEnabled,
  };
  if (
    !normalized.cronTimezone ||
    normalized.cronTimezone.length > 80
  ) {
    const error = new Error("任务时区不能为空且不能超过 80 个字符");
    error.statusCode = 422;
    throw error;
  }
  if (
    !normalized.crawlCronSchedule ||
    normalized.crawlCronSchedule.length > 100 ||
    !normalized.syncCronSchedule ||
    normalized.syncCronSchedule.length > 100
  ) {
    const error = new Error("Cron 表达式不能为空且不能超过 100 个字符");
    error.statusCode = 422;
    throw error;
  }
  if (
    typeof normalized.crawlEnabled !== "boolean" ||
    typeof normalized.syncEnabled !== "boolean"
  ) {
    const error = new Error("任务启用状态必须是布尔值");
    error.statusCode = 422;
    throw error;
  }
  try {
    new Intl.DateTimeFormat("zh-CN", {
      timeZone: normalized.cronTimezone,
    }).format(new Date());
  } catch {
    const error = new Error("任务时区无效");
    error.statusCode = 422;
    throw error;
  }
  return normalized;
}

function triggerCrawl(reason) {
  if (
    stopping ||
    (reason.startsWith("schedule") && !schedulerSettings.crawlEnabled)
  ) {
    return null;
  }
  if (activeRun) {
    log("schedule_skipped", {
      reason,
      message: "已有采集任务正在运行",
    });
    return activeRun;
  }
  if (activeSync) {
    deferredCrawl = reason;
    log("crawl_deferred", {
      reason,
      message: "闲鱼同步任务正在运行，采集将在同步结束后补跑",
    });
    return activeSync;
  }

  activeRun = runCrawl({ trigger: reason })
    .catch((error) => {
      log("scheduled_crawl_failed", {
        reason,
        error: serializeError(error),
      });
    })
    .finally(() => {
      activeRun = null;
      if (deferredSync && !stopping) {
        const deferred = deferredSync;
        deferredSync = null;
        void triggerSync(deferred.reason);
      }
    });
  return activeRun;
}

function triggerSync(reason) {
  if (
    stopping ||
    (reason.startsWith("schedule") && !schedulerSettings.syncEnabled)
  ) {
    return null;
  }
  if (activeSync) {
    log("sync_skipped", {
      reason,
      message: "已有闲鱼同步任务正在运行",
    });
    return activeSync;
  }
  if (activeRun) {
    deferredSync = { reason: `${reason}-deferred` };
    log("sync_deferred", {
      reason,
      message: "采集任务正在运行，闲鱼同步将在采集结束后补跑",
    });
    return activeRun;
  }

  activeSync = syncService
    .run({ trigger: reason })
    .then((result) => {
      log("xianyu_sync_completed", result);
      return result;
    })
    .catch((error) => {
      log("xianyu_sync_failed", {
        reason,
        error: serializeError(error),
      });
    })
    .finally(() => {
      activeSync = null;
      if (deferredCrawl && !stopping) {
        const deferred = deferredCrawl;
        deferredCrawl = null;
        void triggerCrawl(deferred);
      }
    });
  return activeSync;
}

function buildScheduledJobs(settings) {
  let nextCrawlJob = null;
  let nextSyncJob = null;
  try {
    if (settings.crawlEnabled) {
      nextCrawlJob = new Cron(
        settings.crawlCronSchedule,
        { timezone: settings.cronTimezone },
        () => {
          void triggerCrawl("schedule");
        },
      );
    }
    if (settings.syncEnabled) {
      nextSyncJob = new Cron(
        settings.syncCronSchedule,
        { timezone: settings.cronTimezone },
        () => {
          void triggerSync("schedule");
        },
      );
    }
    return {
      crawlJob: nextCrawlJob,
      syncJob: nextSyncJob,
    };
  } catch (cause) {
    nextCrawlJob?.stop();
    nextSyncJob?.stop();
    const error = new Error(`Cron 配置无效：${cause.message}`);
    error.statusCode = 422;
    throw error;
  }
}

function replaceScheduledJobs(settings, jobs = buildScheduledJobs(settings)) {
  crawlJob?.stop();
  syncJob?.stop();
  crawlJob = jobs.crawlJob;
  syncJob = jobs.syncJob;
  schedulerSettings = settings;
}

function updateScheduleSettings(input) {
  const normalized = normalizeScheduleSettings(input);
  const jobs = buildScheduledJobs(normalized);
  const updatedAt = nowIso();
  const database = new CrawlerDatabase(config.dbPath);
  let saved;
  try {
    saved = database.setSchedulerSettings(normalized, updatedAt);
  } catch (error) {
    jobs.crawlJob?.stop();
    jobs.syncJob?.stop();
    throw error;
  } finally {
    database.close();
  }
  replaceScheduledJobs(settingsFromRow(saved), jobs);
  log("scheduler_settings_updated", {
    cronTimezone: schedulerSettings.cronTimezone,
    crawlCronSchedule: schedulerSettings.crawlCronSchedule,
    crawlEnabled: schedulerSettings.crawlEnabled,
    syncCronSchedule: schedulerSettings.syncCronSchedule,
    syncEnabled: schedulerSettings.syncEnabled,
  });
  return scheduleRuntime();
}

function scheduleRuntime() {
  return {
    active: Boolean(activeRun),
    enabled: schedulerSettings.crawlEnabled,
    cronSchedule: schedulerSettings.crawlCronSchedule,
    cronTimezone: schedulerSettings.cronTimezone,
    runOnStart: config.runOnStart,
    nextRun: crawlJob?.nextRun()?.toISOString() ?? null,
    updatedAt: schedulerSettings.updatedAt,
    sync: {
      active: Boolean(activeSync),
      enabled: schedulerSettings.syncEnabled,
      deferred: Boolean(deferredSync),
      cronSchedule: schedulerSettings.syncCronSchedule,
      cronTimezone: schedulerSettings.cronTimezone,
      nextRun: syncJob?.nextRun()?.toISOString() ?? null,
      batchSize: config.syncRunLimit,
    },
  };
}

const database = new CrawlerDatabase(config.dbPath);
database.markInterruptedRuns(nowIso());
schedulerSettings = settingsFromRow(
  database.getSchedulerSettings(
    {
      cronTimezone: config.cronTimezone,
      crawlCronSchedule: config.cronSchedule,
      crawlEnabled: config.crawlEnabled,
      syncCronSchedule: config.syncCronSchedule,
      syncEnabled: config.syncEnabled,
    },
    nowIso(),
  ),
);
database.close();
replaceScheduledJobs(schedulerSettings);

dashboard = await startDashboardServer(config, scheduleRuntime, {
  listXianyuAccounts: () => syncService.listAccounts(),
  validateXianyuAccount: (accountId) =>
    syncService.validateAccount(accountId),
  updateScheduleSettings,
  triggerCrawl: (reason) => {
    void triggerCrawl(reason);
    return { active: true, mode: "full" };
  },
  triggerSync: (reason) => {
    void triggerSync(reason);
    return { active: true, mode: "full" };
  },
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  crawlJob?.stop();
  syncJob?.stop();
  log("scheduler_stopping", { signal });
  await Promise.allSettled(
    [activeRun, activeSync].filter(Boolean),
  );
  await dashboard.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

log("scheduler_started", {
  cronSchedule: schedulerSettings.crawlCronSchedule,
  cronTimezone: schedulerSettings.cronTimezone,
  crawlEnabled: schedulerSettings.crawlEnabled,
  runOnStart: config.runOnStart,
  nextRun: crawlJob?.nextRun()?.toISOString() ?? null,
  syncEnabled: schedulerSettings.syncEnabled,
  syncCronSchedule: schedulerSettings.syncCronSchedule,
  syncNextRun: syncJob?.nextRun()?.toISOString() ?? null,
  dashboard: `http://${config.dashboardHost}:${config.dashboardPort}`,
});

if (config.runOnStart && schedulerSettings.crawlEnabled) {
  await triggerCrawl("startup");
}
