import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "panel-log-pagination-"));
  const app = createPanelServer({
    adminKey: "pagination-admin-key",
    gatewayKey: "pagination-gateway-key",
    dataDir: join(directory, "data"),
    allowLocal: true,
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((done) => app.server.close(done));
    rmSync(directory, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "pagination-admin-key" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const call = (path) =>
    fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  return { ...app, base, call };
}

function requestEntry(index, fields = {}) {
  return {
    id: randomUUID(),
    at: new Date(Date.UTC(2026, 9, 29, 9, 36) - index * 1000).toISOString(),
    kind: "request",
    accountName: "workspace",
    model: "test-model",
    message: "request completed",
    requestId: `request-${index}`,
    status: index % 2 ? 500 : 200,
    initialMessage: { role: "user", text: "user message", truncated: false },
    requestDiagnostics: { received: { messageCount: index + 1 } },
    ...fields,
  };
}

test("paged request logs bound long-message responses and preserve complete details", async (t) => {
  const app = await fixture(t);
  const text = "中".repeat(4000);
  const entries = Array.from({ length: 1000 }, (_, index) =>
    requestEntry(index, {
      initialMessage: { role: "user", text, truncated: false },
    }),
  );
  app.store.state.logs = entries;
  const response = await app.call("/api/logs?limit=20&offset=0");
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.ok(Buffer.byteLength(body) < 300000);
  const page = JSON.parse(body);
  assert.equal(page.total, 1000);
  assert.equal(page.limit, 20);
  assert.equal(page.offset, 0);
  assert.deepEqual(
    page.logs.map((entry) => entry.id),
    entries.slice(0, 20).map((entry) => entry.id),
  );
  assert.equal(page.logs[0].initialMessage.text, text);
  assert.equal(page.logs[0].requestDiagnostics, undefined);
  const detail = await (
    await app.call(`/api/logs/requests/${entries[0].id}`)
  ).json();
  assert.deepEqual(detail.log, entries[0]);
  assert.equal(
    app.store.state.logs[0].requestDiagnostics.received.messageCount,
    1,
  );
});

test("request outcome and full-message search filter before pagination", async (t) => {
  const app = await fixture(t);
  const entries = Array.from({ length: 60 }, (_, index) =>
    requestEntry(index, {
      status: [200, 302, 400, 499, 0][index % 5],
      initialMessage: {
        role: "user",
        text: "前".repeat(3990) + (index % 3 ? "OTHER" : "Needle"),
        truncated: false,
      },
    }),
  );
  app.store.state.logs = entries;
  const expected = entries.filter(
    (entry, index) =>
      index % 3 === 0 && !(entry.status >= 200 && entry.status < 400),
  );
  const page = await (
    await app.call(
      "/api/logs/requests?limit=4&offset=4&q=NEEDLE&outcome=failure",
    )
  ).json();
  assert.equal(page.total, expected.length);
  assert.deepEqual(
    page.logs.map((entry) => entry.id),
    expected.slice(4, 8).map((entry) => entry.id),
  );
  const successes = await (await app.call("/api/logs?outcome=success")).json();
  assert.equal(successes.total, 24);
  assert.equal(successes.limit, 20);
  assert.ok(
    successes.logs.every((entry) => entry.status >= 200 && entry.status < 400),
  );
  const empty = await (
    await app.call("/api/logs?q=no-matching-message")
  ).json();
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.logs, []);
});

test("log channels retain kind filters and search metadata independently", async (t) => {
  const app = await fixture(t);
  const entries = [
    requestEntry(0),
    requestEntry(1, {
      kind: "audit",
      actor: { name: "Operator" },
      action: "account.update",
      ip: "127.0.0.2",
    }),
    requestEntry(2, { kind: "account", actor: { name: "Operator" } }),
    requestEntry(3, { kind: "health", message: "Health failure", status: 500 }),
    requestEntry(4, { kind: "wake", message: "Wake success", status: 200 }),
  ];
  app.store.state.logs = entries;
  for (const search of ["operator", "ACCOUNT.UPDATE", "127.0.0.2"]) {
    const audit = await (
      await app.call(
        `/api/logs/audit?kind=audit&q=${encodeURIComponent(search)}`,
      )
    ).json();
    assert.deepEqual(
      audit.logs.map((entry) => entry.id),
      [entries[1].id],
    );
    assert.equal(audit.total, 1);
  }
  const system = await (
    await app.call("/api/logs/system?kind=wake&outcome=failure")
  ).json();
  assert.deepEqual(
    system.logs.map((entry) => entry.id),
    [entries[4].id],
  );
  assert.equal(system.total, 1);
  const requests = await (await app.call("/api/logs?limit=20")).json();
  assert.deepEqual(
    requests.logs.map((entry) => entry.id),
    [entries[0].id],
  );
});

test("pagination clamps limits and offsets while legacy requests keep their response shape", async (t) => {
  const app = await fixture(t);
  app.store.state.logs = Array.from({ length: 120 }, (_, index) =>
    requestEntry(index),
  );
  const upper = await (
    await app.call("/api/logs?limit=50000&offset=-1")
  ).json();
  assert.equal(upper.limit, 100);
  assert.equal(upper.offset, 0);
  assert.equal(upper.logs.length, 100);
  const lower = await (await app.call("/api/logs?limit=-5&offset=1.9")).json();
  assert.equal(lower.limit, 1);
  assert.equal(lower.offset, 1);
  assert.deepEqual(
    lower.logs.map((entry) => entry.id),
    [app.store.state.logs[1].id],
  );
  const invalid = await (
    await app.call("/api/logs?limit=invalid&offset=invalid")
  ).json();
  assert.equal(invalid.limit, 20);
  assert.equal(invalid.offset, 0);
  const beyond = await (await app.call("/api/logs?offset=999999")).json();
  assert.deepEqual(beyond.logs, []);
  assert.equal(beyond.total, 120);
  for (const path of [
    "/api/logs",
    "/api/logs/requests",
    "/api/logs?unrelated=value",
  ]) {
    const legacy = await (await app.call(path)).json();
    assert.deepEqual(Object.keys(legacy), ["logs"]);
    assert.equal(legacy.logs.length, 120);
    assert.ok(
      legacy.logs.every((entry) => entry.requestDiagnostics === undefined),
    );
  }
});

test("downloads export all matching rows across pages and require a management session", async (t) => {
  const app = await fixture(t);
  const entries = Array.from({ length: 75 }, (_, index) =>
    requestEntry(index, { accountName: index % 3 ? "Other" : "Selected" }),
  );
  app.store.state.logs = entries;
  const expected = entries.filter(
    (entry) => entry.accountName === "Selected" && entry.status >= 400,
  );
  const response = await app.call(
    "/api/logs?download=1&q=selected&outcome=failure&limit=1&offset=10",
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^application\/json/);
  assert.match(
    response.headers.get("content-disposition"),
    /^attachment; filename="requests-logs-.*\.json"$/,
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  const downloaded = await response.json();
  assert.ok(expected.length > 1);
  assert.deepEqual(
    downloaded.map((entry) => entry.id),
    expected.map((entry) => entry.id),
  );
  assert.ok(
    downloaded.every((entry) => entry.requestDiagnostics === undefined),
  );
  assert.deepEqual(downloaded[0].initialMessage, expected[0].initialMessage);
  const empty = await (await app.call("/api/logs?download=1&q=missing")).json();
  assert.deepEqual(empty, []);
  for (const channel of ["", "/requests", "/audit", "/system"]) {
    const unauthenticated = await fetch(
      `${app.base}/api/logs${channel}?download=1`,
    );
    assert.equal(unauthenticated.status, 401);
  }
});
