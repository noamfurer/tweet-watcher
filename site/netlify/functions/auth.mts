import type { Context } from "@netlify/functions";
import {
  clearSessionCookie,
  createSessionCookie,
  isAuthorized,
  passwordMatches,
} from "./_shared/auth.mts";
import { json } from "./_shared/http.mts";

export default async (request: Request, _context: Context) => {
  if (request.method === "GET") return json({ unlocked: await isAuthorized(request) });
  if (request.method === "DELETE") {
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const body = await request.json().catch(() => ({})) as { password?: string };
  if (!body.password || !await passwordMatches(String(body.password))) {
    await new Promise((resolve) => setTimeout(resolve, 450));
    return json({ error: "סיסמה שגויה, נסה שוב." }, 401);
  }
  return json({ ok: true }, 200, { "Set-Cookie": await createSessionCookie() });
};
