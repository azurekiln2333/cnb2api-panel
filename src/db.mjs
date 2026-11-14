import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LOG_RETENTION, logChannel } from "./file-storage.mjs";

// Node's built-in SQLite is the only driver: no native dependency, and the
// call surface stays on `exec` / `prepare().run/get/all` / `close` so Node 24
// and 26 behave identically.
const SYNCHRONOUS = ["OFF", "NORMAL", "FULL", "EXTRA"];

// Tests remove their temporary directories while connections may still exist,
// and a Windows handle blocks that removal. Connections therefore reopen
// lazily, which makes an explicit close always safe. Several stores may open
// the same file, so every instance is tracked separately.
const connections = new Set();

export class Connection {
  constructor(file, { synchronous = "NORMAL" } = {}) {
    if (!SYNCHRONOUS.includes(synchronous))
      throw new Error("Invalid SQLite synchronous mode");
    this.file = resolve(file);
    this.synchronous = synchronous;
    this.handle = null;
    this.statements = new Map();
    connections.add(this);
  }

  get db() {
    if (!this.handle) this.open();
    return this.handle;
  }

  open() {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = new DatabaseSync(this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // Filesystems without POSIX modes keep their default permissions.
    }
    handle.exec("PRAGMA busy_timeout=5000");
    handle.exec("PRAGMA journal_mode=WAL");
    handle.exec("PRAGMA foreign_keys=ON");
    handle.exec(`PRAGMA synchronous=${this.synchronous}`);
    this.handle = handle;
    this.statements.clear();
  }

