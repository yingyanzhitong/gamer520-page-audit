export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function randomBetween(minimum, maximum) {
  if (maximum <= minimum) return minimum;
  return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
}

export function nowIso() {
  return new Date().toISOString();
}

export function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: String(error),
    stack: null,
  };
}

export function errorSummary(error, maxLength = 2_000) {
  const serialized = serializeError(error);
  return `${serialized.name}: ${serialized.message}`.slice(0, maxLength);
}

export function parseGameId(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(\d+)\.html$/);
    return match ? Number(match[1]) : null;
  } catch {
    const match = String(value).match(/(?:post-)?(\d+)/);
    return match ? Number(match[1]) : null;
  }
}

export function buildListPageUrl(listUrl, pageNumber) {
  const source = new URL(listUrl);
  if (pageNumber === 1) return source.href;

  const pathname = source.pathname.replace(/\/+$/, "");
  const target = new URL(
    `${pathname}/page/${pageNumber}`,
    source.origin,
  );
  for (const [key, value] of source.searchParams) {
    target.searchParams.append(key, value);
  }
  return target.href;
}

export function passwordFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return (
      parsed.searchParams.get("pwd") ||
      parsed.searchParams.get("password") ||
      parsed.searchParams.get("passcode") ||
      null
    );
  } catch {
    return null;
  }
}

export function selectImageUrl(candidates, baseUrl) {
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (!value || /^\d+$/.test(value) || /^data:/i.test(value)) {
      continue;
    }

    try {
      const url = new URL(value, baseUrl);
      if (/^https?:$/.test(url.protocol)) return url.href;
    } catch {
      // Ignore malformed candidates and try the next image source.
    }
  }
  return null;
}
