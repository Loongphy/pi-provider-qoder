import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  ToolCall,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QODER_QUEUE_POLL_MAX_FAILURES, streamQoder } from "../stream.js";
import { setQoderUI } from "../ui.js";

/** Strip ANSI escape sequences (the fake theme renders plain text, belt and braces). */
function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are the point
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * A fake extension UI that captures the queue-status widget the way pi's
 * interactive mode does: the factory is invoked per setWidget call, the widget
 * is rendered once on mount (renderWidgets), and every requestRender records
 * what the row would show at `width`.
 */
function widgetUI(width = 200) {
  const rendered: string[] = [];
  const workingMessages: (string | undefined)[] = [];
  const placements: (string | undefined)[] = [];
  let component: { render(w: number): string[]; dispose?(): void } | undefined;
  let mountCount = 0;
  const requestRender = () => {
    if (component) rendered.push(stripAnsi(component.render(width)[0] ?? ""));
  };
  const ui = {
    setWidget(
      _key: string,
      factory:
        | ((
            tui: { requestRender(force?: boolean): void },
            theme: { fg(c: string, t: string): string },
          ) => {
            render(w: number): string[];
            dispose?(): void;
          })
        | undefined,
      opts?: { placement?: string },
    ) {
      if (!factory) {
        component = undefined;
        return;
      }
      placements.push(opts?.placement);
      component = factory({ requestRender }, { fg: (_c, t) => t });
      mountCount++;
      requestRender(); // pi re-renders the widget container on mount
    },
    setWorkingMessage(message?: string) {
      workingMessages.push(message);
    },
  };
  return {
    ui,
    /** The queue-status row, one entry per tick, in order. */
    lines: () => rendered,
    workingMessages: () => workingMessages,
    placements: () => placements,
    isVisible: () => component !== undefined,
    mounts: () => mountCount,
    /** Simulate a session switch: pi disposes mounted widgets. */
    dispose: () => component?.dispose?.(),
  };
}

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

