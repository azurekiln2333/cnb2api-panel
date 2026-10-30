export const DEFAULT_QUOTA_PROTECTION = Object.freeze({
  enabled: true,
  thresholdPercent: 10,
});

export function validateQuotaProtection(input = DEFAULT_QUOTA_PROTECTION, previous = DEFAULT_QUOTA_PROTECTION) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("额度保护配置格式无效");
  const policy = { ...DEFAULT_QUOTA_PROTECTION, ...previous, ...input };
  if (typeof policy.enabled !== "boolean")
    throw new Error("额度保护开关须为布尔值");
  if (!Number.isInteger(policy.thresholdPercent) ||
      policy.thresholdPercent < 1 || policy.thresholdPercent > 100)
    throw new Error("额度保护阈值须为 1 至 100 的整数");
  return { enabled: policy.enabled, thresholdPercent: policy.thresholdPercent };
}

export function quotaCreditValues(quota) {
  const credits = quota?.credits;
  if (!credits || ![credits.total, credits.used, credits.freeze].every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  )) return null;
  const remaining = Math.max(0, credits.total - credits.used - credits.freeze);
  const remainingPercent = credits.total > 0
    ? Math.min(100, remaining / credits.total * 100) : 0;
  return { remaining, remainingPercent };
}

export function quotaProtectionFor(account, settings) {
  const policy = settings?.quotaProtection || DEFAULT_QUOTA_PROTECTION;
  const values = quotaCreditValues(account.quota);
  const org = account.repo?.split("/")[0];
  const validSnapshot = Boolean(values && org && account.quota.org === org &&
    Number.isFinite(Date.parse(account.quota.syncedAt)));
  const result = {
    suspended: false,
    reason: null,
    remainingPercent: validSnapshot ? values.remainingPercent : null,
    thresholdPercent: policy.thresholdPercent,
  };
  if (!policy.enabled) return { ...result, reason: "disabled" };
  const verification = account.quotaSync?.status === "syncing"
    ? account.quotaSync.previousStatus : account.quotaSync?.status;
  if (verification === "error")
    return { ...result, suspended: true, reason: "sync-error" };
  if (!account.quota || verification !== "ok")
    return { ...result, suspended: true, reason: "unknown" };
  if (!validSnapshot)
    return { ...result, suspended: true, reason: "invalid" };
  // Percentage arithmetic can land a few ulps below an exact threshold.
  const thresholdTolerance = Number.EPSILON * 100 * 4;
  if (values.remainingPercent < policy.thresholdPercent - thresholdTolerance)
    return { ...result, suspended: true, reason: "low" };
  return result;
}

export function refreshQuotaProtection(state) {
  for (const account of state.accounts)
    account.quotaProtection = quotaProtectionFor(account, state.settings);
}
