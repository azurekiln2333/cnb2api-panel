const actions = {
  "POST /api/session": ["auth.login", "管理密钥登录"],
  "DELETE /api/session": ["auth.logout", "退出登录"],
  "GET /api/auth/oidc/callback": ["auth.sso_login", "SSO 登录"],
  "PATCH /api/auth/settings": ["auth.settings", "修改登录配置"],
  "PATCH /api/settings": ["routing.settings", "修改路由配置"],
  "POST /api/accounts": ["account.create", "添加账号"],
  "POST /api/access/key": ["gateway.key.read", "查看网关密钥"],
  "POST /api/usage/comparison": ["usage.sync", "同步工作区用量"],
};
const accountActions = {
  PATCH: ["account.update", "修改账号"],
  DELETE: ["account.delete", "删除账号"],
  probe: ["account.probe", "手动探活"],
  quota: ["account.quota", "同步组织额度"],
  wake: ["account.wake", "手动唤醒"],
  registration: ["account.token.rotate", "轮换注册密钥"],
  credentials: ["account.credentials.read", "查看账号凭据"],
  pat: ["account.pat.read", "查看个人令牌"],
};

export function auditRequest(req, res, path, store, user) {
  const match =
    /^\/api\/accounts\/([\w-]+)(?:\/(probe|quota|wake|registration|pat|credentials))?$/.exec(
      path,
    );
  const operation =
    actions[`${req.method} ${path}`] ||
    (match &&
      (match[2]
        ? req.method === "POST" && accountActions[match[2]]
        : accountActions[req.method]));
  if (!operation) return;
  const original = match
    ? store.state.accounts.find((account) => account.id === match[1])
    : null;
  const ip = req.socket.remoteAddress || "";
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    const actor = req.auditActor || user;
    const target = req.auditTarget || original;
    const status =
      req.auditStatus || (res.writableFinished ? res.statusCode : 499);
    try {
      store.record({
        kind: "audit",
        action: operation[0],
        status,
        message: `${operation[1]}${status < 400 ? "成功" : "失败"}`,
        accountId: target?.id || null,
        accountName: target?.name || "面板",
        actor: {
          name: actor?.name || "未登录",
          provider: actor?.provider || "anonymous",
          ...(actor?.subject ? { subject: actor.subject } : {}),
        },
        ip,
        method: req.method,
        path,
      });
    } catch {
      console.error(
        "[audit] Failed to persist audit log; check the data directory",
      );
    }
  };
  res.once("finish", record);
  res.once("close", record);
}
