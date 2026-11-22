import { readEncrypted, writeEncrypted } from "./storage.mts";

const KEY = "apify-settings.v1";
const APIFY_API = "https://api.apify.com/v2";

export type ApifyErrorCode = "apify-auth" | "apify-credit" | "apify-error" | "source-unavailable";

export interface ApifyRunReport {
  at: number;
  source: "site" | "github-secret" | "none";
  ok: boolean;
  code: ApifyErrorCode | null;
  detail: string | null;
}

interface StoredApifySettings {
  token: string | null;
  updatedAt: number | null;
  username: string | null;
  lastRun: ApifyRunReport | null;
}

const EMPTY: StoredApifySettings = { token: null, updatedAt: null, username: null, lastRun: null };

export async function readApifySettings(): Promise<StoredApifySettings> {
  return { ...EMPTY, ...(await readEncrypted<Partial<StoredApifySettings>>(KEY, {})) };
}

async function patchApifySettings(patch: Partial<StoredApifySettings>) {
  const current = await readApifySettings();
  await writeEncrypted(KEY, { ...current, ...patch });
}

export async function readApifyToken() {
  return (await readApifySettings()).token;
}

export async function saveApifyToken(token: string, username: string | null) {
  await patchApifySettings({ token, username, updatedAt: Date.now(), lastRun: null });
}

export async function clearApifyToken() {
  await patchApifySettings({ token: null, username: null, updatedAt: Date.now(), lastRun: null });
}

export async function recordApifyRun(report: ApifyRunReport) {
  await patchApifySettings({ lastRun: report });
}

/** What the browser is allowed to see. Never includes the token itself. */
export async function publicApifySettings() {
  const settings = await readApifySettings();
  return {
    configured: Boolean(settings.token),
    last4: settings.token ? settings.token.slice(-4) : null,
    updatedAt: settings.updatedAt,
    username: settings.username,
    lastRun: settings.lastRun,
  };
}

export function cleanToken(value: unknown) {
  const token = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_\-]{20,200}$/.test(token)) {
    throw new Error("המפתח לא נראה כמו API token של Apify (בדרך כלל מתחיל ב-apify_api_)");
  }
  return token;
}

async function apifyGet(path: string, token: string) {
  const response = await fetch(`${APIFY_API}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => ({})) as { data?: Record<string, any> };
  return { ok: response.ok, status: response.status, data: payload.data ?? null };
}

/** Checks the token against Apify and returns the account name plus this month's usage, if Apify reports it. */
export async function inspectApifyToken(token: string) {
  const me = await apifyGet("/users/me", token).catch(() => null);
  if (!me) throw new Error("לא ניתן להתחבר ל-Apify כרגע. נסה שוב בעוד דקה.");
  if (me.status === 401 || me.status === 403) throw new Error("Apify דחה את המפתח. ודא שהעתקת אותו במלואו ושהוא לא נמחק.");
  if (!me.ok || !me.data) throw new Error(`Apify החזיר שגיאה (${me.status})`);

  const username = String(me.data.username || me.data.email || "") || null;
  let usageUsd: number | null = null;
  let limitUsd: number | null = null;
  const limits = await apifyGet("/users/me/limits", token).catch(() => null);
  if (limits?.ok && limits.data) {
    const used = Number(limits.data.current?.monthlyUsageUsd);
    const max = Number(limits.data.limits?.maxMonthlyUsageUsd);
    usageUsd = Number.isFinite(used) ? used : null;
    limitUsd = Number.isFinite(max) ? max : null;
  }
  return { username, usageUsd, limitUsd };
}

export function apifyErrorMessage(code: string | null | undefined) {
  switch (code) {
    case "apify-auth":
      return "Apify דחה את המפתח. אפשר להחליף אותו בלשונית הגדרות";
    case "apify-credit":
      return "נגמר הקרדיט החודשי ב-Apify. אפשר להחליף מפתח בלשונית הגדרות";
    case "apify-missing":
      return "לא הוגדר מפתח Apify. אפשר להוסיף אותו בלשונית הגדרות";
    case "apify-error":
      return "Apify החזיר שגיאה בהרצה האחרונה; יתבצע ניסיון נוסף";
    case "account-unavailable":
      return "לא ניתן היה לקרוא את הציוצים של החשבון בהרצה האחרונה; יתבצע ניסיון נוסף";
    default:
      return "מקור הנתונים לא היה זמין בהרצה האחרונה; יתבצע ניסיון נוסף";
  }
}
