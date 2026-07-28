const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const longDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const state = {
  gamePage: 1,
  gamePageCount: 1,
  gameQuery: "",
  gameStatus: "all",
  loading: false,
  accountId: null,
  accounts: [],
  defaultPrice: 1,
  eligibleGames: 0,
  scheduleDirty: false,
  scheduleLoaded: false,
  schedulerTimezone: "Asia/Shanghai",
};

const statusLabels = {
  failed: "失败",
  interrupted: "已中断",
  partial: "部分成功",
  pending: "等待中",
  publishing: "发布中",
  running: "采集中",
  success: "成功",
  unknown: "待确认",
};

const changeLabels = {
  new: "新增",
  updated: "更新",
};

const syncModeLabels = {
  all: "全部商品",
  pending: "未发布商品",
  updated: "已更新商品",
};

const syncPhaseLabels = {
  preparing: "准备队列",
  material: "同步素材",
  publishing: "发布商品",
  "binding-card": "关联卡券 #6",
  processing: "处理下一件",
  completed: "本轮完成",
};

const elements = {
  adminKey: document.querySelector("#admin-key"),
  catalogCount: document.querySelector("#catalog-count"),
  configuredAccount: document.querySelector("#configured-account"),
  crawlCron: document.querySelector("#crawl-cron"),
  crawlEnabled: document.querySelector("#crawl-enabled"),
  crawlNextRun: document.querySelector("#crawl-next-run"),
  cronSchedule: document.querySelector("#cron-schedule"),
  currentProgressLabel: document.querySelector(
    "#current-progress-label",
  ),
  detailProgress: document.querySelector("#detail-progress"),
  defaultPrice: document.querySelector("#default-price"),
  dialog: document.querySelector("#game-dialog"),
  dialogClose: document.querySelector("#dialog-close"),
  errorList: document.querySelector("#error-list"),
  failedGames: document.querySelector("#failed-games"),
  gameDetail: document.querySelector("#game-detail"),
  gameSearch: document.querySelector("#game-search"),
  gameTableBody: document.querySelector("#game-table-body"),
  generatedAt: document.querySelector("#generated-at"),
  hotRail: document.querySelector("#hot-rail"),
  loadAccounts: document.querySelector("#load-accounts"),
  interruptCrawl: document.querySelector("#interrupt-crawl"),
  interruptSync: document.querySelector("#interrupt-sync"),
  nextPage: document.querySelector("#next-page"),
  nextRun: document.querySelector("#next-run"),
  pageLabel: document.querySelector("#page-label"),
  previousPage: document.querySelector("#previous-page"),
  railSummary: document.querySelector("#rail-summary"),
  refreshButton: document.querySelector("#refresh-button"),
  runCrawl: document.querySelector("#run-crawl"),
  runSyncAll: document.querySelector("#run-sync-all"),
  runSyncPending: document.querySelector("#run-sync-pending"),
  runSyncSchedule: document.querySelector("#run-sync-schedule"),
  runSyncUpdated: document.querySelector("#run-sync-updated"),
  runList: document.querySelector("#run-list"),
  saveAccount: document.querySelector("#save-account"),
  saveSchedule: document.querySelector("#save-schedule"),
  scheduleForm: document.querySelector("#schedule-settings-form"),
  scheduleSaveState: document.querySelector("#schedule-save-state"),
  scheduleSyncNextRun: document.querySelector(
    "#schedule-sync-next-run",
  ),
  scheduleTimezone: document.querySelector("#schedule-timezone"),
  resumeCrawl: document.querySelector("#resume-crawl"),
  resumeSync: document.querySelector("#resume-sync"),
  serviceStatus: document.querySelector("#service-status"),
  statusFilter: document.querySelector("#status-filter"),
  statusPulse: document.querySelector("#status-pulse"),
  syncNextRun: document.querySelector("#sync-next-run"),
  syncCron: document.querySelector("#sync-cron"),
  syncEnabled: document.querySelector("#sync-enabled"),
  syncMode: document.querySelector("#sync-mode"),
  syncProgressCount: document.querySelector("#sync-progress-count"),
  syncProgressCurrent: document.querySelector("#sync-progress-current"),
  syncProgressPhase: document.querySelector("#sync-progress-phase"),
  syncProgressTrack: document.querySelector("#sync-progress-track"),
  syncRunSummary: document.querySelector("#sync-run-summary"),
  successRatio: document.querySelector("#success-ratio"),
  successfulGames: document.querySelector("#successful-games"),
  timezone: document.querySelector("#timezone"),
  toast: document.querySelector("#toast"),
  totalDownloads: document.querySelector("#total-downloads"),
  totalGames: document.querySelector("#total-games"),
  xianyuAccount: document.querySelector("#xianyu-account"),
  xianyuSettingsForm: document.querySelector("#xianyu-settings-form"),
  xianyuSyncState: document.querySelector("#xianyu-sync-state"),
};

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) element.textContent = text;
  return element;
}

function clear(element) {
  element.replaceChildren();
}

