import { Cron } from "croner";

import { loadConfig } from "./config.mjs";
import { runCrawl } from "./crawler.mjs";
import { CrawlerDatabase } from "./database.mjs";
import { startDashboardServer } from "./dashboard-server.mjs";
import {
  materialSyncConcurrency,
  publishBatchSize,
  XianyuSyncService,
} from "./sync-service.mjs";
import { TaskControl } from "./task-control.mjs";
import { nowIso, serializeError } from "./utils.mjs";

const config = loadConfig();
let activeRun = null;
let activeSync = null;
let crawlControl = null;
let syncControl = null;
let syncProgress = null;
let deferredSyncs = [];
let deferredCrawl = null;
let stopping = false;
let dashboard;
let crawlJob = null;
let syncJobs = new Map();
let schedulerSettings;
let syncService;

function parseSyncGameIds(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed
        .map((gameId) => Number(gameId))
        .filter((gameId) => Number.isSafeInteger(gameId) && gameId > 0),
    ),
  ];
}

function parseSyncAccountIds(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [
    ...new Set(
      parsed
        .map((accountId) => String(accountId ?? "").trim())
        .filter(Boolean),
    ),
  ];
}

function parseSyncTasks(value, legacy = {}) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = [];
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    parsed = parseSyncAccountIds(legacy.accountIds).map((accountId) => ({
      accountId,
      enabled: legacy.enabled,
      cronSchedule: legacy.cronSchedule,
      mode: legacy.mode,
      gameIds: legacy.gameIds,
      materialConcurrency: legacy.materialConcurrency,
      publishBatchSize: legacy.publishBatchSize,
      publishLimit: legacy.publishLimit,
      sort: legacy.sort,
    }));
  }
  return parsed.map((task) => ({
    accountId: String(task?.accountId ?? "").trim(),
    enabled: Boolean(task?.enabled),
    cronSchedule: String(task?.cronSchedule ?? "").trim(),
    mode: String(task?.mode ?? "all").trim(),
    gameIds: parseSyncGameIds(task?.gameIds),
    materialConcurrency: Number(task?.materialConcurrency ?? 4),
    publishBatchSize: Number(task?.publishBatchSize ?? publishBatchSize),
    publishLimit: Number(task?.publishLimit ?? 0),
    sort: String(task?.sort ?? "created").trim(),
  }));
}

function syncGameIdsValue(value) {
  if (!Array.isArray(value)) {
    const error = new Error("自选游戏必须是游戏 ID 数组");
    error.statusCode = 422;
    throw error;
  }
  const gameIds = parseSyncGameIds(value);
  if (gameIds.length !== value.length) {
    const error = new Error("自选游戏 ID 必须是正整数");
    error.statusCode = 422;
    throw error;
  }
  if (gameIds.length > 1_000) {
    const error = new Error("自选游戏最多 1000 个");
    error.statusCode = 422;
    throw error;
  }
  return gameIds;
}

function syncAccountIdsValue(value) {
  if (!Array.isArray(value)) {
    const error = new Error("发布账号必须是账号 ID 数组");
    error.statusCode = 422;
    throw error;
  }
  const accountIds = parseSyncAccountIds(value);
  if (
    accountIds.length !== value.length ||
    accountIds.some((accountId) => accountId.length > 80)
  ) {
    const error = new Error("发布账号 ID 不能为空且不能超过 80 个字符");
    error.statusCode = 422;
    throw error;
  }
  if (accountIds.length > 20) {
    const error = new Error("一次手动同步最多选择 20 个发布账号");
    error.statusCode = 422;
    throw error;
  }
  return accountIds;
}

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
  const legacySync = {
    accountIds: row.sync_account_ids,
    enabled: Boolean(row.sync_enabled),
    cronSchedule: row.sync_cron_schedule,
    mode: row.sync_mode ?? "all",
    gameIds: parseSyncGameIds(row.sync_game_ids),
    materialConcurrency: Number(row.material_concurrency),
    publishBatchSize: Number(row.publish_batch_size),
    publishLimit: Number(row.sync_publish_limit ?? 0),
    sort: row.sync_sort ?? "created",
  };
  const syncTasks = parseSyncTasks(row.sync_tasks, legacySync);
  const primarySyncTask = syncTasks[0] ?? legacySync;
  return {
    cronTimezone: row.cron_timezone,
    crawlCronSchedule: row.crawl_cron_schedule,
    crawlEnabled: Boolean(row.crawl_enabled),
    syncCronSchedule: primarySyncTask.cronSchedule,
    syncEnabled: syncTasks.some((task) => task.enabled),
    syncMode: primarySyncTask.mode,
    syncGameIds: primarySyncTask.gameIds,
    syncAccountIds: syncTasks.map((task) => task.accountId),
    syncTasks,
    crawlConcurrency: Number(row.crawl_concurrency),
    materialConcurrency: primarySyncTask.materialConcurrency,
    publishBatchSize: primarySyncTask.publishBatchSize,
    publishLimit: primarySyncTask.publishLimit,
    syncSort: primarySyncTask.sort,
    publishConcurrency: Number(row.publish_concurrency),
    updatedAt: row.updated_at,
  };
}

