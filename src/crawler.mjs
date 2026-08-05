import { CrawlerDatabase } from "./database.mjs";
import { loadConfig, publicConfig } from "./config.mjs";
import {
  AccessBlockedError,
  createCrawlerContext,
  discoverListPage,
  extractGame,
  fetchSourceUpdateTimes,
  isSourceTimestampCurrent,
  launchBrowser,
  validateImageUrl,
} from "./playwright-extractor.mjs";
import { isTaskTerminatedError } from "./task-control.mjs";
import {
  buildListPageUrl,
  errorSummary,
  nowIso,
  randomBetween,
  serializeError,
} from "./utils.mjs";

function createStatistics() {
  return {
    listPagesSucceeded: 0,
    listPagesFailed: 0,
    discoveredCount: 0,
    detailSucceeded: 0,
    detailFailed: 0,
    detailSkipped: 0,
  };
}

async function runWithRetry(operation, config, control = null) {
  let lastError;
  for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
    try {
      await control?.checkpoint();
      const value = await operation(attempt);
      await control?.checkpoint();
      return {
        value,
        attemptCount: attempt,
      };
    } catch (error) {
      if (control?.terminated || isTaskTerminatedError(error)) {
        throw error;
      }
      lastError = error;
      if (attempt > config.maxRetries) break;
      const baseDelay = attempt === 1 ? 5_000 : 15_000 * attempt;
      await interruptibleDelay(
        baseDelay + randomBetween(0, 2_000),
        control?.signal,
      );
    }
  }

  lastError.attemptCount = config.maxRetries + 1;
  throw lastError;
}

