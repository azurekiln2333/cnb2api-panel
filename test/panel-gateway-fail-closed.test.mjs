import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";
import { removeAll } from "./support/sqlite-fixture.mjs";

// Design R11 / §6: the gateway refuses every inference call until a key is
// presented. There is no environment switch, no account-pool state and no
// request shape that turns authentication off.
const ADMIN = "fail-closed-test-admin-key";

const INFERENCE = [
  ["POST", "/v1/chat/completions"],
  ["POST", "/v1/responses"],
  ["POST", "/v1/messages"],
  ["POST", "/v1/messages/count_tokens"],
  ["GET", "/v1/models"],
  ["GET", "/models"],
  ["GET", "/v1/quota"],
  ["GET", "/v1/dashboard/billing/subscription"],
  ["GET", "/dashboard/billing/subscription"],
  ["GET", "/v1/dashboard/billing/usage"],
  ["GET", "/dashboard/billing/usage"],
];
const BODY = JSON.stringify({
  model: "any",
  messages: [{ role: "user", content: "hi" }],
});

async function fixture(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "cnb-fail-closed-"));
  const app = createPanelServer({
    adminKey: ADMIN,
    gatewayKey: "fail-closed-test-gateway-key",
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    ...options,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(async () => {
    app.pool.stop();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    removeAll(root);
  });
  return { app, base: `http://127.0.0.1:${app.server.address().port}` };
}

const call = (base, [method, path], headers = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "POST" ? BODY : undefined,
  });

test("inference refuses every call that carries no credential", async (t) => {
  const { base } = await fixture(t);
  for (const route of INFERENCE) {
    const response = await call(base, route);
    assert.equal(response.status, 401, `${route[1]} answered ${response.status}`);
    const body = await response.json();
    const error = body.error ?? {};
    assert.equal(error.message, "invalid api key", `${route[1]} leaked ${JSON.stringify(body)}`);
    // Anthropic-shaped endpoints wrap the error, everything else does not.
    if (route[1].startsWith("/v1/messages"))
      assert.equal(body.type, "error", `${route[1]} lacks the Anthropic envelope`);
  }
});

test("blank credentials are refused instead of matching an empty key", async (t) => {
  const { base } = await fixture(t);
  const blanks = [
    { Authorization: "Bearer " },
    { Authorization: "Bearer    " },
    { "x-api-key": "" },
    // A blank header pair must not satisfy an "undefined equals undefined" path.
    {},
  ];
  for (const headers of blanks) {
    for (const route of INFERENCE) {
      const response = await call(base, route, headers);
      assert.equal(
        response.status,
        401,
        `${route[1]} accepted ${JSON.stringify(headers)}`,
      );
      await response.text();
    }
  }
});

test("the management key does not open the inference API", async (t) => {
  const { base } = await fixture(t);
  const response = await call(base, ["POST", "/v1/chat/completions"], {
    Authorization: `Bearer ${ADMIN}`,
  });
  assert.equal(response.status, 401);
  await response.text();
});

test("the refusal never echoes a usable key", async (t) => {
  const { base } = await fixture(t);
  const response = await call(base, ["POST", "/v1/chat/completions"]);
  const text = await response.text();
  assert.equal(response.status, 401);
  assert.doesNotMatch(text, /fail-closed-test-gateway-key/);
  assert.doesNotMatch(text, /fail-closed-test-admin-key/);
  assert.doesNotMatch(text, /data\/gateway\.key/);
});

test("a panel with no accounts still refuses inference", async (t) => {
  // The old "no accounts means nothing to authenticate" shortcut is exactly what
  // this design forbids: an empty pool stays closed.
  const { app, base } = await fixture(t);
  assert.equal(app.store.state.accounts.length, 0);
  const response = await call(base, ["POST", "/v1/chat/completions"]);
  assert.equal(response.status, 401);
  await response.text();
});

test("an unset GATEWAY_KEY is generated, so the panel is never open", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cnb-fail-closed-generated-"));
  const app = createPanelServer({
    adminKey: ADMIN,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.pool.stop();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    removeAll(root);
  });

  const anonymous = await call(base, ["POST", "/v1/chat/completions"]);
  assert.equal(anonymous.status, 401);
  await anonymous.text();
  // Generating a key is what closes the door, so the reveal must still work.
  const revealed = await fetch(`${base}/api/access/key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  assert.equal(revealed.status, 200);
  assert.ok((await revealed.json()).key.length >= 12);
});
