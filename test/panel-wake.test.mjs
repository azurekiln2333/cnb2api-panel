import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { Store } from "../src/store.mjs";
import { Pool } from "../src/pool.mjs";
import { createPanelServer } from "../src/app.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "cnb-panel-wake-"));
  const store = new Store(directory);
  const pool = new Pool(store);
  const account = store.create({
    name: "wake-test-account",
    repo: "org/workspace",
    branch: "main",
    proxyKey: "wake-test-proxy-key",
    pat: "old-personal-token",
    autoWake: true,
  });
  t.after(() => {
    pool.stop();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, pool, id: account.id };
}

const success = () => Response.json({ sn: "workspace-start-confirmed" });
const recentWake = () => new Date(Date.now() - 5 * 60000).toISOString();

test("manual wake can retry within 30 minutes of a successful start using an updated PAT", async (t) => {
  const app = fixture(t);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, ...options });
    return success();
  });
  assert.deepEqual(await app.pool.wake(app.id), { ok: true });
  const firstWake = app.store.get(app.id).lastWakeAt;
  assert.ok(Date.now() - Date.parse(firstWake) < 30 * 60000);
  app.store.update(app.id, { pat: "new-personal-token" });
  assert.deepEqual(await app.pool.wake(app.id), { ok: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Authorization, "Bearer old-personal-token");
  assert.equal(calls[1].headers.Authorization, "Bearer new-personal-token");
  assert.equal(calls[1].url, "https://api.cnb.cool/org/workspace/-/workspace/start");
  assert.equal(calls[1].method, "POST");
  assert.deepEqual(JSON.parse(calls[1].body), { branch: "main" });
});

test("official URL-only and mixed responses confirm existing workspaces without changing worker routing", async (t) => {
  for (const [name, data] of [
    ["absolute WebIDE URL", { url: "https://cnb.cool/org/workspace/-/workspace" }],
    ["relative loading URL", { url: "/org/workspace/-/workspace/loading" }],
    ["invalid sn with valid URL", { sn: 123, url: "/org/workspace/-/workspace" }],
    ["blank sn with valid URL", { sn: "  ", url: "/org/workspace/-/workspace" }],
  ]) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      const remote = t.mock.method(globalThis, "fetch", async () => Response.json(data));
      assert.deepEqual(await app.pool.wake(app.id), { ok: true });
      assert.equal(remote.mock.callCount(), 1);
      const current = app.store.get(app.id);
      assert.ok(current.lastWakeAt);
      assert.equal(current.endpoint, "");
      assert.equal(current.status, "pending");
      assert.equal(app.store.state.logs[0].status, 200);
    });
  }
});

test("automatic wake and the background cycle retain the 30 minute cooldown without calling CNB", async (t) => {
  const app = fixture(t);
  const lastWakeAt = recentWake();
  app.store.patch(app.id, { lastWakeAt });
  const remote = t.mock.method(globalThis, "fetch", async () => success());
  await assert.rejects(app.pool.wake(app.id, { automatic: true }), {
    status: 409,
    message: /30 分钟冷却/,
  });
  await app.pool.cycle();
  assert.equal(remote.mock.callCount(), 0);
  assert.equal(app.store.get(app.id).lastWakeAt, lastWakeAt);
  app.store.patch(app.id, {
    lastWakeAt: new Date(Date.now() - 31 * 60000).toISOString(),
  });
  await app.pool.cycle();
  assert.equal(remote.mock.callCount(), 1);
  assert.ok(Date.now() - Date.parse(app.store.get(app.id).lastWakeAt) < 60000);
});

test("manual and automatic calls share an actual in-flight workspace start", async (t) => {
  for (const [name, firstAutomatic, secondAutomatic] of [
    ["manual then automatic", false, true],
    ["automatic then manual", true, false],
    ["manual then manual", false, false],
  ]) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      const previous = firstAutomatic ? null : recentWake();
      app.store.patch(app.id, { lastWakeAt: previous });
      let finish;
      const gate = new Promise((resolve) => {
        finish = resolve;
      });
      t.after(() => finish(success()));
      const remote = t.mock.method(globalThis, "fetch", () => gate);
      const first = app.pool.wake(app.id, { automatic: firstAutomatic });
      const second = app.pool.wake(app.id, { automatic: secondAutomatic });
      assert.equal(remote.mock.callCount(), 1);
      assert.equal(app.store.get(app.id).lastWakeAt, previous);
      finish(success());
      assert.deepEqual(await Promise.all([first, second]), [
        { ok: true },
        { ok: true },
      ]);
      assert.equal(app.pool.wakes.size, 0);
      assert.equal(app.store.state.logs.filter((log) => log.kind === "wake").length, 1);
    });
  }
});

