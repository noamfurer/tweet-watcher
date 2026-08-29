import type { WatchType } from "./storage.mts";

export interface RawTweet {
  tweetId: string;
  authorName: string;
  handle: string;
  body: string;
  postedAt: string;
  media: boolean;
  url: string;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36";
const VIEWER_HEADERS = {
  "user-agent": UA,
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,he;q=0.8",
  origin: "https://twitterwebviewer.com",
  referer: "https://twitterwebviewer.com/twitter-search",
};
const RSS_HOSTS = [
  "xcancel.com",
  "nitter.poast.org",
  "nitter.privacyredirect.com",
  "nitter.tiekoetter.com",
  "nuku.trabun.org",
  "nitter.catsarch.com",
  "nitter.kareem.one",
];

function decodeXml(value: string) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function tag(block: string, name: string) {
  return block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
}

function pick(obj: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

function normalizeViewerTweet(raw: unknown): RawTweet | null {
  if (!raw || typeof raw !== "object") return null;
  const tweet = raw as Record<string, unknown>;
  const author = (tweet.author ?? tweet.user ?? {}) as Record<string, unknown>;
  const tweetId = pick(tweet, ["id", "id_str", "tweetId", "rest_id"]);
  if (!tweetId) return null;
  const handleRaw = pick(author, ["username", "screen_name", "handle"]);
  const handle = handleRaw ? `@${handleRaw.replace(/^@/, "")}` : "";
  const createdAt = pick(tweet, ["createdAt", "created_at", "date", "time", "timestamp"]);
  const parsed = createdAt ? new Date(createdAt) : new Date();
  const media = tweet.media;
  const url = pick(tweet, ["url", "permalink", "link", "tweetUrl"])
    || `https://x.com/${handle.replace(/^@/, "")}/status/${tweetId}`;
  return {
    tweetId,
    authorName: pick(author, ["displayName", "name", "fullName"]) || handle || "לא ידוע",
    handle,
    body: pick(tweet, ["text", "content", "full_text", "body"]),
    postedAt: (Number.isNaN(parsed.getTime()) ? new Date() : parsed).toISOString(),
    media: (Array.isArray(media) && media.length > 0) || Boolean(tweet.hasMedia || tweet.video || tweet.photo),
    url: url.startsWith("http") ? url : `https://x.com${url}`,
  };
}

function collectViewerTweets(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  const value = payload as Record<string, unknown>;
  for (const key of ["tweets", "results", "items", "statuses"]) {
    if (Array.isArray(value[key])) return value[key] as unknown[];
  }
  return value.data ? collectViewerTweets(value.data) : [];
}

async function fetchViewer(query: string) {
  const response = await fetch(
    `https://api.twitterwebviewer.com/api/search/tweets?sort=latest&q=${encodeURIComponent(query)}`,
    {
      headers: VIEWER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(12_000),
    },
  );
  const text = await response.text();
  const trimmed = text.trim();
  if (!response.ok || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    throw new Error(`TwitterWebViewer returned ${response.status}`);
  }
  return collectViewerTweets(JSON.parse(trimmed))
    .map(normalizeViewerTweet)
    .filter((item): item is RawTweet => Boolean(item));
}

function parseRss(xml: string): RawTweet[] {
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
  return blocks.flatMap((block) => {
    const guid = decodeXml(tag(block, "guid"));
    const link = decodeXml(tag(block, "link"));
    const id = /^\d+$/.test(guid) ? guid : link.match(/status\/(\d+)/)?.[1] ?? "";
    if (!/^\d+$/.test(id)) return [];
    const creator = decodeXml(tag(block, "dc:creator")) || decodeXml(tag(block, "creator"));
    const linkHandle = link.match(/^https?:\/\/[^/]+\/([^/]+)\/status/)?.[1] ?? "";
    const handle = `@${(creator || linkHandle).replace(/^@/, "")}`;
    const description = tag(block, "description");
    const posted = new Date(decodeXml(tag(block, "pubDate")) || Date.now());
    return [{
      tweetId: id,
      authorName: handle.replace(/^@/, "") || "לא ידוע",
      handle,
      body: decodeXml(description) || decodeXml(tag(block, "title")),
      postedAt: (Number.isNaN(posted.getTime()) ? new Date() : posted).toISOString(),
      media: /<img|<video|pic\.(twitter|x)\.com/i.test(description),
      url: `https://x.com/${handle.replace(/^@/, "")}/status/${id}`,
    }];
  });
}

async function fetchRss(type: WatchType, query: string) {
  const handle = query.replace(/^@/, "").replace(/^from:/i, "");
  const paths = type === "user"
    ? [`/${handle}/rss`, `/search/rss?f=tweets&q=${encodeURIComponent(`from:${handle}`)}`]
    : [`/search/rss?f=tweets&q=${encodeURIComponent(query)}`];
  const attempts = RSS_HOSTS.flatMap((host) => paths.map(async (path) => {
    const response = await fetch(`https://${host}${path}`, {
      headers: {
        accept: "application/rss+xml, application/xml, text/xml",
        "cache-control": "no-cache",
        "user-agent": "FreshRSS/1.24 (Linux; https://freshrss.org)",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(9_000),
    });
    const text = await response.text();
    if (!response.ok || !/<(?:rss|feed)[\s>]/i.test(text)) {
      throw new Error(`${host} returned ${response.status}`);
    }
    return parseRss(text);
  }));
  const results = await Promise.allSettled(attempts);
  const valid = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  const populated = valid.find((items) => items.length > 0);
  if (populated) return populated;
  if (valid.length) return [];
  throw new Error("כל מקורות ה-RSS הציבוריים אינם זמינים כעת");
}

async function fetchSyndication(query: string): Promise<RawTweet[]> {
  const handle = query.replace(/^@/, "").replace(/^from:/i, "");
  const target = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${encodeURIComponent(handle)}`;
  const candidates = [target, `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`];
  let html = "";
  for (const url of candidates) {
    const response = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" }, signal: AbortSignal.timeout(14_000) });
    if (response.ok) {
      html = await response.text();
      if (html.includes("__NEXT_DATA__")) break;
      html = "";
    }
  }
  const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  if (!json) throw new Error("מקור החשבון לא זמין");
  const data = JSON.parse(json) as any;
  const entries = data?.props?.pageProps?.timeline?.entries ?? [];
  return entries.flatMap((entry: any) => {
    const tweet = entry?.content?.tweet;
    if (!tweet?.id_str) return [];
    const user = tweet.user ?? {};
    return [{
      tweetId: String(tweet.id_str),
      authorName: String(user.name || `@${handle}`),
      handle: `@${String(user.screen_name || handle)}`,
      body: String(tweet.full_text || tweet.text || ""),
      postedAt: new Date(tweet.created_at || Date.now()).toISOString(),
      media: Boolean(tweet.entities?.media?.length),
      url: `https://x.com/${handle}/status/${tweet.id_str}`,
    }];
  });
}

export async function fetchTweets(type: WatchType, query: string) {
  const normalizedQuery = type === "user"
    ? `from:${query.replace(/^@/, "").replace(/^from:/i, "")}`
    : query;
  const errors: string[] = [];
  if (type === "user") {
    try {
      const items = await fetchSyndication(query);
      if (items.length) return items;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "Syndication failed");
    }
  }
  try {
    const items = await fetchViewer(normalizedQuery);
    if (items.length) return items;
    errors.push("TwitterWebViewer returned no tweets");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "TwitterWebViewer failed");
  }
  try {
    const items = await fetchRss(type, query);
    if (items.length) return items;
    errors.push("RSS returned no tweets");
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "RSS failed");
  }
  throw new Error(errors.join(" · "));
}
