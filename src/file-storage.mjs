// Log taxonomy shared by the storage layer, the log API and the tests.
// Runtime log writes never touch files any more: entries go into
// `logs/logs.sqlite` (see db.mjs), and the legacy `*.log` files are left
// exactly as they were found.
export const logChannel = (entry) =>
  entry.kind === "request"
    ? "requests"
    : ["account", "audit"].includes(entry.kind)
      ? "audit"
      : "system";

/** Entries kept per channel; the boundary the API and retention share. */
export const LOG_RETENTION = 1000;