function interruptibleDelay(milliseconds, signal = null) {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
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

function chunks(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export async function runCrawl({
  trigger = "manual",
  overrides = {},
  control = null,
} = {}) {
  const config = loadConfig(overrides);
  const database = new CrawlerDatabase(config.dbPath);
  const statistics = createStatistics();
  const startedAt = nowIso();
  database.markInterruptedRuns(startedAt);
  const runId = database.startRun(
    trigger,
    startedAt,
    publicConfig(config),
  );
  const recordTaskLog = ({
    gameId = null,
    level = "info",
    stage,
    action,
    message,
    details = null,
  }) => {
    database.recordTaskLog({
      taskType: "crawl",
      runId,
      gameId,
      level,
      stage,
      action,
      message,
      details,
      createdAt: nowIso(),
    });
  };
  let browser;
  let fatalError = null;
  let abortReason = null;
  const closeBrowserOnTerminate = () => {
    void browser?.close().catch(() => {});
  };
  control?.signal.addEventListener(
    "abort",
    closeBrowserOnTerminate,
    { once: true },
  );

  log("crawl_started", {
    runId,
    trigger,
    config: publicConfig(config),
  });
  recordTaskLog({
    stage: "task",
    action: "start",
    message: `采集任务已启动，将读取前 ${config.pageCount} 页`,
    details: {
      trigger,
      pageCount: config.pageCount,
      detailConcurrency: config.detailConcurrency,
      maxRetries: config.maxRetries,
    },
  });

  try {
    await control?.checkpoint();
    recordTaskLog({
      stage: "browser",
      action: "launch",
      message: "正在启动采集浏览器",
      details: {
        channel: config.playwrightChannel,
        headless: config.headless,
      },
    });
    browser = await launchBrowser(config);
    await control?.checkpoint();
    recordTaskLog({
      level: "success",
      stage: "browser",
      action: "launched",
      message: "采集浏览器启动成功",
    });
    const listContext = await createCrawlerContext(browser);
    const discovered = new Map();

    try {
      for (let pageNumber = 1; pageNumber <= config.pageCount; pageNumber += 1) {
        await control?.checkpoint();
        const pageUrl = buildListPageUrl(config.listUrl, pageNumber);
        recordTaskLog({
          stage: "list",
          action: "request",
          message: `开始读取列表第 ${pageNumber} 页`,
          details: { pageNumber, pageUrl },
        });
        try {
          const { value: items, attemptCount } = await runWithRetry(
            () =>
              discoverListPage(
                listContext,
                pageUrl,
                pageNumber,
                config,
              ),
            config,
            control,
          );
          statistics.listPagesSucceeded += 1;

          if (items.length === 0) {
            recordTaskLog({
              level: "warning",
              stage: "list",
              action: "exhausted",
              message: `列表第 ${pageNumber} 页没有商品，提前结束列表采集`,
              details: { pageNumber, pageUrl, attemptCount },
            });
            log("list_exhausted", { runId, pageNumber, pageUrl });
            break;
          }

          for (const item of items) {
            const existing = discovered.get(item.id);
            if (!existing || item.hotRank < existing.hotRank) {
              discovered.set(item.id, item);
            }
          }

          log("list_page_succeeded", {
            runId,
            pageNumber,
            itemCount: items.length,
          });
          recordTaskLog({
            level: "success",
            stage: "list",
            action: "succeeded",
            message: `列表第 ${pageNumber} 页读取成功，发现 ${items.length} 个商品`,
            details: {
              pageNumber,
              itemCount: items.length,
              discoveredCount: discovered.size,
              attemptCount,
            },
          });
        } catch (error) {
          if (control?.terminated || isTaskTerminatedError(error)) {
            throw error;
          }
          statistics.listPagesFailed += 1;
          const serialized = serializeError(error);
          database.recordError({
            runId,
            targetUrl: pageUrl,
            stage: "list",
            attemptCount: error.attemptCount ?? config.maxRetries + 1,
            errorName: serialized.name,
            errorMessage: serialized.message,
            createdAt: nowIso(),
          });
          log("list_page_failed", {
            runId,
            pageNumber,
            error: serialized,
          });
          recordTaskLog({
            level: "error",
            stage: "list",
            action: "failed",
            message: `列表第 ${pageNumber} 页读取失败：${serialized.message}`,
            details: {
              pageNumber,
              pageUrl,
              attemptCount:
                error.attemptCount ?? config.maxRetries + 1,
              errorName: serialized.name,
            },
          });
        }

        statistics.discoveredCount = discovered.size;
        database.updateRunProgress(runId, statistics);

        if (config.listDelayMs > 0) {
          await interruptibleDelay(
            config.listDelayMs,
            control?.signal,
          );
        }
      }
    } finally {
      await listContext.close().catch(() => {});
    }

    const queue = [...discovered.values()].sort(
      (left, right) => left.hotRank - right.hotRank,
    );
    statistics.discoveredCount = queue.length;
    database.upsertDiscoveredGames(queue, startedAt);
    database.updateRunProgress(runId, statistics);
    recordTaskLog({
      level: "success",
      stage: "discovery",
      action: "saved",
      message: `列表采集完成，共保存 ${queue.length} 个候选游戏`,
      details: {
        listPagesSucceeded: statistics.listPagesSucceeded,
        listPagesFailed: statistics.listPagesFailed,
        discoveredCount: queue.length,
      },
    });

    if (queue.length === 0) {
      throw new Error("热度列表没有发现任何有效游戏");
    }

    const metadataContext = await createCrawlerContext(browser);
    try {
      for (const batch of chunks(queue, 100)) {
        await control?.checkpoint();
        recordTaskLog({
          stage: "metadata",
          action: "request",
          message: `正在批量读取 ${batch.length} 个游戏的来源更新时间`,
          details: {
            firstGameId: batch[0]?.id ?? null,
            lastGameId: batch.at(-1)?.id ?? null,
          },
        });
        try {
          const { value: timestamps, attemptCount } = await runWithRetry(
            () =>
              fetchSourceUpdateTimes(
                metadataContext,
                batch[0].sourceUrl,
                batch.map((game) => game.id),
                config,
              ),
            config,
            control,
          );
          for (const game of batch) {
            game.sourceUpdatedAt = timestamps.get(game.id) ?? null;
          }
          log("source_update_times_succeeded", {
            runId,
            gameCount: batch.length,
            timestampCount: timestamps.size,
          });
          recordTaskLog({
            level: "success",
            stage: "metadata",
            action: "succeeded",
            message: `来源更新时间读取成功，${timestamps.size}/${batch.length} 个游戏返回时间`,
            details: {
              gameCount: batch.length,
              timestampCount: timestamps.size,
              attemptCount,
            },
          });
        } catch (error) {
          if (control?.terminated || isTaskTerminatedError(error)) {
            throw error;
          }
          const serialized = serializeError(error);
          database.recordError({
            runId,
            targetUrl: batch[0].sourceUrl,
            stage: "source_update_time",
            attemptCount: error.attemptCount ?? config.maxRetries + 1,
            errorName: serialized.name,
            errorMessage: serialized.message,
            createdAt: nowIso(),
          });
          log("source_update_times_failed", {
            runId,
            gameCount: batch.length,
            error: serialized,
          });
          recordTaskLog({
            level: "error",
            stage: "metadata",
            action: "failed",
            message: `来源更新时间读取失败：${serialized.message}`,
            details: {
              gameCount: batch.length,
              attemptCount:
                error.attemptCount ?? config.maxRetries + 1,
              errorName: serialized.name,
            },
          });
        }
      }
    } finally {
      await metadataContext.close().catch(() => {});
    }

    const detailQueue = [];
    const imageValidationContext = await createCrawlerContext(browser);
    try {
      for (const game of queue) {
        const refreshState = database.getGameRefreshState(game.id) ?? {};
        if (
          isSourceTimestampCurrent(
            game.sourceUpdatedAt,
            refreshState.last_scraped_at,
          )
        ) {
          const checkedAt = nowIso();
          database.markGameAttempt(game.id, checkedAt);
          const imageAccessible = await validateImageUrl(
            imageValidationContext,
            refreshState.image_url,
            game.sourceUrl,
            config,
          );
          database.saveGameUnchanged(
            game.id,
            game.sourceUpdatedAt,
            checkedAt,
            imageAccessible,
          );
          statistics.detailSkipped += 1;
          log("detail_skipped_source_unchanged", {
            runId,
            gameId: game.id,
            hotRank: game.hotRank,
            sourceUpdatedAt: game.sourceUpdatedAt,
            imageAccessible,
          });
          recordTaskLog({
            gameId: game.id,
            level: imageAccessible ? "warning" : "error",
            stage: "detail",
            action: "skipped",
            message: imageAccessible
              ? `游戏 ${game.id} 来源更新时间未变化，跳过详情采集`
              : `游戏 ${game.id} 图片链接无法访问，标记为缺失`,
            details: {
              title: game.title,
              hotRank: game.hotRank,
              sourceUpdatedAt: game.sourceUpdatedAt,
              imageAccessible,
            },
          });
        } else {
          detailQueue.push(game);
          recordTaskLog({
            gameId: game.id,
            stage: "detail",
            action: "queued",
            message: `游戏 ${game.id} 已加入详情采集队列`,
            details: {
              title: game.title,
              hotRank: game.hotRank,
              sourceUpdatedAt: game.sourceUpdatedAt,
            },
          });
        }
      }
    } finally {
      await imageValidationContext.close().catch(() => {});
    }
    database.updateRunProgress(runId, statistics);

    let cursor = 0;
    let accessBlockStreak = 0;

    const worker = async (workerId) => {
      const context = await createCrawlerContext(browser);
      try {
        while (!abortReason) {
          await control?.checkpoint();
          const currentIndex = cursor;
          cursor += 1;
          const game = detailQueue[currentIndex];
          if (!game) break;

          const refreshState = database.getGameRefreshState(game.id) ?? {};
          database.markGameAttempt(game.id, nowIso());
          recordTaskLog({
            gameId: game.id,
            stage: "detail",
            action: "request",
            message: `工作线程 ${workerId} 开始采集游戏 ${game.id} 详情`,
            details: {
              title: game.title,
              sourceUrl: game.sourceUrl,
              hotRank: game.hotRank,
            },
          });
          try {
            const { value: result, attemptCount } = await runWithRetry(
              () =>
                extractGame(context, game.sourceUrl, config, {
                  sourceUpdatedAt: refreshState.source_updated_at,
                  lastScrapedAt: refreshState.last_scraped_at,
                  knownSourceUpdatedAt: game.sourceUpdatedAt,
                }),
              config,
              control,
            );
            if (result.unchanged) {
              const imageAccessible = await validateImageUrl(
                context,
                refreshState.image_url,
                game.sourceUrl,
                config,
              );
              database.saveGameUnchanged(
                game.id,
                result.sourceUpdatedAt,
                nowIso(),
                imageAccessible,
              );
              statistics.detailSkipped += 1;
              accessBlockStreak = 0;
              log("detail_skipped_unchanged", {
                runId,
                workerId,
                gameId: game.id,
                hotRank: game.hotRank,
                attemptCount,
                sourceUpdatedAt: result.sourceUpdatedAt,
                imageAccessible,
              });
              recordTaskLog({
                gameId: game.id,
                level: "warning",
                stage: "detail",
                action: "skipped",
                message: imageAccessible
                  ? `游戏 ${game.id} 详情更新时间未变化，保留原数据`
                  : `游戏 ${game.id} 图片链接无法访问，标记为缺失`,
                details: {
                  title: game.title,
                  workerId,
                  attemptCount,
                  sourceUpdatedAt: result.sourceUpdatedAt,
                  imageAccessible,
                },
              });
              database.updateRunProgress(runId, statistics);
              const delay = randomBetween(
                config.detailDelayMinMs,
                config.detailDelayMaxMs,
              );
              if (delay > 0) {
                await interruptibleDelay(delay, control?.signal);
              }
              continue;
            }
            database.saveGameSuccess(game, result, nowIso());
            statistics.detailSucceeded += 1;
            accessBlockStreak = 0;
            log("detail_succeeded", {
              runId,
              workerId,
              gameId: game.id,
              hotRank: game.hotRank,
              attemptCount,
              downloadCount: result.resource.downloads.length,
            });
            recordTaskLog({
              gameId: game.id,
              level: "success",
              stage: "detail",
              action: "succeeded",
              message: `游戏 ${game.id} 详情采集成功，保存 ${result.resource.downloads.length} 个下载源`,
              details: {
                title: result.page.title,
                workerId,
                attemptCount,
                downloadCount: result.resource.downloads.length,
                imageAvailable: Boolean(result.page.image),
              },
            });
          } catch (error) {
            if (control?.terminated || isTaskTerminatedError(error)) {
              throw error;
            }
            statistics.detailFailed += 1;
            const serialized = serializeError(error);
            const attemptedAt = nowIso();
            database.saveGameFailure(
              game.id,
              `${serialized.name}: ${serialized.message}`,
              attemptedAt,
            );
            database.recordError({
              runId,
              gameId: game.id,
              targetUrl: game.sourceUrl,
              stage: "detail",
              attemptCount: error.attemptCount ?? config.maxRetries + 1,
              errorName: serialized.name,
              errorMessage: serialized.message,
              createdAt: attemptedAt,
            });
            log("detail_failed", {
              runId,
              workerId,
              gameId: game.id,
              hotRank: game.hotRank,
              error: serialized,
            });
            recordTaskLog({
              gameId: game.id,
              level: "error",
              stage: "detail",
              action: "failed",
              message: `游戏 ${game.id} 详情采集失败：${serialized.message}`,
              details: {
                title: game.title,
                workerId,
                attemptCount:
                  error.attemptCount ?? config.maxRetries + 1,
                errorName: serialized.name,
              },
            });

            if (error instanceof AccessBlockedError) {
              accessBlockStreak += 1;
              if (accessBlockStreak >= config.accessBlockThreshold) {
                abortReason = `连续 ${accessBlockStreak} 个详情页被限制访问`;
              }
            } else {
              accessBlockStreak = 0;
            }
          }

          database.updateRunProgress(runId, statistics);
          const delay = randomBetween(
            config.detailDelayMinMs,
            config.detailDelayMaxMs,
          );
          if (delay > 0) {
            await interruptibleDelay(delay, control?.signal);
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
    };

    const workerResults = await Promise.allSettled(
      Array.from(
        {
          length: Math.min(config.detailConcurrency, queue.length),
        },
        (_, index) => worker(index + 1),
      ),
    );
    const rejectedWorker = workerResults.find(
      (result) => result.status === "rejected",
    );
    if (rejectedWorker) throw rejectedWorker.reason;

    if (abortReason) {
      statistics.detailSkipped +=
        queue.length -
        statistics.detailSucceeded -
        statistics.detailFailed -
        statistics.detailSkipped;
    }
  } catch (error) {
    fatalError = error;
    const terminated =
      control?.terminated || isTaskTerminatedError(error);
    log("crawl_fatal_error", {
      runId,
      error: serializeError(error),
    });
    recordTaskLog({
      level: terminated ? "warning" : "error",
      stage: "task",
      action: terminated ? "terminated" : "failed",
      message: terminated
        ? "采集任务已由管理员终止，不可恢复"
        : `采集任务异常终止：${serializeError(error).message}`,
      details: {
        errorName: serializeError(error).name,
      },
    });
  } finally {
    control?.signal.removeEventListener(
      "abort",
      closeBrowserOnTerminate,
    );
    await browser?.close().catch(() => {});

    let status = "success";
    const terminated =
      control?.terminated || isTaskTerminatedError(fatalError);
    const summary =
      abortReason ||
      (fatalError ? errorSummary(fatalError) : null) ||
      (statistics.listPagesFailed > 0 ||
      statistics.detailFailed > 0
        ? `列表页失败 ${statistics.listPagesFailed}，详情失败 ${statistics.detailFailed}`
        : null);
    if (terminated) {
      status = "interrupted";
    } else if (fatalError && statistics.detailSucceeded === 0) {
      status = "failed";
    } else if (
      abortReason ||
      fatalError ||
      statistics.listPagesFailed > 0 ||
      statistics.detailFailed > 0
    ) {
      status = "partial";
    }

    database.finishRun(
      runId,
      status,
      nowIso(),
      statistics,
      summary,
    );
    recordTaskLog({
      level:
        status === "success"
          ? "success"
          : status === "failed"
            ? "error"
            : "warning",
      stage: "task",
      action: "finished",
      message: `采集任务已结束：成功 ${statistics.detailSucceeded}，跳过 ${statistics.detailSkipped}，失败 ${statistics.detailFailed}`,
      details: {
        status,
        ...statistics,
        errorSummary: summary,
      },
    });
    database.close();

    log("crawl_finished", {
      runId,
      status,
      statistics,
      errorSummary: summary,
    });

    if (fatalError) throw fatalError;
    return {
      runId,
      status,
      statistics,
      errorSummary: summary,
    };
  }
}
