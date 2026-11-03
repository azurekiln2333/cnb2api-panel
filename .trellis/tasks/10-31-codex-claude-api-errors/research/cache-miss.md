# 缓存不命中：前缀易变与会话打散

## 结论

配额烧得远快于 token 数，主因是上游前缀缓存几乎全部未命中，与计费口径无关。
两条独立缺陷同时存在，任一都足以让命中率接近零。

1. 计费头的随机值留在被缓存前缀里，同一会话每次请求的字节都不同。
2. 会话键不稳定，同一会话被分散到 10 个账号，而缓存按账号隔离。

两者叠加，每次请求都换账号、换前缀，必然按未命中单价扣费。

## 证据

### 1. 计费头只改了名字，没改值

`src/request-overrides.mjs` 的 `CLAUDE_CODE_PHRASES` 原本只有一条规则：

```js
[/x-anthropic-billing-hdr/gi, "x-cc-billing-meta"]
```

它把 token `x-anthropic-billing-hdr` 换成 `x-cc-billing-meta`，值原样保留。
Claude Code 在该头里带每次变化的 `cch=<随机>`，改写后前缀仍每次不同。
旧注释把这个行为当成特性记录了下来，见同文件规则表上方注释里的
“the billing values survive the header-name rewrite”，以及
`test/panel-overrides.test.mjs` 的 `"billing values survive"` 断言。
Workspace 侧 `../cnb2api-main/src/anthropic.mjs:43` 是同一张表，同样保留值，
所以两层代理都没有消除这个易变点。

实测改写管道直调。两个只有 `cch` 不同的请求，改写后 `system` 字节不同，
会话键也不同（`stable? false`）。

### 2. 会话键哈希了含随机值的原文

`src/pool.mjs` 原先用 `semanticPayload` 算会话键，那是改写之前的客户端原文：

```js
const affinityKey = this.store.state.settings.sessionAffinity
  ? sessionKey(req.headers, semanticPayload)
  : null;
```

`sessionKey` 在没有会话标识时回退到“system 加首条 user 内容”哈希，
于是 `cch` 的随机值直接进入哈希输入。
结果同一会话每轮得到不同键，`Pool.select` 每次重新选账号。
缓存按账号隔离，必然未命中。

### 3. `prompt_cache_key` 从未被使用

`src/session-affinity.mjs` 的 `sessionKey` 只认 `x-session-id`、
`x-conversation-id`、`metadata.session_id`、`metadata.conversation_id`
和 `metadata.user_id` 内嵌的会话。
Codex 用 `prompt_cache_key` 标记会话，该字段被完全忽略。
Codex 每轮还会重写 system 提示，包括工具清单与沙箱说明。
回退哈希因此每轮都变，会话被打散。

### 4. 换账号策略会永久打散会话

`src/pool.mjs` 的 `Pool.select` 在绑定账号不再是候选时调用
`this.affinity.forget(affinityKey)`，然后重新绑定。
冷却与 `quotaProtection.suspended` 都会让账号离开候选集。
该保护默认 `enabled: true`、`thresholdPercent: 10`。
额度越紧张，账号越频繁被挂起，会话越频繁迁移。
迁移又让缓存继续未命中，形成正反馈。
这是既有设计，本次不改，但它是缺陷 1、2 的放大器。

## 已修改

- `src/request-overrides.mjs`：计费头规则同时规范化名字与易变值。
  规则只消费 `key=value` 段，头部同一行后续文本保持原字节。
- `src/request-overrides.mjs`：身份句规则覆盖
  `official CLI tool for Claude` 与 `official CLI for Claude` 两种线上变体。
  原先只匹配后者，`tool` 变体会漏改，前缀在两种客户端版本间抖动。
- `src/pool.mjs`：会话键改用改写后的 `forwardedPayload`，让规范化生效。
- `src/session-affinity.mjs`：`sessionKey` 认 `prompt_cache_key`
  与 `metadata.prompt_cache_key`。

## 验证

- `test/request-overrides.test.mjs`：两个不同 `cch` 的 Chat 请求得到
  字节相同的前缀。Messages 数组块路径同样规范化。无值头只改名。
  user 与 assistant 文本不被改动。两种身份措辞收敛到同一前缀。
- `test/panel-cache-affinity.test.mjs`（新增）：3 账号环境下，
  Claude Code 会话 4 轮全部落在同一账号且前缀字节一致。
  转发出去的前缀不含随机计费值。Codex 会话在 system 每轮变化时
  仍靠 `prompt_cache_key` 保持同账号。`SessionAffinity` 的
  绑定保留、释放与过期语义各有覆盖。
- 反证：回退 `src/request-overrides.mjs`、`src/pool.mjs` 与
  `src/session-affinity.mjs` 后，前两条与 Codex 一条分别失败，
  证明测试确实守住修复。
- `npm test`：492/492 通过。

## 未验证

- 线上 `cch` 的实际格式未见。两仓库源码均无 `cch=` 字面量。
  规则按 `key=value` 段设计，以容忍格式差异。上游若换了键名，
  规则仍会消费整段并收敛为固定占位。
- 未对 CNB 上游做任何实测，无线上请求。
- 命中率提升幅度未测，本地无法复现上游缓存计价。
- 缺陷 4 的换账号策略按现状保留。是否需要在冷却期间保留绑定、
  恢复后回归原账号，应作为独立决策处理，本次未改。
