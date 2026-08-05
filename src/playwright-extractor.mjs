import jsQR from "jsqr";
import { chromium } from "playwright";
import sharp from "sharp";

import {
  parseGameId,
  passwordFromUrl,
  selectImageUrl,
} from "./utils.mjs";

export class AccessBlockedError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "AccessBlockedError";
    this.status = status;
  }
}

function decodeHttpUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function embeddedQrData(qrImageUrl) {
  if (!qrImageUrl) return null;
  try {
    return decodeHttpUrl(new URL(qrImageUrl).searchParams.get("data"));
  } catch {
    return null;
  }
}

async function decodeQrBuffer(image) {
  const { data, info } = await sharp(image)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = jsQR(
    Uint8ClampedArray.from(data),
    info.width,
    info.height,
    { inversionAttempts: "attemptBoth" },
  );
  return decodeHttpUrl(decoded?.data);
}

async function decodeQrLocator(qrImage, detailPage, timeoutMs) {
  const source = decodeHttpUrl(
    await qrImage.getAttribute("src"),
    detailPage.url(),
  );
  const embedded = embeddedQrData(source);

  try {
    await qrImage.waitFor({ state: "visible", timeout: timeoutMs });
    await qrImage.evaluate(async (image) => {
      if (image.complete && image.naturalWidth > 0) return;
      await new Promise((resolve, reject) => {
        image.addEventListener("load", resolve, { once: true });
        image.addEventListener("error", reject, { once: true });
      });
    });

    const screenshot = await qrImage.screenshot({
      animations: "disabled",
      type: "png",
    });
    const decodedUrl = await decodeQrBuffer(screenshot);
    if (decodedUrl) {
      return {
        url: decodedUrl,
        qrImageUrl: source,
        method: "playwright-element-screenshot",
      };
    }
  } catch (error) {
    if (!source && !embedded) throw error;
  }

  if (source) {
    try {
      const response = await detailPage.request.get(source, {
        headers: { referer: detailPage.url() },
        timeout: timeoutMs,
      });
      if (response.ok()) {
        const decodedUrl = await decodeQrBuffer(await response.body());
        if (decodedUrl) {
          return {
            url: decodedUrl,
            qrImageUrl: source,
            method: "playwright-request-image",
          };
        }
      }
    } catch (error) {
      if (!embedded) throw error;
    }
  }

  if (embedded) {
    return {
      url: embedded,
      qrImageUrl: source,
      method: "qr-query-fallback",
    };
  }

  return {
    url: null,
    qrImageUrl: source,
    method: "failed",
  };
}

async function extractGameDescription(page) {
  return page.evaluate(() => {
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() || "";
    const headings = [...document.querySelectorAll("strong, h2, h3, h4")];
    const descriptionHeading = headings.find(
      (element) => normalize(element.textContent) === "游戏简介",
    );

    if (descriptionHeading) {
      const scope = descriptionHeading.parentElement;
      const paragraph = scope
        ? [...scope.querySelectorAll("p")]
            .map((element) => normalize(element.textContent))
            .find((text) => text.length >= 20)
        : null;
      if (paragraph) return paragraph;

      const siblingText = normalize(
        descriptionHeading.nextElementSibling?.textContent,
      );
      if (siblingText.length >= 20) return siblingText;
    }

    const content = document.querySelector(".entry-content");
    if (content) {
      const paragraph = [...content.querySelectorAll("p")]
        .filter(
          (element) =>
            !element.closest(
              ".ssgc-details-body, .ssgc-shots-list, .ssgc-spec-grid",
            ),
        )
        .map((element) => normalize(element.textContent))
        .find(
          (text) =>
            text.length >= 40 &&
            !/解压密码|提取码|获取资源|重要通知|系统需求/.test(text),
        );
      if (paragraph) return paragraph;
    }

    return (
      document
        .querySelector('meta[name="description"]')
        ?.getAttribute("content")
        ?.replace(/\s+/g, " ")
        .trim() || null
    );
  });
}

function assertAllowedArticleUrl(pageUrl) {
  const parsed = new URL(pageUrl);
  if (
    !/(^|\.)gamer520\.com$/i.test(parsed.hostname) ||
    !/\/\d+\.html$/.test(parsed.pathname)
  ) {
    throw new Error("仅允许解析 gamer520.com 数字文章页面");
  }
}

function responseError(response, label) {
  const status = response?.status() ?? null;
  if (status === 403 || status === 429) {
    return new AccessBlockedError(`${label}被拒绝：HTTP ${status}`, status);
  }
  return new Error(`${label}请求失败：HTTP ${status ?? "unknown"}`);
}

