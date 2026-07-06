"use client";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">
        Något gick snett.
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Ett oväntat fel inträffade. Försök igen — och hör av dig till supporten
        om det fortsätter.
      </p>
      <button
        type="button"
        onClick={reset}
        className="mt-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        Försök igen
      </button>
    </main>
  );
}
