import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import { getRuntimeSecrets } from "./runtime-secrets.mts";

const COOKIE_NAME = "mx_session";
const MONTH_SECONDS = 60 * 60 * 24 * 30;

function equalText(a: string, b: string) {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

export async function passwordMatches(input: string) {
  const secrets = await getRuntimeSecrets();
  const candidate = scryptSync(input, secrets.passwordSalt, 32).toString("hex");
  return equalText(candidate, secrets.passwordHash);
}

export async function createSessionCookie() {
  const secrets = await getRuntimeSecrets();
  const expires = Math.floor(Date.now() / 1000) + MONTH_SECONDS;
  const payload = String(expires);
  const signature = createHmac("sha256", secrets.sessionSecret).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${MONTH_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function isAuthorized(request: Request) {
  const cookie = request.headers.get("cookie") ?? "";
  const pair = cookie.split(/;\s*/).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  const token = pair?.slice(COOKIE_NAME.length + 1) ?? "";
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !/^\d+$/.test(payload)) return false;
  if (Number(payload) < Math.floor(Date.now() / 1000)) return false;
  const secrets = await getRuntimeSecrets();
  const expected = createHmac("sha256", secrets.sessionSecret).update(payload).digest("base64url");
  return equalText(signature, expected);
}

export async function requireAuth(request: Request) {
  if (!await isAuthorized(request)) throw new Error("Unauthorized");
}
