import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";

export const dashboardSessionCookie = "g520_admin_session";

function safeEqual(leftValue, rightValue) {
  const left = Buffer.from(String(leftValue ?? ""));
  const right = Buffer.from(String(rightValue ?? ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function signature(payload, secret) {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

function cookieValues(request) {
  const values = new Map();
  for (const segment of String(request.headers.cookie ?? "").split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 1) continue;
    values.set(
      segment.slice(0, separator).trim(),
      segment.slice(separator + 1).trim(),
    );
  }
  return values;
}

export function dashboardAuthEnabled(config) {
  return Boolean(
    config.dashboardAdminUsername &&
      config.dashboardAdminPassword &&
      config.dashboardSessionSecret,
  );
}

export function verifyDashboardCredentials(
  config,
  username,
  password,
) {
  if (!dashboardAuthEnabled(config)) return false;
  return (
    safeEqual(username, config.dashboardAdminUsername) &&
    safeEqual(password, config.dashboardAdminPassword)
  );
}

export function createDashboardSession(
  config,
  now = Date.now(),
) {
  const payload = Buffer.from(
    JSON.stringify({
      username: config.dashboardAdminUsername,
      expiresAt:
        now + config.dashboardSessionTtlSeconds * 1_000,
    }),
  ).toString("base64url");
  return `${payload}.${signature(payload, config.dashboardSessionSecret)}`;
}

export function verifyDashboardSession(
  config,
  token,
  now = Date.now(),
) {
  if (!dashboardAuthEnabled(config) || !token) return null;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const payload = token.slice(0, separator);
  const providedSignature = token.slice(separator + 1);
  if (
    !safeEqual(
      providedSignature,
      signature(payload, config.dashboardSessionSecret),
    )
  ) {
    return null;
  }
  try {
    const session = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    if (
      session.username !== config.dashboardAdminUsername ||
      !Number.isFinite(session.expiresAt) ||
      session.expiresAt <= now
    ) {
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function dashboardSessionFromRequest(config, request) {
  return verifyDashboardSession(
    config,
    cookieValues(request).get(dashboardSessionCookie),
  );
}

function secureRequest(request) {
  return String(request.headers["x-forwarded-proto"] ?? "")
    .split(",")
    .some((protocol) => protocol.trim().toLowerCase() === "https");
}

export function dashboardSessionCookieHeader(config, request, token) {
  return [
    `${dashboardSessionCookie}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${config.dashboardSessionTtlSeconds}`,
    ...(secureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}

export function clearDashboardSessionCookieHeader(request) {
  return [
    `${dashboardSessionCookie}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
    ...(secureRequest(request) ? ["Secure"] : []),
  ].join("; ");
}
