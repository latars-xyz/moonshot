import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { corsHeaders } from "@/lib/rates";

export { bearer, readJson } from "@/lib/ads-route";

export function reply(req: NextRequest, body: unknown, status = 200) {
  const headers = corsHeaders(req.headers.get("origin"));
  return body === null ? new NextResponse(null, { status, headers }) : NextResponse.json(body, { status, headers });
}

export function preflight(req: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}
