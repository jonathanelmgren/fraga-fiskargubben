import { searchLakes } from "@/lib/lakes/resolve";

/** L2: bound the public, unauthenticated typeahead query length. */
const MIN_Q_LENGTH = 2;
const MAX_Q_LENGTH = 64;

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();

  // L2: require ≥2 chars and cap length so a single keystroke / huge query
  // can't drive an expensive scan on this public endpoint (pairs with H10).
  if (q.length < MIN_Q_LENGTH || q.length > MAX_Q_LENGTH) {
    return Response.json([]);
  }

  // H1: wrap in a try/catch error boundary so a DB failure returns a stable
  // JSON body instead of a raw Next 500 (no stack leak in dev).  The typeahead
  // consumer treats a non-array / empty result as "no hits".
  try {
    const hits = await searchLakes(q);
    return Response.json(hits);
  } catch {
    return Response.json(
      { error: "lake search temporarily unavailable" },
      { status: 503 },
    );
  }
}
