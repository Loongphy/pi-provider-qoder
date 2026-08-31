import crypto from "node:crypto";
import * as PiAi from "@earendil-works/pi-ai";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  clampThinkingLevel,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  buildAuthHeaders,
  getMachineId,
  getQoderChatURL,
  getQoderMode,
  getQoderQueueStatusURL,
  getQoderUserEmailFallback,
  isQoderCNMode,
} from "./cosy.js";
import { getCachedModelConfig, MAX_OUTPUT_TOKENS } from "./models.js";
import { getCachedCredentials } from "./oauth.js";
import { qoderEncodeBody } from "./qoder-encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking-parser.js";
import { transformMessagesForQoder, transformTools } from "./transform.js";
import { clearQueueStatus, qoderLog, reportQueueStatus } from "./ui.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

/**
 * How long we keep waiting while the upstream keeps us queued.
 *
 * A wall-clock budget rather than an attempt count, identical to qodercli's
 * QODER_MODEL_QUEUE_MAX_WAIT_MS and its default (`PSl = 36e5`, one hour). The
 * budget is also what bounds an unusually large retry hint.
 */
const QODER_QUEUE_MAX_WAIT_MS_DEFAULT = 3_600_000;

function qoderQueueMaxWaitMs(): number {
  const raw = process.env.QODER_MODEL_QUEUE_MAX_WAIT_MS;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return QODER_QUEUE_MAX_WAIT_MS_DEFAULT;
}

interface QoderQueueInfo {
  isQueued?: boolean;
  modelKey?: string;
  queueCount?: number;
  queueType?: string;
  retryAfterSeconds?: number;
  /** Millisecond hints, which qodercli reads BEFORE the seconds field. */
  retry_after_ms?: number;
  retryAfterMs?: number;
  serviceAvailable?: boolean;
  waitTime?: number;
}

/** qodercli's `S3A`: only a real boolean counts; anything else is absent. */
function qoderBool(value: unknown): boolean | undefined {
  return value === true || value === false ? value : undefined;
}

/** qodercli's `bp`: a finite number, or a string of digits. */
function qoderNum(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** qodercli's `VK`: a non-empty trimmed string. */
function qoderStr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * qodercli's `LSl` field normalization: every field goes through a type guard,
 * and junk values become absent rather than being trusted downstream. Without
 * this a gateway that sends `"retryAfterSeconds":"30"` would have its hint
 * silently ignored.
 */
function normalizeQoderQueueInfo(record: Record<string, unknown>): QoderQueueInfo {
  const info: QoderQueueInfo = {
    isQueued: qoderBool(record.isQueued),
    modelKey: qoderStr(record.modelKey),
    queueCount: qoderNum(record.queueCount),
    queueType: qoderStr(record.queueType),
    serviceAvailable: qoderBool(record.serviceAvailable),
    retryAfterSeconds: qoderNum(record.retryAfterSeconds),
    retry_after_ms: qoderNum(record.retry_after_ms),
    retryAfterMs: qoderNum(record.retryAfterMs),
    waitTime: qoderNum(record.waitTime),
  };
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined)) as QoderQueueInfo;
}

/**
 * Qoder signals "the model is saturated, try again later" as a non-200 SSE
 * envelope whose body is a triple-nested JSON string:
 *
 *   {"code":"403","message":"{\"code\":\"10605\",\"message\":\"{...notice...}\"}"}
 *
 * The inner notice carries two shapes we have observed:
 *
 *   isQueued:true  — we are in a queue; `queueCount`/`waitTime` describe the position.
 *   isQueued:false — we were NOT admitted to the queue, but `retryAfterSeconds`
 *                    still says when to re-submit (this is the common shape: {"isQueued":false,"modelKey":"qfmodel","queueCount":0,"queueType":"slow","retryAfterSeconds":2,"serviceAvailable":true,"waitTime":0}).
 *
 * Both are transient back-pressure signals carrying a retry hint, so either one
 * is retryable: the discriminator is the 10605 code, not `isQueued`. Requiring
 * `isQueued` to be true (as an earlier revision did) let the far more common
 * isQueued:false notice fall through as a fatal "Upstream status 403".
 *
 * Returns the parsed notice for a genuine 10605, otherwise null, so unrelated
 * 403s (auth/quota/etc.) keep their original error behavior.
 */
