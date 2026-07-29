import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_XIANYU_TEMPLATES,
  renderXianyuListing,
  validateXianyuTemplates,
} from "../src/xianyu-templates.mjs";

const game = {
  id: 118842,
  title: "游戏名称",
  description: "游戏简介",
  image_url: "https://images.example/118842.jpg",
  effective_price: 2.5,
  resource_code: "A118842",
  archive_password: "gamer520.com",
  detail_page_url: "https://www.gamer520.com/118842.html",
  downloads: [
    { provider: "迅雷云盘" },
    { provider: "百度网盘" },
    { provider: "夸克网盘" },
  ],
};

test("默认模板生成现有标题、动态网盘简介和游戏封面", () => {
  const listing = renderXianyuListing(
    game,
    DEFAULT_XIANYU_TEMPLATES,
  );
  assert.equal(listing.title, "【秒发】游戏名称");
  assert.match(listing.description, /^游戏简介/u);
  assert.match(listing.description, /支持网盘：百度\/夸克\/迅雷/u);
  assert.equal(listing.imageUrl, "https://images.example/118842.jpg");
});

test("自定义模板替换标题、简介、图片和价格占位符", () => {
  const listing = renderXianyuListing(game, {
    titleTemplate: "现货 {title} #{id}",
    descriptionTemplate:
      "{description}\n售价 {price}\n编号 {resource_code}\n密码 {archive_password}",
    imageTemplate: "https://cdn.example/games/{id}.webp",
  });
  assert.equal(listing.title, "现货 游戏名称 #118842");
  assert.match(listing.description, /售价 2.5/u);
  assert.match(listing.description, /密码 gamer520.com/u);
  assert.equal(
    listing.imageUrl,
    "https://cdn.example/games/118842.webp",
  );
});

test("未知占位符和无效图片地址会被拒绝", () => {
  assert.throws(
    () =>
      validateXianyuTemplates({
        ...DEFAULT_XIANYU_TEMPLATES,
        titleTemplate: "{unknown}",
      }),
    /不支持占位符 \{unknown\}/u,
  );
  assert.throws(
    () =>
      renderXianyuListing(game, {
        ...DEFAULT_XIANYU_TEMPLATES,
        imageTemplate: "not-a-url-{id}",
      }),
    /图片模板渲染结果不是有效 URL/u,
  );
});