function concurrencyValue(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
    const error = new Error(`${label}必须是 1 到 12 之间的整数`);
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function publishBatchSizeValue(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 20) {
    const error = new Error("每批发布商品数必须是 1 到 20 之间的整数");
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function publishLimitValue(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100_000) {
    const error = new Error("单次定时发布成功上限必须是 0 到 100000 之间的整数");
    error.statusCode = 422;
    throw error;
  }
  return parsed;
}

function syncTasksValue(value) {
  if (!Array.isArray(value)) {
    const error = new Error("账号同步任务必须是数组");
    error.statusCode = 422;
    throw error;
  }
  if (value.length > 20) {
    const error = new Error("最多配置 20 个账号同步任务");
    error.statusCode = 422;
    throw error;
  }
  const tasks = value.map((task) => {
    const accountId = String(task?.accountId ?? "").trim();
    const enabled = task?.enabled;
    const cronSchedule = String(task?.cronSchedule ?? "").trim();
    const mode = String(task?.mode ?? "").trim();
    const gameIds = syncGameIdsValue(task?.gameIds ?? []);
    const sort = String(task?.sort ?? "created").trim();
    if (!accountId || accountId.length > 80) {
      const error = new Error("发布账号 ID 不能为空且不能超过 80 个字符");
      error.statusCode = 422;
      throw error;
    }
    if (typeof enabled !== "boolean") {
      const error = new Error(`账号 ${accountId} 的任务启用状态必须是布尔值`);
      error.statusCode = 422;
      throw error;
    }
    if (!cronSchedule || cronSchedule.length > 100) {
      const error = new Error(`账号 ${accountId} 的 Cron 表达式不能为空且不能超过 100 个字符`);
      error.statusCode = 422;
      throw error;
    }
    if (!new Set(["all", "pending", "updated", "selected-force"]).has(mode)) {
      const error = new Error(
        `账号 ${accountId} 的同步范围必须是 all、pending、updated 或 selected-force`,
      );
      error.statusCode = 422;
      throw error;
    }
    if (mode === "selected-force" && gameIds.length === 0) {
      const error = new Error(`账号 ${accountId} 的自选游戏任务至少需要选择一个游戏`);
      error.statusCode = 422;
      throw error;
    }
    if (!new Set(["created", "updated", "hot"]).has(sort)) {
      const error = new Error(
        `账号 ${accountId} 的同步排序必须是 created、updated 或 hot`,
      );
      error.statusCode = 422;
      throw error;
    }
    return {
      accountId,
      enabled,
      cronSchedule,
      mode,
      gameIds,
      materialConcurrency: concurrencyValue(
        task?.materialConcurrency,
        `账号 ${accountId} 的素材导入并行数`,
      ),
      publishBatchSize: publishBatchSizeValue(task?.publishBatchSize),
      publishLimit: publishLimitValue(task?.publishLimit),
      sort,
    };
  });
  const accountIds = tasks.map((task) => task.accountId);
  if (new Set(accountIds).size !== accountIds.length) {
    const error = new Error("同一发布账号只能配置一个同步任务");
    error.statusCode = 422;
    throw error;
  }
  return tasks;
}

function normalizeScheduleSettings(input) {
  const legacyAccountIds = input.syncAccountIds
    ? syncAccountIdsValue(input.syncAccountIds)
    : [];
  const syncTasks = syncTasksValue(
    input.syncTasks ??
      (legacyAccountIds.length > 0
        ? legacyAccountIds.map((accountId) => ({
            accountId,
            enabled: input.syncEnabled,
            cronSchedule: input.syncCronSchedule,
            mode: input.syncMode,
            gameIds: input.syncGameIds,
            materialConcurrency: input.materialConcurrency,
            publishBatchSize: input.publishBatchSize,
            publishLimit: input.publishLimit,
            sort: input.syncSort,
          }))
        : schedulerSettings?.syncTasks ?? []),
  );
  const primarySyncTask = syncTasks[0] ?? {
    cronSchedule: config.syncCronSchedule,
    mode: "all",
    gameIds: [],
    materialConcurrency: materialSyncConcurrency,
    publishBatchSize,
    publishLimit: 0,
    sort: "created",
  };
  const normalized = {
    cronTimezone: String(input.cronTimezone ?? "").trim(),
    crawlCronSchedule: String(input.crawlCronSchedule ?? "").trim(),
    crawlEnabled: input.crawlEnabled,
    syncCronSchedule: primarySyncTask.cronSchedule,
    syncEnabled: syncTasks.some((task) => task.enabled),
    syncMode: primarySyncTask.mode,
    syncGameIds: primarySyncTask.gameIds,
    syncAccountIds: syncTasks.map((task) => task.accountId),
    syncTasks,
    crawlConcurrency: concurrencyValue(
      input.crawlConcurrency,
      "采集并行数",
    ),
    materialConcurrency: primarySyncTask.materialConcurrency,
    publishBatchSize: primarySyncTask.publishBatchSize,
    publishLimit: primarySyncTask.publishLimit,
    syncSort: primarySyncTask.sort,
    publishConcurrency: concurrencyValue(
      input.publishConcurrency ??
        schedulerSettings?.publishConcurrency ??
        4,
      "兼容发布并行数",
    ),
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
    normalized.crawlCronSchedule.length > 100
  ) {
    const error = new Error("Cron 表达式不能为空且不能超过 100 个字符");
    error.statusCode = 422;
    throw error;
  }
  if (
    typeof normalized.crawlEnabled !== "boolean"
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

  crawlControl = new TaskControl();
  const control = crawlControl;
  activeRun = runCrawl({
    trigger: reason,
    control,
    overrides: {
      detailConcurrency: schedulerSettings.crawlConcurrency,
    },
  })
    .catch((error) => {
      log("scheduled_crawl_failed", {
        reason,
        error: serializeError(error),
      });
    })
    .finally(() => {
      activeRun = null;
      if (crawlControl === control) crawlControl = null;
      if (deferredSyncs.length > 0 && !stopping) {
        const deferred = deferredSyncs.shift();
        void triggerSync(
          deferred.reason,
          deferred.mode,
          deferred.options,
        );
      }
    });
  return activeRun;
}

function triggerSync(
  reason,
  mode = schedulerSettings.syncMode,
  options = {},
) {
  if (stopping) {
    return null;
  }
  const accountIds = syncAccountIdsValue(
    options.accountIds ?? schedulerSettings.syncAccountIds,
  );
  if (accountIds.length === 0) {
    if (reason.startsWith("schedule")) {
      log("schedule_skipped", {
        reason,
        message: "未选择发布账号，已跳过闲鱼同步任务",
      });
      return null;
    }
    const error = new Error("请先在任务页面选择至少一个发布账号");
    error.statusCode = 422;
    throw error;
  }
  if (activeSync || activeRun) {
    const duplicate = deferredSyncs.some(
      (deferred) =>
        deferred.reason === reason &&
        deferred.options.accountIds.join("\u0000") === accountIds.join("\u0000"),
    );
    if (!duplicate) {
      deferredSyncs.push({
        reason,
        mode,
        options: { ...options, accountIds },
      });
    }
    log("sync_deferred", {
      reason,
      accountIds,
      queueLength: deferredSyncs.length,
      message: activeRun
        ? "采集任务正在运行，账号同步任务已进入队列"
        : "其他账号同步任务正在运行，当前账号任务已进入队列",
    });
    return activeSync ?? activeRun;
  }

  const configuredTasks = new Map(
    schedulerSettings.syncTasks.map((task) => [task.accountId, task]),
  );
  for (const task of options.tasks ?? []) {
    configuredTasks.set(task.accountId, task);
  }
  const fallbackTask = schedulerSettings.syncTasks[0] ?? {
    enabled: false,
    cronSchedule: schedulerSettings.syncCronSchedule,
    mode: schedulerSettings.syncMode,
    gameIds: schedulerSettings.syncGameIds,
    materialConcurrency: schedulerSettings.materialConcurrency,
    publishBatchSize: schedulerSettings.publishBatchSize,
    publishLimit: schedulerSettings.publishLimit,
    sort: schedulerSettings.syncSort,
  };
  const accountTasks = accountIds.map((accountId) => ({
    ...fallbackTask,
    ...configuredTasks.get(accountId),
    accountId,
  }));
  if (
    reason.startsWith("schedule") &&
    accountTasks.every((task) => !task.enabled)
  ) {
    log("schedule_skipped", {
      reason,
      accountIds,
      message: "账号同步任务已停用",
    });
    return null;
  }

  syncControl = new TaskControl();
  const control = syncControl;
  syncProgress = {
    total: 0,
    completed: 0,
    currentGameId: null,
    currentTitle: null,
    phase: "preparing",
    accountIds,
    accountId: accountIds[0],
    accountIndex: 1,
    accountCount: accountIds.length,
  };
  activeSync = (async () => {
    const results = [];
    for (let index = 0; index < accountIds.length; index += 1) {
      const accountId = accountIds[index];
      const task = accountTasks[index];
      const resolvedMode = reason.startsWith("schedule") ? task.mode : mode;
      const gameIds = Array.isArray(options.gameIds)
        ? options.gameIds
        : resolvedMode === "selected-force"
          ? task.gameIds
          : null;
      const result = await syncService.run({
        trigger: reason,
        mode: resolvedMode,
        gameIds,
        accountId,
        control,
        materialConcurrency: task.materialConcurrency,
        publishBatchSize: task.publishBatchSize,
        candidateSort: task.sort,
        publishLimit: reason.startsWith("schedule")
          ? task.publishLimit
          : 0,
        onProgress: (progress) => {
          syncProgress = {
            ...progress,
            accountIds,
            accountId,
            accountIndex: index + 1,
            accountCount: accountIds.length,
          };
        },
      });
      results.push(result);
    }
    return { accountIds, accounts: results, status: "success" };
  })()
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
      if (syncControl === control) syncControl = null;
      syncProgress = null;
      if (deferredCrawl && !stopping) {
        const deferred = deferredCrawl;
        deferredCrawl = null;
        void triggerCrawl(deferred);
      } else if (deferredSyncs.length > 0 && !stopping) {
        const deferred = deferredSyncs.shift();
        void triggerSync(
          deferred.reason,
          deferred.mode,
          deferred.options,
        );
      }
    });
  return activeSync;
}

