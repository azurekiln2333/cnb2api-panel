import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { readLegacyState } from "../src/legacy-store.mjs";
import { emptyTokenUsage } from "../src/token-usage.mjs";
import {
  TEST_KEY,
  pendingDocuments,
  singleFileDocuments,
  splitDocuments,
  writeDocuments,
} from "./legacy-fixtures/index.mjs";
import { editDatabase, removeAll } from "./support/sqlite-fixture.mjs";

function fixture(t, documents, options) {
  const root = mkdtempSync(join(tmpdir(), "cnb-sqlite-import-"));
  const directory = join(root, "data");
  writeDocuments(directory, documents, options);
  t.after(() => removeAll(root));
  return { root, directory };
}
const backups = (directory) =>
  readdirSync(directory).filter((name) => name.includes(".migrated-"));
const manifest = (directory) =>
  editDatabase(directory, (db) =>
    db.all("SELECT source, checksum, backup, completed FROM legacy_imports ORDER BY source"),
  );

test("the first start imports every legacy document into SQLite and renames it", (t) => {
  const documents = splitDocuments();
  const { directory } = fixture(t, documents);
  const expected = readLegacyState(directory, { key: TEST_KEY, allowLocal: true });
  assert.equal(expected.found, true);
  const logFile = join(directory, "requests.log");
  const logBytes = readFileSync(logFile);

  const store = new Store(directory, { allowLocal: true });
  // Accounts, credentials, SSO, settings, statistics and relay state survive.
  assert.deepEqual(store.state.accounts, expected.state.accounts);
  assert.deepEqual(store.state.settings, expected.state.settings);
  assert.deepEqual(store.state.sso, expected.state.sso);
  assert.deepEqual(store.state.hourly, expected.state.hourly);
  assert.deepEqual(store.state.daily, expected.state.daily);
  assert.deepEqual(store.state.tokenUsage, expected.state.tokenUsage);
  assert.equal(store.state.tokenUsageStartedAt, expected.state.tokenUsageStartedAt);
  assert.deepEqual(store.state.creditHistory, expected.state.creditHistory);
  assert.deepEqual(store.state.registrationRelay, expected.state.registrationRelay);
  assert.equal(store.get("acct-alpha").secrets.proxyKey, "fixture-proxy-alpha");
  assert.equal(store.state.sso.clientSecret, "fixture-sso-secret");

  // The manifest records every source and the files are renamed, not deleted.
  const rows = manifest(directory);
  assert.deepEqual(
    rows.map((row) => row.source),
    ["accounts.json", "panel.json", "stats.json"],
  );
  assert.ok(rows.every((row) => row.completed === 1));
  assert.equal(backups(directory).length, 3);
  for (const name of ["accounts.json", "panel.json", "stats.json"])
    assert.equal(existsSync(join(directory, name)), false);
  for (const row of rows)
    assert.equal(
      readFileSync(join(directory, row.backup)).length > 0,
      true,
    );

  // Old logs are neither imported nor touched.
  assert.deepEqual(readFileSync(logFile), logBytes);
  assert.equal(store.logs.all().length, 0);
});

test("a restart does not import twice and keeps the same state", (t) => {
  const { directory } = fixture(t, splitDocuments());
  const first = new Store(directory, { allowLocal: true });
  const expected = structuredClone(first.state);
  const rows = manifest(directory);
  const second = new Store(directory, { allowLocal: true });
  assert.deepEqual(second.state, expected);
  assert.deepEqual(manifest(directory), rows);
  assert.equal(backups(directory).length, 3);
});

test("a crash between the commit and the renames resumes without reimporting", (t) => {
  const { directory } = fixture(t, splitDocuments());
  const first = new Store(directory, { allowLocal: true });
  const expected = structuredClone(first.state);
  // Recreate the crash window: the manifest is committed, the files are not
  // renamed yet, so the backup does not exist and the source still does.
  for (const row of manifest(directory)) {
    renameSync(join(directory, row.backup), join(directory, row.source));
    editDatabase(directory, (db) =>
      db.run("UPDATE legacy_imports SET completed = 0 WHERE source = ?", row.source),
    );
  }
  const resumed = new Store(directory, { allowLocal: true });
  assert.deepEqual(resumed.state, expected);
  assert.ok(manifest(directory).every((row) => row.completed === 1));
  for (const name of ["accounts.json", "panel.json", "stats.json"])
    assert.equal(existsSync(join(directory, name)), false);
});

