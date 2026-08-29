import type { Context } from "@netlify/functions";
import { runIngest } from "./_shared/ingest.mts";
import { getRuntimeSecrets } from "./_shared/runtime-secrets.mts";
import { writeIngestStatus } from "./_shared/storage.mts";

export default async (request: Request, _context: Context) => {
  const { cronSecret } = await getRuntimeSecrets();
  if (request.headers.get("x-monitor-cron") !== cronSecret) {
    return new Response("Unauthorized", { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as { watchId?: string | null };
  const startedAt = Date.now();
  await writeIngestStatus({
    state: "running",
    startedAt,
    completedAt: null,
    checked: 0,
    inserted: 0,
    failed: 0,
    message: null,
  });
  try {
    const result = await runIngest(body.watchId ?? null);
    await writeIngestStatus({
      state: "completed",
      startedAt,
      completedAt: Date.now(),
      checked: result.checked,
      inserted: result.inserted,
      failed: result.failed,
      message: result.skipped ? "בדיקה אחרת כבר מתבצעת" : null,
    });
    console.log(JSON.stringify({ event: "ingest-complete", checked: result.checked, inserted: result.inserted, failed: result.failed, skipped: result.skipped }));
    return new Response(null, { status: 204 });
  } catch (error) {
    await writeIngestStatus({
      state: "failed",
      startedAt,
      completedAt: Date.now(),
      checked: 0,
      inserted: 0,
      failed: 0,
      message: "הבדיקה נכשלה לפני שהושלמה",
    });
    throw error;
  }
};
