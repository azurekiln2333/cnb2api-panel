const routes = new Map([
  ["/v1/quota", "quota"],
  ["/v1/dashboard/billing/subscription", "subscription"],
  ["/dashboard/billing/subscription", "subscription"],
  ["/v1/dashboard/billing/usage", "usage"],
  ["/dashboard/billing/usage", "usage"],
]);

export const gatewayQuotaRoute = (path) => routes.get(path);

const organization = (account) => account.repo.split("/")[0];
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
const unavailable = () => ({
  status: 503,
  body: { error: {
    message: "quota data temporarily unavailable",
    type: "service_unavailable_error",
    code: "quota_unavailable",
  } },
});

function aggregate(accounts) {
  const enabled = accounts.filter((account) => account.enabled);
  if (enabled.some((account) => !organization(account))) return null;
  const organizations = new Set(enabled.map(organization));
  if (!organizations.size) return null;
  const snapshots = new Map();
  for (const account of accounts) {
    const org = organization(account);
    const quota = account.quota;
    if (!organizations.has(org) || quota?.org !== org ||
      ![quota.credits?.total, quota.credits?.used, quota.credits?.freeze].every(nonnegative) ||
      typeof quota.syncedAt !== "string" || !Number.isFinite(Date.parse(quota.syncedAt))) continue;
    const previous = snapshots.get(org);
    if (!previous || Date.parse(quota.syncedAt) > Date.parse(previous.syncedAt)) snapshots.set(org, quota);
  }
  if (snapshots.size !== organizations.size) return null;
  let total = 0;
  let used = 0;
  let frozen = 0;
  let remaining = 0;
  let oldest = Infinity;
  for (const quota of snapshots.values()) {
    total += quota.credits.total;
    used += quota.credits.used;
    frozen += quota.credits.freeze;
    remaining += Math.max(0, quota.credits.total - quota.credits.used - quota.credits.freeze);
    oldest = Math.min(oldest, Date.parse(quota.syncedAt));
  }
  if (![total, used, frozen, remaining].every(nonnegative)) return null;
  return {
    object: "quota", unit: "cnb_credits", total, used, frozen, remaining,
    organizations: organizations.size, syncedAt: new Date(oldest).toISOString(),
  };
}

// Legacy *_usd fields are a numeric CNB-credit mirror, without a currency conversion.
// Date query parameters cannot turn cached current-period snapshots into history.
export function gatewayQuotaResponse(accounts, kind) {
  const quota = aggregate(accounts);
  if (!quota) return unavailable();
  if (kind === "quota") return { status: 200, body: quota };
  const metadata = { unit: quota.unit, period: "current", syncedAt: quota.syncedAt };
  if (kind === "subscription") return { status: 200, body: {
    object: "billing_subscription", has_payment_method: false,
    soft_limit_usd: quota.total, hard_limit_usd: quota.total, system_hard_limit_usd: quota.total,
    ...metadata,
  } };
  const usage = (quota.total - quota.remaining) * 100;
  if (!nonnegative(usage)) return unavailable();
  return { status: 200, body: { object: "list", total_usage: usage, ...metadata } };
}
