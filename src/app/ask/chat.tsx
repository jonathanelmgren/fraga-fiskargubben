"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PENDING_PROMPT_KEY, type PendingPrompt } from "@/app/hero-prompt";
import gubbeImg from "@/assets/gubbe.png";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// L-ui1: GateType / KNOWN_GATE_TYPES / PERSONA_GATES below mirror the server's
// AskResult union (src/lib/chat/ask-handler.ts) plus the client-only "error"
// state. There is no compile-time link, so when a gate type is added to
// AskResult it MUST be added here too. asGateType() fails safe to "error".
type GateType =
  | "register_to_continue"
  | "chat_limit"
  | "topic_refused"
  | "lake_unresolved"
  | "out_of_credits"
  | "lake_lock"
  // Rebuild: a free clarify round from the lake resolver — rendered as an
  // ordinary assistant bubble; the conversation continues.
  | "clarify"
  | "error";

export type ChatMessage =
  | { role: "user"; text: string; id: string }
  | { role: "assistant"; text: string; streaming?: boolean; id: string }
  | { role: "gate"; gateType: GateType; text: string; id: string };

/** Mirrors SignalBadges from the server (X-Signals header / snapshot). */
export type Badges = {
  lake: string;
  status: "resolved" | "unresolved_area";
  airTempC?: number;
  windMs?: number;
  waterTempC?: number;
};

// ---------------------------------------------------------------------------
// Gate response classification
// ---------------------------------------------------------------------------

/** In-persona — rendered as Fiskargubben message bubble */
const PERSONA_GATES: GateType[] = [
  "topic_refused",
  "lake_unresolved",
  "lake_lock",
  "clarify",
];

function isPersonaGate(g: GateType): boolean {
  return PERSONA_GATES.includes(g);
}

const KNOWN_GATE_TYPES: GateType[] = [
  "register_to_continue",
  "chat_limit",
  "topic_refused",
  "lake_unresolved",
  "out_of_credits",
  "lake_lock",
  "clarify",
  "error",
];

function asGateType(value: string): GateType | null {
  return (KNOWN_GATE_TYPES as string[]).includes(value)
    ? (value as GateType)
    : null;
}

// ---------------------------------------------------------------------------
// Badges strip
// ---------------------------------------------------------------------------

