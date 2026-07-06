import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
      <p className="text-sm font-semibold text-muted-foreground">404</p>
      <h1 className="text-2xl font-semibold tracking-tight">
        Här nappar det inte.
      </h1>
      <p className="max-w-sm text-sm text-muted-foreground">
        Sidan du letar efter finns inte — den kan ha flyttats eller aldrig
        funnits.
      </p>
      <Link
        href="/"
        className="mt-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        Till startsidan
      </Link>
    </main>
  );
}