function makeContext(): TranscriptContext {
  return normalizeContext({
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi", timestamp: 0 }],
    tools: [],
  });
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
  let stateDir = "";
  beforeEach(() => {
    // Vitest's stderr is a pipe, so qoderLog would default to on here; keep
    // the suite quiet unless a test opts in explicitly.
    process.env.QODER_LOG = "0";
    // The queue handshake files must never touch the real ~/.pi/agent.
    stateDir = mkdtempSync(join(tmpdir(), "qoder-ui-test-"));
    process.env.PI_AGENT_DIR = stateDir;
    // Mount the fallback row immediately unless a test wants the grace path.
    process.env.QODER_QUEUE_YIELD_GRACE_MS = "0";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setQoderUI(undefined);
    delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    delete process.env.QODER_QUEUE_POLL;
    delete process.env.QODER_LOG;
    delete process.env.PI_AGENT_DIR;
    delete process.env.QODER_QUEUE_YIELD_GRACE_MS;
    rmSync(stateDir, { recursive: true, force: true });
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
   * A queue-status poll reply. `undefined` body with the default status 404
   * models a gateway that has no queue endpoint at all, which is the common
   * case for tests that only care about the resend path.
   */
  type PollReply = Error | { body?: unknown; status?: number };

  /**
   * Route chat POSTs through `chat` (last entry reused) and queue-status GETs
   * through `poll` (consumed in order, then the gateway is treated as having
   * no queue endpoint). Counts the two separately so a test can prove how many
   * times the conversation was uploaded versus how many times we just looked.
   */
  function mockFetchQueue(opts: { chat: Array<string | Response>; poll?: PollReply[] }) {
    let posts = 0;
    let gets = 0;
    const getUrls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/queue/status")) {
        getUrls.push(url);
        const reply = opts.poll?.[Math.min(gets, (opts.poll?.length ?? 1) - 1)] ?? { status: 404 };
        gets++;
        if (reply instanceof Error) throw reply;
        return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), {
          status: reply.status ?? 200,
        });
      }
      const body = opts.chat[Math.min(posts, opts.chat.length - 1)];
      posts++;
      return typeof body === "string"
        ? new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
        : body;
    }) as unknown as typeof fetch;
    return { fetch: fetchMock, posts: () => posts, gets: () => gets, getUrls };
  }

  /**
   * An SSE body that is cut off the way undici reports a gateway hanging up:
   * the bytes arrive, then the next `read()` rejects with `TypeError: terminated`.
   */
  function truncatedAfter(body: string): Response {
    // Erroring a stream discards whatever is still queued, so the bytes have to
    // go out on the first pull and the socket only dies on the next one.
    const bytes = new TextEncoder().encode(body);
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          controller.enqueue(bytes);
          return;
        }
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }

  /** A queue-status payload; nested in `data` because that is how the gateway answers. */
  function queueStatus(inner: object): PollReply {
    return { body: { data: inner } };
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

  // A 0 hint is floored to 100ms by the anti-spin guard, which keeps these
  // tests fast while still exercising the real backoff path.
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
    // The queue frees up on the first look, so the conversation is uploaded
    // exactly twice (original + resend) while the waiting is done by GET.
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [queueStatus({ isQueued: false, modelKey: "qmodel_preview", retryAfterSeconds: 0 })],
    });
    globalThis.fetch = route.fetch;
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event after queue retry").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
    expect(route.posts()).toBe(2);
    expect(route.gets()).toBe(1);
  });

  it("does not fail the turn when the gateway hangs up right after the queue notice", async () => {
    // The production failure: the gateway writes the 10605 notice and drops the
    // socket, which undici surfaces as `TypeError: terminated`. The notice only
    // broke out of the line loop, so the next read hit the dead body and the
    // rejection escaped as an error event — the "Error: terminated" that shows
    // up a few times before a queued request really resumes — throwing away the
    // recoverable notice we had just parsed.
    const route = mockFetchQueue({
      chat: [truncatedAfter(QUEUED_SSE), SUCCESS_SSE],
      poll: [queueStatus({ isQueued: false, modelKey: "qmodel_preview", retryAfterSeconds: 0 })],
    });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(
      events.find((e) => e.type === "error"),
      "a dead socket after the notice is not a failure",
    ).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done, "the resend still happens").toBeDefined();
    expect((done as { message: AssistantMessage }).message.stopReason).toBe("stop");
    expect(route.posts()).toBe(2);
  });

  it("does not fail a complete answer when the socket dies after [DONE]", async () => {
    const route = mockFetchQueue({ chat: [truncatedAfter(SUCCESS_SSE)] });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(
      events.find((e) => e.type === "error"),
      "the answer was complete",
    ).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const text = (done as { message: AssistantMessage }).message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("still surfaces a truncated body when there was nothing to recover from", async () => {
    // The safety net is scoped to a body that already told us it was over:
    // a mid-answer truncation must stay an error, or the turn silently dies.
    const partial = sseEnvelope(chunk({ content: "Hel", role: "assistant" }));
    const route = mockFetchQueue({ chat: [truncatedAfter(partial)] });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    expect(err, "a truncated answer is still an error").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toBe("terminated");
  });

  it("ticks the countdown and the elapsed budget instead of freezing one line", async () => {
    // The status line used to be rendered once per wait carrying the full hint
    // and then left alone, so "retry in 30s" sat unchanged for 30 seconds and
    // read as a hang.
    process.env.QODER_QUEUE_POLL = "0";
    process.env.QODER_LOG = "1";
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const route = mockFetchQueue({
      chat: [
        queueEnvelope({ isQueued: true, modelKey: "qmodel_preview", queueCount: 450, retryAfterSeconds: 2 }),
        SUCCESS_SSE,
      ],
    });
    globalThis.fetch = route.fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const lines = widget.lines();
    expect(lines.some((m) => m.includes("retry in 2s"))).toBe(true);
    expect(lines.some((m) => m.includes("retry in 1s"))).toBe(true);
    expect(lines.some((m) => m.includes("retry in 0s"))).toBe(true);
    // The elapsed side of the budget moves with it.
    expect(lines.some((m) => m.includes("waited 0s/"))).toBe(true);
    expect(lines.some((m) => m.includes("waited 2s/"))).toBe(true);
    // The widget row is a status line and ticks; stderr is a log and does not,
    // so a long wait cannot turn into a per-second log flood.
    const logged = errorSpy.mock.calls.filter((c) => String(c[0]).includes("pi-provider-qoder"));
    expect(logged.length).toBeLessThan(lines.length);
  }, 20_000);

  it("reports queue status on its own widget row above the editor, never on the working row", async () => {
    const widget = widgetUI();
    setQoderUI(widget.ui);
    globalThis.fetch = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    await consume(stream);

    const lines = widget.lines();
    expect(lines.some((m) => m.includes("Queued on qmodel_preview"))).toBe(true);
    expect(lines.some((m) => m.includes("position 489"))).toBe(true);
    // The row lives in the extension-widget area above the editor (pi has no
    // slot above the working row), so "Working for ..." keeps its own line.
    expect(widget.placements().every((p) => p === "aboveEditor")).toBe(true);
    expect(widget.workingMessages()).toEqual([]);
    // Cleared once real content starts streaming, and the row is removed.
    expect(widget.isVisible()).toBe(false);
  });

  it("keeps the queue row to one truncated line regardless of terminal width", async () => {
    const narrow = widgetUI(40);
    setQoderUI(narrow.ui);
    globalThis.fetch = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    // A wrapped status row is what made the layout jump; the widget must stay
    // exactly one line tall at any width.
    for (const line of narrow.lines()) expect(line.length).toBeLessThanOrEqual(40);
    expect(narrow.lines().some((m) => m.includes("Queued on qmodel_preview"))).toBe(true);
  });

  it("mounts the widget once per queue episode and updates it in place", async () => {
    // Several looks at the queue and several ticks of the countdown must not
    // rebuild the widget container each time; only the line content changes.
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [
        queueStatus({ isQueued: true, queueCount: 412, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: false, retryAfterSeconds: 0 }),
      ],
    });
    globalThis.fetch = route.fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(widget.mounts()).toBe(1);
    expect(widget.lines().length).toBeGreaterThan(1);
    expect(widget.isVisible()).toBe(false);
  }, 30_000);

  it("publishes the queue line to the handshake file and yields to a widget host", async () => {
    // A widget host (the user's status extension) that claims the queue row
    // renders it ABOVE "Working for"; the provider must then stand its own
    // row down so the line is not duplicated, and clean the file up at the end.
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const claimPath = join(stateDir, `qoder-queue-${process.pid}.claim`);
    writeFileSync(claimPath, String(Date.now()));
    const statePath = join(stateDir, `qoder-queue-${process.pid}.json`);

    let sawPublishedLine = false;
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [
        queueStatus({ isQueued: true, queueCount: 412, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: false, retryAfterSeconds: 0 }),
      ],
    });
    const innerFetch = route.fetch;
    globalThis.fetch = (async (url: URL, init?: RequestInit) => {
      const response = await innerFetch(url, init);
      // While the provider is mid-wait, the published line must be on disk.
      try {
        const raw = JSON.parse(readFileSync(statePath, "utf8")) as { line?: string };
        if (typeof raw.line === "string" && raw.line.includes("Queued on qmodel_preview")) {
          sawPublishedLine = true;
        }
      } catch {
        // not written yet
      }
      return response;
    }) as unknown as typeof fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(sawPublishedLine, "the queue line was published for widget hosts").toBe(true);
    expect(widget.lines(), "the host claimed it, so no duplicate fallback row").toEqual([]);
    expect(widget.workingMessages()).toEqual([]);
    expect(() => statSync(statePath), "the handshake file is cleaned up once the queue clears").toThrow();
  }, 30_000);

  it("keeps the fallback row when no widget host claims the queue display", async () => {
    // Standalone installs (no status extension): after the grace period the
    // provider renders the row itself, below the working row.
    process.env.QODER_QUEUE_YIELD_GRACE_MS = "0";
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [queueStatus({ isQueued: false, retryAfterSeconds: 0 })],
    });
    globalThis.fetch = route.fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(widget.mounts()).toBe(1);
    expect(widget.lines().some((m) => m.includes("Queued on qmodel_preview"))).toBe(true);
  }, 30_000);

  it("delays the fallback row during the yield grace period", async () => {
    // The grace window exists so a widget host can claim the row first; with
    // a long grace and no host, the row appears only after it elapses.
    process.env.QODER_QUEUE_YIELD_GRACE_MS = "5000";
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [
        queueStatus({ isQueued: true, queueCount: 412, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: false, retryAfterSeconds: 0 }),
      ],
    });
    globalThis.fetch = route.fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    // The episode lasts ~1s (two 500ms waits), well inside the 5s grace.
    expect(widget.lines()).toEqual([]);
  }, 30_000);

  it("re-mounts the widget after a session switch disposed it", async () => {
    const widget = widgetUI();
    setQoderUI(widget.ui);
    globalThis.fetch = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(widget.isVisible()).toBe(false);

    // A second queued request in a new session: pi disposed the old component.
    widget.dispose();
    globalThis.fetch = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(widget.lines().some((m) => m.includes("Queued on qmodel_preview"))).toBe(true);
    expect(widget.isVisible()).toBe(false);
  });

  it("writes nothing to stderr while pi's TUI owns the terminal", async () => {
    // The original bug: console.error during streaming scrolls the terminal
    // behind pi's renderer's back, which re-paints the working row on a new
    // line every tick and pushes the composer off screen. stderr attached to a
    // TTY must therefore stay silent unless logging is explicitly requested.
    const stderrDesc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      delete process.env.QODER_LOG; // the default path: silent on a TTY
      globalThis.fetch = mockFetchSequence([QUEUED_SSE, SUCCESS_SSE]);
      await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      expect(errorSpy.mock.calls.filter((c) => String(c[0]).includes("pi-provider-qoder"))).toEqual([]);

      // Opt-in logging still works for real diagnostics (not for the status
      // line itself, which is a UI row now).
      process.env.QODER_LOG = "1";
      const route = mockFetchQueue({
        chat: [queueEnvelope(REFUSED_FAST), SUCCESS_SSE],
        poll: [new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")],
      });
      globalThis.fetch = route.fetch;
      await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
      expect(
        errorSpy.mock.calls.some((c) => String(c[0]).includes("[pi-provider-qoder] queue status polling disabled")),
      ).toBe(true);
    } finally {
      if (stderrDesc) Object.defineProperty(process.stderr, "isTTY", stderrDesc);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
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

  /** Same production shape, but pinned to the 500ms floor so tests stay quick. */
  const REFUSED_FAST = { ...REFUSED_QUEUE_NOTICE, retryAfterSeconds: 0 };

  it("retries a 10605 notice that reports isQueued:false, then succeeds", async () => {
    const route = mockFetchQueue({
      chat: [queueEnvelope(REFUSED_FAST), SUCCESS_SSE],
      poll: [queueStatus({ isQueued: false, modelKey: "qfmodel", retryAfterSeconds: 0 })],
    });
    globalThis.fetch = route.fetch;
    const stream = streamQoder(makeModel(), makeContext(), { apiKey: "fake" });
    const events = await consume(stream);

    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event after retrying the refused-queue notice").toBeDefined();
    expect((done as { message: AssistantMessage }).message.stopReason).toBe("stop");
    expect(route.posts()).toBe(2);
  }, 20_000);

  it("waits out a long queue by polling, re-uploading the conversation only once", async () => {
    // The case the poll route exists for: several looks at the queue, and the
    // multi-megabyte body goes out exactly twice (original + the real send).
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [
        queueStatus({ isQueued: true, queueCount: 900, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: true, queueCount: 412, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: true, queueCount: 7, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: false, retryAfterSeconds: 0 }),
      ],
    });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(route.gets()).toBe(4);
    expect(route.posts()).toBe(2);
    // The position is re-read on every look, so it walks down instead of being
    // frozen at whatever the first notice said. NOTE: the stale "position 489"
    // from QUEUED_SSE is never shown once a poll answers.
    const lines = widget.lines();
    expect(lines.some((m) => m.includes("position 900"))).toBe(true);
    expect(lines.some((m) => m.includes("position 412"))).toBe(true);
    expect(lines.some((m) => m.includes("position 7"))).toBe(true);
  }, 30_000);

  it("keeps polling while serviceAvailable is false and only resends on a free slot", async () => {
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [
        queueStatus({ isQueued: true, serviceAvailable: false, retryAfterSeconds: 0 }),
        queueStatus({ isQueued: false, retryAfterSeconds: 0 }),
      ],
    });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(route.gets()).toBe(2);
    expect(route.posts()).toBe(2);
    // A free slot is announced as a resend, not as another wait.
    expect(widget.lines().some((m) => m.includes("slot free \u00B7 resending"))).toBe(true);
  }, 30_000);

  it("asks the queue endpoint with requestSetId, modelKey and queueType", async () => {
    const route = mockFetchQueue({
      chat: [QUEUED_SSE, SUCCESS_SSE],
      poll: [queueStatus({ isQueued: false, retryAfterSeconds: 0 })],
    });
    globalThis.fetch = route.fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(route.getUrls).toHaveLength(1);
    const url = new URL(route.getUrls[0]);
    expect(url.pathname).toBe("/algo/api/v2/service/ask/queue/status");
    expect(url.searchParams.get("requestSetId")).toMatch(/^[0-9a-f]{16}$/);
    // modelKey comes from the notice (qmodel_preview), not the pi model id.
    expect(url.searchParams.get("modelKey")).toBe("qmodel_preview");
    expect(url.searchParams.get("queueType")).toBe("slow");
  });

  it("degrades to a plain hint wait when the gateway has no queue endpoint", async () => {
    // poll defaults to 404: a missing endpoint must not fail the turn.
    const route = mockFetchQueue({ chat: [queueEnvelope(REFUSED_FAST), SUCCESS_SSE] });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(
      events.find((e) => e.type === "done"),
      "the resend still happens",
    ).toBeDefined();
    expect(route.gets()).toBe(1);
    expect(route.posts()).toBe(2);
  }, 20_000);

  it("stops polling after three consecutive failures instead of looping forever", async () => {
    const route = mockFetchQueue({
      chat: [queueEnvelope(REFUSED_FAST), SUCCESS_SSE],
      poll: [new Error("ECONNRESET"), new Error("ECONNRESET"), new Error("ECONNRESET")],
    });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(route.gets()).toBe(QODER_QUEUE_POLL_MAX_FAILURES);
    expect(route.posts()).toBe(2);
  }, 30_000);

  it("QODER_QUEUE_POLL=0 waits the hint and resends without touching the endpoint", async () => {
    process.env.QODER_QUEUE_POLL = "0";
    const route = mockFetchQueue({ chat: [queueEnvelope(REFUSED_FAST), SUCCESS_SSE] });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.find((e) => e.type === "done")).toBeDefined();
    expect(route.gets()).toBe(0);
    expect(route.posts()).toBe(2);
  }, 20_000);

  it("honors the advertised retryAfterSeconds and labels a refused slot as busy", async () => {
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const route = mockFetchQueue({
      chat: [queueEnvelope(REFUSED_QUEUE_NOTICE), SUCCESS_SSE],
      // The service is down on the first look, so the same 2s hint is slept as a
      // queue LOOK; then the endpoint turns out to be absent (404) and the very
      // same hint is slept again as the wait before the re-send.
      poll: [queueStatus({ serviceAvailable: false, modelKey: "qfmodel", retryAfterSeconds: 2 }), { status: 404 }],
    });
    globalThis.fetch = route.fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const lines = widget.lines();
    expect(lines[0]).toContain("Busy on qfmodel");
    // The hint is taken literally in both phases, not clamped to something
    // shorter.
    expect(lines.some((m) => m.includes("check again in 2s"))).toBe(true);
    expect(lines.some((m) => m.includes("retry in 2s"))).toBe(true);
    // A queue position is meaningless when we were never queued.
    expect(lines[0]).not.toContain("position");
    expect(route.posts()).toBe(2);
  }, 20_000);

  it("waits 1s when the notice carries no retryAfterSeconds", async () => {
    const widget = widgetUI();
    setQoderUI(widget.ui);
    globalThis.fetch = mockFetchSequence([queueEnvelope({ isQueued: false, modelKey: "qfmodel" }), SUCCESS_SSE]);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const lines = widget.lines();
    // The first line is the notice itself (the 30s poll default); the 1s
    // fallback applies to the wait before the re-send.
    expect(lines[0]).toContain("check again in 30s");
    expect(lines.some((m) => m.includes("retry in 1s"))).toBe(true);
    expect(
      events.find((e) => e.type === "done"),
      "should recover after the fallback wait",
    ).toBeDefined();
  }, 15_000);

  it("honors a long hint instead of clamping it, bounded only by the budget", async () => {
    // A 120s hint must be taken literally: qodercli's 30s poll throttle is not
    // our semantics, and cutting it early would re-POST the whole conversation
    // 90s too soon. Abort mid-wait so the test does not sleep 2 minutes.
    const widget = widgetUI();
    setQoderUI(widget.ui);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    globalThis.fetch = mockFetchSequence([
      queueEnvelope({ isQueued: true, modelKey: "qfmodel", retryAfterSeconds: 120 }),
      SUCCESS_SSE,
    ]);
    const events = await consume(
      streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }),
    );

    const lines = widget.lines();
    expect(lines.some((m) => m.includes("in 120s"))).toBe(true);
    const err = events.find((e) => e.type === "error") as { error: AssistantMessage } | undefined;
    expect(err?.error.stopReason, "the wait must stay interruptible").toBe("aborted");
  }, 15_000);

  it("gives up with the original upstream error once the wall-clock budget is spent", async () => {
    // A tiny time budget instead of an attempt cap, matching the upstream knob.
    process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = "1200";
    const route = mockFetchQueue({
      chat: [queueEnvelope({ isQueued: false, modelKey: "qfmodel", retryAfterSeconds: 0.5 })],
      // Never frees up: polling burns the budget, then the last resend errors.
      poll: [queueStatus({ isQueued: true, modelKey: "qfmodel", retryAfterSeconds: 0.5 })],
    });
    globalThis.fetch = route.fetch;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    expect(err, "expected the queue notice to surface as an error after the budget").toBeDefined();
    expect((err as { error: AssistantMessage }).error.errorMessage).toMatch(/Upstream status 403/);
    // The budget stops the waiting, and the conversation is re-uploaded at most
    // once more than it was sent to begin with.
    expect(route.gets()).toBeGreaterThanOrEqual(2);
    expect(route.posts()).toBe(2);
  }, 20_000);

  it("clears the queue row when the retry budget is exhausted", async () => {
    process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS = "1200";
    const widget = widgetUI();
    setQoderUI(widget.ui);
    globalThis.fetch = mockFetchSequence([
      queueEnvelope({ isQueued: false, modelKey: "qfmodel", retryAfterSeconds: 0 }),
    ]);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(widget.lines().some((m) => m.length > 0)).toBe(true);
    expect(widget.isVisible()).toBe(false);
  }, 20_000);

  it("retries when the notice arrives as a real HTTP 403 instead of an SSE envelope", async () => {
    process.env.QODER_QUEUE_POLL = "0";
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        const mid = { code: "10605", message: JSON.stringify(REFUSED_FAST) };
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
    const partial = sseEnvelope(chunk({ content: "Hel", role: "assistant" })) + queueEnvelope(REFUSED_FAST);
    const fetchMock = mockFetchSequence([partial]);
    globalThis.fetch = fetchMock;
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    expect(err, "a mid-stream notice must surface as an error, not a duplicate turn").toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  /**
   * qodercli mints request_id/chat_record_id once per request BUILD and keeps
   * `is_retry` a constant false, so a queue resend must replay the exact same
   * encoded bytes. Only the COSY signature (which covers a unix timestamp) is
   * regenerated per attempt, mirroring its per-attempt prepareRequest().
   */
  it("re-sends identical body bytes and only re-signs each attempt", async () => {
    const bodies: Buffer[] = [];
    const auths: string[] = [];
    let call = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/queue/status")) {
        return new Response(JSON.stringify({ data: { isQueued: false, retryAfterSeconds: 0 } }), { status: 200 });
      }
      bodies.push(Buffer.from(init?.body as ArrayBuffer));
      const headers = init?.headers as Record<string, string>;
      auths.push(`${headers.Authorization}|${headers["X-Request-Id"]}`);
      call++;
      return new Response(call === 1 ? queueEnvelope(REFUSED_FAST) : SUCCESS_SSE, { status: 200 });
    }) as unknown as typeof fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(bodies.length).toBe(2);
    expect(bodies[1].equals(bodies[0])).toBe(true);
    expect(auths[1]).not.toBe(auths[0]);
  }, 20_000);
});

