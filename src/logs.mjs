import { logChannel } from "./file-storage.mjs";

const QUERY_FIELDS = ["limit", "offset", "q", "outcome", "kind"];
const integer = (value, fallback, minimum, maximum) => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
    : fallback;
};
const summary = ({ requestDiagnostics, ...entry }) => entry;

export function queryLogs(entries, channel, parameters) {
  const search = (parameters.get("q") || "").toLowerCase();
  const outcome = parameters.get("outcome") || "all";
  const kind = parameters.get("kind") || "all";
  const matching = entries.filter((entry) => {
    if (logChannel(entry) !== channel) return false;
    if (channel === "requests") {
      const successful = entry.status >= 200 && entry.status < 400;
      if (outcome === "success" && !successful) return false;
      if (outcome === "failure" && successful) return false;
    } else if (kind !== "all" && entry.kind !== kind) return false;
    return (
      !search ||
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
        .toLowerCase()
        .includes(search)
    );
  });
  const download = parameters.get("download") === "1";
  const paginated = QUERY_FIELDS.some((field) => parameters.has(field));
  const limit = integer(parameters.get("limit"), 20, 1, 100);
  const offset = integer(
    parameters.get("offset"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const selected =
    download || !paginated ? matching : matching.slice(offset, offset + limit);
  return {
    logs: selected.map(summary),
    total: matching.length,
    limit,
    offset,
    download,
    paginated,
  };
}
