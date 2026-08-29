import type { Context } from "@netlify/functions";
import { getRuntimeSecrets } from "./_shared/runtime-secrets.mts";

function israelWindow(now = new Date()) {
  const parts: Record<string, string> = {};
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now).forEach((part) => { parts[part.type] = part.value; });
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday ?? "Sat"] ?? 6;
  const hour = Number(parts.hour ?? 0) % 24;
  return (day <= 4 && hour >= 7 && hour < 23) || (day === 5 && hour >= 7 && hour < 16);
}

export default async (_request: Request, context: Context) => {
  if (!israelWindow()) return new Response("Outside activity window", { status: 200 });
  const { cronSecret } = await getRuntimeSecrets();
  const response = await fetch(`${context.site.url}/.netlify/functions/ingest-background`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Monitor-Cron": cronSecret },
    body: JSON.stringify({ watchId: null }),
  });
  return new Response(response.ok || response.status === 202 ? "Queued" : "Queue failed", {
    status: response.ok || response.status === 202 ? 200 : 502,
  });
};