function formatDate(value, long = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return (long ? longDateFormatter : dateFormatter).format(date);
}

function formatScheduleDate(value, timezone = state.schedulerTimezone) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
  } catch {
    return longDateFormatter.format(date);
  }
}

function formatDuration(startedAt, finishedAt) {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const finish = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((finish - start) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${remainingSeconds} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

function statusChip(status, taskType = "crawl") {
  const label =
    status === "running" && taskType === "sync"
      ? "同步中"
      : statusLabels[status] ?? status;
  return createElement(
    "span",
    `status-chip status-${status}`,
    label,
  );
}

async function fetchJson(url, options = {}) {
  const headers = {
    accept: "application/json",
    ...(options.headers ?? {}),
  };
  if (options.body != null && !headers["content-type"]) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(url, {
    ...options,
    headers,
    body:
      options.body == null || typeof options.body === "string"
        ? options.body
        : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(
      payload.error ?? `请求失败：HTTP ${response.status}`,
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return response.json();
}

function renderRail(completed, total, running) {
  clear(elements.hotRail);
  const safeTotal = Math.max(1, total);
  for (let index = 1; index <= safeTotal; index += 1) {
    const segment = createElement("span", "rail-segment");
    if (index <= completed) segment.classList.add("is-covered");
    if (running && index === completed + 1) {
      segment.classList.add("is-current");
    }
    elements.hotRail.append(segment);
  }
  elements.railSummary.textContent = `${completed} / ${safeTotal}`;
  elements.hotRail.setAttribute(
    "aria-label",
    `热度榜已完成 ${completed} 页，共 ${safeTotal} 页`,
  );
}

function renderDashboard(payload) {
  const { scheduler, currentRun, latestRun, totals } = payload;
  const visibleRun = currentRun ?? latestRun;
  const serviceRunning = Boolean(scheduler.active || currentRun);

  elements.generatedAt.textContent = formatDate(payload.generatedAt, true);
  state.schedulerTimezone =
    scheduler.cronTimezone || state.schedulerTimezone;
  elements.nextRun.textContent = scheduler.enabled
    ? formatScheduleDate(scheduler.nextRun)
    : "自动采集已关闭";
  elements.timezone.textContent = scheduler.cronTimezone;
  elements.cronSchedule.textContent = scheduler.cronSchedule;
  elements.serviceStatus.textContent = serviceRunning
    ? `任务 #${currentRun?.id ?? "—"} 正在采集`
    : scheduler.enabled
      ? "采集服务在线 · 当前待命"
      : "采集服务在线 · 自动任务已关闭";
  elements.statusPulse.className = `status-pulse${
    serviceRunning ? " is-running" : ""
  }`;

  elements.totalGames.textContent = totals.games.toLocaleString("zh-CN");
  elements.totalDownloads.textContent =
    totals.downloads.toLocaleString("zh-CN");
  elements.successfulGames.textContent =
    totals.successfulGames.toLocaleString("zh-CN");
  elements.failedGames.textContent =
    totals.failedGames.toLocaleString("zh-CN");
  const ratio =
    totals.games > 0
      ? Math.round((totals.successfulGames / totals.games) * 100)
      : 0;
  elements.successRatio.textContent = `${ratio}% 已获取完整详情`;

  const completedDetails = currentRun
    ? currentRun.detailSucceeded +
      currentRun.detailFailed +
      currentRun.detailSkipped
    : 0;
  const detailTotal = currentRun?.discoveredCount ?? 0;
  const detailPercent =
    detailTotal > 0 ? Math.round((completedDetails / detailTotal) * 100) : 0;
  elements.currentProgressLabel.textContent = currentRun
    ? `${completedDetails} / ${detailTotal}`
    : latestRun
      ? `上轮${statusLabels[latestRun.status] ?? latestRun.status}`
      : "等待首次任务";
  elements.detailProgress.setAttribute("aria-valuenow", String(detailPercent));
  elements.detailProgress.querySelector("span").style.width =
    `${detailPercent}%`;

  renderRail(
    visibleRun?.listPagesSucceeded ?? 0,
    payload.pageCount,
    serviceRunning,
  );
  renderErrors(payload.recentErrors);
  state.eligibleGames = totals.eligibleGames ?? 0;
  renderXianyuDashboard(payload);
  renderScheduleDashboard(scheduler);
}

function renderXianyuDashboard(payload) {
  const sync = payload.scheduler.sync ?? {};
  const latest = payload.xianyu.latestSyncRun;
  state.accountId = payload.xianyu.accountId;
  state.defaultPrice = Number(payload.xianyu.defaultPrice ?? 1);
  if (document.activeElement !== elements.defaultPrice) {
    elements.defaultPrice.value = String(state.defaultPrice);
  }
  elements.configuredAccount.textContent = state.accountId || "未配置";
  elements.syncNextRun.textContent = sync.enabled
    ? `下次自动同步 ${formatDate(sync.nextRun, true)} · ${syncModeLabels[sync.mode] ?? "全部商品"} · 逐个处理`
    : "自动同步未启用";
  const syncDisabled =
    !state.accountId ||
    Boolean(sync.active) ||
    Boolean(payload.scheduler.active);
  elements.runSyncAll.disabled = syncDisabled;
  elements.runSyncPending.disabled = syncDisabled;
  elements.runSyncUpdated.disabled = syncDisabled;
  elements.runSyncSchedule.disabled = syncDisabled;
  if (document.activeElement !== elements.xianyuAccount) {
    renderAccountOptions(state.accounts);
  }
  elements.xianyuSyncState.className = "sync-state-badge";
  if (!state.accountId) {
    elements.xianyuSyncState.textContent = "请先选择发布账号";
  } else if (!sync.enabled) {
    elements.xianyuSyncState.textContent = "同步未启用";
    elements.xianyuSyncState.classList.add("is-error");
  } else if (sync.active) {
    elements.xianyuSyncState.textContent = sync.interrupted
      ? "同步已中断，可恢复"
      : "正在同步";
    elements.xianyuSyncState.classList.add("is-active");
  } else if (sync.deferred) {
    elements.xianyuSyncState.textContent = "采集后补跑";
    elements.xianyuSyncState.classList.add("is-active");
  } else {
    elements.xianyuSyncState.textContent = "同步已就绪";
    elements.xianyuSyncState.classList.add("is-active");
  }
  renderSyncProgress(sync, latest);
  renderSyncRun(latest);
}

function renderSyncProgress(sync, latest) {
  const live = sync.active ? sync.progress : null;
  const total = Math.max(
    0,
    Number(live?.total ?? latest?.selectedCount ?? 0),
  );
  const completed = Math.min(
    total,
    Math.max(
      0,
      Number(live?.completed ?? latest?.processedCount ?? 0),
    ),
  );
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const phase = live?.phase ?? (latest ? "completed" : null);
  const currentTitle = live?.currentTitle ?? latest?.currentTitle;
  const currentGameId = live?.currentGameId ?? latest?.currentGameId;

  elements.syncProgressPhase.textContent = phase
    ? syncPhaseLabels[phase] ?? phase
    : "等待任务";
  elements.syncProgressCount.textContent = `${completed} / ${total}`;
  elements.syncProgressTrack.setAttribute(
    "aria-valuenow",
    String(percent),
  );
  elements.syncProgressTrack.querySelector("span").style.width =
    `${percent}%`;

  if (sync.interrupted) {
    elements.syncProgressCurrent.textContent =
      currentTitle
        ? `已中断于：${currentTitle} · ID ${currentGameId}`
        : "任务已中断，可从当前进度恢复";
  } else if (currentTitle) {
    elements.syncProgressCurrent.textContent =
      `正在处理：${currentTitle} · ID ${currentGameId}`;
  } else if (latest) {
    elements.syncProgressCurrent.textContent =
      `最近任务 #${latest.id} · ${statusLabels[latest.status] ?? latest.status}`;
  } else {
    elements.syncProgressCurrent.textContent = "尚未开始同步";
  }
}

function renderScheduleDashboard(scheduler) {
  const sync = scheduler.sync ?? {};
  if (!state.scheduleDirty) {
    elements.scheduleTimezone.value =
      scheduler.cronTimezone || "Asia/Shanghai";
    elements.crawlCron.value = scheduler.cronSchedule || "";
    elements.crawlEnabled.checked = Boolean(scheduler.enabled);
    elements.syncCron.value = sync.cronSchedule || "";
    elements.syncEnabled.checked = Boolean(sync.enabled);
    elements.syncMode.value = sync.mode || "all";
    state.scheduleLoaded = true;
  }
  elements.crawlNextRun.textContent = scheduler.enabled
    ? formatScheduleDate(scheduler.nextRun, scheduler.cronTimezone)
    : "自动采集已关闭";
  elements.scheduleSyncNextRun.textContent = sync.enabled
    ? formatScheduleDate(sync.nextRun, scheduler.cronTimezone)
    : "自动同步已关闭";
  const taskBusy = Boolean(scheduler.active || sync.active);
  elements.runCrawl.disabled = taskBusy;
  elements.interruptCrawl.disabled =
    !scheduler.active || Boolean(scheduler.interrupted);
  elements.resumeCrawl.disabled =
    !scheduler.active || !scheduler.interrupted;
  elements.interruptSync.disabled =
    !sync.active || Boolean(sync.interrupted);
  elements.resumeSync.disabled = !sync.active || !sync.interrupted;
  elements.scheduleSaveState.className = "sync-state-badge";
  if (taskBusy) {
    elements.scheduleSaveState.textContent =
      scheduler.interrupted || sync.interrupted
        ? "任务已中断，可恢复"
        : "任务运行中";
    elements.scheduleSaveState.classList.add("is-active");
  } else if (state.scheduleDirty) {
    elements.scheduleSaveState.textContent = "有未保存修改";
  } else {
    elements.scheduleSaveState.textContent = "定时设置已生效";
    elements.scheduleSaveState.classList.add("is-active");
  }
}

function renderSyncRun(run) {
  clear(elements.syncRunSummary);
  if (!run) {
    elements.syncRunSummary.append(
      createElement("div", "empty-state", "还没有同步任务"),
    );
    return;
  }
  const lines = [
    ["最近任务", `#${run.id} · ${statusLabels[run.status] ?? run.status}`],
    [
      "账号 / 进度",
      `${run.accountId ?? "—"} / ${syncModeLabels[run.syncMode] ?? "全部商品"} / ${run.processedCount ?? 0} / ${run.selectedCount} 条`,
    ],
    [
      "素材",
      `新增 ${run.materialCreated} · 更新 ${run.materialUpdated} · 跳过 ${run.materialSkipped}`,
    ],
    [
      "发布",
      `提交 ${run.publishSubmitted} · 成功 ${run.publishSuccess} · 失败 ${run.publishFailed}`,
    ],
    [
      "卡券 #6",
      `关联 ${run.cardBound ?? 0} · 失败 ${run.cardBindFailed ?? 0}`,
    ],
    ["完成时间", formatDate(run.finishedAt ?? run.startedAt, true)],
  ];
  for (const [label, value] of lines) {
    const line = createElement("div", "sync-summary-line");
    line.append(
      createElement("span", null, label),
      createElement("strong", null, value),
    );
    elements.syncRunSummary.append(line);
  }
  if (run.errorSummary) {
    elements.syncRunSummary.append(
      createElement("small", "sync-summary-error", run.errorSummary),
    );
  }
}

function renderRuns(runs) {
  clear(elements.runList);
  if (runs.length === 0) {
    elements.runList.append(
      createElement("div", "empty-state", "还没有任务记录"),
    );
    return;
  }

  for (const run of runs) {
    const item = createElement("div", "run-item");
    const isSync = run.taskType === "sync";
    if (isSync) item.classList.add("is-sync-run");
    item.append(
      createElement(
        "span",
        "run-id",
        `${isSync ? "S" : "C"}#${run.id}`,
      ),
    );

    const date = createElement("div", "run-date");
    date.append(
      createElement("strong", null, formatDate(run.startedAt)),
      createElement(
        "small",
        null,
        formatDuration(run.startedAt, run.finishedAt),
      ),
    );
    item.append(date);

    const total = Math.max(
      1,
      isSync
        ? run.selectedCount
        : run.detailSucceeded + run.detailFailed + run.detailSkipped,
    );
    const completed = isSync
      ? run.processedCount
      : run.detailSucceeded;
    const failedCount = isSync
      ? (run.publishFailed ?? 0) + (run.cardBindFailed ?? 0)
      : run.detailFailed;
    const meter = createElement("div", "run-meter");
    const success = createElement("span", "success");
    success.style.width =
      `${(Math.max(0, completed - failedCount) / total) * 100}%`;
    const failed = createElement("span", "failed");
    failed.style.width = `${(failedCount / total) * 100}%`;
    meter.append(success, failed);
    item.append(meter);

    const count = createElement("div", "run-count");
    count.append(
      createElement(
        "strong",
        null,
        isSync
          ? `${run.processedCount}/${run.selectedCount}`
          : `${run.detailSucceeded}/${run.discoveredCount}`,
      ),
      createElement(
        "small",
        null,
        isSync
          ? `${run.accountId ?? "未配置账号"} · 卡券 ${run.cardBound ?? 0}`
          : `${run.listPagesSucceeded} 个列表页`,
      ),
      statusChip(run.status, run.taskType),
    );
    item.append(count);
    elements.runList.append(item);
  }
}

function renderErrors(errors) {
  clear(elements.errorList);
  if (errors.length === 0) {
    elements.errorList.append(
      createElement(
        "div",
        "empty-state",
        "近期没有异常，采集链路运行正常",
      ),
    );
    return;
  }

  for (const error of errors) {
    const item = createElement("div", "error-item");
    item.append(
      createElement(
        "span",
        "error-mark",
        error.stage === "list" ? "LIST" : "DATA",
      ),
    );
    const content = createElement("div", "error-content");
    content.append(
      createElement(
        "strong",
        null,
        error.gameId ? `游戏 #${error.gameId}` : "列表页请求",
      ),
      createElement(
        "p",
        null,
        `${error.errorName}：${error.errorMessage}`,
      ),
      createElement("time", null, formatDate(error.createdAt, true)),
    );
    item.append(content);
    elements.errorList.append(item);
  }
}

function renderGames(payload) {
  clear(elements.gameTableBody);
  state.gamePage = payload.page;
  state.gamePageCount = payload.pageCount;
  elements.catalogCount.textContent =
    `共 ${payload.total.toLocaleString("zh-CN")} 条 · 每页 ${payload.pageSize} 条`;
  elements.pageLabel.textContent =
    `第 ${payload.page} / ${payload.pageCount} 页`;
  elements.previousPage.disabled = payload.page <= 1;
  elements.nextPage.disabled = payload.page >= payload.pageCount;

  if (payload.items.length === 0) {
    const row = document.createElement("tr");
    const cell = createElement(
      "td",
      "table-message",
      "没有符合当前条件的游戏",
    );
    cell.colSpan = 9;
    row.append(cell);
    elements.gameTableBody.append(row);
    return;
  }

  for (const game of payload.items) {
    const row = document.createElement("tr");
    const rank = createElement(
      "td",
      "rank-value",
      game.hotRank ? String(game.hotRank).padStart(3, "0") : "—",
    );
    const gameCell = createElement("td", "game-title-cell");
    gameCell.append(
      createElement("strong", null, game.title ?? "未命名游戏"),
      createElement("small", null, `ID ${game.id} · 第 ${game.hotPage ?? "—"} 页`),
    );
    const sources = createElement(
      "td",
      "source-count",
      `${game.downloadCount} 个`,
    );
    const price = renderPriceControl(game);
    const status = document.createElement("td");
    status.append(statusChip(game.scrapeStatus));
    const change = createElement("td", "source-update-cell");
    change.append(
      createElement(
        "strong",
        null,
        formatDate(game.sourceUpdatedAt),
      ),
    );
    if (changeLabels[game.lastChangeType]) {
      change.append(
        createElement(
          "span",
          `change-chip change-${game.lastChangeType}`,
          changeLabels[game.lastChangeType],
        ),
      );
    } else {
      change.append(createElement("small", null, "尚未标记"));
    }
    const publish = document.createElement("td");
    publish.append(publishStatusChip(game));
    const scraped = createElement(
      "td",
      "last-scraped",
      formatDate(game.lastScrapedAt),
    );
    const action = document.createElement("td");
    const button = createElement("button", "detail-button", "详情");
    button.type = "button";
    button.setAttribute("aria-label", `查看 ${game.title ?? game.id} 详情`);
    button.addEventListener("click", () => {
      void showGame(game.id);
    });
    action.append(button);
    row.append(
      rank,
      gameCell,
      sources,
      price,
      status,
      change,
      publish,
      scraped,
      action,
    );
    elements.gameTableBody.append(row);
  }
}

function renderPriceControl(game) {
  const cell = createElement("td", "price-cell");
  const editor = createElement("div", "price-editor");
  const currency = createElement("span", null, "¥");
  const input = document.createElement("input");
  input.type = "number";
  input.min = "0.01";
  input.max = "999999";
  input.step = "0.01";
  input.inputMode = "decimal";
  input.value = String(game.effectivePrice ?? state.defaultPrice);
  input.setAttribute(
    "aria-label",
    `${game.title ?? game.id} 售卖价格`,
  );
  const save = createElement("button", null, "保存");
  save.type = "button";
  save.setAttribute(
    "aria-label",
    `保存 ${game.title ?? game.id} 售卖价格`,
  );
  save.addEventListener("click", () => {
    void saveGamePrice(game.id, input.value, save);
  });
  editor.append(currency, input, save);
  cell.append(editor);
  const hint = createElement(
    "small",
    null,
    game.salePrice == null
      ? `使用默认 ¥${Number(game.effectivePrice).toFixed(2)}`
      : "单独定价",
  );
  cell.append(hint);
  if (game.salePrice != null) {
    const reset = createElement("button", "price-reset", "恢复默认");
    reset.type = "button";
    reset.setAttribute(
      "aria-label",
      `恢复 ${game.title ?? game.id} 默认售价`,
    );
    reset.addEventListener("click", () => {
      void saveGamePrice(game.id, null, reset);
    });
    cell.append(reset);
  }
  return cell;
}

async function saveGamePrice(gameId, price, button) {
  const key = requireXianyuApiKey();
  button.disabled = true;
  try {
    const payload = await fetchJson(`/api/games/${gameId}/price`, {
      method: "PUT",
      headers: { "X-API-Key": key },
      body: { price },
    });
    showToast(
      payload.salePrice == null
        ? `商品 #${gameId} 已恢复默认售价`
        : `商品 #${gameId} 售价已保存`,
    );
    await loadGames();
  } finally {
    button.disabled = false;
  }
}

function publishStatusChip(game) {
  let status = game.publicationStatus;
  let label;
  if (status === "success") {
    label = "已发布";
  } else if (status === "publishing") {
    label = "发布中";
  } else if (status === "failed") {
    label = "发布失败";
  } else if (status === "unknown") {
    label = "结果待确认";
  } else if (game.materialSyncStatus === "synced") {
    status = "synced";
    label = "素材已同步";
  } else if (game.materialSyncStatus === "failed") {
    status = "failed";
    label = "素材失败";
  } else if (game.materialSyncStatus === "skipped") {
    status = "skipped";
    label = "同名已跳过";
  } else {
    status = "pending";
    label = "待同步";
  }
  return createElement("span", `publish-chip publish-${status}`, label);
}

function labeledPassword(label, value) {
  const item = createElement("div", "password-item");
  item.append(
    createElement("small", null, label),
    createElement("code", null, value || "—"),
  );
  return item;
}

function externalLink(label, href) {
  const link = createElement("a", null, label);
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("is-visible");
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove("is-visible");
  }, 1_800);
}

async function copyText(value) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  showToast("提取码已复制");
}

function renderGameDetail({ game, downloads }) {
  const safeDownloads = Array.isArray(downloads) ? downloads : [];
  clear(elements.gameDetail);
  const passwords = createElement(
    "section",
    "detail-section detail-credentials",
  );
  passwords.append(createElement("h2", null, "游戏凭证"));
  const passwordStrip = createElement("div", "password-strip");
  passwordStrip.append(
    labeledPassword("资源编号", game.resourceCode),
    labeledPassword("解压密码", game.archivePassword),
  );
  passwords.append(passwordStrip);
  elements.gameDetail.append(passwords);

  const downloadSection = createElement("section", "detail-section");
  downloadSection.append(createElement("h2", null, "下载源"));
  const grid = createElement("div", "download-grid");
  if (safeDownloads.length === 0) {
    const empty = createElement("div", "detail-empty-download");
    empty.append(
      createElement("strong", null, "当前没有可用下载源"),
      createElement(
        "p",
        null,
        "这条记录仍可查看基础信息；后续采集到资源后会自动补充。",
      ),
    );
    grid.append(empty);
  }
  for (const download of safeDownloads) {
    const card = createElement("article", "download-card");
    const top = createElement("div", "download-card-top");
    top.append(createElement("strong", null, download.provider || "下载源"));
    if (download.url) {
      top.append(externalLink("打开链接 ↗", download.url));
    }
    card.append(top);
    if (download.url) {
      card.append(createElement("code", "download-url", download.url));
    }
    const code = download.extractionCode || download.password;
    const codeRow = createElement("div", "download-code");
    codeRow.append(
      createElement("span", null, `提取码：${code || "无"}`),
    );
    if (code) {
      const copyButton = createElement("button", "copy-button", "复制");
      copyButton.type = "button";
      copyButton.addEventListener("click", () => {
        void copyText(code);
      });
      codeRow.append(copyButton);
    }
    card.append(codeRow);
    grid.append(card);
  }
  downloadSection.append(grid);
  elements.gameDetail.append(downloadSection);

  const links = createElement("section", "detail-section detail-links-section");
  links.append(createElement("h2", null, "资源详情页"));
  if (game.detailPageUrl) {
    links.append(
      externalLink("打开资源详情页 ↗", game.detailPageUrl),
    );
  } else {
    links.append(
      createElement("div", "detail-empty-download", "暂无资源详情页"),
    );
  }
  elements.gameDetail.append(links);
}

async function showGame(gameId) {
  try {
    clear(elements.gameDetail);
    elements.gameDetail.append(
      createElement("div", "loading-block", "正在读取游戏详情…"),
    );
    elements.dialog.showModal();
    const detail = await fetchJson(`/api/games/${gameId}`);
    renderGameDetail({
      game: detail.game,
      downloads: Array.isArray(detail.downloads) ? detail.downloads : [],
    });
  } catch (error) {
    clear(elements.gameDetail);
    elements.gameDetail.append(
      createElement("div", "empty-state", error.message),
    );
  }
}

function requireXianyuApiKey() {
  const key = elements.adminKey.value.trim();
  if (!key) throw new Error("请先输入闲鱼 API Key");
  sessionStorage.setItem("gamer520.xianyuApiKey", key);
  return key;
}

function renderAccountOptions(accounts) {
  clear(elements.xianyuAccount);
  const savedAccountExists = accounts.some(
    (account) => account.accountId === state.accountId,
  );
  if (state.accountId && !savedAccountExists) {
    const saved = createElement(
      "option",
      null,
      `${state.accountId} · 当前已保存`,
    );
    saved.value = state.accountId;
    elements.xianyuAccount.append(saved);
  }
  if (accounts.length === 0 && !state.accountId) {
    const option = createElement("option", null, "请先加载账号");
    option.value = "";
    elements.xianyuAccount.append(option);
    return;
  }
  if (!state.accountId) {
    const placeholder = createElement("option", null, "请选择发布账号");
    placeholder.value = "";
    elements.xianyuAccount.append(placeholder);
  }
  for (const account of accounts) {
    const option = createElement(
      "option",
      null,
      `${account.accountId}${account.remark ? ` · ${account.remark}` : ""}${
        account.enabled ? "" : " · 已停用"
      }`,
    );
    option.value = account.accountId;
    option.disabled = !account.enabled;
    elements.xianyuAccount.append(option);
  }
  elements.xianyuAccount.value = accounts.some(
    (account) => account.accountId === state.accountId && account.enabled,
  )
    ? state.accountId
    : state.accountId || "";
}

async function loadXianyuAccounts({ announce = true } = {}) {
  const key = requireXianyuApiKey();
  elements.loadAccounts.disabled = true;
  try {
    const payload = await fetchJson("/api/xianyu/accounts", {
      headers: { "X-API-Key": key },
    });
    state.accounts = payload.items;
    renderAccountOptions(state.accounts);
    if (announce) showToast(`已加载 ${state.accounts.length} 个账号`);
  } finally {
    elements.loadAccounts.disabled = false;
  }
}

async function saveXianyuAccount(event) {
  event.preventDefault();
  const key = requireXianyuApiKey();
  const accountId = elements.xianyuAccount.value;
  const defaultPrice = Number(elements.defaultPrice.value);
  if (!accountId) throw new Error("请选择一个可用发布账号");
  if (
    !Number.isFinite(defaultPrice) ||
    defaultPrice < 0.01 ||
    defaultPrice > 999_999
  ) {
    throw new Error("默认售价必须在 0.01 到 999999 元之间");
  }
  if (
    state.accountId &&
    state.accountId !== accountId &&
    !window.confirm(
      `确认从账号“${state.accountId}”切换到“${accountId}”吗？未在新账号发布过的商品会重新进入队列，旧账号商品不会删除。`,
    )
  ) {
    return;
  }
  elements.saveAccount.disabled = true;
  try {
    await fetchJson("/api/settings/xianyu", {
      method: "PUT",
      headers: { "X-API-Key": key },
      body: {
        account_id: accountId,
        default_price: defaultPrice,
      },
    });
    state.accountId = accountId;
    state.defaultPrice = defaultPrice;
    showToast(`发布账号与默认售价已保存：${accountId}`);
    await refreshAll();
  } finally {
    elements.saveAccount.disabled = false;
  }
}

async function runXianyuSync(mode) {
  const key = requireXianyuApiKey();
  if (!state.accountId) throw new Error("请先选择发布账号");
  const label = syncModeLabels[mode] ?? syncModeLabels.all;
  if (
    !window.confirm(
      `确认使用账号“${state.accountId}”同步“${label}”吗？同名商品会跳过，已发布商品不会重复上架。`,
    )
  ) {
    return;
  }
  elements.runSyncAll.disabled = true;
  elements.runSyncPending.disabled = true;
  elements.runSyncUpdated.disabled = true;
  elements.runSyncSchedule.disabled = true;
  try {
    await fetchJson("/api/sync/run", {
      method: "POST",
      headers: { "X-API-Key": key },
      body: { mode },
    });
    showToast(`${label}同步任务已启动`);
    window.setTimeout(() => {
      void refreshAll();
    }, 1_000);
  } finally {
    elements.runSyncAll.disabled = false;
    elements.runSyncPending.disabled = false;
    elements.runSyncUpdated.disabled = false;
    elements.runSyncSchedule.disabled = false;
  }
}

async function controlTask(task, action, button) {
  const key = requireXianyuApiKey();
  button.disabled = true;
  try {
    await fetchJson(`/api/tasks/${task}/${action}`, {
      method: "POST",
      headers: { "X-API-Key": key },
      body: {},
    });
    showToast(
      `${task === "crawl" ? "采集" : "同步"}任务已${
        action === "interrupt" ? "中断" : "恢复"
      }`,
    );
    await refreshAll();
  } finally {
    button.disabled = false;
  }
}

async function runManualCrawl() {
  const key = requireXianyuApiKey();
  if (
    !window.confirm(
      "确认立即采集热度前 100 页吗？任务会更新有变化的游戏，未变化的详情会跳过。",
    )
  ) {
    return;
  }
  elements.runCrawl.disabled = true;
  try {
    await fetchJson("/api/crawl/run", {
      method: "POST",
      headers: { "X-API-Key": key },
      body: {},
    });
    showToast("手动采集任务已启动");
    window.setTimeout(() => {
      void refreshAll();
    }, 1_000);
  } finally {
    elements.runCrawl.disabled = false;
  }
}

async function saveScheduleSettings(event) {
  event.preventDefault();
  const key = requireXianyuApiKey();
  const payload = {
    cron_timezone: elements.scheduleTimezone.value.trim(),
    crawl: {
      cron_schedule: elements.crawlCron.value.trim(),
      enabled: elements.crawlEnabled.checked,
    },
    sync: {
      cron_schedule: elements.syncCron.value.trim(),
      enabled: elements.syncEnabled.checked,
      mode: elements.syncMode.value,
    },
  };
  if (
    !payload.cron_timezone ||
    !payload.crawl.cron_schedule ||
    !payload.sync.cron_schedule
  ) {
    throw new Error("任务时区和 Cron 表达式不能为空");
  }
  elements.saveSchedule.disabled = true;
  try {
    await fetchJson("/api/settings/schedule", {
      method: "PUT",
      headers: { "X-API-Key": key },
      body: payload,
    });
    state.scheduleDirty = false;
    showToast("定时设置已保存并立即生效");
    await refreshAll();
  } finally {
    elements.saveSchedule.disabled = false;
  }
}

async function loadGames() {
  const parameters = new URLSearchParams({
    page: String(state.gamePage),
    pageSize: "20",
    query: state.gameQuery,
    status: state.gameStatus,
  });
  const payload = await fetchJson(`/api/games?${parameters}`);
  renderGames(payload);
}

async function refreshAll() {
  if (state.loading) return;
  state.loading = true;
  elements.refreshButton.disabled = true;
  elements.refreshButton.classList.add("is-loading");
  try {
    const [dashboard, runs] = await Promise.all([
      fetchJson("/api/dashboard"),
      fetchJson("/api/runs?limit=12"),
    ]);
    renderDashboard(dashboard);
    renderRuns(runs);
    await loadGames();
  } catch (error) {
    elements.serviceStatus.textContent = "采集服务连接失败";
    elements.statusPulse.className = "status-pulse is-error";
    showToast(error.message);
  } finally {
    state.loading = false;
    elements.refreshButton.disabled = false;
    elements.refreshButton.classList.remove("is-loading");
  }
}

let searchTimer;
elements.gameSearch.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    state.gameQuery = elements.gameSearch.value.trim();
    state.gamePage = 1;
    void loadGames().catch((error) => showToast(error.message));
  }, 280);
});

