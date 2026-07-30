import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import sharp from "sharp";

const maximumCoverBytes = 10 * 1024 * 1024;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readLimitedBody(response) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumCoverBytes
  ) {
    throw new Error("封面图片超过 10MB 限制");
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maximumCoverBytes) {
      throw new Error("封面图片超过 10MB 限制");
    }
    chunks.push(chunk);
  }
  if (total === 0) throw new Error("封面图片内容为空");
  return Buffer.concat(chunks);
}

export async function cacheCoverImage({
  gameId,
  imageUrl,
  cacheDirectory,
  publicBaseUrl,
  fetchImpl = fetch,
  attempts = 3,
  timeoutMs = 20_000,
}) {
  const parsedUrl = new URL(imageUrl);
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("封面地址必须是 HTTP/HTTPS URL");
  }

  const digest = createHash("sha256")
    .update(parsedUrl.toString())
    .digest("hex")
    .slice(0, 20);
  const fileName = `${Number(gameId)}-${digest}.jpg`;
  const filePath = path.join(cacheDirectory, fileName);
  await fs.promises.mkdir(cacheDirectory, { recursive: true });

  const cached = await fs.promises
    .stat(filePath)
    .catch(() => null);
  if (cached?.isFile() && cached.size > 0) {
    return {
      fileName,
      filePath,
      publicUrl: `${publicBaseUrl.replace(/\/+$/, "")}/covers/${fileName}`,
      cached: true,
    };
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const temporaryPath = `${filePath}.${process.pid}.tmp`;
    try {
      const response = await fetchImpl(parsedUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/*",
          "user-agent": "gamer520-page-audit/cover-cache",
        },
      });
      if (!response.ok) {
        throw new Error(`封面下载返回 HTTP ${response.status}`);
      }
      const contentType = String(
        response.headers.get("content-type") ?? "",
      ).toLowerCase();
      if (!contentType.startsWith("image/")) {
        throw new Error(
          `封面下载返回了非图片类型：${contentType || "unknown"}`,
        );
      }

      const source = await readLimitedBody(response);
      await sharp(source)
        .rotate()
        .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
        .toFile(temporaryPath);
      await fs.promises.rename(temporaryPath, filePath);
      return {
        fileName,
        filePath,
        publicUrl: `${publicBaseUrl.replace(/\/+$/, "")}/covers/${fileName}`,
        cached: false,
      };
    } catch (error) {
      lastError = error;
      await fs.promises.rm(temporaryPath, { force: true });
      if (attempt < attempts) await delay(attempt * 500);
    }
  }

  throw new Error(
    `封面缓存失败（已重试 ${attempts} 次）：${lastError?.message ?? "未知错误"}`,
  );
}
