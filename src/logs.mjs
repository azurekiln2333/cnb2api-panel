const QUERY_FIELDS = ["limit", "offset", "q", "outcome", "kind"];
const integer = (value, fallback, minimum, maximum) => {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
    : fallback;
};

/**
 * Turn query parameters into a log page. Filtering, ordering and retention all
 * happen inside the log database, so only the requested page is parsed.
 */
export function queryLogs(logs, channel, parameters) {
  const search = (parameters.get("q") || "").toLowerCase();
  const outcome = parameters.get("outcome") || "all";
  const kind = parameters.get("kind") || "all";
  const download = parameters.get("download") === "1";
  const paginated = QUERY_FIELDS.some((field) => parameters.has(field));
  const limit = integer(parameters.get("limit"), 20, 1, 100);
  const offset = integer(
    parameters.get("offset"),
    0,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const page = logs.page(channel, {
    search,
    outcome,
    kind,
    limit,
    offset,
    all: download || !paginated,
  });
  return {
    logs: page.logs,
    total: page.total,
    limit,
    offset,
    download,
    paginated,
  };
}
