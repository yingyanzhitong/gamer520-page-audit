import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import sharp from "sharp";

import { cacheCoverImage } from "../src/cover-cache.mjs";

test("封面下载后转为 JPEG 并复用本地缓存", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-cover-cache-test-"),
  );
  const image = await sharp({
    create: {
      width: 32,
      height: 18,
      channels: 3,
      background: "#3157ff",
    },
  })
    .png()
    .toBuffer();
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.writeHead(200, {
      "content-type": "image/png",
      "content-length": image.length,
    });
    response.end(image);
  });
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  const { port } = server.address();

  try {
    const input = {
      gameId: 118842,
      imageUrl: `http://127.0.0.1:${port}/cover.png`,
      cacheDirectory: directory,
      publicBaseUrl: "https://gamer520.example",
      attempts: 1,
    };
    const first = await cacheCoverImage(input);
    const second = await cacheCoverImage(input);

    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(first.publicUrl, second.publicUrl);
    assert.match(
      first.publicUrl,
      /^https:\/\/gamer520\.example\/covers\/118842-[a-f0-9]{20}\.jpg$/,
    );
    assert.equal(requests, 1);
    const metadata = await sharp(first.filePath).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.width, 32);
    assert.equal(metadata.height, 18);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("终止信号会取消正在进行的封面下载", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-cover-abort-test-"),
  );
  const controller = new AbortController();
  const fetchImpl = async (_url, options) =>
    new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(options.signal.reason),
        { once: true },
      );
    });

  try {
    const request = cacheCoverImage({
      gameId: 118842,
      imageUrl: "https://images.example/cover.png",
      cacheDirectory: directory,
      publicBaseUrl: "https://gamer520.example",
      fetchImpl,
      attempts: 1,
      signal: controller.signal,
    });
    controller.abort(new Error("测试终止"));
    await assert.rejects(request, /测试终止/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
