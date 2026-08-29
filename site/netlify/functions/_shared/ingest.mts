import { randomUUID } from "node:crypto";
import { fetchTweets } from "./source.mts";
import {
  acquireLease,
  readTweets,
  readWatches,
  releaseLease,
  writeTweets,
  writeWatches,
  type StoredTweet,
} from "./storage.mts";

const MAX_WATCHES = 12;
const COOLDOWN = 4_000;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function runIngest(watchId?: string | null) {
  if (!(await acquireLease(14 * 60))) return { skipped: true, checked: 0, inserted: 0, failed: 0 };
  let inserted = 0;
  let checked = 0;
  let failed = 0;
  const updates = new Map<string, { lastCheck: number; lastError: string | null }>();
  const additions: StoredTweet[] = [];
  try {
    const watches = (await readWatches())
      .filter((watch) => watch.active && (!watchId || watch.id === watchId))
      .sort((a, b) => a.lastCheck - b.lastCheck)
      .slice(0, MAX_WATCHES);
    for (let index = 0; index < watches.length; index += 1) {
      const watch = watches[index]!;
      if (index > 0) await wait(COOLDOWN);
      checked += 1;
      try {
        const items = await fetchTweets(watch.type, watch.query);
        const excludes = watch.exclude.map((value) => value.toLowerCase()).filter(Boolean);
        for (const tweet of items.slice(0, 60)) {
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
      } catch (error) {
        failed += 1;
        const detail = error instanceof Error ? error.message : "";
        const transient = /40\d|5\d\d|connect|timeout|abort|לא זמין|לא נמצאו/i.test(detail);
        updates.set(watch.id, {
          lastCheck: Date.now(),
          lastError: transient ? "מקור הנתונים הציבורי לא זמין זמנית; יתבצע ניסיון נוסף בעדכון הבא" : detail || "שאיבה נכשלה",
        });
      }
    }

    const currentTweets = await readTweets();
    const seen = new Set(currentTweets.map((tweet) => `${tweet.w}:${tweet.tweetId}`));
    const fresh = additions.filter((tweet) => {
      const key = `${tweet.w}:${tweet.tweetId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    inserted = fresh.length;
    await writeTweets([...fresh, ...currentTweets].sort((a, b) => b.ts - a.ts).slice(0, 1200));

    const currentWatches = await readWatches();
    await writeWatches(currentWatches.map((watch) => ({ ...watch, ...(updates.get(watch.id) ?? {}) })));
    return { skipped: false, checked, inserted, failed };
  } finally {
    await releaseLease();
  }
}
