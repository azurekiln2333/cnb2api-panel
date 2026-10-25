import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const LOG_FILES = {
  requests: "requests.log",
  audit: "audit.log",
  system: "system.log",
};
export const logChannel = (entry) =>
  entry.kind === "request"
    ? "requests"
    : ["account", "audit"].includes(entry.kind)
      ? "audit"
      : "system";
const ALLOWED = new Set([
  "panel.json",
  "accounts.json",
  "stats.json",
  ...Object.values(LOG_FILES),
]);
export const retainLogs = (entries) => {
  const counts = { requests: 0, audit: 0, system: 0 };
  return entries.filter((entry) => ++counts[logChannel(entry)] <= 1000);
};

// A durable intent makes multi-file changes recoverable after a process stops.
// Only encrypted account/SSO documents may be passed to this layer.
export class FileStorage {
  constructor(directory, logDirectory = resolve(directory, "../logs")) {
    this.directory = resolve(directory);
    this.logDirectory = resolve(logDirectory);
    const logRelative = relative(this.directory, this.logDirectory);
    if (
      !logRelative ||
      (!isAbsolute(logRelative) &&
        logRelative !== ".." &&
        !logRelative.startsWith(`..${sep}`))
    )
      throw new Error("PANEL_LOG_DIR must be outside PANEL_DATA_DIR");
    mkdirSync(this.logDirectory, { recursive: true, mode: 0o700 });
    this.pending = join(this.directory, "store.pending");
    this.migrateLogs();
    this.recover();
  }

  path(name) {
    return join(
      Object.values(LOG_FILES).includes(name)
        ? this.logDirectory
        : this.directory,
      name,
    );
  }

  // Copy through the destination filesystem so separate Docker bind mounts work.
  // Matching duplicates mean a previous copy completed before source cleanup.
  migrateLogs() {
    const copies = Object.values(LOG_FILES).flatMap((name) => {
      const source = join(this.directory, name);
      if (!existsSync(source)) return [];
      const bytes = readFileSync(source);
      const target = this.path(name);
      if (existsSync(target) && !readFileSync(target).equals(bytes))
        throw new Error(
          `Cannot migrate ${name}: destination already has different logs`,
        );
      return [{ name, source, bytes }];
    });
    for (const { name, source, bytes } of copies) {
      if (!existsSync(this.path(name))) this.atomic(name, bytes);
      unlinkSync(source);
    }
  }

  atomic(name, text) {
    const file = this.path(name);
    writeFileSync(`${file}.tmp`, text, { mode: 0o600, flush: true });
    renameSync(`${file}.tmp`, file);
  }

  apply(operations) {
    for (const operation of operations) {
      if (
        !ALLOWED.has(operation.file) ||
        typeof operation.text !== "string" ||
        !["replace", "append"].includes(operation.type)
      )
        throw new Error(
          "Invalid pending storage operation; restore the data backup",
        );
      if (operation.type === "replace") {
        this.atomic(operation.file, operation.text);
        continue;
      }
      if (
        !Object.values(LOG_FILES).includes(operation.file) ||
        !Number.isSafeInteger(operation.offset) ||
        operation.offset < 0
      )
        throw new Error("Invalid pending log append");
      const file = this.path(operation.file);
      const size = existsSync(file) ? statSync(file).size : 0;
      const bytes = Buffer.from(operation.text, "utf8");
      if (size < operation.offset || size > operation.offset + bytes.length)
        throw new Error(
          `Cannot recover ${operation.file}: unexpected file size`,
        );
      if (size > operation.offset) {
        const tail = readFileSync(file).subarray(operation.offset);
        if (!tail.equals(bytes.subarray(0, tail.length)))
          throw new Error(`Cannot recover ${operation.file}: content changed`);
        if (tail.length === bytes.length) continue;
        truncateSync(file, operation.offset);
      }
      appendFileSync(file, bytes, { mode: 0o600, flush: true });
    }
  }

  recover() {
    if (!existsSync(this.pending)) return;
    const transaction = JSON.parse(readFileSync(this.pending, "utf8"));
    if (transaction.version !== 1 || !Array.isArray(transaction.operations))
      throw new Error("Invalid pending storage transaction");
    this.apply(transaction.operations);
    unlinkSync(this.pending);
  }

  write(operations) {
    if (!operations.length) return;
    if (existsSync(this.pending))
      throw new Error(
        "A storage transaction is pending; restart the panel to recover it",
      );
    this.atomic("store.pending", JSON.stringify({ version: 1, operations }));
    this.apply(operations);
    unlinkSync(this.pending);
  }

  readLog(channel) {
    const name = LOG_FILES[channel];
    const file = this.path(name);
    if (!existsSync(file)) return { entries: [], lines: 0 };
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
    const entries = lines.map((line, index) => {
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        throw new Error(`Invalid ${name} at line ${index + 1}`);
      }
      if (
        !entry ||
        typeof entry.id !== "string" ||
        typeof entry.at !== "string" ||
        typeof entry.kind !== "string" ||
        logChannel(entry) !== channel
      )
        throw new Error(
          `Invalid event category in ${name} at line ${index + 1}`,
        );
      return entry;
    });
    return { entries: entries.slice(-1000).reverse(), lines: lines.length };
  }
}
