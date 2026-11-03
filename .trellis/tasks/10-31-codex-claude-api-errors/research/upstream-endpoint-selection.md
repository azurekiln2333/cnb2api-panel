# 上游端点选择（chat / ide）设计调研

调研日期：2026-11（只读代码，未访问线上、未使用任何 key）
范围：`D:\My2KProjects\cnb2api-main`（workspace，只读）与 `D:\My2KProjects\cnb2api-panel`（面板）
结论性质：**设计调研**。本文不改任何源码，不猜测任何 URL。

---

## 0. 问题背景

用户事实：

- 10 个账号，`deepseek-v4.1` 总配额约 1570 亿 tokens/账号（合计约 1.57 万亿）。
- New API 统计只有 60–70 亿 tokens。
- 配额已消耗一半。
- 面板「今日 Token 用量」页缓存读写长期为 0。
- 同一 4007 token 前缀，第二次请求有时命中 3840，有时 0 → 缓存不稳定。

待证假设：

> 配额按 credit 扣费；缓存未命中的单价远高于命中；缓存失效导致配额消耗速度远超 token 数。

用户诉求：

> CNB 有 chat 和 ide 两种上游端点，能否在面板里选择？

---

## 1. 现有能力边界

### 1.1 workspace 的上游 URL 是编译期单一常量

| 证据 | 说明 |
|---|---|
| `cnb2api-main/src/config.mjs:22` | `upstreamUrl: ''`，唯一字段 |
| `cnb2api-main/src/config.mjs:27-30` | 非空时取 `process.env.UPSTREAM_OVERRIDE`，否则拼接 `https://api.cnb.cool/${repo}/-/ai/chat/completions` |
| `cnb2api-main/src/config.mjs:40-43` | URL 为空则拒绝启动 |
| `cnb2api-main/src/proxy.mjs:134` | `config.upstreamUrl` 在全仓库**唯一使用点**（`fetch` 目标） |

结论：workspace 侧只有**一个**上游，进程启动时定型，运行期不可改。`UPSTREAM_OVERRIDE` 是给本地 mock 用的测试钩子（`config.mjs:25-26` 注释明确），不是线上选择面。

### 1.2 面板能下发的只有身份类请求头，不能改 URL

面板构造载体：

- `cnb2api-panel/src/pool.mjs:1037-1040` — `headerNames` 取自 `settings.upstreamHeaders`，序列化为 `base64url`。
- `cnb2api-panel/src/pool.mjs:1164-1166` — 以 `x-cnb2api-upstream-headers` 头发送。
- 面板白名单 `cnb2api-panel/src/request-overrides.mjs:19-22` 共 8 项：
  `user-agent`、`accept`、`x-product-code`、`x-ide-name`、`x-ide-type`、`x-ide-version`、`x-agent-intent`、`x-agent-type`。

workspace 解析侧：

- `cnb2api-main/src/proxy.mjs:15-18` — `OVERRIDE_HEADER_NAMES`，与面板 8 项**逐字一致**。
- `cnb2api-main/src/proxy.mjs:24-45` — `parseUpstreamHeaders`：校验 base64url、体积上限 12 KiB（`proxy.mjs:19`）、每个值限 `[\x20-\x7e]{0,512}`（`proxy.mjs:41`）。
- `cnb2api-main/src/proxy.mjs:136` — 覆盖头与 `Authorization: Bearer ${config.upstreamToken}`、`Content-Type` 合并后发往**同一个** `config.upstreamUrl`。

结论：**现有载体只能替换身份头（谁在调用），不能替换端点（调用到哪）。** 二者是正交维度，但当前协议没有后者。

### 1.3 载体协议是「全有或全无」的开关

`proxy.mjs:38` 的 `present: true` 一旦置位，workspace 会连带切换多条行为分支：

- `proxy.mjs:56-61` — `upstreamUsage` 把与覆盖值相同的数值字段清零（防敏感值反射）。
- `proxy.mjs:172-176` — JSON 响应被判为异常，返回 502。
- `proxy.mjs:195` / `211` / `312` — 启用 `OverrideSseFilter`，`j.error` 直接短路为 streamError。
- `proxy.mjs:217` / `324` — 不持久化被反射的 model 值（`observeModel` 跳过）。
- `proxy.mjs:294` / `328` — 日志省略 usage 数值。

含义：任何**新增载体字段**都会自动继承这些限制。若把端点选择塞进同一载体，端点值本身会被当作「敏感值」参与 `upstreamUsage` 的清零匹配（`proxy.mjs:55-58`），必须显式排除，否则可能误清 usage。

### 1.4 身份头与端点语义的现状

`cnb2api-main/src/codebuddy-models.mjs:87` 出现 `'x-product': 'SaaS'`，与面板的 `x-product-code` 不是同一头，且该处走的是模型目录拉取（`codebuddy-models.mjs:73` 拼 `/v3/config`），并非推理端点。

