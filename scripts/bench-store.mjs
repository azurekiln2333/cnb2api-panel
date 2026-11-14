// Compares the pre-SQLite store (HEAD) with the current SQLite store on
// production-scale data. Not part of `npm test`: it writes to temp directories
// only and takes a few seconds per implementation.
//
//   node scripts/bench-store.mjs
//
// Everything is synthetic: no real account, credential or data directory is
// touched. Write volume is counted on each implementation's own write path, so
// a rewrite of an identically sized file still counts as written.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");
const REPOSITORY = resolve(SOURCE, "..");
const ACCOUNTS = 11;
const HOURLY = 720;
const LOGS_PER_CHANNEL = 1000;
const CYCLES = 10;

/** HEAD's file-based store, materialised next to its own dependencies. */
function legacySources(root) {
  const directory = join(root, "legacy-src");
  mkdirSync(directory, { recursive: true });
  // Copy the whole source tree so transitive imports of HEAD's modules resolve
  // without a hand-maintained dependency list, then restore HEAD's own files.
  for (const name of readdirSync(SOURCE))
    if (name.endsWith(".mjs"))
      copyFileSync(join(SOURCE, name), join(directory, name));
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  for (const name of ["store.mjs", "file-storage.mjs"])
    writeFileSync(
      join(directory, name),
      execFileSync("git", ["show", `HEAD:src/${name}`], {
        cwd: REPOSITORY,
        maxBuffer: 64 * 1048576,
      }),
    );
  return directory;
}

const account = (index) => ({
  name: `acct-${index}`,
  repo: `org/repo${index}`,
  endpoint: `https://ws${index}-9001.cnb.run`,
  pat: `pat-${index}-${"x".repeat(40)}`,
  proxyKey: `key-${index}-${"y".repeat(40)}`,
  registrationToken: `${"r".repeat(40)}${index}`,
});

// Same shape as the production diagnostics payload: 64 messages, ~11KB once
// serialised with initialMessage.
const diagnostics = {
  messages: Array.from({ length: 64 }, (_, index) => ({
    role: "user",
    index,
    chars: 900,
    preview: "p".repeat(80),
  })),
};

const logEntry = (kind, accountIds, index, extra = {}) => ({
  id: randomUUID(),
  at: new Date(Date.now() - index * 1000).toISOString(),
  kind,
  accountId: accountIds[index % accountIds.length],
  status: 200,
  durationMs: 800,
  message: `m${index}`,
  ...extra,
});

const requestEntry = (accountIds, index) =>
  logEntry("request", accountIds, index, {
    initialMessage: "q".repeat(4000),
    requestDiagnostics: diagnostics,
    path: "/v1/chat/completions",
    model: "fixture-model",
  });

const buckets = (accountIds, now) =>
  Array.from({ length: HOURLY }, (_, hour) => ({
    at: new Date(
      Math.floor(now / 3600000) * 3600000 - hour * 3600000,
    ).toISOString(),
    requests: 100,
    errors: 3,
    durationMs: 90000,
    accounts: Object.fromEntries(accountIds.map((id) => [id, 9])),
    tokenUsage: {
      input: 1e6,
      output: 1e5,
      total: 1.1e6,
      cacheRead: 5e5,
      cacheWrite: 1e5,
    },
  }));

const logEntries = (accountIds) => [
  ...Array.from({ length: LOGS_PER_CHANNEL }, (_, index) =>
    requestEntry(accountIds, index),
  ),
  ...Array.from({ length: LOGS_PER_CHANNEL }, (_, index) =>
    logEntry("audit", accountIds, index),
  ),
  ...Array.from({ length: LOGS_PER_CHANNEL }, (_, index) =>
    logEntry("health", accountIds, index),
  ),
];

const directoryBytes = (directories) => {
  let total = 0;
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      try {
        total += statSync(join(directory, name)).size;
      } catch {
        // A checkpoint may remove a WAL file between readdir and stat.
      }
    }
  }
  return total;
};

function measure(label, operation, { iterations = 5, counter }) {
  for (let index = 0; index < 2; index++) operation(index);
  const bytesBefore = counter.bytes;
  const cpu = process.cpuUsage();
  const started = process.hrtime.bigint();
  for (let index = 0; index < iterations; index++) operation(index);
  const wall = Number(process.hrtime.bigint() - started) / 1e6;
  const used = process.cpuUsage(cpu);
  return {
    label,
    wall: wall / iterations,
    cpu: (used.user + used.system) / 1000 / iterations,
    kilobytes: (counter.bytes - bytesBefore) / iterations / 1024,
  };
}

