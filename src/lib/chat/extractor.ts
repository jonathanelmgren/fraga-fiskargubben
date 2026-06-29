/**
 * Extractor — Task 5.2
 *
 * Calls Haiku 4.5 with structured output (zodOutputFormat / output_config.format)
 * to extract fishing-related context from a user message.
 *
 * Topic gate: if the model returns onTopic:false, a canned in-persona Swedish
 * refusal string is set here in code (simpler than asking the model to produce
 * it, avoids extra output tokens, and keeps the persona consistent).
 *
 * Null-parse fallback: if parsed_output is null (parse failure), we return an
 * off-topic result with the canned refusal so the caller can handle it gracefully
 * without crashing. The null branch is documented and treated as off-topic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { EXTRACTOR_MODEL } from "@/lib/claude/models";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type Extraction = {
  onTopic: boolean;
  lakeName?: string;
  municipality?: string;
  time?: string;
  intent?: string;
  contextChanged: boolean;
  /** Set when onTopic=false. Canned in-persona Swedish refusal. */
  refusal?: string;
};

// ---------------------------------------------------------------------------
// Zod schema — what Haiku must produce
// ---------------------------------------------------------------------------

const ExtractionOutputSchema = z.object({
  onTopic: z
    .boolean()
    .describe(
      "true if the user is asking about fishing in a Swedish lake; false for anything else",
    ),
  lakeName: z
    .string()
    .optional()
    .describe("Name of the Swedish lake the user mentioned, if any"),
  municipality: z
    .string()
    .optional()
    .describe("Municipality the user mentioned alongside the lake, if any"),
  time: z
    .string()
    .optional()
    .describe(
      'When the user wants to fish, e.g. "ikväll", "imorgon", "på lördag"',
    ),
  intent: z
    .string()
    .optional()
    .describe("Short description of what the user wants to do or catch"),
  contextChanged: z
    .boolean()
    .describe(
      "true if the lake or time changed compared to the prior conversation history",
    ),
});

// ---------------------------------------------------------------------------
// Canned in-persona refusal (used when onTopic=false or parse failure)
// ---------------------------------------------------------------------------

const CANNED_REFUSAL =
  "Jag snackar bara fiske, grabben. Fråga mig om sjöar, abborre eller gädda istället.";

// ---------------------------------------------------------------------------
// Dependency injection shim (so tests can inject a fake client)
// ---------------------------------------------------------------------------

export type ExtractorDeps = {
  client: Pick<Anthropic, "messages">;
};

function defaultClient(): Pick<Anthropic, "messages"> {
  // Lazy import env to avoid module-level side-effects during tests
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { env } = require("@/shared/env") as typeof import("@/shared/env");
  return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
}

// ---------------------------------------------------------------------------
// extract()
// ---------------------------------------------------------------------------

/**
 * Extract structured fishing context from a single user message.
 *
 * @param message  The raw user message (Swedish free text).
 * @param history  Prior conversation turns (used for contextChanged detection).
 * @param deps     Optional deps for testing (inject a fake client).
 */
export async function extract(
  message: string,
  history: HistoryMessage[] = [],
  deps?: ExtractorDeps,
): Promise<Extraction> {
  const client = deps?.client ?? defaultClient();

  const systemPrompt = `Du är en assistent som extraherar fiskerelaterad information ur svenska meddelanden.
Din uppgift är att analysera användarens meddelande och returnera ett strukturerat svar.

Regler:
- onTopic: true BARA om meddelandet handlar om fiske i en svensk sjö. Allt annat är off-topic.
- lakeName: sjönamnet om användaren nämner ett (t.ex. "Tolken", "Vättern", "Hjälmaren").
- municipality: kommunnamnet om användaren nämner det i samband med sjön.
- time: när användaren vill fiska (t.ex. "ikväll", "imorgon", "på lördag").
- intent: kort beskrivning av vad användaren vill göra eller fånga.
- contextChanged: true om sjön eller tidpunkten har ändrats jämfört med historiken nedan.

Svara ENBART med det strukturerade JSON-objektet — ingen annan text.`;

  // Build a compact history summary for contextChanged detection
  const historyText =
    history.length > 0
      ? history
          .slice(-4) // last 4 messages is enough context
          .map((m) => `${m.role}: ${m.content}`)
          .join("\n")
      : "(ingen historik)";

  const userContent = `Historik:\n${historyText}\n\nNytt meddelande:\n${message}`;

  const response = await client.messages.parse({
    model: EXTRACTOR_MODEL,
    max_tokens: 512,
    system: systemPrompt,
    messages: [{ role: "user", content: userContent }],
    output_config: {
      format: zodOutputFormat(ExtractionOutputSchema),
    },
  });

  // Null guard: parse failure → treat as off-topic with canned refusal
  if (response.parsed_output == null) {
    return {
      onTopic: false,
      contextChanged: false,
      refusal: CANNED_REFUSAL,
    };
  }

  const parsed = response.parsed_output;

  // Topic gate: add canned refusal when off-topic
  if (!parsed.onTopic) {
    return {
      onTopic: false,
      contextChanged: parsed.contextChanged,
      refusal: CANNED_REFUSAL,
    };
  }

  return {
    onTopic: true,
    lakeName: parsed.lakeName,
    municipality: parsed.municipality,
    time: parsed.time,
    intent: parsed.intent,
    contextChanged: parsed.contextChanged,
  };
}
