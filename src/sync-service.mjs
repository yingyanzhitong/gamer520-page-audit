import { randomUUID } from "node:crypto";

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

export class XianyuSyncService {
  constructor(config, client = null) {
    this.config = config;
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
          total: 0,
          completed: processedCount,
          materialTotal: candidates.length,
          materialCompleted: totals.material_processed_count,
          materialSkipped: totals.material_skipped,
          publishTotal: totals.publish_selected_count,
          publishCompleted: totals.publish_processed_count,
          currentGameId: null,
          currentTitle: null,
          phase: "preparing",
          ...progress,
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
        return false;
      }
    };
    try {
      await control?.checkpoint();
      await this.validateAccount(accountId);
      await control?.checkpoint();
      database.recordMissingImageSyncErrors(nowIso());
      candidates = database.listSyncCandidates(
        accountId,
        100_000,
        mode,
      );
      database.updateSyncRun(runId, {
        selected_count: candidates.length,
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
        return {
          runId,
          accountId,
          mode,
          selectedCount: 0,
          batchCount: 0,
          status: "success",
        };
      }

      const titleLocks = new Map();
      const syncMaterial = async (candidate) => {
        const listing = listingFor(candidate);
        const payload = {
          external_id: String(candidate.id),
          content_hash: candidate.sync_content_hash,
          title: listing.title,
          description: listing.description,
          price: Number(candidate.effective_price),
          images: [listing.imageUrl],
          category: "虚拟商品",
          delivery_method: "express",
          postage: 0,
          condition: "全新",
          remark: `来源 gamer520，商品ID ${candidate.id}`,
        };
        reportProgress({
          total: candidates.length,
          currentGameId: candidate.id,
          currentTitle: candidate.title,
          phase: "material",
        });

        const titleKey = listing.title.trim();
        const previous = titleLocks.get(titleKey) ?? Promise.resolve();
        const operation = previous
          .catch(() => {})
          .then(async () => {
            await control?.checkpoint();
            const results = await this.client.upsertMaterials([payload]);
            const result = results.find(
              (item) =>
                String(item.external_id) === String(candidate.id),
            );
            if (!result) {
              throw new Error("闲鱼素材接口未返回该商品结果");
            }
            return result;
          });
        titleLocks.set(titleKey, operation);

        try {
          return { candidate, result: await operation };
        } catch (error) {
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
          batch = await this.client.publishBatch({
            accountId,
            materialIds,
            requestId,
          });
        } catch (submissionError) {
          if (Number(submissionError.status) >= 400) {
            throw submissionError;
          }
          try {
            recoveredStatus = await this.client.getBatchStatus(requestId);
            batch = { batch_id: requestId, idempotent_replay: true };
          } catch {
            batch = { batch_id: requestId };
            submissionUncertain = true;
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
          return {
            runId,
            accountId,
            mode,
            selectedCount: candidates.length,
            batchCount: totals.batch_count,
            batchId,
            status: "unknown",
          };
        }

        const deadline = Date.now() + this.config.syncBatchTimeoutMs;
        let status = recoveredStatus;
        while (Date.now() < deadline) {
          await control?.checkpoint();
          if (!status) {
            status = await this.client.getBatchStatus(batchId);
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
          return {
            runId,
            accountId,
            mode,
            selectedCount: candidates.length,
            batchCount: totals.batch_count,
            batchId,
            status: "unknown",
          };
        }

        const entryByMaterial = new Map(
          entries.map((entry) => [entry.materialId, entry]),
        );
        let batchSuccess = 0;
        let batchFailed = 0;
        const successfulItems = [];
        const completedAt = nowIso();
        for (const item of status.items ?? []) {
          const entry = entryByMaterial.get(Number(item.material_id));
          if (!entry || item.account_id !== accountId) continue;
          const itemStatus =
            item.status === "success" ? "success" : "failed";
          if (itemStatus === "success") batchSuccess += 1;
          else batchFailed += 1;
          database.markPublicationResult({
            gameId: entry.candidate.id,
            accountId,
            status: itemStatus,
            itemId: item.item_id,
            itemUrl: item.item_url,
            errorMessage: item.error_message,
            updatedAt: completedAt,
          });
          if (itemStatus === "success" && item.item_id) {
            successfulItems.push({
              candidate: entry.candidate,
              itemId: item.item_id,
            });
          }
        }

        const missingResults =
          entries.length - batchSuccess - batchFailed;
        if (missingResults > 0) {
          batchFailed += missingResults;
          for (const entry of entries) {
            const hasResult = (status.items ?? []).some(
              (item) =>
                Number(item.material_id) === entry.materialId &&
                item.account_id === accountId,
            );
            if (!hasResult) {
              database.markPublicationResult({
                gameId: entry.candidate.id,
                accountId,
                status: "failed",
                errorMessage: "批次已结束但未返回该商品结果",
                updatedAt: completedAt,
              });
            }
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
        return null;
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
          const { candidate, result, error } = outcome;
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
      }

      totals.publish_selected_count = publishQueue.length;
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
          publishQueue.length > 0 ? "publishing" : "material-completed",
      });

      for (
        let publishIndex = 0;
        publishIndex < publishQueue.length;
        publishIndex += publishBatchSize
      ) {
        const publicationResult = await publishEntries(
          publishQueue.slice(
            publishIndex,
            publishIndex + publishBatchSize,
          ),
        );
        if (publicationResult) return publicationResult;
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
      throw error;
    } finally {
      database.close();
    }
  }
}