export async function validateImageUrl(
  context,
  imageUrl,
  referer,
  config,
) {
  if (!imageUrl) return false;
  try {
    const response = await context.request.get(imageUrl, {
      timeout: config.navigationTimeoutMs,
      headers: {
        accept: "image/avif,image/webp,image/png,image/jpeg,image/*",
        referer,
      },
    });
    const contentType = String(
      response.headers()["content-type"] ?? "",
    ).toLowerCase();
    return response.ok() && contentType.startsWith("image/");
  } catch {
    return false;
  }
}

function normalizeSourceUpdatedAt(value, { utc = false } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized =
    utc && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? `${raw}Z` : raw;
  const timestamp = new Date(normalized);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

export function isSourceTimestampCurrent(sourceUpdatedAt, lastScrapedAt) {
  const sourceTimestamp = normalizeSourceUpdatedAt(sourceUpdatedAt);
  const scrapedTimestamp = normalizeSourceUpdatedAt(lastScrapedAt);
  if (!sourceTimestamp || !scrapedTimestamp) return false;
  return new Date(sourceTimestamp).getTime() <= new Date(scrapedTimestamp).getTime();
}

export async function fetchSourceUpdateTimes(
  context,
  sourceUrl,
  gameIds,
  config,
) {
  assertAllowedArticleUrl(sourceUrl);
  const ids = [...new Set(gameIds)]
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (ids.length === 0) return new Map();
  if (ids.length > 100) {
    throw new Error("来源更新时间接口单次最多查询 100 个文章 ID");
  }

  const endpoint = new URL("/wp-json/wp/v2/posts", sourceUrl);
  endpoint.searchParams.set("include", ids.join(","));
  endpoint.searchParams.set("per_page", String(ids.length));
  endpoint.searchParams.set("_fields", "id,modified_gmt,modified");

  const response = await context.request.get(endpoint.href, {
    timeout: config.navigationTimeoutMs,
    headers: { accept: "application/json" },
  });
  if (!response.ok()) {
    throw responseError(response, "来源更新时间接口");
  }

  const records = await response.json();
  if (!Array.isArray(records)) {
    throw new Error("来源更新时间接口返回格式异常");
  }

  const timestamps = new Map();
  for (const record of records) {
    const id = Number(record?.id);
    const timestamp =
      normalizeSourceUpdatedAt(record?.modified_gmt, { utc: true }) ??
      normalizeSourceUpdatedAt(record?.modified);
    if (ids.includes(id) && timestamp) timestamps.set(id, timestamp);
  }
  return timestamps;
}

export async function launchBrowser(config) {
  const options = { headless: config.headless };
  if (config.playwrightChannel) {
    options.channel = config.playwrightChannel;
  }
  return chromium.launch(options);
}

export async function createCrawlerContext(browser) {
  const context = await browser.newContext({ locale: "zh-CN" });
  context.on("page", (page) => {
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
  });
  return context;
}

export async function discoverListPage(
  context,
  pageUrl,
  pageNumber,
  config,
) {
  const page = await context.newPage();
  try {
    const response = await page.goto(pageUrl, {
      timeout: config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });
    if (!response?.ok()) throw responseError(response, "热度列表页");

    const articles = page.locator(
      "main.site-main .posts-wrapper article.category-pcplay",
    );
    const items = await articles.evaluateAll((nodes) =>
      nodes.map((article, index) => {
        const anchor = article.querySelector(
          'h2.entry-title a[rel="bookmark"]',
        );
        const image = article.querySelector(".entry-media img");
        const id = Number(article.id.replace(/^post-/, ""));
        return {
          id,
          sourceUrl: anchor?.href || null,
          title:
            anchor?.getAttribute("title") ||
            anchor?.textContent?.replace(/\s+/g, " ").trim() ||
            null,
          imageUrl:
            image?.getAttribute("data-src") ||
            image?.getAttribute("src") ||
            null,
          hotPosition: index + 1,
        };
      }),
    );

    return items
      .filter(
        (item) =>
          Number.isInteger(item.id) &&
          item.id > 0 &&
          /^https:\/\/www\.gamer520\.com\/\d+\.html$/i.test(
            item.sourceUrl || "",
          ),
      )
      .map((item) => ({
        ...item,
        hotPage: pageNumber,
        hotRank: (pageNumber - 1) * 20 + item.hotPosition,
      }));
  } finally {
    await page.close().catch(() => {});
  }
}

function providerFromUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    if (/pan\.baidu\.com$/i.test(hostname)) return "百度网盘";
    if (/pan\.quark\.cn$/i.test(hostname)) return "夸克网盘";
    if (/pan\.xunlei\.com$/i.test(hostname)) return "迅雷云盘";
    if (/(^|\.)gofile\.io$/i.test(hostname)) return "GOFILE 海外盘";
    return hostname;
  } catch {
    return "未知来源";
  }
}

