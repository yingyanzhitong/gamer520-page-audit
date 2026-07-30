import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createDashboardSession,
  verifyDashboardSession,
} from "../src/dashboard-auth.mjs";
import { startDashboardServer } from "../src/dashboard-server.mjs";
import { CrawlerDatabase } from "../src/database.mjs";

function authConfig(databasePath) {
  return {
    dashboardHost: "127.0.0.1",
    dashboardPort: 0,
    dashboardAdminUsername: "admin",
    dashboardAdminPassword: "test-password",
    dashboardSessionSecret: "test-session-secret-with-enough-entropy",
    dashboardSessionTtlSeconds: 3600,
    dbPath: databasePath,
    xianyuApiKey: "xianyu-plain-key",
    downloadReadApiKey: "download-plain-key",
    pageCount: 50,
  };
}

test("后台会话支持签名校验、篡改拒绝和过期失效", () => {
  const config = authConfig("/tmp/unused.sqlite");
  const now = Date.now();
  const token = createDashboardSession(config, now);
  assert.equal(
    verifyDashboardSession(config, token, now + 1_000)?.username,
    "admin",
  );
  assert.equal(
    verifyDashboardSession(config, `${token}tampered`, now + 1_000),
    null,
  );
  assert.equal(
    verifyDashboardSession(config, token, now + 3_601_000),
    null,
  );
});

test("后台数据需要登录且 API Key 明文仅对登录会话展示", async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "gamer520-auth-test-"),
  );
  const databasePath = path.join(directory, "test.sqlite");
  const database = new CrawlerDatabase(databasePath);
  database.close();
  const dashboard = await startDashboardServer(
    authConfig(databasePath),
    () => ({
      active: false,
      interrupted: false,
      enabled: true,
      cronSchedule: "0 3 * * *",
      cronTimezone: "Asia/Shanghai",
      nextRun: null,
      sync: {
        active: false,
        interrupted: false,
        enabled: true,
        cronSchedule: "0 */6 * * *",
        nextRun: null,
        mode: "pending",
      },
    }),
  );
  const baseUrl = `http://127.0.0.1:${dashboard.address.port}`;
  try {
    assert.equal(
      (await fetch(`${baseUrl}/api/dashboard`)).status,
      401,
    );
    const wrong = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "wrong",
      }),
    });
    assert.equal(wrong.status, 401);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "admin",
        password: "test-password",
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];
    assert.match(cookie, /^g520_admin_session=/);

    const session = await fetch(`${baseUrl}/api/auth/session`, {
      headers: { cookie },
    }).then((response) => response.json());
    assert.equal(session.authenticated, true);
    assert.equal(session.username, "admin");

    const keyOnly = await fetch(`${baseUrl}/api/admin/api-keys`, {
      headers: { "X-API-Key": "xianyu-plain-key" },
    });
    assert.equal(keyOnly.status, 403);

    const keys = await fetch(`${baseUrl}/api/admin/api-keys`, {
      headers: { cookie },
    }).then((response) => response.json());
    assert.equal(keys.items[0].value, "xianyu-plain-key");
    assert.equal(keys.items[1].value, "download-plain-key");

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { cookie },
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  } finally {
    await dashboard.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
