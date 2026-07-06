"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PENDING_PROMPT_KEY, type PendingPrompt } from "@/app/hero-prompt";
import gubbeIcon from "@/assets/gubbe-icon.png";
import { LocationTip } from "@/components/location-tip";
import { useSession } from "@/lib/auth-client";
import { useGeolocation } from "@/lib/hooks/use-geolocation";
import { readShareLocationCookie, writeTosCookie } from "@/lib/prefs-cookies";
import { TOS_VERSION } from "@/lib/tos-version";

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
  // Paid fair-use cap (HTTP 429) — too many new chats in the rolling window.
  | "rate_limited"
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
  "rate_limited",
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
      // pl-14 on mobile clears the absolutely-positioned drawer toggle
      // (chat-drawer.tsx) that sits in the top-left corner.
      className="flex flex-wrap items-center gap-2 border-b border-border bg-card/60 py-2.5 pr-4 pl-14 md:pl-4"
      aria-label="Fångad data"
    >
      {badges.status === "resolved" ? (
        <Badge icon="🎣" label={badges.lake} />
      ) : (
        <Badge icon="🗺️" label={badges.lake} tone="muted" />
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

/**
 * Assistant text is rendered as markdown (the persona is allowed light
 * markdown: bold, lists). Styling lives in globals.css under .chat-markdown
 * so the streaming partial and the final message render identically.
 */
function AssistantBubble({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">
        <Image
          src={gubbeIcon}
          alt="Fiskargubben"
          width={40}
          height={40}
          className="rounded-full object-cover shadow"
        />
      </div>
      <div className="chat-bubble-assistant">
        <div className="chat-markdown text-sm leading-relaxed">
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
        </div>
      </div>
    </div>
  );
}

/**
 * Rotating "what the gubbe is up to" lines while the server extracts,
 * resolves the lake and builds signals. Purely cosmetic — the client can't
 * see real progress — but honest about the kind of work happening.
 */
const THINKING_PHRASES = [
  "Gubben kliar sig i skägget…",
  "Slår upp sjökortet…",
  "Kollar vinden och lufttrycket…",
  "Tjuvkikar på vattentemperaturen…",
  "Hör efter vilka arter som rör sig…",
  "Väger beteslådan i handen…",
  "Muttrar lite för sig själv…",
  "Rotar i masklådan…",
  "Läser av månens skede…",
  "Knyter om tafsen…",
  "Spottar i näven för tur…",
  "Drar sig till minnes förra torsdagen…",
];

const THINKING_PHRASE_MS = 3500;

function ThinkingIndicator({ withPhrases }: { withPhrases: boolean }) {
  const [phraseIndex, setPhraseIndex] = useState(0);

  useEffect(() => {
    if (!withPhrases) return;
    const timer = setInterval(
      () => setPhraseIndex((i) => (i + 1) % THINKING_PHRASES.length),
      THINKING_PHRASE_MS,
    );
    return () => clearInterval(timer);
  }, [withPhrases]);

  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 mt-0.5">
        <Image
          src={gubbeIcon}
          alt="Fiskargubben"
          width={40}
          height={40}
          className="rounded-full object-cover shadow opacity-70"
        />
      </div>
      <div className="chat-bubble-assistant opacity-75">
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground italic">
          <span className="casting-dot" />
          <span className="casting-dot" style={{ animationDelay: "0.2s" }} />
          <span className="casting-dot" style={{ animationDelay: "0.4s" }} />
          {withPhrases && THINKING_PHRASES[phraseIndex]}
        </span>
      </div>
    </div>
  );
}

function ChatLimitBanner({
  ariaLabel,
  className,
  loggedIn,
}: {
  ariaLabel: string;
  className: string;
  loggedIn: boolean;
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
        </Link>{" "}
        eller{" "}
        {loggedIn ? (
          <Link
            href="/profile"
            className="underline underline-offset-2 hover:text-stone-800"
          >
            uppgradera till premium
          </Link>
        ) : (
          <Link
            href="?auth=1"
            scroll={false}
            className="underline underline-offset-2 hover:text-stone-800"
          >
            logga in / skapa konto
          </Link>
        )}{" "}
        för obegränsade följdfrågor.
      </span>
    </section>
  );
}

function GateBanner({
  gateType,
  text,
  loggedIn,
}: {
  gateType: GateType;
  text: string;
  loggedIn: boolean;
}) {
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
            href="?auth=1"
            scroll={false}
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
            "Uppgradera till premium för obegränsade frågor till gubben."}
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

  if (gateType === "rate_limited") {
    return (
      <div
        role="status"
        className="gate-rate-limited mx-auto max-w-sm text-center py-5 px-6 rounded-xl border border-stone-300 bg-stone-50/80 shadow-sm"
      >
        <p className="text-sm font-medium text-stone-700 mb-2">
          Dygnsgränsen är nådd
        </p>
        <p className="text-xs text-stone-500">
          {text ||
            "Du har startat ovanligt många nya chattar det senaste dygnet. Försök igen om några timmar."}
        </p>
      </div>
    );
  }

  if (gateType === "error") {
    return (
      <p role="status" className="text-xs text-red-700/80 px-4 italic mx-2">
        {text || "Något gick snett. Försök igen om ett ögonblick."}
      </p>
    );
  }

  if (gateType === "chat_limit") {
    return (
      <ChatLimitBanner
        ariaLabel="Chatbegränsning"
        className="chat-limit-banner flex items-center gap-3 rounded-lg border border-stone-300/70 bg-stone-100/60 px-4 py-3 text-xs text-stone-600 mx-2"
        loggedIn={loggedIn}
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

// ---------------------------------------------------------------------------
// Resumable streams — client side (see resumable-chat-streams design spec).
// Generation lives in the server's stream registry; the POST body and the
// GET /api/ask/stream re-attach endpoint are both just subscribers. If a read
// breaks (phone locked, network blip), we re-attach from the offset we have
// instead of dropping the answer.
// ---------------------------------------------------------------------------

/** Offset in UTF-16 code units — the same unit the server slices on. */
type StreamProgress = { offset: number };

type DanglingStream = {
  conversationId: string;
  msgId: string;
  progress: StreamProgress;
};

const REATTACH_DELAYS_MS = [1000, 2000, 4000];

const GENERIC_STREAM_ERROR = "Något gick snett. Försök igen om ett ögonblick.";

/**
 * Drain a text/plain body into the chat via applyChunk, advancing progress so
 * a later re-attach knows where to resume. Throws on a broken read.
 */
async function pumpStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  progress: StreamProgress,
  applyChunk: (chunk: string, done: boolean) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let done = false;
  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    const chunk = value ? decoder.decode(value, { stream: !done }) : "";
    if (chunk) progress.offset += chunk.length;
    if (chunk || done) applyChunk(chunk, done);
  }
}

/**
 * Re-attach to the conversation's in-flight stream from the current offset.
 * "gone" = the server has no stream entry (finished long ago, or restarted) —
 * the DB view is the fallback. "failed" = transient, worth retrying.
 */
async function attachToStream(
  conversationId: string,
  progress: StreamProgress,
  applyChunk: (chunk: string, done: boolean) => void,
): Promise<"done" | "gone" | "failed"> {
  let response: Response;
  try {
    response = await fetch(
      `/api/ask/stream?conversationId=${encodeURIComponent(conversationId)}&offset=${progress.offset}`,
    );
  } catch {
    return "failed";
  }
  if (response.status === 404) return "gone";
  const reader = response.ok ? response.body?.getReader() : undefined;
  if (!reader) return "failed";
  try {
    await pumpStream(reader, progress, applyChunk);
    return "done";
  } catch {
    return "failed";
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Indirection so tests can stub the full-page reload (jsdom's
 * window.location.reload is non-configurable and not implemented).
 */
export const pageReload = {
  trigger() {
    window.location.reload();
  },
};

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
   * The server's stream registry is still generating this conversation's
   * reply (page loaded mid-generation) — attach to it on mount.
   */
  initialActiveStream?: boolean;
  /**
   * New-chat view (/ask): pick up the landing hero's pending prompt from
   * sessionStorage and auto-submit it on mount.
   */
  autoSubmitPending?: boolean;
  /**
   * Server-resolved prefs (account + preference cookies, see
   * resolveChatPrefs). Authoritative at render time — no client-side
   * re-derivation, so the gate and geo toggle paint correctly at once.
   */
  initialTosAccepted?: boolean;
  /** Accepted an OLDER terms version → gate shows "updated terms" copy. */
  initialTosPreviouslyAccepted?: boolean;
  /** Current acceptance exists on the ACCOUNT (not just the cookie). */
  initialTosOnAccount?: boolean;
  initialShareLocation?: boolean;
  /** Account-side location pref only — drives the cookie→account transfer. */
  initialShareLocationOnAccount?: boolean;
};

/** Best-effort account sync; the preference cookie remains the client copy. */
function postPreferences(body: {
  tosAccepted?: true;
  shareLocation?: boolean;
}): void {
  void fetch("/api/preferences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {
    // non-fatal — retried implicitly next time the pref changes
  });
}

export default function Chat({
  conversationId: initialConversationId,
  initialMessages,
  initialBadges,
  initialFrozen = false,
  initialActiveStream = false,
  autoSubmitPending = false,
  initialTosAccepted = false,
  initialTosPreviouslyAccepted = false,
  initialTosOnAccount = false,
  initialShareLocation,
  initialShareLocationOnAccount = false,
}: ChatProps) {
  const router = useRouter();
  // The conversation drawer is only rendered for logged-in users (ask-shell),
  // so only they need the post-turn RSC refresh. For anon users a refresh
  // could even 404 (their /ask/[id] ownership rides on the claim cookie).
  const { data: session } = useSession();
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
  // The rotating "gubben rotar i masklådan" phrases only make sense on the
  // first message of a new chat, where the server actually fetches weather
  // and builds signals. Follow-up turns are fast — plain dots are enough.
  const [thinkingWithPhrases, setThinkingWithPhrases] = useState(false);
  const [frozen, setFrozen] = useState(initialFrozen);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Location rides along on the FIRST prompt only (landing handoff).
  const pendingLocationRef = useRef<PendingPrompt["location"]>(undefined);
  // Geo toggle for chats started directly on /ask. Location is stored on the
  // conversation at creation, so the toggle only matters (and only shows)
  // before the first message of a new chat. The preference persists in a
  // server-readable cookie (hook) and on the account for logged-in users.
  const { geo, coords, toggleLocation } = useGeolocation({
    initialOn: initialShareLocation,
    onPrefChange: (on) => {
      if (session) postPreferences({ shareLocation: on });
    },
  });
  // Location nudge: shown on a coin flip per visit (only while the geo toggle
  // is off and still matters, i.e. before the first message of a new chat).
  const [showLocationTip] = useState(() => Math.random() < 0.5);

  // Terms gate — server-resolved (account + cookie), so the gate renders in
  // the right state from the first paint.
  const [tosAccepted, setTosAccepted] = useState(initialTosAccepted);
  const tosUpdated = initialTosPreviouslyAccepted;
  // Hero prompt held back until the terms are accepted.
  const [heldPrompt, setHeldPrompt] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll only on count change
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [messages.length]);

  const forceScroll = useCallback(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, []);

  const isDisabled = streaming || thinking || frozen || !tosAccepted;

  // A broken stream parked while the tab was hidden; resumed on visibility.
  const danglingRef = useRef<DanglingStream | null>(null);

  /** Chunk applier bound to one assistant bubble (matched by id, not position). */
  const applyStreamChunk = useCallback(
    (msgId: string) => (chunk: string, done: boolean) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.role === "assistant" && m.id === msgId
            ? { ...m, text: m.text + chunk, streaming: !done }
            : m,
        ),
      );
      forceScroll();
    },
    [forceScroll],
  );

  /**
   * Try to re-attach a broken stream with backoff. Hidden tab → park and let
   * the visibilitychange listener resume (mobile browsers freeze fetches).
   * "gone" → the registry evicted the entry; the DB has the persisted turns,
   * so reload the server-rendered conversation. Exhausted → error bubble.
   */
  const recoverStream = useCallback(
    async (dangling: DanglingStream) => {
      const { conversationId: convId, msgId, progress } = dangling;
      const apply = applyStreamChunk(msgId);
      for (const delay of REATTACH_DELAYS_MS) {
        if (document.hidden) {
          danglingRef.current = dangling;
          return;
        }
        await sleep(delay);
        const result = await attachToStream(convId, progress, apply);
        if (result === "done") {
          setStreaming(false);
          if (session) router.refresh();
          return;
        }
        if (result === "gone") {
          pageReload.trigger();
          return;
        }
      }
      if (document.hidden) {
        danglingRef.current = dangling;
        return;
      }
      setStreaming(false);
      setMessages((prev) => [
        ...prev.map((m) =>
          m.role === "assistant" && m.id === msgId
            ? { ...m, streaming: false }
            : m,
        ),
        { role: "assistant", text: GENERIC_STREAM_ERROR, id: nextId() },
      ]);
      forceScroll();
    },
    [applyStreamChunk, forceScroll, router, session],
  );

  // Phone unlocked / tab foregrounded again → resume a parked stream.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const dangling = danglingRef.current;
      if (!dangling) return;
      danglingRef.current = null;
      void recoverStream(dangling);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () =>
      document.removeEventListener("visibilitychange", onVisibility);
  }, [recoverStream]);

  // Page loaded while the server was still generating (initialActiveStream):
  // append an empty streaming bubble and attach from offset 0. The user turn
  // is already in initialMessages (persisted up-front); the assistant turn is
  // not yet in the DB, so nothing duplicates.
  const mountAttachRef = useRef(false);
  useEffect(() => {
    if (
      !initialActiveStream ||
      !initialConversationId ||
      mountAttachRef.current
    ) {
      return;
    }
    mountAttachRef.current = true;
    const msgId = nextId();
    setMessages((prev) => [
      ...prev,
      { role: "assistant", text: "", streaming: true, id: msgId },
    ]);
    setStreaming(true);
    const progress: StreamProgress = { offset: 0 };
    void (async () => {
      const result = await attachToStream(
        initialConversationId,
        progress,
        applyStreamChunk(msgId),
      );
      if (result === "done") {
        setStreaming(false);
        if (session) router.refresh();
        return;
      }
      if (result === "gone") {
        // Settled between SSR and mount — the DB now has the full turn.
        pageReload.trigger();
        return;
      }
      await recoverStream({
        conversationId: initialConversationId,
        msgId,
        progress,
      });
    })();
  }, [
    initialActiveStream,
    initialConversationId,
    applyStreamChunk,
    recoverStream,
    router,
    session,
  ]);

  // One-time transfer: prefs accepted anonymously (cookies) get mirrored to
  // the account after registration/login, so they survive a new browser.
  const prefsSyncedRef = useRef(false);
  useEffect(() => {
    if (!session || prefsSyncedRef.current) return;
    prefsSyncedRef.current = true;
    if (initialTosAccepted && !initialTosOnAccount) {
      postPreferences({ tosAccepted: true });
    }
    if (readShareLocationCookie() === true && !initialShareLocationOnAccount) {
      postPreferences({ shareLocation: true });
    }
  }, [
    session,
    initialTosAccepted,
    initialTosOnAccount,
    initialShareLocationOnAccount,
  ]);

  const sendMessage = useCallback(
    async (trimmed: string) => {
      // Append user message
      const userMsgId = nextId();
      setMessages((prev) => [
        ...prev,
        { role: "user", text: trimmed, id: userMsgId },
      ]);
      setThinking(true);
      setThinkingWithPhrases(!conversationId);
      forceScroll();

      // E2: hoisted so the catch can finalize or RECOVER a dangling partial
      // bubble (resumable streams — re-attach instead of dropping the answer).
      let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let streamingMsgId: string | null = null;
      let recoveryConvId: string | null = conversationId;
      const progress: StreamProgress = { offset: 0 };

      // Landing handoff wins; otherwise the chat's own geo toggle, but only
      // for the first message (the server binds coords at creation).
      const location =
        pendingLocationRef.current ??
        (!conversationId && coords ? coords : undefined);
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
        if (convId) recoveryConvId = convId;
        if (convId && !conversationId) {
          setConversationId(convId);
          // Make refresh/share land on the persisted conversation.
          try {
            window.history.replaceState(null, "", `/ask/${convId}`);
          } catch {
            // history unavailable — non-fatal
          }
        }

        // L6: non-OK HTTP first (402 out_of_credits and 429 rate_limited are
        // legitimate gates with a renderable JSON body).
        if (
          !response.ok &&
          response.status !== 402 &&
          response.status !== 429
        ) {
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

          if (!reader) {
            setStreaming(false);
            return;
          }
          activeReader = reader;

          // Body is the visible answer as plain UTF-8 (server strips thinking
          // + JSON frames). Append verbatim; do NOT parse as SSE. progress
          // tracks the offset a re-attach would resume from.
          await pumpStream(reader, progress, applyStreamChunk(assistantMsgId));

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
            // Frozen banner below the input renders the limit copy; appending
            // a gate message too would show it twice (and refresh only
            // restores the frozen flag, not the message).
            setFrozen(true);
          } else if (isPersonaGate(gateType)) {
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

        // The drawer (ask-shell) is server-rendered; re-fetch the RSC payload
        // so a just-created conversation (and its title after the lifecycle
        // transition) shows up without a hard reload. Client chat state is
        // preserved across refresh.
        if (session) {
          router.refresh();
        }
      } catch {
        setThinking(false);

        if (activeReader) {
          try {
            await activeReader.cancel();
          } catch {
            // reader already errored/closed — nothing to cancel.
          }
        }

        // Resumable streams: a broken read mid-answer is NOT an error — the
        // server keeps generating. Re-attach from the offset we already have
        // (or park it for the visibilitychange listener if we're hidden).
        // streaming stays true so the input remains locked meanwhile.
        if (streamingMsgId && recoveryConvId) {
          const dangling: DanglingStream = {
            conversationId: recoveryConvId,
            msgId: streamingMsgId,
            progress,
          };
          if (document.hidden) {
            danglingRef.current = dangling;
          } else {
            void recoverStream(dangling);
          }
          return;
        }

        setStreaming(false);
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: GENERIC_STREAM_ERROR,
            id: nextId(),
          },
        ]);
        forceScroll();
      }
    },
    [
      conversationId,
      coords,
      forceScroll,
      router,
      session,
      applyStreamChunk,
      recoverStream,
    ],
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

  // Landing handoff: auto-submit the pending prompt exactly once — unless the
  // terms gate is still up, in which case the prompt is held and fired from
  // the accept handler instead.
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
      if (initialTosAccepted) {
        void sendMessage(pending.text);
      } else {
        setHeldPrompt(pending.text);
      }
    }
  }, [autoSubmitPending, sendMessage, initialTosAccepted]);

  const acceptTos = useCallback(() => {
    writeTosCookie(TOS_VERSION);
    setTosAccepted(true);
    if (session) postPreferences({ tosAccepted: true });
    if (heldPrompt) {
      setHeldPrompt(null);
      void sendMessage(heldPrompt);
    }
  }, [session, heldPrompt, sendMessage]);

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
              src={gubbeIcon}
              alt="Fiskargubben"
              width={96}
              height={96}
              className="rounded-full shadow-lg opacity-90"
            />
            <div className="text-center space-y-2">
              <p className="text-base text-muted-foreground font-medium">
                Vad undrar du? Sjö, kust eller fisket i stort.
              </p>
              <p className="text-xs text-muted-foreground/60">
                t.ex. "Ska jag fiska abborre i Vättern imorgon tidigt?" eller
                "Var hittar jag makrillen i skärgården?"
              </p>
            </div>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === "user") {
            return <UserBubble key={msg.id} text={msg.text} />;
          }
          if (msg.role === "assistant") {
            return <AssistantBubble key={msg.id} text={msg.text} />;
          }
          return (
            <GateBanner
              key={msg.id}
              gateType={msg.gateType}
              text={msg.text}
              loggedIn={!!session}
            />
          );
        })}

        {thinking && <ThinkingIndicator withPhrases={thinkingWithPhrases} />}
        <div ref={bottomRef} />
      </section>

      {/* Terms gate — blocks the first message until accepted */}
      {!tosAccepted && (
        <div className="tos-gate shrink-0 mx-4 mb-2 rounded-xl border border-border bg-card px-5 py-4 text-center shadow-sm">
          <p className="text-sm font-medium text-foreground">
            {tosUpdated
              ? "Villkoren har uppdaterats. Godkänn dem för att fortsätta."
              : "Fiskargubbens svar genereras av AI och kan innehålla fel. Fisket sker på egen risk."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Genom att fortsätta godkänner du{" "}
            <Link
              href="/termsofservice"
              className="underline underline-offset-2"
            >
              användarvillkoren
            </Link>{" "}
            och{" "}
            <Link
              href="/privacystatement"
              className="underline underline-offset-2"
            >
              integritetspolicyn
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={acceptTos}
            className="mt-3 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Godkänn och fortsätt
          </button>
        </div>
      )}

      {/* Frozen system notice */}
      {frozen && (
        <ChatLimitBanner
          ariaLabel="Chatt fryst"
          className="frozen-banner shrink-0 mx-4 mb-2 flex items-center gap-3 rounded-lg border border-stone-300/70 bg-stone-100/60 px-4 py-3 text-xs text-stone-600"
          loggedIn={!!session}
        />
      )}

      {/* Location nudge — only before the first message binds the coords */}
      {showLocationTip && !conversationId && geo === "off" && tosAccepted && (
        <LocationTip className="shrink-0 px-4 pb-1" />
      )}

      {/* Input area */}
      <form
        onSubmit={handleSubmit}
        className="chat-input-area shrink-0 border-t border-border bg-card/80 px-4 py-3 flex items-end gap-3"
      >
        <label htmlFor="chat-input" className="sr-only">
          Skriv din fråga
        </label>
        {!conversationId && (
          <button
            type="button"
            onClick={toggleLocation}
            aria-pressed={geo === "on"}
            aria-label="Använd min plats"
            title={
              geo === "on"
                ? "Plats används"
                : geo === "loading"
                  ? "Hämtar plats…"
                  : geo === "denied"
                    ? "Plats nekad"
                    : "Använd min plats"
            }
            // size-11 (44px) matches the single-row textarea height (border +
            // py-2.5 + text line) so pin, input and submit sit level.
            className={`flex size-11 shrink-0 items-center justify-center rounded-lg border transition-colors ${
              geo === "on"
                ? "border-primary/40 bg-primary/10 text-primary"
                : geo === "denied"
                  ? "border-border bg-card text-muted-foreground/50"
                  : "border-border bg-card text-muted-foreground hover:bg-secondary"
            } ${geo === "loading" ? "animate-pulse" : ""}`}
          >
            <svg
              viewBox="0 0 24 24"
              className="size-5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M12 21s-7-5.4-7-11a7 7 0 1 1 14 0c0 5.6-7 11-7 11Z" />
              <circle cx="12" cy="10" r="2.5" />
            </svg>
          </button>
        )}
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
          className="h-11 shrink-0 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
          aria-label="Skicka fråga"
        >
          <span className="sm:hidden">Fråga</span>
          <span className="hidden sm:inline">Fråga gubben</span>
        </button>
      </form>
    </div>
  );
}
