import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.mjs";
import {
  AccessBlockedError,
  createCrawlerContext,
  extractGame,
  launchBrowser,
} from "../src/playwright-extractor.mjs";

const articleUrl = "https://www.gamer520.com/88181.html";
const detailUrl = "https://520.gamers520.com/33732.html";
const urls = [
  "https://pan.baidu.com/s/example?pwd=1s97",
  "https://pan.quark.cn/s/example",
  "https://pan.xunlei.com/s/example?pwd=pkw3",
  "https://gofile.io/d/example",
];

const detailHtml = `
  <meta charset="utf-8">
  <h1>A03131</h1>
  <div class="bdp-header">解压密码:laoquzhang.com |</div>
  ${["百度网盘扫码", "夸克网盘扫码", "迅雷云盘", "GOFILE 海外盘"].map((title, index) => `
    <div class="bdp-card">
      <div class="bdp-card-title">${title}</div>
      <a class="bdp-btn" href="${urls[index]}">下载</a>
      ${index === 0 ? '<div class="bdp-pwd-box"><strong>1s97</strong></div>' : ""}
    </div>
  `).join("")}
`;

function articleHtml(entry) {
  return `
    <meta charset="utf-8">
    <h1>万象群侠传|官方中文|Build.25934899|解压即撸|</h1>
    <div class="meta-date"><time datetime="2026-10-15T00:00:00Z"></time></div>
    <article class="article-content"><div class="entry-content">
      <h2>游戏简介</h2><p>这是一段用于验证新版和旧版下载入口均可采集的游戏简介。</p>
    </div></article>
    <div id="cao_widget_pay-4">
      <span id="refurl" data-clipboard-text="A03131">A03131</span>
      ${entry}
    </div>
  `;
}

test("真实浏览器兼容新版直达下载入口与旧版弹窗入口", { timeout: 60_000 }, async (t) => {
  const config = loadConfig({ headless: true, navigationTimeoutMs: 5_000 });
  const browser = await launchBrowser(config);
  t.after(() => browser.close());
  async function contextFor(entry, { blocked = false } = {}) {
    const context = await createCrawlerContext(browser);
    context.setDefaultTimeout(5_000);
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.href === articleUrl) {
        await route.fulfill({ contentType: "text/html", body: articleHtml(entry) });
      } else if (url.hostname === "www.gamer520.com" && url.pathname === "/go") {
        await route.fulfill(blocked
          ? { status: 403, body: "Forbidden" }
          : {
              contentType: "text/html",
              body: `<script>location.replace(${JSON.stringify(detailUrl)})</script>`,
            });
      } else if (url.href === detailUrl) {
        await route.fulfill({ contentType: "text/html", body: detailHtml });
      } else {
        await route.abort();
      }
    });
    return context;
  }

  for (const [name, entry] of [
    ["新版 go-downblank 直接跟随 go 跳转", '<a class="go-downblank" href="/go?post_id=88181" target="_blank">立即下载</a>'],
    ["旧版 go-down 继续使用资源成功弹窗", `
      <a class="go-down" href="javascript:;">获取资源</a>
      <script>
        window.jQuery = { _data: () => ({ click: [{}] }) };
        document.querySelector('.go-down').addEventListener('click', () => {
          const modal = document.createElement('div');
          modal.className = 'swal2-popup swal2-show';
          modal.innerHTML = '<div class="swal2-title">下载地址获取成功</div><button class="swal2-confirm">立即下载</button>';
          modal.querySelector('button').onclick = () => window.open('${detailUrl}');
          document.body.appendChild(modal);
        });
      </script>
    `],
  ]) {
    await t.test(name, async () => {
      const context = await contextFor(entry);
      try {
        const result = await extractGame(context, articleUrl, config, { forceRefresh: true });
        assert.equal(result.resource.detailPageUrl, detailUrl);
        assert.equal(result.resource.resourceCode, "A03131");
        assert.equal(result.resource.archivePassword, "laoquzhang.com");
        assert.deepEqual(result.resource.downloads.map((download) => download.url), urls);
        assert.deepEqual(result.resource.downloads.map((download) => download.provider), [
          "百度网盘", "夸克网盘", "迅雷云盘", "GOFILE 海外盘",
        ]);
        assert.equal(result.resource.downloads[0].extractionCode, "1s97");
        assert.equal(result.resource.downloads[2].extractionCode, "pkw3");
      } finally {
        await context.close();
      }
    });
  }

  await t.test("新版入口被拒绝时报告访问失败，不保存为零下载源", async () => {
    const context = await contextFor(
      '<a class="go-downblank" href="/go?post_id=88181">立即下载</a>',
      { blocked: true },
    );
    try {
      await assert.rejects(
        extractGame(context, articleUrl, config, { forceRefresh: true }),
        (error) => error instanceof AccessBlockedError && error.status === 403,
      );
    } finally {
      await context.close();
    }
  });
});
