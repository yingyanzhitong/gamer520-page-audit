import { loadConfig } from "./src/config.mjs";
import {
  createCrawlerContext,
  extractGame,
  launchBrowser,
} from "./src/playwright-extractor.mjs";

const pageUrl =
  process.argv[2] || "https://www.gamer520.com/106813.html";
const config = loadConfig({
  pageCount: 1,
  detailConcurrency: 1,
});
const browser = await launchBrowser(config);

try {
  const context = await createCrawlerContext(browser);
  try {
    const result = await extractGame(context, pageUrl, config);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close().catch(() => {});
  }
} finally {
  await browser.close();
}