test("legacy data that reappears beside the database stops the panel", (t) => {
  const { directory } = fixture(t, splitDocuments());
  new Store(directory, { allowLocal: true });
  writeFileSync(join(directory, "accounts.json"), JSON.stringify({ version: 1, accounts: [] }));
  assert.throws(() => new Store(directory, { allowLocal: true }), /Legacy panel data/);
});

test("a changed legacy file during migration is refused instead of overwritten", (t) => {
  const { directory } = fixture(t, splitDocuments());
  new Store(directory, { allowLocal: true });
  const row = manifest(directory).find((entry) => entry.source === "accounts.json");
  renameSync(join(directory, row.backup), join(directory, row.source));
  writeFileSync(join(directory, row.source), JSON.stringify({ version: 1, accounts: [] }));
  editDatabase(directory, (db) =>
    db.run("UPDATE legacy_imports SET completed = 0 WHERE source = ?", row.source),
  );
  assert.throws(
    () => new Store(directory, { allowLocal: true }),
    /changed during migration/,
  );
});

test("a corrupt legacy document fails without leaving a usable empty database", (t) => {
  const documents = splitDocuments();
  documents["stats.json"] = "{not json";
  const { directory } = fixture(t, documents);
  const original = readFileSync(join(directory, "stats.json"));
  assert.throws(() => new Store(directory, { allowLocal: true }));
  // The old files are untouched and the database holds no settings row, so the
  // next start fails the same way instead of starting empty.
  assert.deepEqual(readFileSync(join(directory, "stats.json")), original);
  assert.equal(existsSync(join(directory, "accounts.json")), true);
  assert.equal(
    editDatabase(directory, (db) => db.get("SELECT id FROM settings WHERE id = 1")),
    undefined,
  );
  assert.throws(() => new Store(directory, { allowLocal: true }));
});

test("a missing master key refuses to import and never creates a new one", (t) => {
  const { directory } = fixture(t, splitDocuments(), { key: null });
  assert.throws(() => new Store(directory, { allowLocal: true }), /master.key is missing/);
  assert.equal(existsSync(join(directory, "master.key")), false);
  assert.equal(existsSync(join(directory, "accounts.json")), true);
});

test("a single-file version 1 document imports accounts, statistics and no logs", (t) => {
  const { directory } = fixture(t, singleFileDocuments());
  const store = new Store(directory, { allowLocal: true });
  assert.equal(store.state.accounts.length, 1);
  assert.equal(store.get("acct-alpha").requests, 7);
  assert.equal(store.get("acct-alpha").secrets.proxyKey, "fixture-proxy-alpha");
  assert.equal(store.state.tokenUsage.total, 140);
  assert.equal(store.state.hourly.length, 2);
  // Version 1 logs are not migrated.
  assert.equal(store.logs.all().length, 0);
  assert.equal(existsSync(join(directory, "panel.json")), false);
  assert.equal(backups(directory).length, 1);
});

test("an interrupted multi-document commit is replayed before the import", (t) => {
  const { documents, pending } = pendingDocuments();
  const { directory } = fixture(t, documents);
  writeFileSync(join(directory, "store.pending"), JSON.stringify(pending));
  const store = new Store(directory, { allowLocal: true });
  // The journal's replacements win over the older files on disk.
  assert.equal(store.get("acct-alpha").name, "甲账号（已改名）");
  assert.equal(store.get("acct-alpha").requests, 43);
  assert.equal(store.state.settings.strategy, "round-robin");
  // The journal's log appends are ignored, and the journal is renamed too.
  assert.equal(store.logs.all().length, 0);
  assert.equal(existsSync(join(directory, "store.pending")), false);
  assert.equal(backups(directory).length, 4);
});

test("an empty data directory starts a fresh database without a manifest", (t) => {
  const root = mkdtempSync(join(tmpdir(), "cnb-sqlite-fresh-"));
  const directory = join(root, "data");
  t.after(() => removeAll(root));
  const store = new Store(directory, { allowLocal: true });
  assert.deepEqual(store.state.accounts, []);
  assert.deepEqual(store.state.tokenUsage, emptyTokenUsage());
  assert.deepEqual(manifest(directory), []);
  assert.equal(existsSync(join(directory, "master.key")), true);
});
