"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import gubbeImg from "@/assets/gubbe.png";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GateType =
  | "register_to_continue"
  | "chat_limit"
  | "topic_refused"
  | "lake_unresolved"
  | "out_of_credits"
  | "lake_lock"
  // L6: distinct generic-error state for non-OK HTTP responses (5xx/503) so a
  // server error isn't mislabeled as a persona gate.
  | "error";

type Message =
  | { role: "user"; text: string; id: string }
  | { role: "assistant"; text: string; streaming?: boolean; id: string }
  | { role: "gate"; gateType: GateType; text: string; id: string };

// ---------------------------------------------------------------------------
// Gate response classification
// ---------------------------------------------------------------------------

/** In-persona — rendered as Fiskargubben message bubble */
const PERSONA_GATES: GateType[] = [
  "topic_refused",
  "lake_unresolved",
  "lake_lock",
];

function isPersonaGate(g: GateType): boolean {
  return PERSONA_GATES.includes(g);
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
          Registrera dig för att fortsätta fråga Fiskargubben.
        </p>
        <div className="flex gap-2 justify-center">
          <Link
            href="/register"
            className="rounded-md bg-teal-700 px-4 py-2 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            Skapa konto
          </Link>
          <Link
            href="/login"
            className="rounded-md border border-teal-700/50 px-4 py-2 text-xs font-medium text-teal-800 transition-colors hover:bg-teal-50"
          >
            Logga in
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
        {/* L7: render the server-provided in-persona text (OUT_OF_CREDITS_MESSAGE)
            when present, instead of dropping it for hardcoded copy. */}
        <p className="text-xs text-stone-500">
          {text ||
            "Uppgradering kommer snart — hör av dig om du vill vara med i betan."}
        </p>
      </div>
    );
  }

  if (gateType === "error") {
    // L6: generic server-error state, distinct from the persona gates.
    return (
      <p role="status" className="text-xs text-red-700/80 px-4 italic mx-2">
        {text || "Något gick snett — försök igen om ett ögonblick."}
      </p>
    );
  }

  if (gateType === "chat_limit") {
    // Plain system notice — NOT Fiskargubben's voice
    return (
      <section
        aria-label="Chatbegränsning"
        className="chat-limit-banner flex items-center gap-3 rounded-lg border border-stone-300/70 bg-stone-100/60 px-4 py-3 text-xs text-stone-600 mx-2"
      >
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

  // topic_refused, lake_unresolved, lake_lock → in-persona, rendered as assistant bubble
  if (isPersonaGate(gateType)) {
    return <AssistantBubble text={text} />;
  }

  // Fallback
  return (
    <p role="status" className="text-xs text-muted-foreground px-4 italic">
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Main Chat component
// ---------------------------------------------------------------------------

// L13: per-message id generator using crypto.randomUUID (no module-level
// mutable counter shared across component instances).
function nextId() {
  return `msg-${crypto.randomUUID()}`;
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [frozen, setFrozen] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // L13: auto-scroll on message count change.  Depending on a ref's .current
  // (the old code) was inert — refs don't trigger effect re-runs.  `forceScroll`
  // still scrolls imperatively during streaming (where the count is unchanged).
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only on count change
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages.length]);

  const forceScroll = useCallback(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, []);

  const isDisabled = streaming || thinking || frozen;

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = input.trim();
      if (!trimmed || isDisabled) return;

      setInput("");

      // Append user message
      const userMsgId = nextId();
      setMessages((prev) => [
        ...prev,
        { role: "user", text: trimmed, id: userMsgId },
      ]);
      setThinking(true);
      forceScroll();

      try {
        const response = await fetch("/api/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            ...(conversationId ? { conversationId } : {}),
          }),
        });

        // L6: handle non-OK HTTP first.  A 5xx/503 (e.g. upstream/DB failure
        // mapped by the route's error boundary) must NOT fall through to the
        // content-type branch where it would be mislabeled as lake_unresolved.
        // out_of_credits is a 402 but a legitimate gate, so allow it through.
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

        // Check content-type to decide stream vs gate JSON
        const ct = response.headers.get("content-type") ?? "";

        if (ct.startsWith("text/plain")) {
          // Capture conversation ID from header
          const convId = response.headers.get("X-Conversation-Id");
          if (convId && !conversationId) {
            setConversationId(convId);
          }

          // Start streaming into a new assistant message
          const assistantMsgId = nextId();
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

          let done = false;
          while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
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

          // Mark streaming done
          setMessages((prev) => {
            const updated = [...prev];
            const last = updated[updated.length - 1];
            if (last?.role === "assistant" && last.id === assistantMsgId) {
              updated[updated.length - 1] = { ...last, streaming: false };
            }
            return updated;
          });
          setStreaming(false);
        } else {
          // Structured gate JSON response
          setThinking(false);
          let gate: { type: string; text: string };
          try {
            gate = await response.json();
          } catch {
            gate = { type: "lake_unresolved", text: "Något gick fel." };
          }

          const gateType = gate.type as GateType;

          if (gateType === "chat_limit") {
            setFrozen(true);
          }

          // Persona gates go as assistant messages; others as gate messages
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
    [input, isDisabled, conversationId, forceScroll],
  );

  // Auto-grow textarea
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  };

  return (
    <div className="chat-root flex flex-col h-full">
      {/* Message list */}
      <section
        className="chat-messages flex-1 overflow-y-auto px-4 py-6 space-y-4"
        aria-live="polite"
        aria-label="Konversation"
      >
        {messages.length === 0 && (
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
          // gate
          return (
            <GateBanner key={msg.id} gateType={msg.gateType} text={msg.text} />
          );
        })}

        {thinking && <ThinkingIndicator />}
        <div ref={bottomRef} />
      </section>

      {/* Frozen system notice */}
      {frozen && (
        <section
          aria-label="Chatt fryst"
          className="frozen-banner shrink-0 mx-4 mb-2 flex items-center gap-2 rounded-lg border border-stone-300/70 bg-stone-100/60 px-4 py-3 text-xs text-stone-600"
        >
          <span className="text-base">⚓</span>
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
