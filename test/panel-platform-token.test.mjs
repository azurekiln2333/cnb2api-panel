import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createPanelServer } from "../src/app.mjs";
import { removeAll } from "./support/sqlite-fixture.mjs";

const ADMIN = "platform-token-admin-key";
const GATEWAY = "platform-token-gateway-key";
const TOKEN = "platform-token-value-0123456789";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

async function start(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "cnb-platform-token-"));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: GATEWAY,
    dataDir: join(directory, "data"),
    allowLocal: true,
    ...options,
  });
  const base = await listen(app.server);
  t.after(async () => {
    await close(app.server);
    removeAll(directory);
  });
  return { base, app };
}

const get = (base, path, headers = {}) =>
  fetch(`${base}${path}`, { headers, redirect: "manual" });

test("PLATFORM_TOKEN authorizes /api/ management routes without a session", async (t) => {
  const { base } = await start(t, { platformToken: TOKEN });

  const unauth = await get(base, "/api/overview");
  assert.equal(unauth.status, 401);

  const ok = await get(base, "/api/overview", {
    Authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.ok(payload.overview || payload.accounts !== undefined || payload);
});

test("a wrong bearer token still requires browser login", async (t) => {
  const { base } = await start(t, { platformToken: TOKEN });

  const wrong = await get(base, "/api/overview", {
    Authorization: "Bearer not-the-platform-token",
  });
  assert.equal(wrong.status, 401);

  const empty = await get(base, "/api/overview", { Authorization: "Bearer " });
  assert.equal(empty.status, 401);

  const scheme = await get(base, "/api/overview", {
    Authorization: `Basic ${TOKEN}`,
  });
  assert.equal(scheme.status, 401);
});

test("the token branch is disabled when PLATFORM_TOKEN is unset", async (t) => {
  const { base } = await start(t, {});

  const attempt = await get(base, "/api/overview", {
    Authorization: `Bearer ${TOKEN}`,
  });
  assert.equal(attempt.status, 401);
});

test("token sessions do not clear the browser cookie on logout", async (t) => {
  const { base } = await start(t, { platformToken: TOKEN });

  const response = await fetch(`${base}/api/session`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("key login still works when PLATFORM_TOKEN is set", async (t) => {
  const { base } = await start(t, { platformToken: TOKEN });

  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie && cookie.includes("cnb_session="));

  const session = await get(base, "/api/session", {
    Cookie: cookie.split(";")[0],
  });
  assert.equal(session.status, 200);
});

test("PANEL_ADMIN_KEY authorizes management routes without PLATFORM_TOKEN", async (t) => {
  const { base } = await start(t, {});

  const unauth = await get(base, "/api/overview");
  assert.equal(unauth.status, 401);

  const ok = await get(base, "/api/overview", {
    Authorization: `Bearer ${ADMIN}`,
  });
  assert.equal(ok.status, 200);

  const reads = await get(base, "/api/settings", {
    Authorization: `Bearer ${ADMIN}`,
  });
  assert.equal(reads.status, 200);
});

test("the admin key bearer keeps working while key login is disabled", async (t) => {
  const { base, app } = await start(t, {});

  // Persist an enabled SSO with key login closed, the state the console reaches
  // only after a proven SSO session. The bearer is the service path, so it must
  // survive that switch (design D2 item 7).
  app.store.saveSso({
    ...app.store.state.sso,
    enabled: true,
    keyLoginEnabled: false,
    issuer: "https://sso.example.com",
    clientId: "panel-client",
    clientSecret: "panel-client-secret",
    allowedEmails: ["admin@example.com"],
  });

  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.equal(login.status, 403);

  const ok = await get(base, "/api/overview", {
    Authorization: `Bearer ${ADMIN}`,
  });
  assert.equal(ok.status, 200);
});

test("a bearer with the gateway key or a wrong key is rejected", async (t) => {
  const { base } = await start(t, { platformToken: TOKEN });

  for (const value of [GATEWAY, "wrong-admin-key-000", `${ADMIN}x`]) {
    const response = await get(base, "/api/overview", {
      Authorization: `Bearer ${value}`,
    });
    assert.equal(response.status, 401);
  }
});
