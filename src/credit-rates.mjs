// Credits per token estimate from two independent sources.
//
// Billing (source A): the organization charge volume that quota sync already
// reads, paired with the panel's own token totals for that organization.
// Reported (source B): the cumulative `credit` that new workers publish on
// `/usage`. Both keep small cumulative sample histories. A rate is always the
// delta between the first and last sample inside a window, never an average
// of rates, so a sample that thinning drops never changes the result.
//
// Storage is compact because the whole history is one meta row that is
// rewritten whenever a sample lands. A history is an array of fixed-order number arrays:
// the first sample holds absolute values, every later sample holds the
// difference from the sample before it. Times are Unix seconds. Credits are
// integers: billing in milli-Credits (CNB's own unit), reported credit in
// micro-Credits.

/** Field order of one billing sample. */
export const BILLING_FIELDS = Object.freeze([
  "atSec",
  "usedMilli",
  "freezeMilli",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
]);
/** Field order of one reported sample. */
export const REPORTED_FIELDS = Object.freeze([
  "atSec",
  "creditMicro",
  "prompt",
  "completion",
  "requests",
  "creditCoverage",
]);
const AT = 0;
const [USED, FREEZE, INPUT, OUTPUT] = [1, 2, 3, 4];
const [CREDIT, PROMPT, COMPLETION, REQUESTS, COVERAGE] = [1, 2, 3, 4, 5];

export const CREDIT_WINDOWS = Object.freeze({
  "1h": 3600000,
  "24h": 86400000,
  "7d": 7 * 86400000,
});
export const MIN_RATE_TOKENS = 100_000;
const HOUR = 3600;
const DAY = 86400;
const RETENTION = 7 * DAY;
// Thinning keeps about 60 + 138 + 144 samples; the cap is only a safety net.
export const MAX_SAMPLES = 400;
// An unchanged counter still gets one sample per hour so a window always has
// an end point close to its boundary.
const KEEPALIVE = HOUR;
const MIN_SPLIT_INTERVALS = 12;
const MIN_SPLIT_R2 = 0.8;
const PER_MILLION = 1_000_000;

export const orgOf = (account) =>
  typeof account?.repo === "string" && account.repo ? account.repo.split("/")[0] : "";
const seconds = (iso) => Math.round(Date.parse(iso) / 1000);
const isoOf = (sec) => new Date(sec * 1000).toISOString();
const count = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);

/** Stored (delta) form → absolute samples. Invalid input decodes to []. */
export function decodeHistory(stored, width) {
  if (!Array.isArray(stored)) return [];
  const result = [];
  for (const row of stored) {
    if (!Array.isArray(row) || row.length !== width || !row.every(Number.isSafeInteger)) return [];
    const previous = result.at(-1);
    const sample = previous ? row.map((value, i) => previous[i] + value) : [...row];
    if (sample.some((value) => value < 0) || (previous && sample[AT] < previous[AT])) return [];
    result.push(sample);
  }
  return result;
}

export function encodeHistory(samples) {
  return samples.map((sample, i) =>
    i ? sample.map((value, k) => value - samples[i - 1][k]) : [...sample],
  );
}

// 1 per minute for the last hour, 1 per 10 minutes up to a day, then 1 per hour.
const resolution = (age) => (age <= HOUR ? 60 : age <= DAY ? 600 : HOUR);

function thin(samples, now) {
  if (samples.length < 3) return samples;
  const kept = [samples[0]];
  for (let i = 1; i < samples.length - 1; i++)
    if (samples[i][AT] - kept.at(-1)[AT] >= resolution(now - samples[i][AT])) kept.push(samples[i]);
  kept.push(samples.at(-1));
  return kept;
}

/**
 * Append one absolute sample to absolute samples. `same` decides whether
 * nothing changed since the previous sample; `broken` decides whether the
 * baseline reset. A broken baseline restarts the history with this sample.
 */
export function appendSample(history, sample, { same, broken, reset = false }) {
  const now = sample[AT];
  let samples = history.filter((item) => now - item[AT] <= RETENTION && item[AT] <= now);
  const last = samples.at(-1);
  if (reset || (last && broken(last, sample))) return [sample];
  if (last && same(last, sample) && now - last[AT] < KEEPALIVE) return samples;
  samples = thin([...samples, sample], now);
  return samples.length > MAX_SAMPLES ? samples.slice(-MAX_SAMPLES) : samples;
}

export function orgTokenTotals(accounts, org) {
  const totals = [0, 0, 0, 0];
  for (const account of accounts)
    if (orgOf(account) === org)
      ["input", "output", "cacheRead", "cacheWrite"].forEach((key, i) => {
        totals[i] += count(account.tokenUsage?.[key]);
      });
  return totals;
}