`cnb2api-main/src/auth.mjs` 全文只做 `proxyKey` 恒时比较，与端点无关；`config.upstreamToken`（CNB_TOKEN）只出现在 `proxy.mjs:136` 的 `Authorization`。

结论：**仓库内没有任何 ide 端点的证据**。`api.cnb.cool/<repo>/-/ai/chat/completions` 之外没有第二个 URL 字面量（`config.mjs:29`、`quota.mjs:9` 只有 `https://api.cnb.cool` 基址用于 `/charge/*`）。

---

## 2. 若要支持面板选 chat / ide

### 2.1 核心约束：白名单枚举，绝不接受任意 URL

理由（按风险排序）：

1. **SSRF**：若载体能带任意 URL，面板一旦被攻破或管理凭据泄露，即可让 workspace 以自身网络位置请求内网地址。workspace 运行在 CNB 云内网，可达面远超公网。
2. **CNB_TOKEN 泄露**：`proxy.mjs:136` 无条件把 `Bearer ${config.upstreamToken}` 发给目标。任意 URL ⇒ 任意接收方拿到真实 token。
3. **审计与可解释性**：枚举值可写进日志与请求诊断，任意 URL 不能。

因此设计必须满足：

- 载体字段是**枚举标识**（如 `chat` / `ide`），不是 URL。
- URL 由 workspace 侧从**内置表**解析，面板无法注入路径、host、query。
- 运行时强制 `redirect: 'error'`（现状已是，`proxy.mjs:140`）。
- 解析结果必须通过协议与主机校验后才 `fetch`。

### 2.2 workspace 需新增

**(1) 端点表**

在 `config.mjs` 增加枚举 → URL 的映射表，只含已确认项：

```
ENDPOINTS = {
  chat: <现有 api.cnb.cool/<repo>/-/ai/chat/completions>,
  ide:  <待用户提供，禁止猜测>,
}
```

解析规则：用 `new URL()` 构造并校验 `protocol === 'https:'`、无 `username`/`password`、host 在允许集合内（可复用 `codebuddy-models.mjs:69` 的校验写法）。任何校验失败 → 拒绝该请求，不回落。

**(2) 载体字段**

两条互斥路径，需二选一，不能都做：

- *方案 A（复用现有载体）*：在 `OVERRIDE_HEADER_NAMES` 之外新增独立字段 `endpoint`。
  代价：载体 `present: true` 的全部副作用（§1.3）会一并生效，且需在 `upstreamUsage`（`proxy.mjs:55-58`）里排除 `endpoint` 值参与清零匹配。
- *方案 B（独立头）*：新增 `x-cnb2api-upstream-endpoint`，值限枚举字面量。
  优点：不触发 `present` 开关，正交于身份头，旧 workspace 直接忽略未知头。
  **推荐 B**。

字段校验（两侧同源）：

- 长度 ≤ 16、`^[a-z][a-z0-9-]{0,15}$`、必须在枚举集合内。
- 缺失或未知值 → 使用 `chat`（默认），不得报错中断推理。

**(3) 降级：兼容旧 workspace**

| 面板版本 | workspace 版本 | 期望行为 |
|---|---|---|
| 新（能发 `x-cnb2api-upstream-endpoint`） | 旧（不认识该头） | 旧 workspace 忽略未知头 → 继续走 `chat`。**必须可工作** |
| 新 | 新 | 按选择路由 |
| 旧 | 新 | 缺头 → 默认 `chat` |

落地点：

- 面板侧沿用 `pool.mjs:1176-1180` 已有的 `x-cnb2api-override-support` 能力探测机制，把「是否支持端点选择」作为一项能力上报，UI 对旧 workspace 灰置该项并说明「工作区版本过低」。
- workspace 侧**不得**因未知枚举值让请求失败；未知即回落默认，并记一条 warn 日志（不含敏感值）。

**(4) 面板设置项与 UI**

- `store.mjs` 的 `settings` 新增 `upstreamEndpoint`（枚举，默认 `chat`），校验方式对齐现有 `dshCompat` 的布尔校验风格（`store.mjs` 内 settings 校验段）。
- `src/app.mjs` 的 `/api/settings` PATCH 透传该字段。
- UI：网关设置页新增一个下拉（`chat` / `ide`），旁注「需要工作区版本 ≥ 支持端点选择的版本」。
- 请求诊断：`pool.mjs` 的 diagnostics 增加 `endpoint`（枚举字面量，非 URL），与现有 `headers.attempts` 并列。

**(5) 多账号场景**

用户的 10 个账号若**混合**了不同端点支持能力，端点选择应作为**账号属性**而非全局设置，否则一个不支持的账号会让整条路由失败。建议：

