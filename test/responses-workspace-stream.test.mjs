import test from "node:test";
import assert from "node:assert/strict";
import { prepareResponsesRequest, ResponsesStream } from "../src/responses.mjs";

const chunk = (delta, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] });
const frame = (value) => `data: ${JSON.stringify(value)}\n\n`;
const measuredUsage = {
  prompt_tokens: 7, completion_tokens: 3,
  prompt_tokens_details: { cached_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 1 },
};
const expectedUsage = {
  input_tokens: 7, input_tokens_details: { cached_tokens: 2 },
  output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 10,
};
const prefix = frame(chunk({ content: "partial answer" })) + frame({ choices: [], usage: measuredUsage });
const upstreamError = /^Error: Invalid or interrupted upstream Chat response$/;
const terminalTypes = new Set(["response.completed", "response.incomplete", "response.failed"]);

function events(frames) {
  return frames.map((buffer) => {
    const [name, data] = buffer.toString().trimEnd().split("\n");
    const value = JSON.parse(data.slice(6));
    assert.equal(name, `event: ${value.type}`);
    return value;
  });
}

function lifecycle(frames, terminalType) {
  const parsed = events(frames);
  assert.deepEqual(parsed.slice(0, 2).map((event) => event.type), ["response.created", "response.in_progress"]);
  assert.deepEqual(parsed.map((event) => event.sequence_number), parsed.map((_event, index) => index));
  assert.deepEqual(parsed.filter((event) => terminalTypes.has(event.type)).map((event) => event.type), [terminalType]);
  assert.equal(parsed.at(-1).type, terminalType);
  return parsed.at(-1).response;
}

function fail(stream, frames) {
  frames.push(...stream.fail("error", "upstream stream interrupted"));
  const response = lifecycle(frames, "response.failed");
  assert.equal(response.status, "failed");
  assert.deepEqual(response.error, { code: "upstream_stream_error", message: "upstream stream interrupted" });
  assert.ok(response.output.every((item) => item.status === "failed"));
  assert.ok(!Buffer.concat(frames).toString().includes("private upstream detail"));
  assert.deepEqual(stream.fail("error", "again"), []);
  assert.deepEqual(stream.finish(), []);
  assert.deepEqual(stream.finish(), []);
  // Closed adapters ignore even oversized or invalid late input.
  assert.deepEqual(stream.push(Buffer.alloc(8 * 1024 * 1024 + 1, 0xff)), []);
  return response;
}

for (const [name, source] of [
  ["OpenAI error", frame({ error: { message: "private upstream detail" } })],
  ["typed error with Chat-shaped choices", frame({ type: "error", choices: [], message: "private upstream detail" })],
  ["CNB business error without choices", frame({ code: 11128, message: "private upstream detail" })],
  ["named error with Chat-shaped choices", `event: error\n${frame({ choices: [], message: "private upstream detail" })}`],
  ["named error ending in DONE", "event: error\ndata: [DONE]\n\n"],
  ["named error without data", "event: error\n\n"],
]) {
  test(`workspace ${name} fails in push and at an undelimited EOF`, () => {
    for (const atEof of [false, true]) {
      const stream = new ResponsesStream();
      const frames = stream.push(Buffer.from(prefix));
      const wire = atEof ? source.trimEnd() : source;
      if (atEof) {
        frames.push(...stream.push(Buffer.from(wire)));
        assert.throws(() => stream.finish(), upstreamError);
      } else assert.throws(() => stream.push(Buffer.from(wire)), upstreamError);
      const response = fail(stream, frames);
      assert.equal(response.output[0].content[0].text, "partial answer");
      assert.deepEqual(response.usage, expectedUsage);
    }
  });
}

test("a failure in the first push restores lifecycle and sequence while retaining parsed text and usage", () => {
  for (const bad of [
    frame({ error: { message: "private upstream detail" } }),
    `event: error\n${frame({ choices: [] })}`,
    "data: {bad}\n\n",
  ]) {
    const stream = new ResponsesStream();
    assert.throws(() => stream.push(Buffer.from(prefix + bad)), upstreamError);
    const response = fail(stream, []);
    assert.equal(response.output[0].content[0].text, "partial answer");
    assert.deepEqual(response.usage, expectedUsage);
  }
});

