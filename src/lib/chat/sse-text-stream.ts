/**
 * sse-text-stream.ts — turn the Anthropic SDK's raw event stream into a plain
 * UTF-8 text stream of the assistant's VISIBLE answer.
 *
 * `MessageStream.toReadableStream()` does NOT emit real SSE frames — it emits
 * one raw streaming-event object per line, newline-separated bare JSON
 * (`JSON.stringify(event) + "\n"`, see @anthropic-ai/sdk core/streaming.js).
 * Piping that straight to the browser was the bug: the client rendered the JSON
 * lines verbatim (message_start, content_block_delta, …), and — because
 * first-turn advice runs with adaptive thinking — the model's private
 * `thinking_delta` reasoning was among them.
 *
 * This transform parses those JSON lines server-side and forwards ONLY the
 * `text_delta` text from `text` content blocks:
 *   - `thinking` / `redacted_thinking` blocks are dropped entirely (never leave
 *     the server — they are the model's private reasoning).
 *   - every non-text event (message_start, message_delta, ping, block
 *     start/stop) is dropped.
 * The result is a clean `text/plain` body the client appends verbatim.
 */

/** Content-block index → block type, tracked across events of one message. */
type BlockKind = "text" | "thinking" | "other";

/**
 * Wrap the SDK's newline-delimited-JSON ReadableStream (bytes) in a
 * TransformStream that outputs only the visible answer text (bytes). Pipe the
 * SDK readable through this and use the result as the Response body.
 */
export function toTextStream(
  sdkReadable: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  // JSON lines arrive split across arbitrary byte chunks; buffer partial lines.
  let buffer = "";
  // The content-block index currently streaming maps to its kind, set on
  // content_block_start and read on content_block_delta.
  const blockKinds = new Map<number, BlockKind>();

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete lines; keep the trailing partial in the buffer.
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const text = handleLine(line, blockKinds);
        if (text) controller.enqueue(encoder.encode(text));
        nl = buffer.indexOf("\n");
      }
    },
    flush(controller) {
      // Emit any final buffered line (the stream may end without a trailing \n).
      if (buffer.length > 0) {
        const text = handleLine(buffer, blockKinds);
        if (text) controller.enqueue(encoder.encode(text));
        buffer = "";
      }
    },
  });

  return sdkReadable.pipeThrough(transform);
}

/**
 * Parse one newline-delimited event line and return the visible text to emit
 * (or "" for nothing). Each non-empty line is one raw Anthropic streaming event
 * as bare JSON. A line that isn't valid JSON is skipped defensively rather than
 * throwing. Also tolerates an accidental `data:` SSE prefix, in case the SDK's
 * serialization ever changes.
 */
function handleLine(line: string, blockKinds: Map<number, BlockKind>): string {
  let payload = line.trim();
  if (payload.length === 0) return "";
  if (payload.startsWith("data:")) payload = payload.slice(5).trim();
  if (payload.length === 0 || payload === "[DONE]") return "";

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return "";
  }
  if (typeof event !== "object" || event === null) return "";
  const e = event as {
    type?: string;
    index?: number;
    content_block?: { type?: string };
    delta?: { type?: string; text?: string };
  };

  switch (e.type) {
    case "content_block_start": {
      const kind = e.content_block?.type;
      blockKinds.set(
        e.index ?? -1,
        kind === "text"
          ? "text"
          : kind === "thinking" || kind === "redacted_thinking"
            ? "thinking"
            : "other",
      );
      return "";
    }
    case "content_block_delta": {
      // Only forward text_delta from a TEXT block; thinking_delta and any delta
      // on a non-text block are the model's private reasoning → dropped.
      if (
        e.delta?.type === "text_delta" &&
        blockKinds.get(e.index ?? -1) === "text" &&
        typeof e.delta.text === "string"
      ) {
        return e.delta.text;
      }
      return "";
    }
    case "content_block_stop": {
      blockKinds.delete(e.index ?? -1);
      return "";
    }
    default:
      // message_start / message_delta / message_stop / ping / error → nothing.
      return "";
  }
}
