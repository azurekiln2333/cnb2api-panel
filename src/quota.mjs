// CNB quota reporting: pull the org's charge quota + usage and render it for a
// terminal. Zero dependencies — native fetch + ANSI escapes only.
//
// Data model (CNB charge API, values are cumulative for the billing period):
//   GET /{org}/-/charge/quota   → allowances  (…_in_sec.total / .free, credit_in_milli.total/free)
//   GET /{org}/-/charge/volume  → consumption (…_in_sec used, credit_in_milli used, freeze_* in-flight)
// Units: *_in_milli ÷ 1000 = credits; *_in_sec ÷ 3600 = core-hours.

const CNB_API = 'https://api.cnb.cool';

const QUOTA_ERROR_CODES = new Set([
  'quota_upstream_http', 'quota_timeout', 'quota_network',
  'quota_invalid_json', 'quota_invalid_response',
]);
const CREDIT_FIELDS = new Set([
  'credit_in_milli.total', 'credit_in_milli', 'freeze_credit_in_milli',
]);

// Keep upstream status and known response fields without retaining response
// bodies, organization URLs, tokens or arbitrary network exception messages.
export class QuotaError extends Error {
  constructor(code, { resource, status, field } = {}) {
    const safeCode = QUOTA_ERROR_CODES.has(code) ? code : 'quota_invalid_response';
    const safeResource = resource === 'quota' || resource === 'volume' ? resource : undefined;
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
    const safeField = CREDIT_FIELDS.has(field) ? field : undefined;
    const target = safeResource || 'response';
    const hint = safeStatus === 401 || safeStatus === 403
      ? ' (check CNB_TOKEN and organization permissions)'
      : safeStatus === 404 ? ' (check the org slug)' : '';
    const messages = {
      quota_upstream_http: `CNB charge ${target} returned HTTP ${safeStatus || 'error'}${hint}`,
      quota_timeout: `CNB charge ${target} request timed out`,
      quota_network: `CNB charge ${target} request failed`,
      quota_invalid_json: `CNB charge ${target} returned invalid JSON`,
      quota_invalid_response: `invalid credit quota response${safeField ? `: ${safeField}` : ''}`,
    };
    super(messages[safeCode]);
    this.name = 'QuotaError';
    this.code = safeCode;
    if (safeResource) this.resource = safeResource;
    if (safeStatus) this.status = safeStatus;
    if (safeField) this.field = safeField;
  }
}

// The management API persists this projection even if a reverse proxy replaces
// its HTTP error response. Never derive public text from arbitrary error text.
export function quotaFailure(error) {
  const fallback = {
    code: 'quota_sync_failed',
    message: '额度同步失败，请检查令牌权限和面板网络连接',
    status: 502,
  };
  if (!(error instanceof QuotaError) || !QUOTA_ERROR_CODES.has(error.code)) return fallback;
  const resource = error.resource === 'quota' ? '额度上限' : error.resource === 'volume' ? '额度用量' : '额度';
  const field = {
    'credit_in_milli.total': '总额度',
    credit_in_milli: '已用额度',
    freeze_credit_in_milli: '冻结额度',
  }[error.field];
  let message;
  switch (error.code) {
    case 'quota_upstream_http': {
      const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599
        ? ` HTTP ${error.status}` : '错误状态';
      const hint = error.status === 401 || error.status === 403
        ? '，请检查令牌权限' : error.status === 404 ? '，请检查组织路径' : '';
      message = `额度同步失败：CNB ${resource}接口返回${status}${hint}`;
      break;
    }
    case 'quota_timeout': message = `额度同步失败：请求 CNB ${resource}接口超时`; break;
    case 'quota_network': message = `额度同步失败：面板无法连接 CNB ${resource}接口`; break;
    case 'quota_invalid_json': message = `额度同步失败：CNB ${resource}接口返回非 JSON 数据`; break;
    case 'quota_invalid_response': message = `额度同步失败：CNB ${field || resource}数据缺失或无效`; break;
  }
  return { code: error.code, message, status: error.code === 'quota_timeout' ? 504 : 502 };
}

// ---- fetch --------------------------------------------------------------