const sameAfterTime = (a, b) => a.every((value, i) => i === AT || value === b[i]);
const decreasedFrom = (a, b, from) => a.some((value, i) => i >= from && b[i] < value);

/** Billing sample after a successful quota sync. Returns the new org history map. */
export function recordBillingSample(state, org, quota, at) {
  const orgs = new Set(state.accounts.map(orgOf).filter(Boolean));
  const histories = Object.fromEntries(
    Object.entries(state.creditHistory || {}).filter(([key]) => orgs.has(key)),
  );
  const sample = [
    seconds(at),
    Math.round(quota.credits.used * 1000),
    Math.round(quota.credits.freeze * 1000),
    ...orgTokenTotals(state.accounts, org),
  ];
  const next = appendSample(decodeHistory(histories[org], BILLING_FIELDS.length), sample, {
    same: sameAfterTime,
    // A billing period reset lowers used Credits; a statistics reset lowers
    // local tokens. Either way the old samples no longer share a baseline.
    broken: (a, b) => b[USED] < a[USED] || decreasedFrom(a, b, INPUT),
  });
  histories[org] = encodeHistory(next);
  return histories;
}

/**
 * Reported sample after a stored worker `/usage` snapshot. The history keeps
 * the worker identity once; any change of it restarts the samples.
 */
export function recordReportedSample(history, snapshot, { at, reset }) {
  const header = {
    bootId: snapshot.bootId,
    supportsCredit: snapshot.support.credit === true,
    coverage: snapshot.coverage.credit !== null && snapshot.coverage.credit !== undefined,
  };
  const sample = [
    seconds(at),
    Math.round(snapshot.counters.credit * PER_MILLION),
    snapshot.counters.prompt,
    snapshot.counters.completion,
    snapshot.counters.requests,
    header.coverage ? snapshot.coverage.credit : 0,
  ];
  const current = loadReportedHistory(history);
  const changed =
    !current ||
    current.bootId !== header.bootId ||
    current.supportsCredit !== header.supportsCredit ||
    current.coverage !== header.coverage;
  const samples = appendSample(
    current ? decodeHistory(current.samples, REPORTED_FIELDS.length) : [],
    sample,
    {
      reset: reset || changed,
      same: sameAfterTime,
      broken: (a, b) => decreasedFrom(a, b, 1),
    },
  );
  return { ...header, samples: encodeHistory(samples) };
}

/** Old state documents have no history. Malformed entries are dropped. */
export function loadCreditHistory(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const result = {};
  for (const [org, stored] of Object.entries(input)) {
    const samples = decodeHistory(stored, BILLING_FIELDS.length);
    if (samples.length) result[org] = encodeHistory(samples.slice(-MAX_SAMPLES));
  }
  return result;
}

export function loadReportedHistory(input) {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.bootId !== "string" ||
    typeof input.supportsCredit !== "boolean" ||
    typeof input.coverage !== "boolean"
  )
    return null;
  const samples = decodeHistory(input.samples, REPORTED_FIELDS.length);
  return samples.length
    ? {
        bootId: input.bootId,
        supportsCredit: input.supportsCredit,
        coverage: input.coverage,
        samples: encodeHistory(samples.slice(-MAX_SAMPLES)),
      }
    : null;
}

const inWindow = (samples, startMs) => samples.filter((sample) => sample[AT] * 1000 >= startMs);
const spent = (sample) => (sample[USED] + sample[FREEZE]) / 1000;
const tokensOf = (sample) => sample[INPUT] + sample[OUTPUT];

/**
 * Non-negative least squares for credits ≈ a·input + b·output with two
 * variables. The unconstrained solution wins when both coefficients are
 * non-negative; otherwise the better single-variable fit, clamped at zero.
 */
export function nnlsSplit(intervals) {
  if (!Array.isArray(intervals) || intervals.length < MIN_SPLIT_INTERVALS) return null;
  let xx = 0, xy = 0, yy = 0, xc = 0, yc = 0, sum = 0;
  for (const { input: x, output: y, credits: c } of intervals) {
    xx += x * x;
    xy += x * y;
    yy += y * y;
    xc += x * c;
    yc += y * c;
    sum += c;
  }
  const residual = (a, b) =>
    intervals.reduce((n, { input, output, credits }) => n + (credits - a * input - b * output) ** 2, 0);
  const candidates = [];
  const det = xx * yy - xy * xy;
  if (det > 1e-9 * xx * yy) {
    const a = (xc * yy - yc * xy) / det;
    const b = (yc * xx - xc * xy) / det;
    if (a >= 0 && b >= 0) candidates.push([a, b]);
  }
  if (xx > 0) candidates.push([Math.max(0, xc / xx), 0]);
  if (yy > 0) candidates.push([0, Math.max(0, yc / yy)]);
  if (!candidates.length) return null;
  let best = null;
  for (const [a, b] of candidates) {
    const error = residual(a, b);
    if (!best || error < best.error) best = { a, b, error };
  }
  const mean = sum / intervals.length;
  const total = intervals.reduce((n, { credits }) => n + (credits - mean) ** 2, 0);
  const r2 = total > 0 ? 1 - best.error / total : best.error < 1e-12 ? 1 : 0;
  return { a: best.a, b: best.b, r2 };
}

