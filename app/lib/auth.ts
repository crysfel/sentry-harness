/**
 * Single shared password (PLAN §9 "Access"). Required whenever the dashboard is
 * bound beyond localhost; optional otherwise. Session = HMAC of a fixed label
 * with the password, in an httpOnly cookie. Works in the proxy and in actions.
 */
export const SESSION_COOKIE = "harness_session";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function passwordRequired(): boolean {
  const host = process.env.DASHBOARD_HOST ?? "127.0.0.1";
  return !LOOPBACK.has(host) || !!process.env.DASHBOARD_PASSWORD;
}

export async function sessionToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("sentry-harness-session-v1"));
  return Buffer.from(sig).toString("base64url");
}

export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  if (!passwordRequired()) return true;
  const pw = process.env.DASHBOARD_PASSWORD;
  if (!pw || !cookieValue) return false;
  return safeEqual(cookieValue, await sessionToken(pw));
}
