import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createPanelServer } from "../src/app.mjs";

const ADMIN = "gateway-key-test-admin-key";

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};
const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

// The console reveals the full gateway key through POST /api/access/key.
const revealKey = async (base) => {
  const response = await fetch(`${base}/api/access/key`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()).key;
};

const chat = (base, key) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "any",
      messages: [{ role: "user", content: "hi" }],
    }),
  });

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cnb-gateway-key-"));
  const dataDir = join(root, "data");
  const open = async (extra = {}) => {
    const app = createPanelServer({ adminKey: ADMIN, dataDir, ...extra });
    const base = await listen(app.server);
    t.after(async () => {
      app.pool.stop();
      if (app.server.listening) await close(app.server);
    });
    return { app, base };
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { dataDir, open };
}

test("an unset GATEWAY_KEY is generated, persisted and used by the API", async (t) => {
  const { dataDir, open } = await fixture(t);
  const { base } = await open();

  const key = await revealKey(base);
  assert.equal(typeof key, "string");
  assert.ok(key.length >= 12);
  assert.notEqual(key, ADMIN);
  assert.match(key, /^[\x21-\x7e]+$/);
  assert.equal(readFileSync(join(dataDir, "gateway.key"), "utf8").trim(), key);

  const rejected = await chat(base, "not-the-generated-gateway-key");
  assert.equal(rejected.status, 401);
  await rejected.text();
  const accepted = await chat(base, key);
  assert.notEqual(accepted.status, 401);
  await accepted.text();
});

test("the generated key survives a restart", async (t) => {
  const { open } = await fixture(t);
  const first = await open();
  const firstKey = await revealKey(first.base);
  first.app.pool.stop();
  await close(first.app.server);

  const second = await open();
  assert.equal(await revealKey(second.base), firstKey);
});

test("GATEWAY_KEY from the environment wins over the stored file", async (t) => {
  const { open } = await fixture(t);
  const first = await open();
  const generated = await revealKey(first.base);
  first.app.pool.stop();
  await close(first.app.server);

  const envKey = "environment-wins-gateway-key";
  const second = await open({ gatewayKey: envKey });
  const revealed = await revealKey(second.base);
  assert.equal(revealed, envKey);
  assert.notEqual(revealed, generated);
  const accepted = await chat(second.base, envKey);
  assert.notEqual(accepted.status, 401);
  await accepted.text();
});

test("an invalid environment GATEWAY_KEY is still refused", async (t) => {
  const { open } = await fixture(t);
  await assert.rejects(() => open({ gatewayKey: "short" }), /at least 12 characters/);
  await assert.rejects(
    () => open({ gatewayKey: "has a space in it" }),
    /printable ASCII characters/,
  );
  await assert.rejects(() => open({ gatewayKey: ADMIN }), /must be different/);
});

test("an empty stored key is reported instead of guessed", async (t) => {
  const { dataDir, open } = await fixture(t);
  const first = await open();
  first.app.pool.stop();
  await close(first.app.server);
  writeFileSync(join(dataDir, "gateway.key"), "\n");
  await assert.rejects(() => open(), /data\/gateway.key is empty/);
});