function Badge({
  icon,
  label,
  tone = "default",
}: {
  icon: string;
  label: string;
  tone?: "default" | "muted";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
        tone === "muted"
          ? "border-border bg-muted text-muted-foreground"
          : "border-border bg-card text-foreground/85"
      }`}
    >
      <span aria-hidden="true">{icon}</span>
      {label}
    </span>
  );
}

function BadgesStrip({ badges }: { badges: Badges }) {
  return (
    <section
      className="flex flex-wrap items-center gap-2 border-b border-border bg-card/60 px-4 py-2.5"
      aria-label="Fångad data"
    >
      {badges.status === "resolved" ? (
        <Badge icon="🎣" label={badges.lake} />
      ) : (
        <Badge icon="🗺️" label={`${badges.lake} (okänd sjö)`} tone="muted" />
      )}
      {badges.airTempC !== undefined && (
        <Badge icon="🌡️" label={`Luft ${formatNum(badges.airTempC)}°C`} />
      )}
      {badges.windMs !== undefined && (
        <Badge icon="💨" label={`Vind ${formatNum(badges.windMs)} m/s`} />
      )}
      {badges.waterTempC !== undefined && (
        <Badge icon="🌊" label={`Vatten ${formatNum(badges.waterTempC)}°C`} />
      )}
    </section>
  );
}

function formatNum(n: number): string {
  return (Math.round(n * 10) / 10).toLocaleString("sv-SE");
}

// ---------------------------------------------------------------------------
// Bubble sub-components
// ---------------------------------------------------------------------------

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="chat-bubble-user">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

function AssistantBubble({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">
        <Image
          src={gubbeImg}
          alt="Fiskargubben"
          width={40}
          height={40}
          className="rounded-full object-cover border-2 border-amber-700/30 shadow"
        />
      </div>
      <div className="chat-bubble-assistant">
        <p className="text-sm leading-relaxed whitespace-pre-wrap">
          {text}
          {streaming && (
            <span
              aria-hidden="true"
              className="inline-block w-2 h-4 ml-0.5 bg-teal-700/60 animate-pulse align-text-bottom rounded-sm"
            />
          )}
        </p>
      </div>
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">
        <Image
          src={gubbeImg}
          alt="Fiskargubben"
          width={40}
          height={40}
          className="rounded-full object-cover border-2 border-amber-700/30 shadow opacity-70"
        />
      </div>
      <div className="chat-bubble-assistant opacity-75">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
          <span className="casting-dot" />
          <span className="casting-dot" style={{ animationDelay: "0.2s" }} />
          <span className="casting-dot" style={{ animationDelay: "0.4s" }} />
          tänker…
        </span>
      </div>
    </div>
  );
}

function ChatLimitBanner({
  ariaLabel,
  className,
}: {
  ariaLabel: string;
  className: string;
}) {
  return (
    <section aria-label={ariaLabel} className={className}>
      <span className="shrink-0 text-base">⚓</span>
      <span>
        Konversationsgränsen är nådd.{" "}
        <Link
          href="/ask"
          className="underline underline-offset-2 hover:text-stone-800"
        >
          Starta en ny chatt
        </Link>
      </span>
    </section>
  );
}

function GateBanner({ gateType, text }: { gateType: GateType; text: string }) {
  if (gateType === "register_to_continue") {
    return (
      <div
        role="status"
        className="gate-cta mx-auto max-w-sm text-center py-5 px-6 rounded-xl border border-amber-700/30 bg-amber-50/80 shadow-sm"
      >
        <p className="text-sm font-medium text-amber-900 mb-3">
          Ditt gratisfiske är slut för nu
        </p>
        <p className="text-xs text-amber-800/70 mb-4">
          Logga in eller skapa ett konto för att fortsätta fråga Fiskargubben.
        </p>
        <div className="flex gap-2 justify-center">
          <Link
            href="/?auth=1"
            className="rounded-md bg-teal-700 px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            Logga in / skapa konto
          </Link>
        </div>
      </div>
    );
  }

  if (gateType === "out_of_credits") {
    return (
      <div
        role="status"
        className="gate-credits mx-auto max-w-sm text-center py-5 px-6 rounded-xl border border-stone-300 bg-stone-50/80 shadow-sm"
      >
        <p className="text-sm font-medium text-stone-700 mb-2">
          Du har använt dina gratisfrågor
        </p>
        <p className="text-xs text-stone-500 mb-3">
          {text ||
            "Uppgradering kommer snart — hör av dig om du vill vara med i betan."}
        </p>
        <Link
          href="/profile"
          className="text-xs font-semibold text-teal-800 underline underline-offset-2"
        >
          Se premium på din profil
        </Link>
      </div>
    );
  }

  if (gateType === "error") {
    return (
      <p role="status" className="text-xs text-red-700/80 px-4 italic mx-2">
        {text || "Något gick snett — försök igen om ett ögonblick."}
      </p>
    );
  }

  if (gateType === "chat_limit") {
    return (
      <ChatLimitBanner
        ariaLabel="Chatbegränsning"
        className="chat-limit-banner flex items-center gap-3 rounded-lg border border-stone-300/70 bg-stone-100/60 px-4 py-3 text-xs text-stone-600 mx-2"
      />
    );
  }

  if (isPersonaGate(gateType)) {
    return <AssistantBubble text={text} />;
  }

  return (
    <p role="status" className="text-xs text-muted-foreground px-4 italic">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Main Chat component
// ---------------------------------------------------------------------------

function nextId() {
  return `msg-${crypto.randomUUID()}`;
}

function parseBadgesHeader(value: string | null): Badges | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Badges;
    return typeof parsed.lake === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export type ChatProps = {
  /** Existing conversation (server-loaded /ask/[id] view). */
  conversationId?: string;
  initialMessages?: ChatMessage[];
  initialBadges?: Badges | null;
  /** Server-loaded frozen state (chat-turn limit already hit). */
  initialFrozen?: boolean;
  /**
   * New-chat view (/ask): pick up the landing hero's pending prompt from
   * sessionStorage and auto-submit it on mount.
   */
  autoSubmitPending?: boolean;
};

export default function Chat({
  conversationId: initialConversationId,
  initialMessages,
  initialBadges,
  initialFrozen = false,
  autoSubmitPending = false,
}: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(
    initialMessages ?? [],
  );
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(
    initialConversationId ?? null,
  );
  const [badges, setBadges] = useState<Badges | null>(initialBadges ?? null);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [frozen, setFrozen] = useState(initialFrozen);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Location rides along on the FIRST prompt only (landing handoff).
  const pendingLocationRef = useRef<PendingPrompt["location"]>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only on count change
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages.length]);

  const forceScroll = useCallback(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, []);

  const isDisabled = streaming || thinking || frozen;

  const sendMessage = useCallback(
    async (trimmed: string) => {
      // Append user message
      const userMsgId = nextId();
      setMessages((prev) => [
        ...prev,
        { role: "user", text: trimmed, id: userMsgId },
      ]);
      setThinking(true);
      forceScroll();

      // E2: hoisted so the catch can finalize a dangling partial bubble.
      let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let streamingMsgId: string | null = null;

      const location = pendingLocationRef.current;
      pendingLocationRef.current = undefined;

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            ...(conversationId ? { conversationId } : {}),
            ...(location ? { location } : {}),
          }),
        });

        // The conversation id now arrives on stream AND clarify responses.
        const convId = response.headers.get("X-Conversation-Id");
        if (convId && !conversationId) {
          setConversationId(convId);
          // Make refresh/share land on the persisted conversation.
          try {
            window.history.replaceState(null, "", `/ask/${convId}`);
          } catch {
            // history unavailable — non-fatal
          }
        }

        // L6: non-OK HTTP first (402 out_of_credits is a legitimate gate).
        if (!response.ok && response.status !== 402) {
          setThinking(false);
          let serverText = "";
          try {
            const j = (await response.json()) as { text?: string };
            serverText = typeof j.text === "string" ? j.text : "";
          } catch {
            // non-JSON error body — fall back to the generic copy
          }
          setMessages((prev) => [
            ...prev,
            { role: "gate", gateType: "error", text: serverText, id: nextId() },
          ]);
          forceScroll();
          return;
        }

        const ct = response.headers.get("content-type") ?? "";

        if (ct.startsWith("text/plain")) {
          const headerBadges = parseBadgesHeader(
            response.headers.get("X-Signals"),
          );
          if (headerBadges) setBadges(headerBadges);

          const assistantMsgId = nextId();
          streamingMsgId = assistantMsgId;
          setMessages((prev) => [
            ...prev,
            {
              role: "assistant",
              text: "",
              streaming: true,
              id: assistantMsgId,
            },
          ]);
          setThinking(false);
          setStreaming(true);
          forceScroll();

          const reader = response.body?.getReader();
          const decoder = new TextDecoder();

          if (!reader) {
            setStreaming(false);
            return;
          }
          activeReader = reader;

          let done = false;
          while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
              // Body is the visible answer as plain UTF-8 (server strips
              // thinking + JSON frames). Append verbatim; do NOT parse as SSE.
              const chunk = decoder.decode(value, { stream: !done });
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                if (last?.role === "assistant" && last.id === assistantMsgId) {
                  updated[updated.length - 1] = {
                    ...last,
                    text: last.text + chunk,
                    streaming: !done,
                  };
                }
                return updated;
              });
              forceScroll();
            }
          }

          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.id === assistantMsgId) {
              updated[updated.length - 1] = { ...last, streaming: false };
            }
            return updated;
          });
          activeReader = null;
          streamingMsgId = null;
          setStreaming(false);
        } else {
          // Structured gate JSON response (incl. clarify rounds)
          setThinking(false);
          let gate: { type: string; text: string };
          try {
            gate = await response.json();
          } catch {
            gate = { type: "error", text: "Något gick fel." };
          }

          const gateType = asGateType(gate.type) ?? "error";

          if (gateType === "chat_limit") {
            setFrozen(true);
          }

          if (isPersonaGate(gateType)) {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", text: gate.text, id: nextId() },
            ]);
          } else {
            setMessages((prev) => [
              ...prev,
              { role: "gate", gateType, text: gate.text, id: nextId() },
            ]);
          }
          forceScroll();
        }
      } catch {
        setThinking(false);
        setStreaming(false);

        if (activeReader) {
          try {
            await activeReader.cancel();
          } catch {
            // reader already errored/closed — nothing to cancel.
          }
        }
        if (streamingMsgId) {
          const danglingId = streamingMsgId;
          setMessages((prev) =>
            prev.map((m) =>
              m.role === "assistant" && m.id === danglingId
                ? { ...m, streaming: false }
                : m,
            ),
          );
        }

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: "Något gick snett — försök igen om ett ögonblick.",
            id: nextId(),
          },
        ]);
        forceScroll();
      }
    },
    [conversationId, forceScroll],
  );

  const handleSubmit = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      const trimmed = input.trim();
      if (!trimmed || isDisabled) return;
      setInput("");
      await sendMessage(trimmed);
    },
    [input, isDisabled, sendMessage],
  );

  // Landing handoff: auto-submit the pending prompt exactly once.
  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (!autoSubmitPending || autoSubmittedRef.current) return;
    autoSubmittedRef.current = true;
    let pending: PendingPrompt | null = null;
    try {
      const raw = sessionStorage.getItem(PENDING_PROMPT_KEY);
      sessionStorage.removeItem(PENDING_PROMPT_KEY);
      pending = raw ? (JSON.parse(raw) as PendingPrompt) : null;
    } catch {
      pending = null;
    }
    if (pending?.text) {
      pendingLocationRef.current = pending.location;
      void sendMessage(pending.text);
    }
  }, [autoSubmitPending, sendMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="chat-root flex flex-col h-full">
      {/* Signal badges (captured data) */}
      {badges && <BadgesStrip badges={badges} />}

      {/* Message list */}
      <section
        className="chat-messages flex-1 overflow-y-auto px-4 py-6 space-y-4"
        aria-live="polite"
        aria-label="Konversation"
      >
        {messages.length === 0 && !thinking && (
          <div className="flex flex-col items-center justify-center h-full gap-6 py-12 select-none">
            <Image
              src={gubbeImg}
              alt="Fiskargubben"
              width={96}
              height={96}
              className="rounded-full border-4 border-amber-700/20 shadow-lg opacity-90"
            />
            <div className="text-center space-y-2">
              <p className="text-base text-muted-foreground font-medium">
                Berätta vilken sjö och vad du undrar
              </p>
              <p className="text-xs text-muted-foreground/60">
                t.ex. "Ska jag fiska abborre i Vättern imorgon tidigt?"
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === "user") {
            return <UserBubble key={msg.id} text={msg.text} />;
          }
          if (msg.role === "assistant") {
            return (
              <AssistantBubble
                key={msg.id}
                text={msg.text}
                streaming={msg.streaming}
              />
            );
          }
          return (
            <GateBanner key={msg.id} gateType={msg.gateType} text={msg.text} />
          );
        })}

        {thinking && <ThinkingIndicator />}
        <div ref={bottomRef} />
      </section>

      {/* Frozen system notice */}
      {frozen && (
        <ChatLimitBanner
          ariaLabel="Chatt fryst"
          className="frozen-banner shrink-0 mx-4 mb-2 flex items-center gap-3 rounded-lg border border-stone-300/70 bg-stone-100/60 px-4 py-3 text-xs text-stone-600"
        />
      )}

      {/* Input area */}
      <form
        onSubmit={handleSubmit}
        className="chat-input-area shrink-0 border-t border-border bg-card/80 px-4 py-3 flex items-end gap-3"
      >
        <label htmlFor="chat-input" className="sr-only">
          Skriv din fråga
        </label>
        <textarea
          id="chat-input"
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            frozen
              ? "Starta en ny chatt för att fortsätta…"
              : "Fråga Fiskargubben…"
          }
          disabled={isDisabled}
          rows={1}
          className="flex-1 resize-none rounded-lg border border-input bg-background px-3 py-2.5 text-sm leading-relaxed placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-ring/60 disabled:opacity-50 max-h-40 overflow-y-auto"
          style={{
            fieldSizing: "content" as React.CSSProperties["fieldSizing"],
          }}
          aria-label="Skriv din fråga till Fiskargubben"
        />
        <button
          type="submit"
          disabled={isDisabled || !input.trim()}
          className="shrink-0 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Skicka fråga"
        >
          {streaming || thinking ? (
            <span className="flex items-center gap-1.5">
              <span className="casting-dot" />
              <span
                className="casting-dot"
                style={{ animationDelay: "0.2s" }}
              />
              <span
                className="casting-dot"
                style={{ animationDelay: "0.4s" }}
              />
            </span>
          ) : (
            "Kasta"
          )}
        </button>
      </form>
    </div>
  );
}
