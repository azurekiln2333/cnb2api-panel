import { closeDatabases } from "../../src/db.mjs";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Remove a temporary fixture directory. SQLite keeps its database files open,
 * and Windows refuses to delete an open file, so every handle is released
 * first. Connections reopen lazily, so a store that is still referenced keeps
 * working after this call.
 */
export function removeAll(directory) {
  closeDatabases();
  rmSync(directory, { recursive: true, force: true });
}

/**
 * Run a callback against the panel database of a fixture directory. Used by
 * tests that simulate documents written by an older build: they change rows
 * directly, then reopen the store and check how it loads them.
 */
export function editDatabase(directory, action) {
  const db = new DatabaseSync(join(directory, "panel.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    return action({
      run: (sql, ...values) => db.prepare(sql).run(...values),
      get: (sql, ...values) => db.prepare(sql).get(...values),
      all: (sql, ...values) => db.prepare(sql).all(...values),
    });
  } finally {
    db.close();
  }
}

export function editSettings(directory, change) {
  editDatabase(directory, (db) => {
    const row = db.get("SELECT settings FROM settings WHERE id = 1");
    const settings = JSON.parse(row.settings);
    change(settings);
    db.run(
      "UPDATE settings SET settings = ? WHERE id = 1",
      JSON.stringify(settings),
    );
  });
}

/** `change` receives `[{ id, config, runtime }]` and may reshape either part. */
export function editAccounts(directory, change) {
  editDatabase(directory, (db) => {
    const rows = readAccountRows(db);
    change(rows);
    for (const row of rows)
      db.run(
        "UPDATE accounts SET config = ?, runtime = ? WHERE id = ?",
        JSON.stringify(row.config),
        JSON.stringify(row.runtime),
        row.id,
      );
  });
}

const readAccountRows = (db) =>
  db
    .all("SELECT id, config, runtime FROM accounts ORDER BY position")
    .map((row) => ({
      id: row.id,
      config: JSON.parse(row.config),
      runtime: JSON.parse(row.runtime),
    }));

/** The stored account rows as `[{ id, config, runtime }]`, position order. */
export function readAccounts(directory) {
  return editDatabase(directory, (db) => readAccountRows(db));
}

/** `change` receives `{ key: parsedValue }` for every meta row. */
export function editMeta(directory, change) {
  editDatabase(directory, (db) => {
    const values = {};
    for (const row of db.all("SELECT key, value FROM meta"))
      values[row.key] = JSON.parse(row.value);
    const original = Object.keys(values);
    change(values);
    for (const key of original)
      if (values[key] === undefined) db.run("DELETE FROM meta WHERE key = ?", key);
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      db.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        key,
        JSON.stringify(value),
      );
    }
  });
}

/** `change` receives the hourly buckets oldest first. */
export function editHourly(directory, change) {
  editDatabase(directory, (db) => {
    const buckets = db
      .all("SELECT at, data FROM stats_hourly ORDER BY at")
      .map((row) => JSON.parse(row.data));
    change(buckets);
    db.run("DELETE FROM stats_hourly");
    for (const bucket of buckets)
      db.run(
        "INSERT INTO stats_hourly (at, data) VALUES (?, ?)",
        bucket.at,
        JSON.stringify(bucket),
      );
  });
}

/** `change` receives the daily rollup as one `{ accounts, days }` document. */
export function editDaily(directory, change) {
  editDatabase(directory, (db) => {
    const accountsRow = db.get(
      "SELECT value FROM meta WHERE key = 'dailyAccounts'",
    );
    const daily = {
      accounts: accountsRow ? JSON.parse(accountsRow.value) : [],
      days: {},
    };
    for (const row of db.all("SELECT day, data FROM stats_daily"))
      daily.days[row.day] = JSON.parse(row.data);
    change(daily);
    db.run(
      `INSERT INTO meta (key, value) VALUES ('dailyAccounts', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(daily.accounts ?? []),
    );
    db.run("DELETE FROM stats_daily");
    for (const [day, value] of Object.entries(daily.days ?? {}))
      db.run(
        "INSERT INTO stats_daily (day, data) VALUES (?, ?)",
        day,
        JSON.stringify(value),
      );
  });
}

/** The daily rollup as one `{ accounts, days }` document. */
export function readDaily(directory) {
  let daily = null;
  editDaily(directory, (value) => {
    daily = value;
  });
  return daily;
}

/**
 * Every file of a data directory decoded as text, for "never on disk"
 * assertions. Binary blobs decode lossily, which is fine for finding an ASCII
 * secret.
 */
export function diskText(directory) {
  return readdirSync(directory)
    .map((name) => readFileSync(join(directory, name)).toString("latin1"))
    .join("\n");
}