function buildScheduledJobs(settings) {
  let nextCrawlJob = null;
  const nextSyncJobs = new Map();
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
    for (const task of settings.syncTasks) {
      if (!task.enabled) continue;
      nextSyncJobs.set(
        task.accountId,
        new Cron(
          task.cronSchedule,
          { timezone: settings.cronTimezone },
          () => {
            void triggerSync(`schedule:${task.accountId}`, task.mode, {
              accountIds: [task.accountId],
              tasks: [task],
            });
          },
        ),
      );
    }
    return {
      crawlJob: nextCrawlJob,
      syncJobs: nextSyncJobs,
    };
  } catch (cause) {
    nextCrawlJob?.stop();
    for (const job of nextSyncJobs.values()) job.stop();
    const error = new Error(`Cron 配置无效：${cause.message}`);
    error.statusCode = 422;
    throw error;
  }
}

function replaceScheduledJobs(settings, jobs = buildScheduledJobs(settings)) {
  crawlJob?.stop();
  for (const job of syncJobs.values()) job.stop();
  crawlJob = jobs.crawlJob;
  syncJobs = jobs.syncJobs;
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
    for (const job of jobs.syncJobs.values()) job.stop();
    throw error;
  } finally {
    database.close();
  }
  replaceScheduledJobs(settingsFromRow(saved), jobs);
  log("scheduler_settings_updated", {
    cronTimezone: schedulerSettings.cronTimezone,
    crawlCronSchedule: schedulerSettings.crawlCronSchedule,
    crawlEnabled: schedulerSettings.crawlEnabled,
    syncTasks: schedulerSettings.syncTasks,
    crawlConcurrency: schedulerSettings.crawlConcurrency,
  });
  return scheduleRuntime();
}

