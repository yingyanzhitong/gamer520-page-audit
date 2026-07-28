import { randomUUID } from "node:crypto";

import { CrawlerDatabase } from "./database.mjs";
import { nowIso, serializeError } from "./utils.mjs";
import { XianyuClient } from "./xianyu-client.mjs";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function splitIntoBatches(items, size) {
  const batches = [];
  for (let offset = 0; offset < items.length; offset += size) {
    batches.push(items.slice(offset, offset + size));
  }
  return batches;
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

function driveLabel(provider) {
  const normalized = String(provider ?? "").trim();
  if (!normalized) return null;
  const knownProviders = [
    ["百度", "百度"],
    ["夸克", "夸克"],
    ["迅雷", "迅雷"],
    ["阿里", "阿里"],
    ["天翼", "天翼"],
    ["123", "123"],
    ["OneDrive", "OneDrive"],
    ["Google", "Google Drive"],
  ];
  const known = knownProviders.find(([keyword]) =>
    normalized.toLowerCase().includes(keyword.toLowerCase()),
  );
  if (known) return known[1];
  return normalized.replace(/(?:云盘|网盘)$/u, "") || normalized;
}

export function buildListingDescription(game) {
  const providerOrder = new Map(
    [
      "百度",
      "夸克",
      "迅雷",
      "阿里",
      "天翼",
      "123",
      "OneDrive",
      "Google Drive",
    ].map((provider, index) => [provider, index]),
  );
  const providers = [
    ...new Set(
      (game.downloads ?? [])
        .map((download) => driveLabel(download.provider))
        .filter(Boolean),
    ),
  ].sort(
    (left, right) =>
      (providerOrder.get(left) ?? 999) -
        (providerOrder.get(right) ?? 999) ||
      left.localeCompare(right, "zh-CN"),
  );
  return [
    String(game.description ?? "").trim(),
    `支持网盘：${providers.join("/") || "以商品详情为准"}`,
    "虚拟商品24小时自动发货",
    "喜欢直接拍，有问题随时聊",
  ]
    .filter(Boolean)
    .join("\n\n");
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

  async run({ trigger = "manual" } = {}) {
    const database = new CrawlerDatabase(this.config.dbPath);
    const settings = database.getXianyuSyncSettings();
    const accountId = settings.account_id;
    if (!accountId) {
      database.close();
      const error = new Error("请先在页面配置发布账号");
      error.statusCode = 422;
      throw error;
    }

    const batchSize = Math.min(20, Math.max(1, this.config.syncRunLimit));
    const startedAt = nowIso();
    const runId = database.startSyncRun(
      trigger,
      accountId,
      batchSize,
      startedAt,
    );
    const totals = {
      material_created: 0,
      material_updated: 0,
      material_unchanged: 0,
      material_skipped: 0,
      publish_submitted: 0,
      publish_success: 0,
      publish_failed: 0,
      batch_count: 0,
    };
    let submittedPublication = null;
    let latestBatchId = null;

    try {
      await this.validateAccount(accountId);
      database.recordMissingImageSyncErrors(nowIso());
      const candidates = database.listSyncCandidates(accountId, 100_000);
      database.updateSyncRun(runId, {
        selected_count: candidates.length,
      });

      if (candidates.length === 0) {
        database.updateSyncRun(runId, {
          status: "success",
          finished_at: nowIso(),
        });
        return {
          runId,
          accountId,
          selectedCount: 0,
          batchCount: 0,
          status: "success",
        };
      }

      const batches = splitIntoBatches(candidates, batchSize);
      for (const batchCandidates of batches) {
        totals.batch_count += 1;
        const upsertPayload = batchCandidates.map((game) => ({
          external_id: String(game.id),
          content_hash: game.sync_content_hash,
          title: `【秒发】${game.title}`.slice(0, 200),
          description: buildListingDescription(game),
          price: Number(game.effective_price),
          images: [game.image_url],
          category: "虚拟商品",
          delivery_method: "express",
          postage: 0,
          condition: "全新",
          remark: `来源 gamer520，商品ID ${game.id}`,
        }));

        let materialResults;
        try {
          materialResults = await this.client.upsertMaterials(upsertPayload);
        } catch (error) {
          const failedAt = nowIso();
          for (const game of batchCandidates) {
            database.markMaterialFailed(game.id, error.message, failedAt);
          }
          throw error;
        }

        const candidateMap = new Map(
          batchCandidates.map((candidate) => [
            String(candidate.id),
            candidate,
          ]),
        );
        const materialByGame = new Map();
        const syncedAt = nowIso();
        for (const result of materialResults) {
          const candidate = candidateMap.get(String(result.external_id));
          if (!candidate) continue;
          const materialId = Number(result.material_id);
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
          materialByGame.set(candidate.id, {
            materialId,
            action: result.action,
          });
        }

        if (materialByGame.size !== batchCandidates.length) {
          throw new Error("闲鱼素材接口未返回全部商品结果");
        }

        const actionCounts = countActions(materialResults);
        totals.material_created += actionCounts.created;
        totals.material_updated += actionCounts.updated;
        totals.material_unchanged += actionCounts.unchanged;
        totals.material_skipped += actionCounts.skipped;

        const publishCandidates = batchCandidates.filter((candidate) => {
          const material = materialByGame.get(candidate.id);
          return (
            candidate.publication_status !== "success" &&
            material.action !== "skipped"
          );
        });
        totals.publish_submitted += publishCandidates.length;

        if (publishCandidates.length === 0) {
          database.updateSyncRun(runId, totals);
          continue;
        }

        const requestId = randomUUID();
        const materialIds = publishCandidates.map(
          (candidate) => materialByGame.get(candidate.id).materialId,
        );
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
        for (const candidate of publishCandidates) {
          database.markPublicationSubmitted(
            candidate.id,
            accountId,
            materialByGame.get(candidate.id).materialId,
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
          candidates: publishCandidates,
        };

        if (submissionUncertain) {
          const unknownAt = nowIso();
          for (const candidate of publishCandidates) {
            database.markPublicationResult({
              gameId: candidate.id,
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
            selectedCount: candidates.length,
            batchCount: totals.batch_count,
            batchId,
            status: "unknown",
          };
        }

        const deadline = Date.now() + this.config.syncBatchTimeoutMs;
        let status = recoveredStatus;
        while (Date.now() < deadline) {
          if (!status) {
            status = await this.client.getBatchStatus(batchId);
          }
          if (status.done || status.finished) break;
          await delay(this.config.syncPollIntervalMs);
          status = null;
        }

        if (!status?.done && !status?.finished) {
          const unknownAt = nowIso();
          for (const candidate of publishCandidates) {
            database.markPublicationResult({
              gameId: candidate.id,
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
            selectedCount: candidates.length,
            batchCount: totals.batch_count,
            batchId,
            status: "unknown",
          };
        }

        const gameByMaterial = new Map(
          publishCandidates.map((candidate) => [
            materialByGame.get(candidate.id).materialId,
            candidate,
          ]),
        );
        let batchSuccess = 0;
        let batchFailed = 0;
        const completedAt = nowIso();
        for (const item of status.items ?? []) {
          const candidate = gameByMaterial.get(Number(item.material_id));
          if (!candidate || item.account_id !== accountId) continue;
          const itemStatus =
            item.status === "success" ? "success" : "failed";
          if (itemStatus === "success") batchSuccess += 1;
          else batchFailed += 1;
          database.markPublicationResult({
            gameId: candidate.id,
            accountId,
            status: itemStatus,
            itemId: item.item_id,
            itemUrl: item.item_url,
            errorMessage: item.error_message,
            updatedAt: completedAt,
          });
        }

        const missingResults =
          publishCandidates.length - batchSuccess - batchFailed;
        if (missingResults > 0) {
          batchFailed += missingResults;
          for (const candidate of publishCandidates) {
            const hasResult = (status.items ?? []).some(
              (item) =>
                Number(item.material_id) ===
                  materialByGame.get(candidate.id).materialId &&
                item.account_id === accountId,
            );
            if (!hasResult) {
              database.markPublicationResult({
                gameId: candidate.id,
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
        submittedPublication = null;
        database.updateSyncRun(runId, {
          ...totals,
          batch_id: batchId,
        });
      }

      const finalStatus =
        totals.publish_failed > 0 ? "partial" : "success";
      const finishedAt = nowIso();
      database.updateSyncRun(runId, {
        ...totals,
        status: finalStatus,
        batch_id: latestBatchId,
        error_summary:
          totals.publish_failed > 0
            ? `${totals.publish_failed} 个商品发布失败`
            : null,
        finished_at: finishedAt,
      });
      return {
        runId,
        accountId,
        selectedCount: candidates.length,
        materialSkipped: totals.material_skipped,
        publishSubmitted: totals.publish_submitted,
        publishSuccess: totals.publish_success,
        publishFailed: totals.publish_failed,
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
          selectedCount: database.listSyncCandidates(
            accountId,
            100_000,
          ).length,
          batchCount: totals.batch_count,
          batchId: submittedPublication.batchId,
          status: "unknown",
        };
      }
      database.updateSyncRun(runId, {
        ...totals,
        status: "failed",
        error_summary: JSON.stringify(serializeError(error)).slice(0, 4_000),
        finished_at: nowIso(),
      });
      throw error;
    } finally {
      database.close();
    }
  }
}