function parseQoderQueueInfo(bodyStr: string): QoderQueueInfo | null {
  try {
    const outer = JSON.parse(bodyStr) as { code?: string | number; message?: string };
    // Normal shape: the transport wraps the notice in a {code:"403"} envelope.
    // An HTTP-level 403 may instead deliver the 10605 layer directly, so accept
    // either nesting depth.
    const mid =
      String(outer.code) === "403"
        ? (JSON.parse(outer.message ?? "") as { code?: string | number; message?: string })
        : outer;
    if (String(mid.code) !== "10605") return null;
    const inner = JSON.parse(mid.message ?? "");
    // A 10605 whose payload we cannot read is not a back-pressure notice.
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return null;
    return normalizeQoderQueueInfo(inner as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * The upstream hint in milliseconds, or undefined when the reply carried none.
 *
 * qodercli reads the fields in this priority order (`mja()`/`qK()`/`XRA()`):
 * an explicit millisecond field (`retry_after_ms`, `retryAfterMs`) wins, then
 * `retryAfterSeconds` scaled by 1000. Both go through `bp()`, so a digit-string
 * hint counts too.
 *
 * The 100ms floor is ours, not qodercli's: a zero/negative hint must not turn
 * the retry budget into a tight loop of full-conversation uploads.
 */
function qoderQueueHintMs(queueInfo: QoderQueueInfo): number | undefined {
  const ms = qoderNum(queueInfo.retry_after_ms) ?? qoderNum(queueInfo.retryAfterMs);
  if (ms !== undefined) return Math.max(100, ms);
  const seconds = qoderNum(queueInfo.retryAfterSeconds);
  return seconds === undefined ? undefined : Math.max(100, seconds * 1000);
}

/** How long to wait before a full re-POST: the hint as-is, 1s when absent. */
function qoderQueueRetryMs(queueInfo: QoderQueueInfo): number {
  return qoderQueueHintMs(queueInfo) ?? 1_000;
}

/**
 * qodercli's `Can()`: the interval between queue-status LOOKs is clamped into
 * [500ms, 30s] (`ySl`/`kSl`), defaulting to 30s (`TSl`) when the reply carries
 * no hint. It applies to POLLING only -- a cheap GET the server is expected to
 * answer often -- so a hint above 30s means "look again in 30s", not "resend
 * early". A re-POST wait keeps the full hint instead (see waitQueueHint).
 */
const QODER_QUEUE_POLL_MIN_MS = 500;
const QODER_QUEUE_POLL_MAX_MS = 30_000;
const QODER_QUEUE_POLL_DEFAULT_MS = 30_000;

function qoderQueuePollMs(queueInfo: QoderQueueInfo): number {
  const hint = qoderQueueHintMs(queueInfo) ?? QODER_QUEUE_POLL_DEFAULT_MS;
  return Math.min(QODER_QUEUE_POLL_MAX_MS, Math.max(QODER_QUEUE_POLL_MIN_MS, hint));
}

/** Consecutive poll failures tolerated before we stop polling (qodercli: 3). */
export const QODER_QUEUE_POLL_MAX_FAILURES = 3;

/**
 * Whether to poll /queue/status while waiting. Enabled by default; set
 * QODER_QUEUE_POLL=0 to go straight back to "sleep the hint, re-POST".
 */
function qoderQueuePollEnabled(): boolean {
  const raw = process.env.QODER_QUEUE_POLL;
  return raw === undefined || !/^(0|false|off)$/i.test(raw.trim());
}

/**
 * Parse the queue-status response. Mirrors qodercli's `queueStatus()` walk:
 * the flags may sit at any depth and may arrive as stringified JSON inside
 * `data`/`result`/`message`/`body`, so breadth-search until a record carries a
 * boolean `isQueued` or `serviceAvailable` (qodercli's LSl accepts exactly
 * those two as the shape marker).
 */
function parseQoderQueueStatus(bodyStr: string): QoderQueueInfo | null {
  let root: unknown;
  try {
    root = JSON.parse(bodyStr);
  } catch {
    return null;
  }

  const seen = new Set<unknown>();
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    // qodercli's `GI`: only plain objects are walked, arrays are skipped.
    if (!node || typeof node !== "object" || Array.isArray(node) || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    // qodercli's `LSl` accepts a record as queue-shaped when either flag is a
    // real boolean, then normalizes every field.
    if (qoderBool(record.isQueued) !== undefined || qoderBool(record.serviceAvailable) !== undefined) {
      return normalizeQoderQueueInfo(record);
    }
    for (const key of ["data", "result", "message", "body"]) {
      const child = record[key];
      if (child && typeof child === "object" && !Array.isArray(child)) {
        queue.push(child);
      } else if (typeof child === "string" && child.length > 0) {
        try {
          queue.push(JSON.parse(child));
        } catch {}
      }
    }
  }
  return null;
}

function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error("Aborted"));
      },
      { once: true },
    );
  });
}

function formatQoderDuration(totalSeconds: number): string {
  const sec = Math.max(0, Math.round(totalSeconds));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return s ? `${m}m${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h}h${mm}m` : `${h}h`;
}

/**
 * What the wait we are about to take actually is:
 * - "watching": sleeping until the next queue-status LOOK (no upload);
 * - "retry": sleeping until the next full re-POST of the conversation;
 * - "ready": the slot opened, resending now.
 */
type QoderQueuePhase = "watching" | "retry" | "ready";

/**
 * The one-line queue status shown in the pi working row and (throttled) on
 * stderr.
 *
 * `remainingMs` is the live part: the caller re-derives it from the wait
 * deadline on every tick, so the countdown counts down instead of sitting
 * frozen at whatever the last notice happened to say.
 */
