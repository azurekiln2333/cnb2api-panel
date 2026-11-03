# 隐性消耗盘点

## 结论

面板对 New API 只暴露一部分上游消耗。差额来自两类请求。第一类是面板主动发起但不产生推理的控制面调用。第二类是推理请求中断后上游已计费、面板未记账。

用户实测：10 个账号共约 157B token 额度，New API 只看到 6–7B token，额度却用掉一半。缓存读写页面显示 0。同一段 4007 token 前缀，有时命中 3840，有时命中 0。

## 一、面板发起的上游请求清单

`Pool.forward` 是唯一的推理入口。其余调用都是控制面。

| 位置 | 用途 | 是否推理 | 是否消耗额度 |
| --- | --- | --- | --- |
| `src/pool.mjs:518` | `/v1/models` 探活 | 否 | 否 |
| `src/pool.mjs:882` | 唤醒工作区 | 否 | 否 |
| `src/quota.mjs:89` | 计费查询 | 否 | 否 |
| `src/worker-usage.mjs:168` | `/usage` 对账 | 否 | 否 |
| `src/pool.mjs:1156` | 推理转发 | 是 | 是 |

控制面调用不进 New API 的 token 统计，也不扣额度。差额不来自这里。

## 二、真正的缺口：中断请求已计费、面板未记账

`Pool.forward` 的重试循环原先在每次尝试开始时把 `usageCapture` 置空。上游已经生成并计费的 token 随之中断丢失。三个触发路径：

1. 客户端或中间层超时断开。Cloudflare 524、New API 超时、Codex 空闲都属这一类。
2. 面板空闲看门狗 `idleTimeoutSeconds`（默认 300 秒）中止。
3. 上游流提前结束，没有 `finish_reason`，没有 `[DONE]`。

CNB 侧按已生成 token 计费，面板侧 `tokenUsage` 记 0。New API 看不到这些请求，额度照扣。

同一前缀有时命中 3840、有时命中 0。这个差异来自重试。第一次请求付费生成前缀缓存。重试换了账号或缓存过期，第二次重新付未命中的 prefill。

### 改动

- `src/pool.mjs`：新增 `usageTotals` 与 `foldUsage()`。每次尝试结束先把本次 `usageCapture.finish()` 累加进 `usageTotals`，再开始下一次尝试。请求日志的 `tokenUsage` 是全部尝试之和。中断的尝试保留已测到的 `input`/`output`/`cacheRead`/`cacheWrite`。这些尝试也计入 `partialRequests`。
- `src/token-usage.mjs`：新增 `deriveCacheMiss(usage)`。`cacheMiss = input - cacheRead`。OpenAI 的 `prompt_tokens` 已含命中，Anthropic 的 `input_tokens` 本身就是未命中。`input` 未知时返回 `null`，不伪造 0。
- `src/pool.mjs`：请求日志新增 `cacheMiss`（派生值）与 `streamFailure.usageCaptured`。`streamFailure` 原本已记录中止原因与耗时：`kind`、`stage`、`elapsedMs`、`attemptElapsedMs`、`abortName`/`abortCode`、`bytesRead`、`upstreamStatus`、`bodyComplete`。

日志读法如下。`partialRequests > 0` 表示某次尝试中途断开且已计费。`streamFailure.kind` 给出断开原因，`elapsedMs` 给出耗时。`usageCaptured=false` 且 `upstreamBytes > 0` 表示上游已产出但 usage 未到。这一段不可证。

## 三、Cloudflare 524 线索（只出方案，未改行为）

现象：`newapi.azurekiln.cn` 走 Cloudflare，Proxy Read Timeout 120 秒。非流式 Chat/Messages 在 120 秒内没有首字节就 524。

面板现状：
- SSE 流式已有 10 秒 keep-alive 注释帧（`RESPONSES_KEEPALIVE_MS`），首个上游 token 之前就发第一帧，流式请求不会撞 524。
- 非流式 Chat/Messages 要等上游完整响应才写头。长推理必然超过 120 秒，必然 524。

方案（待评估，未实施）：
1. 非流式请求先写响应头加一个 SSE 心跳，再按原协议收尾。会改变响应头时序，客户端可能不接受。
2. 非流式请求内部转流式，先发 `text/event-stream` 心跳，最后一次性输出完整 JSON。需要客户端接受 SSE 头。
3. 只调大 Cloudflare 的 Proxy Read Timeout，不改面板。属于部署侧。
4. 面板对非流式请求设上限（例如 100 秒）主动返回 504。不改计费，但缩短 524 造成的重复付费窗口。

建议先做 3，再评估 4。1 和 2 改变协议行为，需要客户端确认。

## 验证

- `test/panel-token-usage.test.mjs` 覆盖两条：`deriveCacheMiss` 的未知 input 返回 `null`，中断尝试的 usage 保留（`input=100`、`output=5`、`cacheRead=60`、`cacheMiss=40`）。
- 全量 `npm test` 通过。