// Read one charge sub-resource. Returns parsed JSON or throws a message that is
// already human-readable (no stack noise) — the CLI prints it verbatim.
async function getCharge(base, org, token, kind, timeoutMs) {
  const url = `${base}/${org}/-/charge/${kind}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let r;
  try {
    r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal,
    });
  } catch {
    throw new QuotaError(signal.aborted ? 'quota_timeout' : 'quota_network', { resource: kind });
  }
  if (!r.ok) {
    r.body?.cancel().catch(() => {});
    throw new QuotaError('quota_upstream_http', { resource: kind, status: r.status });
  }
  try {
    return await r.json();
  } catch (error) {
    const code = signal.aborted ? 'quota_timeout'
      : error instanceof SyntaxError ? 'quota_invalid_json' : 'quota_network';
    throw new QuotaError(code, { resource: kind });
  }
}

// Fetch both endpoints concurrently and fold them into a flat, unit-normalized
// snapshot. Tests can override base to use an isolated local HTTP server.
export async function fetchQuota({ org, token, timeoutMs = 15_000, base = CNB_API } = {}) {
  if (!org) throw new Error('org slug is required (CNB_REPO_SLUG=org/repo or --org)');
  if (!token) throw new Error('CNB_TOKEN is required to read charge quota');
  const [quota, volume] = await Promise.all([
    getCharge(base, org, token, 'quota', timeoutMs),
    getCharge(base, org, token, 'volume', timeoutMs),
  ]);
  const creditNumber = (value) =>
    (typeof value === 'number' || typeof value === 'string' && value.trim()) &&
    Number.isFinite(Number(value)) && Number(value) >= 0;
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(quota) || !object(quota.credit_in_milli) || !creditNumber(quota.credit_in_milli.total))
    throw new QuotaError('quota_invalid_response', { resource: 'quota', field: 'credit_in_milli.total' });
  if (!object(volume) || !creditNumber(volume.credit_in_milli))
    throw new QuotaError('quota_invalid_response', { resource: 'volume', field: 'credit_in_milli' });
  // CNB's VolumeUsedResp permits an omitted frozen-Credits field. Only omission
  // represents zero: explicit null, negative and malformed values stay invalid.
  if (Object.hasOwn(volume, 'freeze_credit_in_milli') && !creditNumber(volume.freeze_credit_in_milli))
    throw new QuotaError('quota_invalid_response', { resource: 'volume', field: 'freeze_credit_in_milli' });
  return normalize(org, quota, volume);
}

// ---- normalize ----------------------------------------------------------

const milli = (v) => (Number(v) || 0) / 1000;      // credits
const secH = (v) => (Number(v) || 0) / 3600;       // core-hours

// Build a { org, credits, dev, ci, storage } view. Missing fields degrade to 0
// rather than throwing — CNB may omit a resource an account doesn't have.
export function normalize(org, quota = {}, volume = {}) {
  const q = quota || {};
  const v = volume || {};
  const cq = q.credit_in_milli || {};
  return {
    org,
    credits: {
      total: milli(cq.total),
      used: milli(v.credit_in_milli),
      freeze: milli(v.freeze_credit_in_milli),
    },
    dev: {
      total: secH((q.dev_in_sec || {}).total),
      used: secH(v.dev_in_sec),
      freeze: secH(v.freeze_dev_in_sec),
    },
    ci: {
      total: secH((q.ci_in_sec || {}).total),
      used: secH(v.ci_in_sec),
    },
  };
}

// ---- render -------------------------------------------------------------

const useColor = () => process.stdout.isTTY && process.env.NO_COLOR === undefined;
const paint = (code, s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const dim = (s) => paint('2', s);
const bold = (s) => paint('1', s);
const cyan = (s) => paint('36', s);

// Green under 60%, yellow 60–85%, red above — the usual traffic-light read.
function tone(pct) {
  if (pct >= 85) return '31';
  if (pct >= 60) return '33';
  return '32';
}

// Unicode meter with fractional last cell, so 3% still shows something.
function bar(pct, width = 24) {
  const p = Math.max(0, Math.min(100, pct));
  const full = Math.floor((p / 100) * width);
  const frac = (p / 100) * width - full;
  const partials = ' ▏▎▍▌▋▊▉';
  const head = frac > 0 && full < width ? partials[Math.round(frac * 7)] : '';
  const filled = '█'.repeat(full) + head;
  const track = filled + dim('─'.repeat(Math.max(0, width - filled.length)));
  return paint(tone(p), track);
}

const fmtNum = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

// One resource line: label, bar, used/total, percent, right-aligned to line up.
function row(label, used, total, unit, decimals) {
  const pct = total > 0 ? (used / total) * 100 : 0;
  const usedS = fmtNum(used, decimals);
  const totalS = fmtNum(total, decimals);
  const amount = `${usedS} / ${totalS} ${unit}`;
  const pctS = `${pct.toFixed(pct < 10 ? 1 : 0)}%`.padStart(5);
  return `  ${bold(label.padEnd(8))} ${bar(pct)}  ${paint(tone(pct), pctS)}  ${dim(amount)}`;
}

// Full report block. Kept as a pure string builder so tests assert on output.
export function render(snap, { now = new Date() } = {}) {
  const L = [];
  L.push('');
  L.push(`  ${cyan('◆')} ${bold('CNB quota')}  ${dim(snap.org)}`);
  L.push('');
  L.push(row('Credits', snap.credits.used, snap.credits.total, 'cr', 1));
  L.push(row('Dev', snap.dev.used, snap.dev.total, 'core-h', 1));
  if (snap.ci.total > 0) L.push(row('CI', snap.ci.used, snap.ci.total, 'core-h', 1));

  const inflight = [];
  if (snap.credits.freeze > 0) inflight.push(`${fmtNum(snap.credits.freeze, 1)} cr`);
  if (snap.dev.freeze > 0) inflight.push(`${fmtNum(snap.dev.freeze, 1)} core-h`);
  if (inflight.length) {
    L.push('');
    L.push(`  ${dim('in-flight (not yet settled):')} ${inflight.join(', ')}`);
  }

  const remain = snap.credits.total - snap.credits.used;
  L.push('');
  L.push(`  ${dim('remaining credits:')} ${bold(fmtNum(remain, 1))} cr` +
    `   ${dim('as of')} ${dim(now.toISOString().replace('T', ' ').slice(0, 19))} UTC`);
  L.push('');
  return L.join('\n');
}

// Compact one-liner for scripts / prompts: `--json`'s human cousin.
export function renderLine(snap) {
  const remain = snap.credits.total - snap.credits.used;
  const pct = snap.credits.total > 0 ? (snap.credits.used / snap.credits.total) * 100 : 0;
  return `credits ${fmtNum(snap.credits.used, 1)}/${fmtNum(snap.credits.total, 1)} (${pct.toFixed(0)}% used, ${fmtNum(remain, 1)} left) · dev ${fmtNum(snap.dev.used, 1)}/${fmtNum(snap.dev.total, 0)} core-h`;
}