function formatQoderQueueMessage(
  queueInfo: QoderQueueInfo,
  modelLabel: string,
  waitedMs: number,
  maxWaitMs: number,
  phase: QoderQueuePhase,
  remainingMs: number,
): string {
  const parts: string[] = [`${queueInfo.isQueued ? "Queued" : "Busy"} on ${modelLabel}`];
  if (queueInfo.isQueued && queueInfo.queueCount != null) parts.push(`position ${queueInfo.queueCount}`);
  if (queueInfo.queueType) parts.push(`${queueInfo.queueType} queue`);
  // qodercli reads this field as SECONDS (`_5e()`: `waitTimeMs = 1e3 * waitTime`,
  // reported to telemetry as `queue_server_wait_time_ms`), so we do the same.
  // The one large sample we have (1401187) is then 16 days, which is not a
  // credible queue estimate -- it is far more likely the gateway sends ms. We
  // follow qodercli's unit and suppress anything past 6h, so a unit mismatch
  // degrades to "no estimate" instead of printing a nonsense number.
  const estSec = qoderNum(queueInfo.waitTime);
  if (estSec !== undefined && estSec > 0 && estSec < 6 * 3600) {
    parts.push(`est. wait ~${formatQoderDuration(estSec)}`);
  }
  const budget = `waited ${formatQoderDuration(waitedMs / 1000)}/${formatQoderDuration(maxWaitMs / 1000)}`;
  const left = `${Math.max(0, Math.ceil(remainingMs / 1000))}s`;
  if (phase === "ready") parts.push(`slot free \u00B7 resending in ${left} (${budget})`);
  else if (phase === "watching") parts.push(`check again in ${left} (${budget})`);
  else parts.push(`retry in ${left} (${budget})`);
  return parts.join(" \u00B7 ");
}

/**
 * Report queue status to the dedicated widget row above the editor, and to
 * stderr when logging is enabled.
 *
 * The two sinks are deliberately decoupled: the widget is a status line and is
 * safe to rewrite every second, while stderr is a log that is throttled and,
 * critically, must never be attached to pi's TUI (see ui.ts for why any
 * console.error during streaming smears the whole screen).
 */
function reportQoderQueueStatus(message: string, opts: { log: boolean }): void {
  if (opts.log) qoderLog(message);
  reportQueueStatus(message);
}

/** Remove the queue-status row once we are no longer queued. */
function clearQoderQueueStatus(): void {
  clearQueueStatus();
}

/**
 * Anything that accepts stream events. `AssistantMessageEventStream` satisfies
 * it structurally, and so does the coalescing emitter below.
 */
type QoderEventSink = { push(event: AssistantMessageEvent): void };

const DELTA_EVENT_TYPES = ["thinking_delta", "text_delta", "toolcall_delta"] as const;
type DeltaEventType = (typeof DELTA_EVENT_TYPES)[number];
type DeltaEvent = Extract<AssistantMessageEvent, { type: DeltaEventType }>;

/**
 * Coalesce consecutive content deltas before they reach pi.
 *
 * Qoder's SSE chunks are tiny — measured against the live gateway: ~4.8
 * characters per delta at 29-53 deltas/s, roughly 2-3x finer than what
 * pi's own providers typically deliver. Every content delta becomes a
 * `message_update` that pi handles by rebuilding the streaming assistant
 * component (clear + re-parse the whole accumulated block as Markdown) and
 * scheduling a render, so the cost per update grows with the answer and the
 * UI thread saturates: in a large session, event-loop delay measured
 * p99 ~28-34ms at Qoder's rate versus ~13ms for a coarser provider, which is
 * what users feel as a stuttering TUI.
 *
 * Merging deltas that belong to the same block keeps the delivered text
 * identical while cutting the update count to at most one per `flushMs`, so pi
 * re-renders on its own ~16ms frame budget instead of on every wire chunk.
 * Structural events (start/end/done/error) flush first, so ordering — and
 * therefore the consumer's block state machine — is unchanged.
 */
function createQoderDeltaEmitter(target: QoderEventSink, flushMs: number): QoderEventSink & { flush(): void } {
  let pending: DeltaEvent | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!pending) return;
    const event = pending;
    pending = null;
    target.push(event);
  };

  return {
    push(event: AssistantMessageEvent): void {
      if (flushMs <= 0 || !DELTA_EVENT_TYPES.includes(event.type as DeltaEventType)) {
        flush();
        target.push(event);
        return;
      }
      const delta = event as DeltaEvent;
      if (pending && pending.type === delta.type && pending.contentIndex === delta.contentIndex) {
        pending.delta += delta.delta;
        // Keep memory and end-of-stream latency bounded on a burst.
        if (pending.delta.length >= QODER_MAX_COALESCED_CHARS) flush();
        return;
      }
      flush();
      pending = { ...delta, delta: delta.delta };
      timer = setTimeout(flush, flushMs);
      // A pending flush must never hold the process open.
      timer.unref?.();
    },
    flush,
  };
}

/** Upper bound on a merged delta, so a long burst is still bounded. */
const QODER_MAX_COALESCED_CHARS = 2048;

/**
 * Merge window in ms. 40ms means at most ~25 content updates/s — still well
 * above what reads as smooth streaming, and ~2x fewer updates than the wire
 * rate. `QODER_STREAM_FLUSH_MS=0` restores per-chunk passthrough.
 */
