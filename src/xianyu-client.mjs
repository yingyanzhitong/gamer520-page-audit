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

  async request(
    pathname,
    {
      method = "GET",
      body,
      timeoutMs = this.timeoutMs,
      signal = null,
    } = {},
  ) {
    this.ensureConfigured();
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        accept: "application/json",
        "x-api-key": this.apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal,
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

  async listAccounts({ signal = null } = {}) {
    const payload = await this.request("/api/v1/cookies/options", {
      signal,
    });
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

  async upsertMaterials(items, { signal = null } = {}) {
    const payload = await this.request(
      "/api/v1/product-publish/materials/external/upsert",
      {
        method: "POST",
        body: {
          source: "gamer520",
          items,
        },
        signal,
      },
    );
    return payload?.data?.items ?? [];
  }

  async publishBatch(
    { accountId, materialIds, requestId },
    { signal = null } = {},
  ) {
    const payload = await this.request(
      "/api/v1/product-publish/publish/batch",
      {
        method: "POST",
        body: {
          account_ids: [accountId],
          material_ids: materialIds,
          request_id: requestId,
        },
        signal,
      },
    );
    return payload?.data ?? {};
  }

  async publishSingle(
    {
      accountId,
      title,
      description,
      price,
      images,
      category,
      deliveryMethod = "express",
      postage = 0,
      condition = "全新",
    },
    { signal = null } = {},
  ) {
    const payload = await this.request(
      "/api/v1/product-publish/publish/single",
      {
        method: "POST",
        timeoutMs: 10 * 60 * 1_000,
        body: {
          account_id: accountId,
          title,
          description,
          price,
          images,
          category,
          delivery_method: deliveryMethod,
          postage,
          condition,
        },
        signal,
      },
    );
    return {
      ...(payload?.data ?? {}),
      message: payload?.message ?? null,
    };
  }

  async getBatchStatus(batchId, { signal = null } = {}) {
    const payload = await this.request(
      `/api/v1/product-publish/publish/batch/${encodeURIComponent(batchId)}/status`,
      { signal },
    );
    return payload?.data ?? {};
  }

  async refreshAccountItems(accountId, { signal = null } = {}) {
    return this.request("/api/v1/items/get-all-from-account", {
      method: "POST",
      body: {
        cookie_id: accountId,
        page_size: 20,
      },
      signal,
    });
  }

  async listAccountItems(accountId, { signal = null } = {}) {
    const payload = await this.request(
      `/api/v1/items/cookie/${encodeURIComponent(accountId)}`,
      { signal },
    );
    return Array.isArray(payload?.items) ? payload.items : [];
  }

  async bindCards(
    { cardIds, itemIds, itemTitle },
    { signal = null } = {},
  ) {
    const payload = await this.request(
      "/api/v1/cards/batch-bind",
      {
        method: "POST",
        body: {
          card_ids: cardIds,
          item_ids: itemIds,
          item_title: itemTitle,
        },
        signal,
      },
    );
    return payload?.data ?? {};
  }
}
