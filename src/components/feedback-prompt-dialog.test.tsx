/**
 * feedback-prompt-dialog.test.tsx — funnel-event wiring of the feedback dialog.
 * Same conventions as auth-dialog.test.tsx: jsdom, no jest-dom, plain expect().
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeedbackPromptDialog } from "./feedback-prompt-dialog";

const fetchMock = vi.fn();

function sentActions(): Array<Record<string, unknown>> {
  return fetchMock.mock.calls.map(([, init]) =>
    JSON.parse((init as RequestInit).body as string),
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("NEXT_PUBLIC_DISCORD_INVITE", "https://discord.gg/test");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("FeedbackPromptDialog", () => {
  it("renders nothing on the server pass (SSR crash regression, digest eb8d1abf)", () => {
    // AskShell renders this during SSR when the feedback gate is due, but the
    // portal target is document.body — which does not exist on the server.
    // renderToString runs no effects, exactly like the SSR pass: the mount
    // guard must keep the output empty so createPortal is never reached.
    expect(renderToString(<FeedbackPromptDialog />)).toBe("");
  });

  it("posts shown exactly once on mount", async () => {
    render(<FeedbackPromptDialog />);
    await waitFor(() => expect(sentActions()).toEqual([{ action: "shown" }]));
  });

  it("posts dismissed when closed without any action", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.click(screen.getAllByLabelText("Stäng")[1]); // X button (index 0 is backdrop)
    await waitFor(() =>
      expect(sentActions()).toEqual([
        { action: "shown" },
        { action: "dismissed" },
      ]),
    );
    expect(screen.queryByRole("dialog")).toBe(null);
  });

  it("posts submitted with the message and shows thanks, no dismissed", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Vad funkar bra/), {
      target: { value: "Bra app!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() =>
      expect(screen.getByText(/Tack för din feedback/)).toBeTruthy(),
    );
    expect(sentActions()).toEqual([
      { action: "shown" },
      { action: "submitted", message: "Bra app!" },
    ]);
  });

  it("does not submit an empty message", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() => expect(sentActions()).toEqual([{ action: "shown" }]));
  });

  it("posts discord_clicked on the invite link; closing after is not dismissed", async () => {
    render(<FeedbackPromptDialog />);
    fireEvent.click(screen.getByRole("link", { name: /Discord/ }));
    fireEvent.click(screen.getAllByLabelText("Stäng")[1]);
    await waitFor(() =>
      expect(sentActions()).toEqual([
        { action: "shown" },
        { action: "discord_clicked" },
      ]),
    );
  });

  it("does not fire dismissed again when Escape is pressed after dialog is closed", async () => {
    render(<FeedbackPromptDialog />);
    // Close via X button — should fire exactly one "dismissed".
    fireEvent.click(screen.getAllByLabelText("Stäng")[1]);
    await waitFor(() =>
      expect(sentActions()).toEqual([
        { action: "shown" },
        { action: "dismissed" },
      ]),
    );
    // Dialog is closed; subsequent Escape presses must not leak another POST.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "Escape" });
    // Allow a tick for any errant async POST to land.
    await new Promise((r) => setTimeout(r, 0));
    const dismissed = sentActions().filter((a) => a.action === "dismissed");
    expect(dismissed).toHaveLength(1);
  });

  it("keeps the form and shows an error when submit fails", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return body.action === "submitted" ? { ok: false } : { ok: true };
    });
    render(<FeedbackPromptDialog />);
    fireEvent.change(screen.getByPlaceholderText(/Vad funkar bra/), {
      target: { value: "Bra app!" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Skicka" }));
    await waitFor(() =>
      expect(screen.getByText(/gick inte att skicka/i)).toBeTruthy(),
    );
    expect(
      (screen.getByPlaceholderText(/Vad funkar bra/) as HTMLTextAreaElement)
        .value,
    ).toBe("Bra app!");
  });
});
