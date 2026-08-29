import type { Config, Context } from "@netlify/functions";
import { ingestExternalResults, type ExternalWatchResult } from "./_shared/external-ingest.mts";
import { githubOidcAudience, requireGithubOidc } from "./_shared/github-oidc.mts";
import { json, safeError } from "./_shared/http.mts";
import { readWatches } from "./_shared/storage.mts";

export default async (request: Request, _context: Context) => {
  try {
    await requireGithubOidc(request);
    if (request.method === "GET") {
      const watches = (await readWatches())
        .filter((watch) => watch.active)
        .sort((a, b) => a.position - b.position)
        .slice(0, 12)
        .map(({ id, type, query }) => ({ id, type, query }));
      return json({ watches, audience: githubOidcAudience });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { results?: ExternalWatchResult[] };
      if (!Array.isArray(body.results)) return json({ error: "Invalid results" }, 400);
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
