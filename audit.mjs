import jsQR from "jsqr";
import sharp from "sharp";

const DEFAULT_PAGE_URL = "https://www.gamer520.com/106813.html";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/138 Safari/537.36";

const pageUrl = new URL(process.argv[2] || DEFAULT_PAGE_URL);

if (!/(^|\.)gamer520\.com$/i.test(pageUrl.hostname)) {
  throw new Error("仅允许解析 gamer520.com 页面");
}

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function plainText(html = "") {
  return decodeHtml(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " "),
  ).trim();
}

function firstText(html, pattern) {
  const match = html.match(pattern);
  return match ? plainText(match[1]) : null;
}

function attribute(tag = "", name) {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`,
    "i",
  );
  const match = tag.match(pattern);
  return match ? decodeHtml(match[1] ?? match[2] ?? "") : null;
}

function resolveHttpUrl(value, base) {
  if (!value) return null;
  try {
    const url = new URL(decodeHtml(value), base);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

async function fetchResponse(url, options = {}) {
  return fetch(url, {
    redirect: "follow",
    ...options,
    headers: {
      "user-agent": USER_AGENT,
      ...options.headers,
    },
  });
}

async function fetchText(url, options = {}) {
  const response = await fetchResponse(url, options);
  const text = await response.text();
  return { response, text };
}

function extractScriptRedirect(html, baseUrl) {
  const normalized = decodeHtml(html.replace(/\\\//g, "/"));
  const direct = normalized.match(
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
  )?.[1];
  if (direct) return resolveHttpUrl(direct, baseUrl);

  const fallback = [...normalized.matchAll(/https?:\/\/[^\s"'<>\\]+/gi)]
    .map((match) => resolveHttpUrl(match[0], baseUrl))
    .find((url) => url && new URL(url).hostname === "gamers520.com");
  return fallback || null;
}

function extractQrCards(html, baseUrl) {
  const images = [
    ...html.matchAll(/<img\b[^>]*\balt=["'][^"']*二维码[^"']*["'][^>]*>/gi),
  ];

  return images.map((match) => {
    const imageTag = match[0];
    const imageIndex = match.index ?? 0;
    const cardStart = html.lastIndexOf('<div class="bdp-card', imageIndex);
    const nextCard = html.indexOf(
      '<div class="bdp-card',
      imageIndex + imageTag.length,
    );
    const fallbackEnd = html.indexOf("</article>", imageIndex);
    const cardEnd =
      nextCard >= 0
        ? nextCard
        : fallbackEnd >= 0
          ? fallbackEnd
          : imageIndex + imageTag.length;
    const cardHtml = html.slice(Math.max(0, cardStart), cardEnd);
    const alt = attribute(imageTag, "alt") || "";
    const extractionCode = plainText(cardHtml).match(
      /提取码\s*[：:]\s*([a-z0-9_-]{3,32})/i,
    )?.[1];

    return {
      provider:
        alt.replace(/扫码|二维码/gi, "").trim() ||
        firstText(cardHtml, /class=["'][^"']*bdp-card-title[^"']*["'][^>]*>([\s\S]*?)<\/div>/i),
      qrImageUrl: resolveHttpUrl(attribute(imageTag, "src"), baseUrl),
      extractionCode: extractionCode || null,
    };
  });
}

function embeddedQrData(qrImageUrl) {
  if (!qrImageUrl) return null;
  try {
    return resolveHttpUrl(new URL(qrImageUrl).searchParams.get("data"));
  } catch {
    return null;
  }
}

async function decodeQrImage(qrImageUrl, referer) {
  const embedded = embeddedQrData(qrImageUrl);

  try {
    const response = await fetchResponse(qrImageUrl, {
      headers: { referer },
    });
    if (!response.ok) {
      throw new Error(`二维码请求失败：HTTP ${response.status}`);
    }

    const image = Buffer.from(await response.arrayBuffer());
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
    const decodedUrl = resolveHttpUrl(decoded?.data);

    if (decodedUrl) {
      return { url: decodedUrl, method: "qr-image" };
    }
  } catch (error) {
    if (!embedded) throw error;
  }

  if (embedded) {
    return { url: embedded, method: "qr-query-fallback" };
  }

  return { url: null, method: "failed" };
}

const page = await fetchText(pageUrl, {
  headers: { referer: pageUrl.origin },
});

if (!page.response.ok) {
  throw new Error(`文章页请求失败：HTTP ${page.response.status}`);
}

const goDownTag = page.text.match(
  /<a\b[^>]*class=["'][^"']*\bgo-down\b[^"']*["'][^>]*>/i,
)?.[0];
const title =
  firstText(page.text, /<h1\b[^>]*>([\s\S]*?)<\/h1>/i) ||
  firstText(page.text, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
const ogImageTag = page.text.match(
  /<meta\b[^>]*property=["']og:image["'][^>]*>/i,
)?.[0];
const postId =
  attribute(goDownTag, "data-id") ||
  pageUrl.pathname.match(/\/(\d+)\.html$/)?.[1] ||
  null;
const resourceCodeTag = page.text.match(
  /<[^>]*\bdata-clipboard-text=["'][^"']+["'][^>]*>/i,
)?.[0];
const resourceCode = attribute(resourceCodeTag, "data-clipboard-text");

const result = {
  page: {
    url: page.response.url,
    title,
    image: resolveHttpUrl(attribute(ogImageTag, "content"), page.response.url),
  },
  resource: {
    postId,
    resourceCode,
    ajaxLandingUrl: null,
    detailPageUrl: null,
    archivePassword: null,
    downloads: [],
  },
};

if (!postId) {
  throw new Error("未找到“获取资源”按钮对应的文章 ID");
}

const ajaxUrl = new URL("/wp-admin/admin-ajax.php", page.response.url);
const ajaxBody = new URLSearchParams({
  action: "user_down_ajax",
  post_id: postId,
});
const ajax = await fetchText(ajaxUrl, {
  method: "POST",
  body: ajaxBody,
  headers: {
    "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    referer: page.response.url,
    "x-requested-with": "XMLHttpRequest",
  },
});

let payload;
try {
  payload = JSON.parse(ajax.text);
} catch {
  throw new Error("资源接口没有返回有效 JSON");
}

const landingUrl = resolveHttpUrl(payload?.msg, page.response.url);
if (String(payload?.status) !== "1" || !landingUrl) {
  throw new Error(`资源接口返回失败：${plainText(String(payload?.msg || ""))}`);
}
result.resource.ajaxLandingUrl = landingUrl;

const landing = await fetchText(landingUrl, {
  headers: { referer: page.response.url },
});
const detailUrl = extractScriptRedirect(landing.text, landing.response.url);
if (!detailUrl) {
  throw new Error("资源中间页未找到详情页跳转地址");
}
result.resource.detailPageUrl = detailUrl;

const detail = await fetchText(detailUrl, {
  headers: { referer: landing.response.url },
});
if (!detail.response.ok) {
  throw new Error(`资源详情页请求失败：HTTP ${detail.response.status}`);
}

const detailText = plainText(detail.text);
result.resource.archivePassword =
  detailText.match(/解压密码\s*[：:]\s*([^\s|]+)/i)?.[1] || null;

const cards = extractQrCards(detail.text, detail.response.url);
result.resource.downloads = await Promise.all(
  cards.map(async (card) => {
    if (!card.qrImageUrl) {
      return {
        ...card,
        url: null,
        password: card.extractionCode,
        qrDecodeMethod: "missing-image",
      };
    }

    const decoded = await decodeQrImage(
      card.qrImageUrl,
      detail.response.url,
    );
    return {
      provider: card.provider,
      url: decoded.url,
      password: card.extractionCode,
      extractionCode: card.extractionCode,
      qrImageUrl: card.qrImageUrl,
      qrDecodeMethod: decoded.method,
    };
  }),
);

console.log(JSON.stringify(result, null, 2));
