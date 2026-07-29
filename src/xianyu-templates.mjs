const providerOrder = new Map(
  [
    "百度",
    "夸克",
    "迅雷",
    "阿里",
    "天翼",
    "123",
    "OneDrive",
    "Google Drive",
  ].map((provider, index) => [provider, index]),
);

export const DEFAULT_XIANYU_TEMPLATES = Object.freeze({
  titleTemplate: "【秒发】{title}",
  descriptionTemplate: [
    "{description}",
    "支持网盘：{cloud_drives}",
    "虚拟商品24小时自动发货",
    "喜欢直接拍，有问题随时聊",
  ].join("\n\n"),
  imageTemplate: "{image_url}",
});

export const XIANYU_TEMPLATE_VARIABLES = Object.freeze([
  "id",
  "title",
  "description",
  "image_url",
  "cloud_drives",
  "price",
  "resource_code",
  "archive_password",
  "detail_page_url",
]);

const templateLimits = {
  titleTemplate: 500,
  descriptionTemplate: 8_000,
  imageTemplate: 2_000,
};

function driveLabel(provider) {
  const normalized = String(provider ?? "").trim();
  if (!normalized) return null;
  const knownProviders = [
    ["百度", "百度"],
    ["夸克", "夸克"],
    ["迅雷", "迅雷"],
    ["阿里", "阿里"],
    ["天翼", "天翼"],
    ["123", "123"],
    ["OneDrive", "OneDrive"],
    ["Google", "Google Drive"],
  ];
  const known = knownProviders.find(([keyword]) =>
    normalized.toLowerCase().includes(keyword.toLowerCase()),
  );
  if (known) return known[1];
  return normalized.replace(/(?:云盘|网盘)$/u, "") || normalized;
}

export function listCloudDrives(downloads = []) {
  return [
    ...new Set(
      downloads
        .map((download) => driveLabel(download.provider))
        .filter(Boolean),
    ),
  ].sort(
    (left, right) =>
      (providerOrder.get(left) ?? 999) -
        (providerOrder.get(right) ?? 999) ||
      left.localeCompare(right, "zh-CN"),
  );
}

export function normalizeXianyuTemplates(templates = {}) {
  return {
    titleTemplate: String(
      templates.titleTemplate ??
        templates.title_template ??
        DEFAULT_XIANYU_TEMPLATES.titleTemplate,
    ),
    descriptionTemplate: String(
      templates.descriptionTemplate ??
        templates.description_template ??
        DEFAULT_XIANYU_TEMPLATES.descriptionTemplate,
    ),
    imageTemplate: String(
      templates.imageTemplate ??
        templates.image_template ??
        DEFAULT_XIANYU_TEMPLATES.imageTemplate,
    ),
  };
}

export function validateXianyuTemplates(templates = {}) {
  const normalized = normalizeXianyuTemplates(templates);
  const supported = new Set(XIANYU_TEMPLATE_VARIABLES);
  for (const [key, value] of Object.entries(normalized)) {
    if (!value.trim()) {
      const error = new Error(`${key} 不能为空`);
      error.statusCode = 422;
      throw error;
    }
    if (value.length > templateLimits[key]) {
      const error = new Error(
        `${key} 不能超过 ${templateLimits[key]} 个字符`,
      );
      error.statusCode = 422;
      throw error;
    }
    const variables = [...value.matchAll(/\{([^{}]+)\}/gu)].map(
      (match) => match[1],
    );
    const unknown = variables.find((variable) => !supported.has(variable));
    if (unknown) {
      const error = new Error(`不支持占位符 {${unknown}}`);
      error.statusCode = 422;
      throw error;
    }
  }
  return normalized;
}

function templateValues(game) {
  const cloudDrives = listCloudDrives(game.downloads);
  const price = Number(game.effective_price ?? game.sale_price ?? 1);
  return {
    id: String(game.id ?? ""),
    title: String(game.title ?? "").trim(),
    description: String(game.description ?? "").trim(),
    image_url: String(game.image_url ?? game.imageUrl ?? "").trim(),
    cloud_drives: cloudDrives.join("/") || "以商品详情为准",
    price: Number.isFinite(price)
      ? price.toFixed(2).replace(/\.?0+$/u, "")
      : "1",
    resource_code: String(
      game.resource_code ?? game.resourceCode ?? "",
    ).trim(),
    archive_password: String(
      game.archive_password ?? game.archivePassword ?? "",
    ).trim(),
    detail_page_url: String(
      game.detail_page_url ?? game.detailPageUrl ?? "",
    ).trim(),
  };
}

function renderTemplate(template, values) {
  return template.replace(/\{([^{}]+)\}/gu, (match, variable) =>
    Object.hasOwn(values, variable) ? values[variable] : match,
  );
}

export function renderXianyuListing(game, templates = {}) {
  const normalized = validateXianyuTemplates(templates);
  const values = templateValues(game);
  const title = renderTemplate(normalized.titleTemplate, values)
    .trim()
    .slice(0, 200);
  const description = renderTemplate(
    normalized.descriptionTemplate,
    values,
  ).trim();
  const imageUrl = renderTemplate(normalized.imageTemplate, values).trim();

  if (!title) {
    const error = new Error("标题模板渲染结果为空");
    error.statusCode = 422;
    throw error;
  }
  if (!description) {
    const error = new Error("简介模板渲染结果为空");
    error.statusCode = 422;
    throw error;
  }
  let parsedImage;
  try {
    parsedImage = new URL(imageUrl);
  } catch {
    const error = new Error("图片模板渲染结果不是有效 URL");
    error.statusCode = 422;
    throw error;
  }
  if (!["http:", "https:"].includes(parsedImage.protocol)) {
    const error = new Error("图片模板只支持 http/https URL");
    error.statusCode = 422;
    throw error;
  }

  return {
    title,
    description,
    imageUrl: parsedImage.toString(),
  };
}

export function buildListingDescription(game) {
  return renderXianyuListing(
    game,
    DEFAULT_XIANYU_TEMPLATES,
  ).description;
}
