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
export const publishHeartbeatMs = 60_000;
export const materialSyncConcurrency = 4;
export const publishConcurrency = 4;

function createConcurrencyLimiter(limit, control = null) {
  let activeCount = 0;
  let resumeScheduled = false;
  const queue = [];
  const runNext = () => {
    if (control?.interrupted) {
      if (!resumeScheduled) {
        resumeScheduled = true;
        void control.checkpoint().then(() => {
          resumeScheduled = false;
          runNext();
        });
      }
      return;
    }
    while (activeCount < limit && queue.length > 0) {
      const { task, resolve, reject } = queue.shift();
      activeCount += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          activeCount -= 1;
          runNext();
        });
    }
  };
  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      runNext();
    });
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

function itemIdFromResult(result) {
  const direct = String(result?.item_id ?? "").trim();
  if (direct) return direct;
  const itemUrl = String(result?.item_url ?? "").trim();
  if (!itemUrl) return "";
  try {
    return new URL(itemUrl).searchParams.get("id") ?? "";
  } catch {
    return "";
  }
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
    materialConcurrency = materialSyncConcurrency,
    publishConcurrency: requestedPublishConcurrency = publishConcurrency,
    onProgress = () => {},
  } = {}) {
    if (!syncModes.has(mode)) {
      const error = new Error("同步范围必须是 all、pending 或 updated");
      error.statusCode = 422;
      throw error;
    }
    const database = new CrawlerDatabase(this.config.dbPath);
    const settings = database.getXianyuSyncSettings();
    const resolvedMaterialConcurrency = Math.min(
      12,
      Math.max(1, Number.parseInt(materialConcurrency, 10) || materialSyncConcurrency),
    );
    const resolvedPublishConcurrency = Math.min(
      12,
      Math.max(
        1,
        Number.parseInt(requestedPublishConcurrency, 10) || publishConcurrency,
      ),
    );
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
      1,
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
    let latestRequestId = null;
    let processedCount = 0;
    let candidates = [];
    let scopeProgress = {
      total: 0,
      materialCompleted: 0,
      publishCompleted: 0,
      publishSkipped: 0,
    };
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
            scopeProgress.publishSkipped +
            totals.material_skipped +
            totals.publish_processed_count,
          publishSuccess: totals.publish_success,
          publishSkipped:
            scopeProgress.publishCompleted +
            scopeProgress.publishSkipped +
            totals.material_skipped,
          publishFailed: totals.publish_failed,
        });
      } catch {
        // 页面进度回调不能影响同步任务本身。
      }
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
        await control?.checkpoint();
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
        materialConcurrency: resolvedMaterialConcurrency,
        publishConcurrency: resolvedPublishConcurrency,
        publishMode: "single",
        publishHeartbeatSeconds: publishHeartbeatMs / 1_000,
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
      await control?.checkpoint();
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
          existingPublishSkippedCount: scopeProgress.publishSkipped,
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
      const preparePublishPayload = async (candidate, listing) => {
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
          await control?.checkpoint();
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
        return {
          title: listing.title,
          description: listing.description,
          price: Number(candidate.effective_price),
          images: [coverUrl],
          category: "虚拟商品",
          deliveryMethod: "express",
          postage: 0,
          condition: "全新",
        };
      };
      const syncMaterial = async (candidate) => {
        reportProgress({
          currentGameId: candidate.id,
          currentTitle: candidate.title,
          phase: "material",
        });
        const listing = listingFor(candidate);
        const existingMaterialId = Number(candidate.material_id);
        if (
          candidate.material_sync_status === "synced" &&
          candidate.synced_content_hash ===
            candidate.sync_content_hash &&
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
          try {
            return {
              candidate,
              existingMaterialId,
              publishPayload: await preparePublishPayload(
                candidate,
                listing,
              ),
            };
          } catch (error) {
            recordTaskLog({
              gameId: candidate.id,
              level: "error",
              stage: "cover",
              action: "failed",
              message: `游戏 ${candidate.id} 封面准备失败：${error.message}`,
              details: { title: candidate.title },
            });
            return { candidate, error };
          }
        }
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
            const publishPayload = await preparePublishPayload(
              candidate,
              listing,
            );
            payload.images = [...publishPayload.images];
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
            await control?.checkpoint();
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
            return {
              result,
              publishPayload,
            };
          });
        titleLocks.set(titleKey, operation);

        try {
          const completed = await operation;
          return {
            candidate,
            result: completed.result,
            publishPayload: completed.publishPayload,
          };
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

      const publishEntry = async ({
        candidate,
        materialId,
        publishPayload,
      }) => {
        await control?.checkpoint();
        const listing = listingFor(candidate);
        const itemData =
          publishPayload ?? {
            title: listing.title,
            description: listing.description,
            price: Number(candidate.effective_price),
            images: [listing.imageUrl],
            category: "虚拟商品",
            deliveryMethod: "express",
            postage: 0,
            condition: "全新",
          };
        const requestId = randomUUID();
        latestRequestId = requestId;
        totals.batch_count += 1;
        totals.publish_submitted += 1;
        const submittedAt = nowIso();
        database.markPublicationSubmitted(
          candidate.id,
          accountId,
          materialId,
          requestId,
          submittedAt,
        );
        database.updateSyncRun(runId, {
          ...totals,
          status: "publishing",
          batch_id: requestId,
          processed_count: processedCount,
          current_game_id: candidate.id,
          current_title: candidate.title,
        });
        reportProgress({
          currentGameId: candidate.id,
          currentTitle: candidate.title,
          phase: "publishing",
        });
        recordTaskLog({
          gameId: candidate.id,
          stage: "publish",
          action: "submit-single",
          message: `正在单独发布游戏 ${candidate.id}`,
          details: {
            requestId,
            materialId,
            accountId,
            title: itemData.title,
            imageCount: itemData.images.length,
          },
        });

        const heartbeatInterval = Math.max(
          1,
          Number(
            this.config.syncPublishHeartbeatMs ??
              publishHeartbeatMs,
          ),
        );
        const publishStartedAt = Date.now();
        let heartbeatCount = 0;
        const heartbeatTimer = setInterval(() => {
          heartbeatCount += 1;
          const elapsedSeconds = Math.floor(
            (Date.now() - publishStartedAt) / 1_000,
          );
          recordTaskLog({
            gameId: candidate.id,
            stage: "publish",
            action: "heartbeat",
            message: `游戏 ${candidate.id} 单商品发布仍在执行，已等待 ${elapsedSeconds} 秒`,
            details: {
              requestId,
              materialId,
              heartbeatCount,
              elapsedSeconds,
            },
          });
        }, heartbeatInterval);
        heartbeatTimer.unref?.();

        let itemStatus = "failed";
        let itemId = "";
        let itemUrl = null;
        let errorMessage = null;
        try {
          const result = await this.client.publishSingle({
            accountId,
            materialId,
            title: itemData.title,
            description: itemData.description,
            price: itemData.price,
            images: itemData.images,
            category: itemData.category,
            deliveryMethod: itemData.deliveryMethod,
            postage: itemData.postage,
            condition: itemData.condition,
          });
          clearInterval(heartbeatTimer);
          await control?.checkpoint();
          itemId = itemIdFromResult(result);
          itemUrl =
            result.item_url ??
            (itemId
              ? `https://www.goofish.com/item?id=${encodeURIComponent(itemId)}`
              : null);
          if (!itemId) {
            const missingIdError = new Error(
              "单商品发布返回成功但缺少闲鱼商品编号",
            );
            missingIdError.resultUnknown = true;
            throw missingIdError;
          }
          itemStatus = "success";
          const completedAt = nowIso();
          database.markPublicationResult({
            gameId: candidate.id,
            accountId,
            status: "success",
            itemId,
            itemUrl,
            updatedAt: completedAt,
          });
          totals.publish_success += 1;
          recordTaskLog({
            gameId: candidate.id,
            level: "success",
            stage: "publish",
            action: "success",
            message: `游戏 ${candidate.id} 发布成功，闲鱼商品编号 ${itemId}`,
            details: {
              requestId,
              materialId,
              itemId,
              itemUrl,
            },
          });
          await bindDeliveryCard(candidate, itemId);
        } catch (error) {
          const statusCode = Number(error.status);
          const resultUnknown =
            error.resultUnknown === true ||
            error.name === "AbortError" ||
            error.name === "TimeoutError" ||
            !Number.isFinite(statusCode) ||
            statusCode <= 0;
          itemStatus = resultUnknown ? "unknown" : "failed";
          errorMessage = error.message;
          database.markPublicationResult({
            gameId: candidate.id,
            accountId,
            status: itemStatus,
            itemId: itemId || null,
            itemUrl,
            errorMessage,
            updatedAt: nowIso(),
          });
          totals.publish_failed += 1;
          recordTaskLog({
            gameId: candidate.id,
            level: resultUnknown ? "warning" : "error",
            stage: "publish",
            action: itemStatus,
            message: `游戏 ${candidate.id} 单商品发布${resultUnknown ? "结果待确认" : "失败"}：${errorMessage}`,
            details: {
              requestId,
              materialId,
              statusCode:
                Number.isFinite(statusCode) && statusCode > 0
                  ? statusCode
                  : null,
              errorMessage,
            },
          });
        } finally {
          clearInterval(heartbeatTimer);
          totals.publish_processed_count += 1;
          processedCount += 1;
          database.updateSyncRun(runId, {
            ...totals,
            batch_id: requestId,
            processed_count: processedCount,
            current_game_id: null,
            current_title: null,
          });
          reportProgress({
            completed: processedCount,
            phase: "processing",
          });
        }
        return itemStatus;
      };
      const materialLimiter = createConcurrencyLimiter(
        resolvedMaterialConcurrency,
        control,
      );
      const publishLimiter = createConcurrencyLimiter(
        resolvedPublishConcurrency,
        control,
      );
      const publishJobs = [];

      const enqueuePublication = (entry) => {
        totals.publish_selected_count += 1;
        const job = publishLimiter(() => publishEntry(entry));
        job.catch(() => {});
        publishJobs.push(job);
        database.updateSyncRun(runId, {
          ...totals,
          processed_count: processedCount,
        });
        reportProgress({
          completed: processedCount,
          phase: "publishing",
        });
      };

      const handleCandidate = async (candidate) => {
        await control?.checkpoint();
        const outcome = await syncMaterial(candidate);
        await control?.checkpoint();
        const {
          existingMaterialId,
          result,
          error,
          publishPayload,
        } = outcome;
        if (existingMaterialId) {
          enqueuePublication({
            candidate,
            materialId: existingMaterialId,
            publishPayload,
          });
          return;
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
        } else {
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
          } else {
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
                  itemId:
                    candidate.publication_item_id ?? null,
                },
              });
              if (
                candidate.publication_status === "success" &&
                candidate.publication_item_id &&
                candidate.publication_card_bind_status !==
                  "success"
              ) {
                await bindDeliveryCard(
                  candidate,
                  candidate.publication_item_id,
                );
              }
              processedCount += 1;
            } else {
              enqueuePublication({
                candidate,
                materialId,
                publishPayload,
              });
            }
          }
        }

        database.updateSyncRun(runId, {
          ...totals,
          processed_count: processedCount,
          current_game_id: null,
          current_title: null,
        });
        reportProgress({
          completed: processedCount,
          phase: "processing",
        });
      };

      await Promise.all(
        candidates.map((candidate) =>
          materialLimiter(() => handleCandidate(candidate)),
        ),
      );
      await Promise.all(publishJobs);
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
        batch_id: latestRequestId,
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
            skipped:
              scopeProgress.publishCompleted +
              scopeProgress.publishSkipped +
              totals.material_skipped,
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
        batchId: latestRequestId,
        status: finalStatus,
      };
    } catch (error) {
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
