import type { Api, AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDegenerateDsmlTurn, stripDsmlResidue, stripThinkingTags, ThinkingTagParser } from "../thinking-parser.js";

function createMockStream() {
  const events: AssistantMessageEvent[] = [];
  const push = vi.fn((event: AssistantMessageEvent) => events.push(event));
  const stream = {
    push,
    end: vi.fn(),
    [Symbol.iterator]: function* () {},
    [Symbol.asyncIterator]: function* () {},
    events,
  } as unknown as AssistantMessageEventStream;
  return { stream, push, events };
}

function createOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "qoder-api" as Api,
    provider: "qoder",
    model: "test",
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
  } as AssistantMessage;
}

// Fixtures for the markup Qoder's gateway leaks when it fails to turn a
// model's tool-call intent into `tool_calls`. The opening angle bracket is
// written as an escape so these stay single-line string literals.
const INVOKE_CLOSE = "\u003C/invoke>";
const PARAM_CLOSE = "\u003C/parameter>";
const FUNCTION_CALL_CLOSE = "\u003C/function_call>";
const DSML_CLOSE = "\u003C/｜DSML｜invoke｜>";

describe("stripDsmlResidue", () => {
  it("removes every leaked tool-call tag form", () => {
    const leaked = `Calling it now.${INVOKE_CLOSE}${PARAM_CLOSE}${FUNCTION_CALL_CLOSE}${DSML_CLOSE}`;
    expect(stripDsmlResidue(leaked)).toBe("Calling it now.");
  });

  it("collapses the blank lines the markup leaves behind", () => {
    expect(stripDsmlResidue(`a\n\n${INVOKE_CLOSE}\n\nb`)).toBe("a\n\nb");
  });

  it("leaves prose untouched", () => {
    expect(stripDsmlResidue("I should invoke the tool later.")).toBe("I should invoke the tool later.");
  });

  it("survives the repeated-tag burst seen in the wild", () => {
    expect(stripDsmlResidue(INVOKE_CLOSE.repeat(40))).toBe("");
  });
});

describe("isDegenerateDsmlTurn", () => {
  const turn = (blocks: Array<{ type: "text"; text: string }>, stopReason: AssistantMessage["stopReason"]) => {
    const message = createOutput();
    message.content = blocks;
    message.stopReason = stopReason;
    return message;
  };

  it("flags the no-text no-tool-call turn whose reasoning ends in leaked markup", () => {
    expect(isDegenerateDsmlTurn(turn([], "stop"), `thinking${INVOKE_CLOSE}${PARAM_CLOSE}`)).toBe(true);
  });

  it("does not flag a single literal tag inside normal reasoning", () => {
    expect(isDegenerateDsmlTurn(turn([], "stop"), `thinking ${INVOKE_CLOSE} then more prose`)).toBe(false);
  });

  it("never flags a turn that produced text", () => {
    expect(
      isDegenerateDsmlTurn(turn([{ type: "text", text: "an answer" }], "stop"), `x${INVOKE_CLOSE}${INVOKE_CLOSE}`),
    ).toBe(false);
  });

  it("never flags a turn that did execute a tool call", () => {
    expect(isDegenerateDsmlTurn(turn([], "toolUse"), `x${INVOKE_CLOSE}${INVOKE_CLOSE}`)).toBe(false);
  });
});

