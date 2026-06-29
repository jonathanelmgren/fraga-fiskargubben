import { searchLakes } from "@/lib/lakes/resolve";

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";

  if (!q) {
    return Response.json([]);
  }

  const hits = await searchLakes(q);
  return Response.json(hits);
}