test("an automatically skipped wake cannot make a concurrent manual retry inherit the cooldown error", async (t) => {
  const app = fixture(t);
  app.store.patch(app.id, { lastWakeAt: recentWake() });
  const remote = t.mock.method(globalThis, "fetch", async () => success());
  const automatic = assert.rejects(
    app.pool.wake(app.id, { automatic: true }),
    { status: 409 },
  );
  const manual = app.pool.wake(app.id);
  await automatic;
  assert.deepEqual(await manual, { ok: true });
  assert.equal(remote.mock.callCount(), 1);
});

test("failed or unconfirmed starts preserve lastWakeAt and allow an immediate manual retry", async (t) => {
  const cases = [
    ["HTTP rejection", () => Response.json({ sn: "rejected" }, { status: 403 })],
    ["missing sn", () => Response.json({})],
    ["blank sn", () => Response.json({ sn: "   " })],
    ["numeric sn", () => Response.json({ sn: 123 })],
    ["object sn", () => Response.json({ sn: {} })],
    ["blank URL", () => Response.json({ url: "  " })],
    ["nonstring URL", () => Response.json({ url: 123 })],
    ["message only", () => Response.json({ message: "accepted" })],
    ["invalid JSON", () => new Response("not JSON")],
    ["network failure", () => { throw new Error("network unavailable"); }],
  ];
  for (const [name, response] of cases) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      const lastWakeAt = recentWake();
      app.store.patch(app.id, { lastWakeAt });
      let rejected = true;
      const remote = t.mock.method(globalThis, "fetch", async () =>
        rejected ? response() : success(),
      );
      await assert.rejects(app.pool.wake(app.id), {
        status: 424,
        message: /CNB 唤醒失败/,
      });
      assert.equal(app.store.get(app.id).lastWakeAt, lastWakeAt);
      assert.equal(app.pool.wakes.size, 0);
      assert.equal(app.store.state.logs.filter((log) => log.kind === "wake").length, 1);
      assert.ok(app.store.state.logs[0].status >= 400);
      rejected = false;
      assert.deepEqual(await app.pool.wake(app.id), { ok: true });
      assert.equal(remote.mock.callCount(), 2);
      assert.notEqual(app.store.get(app.id).lastWakeAt, lastWakeAt);
    });
  }
});

test("HTTP failures preserve upstream status and actionable safe diagnostics without exposing response bodies", async (t) => {
  for (const [status, hint] of [
    [400, /仓库路径和分支/],
    [401, /个人令牌无效或已过期/],
    [403, /repo-cnb-trigger:rw/],
    [404, /仓库路径、分支和令牌可见范围/],
    [422, /vscode 配置/],
    [429, /请求频率受限/],
    [500, /CNB 服务暂时不可用/],
  ]) {
    await t.test(`HTTP ${status}`, async (t) => {
      const app = fixture(t);
      const lastWakeAt = recentWake();
      app.store.patch(app.id, { lastWakeAt });
      const secrets = Object.values(app.store.get(app.id).secrets);
      t.mock.method(globalThis, "fetch", async () => Response.json({
        sn: "not-successful",
        message: secrets.join(" "),
        unknownDebugField: "private-upstream-debug-info",
      }, { status }));
      let message;
      await assert.rejects(app.pool.wake(app.id), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.match(error.message, hint);
        message = error.message;
        return true;
      });
      assert.equal(app.store.get(app.id).lastWakeAt, lastWakeAt);
      const logs = app.store.state.logs.filter((log) => log.kind === "wake");
      assert.equal(logs.length, 1);
      assert.equal(logs[0].message, message);
      assert.equal(logs[0].status, status);
      assert.equal(logs[0].upstreamStatus, status);
      const visible = JSON.stringify({ message, logs });
      for (const secret of secrets) assert.equal(visible.includes(secret), false);
      assert.equal(visible.includes("private-upstream-debug-info"), false);
    });
  }
});

test("network and timeout failures are distinct, safely logged, and never start cooldown", async (t) => {
  for (const [name, makeError, hint, status] of [
    ["network", (message) => new TypeError(message), /网络连接失败/, 502],
    ["timeout", (message) => new DOMException(message, "TimeoutError"), /请求超时/, 504],
  ]) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      const secrets = Object.values(app.store.get(app.id).secrets);
      t.mock.method(globalThis, "fetch", async () => {
        throw makeError(secrets.join(" "));
      });
      let message;
      await assert.rejects(app.pool.wake(app.id), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, hint);
        message = error.message;
        return true;
      });
      assert.equal(app.store.get(app.id).lastWakeAt, null);
      const log = app.store.state.logs[0];
      assert.equal(log.message, message);
      assert.equal(log.status, status);
      assert.equal(log.upstreamStatus, null);
      const visible = JSON.stringify({ message, log });
      for (const secret of secrets) assert.equal(visible.includes(secret), false);
    });
  }
});