elements.statusFilter.addEventListener("change", () => {
  state.gameStatus = elements.statusFilter.value;
  state.gamePage = 1;
  void loadGames().catch((error) => showToast(error.message));
});

elements.previousPage.addEventListener("click", () => {
  if (state.gamePage <= 1) return;
  state.gamePage -= 1;
  void loadGames().catch((error) => showToast(error.message));
});

elements.nextPage.addEventListener("click", () => {
  if (state.gamePage >= state.gamePageCount) return;
  state.gamePage += 1;
  void loadGames().catch((error) => showToast(error.message));
});

elements.refreshButton.addEventListener("click", () => {
  void refreshAll();
});

elements.adminKey.value =
  sessionStorage.getItem("gamer520.xianyuApiKey") ?? "";
elements.adminKey.addEventListener("input", () => {
  const value = elements.adminKey.value.trim();
  if (value) {
    sessionStorage.setItem("gamer520.xianyuApiKey", value);
  } else {
    sessionStorage.removeItem("gamer520.xianyuApiKey");
  }
});

elements.loadAccounts.addEventListener("click", () => {
  void loadXianyuAccounts().catch((error) => showToast(error.message));
});

elements.xianyuSettingsForm.addEventListener("submit", (event) => {
  void saveXianyuAccount(event).catch((error) => showToast(error.message));
});