test("an error frame preserves its measured usage without exposing its raw message", () => {
  for (const source of [
    frame({ error: { message: "private upstream detail" }, usage: measuredUsage }),
    `event: error\n${frame({ choices: [], message: "private upstream detail", usage: measuredUsage })}`,
  ]) {
    const stream = new ResponsesStream();
    assert.throws(() => stream.push(Buffer.from(source)), upstreamError);
    assert.deepEqual(fail(stream, []).usage, expectedUsage);
  }
});

test("a failing later push reuses undelivered sequence numbers", () => {
  const stream = new ResponsesStream();
  const frames = stream.push(Buffer.from(frame(chunk({ content: "first " }))));
  assert.throws(() => stream.push(Buffer.from(
    frame(chunk({ content: "second" })) + frame({ choices: [], usage: measuredUsage }) + "data: {bad}\n\n",
  )), upstreamError);
  const response = fail(stream, frames);
  assert.equal(response.output[0].content[0].text, "first second");
  assert.deepEqual(response.usage, expectedUsage);
});

test("malformed final JSON and unfinished UTF-8 still allow one failure after finish throws", () => {
  for (const suffix of [
    Buffer.from('data: {"error":{"message":"private upstream detail"}'),
    Buffer.from([0xe4, 0xb8]),
  ]) {
    const stream = new ResponsesStream();
    const frames = stream.push(Buffer.concat([Buffer.from(prefix), suffix]));
    assert.throws(() => stream.finish(), upstreamError);
    const response = fail(stream, frames);
    assert.equal(response.output[0].content[0].text, "partial answer");
    assert.deepEqual(response.usage, expectedUsage);
  }
});

test("invalid UTF-8 fails in push and preserves prior measured output", () => {
  const stream = new ResponsesStream();
  const frames = stream.push(Buffer.from(prefix));
  assert.throws(() => stream.push(Buffer.from([0xc3, 0x28])), upstreamError);
  const response = fail(stream, frames);
  assert.equal(response.output[0].content[0].text, "partial answer");
  assert.deepEqual(response.usage, expectedUsage);
});

test("tool validation in finish rolls back undelivered item events", () => {
  const { payload, toolContext } = prepareResponsesRequest({ input: "local fixture", tools: [
    { type: "function", name: "read" }, { type: "custom", name: "edit" },
  ] });
  const stream = new ResponsesStream({ toolContext });
  const frames = stream.push(Buffer.from(prefix + frame(chunk({ tool_calls: [
    { index: 0, id: "call_read", type: "function", function: { name: payload.tools[0].function.name, arguments: "" } },
    { index: 1, id: "call_edit", type: "function", function: { name: payload.tools[1].function.name, arguments: "{}" } },
  ] }, "tool_calls"))));
  assert.throws(() => stream.finish(), upstreamError);
  const response = fail(stream, frames);
  assert.equal(response.output[0].content[0].text, "partial answer");
  assert.deepEqual(response.usage, expectedUsage);
  assert.equal(events(frames).some((event) => event.type === "response.output_item.done"), false);
});

test("tool finish reasons without tools and incomplete tool identities remain failures", () => {
  for (const delta of [{}, { tool_calls: [{ index: 0, function: { name: "read" } }] }]) {
    const stream = new ResponsesStream();
    const frames = stream.push(Buffer.from(prefix + frame(chunk(delta, "tool_calls"))));
    assert.throws(() => stream.finish(), upstreamError);
    assert.deepEqual(fail(stream, frames).usage, expectedUsage);
  }
});