/** Billing deltas for one organization's absolute samples from `startMs`. */
export function billingWindow(samples, startMs) {
  const selected = inWindow(samples, startMs);
  if (selected.length < 2) return null;
  const first = selected[0];
  const last = selected.at(-1);
  const intervals = [];
  for (let i = 1; i < selected.length; i++) {
    const input = selected[i][INPUT] - selected[i - 1][INPUT];
    const output = selected[i][OUTPUT] - selected[i - 1][OUTPUT];
    if (input + output > 0)
      intervals.push({ input, output, credits: spent(selected[i]) - spent(selected[i - 1]) });
  }
  return {
    windowStart: isoOf(first[AT]),
    windowEnd: isoOf(last[AT]),
    deltaCredits: spent(last) - spent(first),
    deltaTokens: tokensOf(last) - tokensOf(first),
    intervals,
  };
}

function billingRate(delta) {
  if (!delta || delta.deltaTokens < MIN_RATE_TOKENS || delta.deltaCredits < 0) return null;
  const fit = nnlsSplit(delta.intervals);
  const split = fit && fit.a >= 0 && fit.b >= 0 && fit.r2 >= MIN_SPLIT_R2;
  return {
    rate: (delta.deltaCredits / delta.deltaTokens) * PER_MILLION,
    inputRate: split ? fit.a * PER_MILLION : null,
    outputRate: split ? fit.b * PER_MILLION : null,
    r2: fit ? fit.r2 : null,
  };
}

/** Reported deltas for one account. `null` means the worker never reported credit. */
export function reportedWindow(history, startMs) {
  // Support comes from the newest snapshot, even one older than the window.
  const current = loadReportedHistory(history);
  if (!current || !current.supportsCredit || !current.coverage) return null;
  const all = decodeHistory(current.samples, REPORTED_FIELDS.length);
  const samples = inWindow(all, startMs);
  const first = samples[0] ?? all.at(-1);
  const last = samples.at(-1) ?? all.at(-1);
  return {
    deltaCredit: (last[CREDIT] - first[CREDIT]) / PER_MILLION,
    deltaTokens: last[PROMPT] + last[COMPLETION] - first[PROMPT] - first[COMPLETION],
    deltaRequests: last[REQUESTS] - first[REQUESTS],
    deltaCoverage: last[COVERAGE] - first[COVERAGE],
  };
}

function reportedRate(delta) {
  if (!delta) return { status: "missing", reported: null };
  if (delta.deltaTokens < MIN_RATE_TOKENS) return { status: "insufficient", reported: null };
  if (delta.deltaCoverage <= 0 || delta.deltaCredit < 0) return { status: "missing", reported: null };
  const partial = delta.deltaCoverage < delta.deltaRequests;
  return {
    status: partial ? "partial" : "ok",
    reported: { rate: (delta.deltaCredit / delta.deltaTokens) * PER_MILLION, partial },
  };
}

const deviation = (billing, reported) =>
  billing && reported && billing.rate > 0 ? (reported.rate - billing.rate) / billing.rate : null;

function latestQuota(accounts, org) {
  let latest = null;
  for (const account of accounts)
    if (orgOf(account) === org && account.quota?.credits && (!latest || account.quota.syncedAt > latest.syncedAt))
      latest = account.quota;
  return latest;
}
const remainingOf = (quota) =>
  quota ? Math.max(0, quota.credits.total - quota.credits.used - quota.credits.freeze) : null;
const tokensLeft = (remaining, rate) =>
  remaining === null || !rate || !(rate.rate > 0) ? null : Math.floor((remaining / rate.rate) * PER_MILLION);

function sumDeltas(deltas) {
  const valid = deltas.filter((delta) => delta && delta.deltaCredits >= 0);
  if (!valid.length) return null;
  return {
    windowStart: valid.map((d) => d.windowStart).sort()[0],
    windowEnd: valid.map((d) => d.windowEnd).sort().at(-1),
    deltaCredits: valid.reduce((n, d) => n + d.deltaCredits, 0),
    deltaTokens: valid.reduce((n, d) => n + d.deltaTokens, 0),
    // Samples of different organizations are not aligned; no combined split.
    intervals: [],
  };
}