describe("request identity: one billed task per user prompt", () => {
  const originalFetch = globalThis.fetch;
  let stateDir = "";

  /** A 10605 queued notice, so the provider also exercises the queue path. */
  function queuedNotice(inner: object): string {
    const mid = { code: "10605", message: JSON.stringify(inner) };
    const outer = { code: "403", message: JSON.stringify(mid) };
    return sseEnvelope(outer, 403, "Forbidden");
  }
  const QUEUED_NOTICE_SSE = queuedNotice({
    isQueued: true,
    modelKey: "qmodel_preview",
    queueCount: 489,
    queueType: "slow",
    retryAfterSeconds: 0,
    serviceAvailable: true,
  });

  beforeEach(() => {
    process.env.QODER_LOG = "0";
    stateDir = mkdtempSync(join(tmpdir(), "qoder-ui-test-"));
    process.env.PI_AGENT_DIR = stateDir;
    process.env.QODER_QUEUE_YIELD_GRACE_MS = "0";
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    setQoderUI(undefined);
    delete process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
    delete process.env.QODER_QUEUE_POLL;
    delete process.env.QODER_LOG;
    delete process.env.PI_AGENT_DIR;
    delete process.env.QODER_QUEUE_YIELD_GRACE_MS;
    rmSync(stateDir, { recursive: true, force: true });
  });

  /**
   * Undo the WAF body obfuscation so a test can read the request JSON.
   * Inverse of qoderEncodeBody: swap the custom alphabet back, un-rotate the
   * three segments, then base64-decode.
   */
  function decodeQoderBody(body: unknown): Record<string, any> {
    const custom = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
    const std = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const swapped = String(body)
      .split("")
      .map((ch) => {
        const i = custom.indexOf(ch);
        if (i >= 0) return std[i];
        return ch === "$" ? "=" : ch;
      })
      .join("");
    const n = swapped.length;
    const a = Math.floor(n / 3);
    const b64 = swapped.slice(n - a) + swapped.slice(a, n - a) + swapped.slice(0, a);
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as Record<string, any>;
  }

  it("keeps request_set_id and business.id stable across a task's tool round-trips", async () => {
    // qodercli mints both once per AgentLifecycle and reuses them for every
    // request of the run; that grouping is what makes the gateway accumulate
    // the round-trips into one billed task instead of charging each one.
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(decodeQoderBody(init?.body));
      return new Response(SUCCESS_SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const base = makeContext();
    // Turn 1: user prompt -> assistant -> tool result -> next request.
    await consume(streamQoder(makeModel(), base, { apiKey: "fake", sessionId: "sess-1" }));
    const afterPrompt = {
      ...base,
      messages: [
        ...base.messages,
        { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: "{}" }] },
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [{ type: "text", text: "ok" }],
          isError: false,
        },
      ],
    } as TranscriptContext;
    await consume(streamQoder(makeModel(), afterPrompt, { apiKey: "fake", sessionId: "sess-1" }));

    expect(bodies.length).toBe(2);
    expect(bodies[0].request_set_id).toBe(bodies[1].request_set_id);
    expect(bodies[0].business.id).toBe(bodies[1].business.id);
    expect(bodies[0].business.id).toBe(bodies[0].request_set_id);
    expect(bodies[0].business.begin_at).toBe(bodies[1].business.begin_at);
    // Per-request identity still differs, as in qodercli (request_id is minted
    // per request; chat_record_id stays content-addressed so a queue resend
    // replays identical bytes).
    expect(bodies[0].request_id).not.toBe(bodies[1].request_id);
    expect(bodies[0].chat_record_id).not.toBe(bodies[1].chat_record_id);
    expect(bodies[0].session_id).toBe(bodies[1].session_id);
  });

  it("starts a new task when the user sends a new prompt", async () => {
    const bodies: Array<Record<string, any>> = [];
    globalThis.fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(decodeQoderBody(init?.body));
      return new Response(SUCCESS_SSE, { status: 200 });
    }) as unknown as typeof fetch;

    const first = makeContext();
    await consume(streamQoder(makeModel(), first, { apiKey: "fake", sessionId: "sess-1" }));
    const second = {
      ...first,
      messages: [
        ...first.messages,
        { role: "assistant", content: [{ type: "text", text: "done" }] },
        { role: "user", content: "and another thing" },
      ],
    } as TranscriptContext;
    await consume(streamQoder(makeModel(), second, { apiKey: "fake", sessionId: "sess-1" }));

    expect(bodies.length).toBe(2);
    expect(bodies[1].request_set_id).not.toBe(bodies[0].request_set_id);
    expect(bodies[1].business.id).toBe(bodies[1].request_set_id);
  });

  it("polls the queue endpoint with the task id it sends as request_set_id", async () => {
    const bodies: Array<Record<string, any>> = [];
    const getUrls: string[] = [];
    let chatCall = 0;
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/queue/status")) {
        getUrls.push(target);
        return new Response(JSON.stringify({ data: { isQueued: false, retryAfterSeconds: 0 } }), { status: 200 });
      }
      bodies.push(decodeQoderBody(init?.body));
      return new Response(chatCall++ === 0 ? QUEUED_NOTICE_SSE : SUCCESS_SSE, { status: 200 });
    }) as unknown as typeof fetch;

    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", sessionId: "sess-1" }));

    expect(getUrls.length).toBeGreaterThan(0);
    expect(bodies.length).toBeGreaterThan(0);
    const url = new URL(getUrls[0]);
    // The queue entry is keyed by request set, so the poll must carry the same
    // task id the body advertises (verified against qodercli's okc()).
    expect(url.searchParams.get("requestSetId")).toBe(bodies[0].request_set_id);
  }, 20_000);
});

