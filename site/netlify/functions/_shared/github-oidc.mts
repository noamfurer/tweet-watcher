import { createPublicKey, verify, type JsonWebKey } from "node:crypto";

const ISSUER = "https://token.actions.githubusercontent.com";
const AUDIENCE = "urn:tweetdeckbha:github-ingest";
const REPOSITORY = "noamfurer/tweet-watcher";
const WORKFLOW_REF = `${REPOSITORY}/.github/workflows/watch.yml@refs/heads/main`;
const JWKS_URL = `${ISSUER}/.well-known/jwks`;

function decodeJson(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

function includesAudience(value: unknown) {
  return value === AUDIENCE || (Array.isArray(value) && value.includes(AUDIENCE));
}

export async function requireGithubOidc(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new Error("Unauthorized");
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Unauthorized");

  const header = decodeJson(parts[0]!);
  const claims = decodeJson(parts[1]!);
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new Error("Unauthorized");

  const now = Math.floor(Date.now() / 1000);
  const exp = Number(claims.exp ?? 0);
  const nbf = Number(claims.nbf ?? 0);
  if (
    claims.iss !== ISSUER
    || !includesAudience(claims.aud)
    || claims.repository !== REPOSITORY
    || claims.ref !== "refs/heads/main"
    || claims.workflow_ref !== WORKFLOW_REF
    || !["schedule", "workflow_dispatch", "push"].includes(String(claims.event_name ?? ""))
    || exp < now - 30
    || exp > now + 15 * 60
    || nbf > now + 30
  ) throw new Error("Unauthorized");

  const response = await fetch(JWKS_URL, {
    headers: { accept: "application/json", "user-agent": "tweetdeckbha-netlify" },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error("Unauthorized");
  const body = await response.json() as { keys?: Array<JsonWebKey & { kid?: string; kty?: string }> };
  const jwk = body.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("Unauthorized");

  const valid = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(parts[2]!, "base64url"),
  );
  if (!valid) throw new Error("Unauthorized");
  return claims;
}

export const githubOidcAudience = AUDIENCE;
