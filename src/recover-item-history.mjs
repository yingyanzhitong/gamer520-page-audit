import { pathToFileURL } from "node:url";

import { loadConfig } from "./config.mjs";
import { CrawlerDatabase } from "./database.mjs";
import { XianyuClient } from "./xianyu-client.mjs";

export async function recoverPublishedItemHistory(config = loadConfig()) {
  const database = new CrawlerDatabase(config.dbPath);
  try {
    const client = new XianyuClient({
      baseUrl: config.xianyuBaseUrl,
      apiKey: database.getXianyuApiKey(config.xianyuApiKey),
    });
    const [materials, logs] = await Promise.all([
      client.listMaterials(),
      client.listSuccessfulPublications(),
    ]);
    return database.restorePublishedItemHistory(
      materials, logs, new Date().toISOString(),
    );
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({
    event: "item_history_recovered",
    ...await recoverPublishedItemHistory(),
  }));
}