async function openDetailViaClick(
  context,
  articlePage,
  resourceButton,
  config,
) {
  const timeout = Math.min(config.navigationTimeoutMs, 10_000);
  await articlePage.waitForFunction(
    () => {
      const button = document.querySelector("#cao_widget_pay-4 .go-down");
      const jquery = window.jQuery;
      return Boolean(
        button &&
          jquery &&
          jquery._data(button, "events")?.click?.length,
      );
    },
    null,
    { timeout },
  );

  await resourceButton.click();
  await articlePage.waitForFunction(
    () =>
      [...document.querySelectorAll(".swal2-title")].some((element) =>
        element.textContent?.includes("下载地址获取成功"),
      ),
    null,
    { timeout },
  );

  const successModal = articlePage.locator(".swal2-popup.swal2-show");
  if ((await successModal.count()) !== 1) {
    const visibleText = await articlePage.locator("body").innerText();
    if (/验证|频繁|限制|登录|captcha/i.test(visibleText)) {
      throw new AccessBlockedError("资源入口要求验证或限制访问");
    }
    throw new Error("没有找到唯一的资源成功弹窗");
  }

  const immediateDownload = successModal.locator(".swal2-confirm");
  if ((await immediateDownload.count()) !== 1) {
    throw new Error("没有找到唯一的“立即下载”按钮");
  }

  const detailPagePromise = articlePage.waitForEvent("popup", {
    timeout,
  });
  await immediateDownload.click();
  const detailPage = await detailPagePromise;
  await detailPage.waitForURL(
    (url) => /(^|\.)gamers520\.com$/i.test(url.hostname),
    {
      timeout: config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    },
  );
  return detailPage;
}

async function openDetailViaRequest(context, pageUrl, config) {
  const postId = parseGameId(pageUrl);
  if (!postId) throw new Error("无法从文章 URL 获取资源文章 ID");

  const ajaxUrl = new URL("/wp-admin/admin-ajax.php", pageUrl).href;
  const response = await context.request.post(ajaxUrl, {
    form: {
      action: "user_down_ajax",
      post_id: String(postId),
    },
    headers: {
      referer: pageUrl,
      "x-requested-with": "XMLHttpRequest",
    },
    timeout: config.navigationTimeoutMs,
  });
  if (!response.ok()) {
    if ([403, 429].includes(response.status())) {
      throw new AccessBlockedError(
        `资源接口被拒绝：HTTP ${response.status()}`,
        response.status(),
      );
    }
    throw new Error(`资源接口失败：HTTP ${response.status()}`);
  }

  const payload = await response.json();
  const landingUrl = decodeHttpUrl(payload?.msg, pageUrl);
  if (String(payload?.status) !== "1" || !landingUrl) {
    const message = String(payload?.msg || "未知错误");
    if (/验证|频繁|限制|登录|captcha/i.test(message)) {
      throw new AccessBlockedError(`资源接口受限：${message}`);
    }
    throw new Error(`资源接口返回失败：${message}`);
  }

  const detailPage = await context.newPage();
  const landingResponse = await detailPage.goto(landingUrl, {
    timeout: config.navigationTimeoutMs,
    waitUntil: "domcontentloaded",
  });
  if (!landingResponse?.ok()) {
    throw responseError(landingResponse, "资源中间页");
  }
  await detailPage.waitForURL(
    (url) => /(^|\.)gamers520\.com$/i.test(url.hostname),
    {
      timeout: config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    },
  );
  return detailPage;
}

