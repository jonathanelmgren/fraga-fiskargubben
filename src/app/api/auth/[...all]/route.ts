import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { withClientIpOnly } from "@/lib/auth/signup-ip";

const handlers = toNextJsHandler(auth);

export const GET = (request: Request) =>
  handlers.GET(withClientIpOnly(request));
export const POST = (request: Request) =>
  handlers.POST(withClientIpOnly(request));
