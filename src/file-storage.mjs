import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

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
  constructor(directory) {
    this.directory = directory;
    this.pending = join(directory, "store.pending");
    this.recover();
  }

  atomic(name, text) {
    const file = join(this.directory, name);
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
      const file = join(this.directory, operation.file);
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
    const file = join(this.directory, name);
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
