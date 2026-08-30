/**
 * Queue waiting against a REAL socket.
 *
 * The mocked suite in stream.test.ts can assert that a `read()` rejection is
 * handled, but it cannot prove how undici actually behaves: what a truncated
 * body really throws, and whether `reader.cancel()` on that errored stream
 * settles instead of hanging once we walk away from it mid-answer. Both are
 * exactly what the queue path depends on, so this file exercises them over
 * loopback HTTP with the stock fetch.
 */
import http from "node:http";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { streamQoder } from "../stream.js";

/** Minimal SSE envelope, identical in shape to the gateway's. */
function sseEnvelope(body: object, statusCodeValue = 200): string {
  const envelope = {
    headers: { "Content-Type": ["application/json"] },
    body: JSON.stringify(body),
    statusCodeValue,
  };
  return `data:${JSON.stringify(envelope)}\n\n`;
}

const QUEUED_SSE = sseEnvelope(
  {
    code: "403",
    message: JSON.stringify({
      code: "10605",
      message: JSON.stringify({
        isQueued: true,
        modelKey: "qmodel_preview",
        queueCount: 450,
        queueType: "slow",
        retryAfterSeconds: 0,
        serviceAvailable: true,
        waitTime: 0,
      }),
    }),
  },
  403,
);

const SUCCESS_SSE =
  sseEnvelope({ choices: [{ delta: { content: "OK" } }], id: "x" }) +
  sseEnvelope({ choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
  // Built literally: `JSON.stringify("[DONE]")` would wrap the marker in another
  // layer of quotes and the stream would never recognise it as the terminator.
  `data:${JSON.stringify({
    headers: { "Content-Type": ["application/json"] },
    body: "[DONE]",
    statusCodeValue: 200,
  })}\n\n`;

function makeModel(): Model<Api> {
  return { id: "ultimate", api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): Context {
  return { systemPrompt: "test", messages: [{ role: "user", content: "hi" }], tools: [] } as unknown as Context;
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("queue waiting over a real socket", () => {
  const originalFetch = globalThis.fetch;
  let server: http.Server | undefined;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    const closing = server;
    server = undefined;
    if (closing) await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  /** Serve `handler` on an ephemeral loopback port and point the provider at it. */
  async function serve(handler: http.RequestListener): Promise<void> {
    server = http.createServer(handler);
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as { port: number }).port;
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) =>
      realFetch(String(input).replace("https://api3.qoder.sh/", `http://127.0.0.1:${port}/`), init)) as typeof fetch;
  }

  it("survives a gateway that writes the queue notice and then hangs up", async () => {
    // The production shape behind "Error: terminated": the gateway writes the
    // 10605 notice and drops the connection without terminating the response.
    // It used to fail the turn on every queued attempt, discarding the
    // recoverable notice and leaving pi's outer retry to re-upload the whole
    // conversation on its own backoff.
    let chats = 0;
    await serve((req, res) => {
      if (req.url?.includes("queue/status")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { isQueued: false, retryAfterSeconds: 0 } }));
        return;
      }
      chats++;
      if (chats > 1) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(SUCCESS_SSE);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(QUEUED_SSE);
      setTimeout(() => res.destroy(), 10);
    });

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    expect(err, `unexpected error: ${JSON.stringify(err ?? {}, null, 2)}`).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done, "the conversation must survive the dead socket and be re-sent").toBeDefined();
    expect((done as { message: AssistantMessage }).message.stopReason).toBe("stop");
  }, 20_000);

  it("survives a gateway that completes the answer and then hangs up", async () => {
    // Same dead socket, but after a finished answer: the message is complete,
    // so the turn must end normally instead of surfacing a transport error.
    await serve((req, res) => {
      if (req.url?.includes("queue/status")) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(SUCCESS_SSE);
      setTimeout(() => res.destroy(), 10);
    });

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));

    const err = events.find((e) => e.type === "error");
    expect(err, `unexpected error: ${JSON.stringify(err ?? {}, null, 2)}`).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const text = (done as { message: AssistantMessage }).message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  }, 20_000);
});