elements.runSyncAll.addEventListener("click", () => {
  void runXianyuSync("all").catch((error) => showToast(error.message));
});

elements.runSyncPending.addEventListener("click", () => {
  void runXianyuSync("pending").catch((error) => showToast(error.message));
});

elements.runSyncUpdated.addEventListener("click", () => {
  void runXianyuSync("updated").catch((error) => showToast(error.message));
});

elements.runSyncSchedule.addEventListener("click", () => {
  void runXianyuSync(elements.syncMode.value).catch((error) =>
    showToast(error.message),
  );
});

elements.runCrawl.addEventListener("click", () => {
  void runManualCrawl().catch((error) => showToast(error.message));
});

elements.interruptCrawl.addEventListener("click", () => {
  void controlTask("crawl", "interrupt", elements.interruptCrawl).catch(
    (error) => showToast(error.message),
  );
});

elements.resumeCrawl.addEventListener("click", () => {
  void controlTask("crawl", "resume", elements.resumeCrawl).catch(
    (error) => showToast(error.message),
  );
});

elements.interruptSync.addEventListener("click", () => {
  void controlTask("sync", "interrupt", elements.interruptSync).catch(
    (error) => showToast(error.message),
  );
});

elements.resumeSync.addEventListener("click", () => {
  void controlTask("sync", "resume", elements.resumeSync).catch(
    (error) => showToast(error.message),
  );
});

elements.scheduleForm.addEventListener("submit", (event) => {
  void saveScheduleSettings(event).catch((error) =>
    showToast(error.message),
  );
});

for (const control of [
  elements.scheduleTimezone,
  elements.crawlCron,
  elements.crawlEnabled,
  elements.syncCron,
  elements.syncEnabled,
  elements.syncMode,
]) {
  control.addEventListener("input", () => {
    if (!state.scheduleLoaded) return;
    state.scheduleDirty = true;
    elements.scheduleSaveState.textContent = "有未保存修改";
    elements.scheduleSaveState.className = "sync-state-badge";
  });
}

elements.dialogClose.addEventListener("click", () => {
  elements.dialog.close();
});

elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});

for (let index = 0; index < 100; index += 1) {
  elements.hotRail.append(createElement("span", "rail-segment"));
}

async function initializeDashboard() {
  await refreshAll();
  if (!elements.adminKey.value.trim()) return;
  await loadXianyuAccounts({ announce: false }).catch((error) => {
    showToast(error.message);
  });
}

void initializeDashboard();
window.setInterval(() => {
  void refreshAll();
}, 5_000);