function qoderStreamFlushMs(): number {
  const raw = process.env.QODER_STREAM_FLUSH_MS;
  if (raw === undefined || raw.trim() === "") return 40;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 1000) : 40;
}

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const StreamCtor = (PiAi as unknown as { AssistantMessageEventStream: new () => AssistantMessageEventStream })
    .AssistantMessageEventStream;
  const stream = new StreamCtor();

  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };

  // Merge Qoder's fine-grained wire chunks into at most one content delta per
  // window, so pi rebuilds/renders the streaming message on its own frame
  // budget rather than on every SSE envelope. See createQoderDeltaEmitter.
  const emitter = createQoderDeltaEmitter(stream, qoderStreamFlushMs());

  (async () => {
    try {
      const providerMode = model.provider === "qoder-cn" ? "cn" : getQoderMode();
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error(
          isQoderCNMode(providerMode)
            ? "Qoder CN credentials not set. Run /login qoder-cn or set QODERCN_PERSONAL_ACCESS_TOKEN."
            : "Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.",
        );
      }

      // Resolve user details from cached credentials
      const cachedCreds = getCachedCredentials(accessToken, model.provider);
      const userID = cachedCreds?.userID || "qoder-user";
      const name = cachedCreds?.name || (isQoderCNMode(providerMode) ? "Qoder CN User" : "Qoder User");
      const email = cachedCreds?.email || getQoderUserEmailFallback(providerMode);
      const machineID = cachedCreds?.machineID || getMachineId();

      // The model `id` pi exposes is the upstream display_name (whitespace
      // stripped) for CN, or the raw key for the international site. The
      // request-time upstream `key` is read back from the cached model config
      // (which stores the original entry keyed by both `key` and `id`), so no
      // key<->friendlyId mapping table is needed here.
      const modelConfig = getCachedModelConfig(model.id, providerMode) || {
        key: model.id,
        is_reasoning: false,
        source: "system",
      };
      // Use the cached entry's original upstream key when available; fall back to
      // the pi id (international site already uses the key as id).
      const qoderModel = modelConfig.key || model.id;

      const isReasoning = !!modelConfig.is_reasoning;

      const normalizedMessages = transformMessagesForQoder(context.messages);
      const systemText = context.systemPrompt || "";

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          const content = normalizedMessages[i].content;
          lastUserText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => ("text" in c ? c.text : "")).join("")
                : "";
          break;
        }
      }

      // Use a stable session id when pi provides one (per agent session) so
      // the Qoder server can maintain prompt cache affinity across consecutive
      // requests. Fall back to a random id only when no sessionId is available.
      const stablePart = stableHash("qoder-session", userID, qoderModel);
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : `${stablePart}-${crypto.randomUUID()}`;

      // Qoder's catalog exposes no per-model output cap, so we use the
      // documented upstream ceiling (MAX_OUTPUT_TOKENS = 131072, see models.ts)
      // and let pi cap it lower when the caller sets options.maxTokens (e.g.
      // compaction at 40K). This avoids truncating reasoning chains / long
      // generations that the 32K default would cut off.
      let maxTokens = MAX_OUTPUT_TOKENS;
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      // Map pi's thinking level (options.reasoning) to Qoder's request fields.
      // Confirmed from @qoder-ai/qodercli: the chat body carries `reasoning_effort`
      // ("none"|"low"|"medium"|"high"|"xhigh"|"max") and `enable_thinking` (bool)
      // inside `parameters`, alongside `max_tokens`.
      //
      // This mirrors the pattern the pi-ai OpenAI provider uses: clamp the
      // requested level to what the model advertises via thinkingLevelMap, then
      // map to the upstream effort name. clampThinkingLevel returns "off" when
      // the level is unsupported or the user disabled thinking.
      const requestedLevel = options?.reasoning;
      const clamped = requestedLevel ? clampThinkingLevel(model, requestedLevel) : undefined;
      const reasoningLevel = clamped === "off" ? undefined : clamped;
      const parameters: Record<string, unknown> = { max_tokens: maxTokens };
      if (reasoningLevel) {
        parameters.enable_thinking = true;
        // Effort-based models advertise concrete effort names in the map
        // (low/medium/xhigh/max). Toggle-only models map every level to
        // "enabled"/"disabled" and accept no effort value — only the on/off
        // switch matters, so we send enable_thinking alone.
        const mapped = model.thinkingLevelMap?.[reasoningLevel];
        const effort = mapped && mapped !== "enabled" && mapped !== "disabled" ? mapped : reasoningLevel;
        // Only send reasoning_effort when the upstream model actually exposes
        // effort levels (thinking_config.enabled.efforts).
        if (modelConfig?.thinking_config?.enabled?.efforts && typeof effort === "string") {
          parameters.reasoning_effort = effort;
        }
      } else {
        // No reasoning level selected (or clamped to off): explicitly disable
        // thinking so the model does not reason by default.
        parameters.enable_thinking = false;
      }

      const reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        // Qoder's server ignores the top-level `system` field (verified: the
        // model never sees it). Inject the system prompt as a leading
        // role:system message instead, which the server does honor.
        system: "",
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
        tools: toolsRaw || [],
        parameters,
        chat_context: {
          chatPrompt: "",
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: {
              key: qoderModel,
              is_reasoning: isReasoning,
            },
            originalContent: lastUserText,
          },
          features: [],
          text: lastUserText,
        },
        model_config: modelConfig,
        business: {
          product: "cli",
          version: "1.0.0",
          type: "agent",
          stage: "start",
          id: crypto.randomUUID(),
          name: lastUserText.substring(0, 30),
          begin_at: Date.now(),
        },
      };

      const chatURL = getQoderChatURL(providerMode);
      const cosyCreds = { userID, authToken: accessToken, name, email, machineID };

      /**
       * The body is encoded ONCE and re-sent verbatim on a queue retry, which is
       * what qodercli does: `request_id`/`chat_record_id` are minted per request
       * build (never rotated per retry) and `is_retry` is a constant `false` in
       * its body builder -- the "is_retry" elsewhere in that bundle is telemetry,
       * not the wire field. All a retry needs is a fresh signature: the COSY sig
       * covers a unix timestamp, and qodercli likewise runs prepareRequest() for
       * every HTTP attempt, so a request that waited 30s is signed at send time.
       */
      const bodyBytes = Buffer.from(JSON.stringify(reqBody));
      const encodedBytes = Buffer.from(qoderEncodeBody(bodyBytes), "utf8");
      const signAttempt = () => buildAuthHeaders(encodedBytes, chatURL, cosyCreds);

      const modelSource = modelConfig.source || "system";

      // The stream "start" event is emitted lazily on the first real data
      // envelope so that queue retries (which re-issue the request before any
      // content is produced) do not emit a premature start.
      let streamStarted = false;
      let queueWaitStartedAt = 0;
      let retryQueued = false;

      // Retrying is only safe before anything reached the consumer: once a
      // block (text/thinking/tool call) exists, a re-submit would duplicate it.
      const canRetryQueue = (): boolean => !streamStarted && output.content.length === 0;

      // Wall-clock budget instead of an attempt cap, like the upstream CLI.
      // `queueBudgetExhausted` latches the moment a wait has slept the budget
      // down to its edge: without it, a wait that ends within a millisecond of
      // the deadline can still see a positive remaining budget and buy one more
      // full re-upload of the conversation before the notice site gives up.
      let queueBudgetExhausted = false;
      const queueBudgetSpent = (): boolean =>
        queueWaitStartedAt > 0 && (queueBudgetExhausted || Date.now() - queueWaitStartedAt >= qoderQueueMaxWaitMs());

      const queueWaitedMs = (): number => (queueWaitStartedAt === 0 ? 0 : Date.now() - queueWaitStartedAt);
      const queueRemainingMs = (): number => qoderQueueMaxWaitMs() - queueWaitedMs();

      /**
       * How often the working row is re-rendered while we wait. The countdown
       * is shown in whole seconds, so anything slower makes the line look
       * frozen — which is exactly the "retry in 30s never moves" complaint.
       * The TUI already re-renders on its own spinner frames, so one extra
       * requestRender per second is free.
       */
      const QUEUE_TICK_MS = 1_000;
      /** stderr is not a status line: only log on a real change, or heartbeat. */
      const QUEUE_LOG_MIN_INTERVAL_MS = 15_000;

      let lastLogKey = "";
      let lastLoggedAt = 0;

      /**
       * The pi-visible model name for an upstream key -- what /model shows
       * (`display_name`), not the raw gateway key. The catalog cache is indexed
       * by both the upstream key and the pi id, so a lookup by key lands either
       * way; without an entry the key itself is the honest fallback.
       *
       * Memoized per key: the cache file is re-read on every miss, and the
       * status line ticks once a second.
       */
      let lastModelLabel: { key: string; label: string } | undefined;
      const modelLabelFor = (key: string | undefined): string => {
        if (!key) return "model";
        if (lastModelLabel?.key === key) return lastModelLabel.label;
        const label = getCachedModelConfig(key, providerMode)?.display_name || key;
        lastModelLabel = { key, label };
        return label;
      };

      /**
       * Push one status line to the working row. The stderr copy is written only
       * when the line actually says something new (phase or position moved) or
       * every QUEUE_LOG_MIN_INTERVAL_MS, so a long wait is not silent without
       * turning the log into a countdown.
       */
      const renderQueue = (info: QoderQueueInfo, phase: QoderQueuePhase, remainingMs: number): void => {
        const message = formatQoderQueueMessage(
          info,
          modelLabelFor(info.modelKey),
          queueWaitedMs(),
          qoderQueueMaxWaitMs(),
          phase,
          remainingMs,
        );
        const key = `${phase}|${info.isQueued}|${info.queueCount ?? ""}|${info.serviceAvailable}`;
        const now = Date.now();
        const log = key !== lastLogKey || now - lastLoggedAt >= QUEUE_LOG_MIN_INTERVAL_MS;
        if (log) {
          lastLogKey = key;
          lastLoggedAt = now;
        }
        reportQoderQueueStatus(message, { log });
      };

      /**
       * Wait out the advertised hint, ticking the status line as we go.
       *
       * One long sleep used to mean one render: the line went out carrying the
       * full hint and then sat unchanged for the whole wait, so "retry in 30s"
       * and a stale "position 450" read as a hung request. Sleeping in slices of
       * at most one tick re-renders every second (fresh countdown, fresh elapsed
       * budget) and keeps the wait interruptible, since each slice re-checks the
       * abort signal.
       *
       * Never sleeps past the retry budget: a spent budget degenerates into one
       * final attempt that the notice site rejects with the original error.
       */
      const waitQueueHint = async (info: QoderQueueInfo, phase: QoderQueuePhase): Promise<void> => {
        // "watching" sleeps until the next queue-status LOOK, which qodercli
        // clamps into [500ms, 30s] via `Can()`; "ready"/"retry" sleep until a
        // full re-POST, which honors the hint as-is because the body is the
        // whole conversation -- clamping it would upload early.
        const hint = phase === "watching" ? qoderQueuePollMs(info) : qoderQueueRetryMs(info);
        const remainingBudget = Math.max(0, queueRemainingMs());
        const total = Math.min(hint, remainingBudget);
        // Sleeping the budget down to its edge spends it: latch it so the notice
        // site surfaces the original upstream error on the next resend instead
        // of racing the clock into another full upload.
        if (total >= remainingBudget) queueBudgetExhausted = true;
        const deadline = Date.now() + total;
        renderQueue(info, phase, total);
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleepMs(Math.min(QUEUE_TICK_MS, remaining), options?.signal);
          renderQueue(info, phase, Math.max(0, deadline - Date.now()));
        }
      };

      /**
       * One GET on the queue-status endpoint (no body: the signature covers an
       * empty one, same convention as the signed model-catalog request).
       *
       * Returns the parsed flags, or null when the endpoint cannot serve us --
       * 404 (a deployment without it), 401/403 (we cannot refresh the token
       * from the stream layer) or a body with no queue flags. Anything else
       * throws so the caller can count transient failures.
       */
      const fetchQueueStatus = async (info: QoderQueueInfo): Promise<QoderQueueInfo | null> => {
        const url = getQoderQueueStatusURL(providerMode, {
          requestSetID: recordID,
          modelKey: info.modelKey || qoderModel,
          queueType: info.queueType,
        });
        const response = await fetch(url, {
          method: "GET",
          headers: { Accept: "application/json", ...buildAuthHeaders(null, url, cosyCreds) },
          signal: options?.signal,
        });
        const text = await response.text().catch(() => "");
        if (response.status === 401 || response.status === 403 || response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // A body we cannot read is treated like an unusable endpoint rather than
        // a retryable failure: the flags are the whole point of the call.
        return parseQoderQueueStatus(text);
      };

      /**
       * Wait out the queue by polling it instead of re-POSTing the conversation.
       *
       * The queue notice's `retryAfterSeconds` only says how long until the next
       * LOOK; the slot being free is what authorizes the resend (qodercli's
       * `hLl`: on `isQueued === false` it sleeps the ready hint once and only
       * then returns to the caller). Queueing runs for minutes and our request
       * body is the entire conversation -- measured up to 14.7MB -- so waiting
       * by resend would upload it again every few seconds, while waiting by poll
       * costs a handful of tiny GETs.
       *
       * "ready" means the slot opened and the ready hint has been slept, so the
       * caller may re-send. "stop-polling" means the poll route is not usable
       * (or the budget ran out) and the caller should degrade to a plain
       * hint-length wait before re-sending: a missing or broken queue API must
       * not turn a recoverable back-pressure notice into a failed turn.
       */
      const pollQueueUntilSlotOpens = async (
        notice: QoderQueueInfo,
      ): Promise<{ outcome: "ready" | "stop-polling"; info: QoderQueueInfo }> => {
        let latest: QoderQueueInfo = notice;
        let failures = 0;
        while (!queueBudgetSpent() && queueRemainingMs() > 0) {
          try {
            const status = await fetchQueueStatus(latest);
            if (!status) return { outcome: "stop-polling", info: latest };
            failures = 0;
            // Carry the identifying fields forward: a status reply that omits
            // them would otherwise make the line lose the model it is waiting on.
            latest = {
              ...status,
              modelKey: status.modelKey || latest.modelKey,
              queueType: status.queueType || latest.queueType,
            };
            if (status.isQueued === false) {
              await waitQueueHint(latest, "ready");
              return { outcome: "ready", info: latest };
            }
          } catch (e) {
            if (options?.signal?.aborted) throw e;
            failures++;
            if (failures >= QODER_QUEUE_POLL_MAX_FAILURES) {
              const reason = e instanceof Error ? e.message : String(e);
              qoderLog(`queue status polling disabled after ${failures} failures: ${reason}`);
              return { outcome: "stop-polling", info: latest };
            }
          }
          // Still queued, the service says it is unavailable, or the look just
          // failed: sleep the hint and look again.
          await waitQueueHint(latest, "watching");
        }
        return { outcome: "stop-polling", info: latest };
      };

      const doQueueRetry = async (queueInfo: QoderQueueInfo): Promise<void> => {
        if (queueWaitStartedAt === 0) queueWaitStartedAt = Date.now();
        let latest = queueInfo;

        // Say what the notice said the moment it lands, before the first look:
        // the notice carries the position and the `waitTime` estimate, which a
        // status reply may not repeat. qodercli renders the current state at the
        // top of every loop iteration for the same reason.
        renderQueue(
          latest,
          qoderQueuePollEnabled() ? "watching" : "retry",
          qoderQueuePollEnabled() ? qoderQueuePollMs(latest) : qoderQueueRetryMs(latest),
        );

        if (qoderQueuePollEnabled()) {
          const polled = await pollQueueUntilSlotOpens(latest);
          latest = polled.info;
          if (polled.outcome === "ready") {
            retryQueued = true;
            return;
          }
        }

        // No poll route (or polling off): wait the hint and re-send. The wait is
        // capped by the remaining budget, so a spent budget degenerates into one
        // final attempt that the notice site rejects with the original error.
        await waitQueueHint(latest, "retry");
        retryQueued = true;
      };

      const decoder = new TextDecoder();
      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCallsState: ToolCallState[] = [];

      const thinkingEnabled = (options?.reasoning as unknown) !== false && (options?.reasoning as unknown) !== "off";
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, emitter) : null;

      do {
        retryQueued = false;
        const response = await fetch(chatURL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            "Cache-Control": "no-cache",
            "Accept-Encoding": "identity",
            "X-Model-Key": qoderModel,
            "X-Model-Source": modelSource,
            ...signAttempt(),
          },
          body: encodedBytes,
          signal: options?.signal,
        });

        if (!response.ok) {
          // A gateway that hangs up mid-body makes `text()` reject with
          // undici's `TypeError: terminated`. An empty body still lets the
          // queue check below run, and otherwise yields the same 403 error.
          const errText = await response.text().catch(() => "");
          // The same back-pressure notice can arrive as a real HTTP status
          // instead of an SSE envelope; only a genuine 10605 is retryable.
          const httpQueueInfo = response.status === 403 ? parseQoderQueueInfo(errText) : null;
          if (httpQueueInfo && canRetryQueue() && !queueBudgetSpent()) {
            await doQueueRetry(httpQueueInfo);
            continue;
          }
          throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");
        let buffer = "";

        // Set as soon as the stream itself tells us it is over (`[DONE]`) or
        // that we should come back later (a queue notice). See readChunk.
        let bodySpent = false;

        /**
         * One body read.
         *
         * Qoder's gateway routinely drops the socket right after writing a
         * queue notice, and undici reports a truncated body as `TypeError:
         * terminated`. Because the notice only used to `break` out of the LINE
         * loop, we went straight back to `reader.read()` on that dead body and
         * the rejection escaped as a failed turn — the "Error: terminated" that
         * shows up a few times before a queued request really resumes, with the
         * throw also discarding the recoverable notice we had just parsed.
         *
         * Once the body has said it is spent we are abandoning it anyway, so
         * its death is not our error.
         */
        const readChunk = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
          try {
            return await reader.read();
          } catch (e) {
            if (bodySpent) return { done: true };
            throw e;
          }
        };

        readLoop: while (true) {
          const chunk = await readChunk();
          if (chunk.done || chunk.value === undefined) break;

          buffer += decoder.decode(chunk.value, { stream: true });

          while (true) {
            const lineEnd = buffer.indexOf("\n");
            if (lineEnd === -1) break;

            const line = buffer.substring(0, lineEnd).trim();
            buffer = buffer.substring(lineEnd + 1);

            if (!line.startsWith("data:")) continue;

            const dataStr = line.substring(5).trim();
            if (dataStr === "[DONE]") {
              bodySpent = true;
              break;
            }

            try {
              const envelope = JSON.parse(dataStr);
              if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
                // Qoder returns a 403/10605 back-pressure notice when the
                // upstream model is saturated. If nothing has reached the
                // consumer yet, wait the advertised retry interval and
                // re-submit instead of failing the turn. This covers both
                // isQueued:true (in the slow queue) and isQueued:false
                // (refused a slot, "come back in N seconds").
                const queueInfo = parseQoderQueueInfo(envelope.body);
                if (queueInfo && canRetryQueue() && !queueBudgetSpent()) {
                  await doQueueRetry(queueInfo);
                  // Leave the whole read loop, not just the line loop: the
                  // response is finished as far as we are concerned, and the
                  // do-while below re-submits it.
                  bodySpent = true;
                  break readLoop;
                }
                throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
              }

              if (!streamStarted) {
                streamStarted = true;
                clearQoderQueueStatus();
                emitter.push({ type: "start", partial: output });
              }

              const innerStr = envelope.body;
              // Qoder wraps the terminator in an envelope (`body:"[DONE]"`), so
              // the `dataStr === "[DONE]"` test above never matches it: the
              // inner body is what says the stream is over.
              if (innerStr === "[DONE]") bodySpent = true;
              if (!innerStr || innerStr === "[DONE]") continue;

              const inner = JSON.parse(innerStr);
              if (inner.id) output.responseId = inner.id as string;
              if (inner.model) output.responseModel = inner.model as string;
              if (inner.usage) {
                const u = inner.usage as {
                  prompt_tokens?: number;
                  completion_tokens?: number;
                  total_tokens?: number;
                  completion_tokens_details?: { reasoning_tokens?: number };
                  prompt_tokens_details?: {
                    cacheable_tokens?: number;
                    cached_tokens?: number;
                    cache_write_tokens?: number;
                  };
                };
                // pi-core computes `promptTokens = input + cacheRead + cacheWrite`
                // (Anthropic convention: `input` EXCLUDES cached/written tokens).
                // Qoder follows OpenAI semantics where `prompt_tokens` INCLUDES
                // `cached_tokens`, so subtract cacheRead (and cache_write_tokens
                // when reported) to match the contract pi-ai's own OpenAI
                // provider uses. `cacheable_tokens` is a capacity metric, not a
                // write count (it is 0 even on first-turn writes), so it is NOT
                // mapped to cacheWrite.
                const promptTokens = u.prompt_tokens ?? 0;
                const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
                const cacheWriteTokens = u.prompt_tokens_details?.cache_write_tokens ?? 0;
                output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
                output.usage.output = u.completion_tokens ?? 0;
                output.usage.totalTokens = u.total_tokens ?? 0;
                output.usage.cacheRead = cacheReadTokens;
                output.usage.cacheWrite = cacheWriteTokens;
              }
              if (inner.choices && inner.choices.length > 0) {
                const choice = inner.choices[0];
                const delta = choice.delta;

                if (delta) {
                  // 1. Process reasoning/thinking content (API reasoning)
                  if (delta.reasoning_content) {
                    // Qoder's backend sometimes routes a literal `<thinking>`
                    // opener into reasoning_content (with the matching
                    // `</thinking>` closer landing in the content stream). Strip
                    // tag artifacts so the thinking block stays clean, matching
                    // the SDK's ContentBlock model.
                    const reasoningChunk = stripThinkingTags(delta.reasoning_content);
                    if (reasoningChunk) {
                      if (thinkingBlockIndex === -1) {
                        thinkingBlockIndex = output.content.length;
                        output.content.push({ type: "thinking", thinking: "" });
                        emitter.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                      }
                      const block = output.content[thinkingBlockIndex] as ThinkingContent;
                      block.thinking += reasoningChunk;
                      emitter.push({
                        type: "thinking_delta",
                        contentIndex: thinkingBlockIndex,
                        delta: reasoningChunk,
                        partial: output,
                      });
                    }
                  }

                  // 2. Process text content
                  if (delta.content) {
                    // End API thinking block if active
                    if (thinkingBlockIndex !== -1) {
                      const block = output.content[thinkingBlockIndex] as ThinkingContent;
                      emitter.push({
                        type: "thinking_end",
                        contentIndex: thinkingBlockIndex,
                        content: block.thinking,
                        partial: output,
                      });
                      thinkingBlockIndex = -1;
                    }

                    if (thinkingParser) {
                      thinkingParser.processChunk(delta.content);
                    } else {
                      if (contentBlockIndex === -1) {
                        contentBlockIndex = output.content.length;
                        output.content.push({ type: "text", text: "" });
                        emitter.push({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
                      }
                      const block = output.content[contentBlockIndex] as TextContent;
                      block.text += delta.content;
                      emitter.push({
                        type: "text_delta",
                        contentIndex: contentBlockIndex,
                        delta: delta.content,
                        partial: output,
                      });
                    }
                  }

                  // 3. Process tool calls
                  if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                    for (const tc of delta.tool_calls) {
                      const idx = tc.index ?? 0;
                      if (!toolCallsState[idx]) {
                        toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0 };
                      }
                      const state = toolCallsState[idx];
                      if (tc.id) state.id = tc.id;
                      if (tc.function?.name) state.name = tc.function.name;

                      // Open the block as soon as the call is IDENTIFIABLE, not
                      // when its first argument byte arrives. A call whose
                      // arguments are absent or an empty string — a no-argument
                      // tool, or a model that sends id+name and then stops — used
                      // to create a toolCallsState entry and no content block, so
                      // the finalizer below saw a non-empty state array, set
                      // stopReason "toolUse", and handed back a message with no
                      // tool call in it. The agent loop then had nothing to run
                      // and the turn simply ended, mid-task and without an error.
                      if (state.emittedStart === undefined && (state.id || state.name)) {
                        state.emittedStart = true;
                        state.contentIndex = output.content.length;
                        output.content.push({
                          type: "toolCall",
                          id: state.id,
                          name: state.name,
                          arguments: {},
                        } satisfies ToolCall);
                        emitter.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
                      }

                      // id and name can arrive after the block is open; keep it
                      // in step, since the finalizer only rewrites `arguments`.
                      if (state.emittedStart) {
                        const block = output.content[state.contentIndex] as ToolCall;
                        block.id = state.id;
                        block.name = state.name;
                      }

                      if (tc.function?.arguments) {
                        const argDelta = tc.function.arguments;
                        state.arguments += argDelta;
                        emitter.push({
                          type: "toolcall_delta",
                          contentIndex: state.contentIndex,
                          delta: argDelta,
                          partial: output,
                        });
                      }
                    }
                  }
                }

                if (choice.finish_reason) {
                  // Preserve the real upstream finish_reason (e.g. "length",
                  // "content_filter") instead of forcing "stop" later.
                  output.stopReason = choice.finish_reason as AssistantMessage["stopReason"];
                }
              }
            } catch (e) {
              // A single malformed SSE line shouldn't kill the stream — skip it.
              // But a genuine upstream error (thrown below) must propagate to the
              // outer catch and surface as stopReason="error", not be swallowed.
              if (e instanceof SyntaxError) {
                if (process.env.QODER_DEBUG) {
                  qoderLog(`skipping malformed SSE line: ${dataStr.slice(0, 200)}`);
                }
                continue;
              }
              throw e;
            }
          }
        }

        // Hand the socket back before re-submitting: undici will not pool a
        // connection whose body was never drained, and a queued gateway usually
        // closes it right after the notice anyway. A body that already errored
        // makes cancel() reject, which is expected here.
        if (retryQueued) await reader.cancel().catch(() => {});
      } while (retryQueued);

      if (thinkingParser) {
        thinkingParser.finalize();
      }

      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        emitter.push({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }

      for (const state of toolCallsState) {
        if (state?.emittedStart && !state.emittedEnd) {
          state.emittedEnd = true;
          let args = {};
          try {
            args = JSON.parse(state.arguments || "{}");
          } catch {}
          const block = output.content[state.contentIndex] as ToolCall;
          block.arguments = args;
          emitter.push({
            type: "toolcall_end",
            contentIndex: state.contentIndex,
            toolCall: {
              type: "toolCall",
              id: state.id,
              name: state.name,
              arguments: args,
            },
            partial: output,
          });
        }
      }

      // Guarded on blocks that actually reached the message, not on the state
      // array being non-empty. Claiming "toolUse" for a message carrying no
      // tool call is what turned a malformed stream into a silent dead end.
      if (toolCallsState.some((state) => state?.emittedStart)) {
        output.stopReason = "toolUse";
      }
      // Otherwise keep whatever finish_reason set upstream (defaults to "stop").
      // Never overwrite a meaningful finish_reason ("length", "content_filter",
      // ...) with "stop".
      emitter.push({
        type: "done",
        reason: output.stopReason as Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
        message: output,
      });
      stream.end();
    } catch (e: unknown) {
      clearQoderQueueStatus();
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      emitter.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    }
  })();

  return stream;
}
