import { runCrawl } from "./crawler.mjs";

const result = await runCrawl({ trigger: "manual" });
console.log(JSON.stringify(result, null, 2));