async function unlockProtectedDetail(detailPage, resourceCode, config) {
  const form = detailPage.locator("form.post-password-form");
  if ((await form.count()) === 0) return;

  const password = resourceCode?.trim();
  if (!password) {
    throw new Error("资源详情页需要密码，但文章页没有资源编号");
  }

  const input = form.locator('input[name="post_password"]');
  const submit = form.locator('input[type="submit"]');
  if ((await input.count()) !== 1 || (await submit.count()) !== 1) {
    throw new Error("资源详情页密码表单结构无法识别");
  }

  const action = decodeHttpUrl(
    await form.getAttribute("action"),
    detailPage.url(),
  );
  if (!action || new URL(action).hostname !== new URL(detailPage.url()).hostname) {
    throw new Error("资源详情页密码表单提交地址无效");
  }

  const response = await detailPage.request.post(action, {
    form: {
      post_password: password,
      Submit: "提交",
    },
    headers: { referer: detailPage.url() },
    timeout: config.navigationTimeoutMs,
  });
  if (!response.ok()) {
    throw responseError(response, "资源详情页密码表单");
  }

  await detailPage.reload({
    timeout: config.navigationTimeoutMs,
    waitUntil: "domcontentloaded",
  });

  if ((await detailPage.locator("form.post-password-form").count()) > 0) {
    throw new Error("资源详情页密码验证失败");
  }
}

async function extractModernDownloads(detailPage, config) {
  const cards = detailPage.locator(".bdp-card");
  const cardCount = await cards.count();
  if (cardCount === 0) return [];

  const downloads = [];
  for (let index = 0; index < cardCount; index += 1) {
    const card = cards.nth(index);
    const providerText = (
      await card.locator(".bdp-card-title").textContent()
    )?.trim();
    const provider =
      providerText?.replace(/扫码|二维码/gi, "").trim() ||
      `未知来源${index + 1}`;
    const passwordLocator = card.locator(".bdp-pwd-box strong");
    const cardPassword =
      (await passwordLocator.count()) === 1
        ? (await passwordLocator.textContent())?.trim() || null
        : null;
    const qrImage = card.locator(".bdp-qrcode-box img");
    const directLink = card.locator("a.bdp-btn[href]");
    const directUrl =
      (await directLink.count()) > 0
        ? decodeHttpUrl(
            await directLink.nth(0).getAttribute("href"),
            detailPage.url(),
          )
        : null;

    if ((await qrImage.count()) !== 1) {
      const password = cardPassword || passwordFromUrl(directUrl);
      downloads.push({
        provider,
        url: directUrl,
        password,
        extractionCode: password,
        qrImageUrl: null,
        qrDecodeMethod: directUrl
          ? "playwright-direct-link"
          : "missing-image",
      });
      continue;
    }

    const decoded = await decodeQrLocator(
      qrImage,
      detailPage,
      Math.min(config.navigationTimeoutMs, 15_000),
    );
    const password = cardPassword || passwordFromUrl(decoded.url);
    downloads.push({
      provider,
      url: decoded.url,
      password,
      extractionCode: password,
      qrImageUrl: decoded.qrImageUrl,
      qrDecodeMethod: decoded.method,
    });
  }
  return downloads;
}

async function extractLegacyDownloads(detailPage) {
  const entryContent = detailPage.locator(".entry-content");
  if ((await entryContent.count()) === 0) {
    return { downloads: [], contentText: "" };
  }

  const content = entryContent.nth(0);
  const extracted = await content.evaluate((element) => {
    const qrValues = [
      ...element.querySelectorAll(
        'input[type="hidden"][id$="_content"]',
      ),
    ].map((input) => {
      const wrapper = input.closest(".wpkqcg_qrcode_wrapper");
      return {
        url: input.value || null,
        qrImageUrl:
          wrapper?.querySelector("img")?.getAttribute("src") || null,
      };
    });

    const directUrls = [...element.querySelectorAll("a[href]")]
      .map((anchor) => anchor.href)
      .filter((url) =>
        /pan\.baidu\.com|pan\.quark\.cn|pan\.xunlei\.com|gofile\.io/i.test(
          url,
        ),
      );

    return {
      qrValues,
      directUrls,
      contentText: element.textContent?.replace(/\s+/g, " ").trim() || "",
    };
  });

  const byUrl = new Map();
  for (const item of extracted.qrValues) {
    const url = decodeHttpUrl(item.url, detailPage.url());
    if (!url) continue;
    const password = passwordFromUrl(url);
    byUrl.set(url, {
      provider: providerFromUrl(url),
      url,
      password,
      extractionCode: password,
      qrImageUrl: decodeHttpUrl(item.qrImageUrl, detailPage.url()),
      qrDecodeMethod: "playwright-hidden-qr-content",
    });
  }

  for (const value of extracted.directUrls) {
    const url = decodeHttpUrl(value, detailPage.url());
    if (!url || byUrl.has(url)) continue;
    const password = passwordFromUrl(url);
    byUrl.set(url, {
      provider: providerFromUrl(url),
      url,
      password,
      extractionCode: password,
      qrImageUrl: null,
      qrDecodeMethod: "playwright-direct-link",
    });
  }

  return {
    downloads: [...byUrl.values()],
    contentText: extracted.contentText,
  };
}

