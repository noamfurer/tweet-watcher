import type { Context } from "@netlify/functions";
import { randomUUID } from "node:crypto";
import { requireAuth } from "./_shared/auth.mts";
import { json, safeError } from "./_shared/http.mts";
import {
  readTweets,
  readIngestStatus,
  readWatches,
  writeTweets,
  writeWatches,
  type StoredWatch,
  type WatchType,
} from "./_shared/storage.mts";

type Payload = Record<string, unknown>;

function asString(value: unknown, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => asString(item, 100)).filter(Boolean).slice(0, 30) : [];
}

export default async (request: Request, _context: Context) => {
  try {
    await requireAuth(request);
    if (request.method === "GET") {
      const [watches, tweets, runStatus] = await Promise.all([readWatches(), readTweets(), readIngestStatus()]);
      return json({ watches: watches.sort((a, b) => a.position - b.position), tweets: tweets.slice(0, 1200), runStatus });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const body = await request.json().catch(() => ({})) as { action?: string; payload?: Payload };
    const action = asString(body.action, 60);
    const payload = body.payload ?? {};

    if (action === "saveWatch") {
      const watches = await readWatches();
      const id = asString(payload.id, 80) || randomUUID();
      const query = asString(payload.query, 500);
      if (!query) return json({ error: "שאילתה ריקה" }, 400);
      const type: WatchType = payload.type === "user" ? "user" : "keyword";
      const existing = watches.find((watch) => watch.id === id);
      const next: StoredWatch = {
        id,
        type,
        title: asString(payload.title, 160) || query,
        query,
        exclude: asStringArray(payload.exclude),
        active: payload.active !== false,
        position: existing?.position ?? watches.length,
        lastCheck: existing?.lastCheck ?? 0,
        lastError: existing?.lastError ?? null,
      };
      const result = existing ? watches.map((watch) => watch.id === id ? next : watch) : [...watches, next];
      await writeWatches(result);
      return json({ id });
    }

    if (action === "deleteWatch") {
      const id = asString(payload.id, 80);
      const [watches, tweets] = await Promise.all([readWatches(), readTweets()]);
      await Promise.all([
        writeWatches(watches.filter((watch) => watch.id !== id).map((watch, index) => ({ ...watch, position: index }))),
        writeTweets(tweets.filter((tweet) => tweet.w !== id)),
      ]);
      return json({ ok: true });
    }

    if (action === "setWatchActive") {
      const id = asString(payload.id, 80);
      const watches = await readWatches();
      await writeWatches(watches.map((watch) => watch.id === id ? { ...watch, active: payload.active === true } : watch));
      return json({ ok: true });
    }

    if (action === "moveWatch") {
      const id = asString(payload.id, 80);
      const direction = Number(payload.direction) < 0 ? -1 : 1;
      const watches = (await readWatches()).sort((a, b) => a.position - b.position);
      const index = watches.findIndex((watch) => watch.id === id);
      const other = index + direction;
      if (index >= 0 && other >= 0 && other < watches.length) {
        [watches[index], watches[other]] = [watches[other]!, watches[index]!];
        await writeWatches(watches.map((watch, position) => ({ ...watch, position })));
      }
      return json({ ok: true });
    }

    if (action === "setTweetUnread") {
      const id = asString(payload.id, 80);
      const tweets = await readTweets();
      await writeTweets(tweets.map((tweet) => tweet.id === id ? { ...tweet, unread: payload.unread === true } : tweet));
      return json({ ok: true });
    }

    if (action === "setManyUnread") {
      const watchId = asString(payload.watchId, 80);
      const tweets = await readTweets();
      await writeTweets(tweets.map((tweet) => !watchId || tweet.w === watchId ? { ...tweet, unread: payload.unread === true } : tweet));
      return json({ ok: true });
    }

    if (action === "runCheck") {
      return json({ queued: true, mode: "github-schedule" });
    }

    return json({ error: "פעולה לא מוכרת" }, 400);
  } catch (error) {
    const unauthorized = error instanceof Error && /Unauthorized/.test(error.message);
    return json({ error: safeError(error) }, unauthorized ? 401 : 500);
  }
};