- 短期：全局设置 + 能力探测拦截（不支持的账号在选路时跳过）。
- 长期：账号级覆盖 + 全局默认，`select()` 只挑支持的账号。

### 2.3 缓存与计费的差异（不可假设）

已知事实：

- workspace 记录 `credit`、`cache_hit`、`cache_miss`（`cnb2api-main/src/usage.mjs:8,12-19`），来源是上游 `usage` 的 `credit` 与 `prompt_cache_hit_tokens` / `prompt_tokens_details.cached_tokens`（`usage.mjs:23-33`）。
- 面板已能对账：`/api/usage/comparison`（`cnb2api-panel/src/app.mjs` 中该路由），`worker-usage.mjs:18-19` 把 `credit`、`cache_hit`、`cache_miss` 纳入字段表，`worker-usage.mjs:42-43` 计算 `credit`/`cacheHit`/`cacheMiss` 的差值，`worker-usage.mjs:67` 以 `supportsCredit` 标记工作区是否上报。
- 配额侧 `credit_in_milli` 来自 `api.cnb.cool/<org>/-/charge/quota`（`cnb2api-main/src/quota.mjs:5,9,16`），与推理 usage 的 `credit` 是**不同来源**。

**能说的**：面板已具备把「credit 消耗」与「token 数」并排比较的能力，前提是 workspace 上报 `credit`（`supportsCredit`）。

**不能说的**：ide 端点与 chat 端点的缓存命中率、单价、credit 折算是否存在差异，**当前无任何代码或配置证据**。这属于必须实测的参数，不能写进设计假设。

建议的验证路径（不影响本次设计）：

1. 用同一 4007 token 前缀各发两次，分别在两个端点，读 `/usage` 的 `cache_hit`/`cache_miss`/`credit` 增量。
2. 用 `/charge/volume` 的 `credit_in_milli.used` 增量交叉核对。
3. 只有拿到两组数字，才能判断"缓存失效导致配额烧快"这一假设，以及端点切换是否改善。

---

## 3. 需要用户提供的信息清单

**无这些信息无法推进实现**，且禁止用推测值填空：

1. **ide 端点的确切 URL**
   - 完整 host + 路径（是否同样是 `https://api.cnb.cool/<repo>/-/ai/...` 下的另一个路径？）
   - 是否需要 query 参数
   - 是否与 repo slug 相关（`config.repo`），还是全局固定

2. **ide 端点必须的请求头**
   - 除现有 8 项身份头外，是否有额外必填头（例如独立的产品码、IDE 类型、版本）
   - 各头的**确切取值**，或取值规则（例如是否等同 `x-ide-type`）

3. **ide 端点与 chat 端点的协议差异**
   - 请求/响应是否同构（OpenAI chat.completions 形状）
   - 流式是否同样以 `data: [DONE]` 结束
   - `usage` 字段名是否一致（尤其 `credit`、`prompt_cache_hit_tokens`）
   - 是否支持 Anthropic `/v1/messages` 语义的请求

4. **端点与配额/计费的关系**
   - 两个端点是否共用同一 `credit` 池
   - `credit` 折算单价是否相同

5. **用户如何得知「CNB 有 chat 和 ide 两种端点」**
   - 来源（官方文档链接 / 控制台界面 / 抓包）
   - 若来自抓包，请提供**脱敏**后的请求行与头名列表（不含 token 值）

6. **当前 10 个账号的端点支持情况**
   - 是否全部为同一版本 workspace
   - 是否存在账号级差异（影响 §2.2(5) 的方案选择）

---

## 4. 建议的推进顺序

1. 先答 §3 的 1–3（缺 URL 与头就无法写任何代码）。
2. 用 `/api/usage/comparison` 与 `/charge/volume` 做一次**双端点 A/B 实测**，得到 cache_hit / cache_miss / credit 三组增量（这是验证用户假设的唯一途径，且不改代码）。
3. 若实测显示 ide 端点缓存命中显著更好，再进入实现：workspace 端点表 + 独立头（方案 B）+ 面板枚举设置 + 能力探测降级。
4. 实现前须补一份 `.trellis/spec/backend/` 的端点选择契约，明确「枚举白名单、缺失回落 chat、旧 workspace 忽略未知头」三条不变量。

---

## 5. 本次调研的边界声明

- 未访问线上环境，未使用任何 token 或 key。
- 未修改 `cnb2api-main` 或 `cnb2api-panel` 的任何源码。
- 未猜测 ide 端点 URL；§3 列出的信息缺失时，任何实现都是假设。
- 用户关于"缓存失效烧配额"的假设**尚未被证实**：面板与 workspace 已具备观测能力（`credit`、`cache_hit`、`cache_miss`），但尚无实测数据。