export async function extractGame(
  context,
  pageUrl,
  config,
  refreshState = {},
) {
  assertAllowedArticleUrl(pageUrl);
  const articlePage = await context.newPage();

  try {
    const articleResponse = await articlePage.goto(pageUrl, {
      timeout: config.navigationTimeoutMs,
      waitUntil: "domcontentloaded",
    });
    if (!articleResponse?.ok()) {
      throw responseError(articleResponse, "文章页");
    }
    const sourceUpdatedAt =
      normalizeSourceUpdatedAt(refreshState.knownSourceUpdatedAt) ??
      normalizeSourceUpdatedAt(
        await articlePage
          .locator(".meta-date time[datetime]")
          .first()
          .getAttribute("datetime")
          .catch(() => null),
      );
    if (isSourceTimestampCurrent(sourceUpdatedAt, refreshState.lastScrapedAt)) {
      return {
        unchanged: true,
        sourceUpdatedAt,
      };
    }

    await articlePage.waitForLoadState("load", {
      timeout: config.navigationTimeoutMs,
    });

    const title = (await articlePage.locator("h1").textContent())?.trim();
    const imageCandidates = await articlePage.evaluate(() => {
      const featuredImage = document.querySelector(
        "article.article-content .entry-content img",
      );
      return [
        document
          .querySelector('meta[property="og:image"]')
          ?.getAttribute("content"),
        featuredImage?.getAttribute("data-src"),
        featuredImage?.getAttribute("data-lazy-src"),
        featuredImage?.getAttribute("src"),
        featuredImage?.currentSrc,
      ];
    });
    const image = selectImageUrl(imageCandidates, articlePage.url());
    const imageAccessible = await validateImageUrl(
      context,
      image,
      articlePage.url(),
      config,
    );
    const gameDescription = await extractGameDescription(articlePage);
    const resourceCodeLocator = articlePage.locator("#refurl");
    const resourceCode =
      (await resourceCodeLocator.count()) > 0
        ? await resourceCodeLocator
            .nth(0)
            .getAttribute("data-clipboard-text")
        : null;
    const resourceButton = articlePage.locator(
      "#cao_widget_pay-4 .go-down",
    );

    if (!title) {
      throw new Error("文章页缺少标题");
    }

    if ((await resourceButton.count()) === 0) {
      return {
        page: {
          url: articlePage.url(),
          title,
          image,
          imageAccessible,
          gameDescription,
          sourceUpdatedAt,
        },
        resource: {
          resourceCode,
          detailPageUrl: null,
          archivePassword: null,
          downloads: [],
        },
      };
    }
    if ((await resourceButton.count()) !== 1) {
      throw new Error("文章页存在多个“获取资源”按钮");
    }

    let detailPage;
    try {
      detailPage = await openDetailViaClick(
        context,
        articlePage,
        resourceButton,
        config,
      );
    } catch (error) {
      if (error instanceof AccessBlockedError) throw error;
      for (const page of context.pages()) {
        if (page !== articlePage) await page.close().catch(() => {});
      }
      detailPage = await openDetailViaRequest(context, pageUrl, config);
    }

    await unlockProtectedDetail(detailPage, resourceCode, config);

    const archiveHeader = detailPage.locator(".bdp-header");
    const archiveText =
      (await archiveHeader.count()) > 0
        ? (await archiveHeader.textContent())?.trim()
        : null;
    const modernDownloads = await extractModernDownloads(
      detailPage,
      config,
    );
    const legacy =
      modernDownloads.length === 0
        ? await extractLegacyDownloads(detailPage)
        : { downloads: [], contentText: "" };
    const downloads =
      modernDownloads.length > 0 ? modernDownloads : legacy.downloads;
    const resolvedDownloads = downloads.filter((download) => download.url);
    const passwordText = `${archiveText || ""} ${legacy.contentText}`;
    const archivePassword =
      passwordText.match(/解压密码\s*[：:]\s*([^\s|]+)/i)?.[1] || null;

    return {
      page: {
        url: articlePage.url(),
        title,
        image,
        imageAccessible,
        gameDescription,
        sourceUpdatedAt,
      },
      resource: {
        resourceCode,
        detailPageUrl: detailPage.url(),
        archivePassword,
        downloads: resolvedDownloads,
      },
    };
  } finally {
    for (const page of context.pages()) {
      await page.close().catch(() => {});
    }
  }
}
