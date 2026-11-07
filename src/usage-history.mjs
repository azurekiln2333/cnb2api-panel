import { addTokenUsage, emptyTokenUsage } from "./token-usage.mjs";

// The daily rollup keeps per-day history after the 30-day hourly window closes.
// Dates use the UTC+8 boundary of the overview so both views agree.
export const DAILY_RETENTION_DAYS = 400;
export const HISTORY_DAYS = [7, 30, 90, 365];
const DAY_MS = 86_400_000;
const UTC8_OFFSET_MS = 8 * 3_600_000;

// Store.commit() clones and serializes the whole state on every request, so
// the rollup packs token counters into short strings of base-36 numbers joined
// by ":". Most slots are differences that stay zero for fully measured
// traffic, and trailing zeros are dropped:
//   input:output:cacheRead:cacheWrite:missing:extraAttempts:partial:
//   readGap:writeGap:totalGap
// `extraAttempts` counts measured attempts beyond the owning request count, so
// a request without retries adds nothing. `readGap`/`writeGap` count reported
// attempts without a cache counter. `totalGap` is total - input - output.
const count = (value) => (Number.isSafeInteger(value) ? value : 0);
const decode = (text) =>
  typeof text === "string" && text
    ? text.split(":").map((part) => count(parseInt(part, 36)))
    : [];

/** Pack counters measured over `requests` requests; `""` means no usage. */
export function packTokenUsage(usage, requests = 0) {
  const value = (key) => count(usage?.[key]);
  const reported = value("reportedRequests");
  const values = [
    value("input"),
    value("output"),
    value("cacheRead"),
    value("cacheWrite"),
    value("missingRequests"),
    reported + value("missingRequests") - requests,
    value("partialRequests"),
    reported - value("cacheReadReported"),
    reported - value("cacheWriteReported"),
    value("total") - value("input") - value("output"),
  ];
  while (values.length && values.at(-1) === 0) values.pop();
  return values.map((item) => item.toString(36)).join(":");
}

/** Inverse of packTokenUsage for the same request count. */
export function unpackTokenUsage(text, requests = 0) {
  const [
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    missing = 0,
    extraAttempts = 0,
    partial = 0,
    readGap = 0,
    writeGap = 0,
    totalGap = 0,
  ] = decode(text);
  const reported = requests + extraAttempts - missing;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + totalGap,
    reportedRequests: reported,
    missingRequests: missing,
    partialRequests: partial,
    cacheReadReported: reported - readGap,
    cacheWriteReported: reported - writeGap,
  };
}

/** UTC+8 calendar date (`YYYY-MM-DD`) for a timestamp. */
export const usageDate = (at) =>
  new Date(at + UTC8_OFFSET_MS).toISOString().slice(0, 10);

export const emptyDaily = () => ({ accounts: [], days: {} });

// Tokens belong to the accounts that produced them. A retried request keeps
// each attempt's own measurement instead of charging the final account.
function usageShares(entry) {
  if (Array.isArray(entry.usageAttempts))
    return entry.usageAttempts.filter((a) => a.accountId && a.tokenUsage);
  return entry.accountId
    ? [{ accountId: entry.accountId, tokenUsage: entry.tokenUsage }]
    : [];
}

/** Add a request's per-account tokens to an hourly bucket that tracks them. */
export function addBucketAccountTokens(bucket, entry) {
  // Buckets written before this field existed keep an unknown split.
  if (!bucket.accountTokens || !entry.tokenUsage) return;
  for (const share of usageShares(entry)) {
    const usage = unpackTokenUsage(bucket.accountTokens[share.accountId]);
    addTokenUsage(usage, share.tokenUsage);
    bucket.accountTokens[share.accountId] = packTokenUsage(usage);
  }
}

// A day lists its accounts as one string of rows joined by ",". Each row is
// `index:requests:tokens` in the same base-36 form, with tokens packed against
// the row's request count. Account ids live once in `daily.accounts`, so 400
// days of UUID keys stay out of the document.
function readRows(text) {
  const rows = new Map();
  for (const part of typeof text === "string" && text ? text.split(",") : []) {
    const [index = 0, requests = 0] = decode(part);
    const tokens = part.split(":").slice(2).join(":");
    rows.set(index, { requests, usage: unpackTokenUsage(tokens, requests) });
  }
  return rows;
}

function writeRows(rows) {
  return [...rows]
    .map(([index, row]) =>
      [
        index.toString(36),
        row.requests.toString(36),
        packTokenUsage(row.usage, row.requests),
      ]
        .filter(Boolean)
        .join(":"),
    )
    .join(",");
}

function updateRows(daily, day, changes) {
  const rows = readRows(day.accounts);
  for (const [accountId, change] of changes) {
    let index = daily.accounts.indexOf(accountId);
    if (index < 0) index = daily.accounts.push(accountId) - 1;
    const row = rows.get(index) ?? { requests: 0, usage: emptyTokenUsage() };
    change(row);
    rows.set(index, row);
  }
  day.accounts = writeRows(rows);
}

// Day totals are packed against the day's request count, so every change to
// that count repacks them.
function updateDay(day, requests, usage) {
  const totals = unpackTokenUsage(day.tokens, day.requests);
  if (usage) addTokenUsage(totals, usage);
  day.requests += requests;
  day.tokens = packTokenUsage(totals, day.requests);
}

// Drop account ids that no retained day references and renumber the rows.
function compactAccounts(daily) {
  const days = Object.values(daily.days).map((day) => [day, readRows(day.accounts)]);
  const used = new Set(days.flatMap(([, rows]) => [...rows.keys()]));
  const remap = new Map();
  const accounts = [];
  daily.accounts.forEach((id, index) => {
    if (used.has(index)) remap.set(index, accounts.push(id) - 1);
  });
  for (const [day, rows] of days)
    day.accounts = writeRows([...rows].map(([index, row]) => [remap.get(index), row]));
  daily.accounts = accounts;
}