test("the HTTP wake endpoint returns safe 424 JSON for CNB auth failures while the admin session stays usable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cnb-panel-wake-http-"));
  const app = createPanelServer({
    adminKey: "wake-test-admin-key",
    gatewayKey: "wake-test-gateway-key",
    dataDir: directory,
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const realFetch = globalThis.fetch;
  const login = await realFetch(`${base}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "wake-test-admin-key" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.body.cancel();
  const account = app.store.create({
    name: "http-wake-account",
    repo: "org/workspace",
    proxyKey: "http-wake-proxy-key",
    pat: "http-wake-personal-token",
  });
  const secrets = Object.values(account.secrets);
  let upstreamStatus = 403;
  const remote = t.mock.method(globalThis, "fetch", async (input, options) => {
    if (new URL(input).hostname !== "api.cnb.cool") return realFetch(input, options);
    return Response.json({
      message: `Workspace quota exhausted. ${secrets.join(" ")}`,
      privateDebugField: "private-http-upstream-debug",
    }, { status: upstreamStatus });
  });
  for (const status of [403, 401]) {
    upstreamStatus = status;
    const response = await realFetch(`${base}/api/accounts/${account.id}/wake`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 424);
    assert.match(response.headers.get("content-type"), /^application\/json/);
    const result = await response.json();
    assert.match(result.error.message, new RegExp(`HTTP ${status}`));
    assert.match(result.error.message, /CNB 说明：Workspace quota exhausted\./);
    if (status === 403) assert.match(result.error.message, /repo-cnb-trigger:rw/);
    const visible = JSON.stringify(result);
    for (const secret of secrets) assert.equal(visible.includes(secret), false);
    assert.equal(visible.includes("private-http-upstream-debug"), false);
    assert.equal(app.store.get(account.id).lastWakeAt, null);
    const overview = await realFetch(`${base}/api/overview`, {
      headers: { Cookie: cookie },
    });
    assert.equal(overview.status, 200);
    await overview.body.cancel();
  }
  assert.equal(remote.mock.callCount(), 2);
  assert.deepEqual(app.store.state.logs.filter((log) => log.kind === "wake").map((log) => log.upstreamStatus), [401, 403]);
});

test("CNB JSON explanation fields are shown while unknown fields stay private", async (t) => {
  for (const [name, data] of [
    ["message", { message: "Workspace quota exhausted" }],
    ["msg", { msg: "Requested branch was not found" }],
    ["nested error", { error: { message: "Workspace limit reached" } }],
    ["string error", { error: "Development environment is unavailable" }],
  ]) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      t.mock.method(globalThis, "fetch", async () => Response.json({
        ...data,
        privateDebugField: "private-upstream-trace",
      }, { status: 403 }));
      await assert.rejects(app.pool.wake(app.id), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, /CNB 说明：/);
        assert.equal(error.message.includes("private-upstream-trace"), false);
        return true;
      });
      assert.equal(app.store.state.logs[0].upstreamStatus, 403);
      assert.equal(app.store.get(app.id).lastWakeAt, null);
    });
  }
});

test("CNB explanations redact every account secret and URL-encoded variants before truncation", async (t) => {
  const app = fixture(t);
  app.store.update(app.id, {
    pat: "pat+/=token1",
    proxyKey: "key+/=token2",
    registrationToken: "reg+/=token3",
  });
  const secrets = Object.values(app.store.get(app.id).secrets);
  const variants = secrets.flatMap((secret) => [
    secret,
    encodeURIComponent(secret),
    encodeURIComponent(encodeURIComponent(secret)),
    new URLSearchParams({ value: secret }).toString().slice(6),
  ]);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    message: `Workspace limit reached. ${variants.join(" ; ")}`,
  }, { status: 403 }));
  let message;
  await assert.rejects(app.pool.wake(app.id), (error) => {
    message = error.message;
    assert.match(message, /Workspace limit reached/);
    assert.match(message, /\[已隐藏\]/);
    return true;
  });
  const visible = JSON.stringify({ message, logs: app.store.state.logs });
  for (const value of variants) assert.equal(visible.includes(value), false);
});

test("CNB explanations redact generic credential key-values and normalize controls", async (t) => {
  const app = fixture(t);
  const credentials = ["unknown-bearer", "unknown-token", "unknown-pat", "unknown-password", "unknown-api-key"];
  t.mock.method(globalThis, "fetch", async () => Response.json({
    message: "Workspace limit reached. " +
      `Bearer ${credentials[0]}; token=${credentials[1]}; PAT:'${credentials[2]}'; ` +
      `password=\"${credentials[3]}\"; api-key=${credentials[4]}; ` +
      `password=\"private-first\nprivate-second\";\n\r\t\u0000\u202e retry later`,
  }, { status: 403 }));
  await assert.rejects(app.pool.wake(app.id), (error) => {
    assert.match(error.message, /Workspace limit reached/);
    assert.match(error.message, /retry later/);
    assert.doesNotMatch(error.message, /[\p{Cc}\p{Cf}]/u);
    assert.doesNotMatch(error.message, /private-first|private-second/);
    for (const value of credentials) assert.equal(error.message.includes(value), false);
    return true;
  });
});

