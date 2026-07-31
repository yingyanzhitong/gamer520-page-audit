import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_XIANYU_TEMPLATES,
  normalizeXianyuTemplates,
} from "./xianyu-templates.mjs";

function transaction(database, callback) {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function normalizeHashValue(value) {
  return typeof value === "string" ? value.trim() : (value ?? null);
}

export const VALID_GAME_DATA_CONDITION = `
  games.content_hash IS NOT NULL
  AND games.title IS NOT NULL
  AND length(trim(games.title)) > 0
  AND games.description IS NOT NULL
  AND length(trim(games.description)) > 0
  AND (
    trim(games.image_url) LIKE 'http://%'
    OR trim(games.image_url) LIKE 'https://%'
  )
  AND EXISTS (
    SELECT 1
    FROM downloads
    WHERE downloads.game_id = games.id
      AND (
        trim(downloads.url) LIKE 'http://%'
        OR trim(downloads.url) LIKE 'https://%'
      )
  )
`;

export function computeGameContentHash(game, downloads = []) {
  const canonicalDownloads = downloads
    .map((download) => ({
      provider: normalizeHashValue(download.provider),
      url: normalizeHashValue(download.url),
      password: normalizeHashValue(download.password),
      extractionCode: normalizeHashValue(
        download.extractionCode ?? download.extraction_code,
      ),
      qrImageUrl: normalizeHashValue(
        download.qrImageUrl ?? download.qr_image_url,
      ),
      decodeMethod: normalizeHashValue(
        download.qrDecodeMethod ??
          download.decodeMethod ??
          download.decode_method,
      ),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );

  const canonical = {
    title: normalizeHashValue(game.title),
    description: normalizeHashValue(
      game.description ?? game.gameDescription,
    ),
    imageUrl: normalizeHashValue(
      game.imageUrl ?? game.image ?? game.image_url,
    ),
    resourceCode: normalizeHashValue(
      game.resourceCode ?? game.resource_code,
    ),
    detailPageUrl: normalizeHashValue(
      game.detailPageUrl ?? game.detail_page_url,
    ),
    archivePassword: normalizeHashValue(
      game.archivePassword ?? game.archive_password,
    ),
    downloads: canonicalDownloads,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export class CrawlerDatabase {
  constructor(databasePath) {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), {
      recursive: true,
    });
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY,
        source_url TEXT NOT NULL UNIQUE,
        title TEXT,
        description TEXT,
        image_url TEXT,
        resource_code TEXT,
        detail_page_url TEXT,
        archive_password TEXT,
        hot_page INTEGER,
        hot_position INTEGER,
        hot_rank INTEGER,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_scraped_at TEXT,
        last_attempt_at TEXT,
        source_updated_at TEXT,
        sale_price REAL,
        scrape_status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        content_hash TEXT,
        last_change_type TEXT,
        last_changed_at TEXT,
        xianyu_item_id TEXT,
        xianyu_item_url TEXT,
        xianyu_account_id TEXT,
        xianyu_published_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS games_hot_rank_idx
      ON games(hot_rank);

      CREATE INDEX IF NOT EXISTS games_last_seen_at_idx
      ON games(last_seen_at);

      CREATE TABLE IF NOT EXISTS downloads (
        game_id INTEGER NOT NULL,
        provider TEXT NOT NULL,
        url TEXT NOT NULL,
        password TEXT,
        extraction_code TEXT,
        qr_image_url TEXT,
        decode_method TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, provider, url),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS crawl_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        status TEXT NOT NULL,
        list_pages_succeeded INTEGER NOT NULL DEFAULT 0,
        list_pages_failed INTEGER NOT NULL DEFAULT 0,
        discovered_count INTEGER NOT NULL DEFAULT 0,
        detail_succeeded INTEGER NOT NULL DEFAULT 0,
        detail_failed INTEGER NOT NULL DEFAULT 0,
        detail_skipped INTEGER NOT NULL DEFAULT 0,
        error_summary TEXT,
        config_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS crawl_errors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        game_id INTEGER,
        target_url TEXT NOT NULL,
        stage TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        error_name TEXT NOT NULL,
        error_message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES crawl_runs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS xianyu_sync_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT,
        default_price REAL NOT NULL DEFAULT 1,
        default_stock INTEGER NOT NULL DEFAULT 999,
        title_template TEXT,
        description_template TEXT,
        image_template TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS scheduler_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cron_timezone TEXT NOT NULL,
        crawl_cron_schedule TEXT NOT NULL,
        crawl_enabled INTEGER NOT NULL DEFAULT 1,
        sync_cron_schedule TEXT NOT NULL,
        sync_enabled INTEGER NOT NULL DEFAULT 1,
        sync_mode TEXT NOT NULL DEFAULT 'all',
        crawl_concurrency INTEGER NOT NULL DEFAULT 3,
        material_concurrency INTEGER NOT NULL DEFAULT 4,
        publish_batch_size INTEGER NOT NULL DEFAULT 20,
        publish_concurrency INTEGER NOT NULL DEFAULT 4,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xianyu_material_sync (
        game_id INTEGER PRIMARY KEY,
        material_id INTEGER,
        synced_content_hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        last_synced_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS xianyu_publications (
        game_id INTEGER NOT NULL,
        account_id TEXT NOT NULL,
        material_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        batch_id TEXT,
        item_id TEXT,
        item_url TEXT,
        last_error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        published_at TEXT,
        card_id INTEGER,
        card_bind_status TEXT NOT NULL DEFAULT 'pending',
        card_bind_error TEXT,
        card_bound_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (game_id, account_id),
        FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS xianyu_publications_account_status_idx
      ON xianyu_publications(account_id, status);

      CREATE TABLE IF NOT EXISTS xianyu_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_type TEXT NOT NULL,
        account_id TEXT,
        sync_mode TEXT NOT NULL DEFAULT 'all',
        requested_limit INTEGER NOT NULL,
        status TEXT NOT NULL,
        selected_count INTEGER NOT NULL DEFAULT 0,
        material_created INTEGER NOT NULL DEFAULT 0,
        material_updated INTEGER NOT NULL DEFAULT 0,
        material_unchanged INTEGER NOT NULL DEFAULT 0,
        material_skipped INTEGER NOT NULL DEFAULT 0,
        material_failed INTEGER NOT NULL DEFAULT 0,
        material_processed_count INTEGER NOT NULL DEFAULT 0,
        publish_selected_count INTEGER NOT NULL DEFAULT 0,
        publish_processed_count INTEGER NOT NULL DEFAULT 0,
        publish_submitted INTEGER NOT NULL DEFAULT 0,
        publish_success INTEGER NOT NULL DEFAULT 0,
        publish_failed INTEGER NOT NULL DEFAULT 0,
        card_bound INTEGER NOT NULL DEFAULT 0,
        card_bind_failed INTEGER NOT NULL DEFAULT 0,
        batch_count INTEGER NOT NULL DEFAULT 0,
        batch_id TEXT,
        processed_count INTEGER NOT NULL DEFAULT 0,
        current_game_id INTEGER,
        current_title TEXT,
        error_summary TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS task_operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_type TEXT NOT NULL
          CHECK (task_type IN ('crawl', 'sync')),
        run_id INTEGER NOT NULL,
        game_id INTEGER,
        level TEXT NOT NULL DEFAULT 'info'
          CHECK (level IN ('info', 'success', 'warning', 'error')),
        stage TEXT NOT NULL,
        action TEXT NOT NULL,
        message TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS task_operation_logs_task_idx
      ON task_operation_logs(task_type, run_id, id);

      CREATE TABLE IF NOT EXISTS service_credentials (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        xianyu_api_key TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS download_api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        api_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      );
    `);

    this.#migrateSchema();
    this.#backfillContentHashes();
    this.#backfillXianyuItemIds();
    this.#backfillSyncRunProgress();
    this.database.exec("PRAGMA user_version = 13;");
  }

  #migrateSchema() {
    const gameColumns = new Set(
      this.database
        .prepare("PRAGMA table_info(games)")
        .all()
        .map((column) => column.name),
    );
    const additions = [
      ["content_hash", "TEXT"],
      ["last_change_type", "TEXT"],
      ["last_changed_at", "TEXT"],
      ["source_updated_at", "TEXT"],
      ["sale_price", "REAL"],
      ["xianyu_item_id", "TEXT"],
      ["xianyu_item_url", "TEXT"],
      ["xianyu_account_id", "TEXT"],
      ["xianyu_published_at", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!gameColumns.has(name)) {
        this.database.exec(`ALTER TABLE games ADD COLUMN ${name} ${definition}`);
      }
    }

    const syncRunColumns = new Set(
      this.database
        .prepare("PRAGMA table_info(xianyu_sync_runs)")
        .all()
        .map((column) => column.name),
    );
    const syncRunAdditions = [
      ["material_skipped", "INTEGER NOT NULL DEFAULT 0"],
      ["material_failed", "INTEGER NOT NULL DEFAULT 0"],
      ["material_processed_count", "INTEGER NOT NULL DEFAULT 0"],
      ["publish_selected_count", "INTEGER NOT NULL DEFAULT 0"],
      ["publish_processed_count", "INTEGER NOT NULL DEFAULT 0"],
      ["batch_count", "INTEGER NOT NULL DEFAULT 0"],
      ["sync_mode", "TEXT NOT NULL DEFAULT 'all'"],
      ["processed_count", "INTEGER NOT NULL DEFAULT 0"],
      ["current_game_id", "INTEGER"],
      ["current_title", "TEXT"],
      ["card_bound", "INTEGER NOT NULL DEFAULT 0"],
      ["card_bind_failed", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, definition] of syncRunAdditions) {
      if (!syncRunColumns.has(name)) {
        this.database.exec(
          `ALTER TABLE xianyu_sync_runs ADD COLUMN ${name} ${definition}`,
        );
      }
    }

    const xianyuSettingsColumns = new Set(
      this.database
        .prepare("PRAGMA table_info(xianyu_sync_settings)")
        .all()
        .map((column) => column.name),
    );
    if (!xianyuSettingsColumns.has("default_price")) {
      this.database.exec(
        "ALTER TABLE xianyu_sync_settings ADD COLUMN default_price REAL NOT NULL DEFAULT 1",
      );
    }
    if (!xianyuSettingsColumns.has("default_stock")) {
      this.database.exec(
        "ALTER TABLE xianyu_sync_settings ADD COLUMN default_stock INTEGER NOT NULL DEFAULT 999",
      );
    }
    const xianyuTemplateAdditions = [
      ["title_template", "TEXT"],
      ["description_template", "TEXT"],
      ["image_template", "TEXT"],
    ];
    for (const [name, definition] of xianyuTemplateAdditions) {
      if (!xianyuSettingsColumns.has(name)) {
        this.database.exec(
          `ALTER TABLE xianyu_sync_settings ADD COLUMN ${name} ${definition}`,
        );
      }
    }

    const schedulerColumns = new Set(
      this.database
        .prepare("PRAGMA table_info(scheduler_settings)")
        .all()
        .map((column) => column.name),
    );
    if (!schedulerColumns.has("sync_mode")) {
      this.database.exec(
        "ALTER TABLE scheduler_settings ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'all'",
      );
    }
    const schedulerConcurrencyAdditions = [
      ["crawl_concurrency", "INTEGER NOT NULL DEFAULT 3"],
      ["material_concurrency", "INTEGER NOT NULL DEFAULT 4"],
      ["publish_batch_size", "INTEGER NOT NULL DEFAULT 20"],
      ["publish_concurrency", "INTEGER NOT NULL DEFAULT 4"],
    ];
    for (const [name, definition] of schedulerConcurrencyAdditions) {
      if (!schedulerColumns.has(name)) {
        this.database.exec(
          `ALTER TABLE scheduler_settings ADD COLUMN ${name} ${definition}`,
        );
      }
    }

    const publicationColumns = new Set(
      this.database
        .prepare("PRAGMA table_info(xianyu_publications)")
        .all()
        .map((column) => column.name),
    );
    const publicationAdditions = [
      ["card_id", "INTEGER"],
      ["card_bind_status", "TEXT NOT NULL DEFAULT 'pending'"],
      ["card_bind_error", "TEXT"],
      ["card_bound_at", "TEXT"],
    ];
    for (const [name, definition] of publicationAdditions) {
      if (!publicationColumns.has(name)) {
        this.database.exec(
          `ALTER TABLE xianyu_publications ADD COLUMN ${name} ${definition}`,
        );
      }
    }
  }

  #backfillSyncRunProgress() {
    this.database.exec(`
      UPDATE xianyu_sync_runs
      SET processed_count = selected_count
      WHERE finished_at IS NOT NULL
        AND processed_count = 0
        AND status IN ('success', 'partial');

      UPDATE xianyu_sync_runs
      SET material_processed_count =
        material_created +
        material_updated +
        material_unchanged +
        material_skipped +
        material_failed
      WHERE material_processed_count = 0;

      UPDATE xianyu_sync_runs
      SET publish_selected_count = publish_submitted
      WHERE publish_selected_count = 0;

      UPDATE xianyu_sync_runs
      SET publish_processed_count = publish_success + publish_failed
      WHERE publish_processed_count = 0;
    `);
  }

  #backfillContentHashes() {
    const rows = this.database
      .prepare(
        `SELECT *
         FROM games
         WHERE content_hash IS NULL`,
      )
      .all();
    if (rows.length === 0) return;

    const downloadStatement = this.database.prepare(
      "SELECT * FROM downloads WHERE game_id = ? ORDER BY provider, url",
    );
    const updateStatement = this.database.prepare(`
      UPDATE games
      SET content_hash = ?,
          last_change_type = COALESCE(last_change_type, 'new'),
          last_changed_at = COALESCE(last_changed_at, last_scraped_at, updated_at)
      WHERE id = ?
    `);
    const now = new Date().toISOString();
    const ensureMaterialStatement = this.database.prepare(`
      INSERT INTO xianyu_material_sync (
        game_id, status, updated_at
      ) VALUES (?, 'pending', ?)
      ON CONFLICT(game_id) DO NOTHING
    `);

    transaction(this.database, () => {
      for (const row of rows) {
        const downloads = downloadStatement.all(row.id);
        updateStatement.run(computeGameContentHash(row, downloads), row.id);
        if (downloads.length > 0) {
          ensureMaterialStatement.run(row.id, now);
        }
      }
    });
  }

  #backfillXianyuItemIds() {
    const rows = this.database
      .prepare(`
        SELECT
          publication.game_id,
          publication.account_id,
          publication.item_id,
          publication.item_url,
          publication.published_at,
          publication.updated_at
        FROM xianyu_publications AS publication
        JOIN games ON games.id = publication.game_id
        WHERE publication.status = 'success'
          AND publication.item_id IS NOT NULL
          AND games.xianyu_item_id IS NULL
        ORDER BY
          COALESCE(publication.published_at, publication.updated_at) DESC
      `)
      .all();
    if (rows.length === 0) return;

    const update = this.database.prepare(`
      UPDATE games
      SET xianyu_item_id = ?,
          xianyu_item_url = ?,
          xianyu_account_id = ?,
          xianyu_published_at = ?
      WHERE id = ? AND xianyu_item_id IS NULL
    `);
    transaction(this.database, () => {
      for (const row of rows) {
        update.run(
          row.item_id,
          row.item_url,
          row.account_id,
          row.published_at ?? row.updated_at,
          row.game_id,
        );
      }
    });
  }

  close() {
    this.database.close();
  }

  markInterruptedRuns(timestamp) {
    this.database
      .prepare(`
        UPDATE crawl_runs
        SET status = 'interrupted',
            finished_at = COALESCE(finished_at, ?),
            error_summary = COALESCE(error_summary, '进程在任务完成前退出')
        WHERE status = 'running'
      `)
      .run(timestamp);
    this.database
      .prepare(`
        UPDATE xianyu_sync_runs
        SET status = 'interrupted',
            finished_at = COALESCE(finished_at, ?),
            error_summary = COALESCE(error_summary, '进程在同步完成前退出')
        WHERE status IN ('running', 'publishing')
      `)
      .run(timestamp);
  }

  startRun(triggerType, startedAt, publicConfig) {
    const result = this.database
      .prepare(`
        INSERT INTO crawl_runs (
          trigger_type,
          started_at,
          status,
          config_json
        ) VALUES (?, ?, 'running', ?)
      `)
      .run(triggerType, startedAt, JSON.stringify(publicConfig));
    return Number(result.lastInsertRowid);
  }

  updateRunProgress(runId, statistics) {
    this.database
      .prepare(`
        UPDATE crawl_runs
        SET list_pages_succeeded = ?,
            list_pages_failed = ?,
            discovered_count = ?,
            detail_succeeded = ?,
            detail_failed = ?,
            detail_skipped = ?
        WHERE id = ?
      `)
      .run(
        statistics.listPagesSucceeded,
        statistics.listPagesFailed,
        statistics.discoveredCount,
        statistics.detailSucceeded,
        statistics.detailFailed,
        statistics.detailSkipped,
        runId,
      );
  }

  finishRun(runId, status, finishedAt, statistics, errorSummary = null) {
    this.database
      .prepare(`
        UPDATE crawl_runs
        SET finished_at = ?,
            status = ?,
            list_pages_succeeded = ?,
            list_pages_failed = ?,
            discovered_count = ?,
            detail_succeeded = ?,
            detail_failed = ?,
            detail_skipped = ?,
            error_summary = ?
        WHERE id = ?
      `)
      .run(
        finishedAt,
        status,
        statistics.listPagesSucceeded,
        statistics.listPagesFailed,
        statistics.discoveredCount,
        statistics.detailSucceeded,
        statistics.detailFailed,
        statistics.detailSkipped,
        errorSummary,
        runId,
      );
  }

  recordError({
    runId,
    gameId = null,
    targetUrl,
    stage,
    attemptCount,
    errorName,
    errorMessage,
    createdAt,
  }) {
    this.database
      .prepare(`
        INSERT INTO crawl_errors (
          run_id,
          game_id,
          target_url,
          stage,
          attempt_count,
          error_name,
          error_message,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        gameId,
        targetUrl,
        stage,
        attemptCount,
        errorName,
        errorMessage.slice(0, 4_000),
        createdAt,
      );
  }

  recordTaskLog({
    taskType,
    runId,
    gameId = null,
    level = "info",
    stage,
    action,
    message,
    details = null,
    createdAt,
  }) {
    this.database
      .prepare(`
        INSERT INTO task_operation_logs (
          task_type,
          run_id,
          game_id,
          level,
          stage,
          action,
          message,
          detail_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        taskType,
        runId,
        gameId,
        level,
        String(stage).slice(0, 100),
        String(action).slice(0, 100),
        String(message).slice(0, 4_000),
        details == null ? null : JSON.stringify(details),
        createdAt,
      );
  }

  listTaskOperationLogs({
    taskType,
    runId,
    afterId = 0,
    limit = 500,
  }) {
    return this.database
      .prepare(`
        SELECT *
        FROM task_operation_logs
        WHERE task_type = ?
          AND run_id = ?
          AND id > ?
        ORDER BY id ASC
        LIMIT ?
      `)
      .all(taskType, runId, afterId, limit);
  }

  getXianyuApiKey(fallback = "") {
    const row = this.database
      .prepare(
        "SELECT xianyu_api_key FROM service_credentials WHERE id = 1",
      )
      .get();
    return String(row?.xianyu_api_key ?? fallback ?? "").trim();
  }

  setXianyuApiKey(apiKey, updatedAt) {
    this.database
      .prepare(`
        INSERT INTO service_credentials (
          id,
          xianyu_api_key,
          updated_at
        ) VALUES (1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          xianyu_api_key = excluded.xianyu_api_key,
          updated_at = excluded.updated_at
      `)
      .run(apiKey, updatedAt);
  }

  ensureDownloadApiKey({ id, name, apiKey, createdAt }) {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO download_api_keys (
          id,
          name,
          api_key,
          created_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(id, name, apiKey, createdAt);
  }

  addDownloadApiKey({ id, name, apiKey, createdAt }) {
    this.database
      .prepare(`
        INSERT INTO download_api_keys (
          id,
          name,
          api_key,
          created_at
        ) VALUES (?, ?, ?, ?)
      `)
      .run(id, name, apiKey, createdAt);
  }

  listDownloadApiKeys() {
    return this.database
      .prepare(`
        SELECT id, name, api_key, created_at
        FROM download_api_keys
        ORDER BY created_at ASC, id ASC
      `)
      .all();
  }

  deleteDownloadApiKey(id) {
    return (
      this.database
        .prepare("DELETE FROM download_api_keys WHERE id = ?")
        .run(id).changes > 0
    );
  }

  upsertDiscoveredGames(games, seenAt) {
    const statement = this.database.prepare(`
      INSERT INTO games (
        id,
        source_url,
        title,
        image_url,
        hot_page,
        hot_position,
        hot_rank,
        first_seen_at,
        last_seen_at,
        scrape_status,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(id) DO UPDATE SET
        source_url = excluded.source_url,
        title = CASE
          WHEN games.last_scraped_at IS NULL
          THEN COALESCE(excluded.title, games.title)
          ELSE games.title
        END,
        image_url = CASE
          WHEN games.last_scraped_at IS NULL
          THEN COALESCE(excluded.image_url, games.image_url)
          ELSE games.image_url
        END,
        hot_page = excluded.hot_page,
        hot_position = excluded.hot_position,
        hot_rank = excluded.hot_rank,
        last_seen_at = excluded.last_seen_at,
        scrape_status = 'pending',
        updated_at = excluded.updated_at
    `);

    transaction(this.database, () => {
      for (const game of games) {
        statement.run(
          game.id,
          game.sourceUrl,
          game.title,
          game.imageUrl,
          game.hotPage,
          game.hotPosition,
          game.hotRank,
          seenAt,
          seenAt,
          seenAt,
        );
      }
    });
  }

  markGameAttempt(gameId, attemptedAt) {
    this.database
      .prepare(`
        UPDATE games
        SET last_attempt_at = ?,
            scrape_status = 'running',
            updated_at = ?
        WHERE id = ?
      `)
      .run(attemptedAt, attemptedAt, gameId);
  }

  getGameRefreshState(gameId) {
    return this.database
      .prepare(`
        SELECT
          source_updated_at,
          last_scraped_at,
          scrape_status,
          (SELECT COUNT(*) FROM downloads WHERE game_id = games.id) AS download_count
        FROM games
        WHERE id = ?
      `)
      .get(gameId);
  }

  saveGameUnchanged(gameId, sourceUpdatedAt, checkedAt) {
    this.database
      .prepare(`
        UPDATE games
        SET source_updated_at = ?,
            last_attempt_at = ?,
            scrape_status = 'success',
            last_error = NULL,
            updated_at = ?
        WHERE id = ?
      `)
      .run(sourceUpdatedAt, checkedAt, checkedAt, gameId);
  }

  saveGameSuccess(game, result, savedAt) {
    transaction(this.database, () => {
      const previous = this.database
        .prepare("SELECT * FROM games WHERE id = ?")
        .get(game.id);
      const previousDownloads = this.database
        .prepare(
          "SELECT * FROM downloads WHERE game_id = ? ORDER BY provider, url",
        )
        .all(game.id);
      const nextDownloads = result.resource.downloads ?? [];
      const nextHash = computeGameContentHash(
        {
          title: result.page.title,
          description: result.page.gameDescription,
          imageUrl: result.page.image,
          resourceCode: result.resource.resourceCode,
          detailPageUrl: result.resource.detailPageUrl,
          archivePassword: result.resource.archivePassword,
        },
        nextDownloads,
      );
      const previousHash = previous?.last_scraped_at
        ? (previous.content_hash ??
          computeGameContentHash(previous, previousDownloads))
        : null;
      const contentChanged = previousHash !== nextHash;
      const changeType = !previousHash
        ? "new"
        : contentChanged
          ? "updated"
          : (previous?.last_change_type ?? "unchanged");
      const changedAt = contentChanged
        ? savedAt
        : (previous?.last_changed_at ?? savedAt);

      this.database
        .prepare(`
          UPDATE games
          SET source_url = ?,
              title = ?,
              description = ?,
              image_url = ?,
              resource_code = ?,
              detail_page_url = ?,
              archive_password = ?,
              last_scraped_at = ?,
              last_attempt_at = ?,
              source_updated_at = ?,
              scrape_status = 'success',
              last_error = NULL,
              content_hash = ?,
              last_change_type = ?,
              last_changed_at = ?,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          result.page.url || game.sourceUrl,
          result.page.title,
          result.page.gameDescription,
          result.page.image,
          result.resource.resourceCode,
          result.resource.detailPageUrl,
          result.resource.archivePassword,
          savedAt,
          savedAt,
          result.page.sourceUpdatedAt ?? null,
          nextHash,
          changeType,
          changedAt,
          savedAt,
          game.id,
        );

      this.database
        .prepare("DELETE FROM downloads WHERE game_id = ?")
        .run(game.id);

      const insertDownload = this.database.prepare(`
        INSERT INTO downloads (
          game_id,
          provider,
          url,
          password,
          extraction_code,
          qr_image_url,
          decode_method,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const download of nextDownloads) {
        insertDownload.run(
          game.id,
          download.provider,
          download.url,
          download.password,
          download.extractionCode,
          download.qrImageUrl,
          download.qrDecodeMethod,
          savedAt,
          savedAt,
        );
      }

      if (nextDownloads.length > 0) {
        this.database
          .prepare(`
            INSERT INTO xianyu_material_sync (
              game_id,
              status,
              updated_at
            ) VALUES (?, 'pending', ?)
            ON CONFLICT(game_id) DO UPDATE SET
              status = CASE
                WHEN xianyu_material_sync.synced_content_hash IS NULL
                  OR xianyu_material_sync.synced_content_hash != ?
                THEN 'pending'
                ELSE xianyu_material_sync.status
              END,
              last_error = CASE
                WHEN xianyu_material_sync.synced_content_hash IS NULL
                  OR xianyu_material_sync.synced_content_hash != ?
                THEN NULL
                ELSE xianyu_material_sync.last_error
              END,
              updated_at = excluded.updated_at
          `)
          .run(game.id, savedAt, nextHash, nextHash);
      } else if (previousDownloads.length > 0) {
        this.database
          .prepare(`
            INSERT INTO xianyu_material_sync (
              game_id,
              status,
              last_error,
              updated_at
            ) VALUES (?, 'failed', '下载资源已消失，未修改或下架线上闲鱼商品', ?)
            ON CONFLICT(game_id) DO UPDATE SET
              status = 'failed',
              last_error = excluded.last_error,
              updated_at = excluded.updated_at
          `)
          .run(game.id, savedAt);
      }
    });
  }

  saveGameFailure(gameId, errorMessage, attemptedAt) {
    this.database
      .prepare(`
        UPDATE games
        SET last_attempt_at = ?,
            scrape_status = 'failed',
            last_error = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        attemptedAt,
        errorMessage.slice(0, 4_000),
        attemptedAt,
        gameId,
      );
  }

  getXianyuSyncSettings() {
    const row =
      this.database
        .prepare(
          `SELECT
             account_id,
             default_price,
             default_stock,
             title_template,
             description_template,
             image_template,
             updated_at
           FROM xianyu_sync_settings
           WHERE id = 1`,
        )
        .get();
    return {
      account_id: row?.account_id ?? null,
      default_price: Number(row?.default_price ?? 1),
      default_stock: Number(row?.default_stock ?? 999),
      title_template:
        row?.title_template ?? DEFAULT_XIANYU_TEMPLATES.titleTemplate,
      description_template:
        row?.description_template ??
        DEFAULT_XIANYU_TEMPLATES.descriptionTemplate,
      image_template:
        row?.image_template ?? DEFAULT_XIANYU_TEMPLATES.imageTemplate,
      updated_at: row?.updated_at ?? null,
    };
  }

  setXianyuSettings(
    accountId,
    defaultPrice,
    updatedAt,
    templates = null,
    defaultStock = null,
  ) {
    transaction(this.database, () => {
      const previous = this.getXianyuSyncSettings();
      const resolvedDefaultStock = Number(
        defaultStock ?? previous.default_stock ?? 999,
      );
      const normalizedTemplates = normalizeXianyuTemplates(
        templates ?? {
          titleTemplate: previous.title_template,
          descriptionTemplate: previous.description_template,
          imageTemplate: previous.image_template,
        },
      );
      this.database
        .prepare(`
          INSERT INTO xianyu_sync_settings (
            id,
            account_id,
            default_price,
            default_stock,
            title_template,
            description_template,
            image_template,
            updated_at
          ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            account_id = excluded.account_id,
            default_price = excluded.default_price,
            default_stock = excluded.default_stock,
            title_template = excluded.title_template,
            description_template = excluded.description_template,
            image_template = excluded.image_template,
            updated_at = excluded.updated_at
        `)
        .run(
          accountId,
          defaultPrice,
          resolvedDefaultStock,
          normalizedTemplates.titleTemplate,
          normalizedTemplates.descriptionTemplate,
          normalizedTemplates.imageTemplate,
          updatedAt,
        );
      if (Number(previous.default_price) !== Number(defaultPrice)) {
        this.database
          .prepare(`
            UPDATE xianyu_material_sync
            SET status = 'pending',
                updated_at = ?
            WHERE game_id IN (
              SELECT id FROM games WHERE sale_price IS NULL
            )
          `)
          .run(updatedAt);
      }
      if (Number(previous.default_stock) !== resolvedDefaultStock) {
        this.database
          .prepare(`
            UPDATE xianyu_material_sync
            SET status = 'pending',
                updated_at = ?
          `)
          .run(updatedAt);
      }
      if (
        previous.title_template !== normalizedTemplates.titleTemplate ||
        previous.description_template !==
          normalizedTemplates.descriptionTemplate ||
        previous.image_template !== normalizedTemplates.imageTemplate
      ) {
        this.database
          .prepare(`
            UPDATE xianyu_material_sync
            SET status = 'pending',
                updated_at = ?
          `)
          .run(updatedAt);
      }
    });
  }

  setXianyuAccountId(accountId, updatedAt) {
    const settings = this.getXianyuSyncSettings();
    this.setXianyuSettings(
      accountId,
      Number(settings.default_price ?? 1),
      updatedAt,
      null,
      Number(settings.default_stock ?? 999),
    );
  }

  setGameSalePrice(gameId, salePrice, updatedAt) {
    const result = this.database
      .prepare(`
        UPDATE games
        SET sale_price = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(salePrice, updatedAt, gameId);
    if (result.changes === 0) return false;
    this.database
      .prepare(`
        UPDATE xianyu_material_sync
        SET status = 'pending',
            updated_at = ?
        WHERE game_id = ?
      `)
      .run(updatedAt, gameId);
    return true;
  }

  getSchedulerSettings(defaults, updatedAt) {
    this.database
      .prepare(`
        INSERT OR IGNORE INTO scheduler_settings (
          id,
          cron_timezone,
          crawl_cron_schedule,
          crawl_enabled,
          sync_cron_schedule,
          sync_enabled,
          sync_mode,
          crawl_concurrency,
          material_concurrency,
          publish_batch_size,
          publish_concurrency,
          updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        defaults.cronTimezone,
        defaults.crawlCronSchedule,
        defaults.crawlEnabled ? 1 : 0,
        defaults.syncCronSchedule,
        defaults.syncEnabled ? 1 : 0,
        defaults.syncMode ?? "all",
        defaults.crawlConcurrency ?? 3,
        defaults.materialConcurrency ?? 4,
        defaults.publishBatchSize ?? 20,
        defaults.publishConcurrency ?? 4,
        updatedAt,
      );
    return this.database
      .prepare("SELECT * FROM scheduler_settings WHERE id = 1")
      .get();
  }

  setSchedulerSettings(settings, updatedAt) {
    this.database
      .prepare(`
        INSERT INTO scheduler_settings (
          id,
          cron_timezone,
          crawl_cron_schedule,
          crawl_enabled,
          sync_cron_schedule,
          sync_enabled,
          sync_mode,
          crawl_concurrency,
          material_concurrency,
          publish_batch_size,
          publish_concurrency,
          updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          cron_timezone = excluded.cron_timezone,
          crawl_cron_schedule = excluded.crawl_cron_schedule,
          crawl_enabled = excluded.crawl_enabled,
          sync_cron_schedule = excluded.sync_cron_schedule,
          sync_enabled = excluded.sync_enabled,
          sync_mode = excluded.sync_mode,
          crawl_concurrency = excluded.crawl_concurrency,
          material_concurrency = excluded.material_concurrency,
          publish_batch_size = excluded.publish_batch_size,
          publish_concurrency = excluded.publish_concurrency,
          updated_at = excluded.updated_at
      `)
      .run(
        settings.cronTimezone,
        settings.crawlCronSchedule,
        settings.crawlEnabled ? 1 : 0,
        settings.syncCronSchedule,
        settings.syncEnabled ? 1 : 0,
        settings.syncMode ?? "all",
        settings.crawlConcurrency,
        settings.materialConcurrency,
        settings.publishBatchSize,
        settings.publishConcurrency,
        updatedAt,
      );
    return this.database
      .prepare("SELECT * FROM scheduler_settings WHERE id = 1")
      .get();
  }

  startSyncRun(triggerType, accountId, syncMode, requestedLimit, startedAt) {
    const result = this.database
      .prepare(`
        INSERT INTO xianyu_sync_runs (
          trigger_type,
          account_id,
          sync_mode,
          requested_limit,
          status,
          started_at
        ) VALUES (?, ?, ?, ?, 'running', ?)
      `)
      .run(triggerType, accountId, syncMode, requestedLimit, startedAt);
    return Number(result.lastInsertRowid);
  }

  updateSyncRun(runId, fields) {
    const allowed = new Set([
      "status",
      "selected_count",
      "material_created",
      "material_updated",
      "material_unchanged",
      "material_skipped",
      "material_failed",
      "material_processed_count",
      "publish_selected_count",
      "publish_processed_count",
      "publish_submitted",
      "publish_success",
      "publish_failed",
      "card_bound",
      "card_bind_failed",
      "batch_count",
      "batch_id",
      "processed_count",
      "current_game_id",
      "current_title",
      "error_summary",
      "finished_at",
    ]);
    const entries = Object.entries(fields).filter(([key]) => allowed.has(key));
    if (entries.length === 0) return;
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    this.database
      .prepare(`UPDATE xianyu_sync_runs SET ${assignments} WHERE id = ?`)
      .run(...entries.map(([, value]) => value), runId);
  }

  getSyncScopeProgress(accountId, mode = "all", gameIds = null) {
    const normalizedMode = new Set([
      "all",
      "pending",
      "updated",
    ]).has(mode)
      ? mode
      : "all";
    const conditions = [VALID_GAME_DATA_CONDITION];
    const parameters = [accountId];
    if (normalizedMode === "pending") {
      conditions.push(
        "games.xianyu_item_id IS NULL",
        "publication.item_id IS NULL",
        "COALESCE(publication.status, 'pending') != 'success'",
      );
    } else if (normalizedMode === "updated") {
      conditions.push("games.last_change_type = 'updated'");
    }
    const requestedGameIds = Array.isArray(gameIds)
      ? gameIds
          .map((gameId) => Number(gameId))
          .filter(Number.isInteger)
      : [];
    if (requestedGameIds.length > 0) {
      conditions.push(
        `games.id IN (${requestedGameIds.map(() => "?").join(", ")})`,
      );
      parameters.push(...requestedGameIds);
    }
    const row = this.database
      .prepare(`
        SELECT
          COUNT(*) AS total,
          SUM(
            CASE
              WHEN material.material_id IS NOT NULL
               AND material.status IN ('synced', 'skipped')
              THEN 1
              ELSE 0
            END
          ) AS material_completed,
          SUM(
            CASE
              WHEN games.xianyu_item_id IS NOT NULL
                OR publication.item_id IS NOT NULL
                OR publication.status = 'success'
              THEN 1
              ELSE 0
            END
          ) AS publish_completed,
          SUM(
            CASE
              WHEN material.status = 'skipped'
               AND games.xianyu_item_id IS NULL
               AND publication.item_id IS NULL
               AND COALESCE(publication.status, 'pending') != 'success'
              THEN 1
              ELSE 0
            END
          ) AS publish_skipped
        FROM games
        LEFT JOIN xianyu_material_sync AS material
          ON material.game_id = games.id
        LEFT JOIN xianyu_publications AS publication
          ON publication.game_id = games.id
         AND publication.account_id = ?
        WHERE ${conditions.join("\n          AND ")}
      `)
      .get(...parameters);
    return {
      total: Number(row.total ?? 0),
      materialCompleted: Number(row.material_completed ?? 0),
      publishCompleted: Number(row.publish_completed ?? 0),
      publishSkipped: Number(row.publish_skipped ?? 0),
    };
  }

  listSyncCandidates(accountId, limit, mode = "all") {
    const settings = this.getXianyuSyncSettings();
    const rows = this.database
      .prepare(`
        SELECT
          games.*,
          COALESCE(
            games.sale_price,
            settings.default_price,
            1
          ) AS effective_price,
          material.material_id,
          material.synced_content_hash,
          material.status AS material_sync_status,
          publication.status AS publication_status,
          publication.batch_id AS publication_batch_id,
          publication.item_id AS publication_item_id,
          publication.item_url AS publication_item_url,
          publication.card_id AS publication_card_id,
          publication.card_bind_status AS publication_card_bind_status,
          publication.card_bind_error AS publication_card_bind_error
        FROM games
        LEFT JOIN xianyu_sync_settings AS settings
          ON settings.id = 1
        LEFT JOIN xianyu_material_sync AS material
          ON material.game_id = games.id
        LEFT JOIN xianyu_publications AS publication
          ON publication.game_id = games.id
         AND publication.account_id = ?
        WHERE ${VALID_GAME_DATA_CONDITION}
          AND games.xianyu_item_id IS NULL
          AND publication.item_id IS NULL
          AND COALESCE(publication.status, 'pending') NOT IN ('publishing', 'unknown', 'success')
        ORDER BY
          CASE WHEN publication.status = 'failed' THEN 0 ELSE 1 END,
          COALESCE(games.last_changed_at, games.first_seen_at) ASC,
          CASE WHEN games.hot_rank IS NULL THEN 1 ELSE 0 END,
          games.hot_rank ASC
      `)
      .all(accountId);
    const downloadStatement = this.database.prepare(
      `SELECT *
       FROM downloads
       WHERE game_id = ?
         AND (
           trim(url) LIKE 'http://%'
           OR trim(url) LIKE 'https://%'
         )
       ORDER BY provider, url`,
    );
    const normalizedMode = new Set([
      "all",
      "pending",
      "updated",
    ]).has(mode)
      ? mode
      : "all";
    return rows
      .map((row) => {
        const downloads = downloadStatement.all(row.id);
        const syncContentHash = createHash("sha256")
          .update(
            JSON.stringify({
              contentHash: row.content_hash,
              effectivePrice: Number(row.effective_price).toFixed(2),
              defaultStock: Number(settings.default_stock ?? 999),
              titleTemplate: settings.title_template,
              descriptionTemplate: settings.description_template,
              imageTemplate: settings.image_template,
              copyVersion: 3,
            }),
          )
          .digest("hex");
        return {
          ...row,
          sync_content_hash: syncContentHash,
          downloads,
        };
      })
      .filter((row) => {
        const materialNeedsSync =
          row.material_id == null ||
          row.synced_content_hash == null ||
          row.synced_content_hash !== row.sync_content_hash ||
          ["pending", "failed"].includes(row.material_sync_status);
        const publicationNeedsSync =
          (row.publication_status == null &&
            row.material_sync_status !== "skipped") ||
          row.publication_status === "failed" ||
          (row.publication_status === "success" &&
            row.publication_card_bind_status !== "success");
        if (normalizedMode === "pending") {
          return publicationNeedsSync;
        }
        if (normalizedMode === "updated") {
          return row.publication_status === "success" && materialNeedsSync;
        }
        return row.material_sync_status !== "skipped";
      })
      .slice(0, limit);
  }

  markMaterialSynced(gameId, materialId, contentHash, syncedAt) {
    this.database
      .prepare(`
        INSERT INTO xianyu_material_sync (
          game_id,
          material_id,
          synced_content_hash,
          status,
          last_error,
          last_synced_at,
          updated_at
        ) VALUES (?, ?, ?, 'synced', NULL, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
          material_id = excluded.material_id,
          synced_content_hash = excluded.synced_content_hash,
          status = 'synced',
          last_error = NULL,
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at
      `)
      .run(gameId, materialId, contentHash, syncedAt, syncedAt);
  }

  markMaterialFailed(gameId, errorMessage, updatedAt) {
    this.database
      .prepare(`
        INSERT INTO xianyu_material_sync (
          game_id,
          status,
          last_error,
          updated_at
        ) VALUES (?, 'failed', ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
          status = 'failed',
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `)
      .run(gameId, String(errorMessage).slice(0, 4_000), updatedAt);
  }

  markMaterialSkipped(
    gameId,
    materialId,
    contentHash,
    reason,
    updatedAt,
  ) {
    this.database
      .prepare(`
        INSERT INTO xianyu_material_sync (
          game_id,
          material_id,
          synced_content_hash,
          status,
          last_error,
          last_synced_at,
          updated_at
        ) VALUES (?, ?, ?, 'skipped', ?, ?, ?)
        ON CONFLICT(game_id) DO UPDATE SET
          material_id = excluded.material_id,
          synced_content_hash = excluded.synced_content_hash,
          status = 'skipped',
          last_error = excluded.last_error,
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at
      `)
      .run(
        gameId,
        materialId,
        contentHash,
        String(reason).slice(0, 4_000),
        updatedAt,
        updatedAt,
      );
  }

  markPublicationSubmitted(
    gameId,
    accountId,
    materialId,
    batchId,
    attemptedAt,
  ) {
    this.database
      .prepare(`
        INSERT INTO xianyu_publications (
          game_id,
          account_id,
          material_id,
          status,
          batch_id,
          attempt_count,
          last_attempt_at,
          updated_at
        ) VALUES (?, ?, ?, 'publishing', ?, 1, ?, ?)
        ON CONFLICT(game_id, account_id) DO UPDATE SET
          material_id = excluded.material_id,
          status = 'publishing',
          batch_id = excluded.batch_id,
          last_error = NULL,
          card_id = NULL,
          card_bind_status = 'pending',
          card_bind_error = NULL,
          card_bound_at = NULL,
          attempt_count = xianyu_publications.attempt_count + 1,
          last_attempt_at = excluded.last_attempt_at,
          updated_at = excluded.updated_at
      `)
      .run(
        gameId,
        accountId,
        materialId,
        batchId,
        attemptedAt,
        attemptedAt,
      );
  }

  markPublicationResult({
    gameId,
    accountId,
    status,
    itemId = null,
    itemUrl = null,
    errorMessage = null,
    updatedAt,
  }) {
    transaction(this.database, () => {
      this.database
        .prepare(`
          UPDATE xianyu_publications
          SET status = ?,
              item_id = COALESCE(?, item_id),
              item_url = COALESCE(?, item_url),
              last_error = ?,
              published_at = CASE WHEN ? = 'success' THEN ? ELSE published_at END,
              updated_at = ?
          WHERE game_id = ? AND account_id = ?
        `)
        .run(
          status,
          itemId,
          itemUrl,
          errorMessage ? String(errorMessage).slice(0, 4_000) : null,
          status,
          updatedAt,
          updatedAt,
          gameId,
          accountId,
        );
      if (status !== "success") return;
      const publication = this.database
        .prepare(`
          SELECT item_id, item_url, published_at
          FROM xianyu_publications
          WHERE game_id = ? AND account_id = ?
        `)
        .get(gameId, accountId);
      if (!publication?.item_id) return;
      this.database
        .prepare(`
          UPDATE games
          SET xianyu_item_id = ?,
              xianyu_item_url = ?,
              xianyu_account_id = ?,
              xianyu_published_at = ?
          WHERE id = ?
        `)
        .run(
          publication.item_id,
          publication.item_url,
          accountId,
          publication.published_at ?? updatedAt,
          gameId,
        );
    });
  }

  markCardBindingResult({
    gameId,
    accountId,
    cardId,
    status,
    errorMessage = null,
    updatedAt,
  }) {
    this.database
      .prepare(`
        UPDATE xianyu_publications
        SET card_id = ?,
            card_bind_status = ?,
            card_bind_error = ?,
            card_bound_at = CASE
              WHEN ? = 'success' THEN ?
              ELSE card_bound_at
            END,
            updated_at = ?
        WHERE game_id = ? AND account_id = ?
      `)
      .run(
        cardId,
        status,
        errorMessage ? String(errorMessage).slice(0, 4_000) : null,
        status,
        updatedAt,
        updatedAt,
        gameId,
        accountId,
      );
  }

  getRecentSyncRuns(limit = 20) {
    return this.database
      .prepare(
        `SELECT *
         FROM xianyu_sync_runs
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(limit);
  }

  queryOne(sql, ...parameters) {
    return this.database.prepare(sql).get(...parameters);
  }

  queryAll(sql, ...parameters) {
    return this.database.prepare(sql).all(...parameters);
  }
}