function sumReported(deltas) {
  const valid = deltas.filter(Boolean);
  if (!valid.length) return null;
  const total = (key) => valid.reduce((n, d) => n + d[key], 0);
  return {
    deltaCredit: total("deltaCredit"),
    deltaTokens: total("deltaTokens"),
    deltaRequests: total("deltaRequests"),
    deltaCoverage: total("deltaCoverage"),
  };
}

const billingStatus = (delta, billing) => (billing ? "ok" : delta ? "insufficient" : "no_data");

/**
 * Per-account rows plus an overall row. The overall row adds the deltas of
 * distinct organizations, so a shared organization is counted once.
 */
export function creditRates(state, { window = "24h", now = Date.now() } = {}) {
  const span = CREDIT_WINDOWS[window];
  if (!span) throw new Error("unsupported credit rate window");
  const accounts = state.accounts;
  const orgCounts = new Map();
  for (const account of accounts) {
    const org = orgOf(account);
    if (org) orgCounts.set(org, (orgCounts.get(org) || 0) + 1);
  }
  const histories = new Map(
    [...orgCounts.keys()].map((org) => [
      org,
      decodeHistory(state.creditHistory?.[org], BILLING_FIELDS.length),
    ]),
  );
  const start = now - span;
  const orgDelta = new Map();
  const orgCapacity = new Map();
  for (const [org, samples] of histories) {
    orgDelta.set(org, billingWindow(samples, start));
    const day = billingRate(billingWindow(samples, now - CREDIT_WINDOWS["24h"]));
    const week = billingRate(billingWindow(samples, now - CREDIT_WINDOWS["7d"]));
    const remaining = remainingOf(latestQuota(accounts, org));
    orgCapacity.set(org, { remaining, tokensLeft: tokensLeft(remaining, day || week) });
  }
  const reportedDeltas = new Map(
    accounts.map((account) => [account.id, reportedWindow(account.creditReportHistory, start)]),
  );
  const rows = accounts.map((account) => {
    const org = orgOf(account);
    const delta = org ? orgDelta.get(org) : null;
    const billing = billingRate(delta);
    const { status: reportedStatus, reported } = reportedRate(reportedDeltas.get(account.id));
    const capacity = org ? orgCapacity.get(org) : null;
    return {
      accountId: account.id,
      accountName: account.name,
      org: org || null,
      sharedOrg: Boolean(org && orgCounts.get(org) > 1),
      windowStart: delta?.windowStart ?? null,
      windowEnd: delta?.windowEnd ?? null,
      deltaCredits: delta?.deltaCredits ?? null,
      deltaTokens: delta?.deltaTokens ?? null,
      billing,
      reported,
      reportedStatus,
      deviation: deviation(billing, reported),
      remainingCredits: capacity?.remaining ?? null,
      tokensLeft: capacity?.tokensLeft ?? null,
      status: billingStatus(delta, billing),
    };
  });
  // The overall row follows the overview Credits card: enabled accounts only.
  const enabledAccounts = accounts.filter((a) => a.enabled);
  const enabledOrgs = [...new Set(enabledAccounts.map(orgOf).filter(Boolean))];
  const overallDelta = sumDeltas(enabledOrgs.map((org) => orgDelta.get(org)));
  const overallBilling = billingRate(overallDelta);
  const overallReported = reportedRate(
    sumReported(enabledAccounts.map((a) => reportedDeltas.get(a.id))),
  );
  const capacityRate = (ms) =>
    billingRate(sumDeltas(enabledOrgs.map((org) => billingWindow(histories.get(org), now - ms))));
  const remainingValues = enabledOrgs
    .map((org) => orgCapacity.get(org).remaining)
    .filter((value) => value !== null);
  const remaining = remainingValues.length ? remainingValues.reduce((n, v) => n + v, 0) : null;
  return {
    window,
    minTokens: MIN_RATE_TOKENS,
    generatedAt: new Date(now).toISOString(),
    accounts: rows,
    overall: {
      organizations: enabledOrgs.length,
      windowStart: overallDelta?.windowStart ?? null,
      windowEnd: overallDelta?.windowEnd ?? null,
      deltaCredits: overallDelta?.deltaCredits ?? null,
      deltaTokens: overallDelta?.deltaTokens ?? null,
      billing: overallBilling,
      reported: overallReported.reported,
      reportedStatus: overallReported.status,
      deviation: deviation(overallBilling, overallReported.reported),
      remainingCredits: remaining,
      tokensLeft: tokensLeft(
        remaining,
        capacityRate(CREDIT_WINDOWS["24h"]) || capacityRate(CREDIT_WINDOWS["7d"]),
      ),
      status: billingStatus(overallDelta, overallBilling),
    },
  };
}