async function updateXianyuApiKey(apiKey) {
  if (activeSync) {
    const error = new Error("同步任务运行中，不能修改闲鱼 API Key");
    error.statusCode = 409;
    throw error;
  }
  const nextService = new XianyuSyncService({
    ...config,
    xianyuApiKey: apiKey,
  });
  await nextService.listAccounts();
  const database = new CrawlerDatabase(config.dbPath);
  try {
    database.setXianyuApiKey(apiKey, nowIso());
  } finally {
    database.close();
  }
  config.xianyuApiKey = apiKey;
  syncService = nextService;
  log("xianyu_api_key_updated");
}

async function controlTask(task, action) {
  const control =
    task === "crawl"
      ? crawlControl
      : task === "sync"
        ? syncControl
        : null;
  const active = task === "crawl" ? activeRun : activeSync;
  if (!control || !active) {
    const error = new Error(
      task === "crawl" ? "当前没有采集任务" : "当前没有同步任务",
    );
    error.statusCode = 409;
    throw error;
  }
  if (action === "pause" || action === "interrupt") {
    control.pause();
  } else if (action === "resume") {
    control.resume();
  } else if (action === "terminate") {
    deferredSyncs = [];
    deferredCrawl = null;
    control.terminate();
  } else {
    const error = new Error("任务控制操作无效");
    error.statusCode = 422;
    throw error;
  }
  log("task_control_changed", {
    task,
    action,
    interrupted: control.interrupted,
    terminated: control.terminated,
  });
  const database = new CrawlerDatabase(config.dbPath);
  try {
    const runId =
      task === "sync"
        ? syncProgress?.runId
        : database.queryOne(
            "SELECT id FROM crawl_runs WHERE status = 'running' ORDER BY id DESC LIMIT 1",
          )?.id;
    if (runId) {
      database.recordTaskLog({
        taskType: task,
        runId,
        level:
          action === "pause" ||
          action === "interrupt" ||
          action === "terminate"
            ? "warning"
            : "success",
        stage: "control",
        action: action === "interrupt" ? "pause" : action,
        message:
          action === "pause" || action === "interrupt"
            ? "管理员已立即暂停任务，停止领取新的处理步骤"
            : action === "terminate"
              ? "管理员已终止任务，任务将退出且不能恢复"
              : "管理员已恢复任务执行",
        details: {
          interrupted: control.interrupted,
          terminated: control.terminated,
        },
        createdAt: nowIso(),
      });
    }
  } finally {
    database.close();
  }
  if (action === "terminate") {
    await active;
  }
  return scheduleRuntime();
}