const newDay = () => ({ requests: 0, tokens: "", accounts: "" });

/** Fold one recorded request into the daily rollup. */
export function recordDaily(daily, entry, now) {
  const date = usageDate(now);
  let day = daily.days[date];
  if (!day) {
    // Expire old days once per new day instead of on every request.
    const cutoff = usageDate(now - (DAILY_RETENTION_DAYS - 1) * DAY_MS);
    const expired = Object.keys(daily.days).filter((key) => key < cutoff);
    for (const key of expired) delete daily.days[key];
    if (expired.length) compactAccounts(daily);
    day = daily.days[date] = newDay();
  }
  updateDay(day, 1, entry.tokenUsage);
  if (entry.status >= 400) day.errors = (day.errors || 0) + 1;
  const changes = [];
  // Request counts follow the final account, like the hourly bucket.
  if (entry.accountId) changes.push([entry.accountId, (row) => row.requests++]);
  if (entry.tokenUsage)
    for (const share of usageShares(entry))
      changes.push([share.accountId, (row) => addTokenUsage(row.usage, share.tokenUsage)]);
  if (changes.length) updateRows(daily, day, changes);
}

const isDate = (key) => /^\d{4}-\d{2}-\d{2}$/.test(key);
const text = (value) => (typeof value === "string" ? value : "");

/** Accept a saved rollup, skipping malformed days and unknown account rows. */
export function loadDaily(value) {
  const daily = emptyDaily();
  if (!value || typeof value !== "object" || Array.isArray(value)) return daily;
  if (Array.isArray(value.accounts)) daily.accounts = value.accounts.map(text);
  const days = value.days && typeof value.days === "object" ? value.days : {};
  for (const [date, day] of Object.entries(days)) {
    if (!isDate(date) || !day || typeof day !== "object") continue;
    const rows = readRows(day.accounts);
    for (const index of rows.keys())
      if (index < 0 || index >= daily.accounts.length) rows.delete(index);
    daily.days[date] = {
      requests: count(day.requests),
      ...(count(day.errors) ? { errors: count(day.errors) } : {}),
      tokens: text(day.tokens),
      accounts: writeRows(rows),
      ...(day.partial === true ? { partial: true } : {}),
    };
  }
  return daily;
}

/**
 * Rebuild the rollup from hourly buckets for documents saved before it
 * existed. Buckets without `accountTokens` cannot restore the per-account
 * token split, so their days carry `partial: true`.
 */
export function backfillDaily(hourly) {
  const daily = emptyDaily();
  for (const bucket of hourly) {
    const at = Date.parse(bucket.at);
    if (!Number.isFinite(at)) continue;
    const date = usageDate(at);
    const day = (daily.days[date] ??= newDay());
    updateDay(day, count(bucket.requests), bucket.tokenUsage);
    if (count(bucket.errors)) day.errors = (day.errors || 0) + count(bucket.errors);
    const changes = Object.entries(bucket.accounts || {}).map(([id, requests]) => [
      id,
      (row) => {
        row.requests += count(requests);
      },
    ]);
    if (bucket.accountTokens && typeof bucket.accountTokens === "object")
      for (const [id, tokens] of Object.entries(bucket.accountTokens))
        changes.push([id, (row) => addTokenUsage(row.usage, unpackTokenUsage(tokens))]);
    else day.partial = true;
    updateRows(daily, day, changes);
  }
  return daily;
}

/** Daily rows for the last `days` UTC+8 days, zero-filled and oldest first. */
export function usageHistory(state, days, now = Date.now()) {
  const todayStart =
    Math.floor((now + UTC8_OFFSET_MS) / DAY_MS) * DAY_MS - UTC8_OFFSET_MS;
  const daily = state.daily || emptyDaily();
  const totals = {
    requests: 0,
    errors: 0,
    tokenUsage: emptyTokenUsage(),
    partial: false,
  };
  const perAccount = new Map();
  const rows = Array.from({ length: days }, (_, index) => {
    const date = usageDate(todayStart - (days - index - 1) * DAY_MS);
    const day = daily.days[date];
    const row = {
      date,
      requests: day?.requests || 0,
      errors: day?.errors || 0,
      tokenUsage: unpackTokenUsage(day?.tokens, day?.requests || 0),
      partial: day?.partial === true,
    };
    if (!day) return row;
    totals.requests += row.requests;
    totals.errors += row.errors;
    addTokenUsage(totals.tokenUsage, row.tokenUsage);
    if (row.partial) totals.partial = true;
    for (const [accountIndex, account] of readRows(day.accounts)) {
      const accountId = daily.accounts[accountIndex];
      let owner = perAccount.get(accountId);
      if (!owner) {
        owner = {
          accountId,
          requests: 0,
          tokenUsage: emptyTokenUsage(),
          partial: false,
        };
        perAccount.set(accountId, owner);
      }
      owner.requests += account.requests;
      addTokenUsage(owner.tokenUsage, account.usage);
      // A backfilled day has no complete per-account token split.
      if (row.partial) owner.partial = true;
    }
    return row;
  });
  const names = new Map(state.accounts.map((a) => [a.id, a.name]));
  const accounts = [...perAccount.values()]
    .map((entry) => ({ ...entry, name: names.get(entry.accountId) || "" }))
    .sort(
      (a, b) => b.tokenUsage.total - a.tokenUsage.total || b.requests - a.requests,
    );
  return {
    range: { days, from: rows[0].date, to: rows.at(-1).date },
    days: rows,
    accounts,
    totals,
  };
}