test("escaped quotes inside credential values never expose their remaining contents", async (t) => {
  for (const [name, credential] of [
    ["double-quoted password", String.raw`password="private-first\"private-second"`],
    ["single-quoted password", String.raw`password='private-first\'private-second'`],
    ["double-quoted Bearer", String.raw`Bearer "private-first\"private-second"`],
    ["single-quoted Bearer", String.raw`Bearer 'private-first\'private-second'`],
    ["URL-encoded quoted token", encodeURIComponent(String.raw`token="private-first\"private-second"`)],
  ]) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      t.mock.method(globalThis, "fetch", async () => Response.json({
        message: `Workspace limit reached. ${credential}; request rejected`,
      }, { status: 403 }));
      let message;
      await assert.rejects(app.pool.wake(app.id), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, /Workspace limit reached/);
        assert.match(error.message, /request rejected/);
        assert.match(error.message, /\[已隐藏\]/);
        assert.doesNotMatch(error.message, /private-first|private-second/);
        message = error.message;
        return true;
      });
      const log = app.store.state.logs[0];
      assert.equal(log.message, message);
      assert.equal(log.status, 403);
      assert.equal(log.upstreamStatus, 403);
      assert.equal(app.store.get(app.id).lastWakeAt, null);
    });
  }
});

test("CNB explanations are limited to 400 characters after redaction", async (t) => {
  const app = fixture(t);
  t.mock.method(globalThis, "fetch", async () => Response.json({
    message: "Workspace limit reached. " + "additional explanation ".repeat(100),
  }, { status: 403 }));
  await assert.rejects(app.pool.wake(app.id), (error) => {
    assert.equal(error.message.split("CNB 说明：")[1].length, 400);
    return true;
  });
});

test("unsafe, invalid, incomplete, and oversized error bodies fall back to the HTTP hint", async (t) => {
  for (const [name, response] of [
    ["HTML body", () => new Response("<html><script>private-script</script></html>", { status: 403, headers: { "Content-Type": "text/html" } })],
    ["HTML in JSON message", () => Response.json({ message: "<script>private-script</script>" }, { status: 403 })],
    ["debug-only JSON", () => Response.json({ debug: "private-debug-body" }, { status: 403 })],
    ["invalid JSON", () => new Response("not JSON private-debug-body", { status: 403, headers: { "Content-Type": "application/json" } })],
    ["incomplete JSON", () => new Response('{"message":"private-incomplete', { status: 403, headers: { "Content-Type": "application/json" } })],
    ["oversized JSON", () => Response.json({ message: "private-large-message".repeat(1000) }, { status: 403 })],
  ]) {
    await t.test(name, async (t) => {
      const app = fixture(t);
      t.mock.method(globalThis, "fetch", async () => response());
      await assert.rejects(app.pool.wake(app.id), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, /HTTP 403/);
        assert.doesNotMatch(error.message, /CNB 说明|private-/);
        return true;
      });
      assert.equal(app.store.state.logs[0].status, 403);
      assert.equal(app.store.state.logs[0].upstreamStatus, 403);
    });
  }
});

test("error-body reads cancel at the byte limit and preserve HTTP status when reading times out", async (t) => {
  for (const mode of ["limit", "timeout"]) {
    await t.test(mode, async (t) => {
      const app = fixture(t);
      let cancelled = false;
      let pulls = 0;
      const stream = new ReadableStream({
        pull(controller) {
          if (mode === "limit") controller.enqueue(new Uint8Array(16 * 1024));
          else if (pulls++ === 0)
            controller.enqueue(new TextEncoder().encode('{"message":"partial'));
          else controller.error(new DOMException("private-timeout-body", "TimeoutError"));
        },
        cancel() { cancelled = true; },
      });
      t.mock.method(globalThis, "fetch", async () => new Response(stream, {
        status: 403,
        headers: { "Content-Type": "application/vnd.cnb.api+json" },
      }));
      await assert.rejects(app.pool.wake(app.id), (error) => {
        assert.equal(error.status, 424);
        assert.match(error.message, /HTTP 403/);
        assert.doesNotMatch(error.message, /CNB 说明|private-/);
        return true;
      });
      if (mode === "limit") assert.equal(cancelled, true);
      assert.equal(app.store.state.logs[0].upstreamStatus, 403);
      assert.equal(app.store.get(app.id).lastWakeAt, null);
    });
  }
});