function scheduleRuntime() {
  const syncTasks = schedulerSettings.syncTasks.map((task) => ({
    ...task,
    nextRun:
      syncJobs.get(task.accountId)?.nextRun()?.toISOString() ?? null,
  }));
  const syncNextRun = syncTasks
    .map((task) => task.nextRun)
    .filter(Boolean)
    .sort()[0] ?? null;
  return {
    active: Boolean(activeRun),
    interrupted: Boolean(crawlControl?.interrupted),
    enabled: schedulerSettings.crawlEnabled,
    cronSchedule: schedulerSettings.crawlCronSchedule,
    cronTimezone: schedulerSettings.cronTimezone,
    runOnStart: config.runOnStart,
    concurrency: schedulerSettings.crawlConcurrency,
    nextRun: crawlJob?.nextRun()?.toISOString() ?? null,
    updatedAt: schedulerSettings.updatedAt,
    sync: {
      active: Boolean(activeSync),
      interrupted: Boolean(syncControl?.interrupted),
      enabled: syncTasks.some((task) => task.enabled),
      deferred: deferredSyncs.length > 0,
      deferredCount: deferredSyncs.length,
      cronSchedule: schedulerSettings.syncCronSchedule,
      cronTimezone: schedulerSettings.cronTimezone,
      nextRun: syncNextRun,
      materialConcurrency: schedulerSettings.materialConcurrency,
      publishBatchSize: schedulerSettings.publishBatchSize,
      publishLimit: schedulerSettings.publishLimit,
      sort: schedulerSettings.syncSort,
      mode: schedulerSettings.syncMode,
      gameIds: schedulerSettings.syncGameIds,
      accountIds: syncTasks.map((task) => task.accountId),
      tasks: syncTasks,
      progress: syncProgress,
    },
  };
}

