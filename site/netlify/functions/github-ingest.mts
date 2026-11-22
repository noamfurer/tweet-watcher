import type { Config, Context } from "@netlify/functions";
import { ingestExternalResults, type ExternalWatchResult } from "./_shared/external-ingest.mts";
import { githubOidcAudience, requireGithubOidc } from "./_shared/github-oidc.mts";
import { json, safeError } from "./_shared/http.mts";
import { readWatches } from "./_shared/storage.mts";
import { readApifyToken, recordApifyRun, type ApifyRunReport } from "./_shared/apify-settings.mts";

function cleanReport(value: unknown): ApifyRunReport | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const source = raw.source === "site" || raw.source === "github-secret" ? raw.source : "none";
  const codes = ["apify-auth", "apify-credit", "apify-error", "source-unavailable"] as const;
  const code = codes.find((item) => item === raw.code) ?? null;
  return {
    at: Date.now(),
    source,
    ok: raw.ok === true,
    code: raw.ok === true ? null : code ?? "apify-error",
    detail: raw.ok === true ? null : String(raw.detail ?? "").slice(0, 200) || null,
  };
}

export default async (request: Request, _context: Context) => {
  try {
    await requireGithubOidc(request);
    if (request.method === "GET") {
      const watches = (await readWatches())
        .filter((watch) => watch.active)
        .sort((a, b) => a.position - b.position)
        .slice(0, 12)
        .map(({ id, type, query }) => ({ id, type, query }));
      // The verified GitHub workflow is the only caller that receives the Apify token.
      const apifyToken = await readApifyToken();
      return json({ watches, audience: githubOidcAudience, apifyToken });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { results?: ExternalWatchResult[]; apify?: unknown };
      if (!Array.isArray(body.results)) return json({ error: "Invalid results" }, 400);
      const report = cleanReport(body.apify);
      if (report) await recordApifyRun(report);
      return json(await ingestExternalResults(body.results));
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    const unauthorized = error instanceof Error && error.message === "Unauthorized";
    return json({ error: unauthorized ? "Unauthorized" : safeError(error) }, unauthorized ? 401 : 500);
  }
};

export const config: Config = {
  path: "/api/github-ingest",
  method: ["GET", "POST"],
};