test("event and response limits still terminate with one explicit failure", () => {
  const oversizedEvent = new ResponsesStream();
  const eventFrames = oversizedEvent.push(Buffer.from(prefix));
  assert.throws(() => oversizedEvent.push(Buffer.from(`data: ${"x".repeat(1024 * 1024 + 1)}\n\n`)), upstreamError);
  assert.deepEqual(fail(oversizedEvent, eventFrames).usage, expectedUsage);

  const oversizedResponse = new ResponsesStream();
  const responseFrames = oversizedResponse.push(Buffer.from(prefix));
  const comment = Buffer.from(`:${"x".repeat(1024 * 1024 - 3)}\n\n`);
  for (let index = 0; index < 7; index++) responseFrames.push(...oversizedResponse.push(comment));
  assert.throws(() => oversizedResponse.push(comment), upstreamError);
  assert.deepEqual(fail(oversizedResponse, responseFrames).usage, expectedUsage);
});

test("reasoning-only output keeps usage and the declared completion status without exposing reasoning", () => {
  for (const reason of [null, "stop", "length", "content_filter"]) {
    const stream = new ResponsesStream();
    const frames = stream.push(Buffer.from(
      frame(chunk({ reasoning_content: "private reasoning" })) +
      frame(chunk({}, reason)) + frame({ choices: [], usage: measuredUsage }),
    ));
    frames.push(...stream.finish());
    const incomplete = reason === "length" || reason === "content_filter";
    const response = lifecycle(frames, incomplete ? "response.incomplete" : "response.completed");
    assert.deepEqual(response.usage, expectedUsage);
    assert.deepEqual(response.output[0].content, []);
    if (incomplete) assert.equal(response.incomplete_details.reason, reason === "length" ? "max_output_tokens" : reason);
    assert.ok(!Buffer.concat(frames).toString().includes("private reasoning"));
    assert.deepEqual(stream.finish(), []);
    assert.deepEqual(stream.fail("error", "late"), []);
  }
});

test("reasoning before visible output preserves fragmented UTF-8 text and trailing usage", () => {
  const stream = new ResponsesStream();
  const wire = Buffer.from(
    ": keep-alive\r\n\r\n" + frame(chunk({ reasoning_content: "private reasoning" })) +
    frame(chunk({ content: "你😀" }, "stop")) + frame({ choices: [], usage: measuredUsage }) + "data: [DONE]\n\n",
  );
  const frames = [];
  for (const byte of wire) frames.push(...stream.push(Uint8Array.of(byte)));
  frames.push(...stream.finish());
  const response = lifecycle(frames, "response.completed");
  assert.equal(response.output[0].content[0].text, "你😀");
  assert.deepEqual(response.usage, expectedUsage);
  assert.ok(!Buffer.concat(frames).toString().includes("private reasoning"));
});

test("clean EOF remains compatible with empty, comment-only, role-only and unterminated answers", () => {
  for (const source of [
    "", ": heartbeat\n\n", frame(chunk({ role: "assistant" })),
    frame(chunk({ content: "answer" })),
    `data: ${JSON.stringify(chunk({ content: "answer" }))}`,
    frame(chunk({ content: "answer" })) + "data: [DONE]\n\n",
  ]) {
    const stream = new ResponsesStream();
    const frames = source ? stream.push(Buffer.from(source)) : [];
    frames.push(...stream.finish());
    assert.equal(lifecycle(frames, "response.completed").usage, null);
    assert.deepEqual(stream.finish(), []);
    assert.deepEqual(stream.push(Buffer.from("data: invalid\n\n")), []);
    assert.deepEqual(stream.fail("error", "late"), []);
  }
});

test("named non-error events and SSE field replacement retain normal completion", () => {
  for (const event of ["event: message\n", "event: error\nevent: message\n", "event: error\nevent\n"]) {
    const stream = new ResponsesStream();
    const frames = stream.push(Buffer.from(event + frame(chunk({ content: "answer" }))));
    frames.push(...stream.push(Buffer.from(frame({ choices: [], usage: measuredUsage }))));
    frames.push(...stream.finish());
    assert.deepEqual(lifecycle(frames, "response.completed").usage, expectedUsage);
  }
});