  statement(sql) {
    let prepared = this.statements.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.statements.set(sql, prepared);
    }
    return prepared;
  }

  exec(sql) {
    this.db.exec(sql);
  }

  run(sql, ...values) {
    return this.statement(sql).run(...values);
  }

  get(sql, ...values) {
    return this.statement(sql).get(...values);
  }

  all(sql, ...values) {
    return this.statement(sql).all(...values);
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // A rolled-back transaction must not mask the original failure.
      }
      throw error;
    }
  }

  // Credentials and settings are written rarely but must survive a power cut,
  // so the WAL is folded into the database file after each such transaction.
  checkpoint() {
    if (!this.handle) return;
    try {
      this.handle.exec("PRAGMA wal_checkpoint(FULL)");
    } catch {
      // A busy checkpoint leaves the data in the WAL; the next one retries.
    }
  }

  migrate(migrations, label) {
    this.transaction(() => {
      this.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY CHECK (version > 0),
        applied_at TEXT NOT NULL
      )`);
      const applied = this.all(
        "SELECT version FROM schema_version ORDER BY version",
      );
      if (
        applied.some((row, index) => row.version !== index + 1) ||
        applied.length > migrations.length
      )
        throw new Error(
          `Unsupported ${label} database schema; restore a compatible backup`,
        );
      for (let index = applied.length; index < migrations.length; index++) {
        this.exec(migrations[index]);
        this.run(
          "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)",
          index + 1,
          new Date().toISOString(),
        );
      }
    });
  }

  close() {
    if (!this.handle) return;
    try {
      this.handle.close();
    } catch {
      // Closing twice is not an error.
    }
    this.handle = null;
    this.statements.clear();
  }
}

/** Release every open database handle; used before removing a data directory. */
export function closeDatabases() {
  for (const connection of [...connections]) connection.close();
}

const LOG_MIGRATIONS = [
  `CREATE TABLE logs (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     channel TEXT NOT NULL,
     at TEXT NOT NULL,
     kind TEXT NOT NULL,
     status INTEGER,
     account_id TEXT,
     search TEXT NOT NULL DEFAULT '',
     payload TEXT NOT NULL
   );
   CREATE INDEX logs_channel_seq ON logs (channel, seq);
   CREATE INDEX logs_channel_kind ON logs (channel, kind);
   CREATE INDEX logs_channel_status ON logs (channel, status);`,
];

// Trimming runs once per 200 appends instead of on every insert; readers never
// see more than the retained window because every query starts from it.
const TRIM_SLACK = 200;

// The search column holds the same text the in-memory filter used to join, so
// page contents stay identical.
const searchText = (entry) =>
  [
    entry.accountName,
    entry.actor?.name,
    entry.action,
    entry.ip,
    entry.model,
    entry.message,
    entry.requestId,
    entry.initialMessage?.text,
  ]
    .map((value) => value ?? "")
    .join(" ")
    .toLowerCase();
const summary = ({ requestDiagnostics, ...entry }) => entry;

function parsePayload(text) {
  try {
    return JSON.parse(text);
  } catch {
    // Payloads contain prompts; never echo parser source text in an error.
    throw new Error("Invalid stored log entry; restore the log backup");
  }
}

/**
 * Append-only log storage in its own database file, so losing it never
 * endangers accounts or statistics.
 */
export class LogStore {
  constructor(directory, { dataDirectory } = {}) {
    this.directory = resolve(directory);
    if (dataDirectory) {
      const fromData = relative(resolve(dataDirectory), this.directory);
      if (
        !fromData ||
        (!isAbsolute(fromData) &&
          fromData !== ".." &&
          !fromData.startsWith(`..${sep}`))
      )
        throw new Error("PANEL_LOG_DIR must be outside PANEL_DATA_DIR");
    }
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.file = join(this.directory, "logs.sqlite");
    this.connection = new Connection(this.file);
    this.connection.migrate(LOG_MIGRATIONS, "log");
    this.counts = { requests: 0, audit: 0, system: 0 };
    for (const row of this.connection.all(
      "SELECT channel, COUNT(*) AS total FROM logs GROUP BY channel",
    ))
      if (row.channel in this.counts) this.counts[row.channel] = row.total;
  }

  get db() {
    return this.connection;
  }

  insert(record) {
    const channel = logChannel(record);
    this.connection.run(
      `INSERT INTO logs (id, channel, at, kind, status, account_id, search, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      record.id,
      channel,
      record.at,
      String(record.kind ?? ""),
      Number.isFinite(record.status) ? record.status : null,
      typeof record.accountId === "string" ? record.accountId : null,
      searchText(record),
      JSON.stringify(record),
    );
    this.counts[channel] = (this.counts[channel] || 0) + 1;
    if (this.counts[channel] > LOG_RETENTION + TRIM_SLACK) this.trim(channel);
  }

  trim(channel) {
    this.connection.run(
      `DELETE FROM logs WHERE channel = ? AND seq <= (
         SELECT seq FROM logs WHERE channel = ? ORDER BY seq DESC LIMIT 1 OFFSET ?
       )`,
      channel,
      channel,
      LOG_RETENTION,
    );
    this.counts[channel] = this.connection.get(
      "SELECT COUNT(*) AS total FROM logs WHERE channel = ?",
      channel,
    ).total;
  }

  /** Append one entry, filling in the id and timestamp when absent. */
  append(entry) {
    const record = {
      ...entry,
      id: typeof entry.id === "string" && entry.id ? entry.id : randomUUID(),
      at:
        typeof entry.at === "string" && entry.at
          ? entry.at
          : new Date().toISOString(),
    };
    this.connection.transaction(() => this.insert(record));
    return record;
  }

  /** Replace the whole log set; used by imports and fixtures, not the hot path. */
  replace(entries) {
    this.connection.transaction(() => {
      this.connection.exec("DELETE FROM logs");
      this.counts = { requests: 0, audit: 0, system: 0 };
      // Newest first in the input means newest first in the sequence.
      for (const entry of [...entries].reverse()) this.insert(entry);
    });
  }

  window(channel) {
    return `WITH window AS (
      SELECT seq, kind, status, search, payload FROM logs
      WHERE channel = ? ORDER BY seq DESC LIMIT ${LOG_RETENTION}
    )`;
  }

  page(
    channel,
    { search = "", outcome = "all", kind = "all", limit = 20, offset = 0, all = false } = {},
  ) {
    const filters = [];
    const values = [];
    if (channel === "requests") {
      if (outcome === "success")
        filters.push("COALESCE(status, 0) BETWEEN 200 AND 399");
      else if (outcome === "failure")
        filters.push("COALESCE(status, 0) NOT BETWEEN 200 AND 399");
    } else if (kind !== "all") {
      filters.push("kind = ?");
      values.push(kind);
    }
    if (search) {
      filters.push("instr(search, ?) > 0");
      values.push(search);
    }
    const where = filters.length ? ` WHERE ${filters.join(" AND ")}` : "";
    const window = this.window(channel);
    const total = this.connection.get(
      `${window} SELECT COUNT(*) AS total FROM window${where}`,
      channel,
      ...values,
    ).total;
    const rows = all
      ? this.connection.all(
          `${window} SELECT payload FROM window${where} ORDER BY seq DESC`,
          channel,
          ...values,
        )
      : this.connection.all(
          `${window} SELECT payload FROM window${where} ORDER BY seq DESC LIMIT ? OFFSET ?`,
          channel,
          ...values,
          limit,
          offset,
        );
    return { total, logs: rows.map((row) => summary(parsePayload(row.payload))) };
  }

  /** Newest-first entries across all channels, within the retained window. */
  all() {
    const rows = [];
    for (const channel of ["requests", "audit", "system"])
      rows.push(
        ...this.connection.all(
          `SELECT seq, payload FROM logs WHERE channel = ?
           ORDER BY seq DESC LIMIT ${LOG_RETENTION}`,
          channel,
        ),
      );
    return rows
      .sort((left, right) => right.seq - left.seq)
      .map((row) => parsePayload(row.payload));
  }

  get(id) {
    const row = this.connection.get(
      "SELECT payload FROM logs WHERE id = ?",
      id,
    );
    return row ? parsePayload(row.payload) : null;
  }

  count(channel) {
    return this.connection.get(
      "SELECT COUNT(*) AS total FROM logs WHERE channel = ?",
      channel,
    ).total;
  }

  close() {
    this.connection.close();
  }
}