describe("ThinkingTagParser", () => {
  let output: AssistantMessage;
  let stream: AssistantMessageEventStream;
  let pushMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    output = createOutput();
    const mock = createMockStream();
    stream = mock.stream;
    pushMock = mock.push;
  });

  // ── Plain text (no thinking tags) ─────────────────────────────────────

  it("passes plain text through without modification", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello world");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "text", text: "Hello world" });
  });

  it("handles empty input", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.finalize();
    expect(output.content).toHaveLength(0);
  });

  // ── Standard <thinking> tags ──────────────────────────────────────────

  it("extracts thinking content from <thinking> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <thinking>reasoning here</thinking> world");
    parser.finalize();

    // Parser inserts thinking block before existing text via splice, then creates a new text block after
    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "reasoning here" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles thinking-only content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>just thinking</thinking>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "just thinking" });
  });

  // ── Alternative tag variants ──────────────────────────────────────────

  it("handles <think> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <think>reasoning</think> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "reasoning" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles <reasoning> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<reasoning>deep thought</reasoning>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "deep thought" });
  });

  it("handles <thought> tags", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thought>pondering</thought>");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "pondering" });
  });

  // ── Chunked streaming ─────────────────────────────────────────────────

  it("handles thinking content split across multiple chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <thin");
    parser.processChunk("king>part1 ");
    parser.processChunk("part2</think");
    parser.processChunk("ing> world");
    parser.finalize();

    expect(output.content).toHaveLength(3);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "part1 part2" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "Hello " });
    expect(output.content[2]).toMatchObject({ type: "text", text: " world" });
  });

  it("handles open tag split across chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("text <thin");
    parser.processChunk("king>body</thinking>");
    parser.finalize();

    expect(output.content).toHaveLength(2);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "body" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "text " });
  });

  // ── Multiple thinking blocks ──────────────────────────────────────────

  it("handles multiple thinking blocks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>first</thinking> text <thinking>second</thinking>");
    parser.finalize();

    // After first thinking block, the parser is in "thinkingExtracted" state
    // and emits remaining text. The second <thinking> tag is in the post-thinking
    // text buffer and gets emitted as plain text (parser doesn't re-enter thinking).
    expect(output.content.length).toBeGreaterThanOrEqual(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "first" });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it("handles text ending with partial tag prefix", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hello <think");
    // Don't finalize yet — the parser should hold back "<think" as potential tag
    // But finalize should flush it as text
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks.length).toBeGreaterThanOrEqual(1);
    const allText = textBlocks.map((c) => (c as { type: string; text: string }).text).join("");
    expect(allText).toContain("Hello");
    expect(allText).toContain("<think");
  });

  it("strips trailing newline after closing tag", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>thought</thinking>\n\nActual text");
    parser.finalize();

    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "thought" });
    expect(output.content[1]).toMatchObject({ type: "text", text: "Actual text" });
  });

  // ── getTextBlockIndex ─────────────────────────────────────────────────

  it("tracks text block index correctly", () => {
    const parser = new ThinkingTagParser(output, stream);
    expect(parser.getTextBlockIndex()).toBeNull();

    parser.processChunk("Hello");
    expect(parser.getTextBlockIndex()).toBe(0);

    parser.processChunk("<thinking>thought</thinking>");
    parser.processChunk(" World");
    expect(parser.getTextBlockIndex()).not.toBeNull();
  });

  // ── Stream events ─────────────────────────────────────────────────────

  it("emits text_start and text_delta events for plain text", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("Hi");
    parser.finalize();

    const eventTypes = pushMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("text_start");
    expect(eventTypes).toContain("text_delta");
  });

  it("emits thinking_start and thinking_delta events for thinking content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>deep</thinking>");
    parser.finalize();

    const eventTypes = pushMock.mock.calls.map((c) => c[0].type);
    expect(eventTypes).toContain("thinking_start");
    expect(eventTypes).toContain("thinking_delta");
    expect(eventTypes).toContain("thinking_end");
  });

  // ── Finalize with remaining buffer ────────────────────────────────────

  it("finalize flushes remaining text when not in thinking mode", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("partial");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "text", text: "partial" });
  });

  it("finalize flushes remaining thinking when in thinking mode", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>unfinished");
    parser.finalize();

    expect(output.content).toHaveLength(1);
    expect(output.content[0]).toMatchObject({ type: "thinking", thinking: "unfinished" });
  });

  // ── Orphan closing tags (opener arrived via reasoning_content) ─────────
  // Regression: Qoder's backend splits one `<thinking>...</thinking>` pair
  // across two SSE fields — opener+reasoning into `reasoning_content`, closer
  // +answer into `content`. The closer has no opener in the content stream, so
  // it must be dropped instead of leaking into visible text.

  it("drops an orphan closing tag at the start of content", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</thinking>\n\n让我查一下这个选项");
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    const text = (textBlocks[0] as { type: string; text: string }).text;
    expect(text).toBe("让我查一下这个选项");
    expect(text).not.toContain("</thinking>");
    expect(output.content.some((c) => c.type === "thinking")).toBe(false);
  });

  it("drops an orphan closer split across stream chunks", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</think");
    parser.processChunk("ing>\n\nanswer");
    parser.finalize();

    const textBlocks = output.content.filter((c) => c.type === "text");
    expect(textBlocks).toHaveLength(1);
    const text = (textBlocks[0] as { type: string; text: string }).text;
    expect(text).toBe("answer");
    expect(text).not.toContain("</thinking>");
    expect(text).not.toContain("</think");
  });

  it("drops an orphan closer for the <reasoning> variant too", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("</reasoning>\n\nresult");
    parser.finalize();

    const text = (output.content.find((c) => c.type === "text") as { type: string; text: string })?.text ?? "";
    expect(text).toBe("result");
    expect(text).not.toContain("</reasoning>");
  });

  it("emits text before an orphan closer, then drops the closer", () => {
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("intro</thinking>\n\noutro");
    parser.finalize();

    const text = (output.content.find((c) => c.type === "text") as { type: string; text: string })?.text ?? "";
    expect(text).not.toContain("</thinking>");
    expect(text).toContain("intro");
    expect(text).toContain("outro");
  });

  // ── stripThinkingTags helper ───────────────────────────────────────────

  it("stripThinkingTags removes opening and closing tag variants", () => {
    expect(stripThinkingTags("<thinking>hello</thinking>")).toBe("hello");
    expect(stripThinkingTags("<reasoning>deep</reasoning>")).toBe("deep");
    expect(stripThinkingTags("plain text")).toBe("plain text");
    expect(stripThinkingTags("<thinking>")).toBe("");
    expect(stripThinkingTags("</thinking>")).toBe("");
  });
});