const database = new CrawlerDatabase(config.dbPath);
database.markInterruptedRuns(nowIso());
config.xianyuApiKey = database.getXianyuApiKey(
  config.xianyuApiKey,
);
if (config.xianyuApiKey && !database.getXianyuApiKey()) {
  database.setXianyuApiKey(config.xianyuApiKey, nowIso());
}
schedulerSettings = settingsFromRow(
  database.getSchedulerSettings(
    {
      cronTimezone: config.cronTimezone,
      crawlCronSchedule: config.cronSchedule,
      crawlEnabled: config.crawlEnabled,
      syncCronSchedule: config.syncCronSchedule,
      syncEnabled: config.syncEnabled,
      syncMode: "all",
      syncGameIds: [],
      syncAccountIds: [database.getXianyuSyncSettings().account_id].filter(
        Boolean,
      ),
      crawlConcurrency: config.detailConcurrency,
      materialConcurrency: materialSyncConcurrency,
      publishBatchSize,
      publishLimit: 0,
      syncSort: "created",
      publishConcurrency: 4,
    },
    nowIso(),
  ),
);
database.close();
syncService = new XianyuSyncService(config);
replaceScheduledJobs(schedulerSettings);

dashboard = await startDashboardServer(config, scheduleRuntime, {
  listXianyuAccounts: () => syncService.listAccounts(),
  getXianyuAccountPublishCapability: (accountId) =>
    syncService.getAccountPublishCapability(accountId),
  syncXianyuPublishedItems: (accountId) =>
    syncService.syncAccountPublishedItems({
      accountIds: [accountId],
    }),
  updateScheduleSettings,
  updateXianyuApiKey,
  triggerCrawl: (reason) => {
    void triggerCrawl(reason);
    return { active: true, mode: "full" };
  },
  triggerSync: (reason, mode, options = {}) => {
    void triggerSync(reason, mode, options);
    return {
      active: true,
      mode,
      gameIds: options.gameIds ?? null,
      accountIds: options.accountIds ?? schedulerSettings.syncAccountIds,
    };
  },
  controlTask,
});

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  crawlJob?.stop();
  for (const job of syncJobs.values()) job.stop();
  crawlControl?.terminate();
  syncControl?.terminate();
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
  syncTasks: scheduleRuntime().sync.tasks.map((task) => ({
    accountId: task.accountId,
    enabled: task.enabled,
    cronSchedule: task.cronSchedule,
    nextRun: task.nextRun,
  })),
  dashboard: `http://${config.dashboardHost}:${config.dashboardPort}`,
});

if (config.runOnStart && schedulerSettings.crawlEnabled) {
  await triggerCrawl("startup");
}
