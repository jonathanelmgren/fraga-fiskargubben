import type { Metadata } from "next";
import { AskShell } from "./ask-shell";
import Chat from "./chat";

export const metadata: Metadata = {
  title: "Fråga Fiskargubben — Chatt",
};

/**
 * New-chat view. Auto-submits the landing hero's pending prompt (from
 * sessionStorage); once the server answers, the client swaps the URL to
 * /ask/<id> so the conversation is shareable/refreshable.
 */
export default function AskPage() {
  return (
    <AskShell>
      <Chat autoSubmitPending />
    </AskShell>
  );
}
