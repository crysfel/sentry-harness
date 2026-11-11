import { NextResponse, type NextRequest } from "next/server";
import { isValidSession, passwordRequired, SESSION_COOKIE } from "./app/lib/auth";

export async function proxy(request: NextRequest) {
  if (!passwordRequired()) return NextResponse.next();
  if (!process.env.DASHBOARD_PASSWORD) {
    return new NextResponse("DASHBOARD_PASSWORD must be set when the dashboard is not bound to localhost.", { status: 503 });
  }
  if (request.nextUrl.pathname === "/login") return NextResponse.next();
  if (await isValidSession(request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  if (request.method !== "GET") return new NextResponse("Unauthorized", { status: 401 });
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?next=${encodeURIComponent(request.nextUrl.pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
