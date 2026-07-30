export class XianyuApiError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = "XianyuApiError";
    this.status = status;
    this.payload = payload;
  }
}

export class XianyuClient {
  constructor({ baseUrl, apiKey, timeoutMs = 30_000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  ensureConfigured() {
    if (!this.apiKey) {
      throw new XianyuApiError("未配置 XIANYU_API_KEY", { status: 503 });
    }
  }

  async request(pathname, { method = "GET", body } = {}) {
    this.ensureConfigured();
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        "x-api-key": this.apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new XianyuApiError(
        payload?.detail ?? payload?.message ?? `闲鱼接口返回 HTTP ${response.status}`,
        { status: response.status, payload },
      );
    }
    if (
      payload &&
      typeof payload === "object" &&
      "success" in payload &&
      payload.success === false
    ) {
      throw new XianyuApiError(payload.message ?? "闲鱼接口调用失败", {
        status: response.status,
        payload,
      });
    }
    return payload;
  }

  async listAccounts() {
    const payload = await this.request("/api/v1/cookies/options");
    if (!Array.isArray(payload)) {
      throw new XianyuApiError("闲鱼账号接口返回格式无效");
    }
    return payload.map((account) => ({
      accountId: String(account.id),
      enabled: Boolean(account.enabled),
      remark: account.remark ?? "",
      pk: account.pk,
    }));
  }

  async upsertMaterials(items) {
    const payload = await this.request(
      "/api/v1/product-publish/materials/external/upsert",
      {
        method: "POST",
        body: {
          source: "gamer520",
          items,
        },
      },
    );
    return payload?.data?.items ?? [];
  }

  async publishBatch({ accountId, materialIds, requestId }) {
    const payload = await this.request(
      "/api/v1/product-publish/publish/batch",
      {
        method: "POST",
        body: {
          account_ids: [accountId],
          material_ids: materialIds,
          request_id: requestId,
        },
      },
    );
    return payload?.data ?? {};
  }

  async getBatchStatus(batchId) {
    const payload = await this.request(
      `/api/v1/product-publish/publish/batch/${encodeURIComponent(batchId)}/status`,
    );
    return payload?.data ?? {};
  }

  async refreshAccountItems(accountId) {
    return this.request("/api/v1/items/get-all-from-account", {
      method: "POST",
      body: {
        cookie_id: accountId,
        page_size: 20,
      },
    });
  }

  async listAccountItems(accountId) {
    const payload = await this.request(
      `/api/v1/items/cookie/${encodeURIComponent(accountId)}`,
    );
    return Array.isArray(payload?.items) ? payload.items : [];
  }

  async bindCards({ cardIds, itemIds, itemTitle }) {
    const payload = await this.request("/api/v1/cards/batch-bind", {
      method: "POST",
      body: {
        card_ids: cardIds,
        item_ids: itemIds,
        item_title: itemTitle,
      },
    });
    return payload?.data ?? {};
  }
}
