import assert from "node:assert/strict";
import test from "node:test";

import {
  buildListPageUrl,
  parseGameId,
  passwordFromUrl,
  selectImageUrl,
} from "../src/utils.mjs";

test("热度榜分页保留 order=hot", () => {
  const listUrl = "https://www.gamer520.com/pcplay?order=hot";
  assert.equal(buildListPageUrl(listUrl, 1), listUrl);
  assert.equal(
    buildListPageUrl(listUrl, 2),
    "https://www.gamer520.com/pcplay/page/2?order=hot",
  );
  assert.equal(
    buildListPageUrl(listUrl, 100),
    "https://www.gamer520.com/pcplay/page/100?order=hot",
  );
});

test("从文章 URL 解析数字唯一键", () => {
  assert.equal(
    parseGameId("https://www.gamer520.com/118834.html"),
    118834,
  );
  assert.equal(parseGameId("not-a-game"), null);
});

test("从网盘 URL 回退提取密码", () => {
  assert.equal(
    passwordFromUrl("https://pan.baidu.com/s/example?pwd=8zpa"),
    "8zpa",
  );
  assert.equal(
    passwordFromUrl("https://example.com/file?passcode=abcd"),
    "abcd",
  );
  assert.equal(passwordFromUrl("https://example.com/file"), null);
});

test("封面元数据为附件数字 ID 时回退正文图片", () => {
  assert.equal(
    selectImageUrl(
      [
        "107795",
        null,
        "data:image/gif;base64,placeholder",
        "https://images.example/game.jpg",
      ],
      "https://www.gamer520.com/4121.html",
    ),
    "https://images.example/game.jpg",
  );
});
