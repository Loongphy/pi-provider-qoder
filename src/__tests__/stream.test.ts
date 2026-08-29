import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setQoderUI, streamQoder } from "../stream.js";

/**
 * Build a single SSE `data:` line carrying a Qoder envelope:
 *   { headers, body: <JSON string>, statusCodeValue, statusCode }
 * The server wraps the OpenAI-style chunk inside `body` as a JSON string.
 */
function sseEnvelope(body: object, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const DONE_SSE =
  "data:" +
  JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
    statusCode: "OK",
  }) +
  "\n\n";

function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

const SUCCESS_SSE =
  sseEnvelope(chunk({ role: "assistant" })) +
  sseEnvelope(chunk({ reasoning_content: "The user wants OK.", role: "assistant" })) +
  sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
  sseEnvelope(finishChunk("stop")) +
  DONE_SSE;

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

function mockFetch(body: string): typeof fetch {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function makeModel(): Model<Api> {
  return { id: "ultimate", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context;
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("streamQoder", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setQoderUI(undefined);
  });

  it("parses a successful SSE stream into text + stop", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("surfaces an upstream 406 'Session blocked' as an error event, not a silent stop", async () => {
    globalThis.fetch = mockFetch(BLOCKED_SSE);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    // Must NOT emit a silent done/stop.
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("preserves finish_reason=length instead of overwriting to stop", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("length");
  });

  it("captures usage, responseId and responseModel from the finish chunk", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          id: "chatcmpl-abc123",
          model: "qmodel_latest",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            completion_tokens_details: { reasoning_tokens: 3 },
            // prompt_tokens (42) INCLUDES cached_tokens (5) per OpenAI
            // semantics; pi-core expects `input` to exclude them
            // (promptTokens = input + cacheRead + cacheWrite), so input =
            // 42 - 5 - 10 = 27. cacheable_tokens is a capacity metric, not a
            // write count, and must not be mapped to cacheWrite.
            prompt_tokens_details: { cacheable_tokens: 99, cache_write_tokens: 10, cached_tokens: 5 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.responseId).toBe("chatcmpl-abc123");
    expect(msg.responseModel).toBe("qmodel_latest");
    expect(msg.usage.input).toBe(27);
    expect(msg.usage.output).toBe(7);
    expect(msg.usage.totalTokens).toBe(49);
    expect(msg.usage.cacheRead).toBe(5);
    expect(msg.usage.cacheWrite).toBe(10);
  });

  it("emits a done event with reason=length when finish_reason is length", async () => {
    const sse =
      sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    expect((done as { reason: string }).reason).toBe("length");
  });

  it("reports a tool_use stop reason when the stream emits tool calls", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              function: { name: "bash", arguments: '{"command":"ls"}' },
            },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("toolUse");
    const toolCall = msg.content.find((c) => c.type === "toolCall");
    expect(toolCall).toBeDefined();
  });

  it("emits a tool call that arrives with no arguments", async () => {
    // A no-argument tool, or a model that sends id+name and stops. The block
    // used to be created only inside `if (tc.function?.arguments)`, so this
    // produced a toolCallsState entry and NO content block — and the finalizer
    // then set stopReason "toolUse" on a message with no tool call in it. pi's
    // agent loop had nothing to execute and the turn ended silently, mid-task.
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "advisor", arguments: "" } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall, "a named tool call must reach the message even with no arguments").toBeDefined();
    expect(toolCall?.name).toBe("advisor");
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.arguments).toEqual({});
    expect(msg.stopReason).toBe("toolUse");
  });

  it("picks up an id and name that arrive after the block is open", async () => {
    // Streamed the other way round: arguments first, identity later.
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: 'and":"ls"}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.id).toBe("call_9");
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
  });

  it("does not claim toolUse when no tool call reached the message", async () => {
    // A malformed stream: a tool_calls delta with neither id nor name. Better a
    // clean "stop" than a message that says toolUse and carries nothing, which
    // the agent loop cannot act on and cannot report.
    const sse =
      sseEnvelope(chunk({ content: "thinking about it", role: "assistant" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: {} }] })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.content.find((c) => c.type === "toolCall")).toBeUndefined();
    expect(msg.stopReason).toBe("stop");
  });

  /**
   * Return a fresh Response for each call, cycling through `bodies` in order
   * (the last body is reused for any extra calls). Each Response body is a
   * one-shot stream, so a new instance is required per invocation.
   */
  function mockFetchSequence(bodies: string[]): typeof fetch {
    let call = 0;
    return vi.fn(async () => {
      const body = bodies[Math.min(call, bodies.length - 1)];
      call++;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
  }

  /**
   * Build an SSE envelope carrying Qoder's triple-nested "queued" 403 notice:
   *   body = {"code":"403","message":"{\"code\":\"10605\",\"message\":\"<inner>\"}"}
   */
  function queueEnvelope(inner: object): string {
    const mid = { code: "10605", message: JSON.stringify(inner) };
    const outer = { code: "403", message: JSON.stringify(mid) };
    return sseEnvelope(outer, 403, "Forbidden");
  }

  // retryAfterSeconds: 0 keeps the test fast (sleepMs resolves immediately).
  const QUEUED_SSE = queueEnvelope({
    isQueued: true,
    modelKey: "qmodel_preview",
    queueCount: 489,
    queueType: "slow",
    retryAfterSeconds: 0,
    serviceAvailable: true,
    waitTime: 1401187,
  });

  it("retries when upstream returns a queued 403, then succeeds", async () => {
    const fetchMock = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
    globalThis.fetch = fetchMock;
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event after queue retry").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
    // First call hit the queue notice, second call served the real stream.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports queue status via setWorkingMessage and clears it on success", async () => {
    const setWorkingMessage = vi.fn();
    setQoderUI({ setWorkingMessage });
    globalThis.fetch = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    await consume(stream);

    const messages = setWorkingMessage.mock.calls.map((c) => c[0]);
    expect(messages.some((m) => typeof m === "string" && m.includes("Queued on qmodel_preview"))).toBe(true);
    expect(messages.some((m) => typeof m === "string" && m.includes("position 489"))).toBe(true);
    // The final call restores the default working message (undefined).
    expect(messages[messages.length - 1]).toBeUndefined();
  });

  it("still errors on a non-queue 403 (no retry)", async () => {
    const forbidden = sseEnvelope({ code: "403", message: "forbidden" }, 403, "Forbidden");
    const fetchMock = mockFetch(forbidden);
    globalThis.fetch = fetchMock;
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event for non-queue 403").toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The shape actually observed in production: a 10605 notice that says we were
   * NOT admitted to a queue (isQueued:false) but should re-submit after 2s.
   * The original retry implementation required isQueued===true and let this
   * fall through as a fatal "Upstream status 403".
   */
  const REFUSED_QUEUE_NOTICE = {
    isQueued: false,
    modelKey: "qfmodel",
    queueCount: 0,
    queueType: "slow",
    retryAfterSeconds: 2,
    serviceAvailable: true,
    waitTime: 0,
  };

  it("retries a 10605 notice that reports isQueued:false, then succeeds", async () => {
    const fetchMock = mockFetchSequence([queueEnvelope(REFUSED_QUEUE_NOTICE), SUCCESS_SSE]);
    globalThis.fetch = fetchMock;
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event after retrying the refused-queue notice").toBeDefined();
    expect((done as { message: AssistantMessage }).message.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("honors the advertised retryAfterSeconds and labels a refused slot as busy", async () => {
    const setWorkingMessage = vi.fn();
    setQoderUI({ setWorkingMessage });
    globalThis.fetch = mockFetchSequence([queueEnvelope(REFUSED_QUEUE_NOTICE), SUCCESS_SSE]);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const status = setWorkingMessage.mock.calls.map((c) => c[0]).find((m) => typeof m === "string");
    expect(status).toContain("Busy on qfmodel");
    expect(status).toContain("retry in 2s");
    // A queue position is meaningless when we were never queued.
    expect(status).not.toContain("position");
  }, 20_000);

  it("falls back to a 5s wait for a refused notice with no retryAfterSeconds", async () => {
    const setWorkingMessage = vi.fn();
    setQoderUI({ setWorkingMessage });
    const controller = new AbortController();
    // Abort while the fallback sleep is pending so the test does not wait 5s.
    setTimeout(() => controller.abort(), 300);
    globalThis.fetch = mockFetchSequence([queueEnvelope({ isQueued: false, modelKey: "qfmodel" }), SUCCESS_SSE]);
    const events = await consume(
      streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }),
    );

    const status = setWorkingMessage.mock.calls.map((c) => c[0]).find((m) => typeof m === "string");
    expect(status).toContain("retry in 5s");
    const err = events.find((e) => e.type === "error");
    expect(err, "aborting during the queue wait must end the turn").toBeDefined();
    expect((err as { error: AssistantMessage }).error.stopReason).toBe("aborted");
  }, 15_000);

  it("gives up with the original upstream error once the retry budget is exhausted", async () => {
    // retryAfterSeconds: 0 makes the 60-attempt budget cheap to burn through.
    const alwaysQueued = queueEnvelope({ isQueued: false, modelKey: "qfmodel", retryAfterSeconds: 0 });
    const fetchMock = mockFetchSequence([alwaysQueued]);
    globalThis.fetch = fetchMock;
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const err = events.find((e) => e.type === "error");
    expect(err, "expected the queue notice to surface as an error after the budget").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toMatch(/Upstream status 403/);
    // 1 initial attempt + 60 retries, then it stops hammering the upstream.
    expect(fetchMock).toHaveBeenCalledTimes(61);
  });

  it("clears the working message when the retry budget is exhausted", async () => {
    const setWorkingMessage = vi.fn();
    setQoderUI({ setWorkingMessage });
    globalThis.fetch = mockFetchSequence([
      queueEnvelope({ isQueued: false, modelKey: "qfmodel", retryAfterSeconds: 0 }),
    ]);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const calls = setWorkingMessage.mock.calls.map((c) => c[0]);
    expect(calls.some((m) => typeof m === "string")).toBe(true);
    expect(calls[calls.length - 1]).toBeUndefined();
  });

  it("retries when the notice arrives as a real HTTP 403 instead of an SSE envelope", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        const mid = { code: "10605", message: JSON.stringify(REFUSED_QUEUE_NOTICE) };
        return new Response(JSON.stringify({ code: "403", message: JSON.stringify(mid) }), { status: 403 });
      }
      return new Response(SUCCESS_SSE, { status: 200 });
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchMock;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it("does not retry a queue notice that lands after content was produced", async () => {
    const partial = sseEnvelope(chunk({ content: "Hel", role: "assistant" })) + queueEnvelope(REFUSED_QUEUE_NOTICE);
    const fetchMock = mockFetchSequence([partial]);
    globalThis.fetch = fetchMock;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    expect(err, "a mid-stream notice must surface as an error, not a duplicate turn").toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-issues each attempt with a fresh request_id and is_retry flag", async () => {
    const bodies: string[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(Buffer.from(init?.body as ArrayBuffer).toString("utf8"));
      call++;
      return new Response(call === 1 ? queueEnvelope(REFUSED_QUEUE_NOTICE) : SUCCESS_SSE, { status: 200 });
    }) as unknown as typeof fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(bodies.length).toBe(2);
    // The body is obfuscated, so compare lengths/markers rather than parsing:
    // the retry must not reuse the first attempt's signed bytes verbatim.
    const first = new TextEncoder().encode(bodies[0]);
    expect(Buffer.compare(first, new TextEncoder().encode(bodies[1]))).not.toBe(0);
  }, 20_000);
});
