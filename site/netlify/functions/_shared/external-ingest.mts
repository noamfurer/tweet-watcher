import { randomUUID } from "node:crypto";
import {
  acquireLease,
  readTweets,
  readWatches,
  releaseLease,
  writeIngestStatus,
  writeTweets,
  writeWatches,
  type StoredTweet,
} from "./storage.mts";

export interface ExternalTweet {
  tweetId: string;
  authorName: string;
  handle: string;
  body: string;
  postedAt: string;
  media: boolean;
  url: string;
}

export interface ExternalWatchResult {
  watchId: string;
  tweets?: ExternalTweet[];
  error?: string;
}

function clean(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function normalizeTweet(value: ExternalTweet): ExternalTweet | null {
  const tweetId = clean(value.tweetId, 80);
  if (!/^\d{8,}$/.test(tweetId)) return null;
  const handle = clean(value.handle, 80).replace(/^@?/, "@");
  const posted = new Date(value.postedAt);
  const url = clean(value.url, 500);
  return {
    tweetId,
    authorName: clean(value.authorName, 180) || handle || "לא ידוע",
    handle,
    body: clean(value.body, 5_000),
    postedAt: (Number.isNaN(posted.getTime()) ? new Date() : posted).toISOString(),
    media: value.media === true,
    url: /^https:\/\/(?:x|twitter)\.com\//i.test(url)
      ? url
      : `https://x.com/${handle.replace(/^@/, "")}/status/${tweetId}`,
  };
}

export async function ingestExternalResults(input: ExternalWatchResult[]) {
  if (!(await acquireLease(3 * 60))) return { skipped: true, checked: 0, inserted: 0, failed: 0 };
  const startedAt = Date.now();
  await writeIngestStatus({ state: "running", startedAt, completedAt: null, checked: 0, inserted: 0, failed: 0, message: null });
  try {
    const [watches, currentTweets] = await Promise.all([readWatches(), readTweets()]);
    const active = new Map(watches.filter((watch) => watch.active).map((watch) => [watch.id, watch]));
    const updates = new Map<string, { lastCheck: number; lastError: string | null }>();
    const additions: StoredTweet[] = [];
    let checked = 0;
    let failed = 0;

    for (const result of input.slice(0, 12)) {
      const watch = active.get(clean(result.watchId, 80));
      if (!watch) continue;
      checked += 1;
      if (result.error) {
        failed += 1;
        updates.set(watch.id, {
          lastCheck: Date.now(),
          lastError: "TwitterWebViewer לא היה זמין בהרצת GitHub האחרונה; יתבצע ניסיון נוסף",
        });
        continue;
      }

      const excludes = watch.exclude.map((value) => value.toLowerCase()).filter(Boolean);
      for (const raw of (Array.isArray(result.tweets) ? result.tweets : []).slice(0, 60)) {
        const tweet = normalizeTweet(raw);
        if (!tweet) continue;
        if (excludes.some((value) => `${tweet.body} ${tweet.handle}`.toLowerCase().includes(value))) continue;
        additions.push({
          id: randomUUID(),
          w: watch.id,
          tweetId: tweet.tweetId,
          name: tweet.authorName,
          handle: tweet.handle,
          text: tweet.body,
          ts: new Date(tweet.postedAt).getTime(),
          unread: true,
          media: tweet.media,
          url: tweet.url,
        });
      }
      updates.set(watch.id, { lastCheck: Date.now(), lastError: null });
    }

    const seen = new Set(currentTweets.map((tweet) => `${tweet.w}:${tweet.tweetId}`));
    const fresh = additions.filter((tweet) => {
      const key = `${tweet.w}:${tweet.tweetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    await Promise.all([
      writeTweets([...fresh, ...currentTweets].sort((a, b) => b.ts - a.ts).slice(0, 1200)),
      writeWatches(watches.map((watch) => ({ ...watch, ...(updates.get(watch.id) ?? {}) }))),
    ]);
    const status = {
      state: "completed" as const,
      startedAt,
      completedAt: Date.now(),
      checked,
      inserted: fresh.length,
      failed,
      message: null,
    };
    await writeIngestStatus(status);
    return { skipped: false, checked, inserted: fresh.length, failed };
  } catch (error) {
    await writeIngestStatus({
      state: "failed",
      startedAt,
      completedAt: Date.now(),
      checked: 0,
      inserted: 0,
      failed: 0,
      message: "קליטת תוצאות GitHub נכשלה",
    });
    throw error;
  } finally {
    await releaseLease();
  }
}
