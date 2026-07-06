/**
 * chat.test.tsx — focused component tests for the Chat UI.
 *
 * Coverage:
 *  1. Submitting the form calls fetch to /api/ask with the typed message.
 *  2. A `chat_limit` gate JSON response renders the plain system banner
 *     (NOT as an assistant bubble; looks for the "Konversationsgränsen" text).
 *  3. A `topic_refused` gate response renders as a persona (assistant) bubble
 *     (inside .chat-bubble-assistant with the gate text).
 *  4. A streamed text/plain response appends text to an assistant bubble.
 *  5. register_to_continue gate renders the CTA with login/register links.
 *
 * Streaming in jsdom is fiddly; we cover it lightly (ReadableStream mock).
 * Live streaming end-to-end is deferred to the Phase 6.2 Playwright e2e.
 *
 * Note: @testing-library/jest-dom is not installed; we use plain expect() +
 * toBeNull / toBeTruthy / toContain / toBe assertions throughout.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Chat from "./chat";

// ---------------------------------------------------------------------------
// Mock next/image (jsdom can't load images)
// ---------------------------------------------------------------------------

vi.mock("next/image", () => ({
  // Use a span instead of img to avoid biome noImgElement in tests
  default: ({ alt }: { alt: string }) => (
    <span data-testid="img-stub">{alt}</span>
  ),
}));

// ---------------------------------------------------------------------------
// Mock next/link
// ---------------------------------------------------------------------------

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [k: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

// ---------------------------------------------------------------------------
// Mock next/navigation (Chat calls router.refresh() to revalidate the drawer)
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Mock useSession — default: logged out
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJsonResponse(body: object, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeStreamResponse(text: string, conversationId = "conv-abc") {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Conversation-Id": conversationId,
    },
  });
}

async function typeAndSubmit(message: string) {
  const textarea = screen.getByRole("textbox", { name: /skriv din fråga/i });
  fireEvent.change(textarea, { target: { value: message } });
  const button = screen.getByRole("button", { name: /skicka fråga/i });
  fireEvent.click(button);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Chat component", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("1. calls fetch /api/ask with the typed message on submit", async () => {
    const fetchMock = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(makeStreamResponse("Prova maskkroken."));

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("Ska jag fiska i Vättern imorgon?");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ask");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.message).toBe("Ska jag fiska i Vättern imorgon?");
  });

  it("2. chat_limit gate freezes the chat with exactly one banner (not an assistant bubble)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeJsonResponse({ type: "chat_limit", text: "Chat limit reached." }),
    );

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("En fråga till");

    await waitFor(() => {
      // The frozen banner — <section aria-label="Chatt fryst"> → role "region"
      expect(
        screen.queryByRole("region", { name: /chatt fryst/i }),
      ).not.toBeNull();
    });

    const banner = screen.getByRole("region", { name: /chatt fryst/i });
    expect(banner.textContent).toContain("Konversationsgränsen");
    // Must NOT be wrapped in .chat-bubble-assistant
    expect(banner.closest(".chat-bubble-assistant")).toBeNull();
    // No duplicate copy in the message list (the pre-fix bug: the gate was
    // ALSO appended as a message, so the banner rendered twice live).
    expect(screen.getAllByText(/Konversationsgränsen/i)).toHaveLength(1);
  });

  it("3. topic_refused gate renders as an assistant persona bubble", async () => {
    const gateText = "Det där är inget fiske — prata om sjöar istället.";
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeJsonResponse({ type: "topic_refused", text: gateText }),
    );

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("Vad är meningen med livet?");

    await waitFor(() => {
      expect(screen.queryByText(gateText)).not.toBeNull();
    });

    const bubble = screen.getByText(gateText).closest(".chat-bubble-assistant");
    expect(bubble).toBeTruthy();
  });

  it("4. streamed text/plain response populates an assistant bubble", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeStreamResponse("Prova maskkroken vid vassen tidigt på morgonen."),
    );

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("Tips för abborre?");

    await waitFor(() => {
      expect(screen.queryByText(/Prova maskkroken vid vassen/i)).not.toBeNull();
    });

    const bubble = screen
      .getByText(/Prova maskkroken vid vassen/i)
      .closest(".chat-bubble-assistant");
    expect(bubble).toBeTruthy();
  });

  it("5. register_to_continue gate renders the CTA opening the auth dialog", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      makeJsonResponse({
        type: "register_to_continue",
        text: "Registrera dig för att fortsätta.",
      }),
    );

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("Ännu en fråga");

    await waitFor(() => {
      // CTA gate has class gate-cta and role=status
      const cta = document.querySelector(".gate-cta");
      expect(cta).not.toBeNull();
    });

    const cta = document.querySelector(".gate-cta") as HTMLElement;
    expect(cta.textContent).toContain("konto");
    // Auth lives in a dialog — the CTA stays on the current page and opens it
    // via the header's ?auth=1 auto-open param (no homepage round-trip).
    expect(cta.querySelector('a[href="?auth=1"]')).toBeTruthy();
  });

  it("6. clarify gate renders as an assistant persona bubble and keeps the conversation id", async () => {
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "clarify",
          text: "Vilken kommun ligger sjön i?",
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Conversation-Id": "conv-clarify-1",
          },
        },
      ),
    );

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("Vad biter i sjön?");

    await waitFor(() => {
      const bubbles = document.querySelectorAll(".chat-bubble-assistant");
      const hasClarify = Array.from(bubbles).some((b) =>
        b.textContent?.includes("Vilken kommun ligger sjön i?"),
      );
      expect(hasClarify).toBe(true);
    });

    // Not rendered as a banner gate.
    expect(document.querySelector(".gate-cta")).toBeNull();
  });

  it("7. X-Signals header renders the badges strip", async () => {
    const badges = {
      lake: "Tolken (Borås, Västra Götaland)",
      status: "resolved",
      airTempC: 17.3,
      windMs: 4.2,
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("Prova jigg."));
        controller.close();
      },
    });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Conversation-Id": "conv-badges-1",
          "X-Signals": encodeURIComponent(JSON.stringify(badges)),
        },
      }),
    );

    render(<Chat initialTosAccepted />);
    await typeAndSubmit("Vad biter i Tolken?");

    await waitFor(() => {
      const strip = document.querySelector('[aria-label="Fångad data"]');
      expect(strip).not.toBeNull();
      expect(strip?.textContent).toContain("Tolken");
      expect(strip?.textContent).toContain("m/s");
    });
  });

  it("8. renders server-loaded initial messages and badges", () => {
    render(
      <Chat
        initialTosAccepted
        conversationId="conv-1"
        initialMessages={[
          { role: "user", text: "Vad biter i Tolken?", id: "m1" },
          { role: "assistant", text: "Abborren står djupt.", id: "m2" },
        ]}
        initialBadges={{
          lake: "Tolken (Borås, Västra Götaland)",
          status: "resolved",
          waterTempC: 16,
        }}
      />,
    );

    expect(document.body.textContent).toContain("Vad biter i Tolken?");
    expect(document.body.textContent).toContain("Abborren står djupt.");
    const strip = document.querySelector('[aria-label="Fångad data"]');
    expect(strip?.textContent).toContain("Vatten");
  });

  it("9. terms gate blocks input until accepted, then unlocks", async () => {
    render(<Chat />);

    // Gate visible from first render, input disabled.
    expect(document.body.textContent).toContain("genereras av AI");
    const textarea = document.querySelector<HTMLTextAreaElement>("#chat-input");
    expect(textarea?.disabled).toBe(true);

    // Accept → gate gone, input enabled, cookie stored.
    fireEvent.click(screen.getByText("Godkänn och fortsätt"));
    await waitFor(() => {
      expect(document.body.textContent).not.toContain("genereras av AI");
      expect(textarea?.disabled).toBe(false);
    });
    expect(document.cookie).toContain("fg_tos_v=1");
  });

  it("10. first-time gate does NOT show the updated-terms copy", () => {
    render(<Chat />);
    expect(document.body.textContent).toContain("genereras av AI");
    expect(document.body.textContent).not.toContain(
      "Villkoren har uppdaterats",
    );
  });

  it("11. previously accepted older version → updated-terms copy", async () => {
    // Server resolved: accepted SOME version, but not the current one.
    render(
      <Chat initialTosAccepted={false} initialTosPreviouslyAccepted={true} />,
    );

    expect(document.body.textContent).toContain("Villkoren har uppdaterats");
    fireEvent.click(screen.getByText("Godkänn och fortsätt"));
    await waitFor(() => {
      expect(document.body.textContent).not.toContain(
        "Villkoren har uppdaterats",
      );
    });
  });
});
