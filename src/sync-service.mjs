import { randomUUID } from "node:crypto";

import { cacheCoverImage } from "./cover-cache.mjs";
import { CrawlerDatabase } from "./database.mjs";
import { nowIso, serializeError } from "./utils.mjs";
import { XianyuClient } from "./xianyu-client.mjs";
import {
  buildListingDescription,
  renderXianyuListing,
} from "./xianyu-templates.mjs";

export { buildListingDescription };

const syncModes = new Set(["all", "pending", "updated"]);
const deliveryCardId = 6;
export const materialSyncConcurrency = 4;
export const publishBatchSize = 20;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function countActions(items) {
  const counts = {
    created: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
  };
  for (const item of items) {
    if (item.action in counts) counts[item.action] += 1;
  }
  return counts;
}

function normalizedTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/gu, "");
}

function titleMatchScore(listingTitle, itemTitle) {
  const listing = normalizedTitle(listingTitle);
  const item = normalizedTitle(itemTitle);
  const shorterLength = Math.min(listing.length, item.length);
  if (shorterLength < 6) return 0;
  if (listing.startsWith(item) || item.startsWith(listing)) {
    return shorterLength;
  }
  let commonPrefix = 0;
  while (
    commonPrefix < shorterLength &&
    listing[commonPrefix] === item[commonPrefix]
  ) {
    commonPrefix += 1;
  }
  return commonPrefix >= 12 ? commonPrefix : 0;
}

function matchNewPublishedItems(
  entries,
  beforeItems,
  afterItems,
  listingFor,
) {
  const previousIds = new Set(
    beforeItems
      .map((item) => String(item.item_id ?? ""))
      .filter(Boolean),
  );
  const available = afterItems.filter((item) => {
    const itemId = String(item.item_id ?? "");
    return itemId && !previousIds.has(itemId);
  });
  const matches = new Map();

  for (const entry of entries) {
    let bestIndex = -1;
    let bestScore = 0;
    for (let index = 0; index < available.length; index += 1) {
      const score = titleMatchScore(
        listingFor(entry.candidate).title,
        available[index].item_title ?? available[index].title,
      );
      if (score > bestScore) {
        bestIndex = index;
        bestScore = score;
      }
    }
    if (bestIndex < 0) continue;
    const [matched] = available.splice(bestIndex, 1);
    matches.set(entry.materialId, matched);
  }
  return matches;
}

export class XianyuSyncService {
  constructor(config, client = null, dependencies = {}) {
    this.config = config;
    this.cacheCover =
      dependencies.cacheCover ?? cacheCoverImage;
    this.client =
      client ??
      new XianyuClient({
        baseUrl: config.xianyuBaseUrl,
        apiKey: config.xianyuApiKey,
      });
  }

  async listAccounts() {
    return this.client.listAccounts();
  }

  async validateAccount(accountId) {
    const accounts = await this.listAccounts();
    const account = accounts.find((item) => item.accountId === accountId);
    if (!account) {
      const error = new Error("账号不存在或当前 API Key 无权访问");
      error.statusCode = 403;
      throw error;
    }
    if (!account.enabled) {
      const error = new Error("该闲鱼账号已停用，不能用于发布");
      error.statusCode = 422;
      throw error;
    }
    return account;
  }

