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
} from "./playwright-extractor.mjs";
import {
  buildListPageUrl,
  errorSummary,
  nowIso,
  randomBetween,
  serializeError,
  sleep,
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
      return {
        value: await operation(attempt),
        attemptCount: attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt > config.maxRetries) break;
      const baseDelay = attempt === 1 ? 5_000 : 15_000 * attempt;
      await sleep(baseDelay + randomBetween(0, 2_000));
    }
  }

  lastError.attemptCount = config.maxRetries + 1;
  throw lastError;
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
  let browser;
  let fatalError = null;
  let abortReason = null;

  log("crawl_started", {
    runId,
    trigger,
    config: publicConfig(config),
  });

  try {
    await control?.checkpoint();
    browser = await launchBrowser(config);
    const listContext = await createCrawlerContext(browser);
    const discovered = new Map();

    try {
      for (let pageNumber = 1; pageNumber <= config.pageCount; pageNumber += 1) {
        await control?.checkpoint();
        const pageUrl = buildListPageUrl(config.listUrl, pageNumber);
        try {
          const { value: items } = await runWithRetry(
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
        } catch (error) {
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
        }

        statistics.discoveredCount = discovered.size;
        database.updateRunProgress(runId, statistics);

        if (config.listDelayMs > 0) {
          await sleep(config.listDelayMs);
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

    if (queue.length === 0) {
      throw new Error("热度列表没有发现任何有效游戏");
    }

    const metadataContext = await createCrawlerContext(browser);
    try {
      for (const batch of chunks(queue, 100)) {
        await control?.checkpoint();
        try {
          const { value: timestamps } = await runWithRetry(
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
        } catch (error) {
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
        }
      }
    } finally {
      await metadataContext.close().catch(() => {});
    }

    const detailQueue = [];
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
        database.saveGameUnchanged(game.id, game.sourceUpdatedAt, checkedAt);
        statistics.detailSkipped += 1;
        log("detail_skipped_source_unchanged", {
          runId,
          gameId: game.id,
          hotRank: game.hotRank,
          sourceUpdatedAt: game.sourceUpdatedAt,
        });
      } else {
        detailQueue.push(game);
      }
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
              database.saveGameUnchanged(
                game.id,
                result.sourceUpdatedAt,
                nowIso(),
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
              });
              database.updateRunProgress(runId, statistics);
              const delay = randomBetween(
                config.detailDelayMinMs,
                config.detailDelayMaxMs,
              );
              if (delay > 0) await sleep(delay);
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
          } catch (error) {
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
          if (delay > 0) await sleep(delay);
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
    log("crawl_fatal_error", {
      runId,
      error: serializeError(error),
    });
  } finally {
    await browser?.close().catch(() => {});

    let status = "success";
    const summary =
      abortReason ||
      (fatalError ? errorSummary(fatalError) : null) ||
      (statistics.listPagesFailed > 0 ||
      statistics.detailFailed > 0
        ? `列表页失败 ${statistics.listPagesFailed}，详情失败 ${statistics.detailFailed}`
        : null);
    if (fatalError && statistics.detailSucceeded === 0) {
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
