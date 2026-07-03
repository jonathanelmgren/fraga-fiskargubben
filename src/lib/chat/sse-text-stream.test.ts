/**
 * sse-text-stream.test.ts — the server-side event-stream → visible-text
 * transform.
 *
 * The SDK's toReadableStream() emits one raw streaming event per line as bare
 * JSON (newline-separated, NO `data:`/`event:` prefix). The transform must
 * forward only text_delta from text blocks and drop thinking, across realistic
 * event orderings and awkward chunk boundaries.
 */

import { describe, expect, it } from "vitest";
import { toTextStream } from "./sse-text-stream";

/** Build a ReadableStream that emits the given string pieces as UTF-8 bytes. */
function sourceOf(pieces: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const p of pieces) controller.enqueue(enc.encode(p));
      controller.close();
    },
  });
}

/** Drain a byte stream to a string. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  out += dec.decode();
  return out;
}

/** One event line exactly as the SDK serializes it: bare JSON + "\n". */
function line(obj: unknown): string {
  return `${JSON.stringify(obj)}\n`;
}

// A realistic first-turn stream: a thinking block (index 0) then a text block
// (index 1), matching adaptive-thinking Sonnet output.
const FIRST_TURN_LINES = [
  line({ type: "message_start", message: { id: "msg_1", role: "assistant" } }),
  line({
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking" },
  }),
  line({
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "The user asks about Tolken…" },
  }),
  line({ type: "content_block_stop", index: 0 }),
  line({
    type: "content_block_start",
    index: 1,
    content_block: { type: "text" },
  }),
  line({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Tolken, jajamen. " },
  }),
  line({
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "Prova maskkroken." },
  }),
  line({ type: "content_block_stop", index: 1 }),
  line({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  line({ type: "message_stop" }),
];

describe("toTextStream", () => {
  it("forwards only the visible text, dropping thinking + envelope events", async () => {
    const out = await collect(toTextStream(sourceOf(FIRST_TURN_LINES)));
    expect(out).toBe("Tolken, jajamen. Prova maskkroken.");
  });

  it("never leaks the model's private thinking text", async () => {
    const out = await collect(toTextStream(sourceOf(FIRST_TURN_LINES)));
    expect(out).not.toContain("The user asks");
    expect(out).not.toContain("thinking");
  });

  it("emits no JSON syntax (the original bug was raw event lines reaching the client)", async () => {
    const out = await collect(toTextStream(sourceOf(FIRST_TURN_LINES)));
    expect(out).not.toContain("content_block");
    expect(out).not.toContain("message_start");
    expect(out).not.toMatch(/[{}]/);
  });

  it("reassembles lines split across arbitrary chunk boundaries", async () => {
    // Concatenate every line then re-slice at odd byte offsets so JSON values
    // and even the newline separators straddle chunk edges.
    const whole = FIRST_TURN_LINES.join("");
    const pieces: string[] = [];
    for (let i = 0; i < whole.length; i += 7)
      pieces.push(whole.slice(i, i + 7));
    const out = await collect(toTextStream(sourceOf(pieces)));
    expect(out).toBe("Tolken, jajamen. Prova maskkroken.");
  });

  it("drops a text_delta that belongs to a non-text block (defensive)", async () => {
    // A thinking block whose delta is mislabeled text_delta must still not leak,
    // because the block KIND (index 0 = thinking) gates emission.
    const lines = [
      line({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
      line({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "leaked?" },
      }),
      line({ type: "content_block_stop", index: 0 }),
    ];
    const out = await collect(toTextStream(sourceOf(lines)));
    expect(out).toBe("");
  });

  it("skips malformed lines without throwing", async () => {
    const lines = [
      "not-json\n",
      line({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      }),
      line({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
    ];
    const out = await collect(toTextStream(sourceOf(lines)));
    expect(out).toBe("ok");
  });

  it("emits a final buffered line with no trailing newline", async () => {
    const piece =
      `${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n` +
      // last line, deliberately no trailing "\n"
      `${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "tail" } })}`;
    const out = await collect(toTextStream(sourceOf([piece])));
    expect(out).toBe("tail");
  });

  it("tolerates an accidental data: SSE prefix (forward-compat)", async () => {
    const lines = [
      `data: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}\n`,
      `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } })}\n`,
    ];
    const out = await collect(toTextStream(sourceOf(lines)));
    expect(out).toBe("hi");
  });
});