  async run({
    trigger = "manual",
    mode = "all",
    gameIds = null,
    control = null,
    onProgress = () => {},
  } = {}) {
    if (!syncModes.has(mode)) {
      const error = new Error("同步范围必须是 all、pending 或 updated");
      error.statusCode = 422;
      throw error;
    }
    const database = new CrawlerDatabase(this.config.dbPath);
    const settings = database.getXianyuSyncSettings();
    const accountId = settings.account_id;
    if (!accountId) {
      database.close();
      const error = new Error("请先在页面配置发布账号");
      error.statusCode = 422;
      throw error;
    }

    const startedAt = nowIso();
    const runId = database.startSyncRun(
      trigger,
      accountId,
      mode,
      publishBatchSize,
      startedAt,
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
        taskType: "sync",
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
    const totals = {
      material_created: 0,
      material_updated: 0,
      material_unchanged: 0,
      material_skipped: 0,
      material_failed: 0,
      material_processed_count: 0,
      publish_selected_count: 0,
      publish_processed_count: 0,
      publish_submitted: 0,
      publish_success: 0,
      publish_failed: 0,
      card_bound: 0,
      card_bind_failed: 0,
      batch_count: 0,
    };
    let submittedPublication = null;
    let latestBatchId = null;
    let processedCount = 0;
    let candidates = [];
    let scopeProgress = {
      total: 0,
      materialCompleted: 0,
      publishCompleted: 0,
    };
    let knownAccountItems = null;
    const listingCache = new Map();
    const listingFor = (candidate) => {
      if (!listingCache.has(candidate.id)) {
        listingCache.set(
          candidate.id,
          renderXianyuListing(candidate, {
            titleTemplate: settings.title_template,
            descriptionTemplate: settings.description_template,
            imageTemplate: settings.image_template,
          }),
        );
      }
      return listingCache.get(candidate.id);
    };
    const reportProgress = (progress) => {
      try {
        onProgress({
          runId,
          accountId,
          mode,
          currentGameId: null,
          currentTitle: null,
          phase: "preparing",
          ...progress,
          total: scopeProgress.total,
          completed: processedCount,
          materialTotal: scopeProgress.total,
          materialCompleted:
            scopeProgress.materialCompleted +
            totals.material_processed_count,
          materialSuccess:
            totals.material_created +
            totals.material_updated +
            totals.material_unchanged,
          materialSkipped:
            scopeProgress.materialCompleted +
            totals.material_skipped,
          materialFailed: totals.material_failed,
          publishTotal: scopeProgress.total,
          publishCompleted:
            scopeProgress.publishCompleted +
            totals.publish_processed_count,
          publishSuccess: totals.publish_success,
          publishSkipped: scopeProgress.publishCompleted,
          publishFailed: totals.publish_failed,
        });
      } catch {
        // 页面进度回调不能影响同步任务本身。
      }
    };
    const refreshAccountItems = async () => {
      recordTaskLog({
        stage: "account",
        action: "refresh-items",
        message: `正在刷新账号 ${accountId} 的商品列表`,
      });
      await this.client.refreshAccountItems(accountId);
      knownAccountItems = await this.client.listAccountItems(accountId);
      recordTaskLog({
        level: "success",
        stage: "account",
        action: "items-refreshed",
        message: `账号商品列表刷新成功，共读取 ${knownAccountItems.length} 个商品`,
        details: { itemCount: knownAccountItems.length },
      });
      return knownAccountItems;
    };
    const bindDeliveryCard = async (candidate, itemId) => {
      await control?.checkpoint();
      reportProgress({
        total: candidates.length,
        currentGameId: candidate.id,
        currentTitle: candidate.title,
        phase: "binding-card",
      });
      recordTaskLog({
        gameId: candidate.id,
        stage: "card",
        action: "bind",
        message: `正在为闲鱼商品 ${itemId} 关联卡券 #${deliveryCardId}`,
        details: {
          itemId: String(itemId),
          cardId: deliveryCardId,
          itemTitle: listingFor(candidate).title,
        },
      });
      try {
        const result = await this.client.bindCards({
          cardIds: [deliveryCardId],
          itemIds: [String(itemId)],
          itemTitle: listingFor(candidate).title,
        });
        if (Number(result.fail_count ?? 0) > 0) {
          throw new Error(`卡券关联失败：${result.fail_count} 条未成功`);
        }
        const boundAt = nowIso();
        database.markCardBindingResult({
          gameId: candidate.id,
          accountId,
          cardId: deliveryCardId,
          status: "success",
          updatedAt: boundAt,
        });
        totals.card_bound += 1;
        recordTaskLog({
          gameId: candidate.id,
          level: "success",
          stage: "card",
          action: "bound",
          message: `闲鱼商品 ${itemId} 已成功关联卡券 #${deliveryCardId}`,
          details: { itemId: String(itemId), cardId: deliveryCardId },
        });
        return true;
      } catch (error) {
        database.markCardBindingResult({
          gameId: candidate.id,
          accountId,
          cardId: deliveryCardId,
          status: "failed",
          errorMessage: error.message,
          updatedAt: nowIso(),
        });
        totals.card_bind_failed += 1;
        recordTaskLog({
          gameId: candidate.id,
          level: "error",
          stage: "card",
          action: "failed",
          message: `闲鱼商品 ${itemId} 关联卡券失败：${error.message}`,
          details: { itemId: String(itemId), cardId: deliveryCardId },
        });
        return false;
      }
    };
    recordTaskLog({
      stage: "task",
      action: "start",
      message: `同步任务已启动，范围为 ${mode}`,
      details: {
        trigger,
        mode,
        accountId,
        materialConcurrency: materialSyncConcurrency,
        publishBatchSize,
        requestedGameIds: Array.isArray(gameIds) ? gameIds : null,
      },
    });
    try {
      await control?.checkpoint();
      recordTaskLog({
        stage: "account",
        action: "validate",
        message: `正在验证发布账号 ${accountId}`,
      });
      const account = await this.validateAccount(accountId);
      recordTaskLog({
        level: "success",
        stage: "account",
        action: "validated",
        message: `发布账号 ${accountId} 验证成功`,
        details: {
          accountId,
          remark: account.remark ?? null,
          enabled: account.enabled,
        },
      });
      await control?.checkpoint();
      candidates = database.listSyncCandidates(
        accountId,
        100_000,
        mode,
      );
      if (Array.isArray(gameIds) && gameIds.length > 0) {
        const requestedGameIds = new Set(
          gameIds
            .map((gameId) => Number(gameId))
            .filter(Number.isInteger),
        );
        candidates = candidates.filter((candidate) =>
          requestedGameIds.has(candidate.id),
        );
      }
      scopeProgress = database.getSyncScopeProgress(
        accountId,
        mode,
        gameIds,
      );
      database.updateSyncRun(runId, {
        selected_count: candidates.length,
      });
      recordTaskLog({
        level: "success",
        stage: "selection",
        action: "completed",
        message: `候选商品筛选完成，本轮处理 ${candidates.length} 个，有效范围共 ${scopeProgress.total} 个`,
        details: {
          candidateCount: candidates.length,
          scopeTotal: scopeProgress.total,
          existingMaterialCount: scopeProgress.materialCompleted,
          existingPublishedCount: scopeProgress.publishCompleted,
        },
      });
      reportProgress({
        total: candidates.length,
        completed: 0,
        phase: candidates.length > 0 ? "preparing" : "completed",
      });

      if (candidates.length === 0) {
        database.updateSyncRun(runId, {
          status: "success",
          finished_at: nowIso(),
        });
        recordTaskLog({
          level: "success",
          stage: "task",
          action: "finished",
          message: "没有需要同步的商品，任务直接完成",
          details: { status: "success", selectedCount: 0 },
        });
        return {
          runId,
          accountId,
          mode,
          selectedCount: 0,
          materialSkipped: 0,
          materialFailed: 0,
          materialProcessedCount: 0,
          publishSelectedCount: 0,
          publishProcessedCount: 0,
          publishSubmitted: 0,
          publishSuccess: 0,
          publishFailed: 0,
          cardBound: 0,
          cardBindFailed: 0,
          batchCount: 0,
          status: "success",
        };
      }

      const titleLocks = new Map();
      const syncMaterial = async (candidate) => {
        reportProgress({
          currentGameId: candidate.id,
          currentTitle: candidate.title,
          phase: "material",
        });
        const existingMaterialId = Number(candidate.material_id);
        if (
          candidate.material_sync_status === "synced" &&
          Number.isInteger(existingMaterialId) &&
          existingMaterialId > 0
        ) {
          recordTaskLog({
            gameId: candidate.id,
            level: "warning",
            stage: "material",
            action: "skipped-existing",
            message: `游戏 ${candidate.id} 已有关联素材 ${existingMaterialId}，跳过素材导入`,
            details: {
              title: candidate.title,
              materialId: existingMaterialId,
            },
          });
          return { candidate, existingMaterialId };
        }
        const listing = listingFor(candidate);
        recordTaskLog({
          gameId: candidate.id,
          stage: "material",
          action: "prepare",
          message: `正在准备游戏 ${candidate.id} 的素材`,
          details: {
            title: listing.title,
            price: Number(candidate.effective_price),
            imageUrl: listing.imageUrl,
          },
        });
        const payload = {
          external_id: String(candidate.id),
          content_hash: candidate.sync_content_hash,
          title: listing.title,
          description: listing.description,
          price: Number(candidate.effective_price),
          images: [],
          category: "虚拟商品",
          delivery_method: "express",
          postage: 0,
          condition: "全新",
          remark: `来源 gamer520，商品ID ${candidate.id}`,
        };
        const titleKey = listing.title.trim();
        const previous = titleLocks.get(titleKey) ?? Promise.resolve();
        const operation = previous
          .catch(() => {})
          .then(async () => {
            await control?.checkpoint();
            let coverUrl = listing.imageUrl;
            if (this.config.coverCacheEnabled !== false) {
              recordTaskLog({
                gameId: candidate.id,
                stage: "cover",
                action: "cache",
                message: `正在缓存游戏 ${candidate.id} 的封面`,
              });
              const cachedCover = await this.cacheCover({
                gameId: candidate.id,
                imageUrl: listing.imageUrl,
                cacheDirectory: this.config.coverCacheDir,
                publicBaseUrl: this.config.publicBaseUrl,
              });
              coverUrl = cachedCover.publicUrl;
              recordTaskLog({
                gameId: candidate.id,
                level: "success",
                stage: "cover",
                action: cachedCover.cached ? "reused" : "cached",
                message: cachedCover.cached
                  ? `游戏 ${candidate.id} 复用已缓存封面`
                  : `游戏 ${candidate.id} 封面缓存成功`,
                details: { coverUrl },
              });
            }
            payload.images = [coverUrl];
            recordTaskLog({
              gameId: candidate.id,
              stage: "material",
              action: "upsert",
              message: `正在写入游戏 ${candidate.id} 的闲鱼素材`,
              details: {
                title: payload.title,
                price: payload.price,
                imageCount: payload.images.length,
              },
            });
            const results = await this.client.upsertMaterials([payload]);
            const result = results.find(
              (item) =>
                String(item.external_id) === String(candidate.id),
            );
            if (!result) {
              throw new Error("闲鱼素材接口未返回该商品结果");
            }
            recordTaskLog({
              gameId: candidate.id,
              level:
                result.action === "skipped" ? "warning" : "success",
              stage: "material",
              action: result.action ?? "upserted",
              message:
                result.action === "skipped"
                  ? `游戏 ${candidate.id} 的同名素材已存在，跳过导入`
                  : `游戏 ${candidate.id} 素材写入成功：${result.action ?? "完成"}`,
              details: {
                materialId: result.material_id ?? null,
                action: result.action ?? null,
                reason: result.reason ?? null,
              },
            });
            return result;
          });
        titleLocks.set(titleKey, operation);

        try {
          return { candidate, result: await operation };
        } catch (error) {
          recordTaskLog({
            gameId: candidate.id,
            level: "error",
            stage: "material",
            action: "failed",
            message: `游戏 ${candidate.id} 素材同步失败：${error.message}`,
            details: { title: candidate.title },
          });
          return { candidate, error };
        } finally {
          if (titleLocks.get(titleKey) === operation) {
            titleLocks.delete(titleKey);
          }
        }
      };

      const publishEntries = async (entries) => {
        const firstCandidate = entries[0].candidate;
        await control?.checkpoint();
        recordTaskLog({
          stage: "publish",
          action: "prepare-batch",
          message: `正在准备第 ${totals.batch_count + 1} 个发布批次，共 ${entries.length} 个商品`,
          details: {
            gameIds: entries.map((entry) => entry.candidate.id),
            materialIds: entries.map((entry) => entry.materialId),
          },
        });
        if (knownAccountItems === null) {
          await refreshAccountItems();
        }
        const beforeItems = knownAccountItems;
        totals.batch_count += 1;
        totals.publish_submitted += entries.length;
        database.updateSyncRun(runId, {
          ...totals,
          processed_count: processedCount,
          current_game_id: firstCandidate.id,
          current_title: firstCandidate.title,
        });
        reportProgress({
          total: candidates.length,
          currentGameId: firstCandidate.id,
          currentTitle: firstCandidate.title,
          phase: "publishing",
        });

        const requestId = randomUUID();
        const materialIds = entries.map((entry) => entry.materialId);
        let batch;
        let recoveredStatus = null;
        let submissionUncertain = false;
        try {
          recordTaskLog({
            stage: "publish",
            action: "submit",
            message: `正在提交批量发布请求，共 ${entries.length} 个商品`,
            details: { requestId, materialIds, accountId },
          });
          batch = await this.client.publishBatch({
            accountId,
            materialIds,
            requestId,
          });
          recordTaskLog({
            level: "success",
            stage: "publish",
            action: "submitted",
            message: `批量发布请求提交成功，批次 ${batch.batch_id ?? requestId}`,
            details: {
              requestId,
              batchId: batch.batch_id ?? requestId,
              itemCount: entries.length,
              idempotentReplay: Boolean(batch.idempotent_replay),
            },
          });
        } catch (submissionError) {
          const statusCode = Number(submissionError.status);
          if ([400, 409, 422].includes(statusCode)) {
            recordTaskLog({
              level: "error",
              stage: "publish",
              action: "rejected",
              message: `批量发布请求被拒绝：${submissionError.message}`,
              details: {
                requestId,
                statusCode,
                itemCount: entries.length,
              },
            });
            const failedAt = nowIso();
            latestBatchId = requestId;
            for (const entry of entries) {
              database.markPublicationSubmitted(
                entry.candidate.id,
                accountId,
                entry.materialId,
                requestId,
                failedAt,
              );
              database.markPublicationResult({
                gameId: entry.candidate.id,
                accountId,
                status: "failed",
                errorMessage: submissionError.message,
                updatedAt: failedAt,
              });
            }
            totals.publish_failed += entries.length;
            totals.publish_processed_count += entries.length;
            processedCount += entries.length;
            database.updateSyncRun(runId, {
              ...totals,
              processed_count: processedCount,
              batch_id: requestId,
              current_game_id: null,
              current_title: null,
            });
            reportProgress({
              total: candidates.length,
              completed: processedCount,
              phase: "processing",
            });
            return {};
          }
          if (statusCode >= 400) {
            throw submissionError;
          }
          try {
            recoveredStatus = await this.client.getBatchStatus(requestId);
            batch = { batch_id: requestId, idempotent_replay: true };
            recordTaskLog({
              level: "warning",
              stage: "publish",
              action: "recovered",
              message: `发布请求响应异常，但已通过幂等请求号恢复批次 ${requestId}`,
              details: { requestId },
            });
          } catch {
            batch = { batch_id: requestId };
            submissionUncertain = true;
            recordTaskLog({
              level: "error",
              stage: "publish",
              action: "unknown",
              message: `发布请求结果未知，无法确认批次 ${requestId}`,
              details: { requestId },
            });
          }
        }

        const batchId = batch.batch_id ?? requestId;
        latestBatchId = batchId;
        const submittedAt = nowIso();
        for (const entry of entries) {
          database.markPublicationSubmitted(
            entry.candidate.id,
            accountId,
            entry.materialId,
            batchId,
            submittedAt,
          );
        }
        database.updateSyncRun(runId, {
          ...totals,
          status: "publishing",
          batch_id: batchId,
        });
        submittedPublication = {
          accountId,
          batchId,
          candidates: entries.map((entry) => entry.candidate),
        };

        if (submissionUncertain) {
          const unknownAt = nowIso();
          for (const entry of entries) {
            database.markPublicationResult({
              gameId: entry.candidate.id,
              accountId,
              status: "unknown",
              errorMessage: "发布请求结果未知，需人工确认后再处理",
              updatedAt: unknownAt,
            });
          }
          database.updateSyncRun(runId, {
            ...totals,
            status: "unknown",
            batch_id: batchId,
            error_summary: "发布请求结果未知，已停止后续批次和自动重试",
            finished_at: unknownAt,
          });
          recordTaskLog({
            level: "error",
            stage: "task",
            action: "stopped-unknown",
            message: "发布请求结果未知，任务已停止，避免自动重复发布",
            details: { batchId, itemCount: entries.length },
          });
          return {
            terminalResult: {
              runId,
              accountId,
              mode,
              selectedCount: candidates.length,
              batchCount: totals.batch_count,
              batchId,
              status: "unknown",
            },
          };
        }

        const deadline = Date.now() + this.config.syncBatchTimeoutMs;
        let status = recoveredStatus;
        let lastLoggedProgress = null;
        while (Date.now() < deadline) {
          await control?.checkpoint();
          if (!status) {
            status = await this.client.getBatchStatus(batchId);
          }
          const statusProgress = `${status.status ?? ""}:${status.processed_count ?? status.processed ?? ""}:${status.done ?? status.finished ?? false}`;
          if (statusProgress !== lastLoggedProgress) {
            lastLoggedProgress = statusProgress;
            recordTaskLog({
              stage: "publish",
              action: "poll",
              message: `批次 ${batchId} 状态：${status.status ?? (status.done || status.finished ? "已完成" : "处理中")}`,
              details: {
                batchId,
                status: status.status ?? null,
                processedCount:
                  status.processed_count ?? status.processed ?? null,
                done: Boolean(status.done || status.finished),
              },
            });
          }
          if (status.done || status.finished) break;
          await delay(this.config.syncPollIntervalMs);
          status = null;
        }

        if (!status?.done && !status?.finished) {
          const unknownAt = nowIso();
          for (const entry of entries) {
            database.markPublicationResult({
              gameId: entry.candidate.id,
              accountId,
              status: "unknown",
              errorMessage: "批量发布超过等待时限，需人工确认后再处理",
              updatedAt: unknownAt,
            });
          }
          database.updateSyncRun(runId, {
            ...totals,
            status: "unknown",
            batch_id: batchId,
            error_summary: "批量发布结果未知，已停止后续批次和自动重试",
            finished_at: unknownAt,
          });
          recordTaskLog({
            level: "error",
            stage: "publish",
            action: "timeout",
            message: `批次 ${batchId} 超过等待时限，任务已停止`,
            details: { batchId, itemCount: entries.length },
          });
          return {
            terminalResult: {
              runId,
              accountId,
              mode,
              selectedCount: candidates.length,
              batchCount: totals.batch_count,
              batchId,
              status: "unknown",
            },
          };
        }

        let reconciledItems = new Map();
        let reconciliationError = null;
        try {
          const afterItems = await refreshAccountItems();
          reconciledItems = matchNewPublishedItems(
            entries,
            beforeItems,
            afterItems,
            listingFor,
          );
          recordTaskLog({
            level: "success",
            stage: "publish",
            action: "reconciled",
            message: `批次 ${batchId} 已核对账号商品列表，匹配 ${reconciledItems.size} 个新商品`,
            details: {
              batchId,
              matchedCount: reconciledItems.size,
              submittedCount: entries.length,
            },
          });
        } catch (error) {
          reconciliationError = error;
          recordTaskLog({
            level: "error",
            stage: "publish",
            action: "reconcile-failed",
            message: `批次 ${batchId} 商品编号核对失败：${error.message}`,
            details: { batchId },
          });
        }

        const statusByMaterial = new Map();
        for (const item of status.items ?? []) {
          if (
            item.account_id &&
            item.account_id !== accountId
          ) {
            continue;
          }
          statusByMaterial.set(Number(item.material_id), item);
        }

        let batchSuccess = 0;
        let batchFailed = 0;
        let batchUnknown = 0;
        const successfulItems = [];
        const completedAt = nowIso();
        for (const entry of entries) {
          const item = statusByMaterial.get(entry.materialId);
          const reconciled = reconciledItems.get(entry.materialId);
          const itemId = String(
            reconciled?.item_id ?? item?.item_id ?? "",
          ).trim();
          const itemUrl =
            item?.item_url ??
            (itemId
              ? `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`
              : null);
          let itemStatus;
          let errorMessage = item?.error_message ?? null;
          if (reconciled || (item?.status === "success" && itemId)) {
            itemStatus = "success";
            errorMessage = null;
            batchSuccess += 1;
          } else if (item?.status === "success") {
            itemStatus = "unknown";
            errorMessage = reconciliationError
              ? `闲鱼返回成功但缺少商品编号，商品列表核对失败：${reconciliationError.message}`
              : "闲鱼返回成功但缺少商品编号，商品列表未发现对应新增商品";
            batchUnknown += 1;
          } else {
            itemStatus = "failed";
            errorMessage =
              errorMessage ??
              "批次已结束但未返回该商品结果";
            batchFailed += 1;
          }
          database.markPublicationResult({
            gameId: entry.candidate.id,
            accountId,
            status: itemStatus,
            itemId: itemId || null,
            itemUrl,
            errorMessage,
            updatedAt: completedAt,
          });
          recordTaskLog({
            gameId: entry.candidate.id,
            level:
              itemStatus === "success"
                ? "success"
                : itemStatus === "unknown"
                  ? "warning"
                  : "error",
            stage: "publish",
            action: itemStatus,
            message:
              itemStatus === "success"
                ? `游戏 ${entry.candidate.id} 发布成功，闲鱼商品编号 ${itemId}`
                : `游戏 ${entry.candidate.id} 发布${itemStatus === "unknown" ? "结果待确认" : "失败"}：${errorMessage}`,
            details: {
              batchId,
              materialId: entry.materialId,
              itemId: itemId || null,
              errorMessage,
            },
          });
          if (itemStatus === "success" && itemId) {
            successfulItems.push({
              candidate: entry.candidate,
              itemId,
            });
          }
        }

        totals.publish_success += batchSuccess;
        totals.publish_failed += batchFailed;
        totals.publish_processed_count += entries.length;
        submittedPublication = null;
        database.updateSyncRun(runId, {
          ...totals,
          batch_id: batchId,
          processed_count: processedCount,
        });
        for (const successfulItem of successfulItems) {
          await bindDeliveryCard(
            successfulItem.candidate,
            successfulItem.itemId,
          );
        }
        processedCount += entries.length;
        database.updateSyncRun(runId, {
          ...totals,
          batch_id: batchId,
          processed_count: processedCount,
          current_game_id: null,
          current_title: null,
        });
        reportProgress({
          total: candidates.length,
          completed: processedCount,
          phase: "processing",
        });
        recordTaskLog({
          level:
            batchFailed > 0 || batchUnknown > 0 ? "warning" : "success",
          stage: "publish",
          action: "batch-finished",
          message: `批次 ${batchId} 完成：成功 ${batchSuccess}，失败 ${batchFailed}，待确认 ${batchUnknown}`,
          details: {
            batchId,
            success: batchSuccess,
            failed: batchFailed,
            unknown: batchUnknown,
          },
        });

        if (batchUnknown > 0) {
          const errorSummary = `${batchUnknown} 个商品缺少可核验的商品编号，已停止后续批次`;
          database.updateSyncRun(runId, {
            ...totals,
            status: "unknown",
            batch_id: batchId,
            error_summary: errorSummary,
            finished_at: completedAt,
          });
          return {
            terminalResult: {
              runId,
              accountId,
              mode,
              selectedCount: candidates.length,
              batchCount: totals.batch_count,
              batchId,
              status: "unknown",
            },
          };
        }

        return {};
      };

      const publishQueue = [];
      for (
        let candidateIndex = 0;
        candidateIndex < candidates.length;
        candidateIndex += materialSyncConcurrency
      ) {
        await control?.checkpoint();
        const materialCandidates = candidates.slice(
          candidateIndex,
          candidateIndex + materialSyncConcurrency,
        );
        const materialOutcomes = await Promise.all(
          materialCandidates.map(syncMaterial),
        );

        for (const outcome of materialOutcomes) {
          const {
            candidate,
            existingMaterialId,
            result,
            error,
          } = outcome;
          if (existingMaterialId) {
            publishQueue.push({
              candidate,
              materialId: existingMaterialId,
            });
            continue;
          }
          totals.material_processed_count += 1;
          if (error) {
            database.markMaterialFailed(
              candidate.id,
              error.message,
              nowIso(),
            );
            totals.material_failed += 1;
            processedCount += 1;
            continue;
          }

          const materialId = Number(result.material_id);
          if (!Number.isInteger(materialId) || materialId <= 0) {
            database.markMaterialFailed(
              candidate.id,
              "闲鱼素材接口未返回有效 material_id",
              nowIso(),
            );
            totals.material_failed += 1;
            processedCount += 1;
            recordTaskLog({
              gameId: candidate.id,
              level: "error",
              stage: "material",
              action: "invalid-result",
              message: `游戏 ${candidate.id} 素材接口没有返回有效 material_id`,
              details: { resultAction: result.action ?? null },
            });
            continue;
          }

          const syncedAt = nowIso();
          if (result.action === "skipped") {
            database.markMaterialSkipped(
              candidate.id,
              materialId,
              candidate.sync_content_hash,
              result.reason ?? "闲鱼素材库已存在同名商品",
              syncedAt,
            );
          } else {
            database.markMaterialSynced(
              candidate.id,
              materialId,
              candidate.sync_content_hash,
              syncedAt,
            );
          }
          const actionCounts = countActions([result]);
          totals.material_created += actionCounts.created;
          totals.material_updated += actionCounts.updated;
          totals.material_unchanged += actionCounts.unchanged;
          totals.material_skipped += actionCounts.skipped;

          if (
            candidate.publication_status === "success" ||
            result.action === "skipped"
          ) {
            recordTaskLog({
              gameId: candidate.id,
              level: "warning",
              stage: "publish",
              action: "skipped",
              message:
                candidate.publication_status === "success"
                  ? `游戏 ${candidate.id} 已发布，跳过重复发布`
                  : `游戏 ${candidate.id} 使用已有同名素材，按规则跳过发布`,
              details: {
                publicationStatus: candidate.publication_status,
                materialAction: result.action,
                itemId: candidate.publication_item_id ?? null,
              },
            });
            if (
              candidate.publication_status === "success" &&
              candidate.publication_item_id &&
              candidate.publication_card_bind_status !== "success"
            ) {
              await bindDeliveryCard(
                candidate,
                candidate.publication_item_id,
              );
            }
            processedCount += 1;
            continue;
          }

          publishQueue.push({ candidate, materialId });
        }

        database.updateSyncRun(runId, {
          ...totals,
          processed_count: processedCount,
          current_game_id: null,
          current_title: null,
        });
        reportProgress({
          total: candidates.length,
          completed: processedCount,
          phase: "processing",
        });

        const materialEnd =
          candidateIndex + materialCandidates.length;
        if (
          materialEnd < candidates.length &&
          materialEnd % publishBatchSize !== 0
        ) {
          continue;
        }

        totals.publish_selected_count += publishQueue.length;
        database.updateSyncRun(runId, {
          ...totals,
          processed_count: processedCount,
          current_game_id: null,
          current_title: null,
        });
        reportProgress({
          total: candidates.length,
          completed: processedCount,
          phase:
            publishQueue.length > 0
              ? "publishing"
              : "material-completed",
        });

        if (publishQueue.length > 0) {
          const publicationResult = await publishEntries(publishQueue);
          if (publicationResult.terminalResult) {
            return publicationResult.terminalResult;
          }
        }
        publishQueue.length = 0;
      }

      const finalStatus =
        totals.material_failed > 0 ||
        totals.publish_failed > 0 ||
        totals.card_bind_failed > 0
          ? "partial"
          : "success";
      const finishedAt = nowIso();
      database.updateSyncRun(runId, {
        ...totals,
        status: finalStatus,
        batch_id: latestBatchId,
        processed_count: processedCount,
        current_game_id: null,
        current_title: null,
        error_summary:
          totals.material_failed > 0 ||
          totals.publish_failed > 0 ||
          totals.card_bind_failed > 0
            ? [
                totals.material_failed > 0
                  ? `${totals.material_failed} 个素材同步失败`
                  : null,
                totals.publish_failed > 0
                  ? `${totals.publish_failed} 个商品发布失败`
                  : null,
                totals.card_bind_failed > 0
                  ? `${totals.card_bind_failed} 个商品关联卡券 #${deliveryCardId} 失败`
                  : null,
              ]
                .filter(Boolean)
                .join("；")
            : null,
        finished_at: finishedAt,
      });
      recordTaskLog({
        level: finalStatus === "success" ? "success" : "warning",
        stage: "task",
        action: "finished",
        message: `同步任务完成：素材成功 ${totals.material_created + totals.material_updated + totals.material_unchanged}，已有跳过 ${scopeProgress.materialCompleted + totals.material_skipped}，素材失败 ${totals.material_failed}，发布成功 ${totals.publish_success}，发布失败 ${totals.publish_failed}`,
        details: {
          status: finalStatus,
          selectedCount: candidates.length,
          material: {
            created: totals.material_created,
            updated: totals.material_updated,
            unchanged: totals.material_unchanged,
            skipped:
              scopeProgress.materialCompleted +
              totals.material_skipped,
            failed: totals.material_failed,
          },
          publish: {
            skipped: scopeProgress.publishCompleted,
            submitted: totals.publish_submitted,
            success: totals.publish_success,
            failed: totals.publish_failed,
          },
          card: {
            success: totals.card_bound,
            failed: totals.card_bind_failed,
          },
        },
      });
      reportProgress({
        total: candidates.length,
        completed: processedCount,
        phase: "completed",
      });
      return {
        runId,
        accountId,
        mode,
        selectedCount: candidates.length,
        materialSkipped: totals.material_skipped,
        materialFailed: totals.material_failed,
        materialProcessedCount: totals.material_processed_count,
        publishSelectedCount: totals.publish_selected_count,
        publishProcessedCount: totals.publish_processed_count,
        publishSubmitted: totals.publish_submitted,
        publishSuccess: totals.publish_success,
        publishFailed: totals.publish_failed,
        cardBound: totals.card_bound,
        cardBindFailed: totals.card_bind_failed,
        batchCount: totals.batch_count,
        batchId: latestBatchId,
        status: finalStatus,
      };
    } catch (error) {
      if (submittedPublication) {
        const unknownAt = nowIso();
        for (const candidate of submittedPublication.candidates) {
          database.markPublicationResult({
            gameId: candidate.id,
            accountId: submittedPublication.accountId,
            status: "unknown",
            errorMessage: `批次状态查询失败：${error.message}`,
            updatedAt: unknownAt,
          });
        }
        database.updateSyncRun(runId, {
          ...totals,
          status: "unknown",
          batch_id: submittedPublication.batchId,
          error_summary: "批量发布已提交但结果查询失败，需人工确认",
          finished_at: unknownAt,
        });
        recordTaskLog({
          level: "error",
          stage: "task",
          action: "stopped-unknown",
          message: `批次状态查询失败，已将批次 ${submittedPublication.batchId} 标记为待确认：${error.message}`,
          details: {
            batchId: submittedPublication.batchId,
            itemCount: submittedPublication.candidates.length,
          },
        });
        return {
          runId,
          accountId,
          mode,
          selectedCount: database.listSyncCandidates(
            accountId,
            100_000,
            mode,
          ).length,
          batchCount: totals.batch_count,
          batchId: submittedPublication.batchId,
          status: "unknown",
        };
      }
      database.updateSyncRun(runId, {
        ...totals,
        status: "failed",
        processed_count: processedCount,
        error_summary: JSON.stringify(serializeError(error)).slice(0, 4_000),
        finished_at: nowIso(),
      });
      recordTaskLog({
        level: "error",
        stage: "task",
        action: "failed",
        message: `同步任务失败：${error.message}`,
        details: serializeError(error),
      });
      throw error;
    } finally {
      database.close();
    }
  }
}