async function run(label, build, { iterations = 5 } = {}) {
  const root = mkdtempSync(join(tmpdir(), `cnb-bench-${label}-`));
  const dataDirectory = join(root, "data");
  const logDirectory = join(root, "logs");
  const counter = { bytes: 0 };
  let store = null;
  try {
    store = build({ dataDirectory, logDirectory, counter });
    const ids = store.state.accounts.map((entry) => entry.id);
    const now = () => new Date().toISOString();
    const options = { counter, iterations };
    const results = [
      measure(
        "patch(checkedAt)",
        (index) =>
          store.patch(ids[index % ACCOUNTS], {
            checkedAt: now(),
            latencyMs: 100 + index,
          }),
        options,
      ),
      measure(
        "patch(workerUsage)",
        (index) =>
          store.patch(ids[index % ACCOUNTS], {
            workerUsage: {
              at: now(),
              requests: index,
              prompt: 100,
              completion: 10,
            },
          }),
        options,
      ),
      measure(
        "record(health)",
        (index) =>
          store.record({
            kind: "health",
            accountId: ids[index % ACCOUNTS],
            status: 200,
            message: `h${index}`,
          }),
        options,
      ),
      measure(
        "record(request ~11KB)",
        (index) => store.record(requestEntry(ids, index)),
        options,
      ),
    ];
    // One health cycle is what an idle panel does every 60 seconds: every
    // account is patched, its health recorded and its worker usage refreshed.
    const cpu = process.cpuUsage();
    for (let cycle = 0; cycle < CYCLES; cycle++)
      for (const id of ids) {
        store.patch(id, { checkedAt: now(), latencyMs: 90 });
        store.record({
          kind: "health",
          accountId: id,
          status: 200,
          message: "探活成功",
        });
        store.patch(id, {
          workerUsage: { at: now(), requests: 1, prompt: 10, completion: 2 },
        });
      }
    const used = process.cpuUsage(cpu);
    const cycleCpu = (used.user + used.system) / 1000 / CYCLES;
    return {
      label,
      results,
      cycleCpu,
      metrics: store.metrics?.() ?? null,
      bytes: directoryBytes([dataDirectory, logDirectory]),
    };
  } finally {
    store?.close?.();
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  const container = mkdtempSync(join(tmpdir(), "cnb-bench-src-"));
  try {
    const legacyDirectory = legacySources(container);
    const current = await import(pathToFileURL(join(SOURCE, "store.mjs")).href);
    const legacy = await import(
      pathToFileURL(join(legacyDirectory, "store.mjs")).href
    );

    // HEAD: three documents plus three log files, journalled through store.pending.
    const old = await run("old", ({ dataDirectory, logDirectory, counter }) => {
      const store = new legacy.Store(dataDirectory, {
        allowLocal: true,
        logDir: logDirectory,
      });
      const write = store.storage.write.bind(store.storage);
      store.storage.write = (operations) => {
        for (const operation of operations)
          counter.bytes += Buffer.byteLength(operation.text);
        return write(operations);
      };
      const ids = Array.from(
        { length: ACCOUNTS },
        (_, index) => store.create(account(index)).id,
      );
      store.commit((state) => {
        state.hourly = buckets(ids, Date.now());
        state.logs = logEntries(ids);
      });
      return store;
    });

    // Current: one state database plus one log database. Its writes are fast
    // enough that a five-sample average is dominated by measurement noise.
    const next = await run("new", ({ dataDirectory, logDirectory, counter }) => {
      const store = new current.Store(dataDirectory, {
        allowLocal: true,
        logDir: logDirectory,
      });
      for (const connection of [store.connection, store.logs.connection]) {
        const run = connection.run.bind(connection);
        connection.run = (...args) => {
          for (const value of args)
            if (typeof value === "string") counter.bytes += Buffer.byteLength(value);
          return run(...args);
        };
      }
      const ids = Array.from(
        { length: ACCOUNTS },
        (_, index) => store.create(account(index)).id,
      );
      store.commit((state) => {
        state.hourly = buckets(ids, Date.now());
      });
      store.logs.replace(logEntries(ids));
      return store;
    }, { iterations: 300 });

    console.log(
      `\n${ACCOUNTS} 个账号 · ${HOURLY} 个 hourly 桶 · 每通道 ${LOGS_PER_CHANNEL} 条日志 · 请求日志每条约 11KB\n`,
    );
    for (const implementation of [old, next]) {
      console.log(`[${implementation.label}]`);
      console.log("op                        ms/op   cpu/op   写盘KB/op");
      for (const result of implementation.results)
        console.log(
          `${result.label.padEnd(22)} ${result.wall.toFixed(1).padStart(7)} ${result.cpu
            .toFixed(1)
            .padStart(7)} ${result.kilobytes.toFixed(0).padStart(7)}`,
        );
      console.log(
        `探活周期（${ACCOUNTS} × patch + record + patch）: ${implementation.cycleCpu.toFixed(1)}ms CPU/次`,
      );
      console.log(
        `→ 空闲占 60 秒周期的 ${((implementation.cycleCpu / 60000) * 100).toFixed(1)}% CPU`,
      );
      if (implementation.metrics)
        console.log(`store.metrics(): ${JSON.stringify(implementation.metrics)}`);
      console.log("");
    }
    console.log("[对比]");
    for (const kind of [
      "patch(checkedAt)",
      "patch(workerUsage)",
      "record(health)",
      "record(request",
    ]) {
      const before = old.results.find((entry) => entry.label.startsWith(kind));
      const after = next.results.find((entry) => entry.label.startsWith(kind));
      console.log(
        `${kind.padEnd(20)} ${before.cpu.toFixed(1)}ms → ${after.cpu.toFixed(2)}ms（${
          after.cpu < 0.01 ? "≥200" : (before.cpu / after.cpu).toFixed(1)
        }×）`,
      );
    }
    console.log(
      `探活周期 CPU ${old.cycleCpu.toFixed(1)}ms → ${next.cycleCpu.toFixed(2)}ms；` +
        `空闲 CPU ${((old.cycleCpu / 60000) * 100).toFixed(1)}% → ${(
          (next.cycleCpu / 60000) *
          100
        ).toFixed(2)}%`,
    );
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
}

await main();