describe("delta coalescing", () => {
  const originalFetch = globalThis.fetch;
  const originalFlush = process.env.QODER_STREAM_FLUSH_MS;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalFlush === undefined) delete process.env.QODER_STREAM_FLUSH_MS;
    else process.env.QODER_STREAM_FLUSH_MS = originalFlush;
    vi.restoreAllMocks();
    setQoderUI(undefined);
  });

  /** `count` SSE chunks each carrying the same small piece of text. */
  function manyTextChunks(count: number, piece: string): string {
    let sse = "";
    for (let i = 0; i < count; i++) sse += sseEnvelope(chunk({ content: piece, role: "assistant" }));
    return sse + sseEnvelope(finishChunk("stop")) + DONE_SSE;
  }

  it("merges Qoder's fine-grained text chunks into one update without losing characters", async () => {
    process.env.QODER_STREAM_FLUSH_MS = "50";
    globalThis.fetch = mockFetch(manyTextChunks(6, "ab"));
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length, "6 wire chunks should collapse into one update").toBe(1);
    expect((textDeltas[0] as { delta: string }).delta).toBe("abababababab");

    const done = events.find((e) => e.type === "done") as { message: AssistantMessage };
    const text = done.message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("abababababab");
  });

  it("QODER_STREAM_FLUSH_MS=0 restores per-chunk passthrough", async () => {
    process.env.QODER_STREAM_FLUSH_MS = "0";
    globalThis.fetch = mockFetch(manyTextChunks(6, "ab"));
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.filter((e) => e.type === "text_delta").length).toBe(6);
  });

  it("flushes a pending delta before structural events so ordering survives", async () => {
    process.env.QODER_STREAM_FLUSH_MS = "50";
    const sse =
      sseEnvelope(chunk({ reasoning_content: "th", role: "assistant" })) +
      sseEnvelope(chunk({ reasoning_content: "in", role: "assistant" })) +
      sseEnvelope(chunk({ content: "te", role: "assistant" })) +
      sseEnvelope(chunk({ content: "xt", role: "assistant" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    expect(events.map((e) => e.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "done",
    ]);
    const done = events[events.length - 1] as { message: AssistantMessage };
    expect(done.message.content.map((c) => ("thinking" in c ? c.thinking : "text" in c ? c.text : ""))).toEqual([
      "thin",
      "text",
    ]);
  });

  it("caps a merged delta so a long burst stays bounded", async () => {
    process.env.QODER_STREAM_FLUSH_MS = "5000";
    const piece = "x".repeat(500);
    globalThis.fetch = mockFetch(manyTextChunks(12, piece));
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const textDeltas = events.filter((e) => e.type === "text_delta");
    // 6000 chars against the merge cap needs more than one flush even with a
    // huge window, so a stuck timer cannot grow one event without bound.
    expect(textDeltas.length).toBeGreaterThan(1);
    const done = events.find((e) => e.type === "done") as { message: AssistantMessage };
    const text = done.message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text.length : 0).toBe(6000);
  }, 20_000);
});
