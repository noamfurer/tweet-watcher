import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://tweetdeckbha.netlify.app/api/github-ingest';
const AUDIENCE = 'urn:tweetdeckbha:github-ingest';
const UA = 'tweet-watcher/3.0 (+https://github.com/noamfurer/tweet-watcher)';
const APIFY_ACTOR = 'xquik~x-tweet-scraper';
const APIFY_STATE_PATH = 'state/netlify-board-sync.json';
const APIFY_MAX_CHARGE_USD = 0.0024;
const APIFY_ITEMS_PER_KEYWORD = 2;
const MIN_APIFY_WINDOW_MS = 12 * 60 * 1000;
const MAX_APIFY_LOOKBACK_MS = 45 * 60 * 1000;
const INITIAL_APIFY_BACKFILL_MS = 24 * 60 * 60 * 1000;
const APIFY_LAG_MS = 60 * 1000;

function isIsraelActivityWindow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Jerusalem',
      weekday: 'short',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now).map((part) => [part.type, part.value]),
  );
  const day = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[parts.weekday] ?? 6;
  const hour = Number(parts.hour) % 24;
  return (day <= 4 && hour >= 7 && hour < 23) || (day >= 5 && hour >= 7 && hour < 16);
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function saveJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function oidcToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) throw new Error('GitHub OIDC is unavailable');
  const url = new URL(requestUrl);
  url.searchParams.set('audience', AUDIENCE);
  const response = await fetch(url, { headers: { authorization: `bearer ${requestToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.value) throw new Error('Could not obtain GitHub OIDC token');
  return payload.value;
}

async function callNetlify(method, body) {
  const response = await fetch(ENDPOINT, {
    method,
    headers: {
      authorization: `Bearer ${await oidcToken()}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Netlify bridge returned ${response.status}`);
  return payload;
}

async function fetchUserTimeline(rawHandle) {
  const handle = String(rawHandle).replace(/^@/, '').replace(/^from:/i, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Invalid account watch');
  const response = await fetch(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses?count=100`, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.code !== 200 || !Array.isArray(payload.results)) {
    throw new Error(`FxTwitter returned ${payload.code || response.status}`);
  }
  return payload.results.flatMap((post) => {
    if (post?.type !== 'status' || !post.id || !post.url || !post.author) return [];
    const screenName = String(post.author.screen_name || handle);
    return [{
      tweetId: String(post.id),
      authorName: String(post.author.name || screenName),
      handle: `@${screenName}`,
      body: String(post.text || ''),
      postedAt: new Date(Number(post.created_timestamp) * 1000).toISOString(),
      media: Boolean(post.media?.all?.length || post.media?.photos?.length || post.media?.videos?.length),
      url: String(post.url),
    }];
  });
}

function apifyTime(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, '_UTC').replace('T', '_');
}

function normalizeApifyTweet(row) {
  if (!row || typeof row !== 'object') return null;
  const tweetId = String(row.id || row.tweetId || row.id_str || '');
  const body = String(row.text || row.fullText || row.full_text || '');
  const author = row.author && typeof row.author === 'object' ? row.author : {};
  const username = String(row.authorUsername || author.username || author.screen_name || '').replace(/^@/, '');
  const posted = new Date(row.createdAt || row.created_at || row.date || '');
  if (!/^\d{8,}$/.test(tweetId) || !body || !username || Number.isNaN(posted.getTime())) return null;
  const rawUrl = String(row.url || row.tweetUrl || row.twitterUrl || '');
  return {
    tweetId,
    authorName: String(author.name || row.authorName || username),
    handle: `@${username}`,
    body,
    postedAt: posted.toISOString(),
    media: Boolean((Array.isArray(row.media) && row.media.length) || (Array.isArray(row.mediaUrls) && row.mediaUrls.length)),
    url: /^https:\/\/(?:x|twitter)\.com\//i.test(rawUrl)
      ? rawUrl
      : `https://x.com/${username}/status/${tweetId}`,
  };
}

async function runApifySearch(query, token) {
  const url = new URL(`https://api.apify.com/v2/acts/${APIFY_ACTOR}/run-sync-get-dataset-items`);
  url.searchParams.set('clean', 'true');
  url.searchParams.set('timeout', '120');
  url.searchParams.set('memory', '256');
  url.searchParams.set('maxTotalChargeUsd', String(APIFY_MAX_CHARGE_USD));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': UA,
    },
    body: JSON.stringify({
      mode: 'search',
      twitterContent: query,
      queryType: 'Latest',
      maxItems: APIFY_ITEMS_PER_KEYWORD,
      outputVariant: 'rich',
      fieldStyle: 'camelCase',
    }),
    signal: AbortSignal.timeout(145_000),
  });
  if (!response.ok) throw new Error(`Apify returned HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Apify returned an invalid response');
  return {
    rowCount: rows.length,
    tweets: rows.map(normalizeApifyTweet).filter(Boolean),
  };
}

async function collectKeywordWatches(watches) {
  if (watches.length === 0) return { results: [], windowEnd: null, skipped: false };
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not configured');

  const state = await loadJson(APIFY_STATE_PATH, {});
  const now = Date.now();
  const untilMs = now - APIFY_LAG_MS;
  const savedEnd = Date.parse(state.apifyWindowEnd || '');
  const forceBackfill = process.env.GITHUB_EVENT_NAME === 'push';
  if (!forceBackfill && Number.isFinite(savedEnd) && untilMs - savedEnd < MIN_APIFY_WINDOW_MS) {
    return { results: [], windowEnd: null, skipped: true };
  }
  const sinceMs = forceBackfill
    ? untilMs - INITIAL_APIFY_BACKFILL_MS
    : Math.max(Number.isFinite(savedEnd) ? savedEnd : 0, untilMs - MAX_APIFY_LOOKBACK_MS);
  const since = apifyTime(new Date(sinceMs));
  const until = apifyTime(new Date(untilMs));
  const results = [];
  let allSucceeded = true;

  for (let offset = 0; offset < watches.length; offset += 3) {
    const batch = watches.slice(offset, offset + 3);
    const settled = await Promise.allSettled(batch.map((watch) =>
      runApifySearch(String(watch.query).trim(), token),
    ));
    settled.forEach((outcome, batchIndex) => {
      const index = offset + batchIndex;
      const watch = batch[batchIndex];
      if (outcome.status === 'fulfilled') {
        console.log(`[keyword ${index + 1}/${watches.length}] received ${outcome.value.rowCount} row(s), normalized ${outcome.value.tweets.length}`);
        results.push({ watchId: watch.id, tweets: outcome.value.tweets });
      } else {
        allSucceeded = false;
        console.warn(`[keyword ${index + 1}/${watches.length}] Apify source unavailable`);
        results.push({ watchId: watch.id, error: 'source-unavailable' });
      }
    });
  }

  const total = results.reduce((sum, result) => sum + (result.tweets?.length || 0), 0);
  console.log(`[apify] collected ${total} item(s) across ${watches.length} isolated keyword search(es)`);
  return {
    results,
    windowEnd: allSucceeded ? new Date(untilMs).toISOString() : null,
    skipped: false,
  };
}

async function main() {
  if (!isIsraelActivityWindow() && process.env.GITHUB_EVENT_NAME !== 'push') {
    console.log('Outside Israel activity window; Netlify sync skipped.');
    return;
  }
  const { watches = [] } = await callNetlify('GET');
  if (!Array.isArray(watches) || watches.length === 0) {
    console.log('No active board watches.');
    return;
  }
  console.log(`Syncing ${watches.length} private board watches.`);

  const keywordWatches = watches.filter((watch) => watch.type !== 'user');
  const userWatches = watches.filter((watch) => watch.type === 'user');
  const results = [];
  let apifyWindowEnd = null;
  try {
    const keywordBatch = await collectKeywordWatches(keywordWatches);
    results.push(...keywordBatch.results);
    apifyWindowEnd = keywordBatch.windowEnd;
    if (keywordBatch.skipped) {
      console.log('[apify] recent window already processed; skipped duplicate run');
    }
  } catch (error) {
    console.warn(`[apify] source unavailable: ${error.message}`);
    results.push(...keywordWatches.map((watch) => ({ watchId: watch.id, error: 'source-unavailable' })));
  }

  for (let index = 0; index < userWatches.length; index += 1) {
    const watch = userWatches[index];
    try {
      const tweets = await fetchUserTimeline(watch.query);
      console.log(`[account ${index + 1}/${userWatches.length}] collected ${tweets.length} item(s)`);
      results.push({ watchId: watch.id, tweets });
    } catch (error) {
      console.warn(`[account ${index + 1}/${userWatches.length}] source unavailable: ${error.message}`);
      results.push({ watchId: watch.id, error: 'source-unavailable' });
    }
  }

  if (results.length === 0) return;
  const outcome = await callNetlify('POST', { results });
  if (apifyWindowEnd) {
    await saveJson(APIFY_STATE_PATH, { version: 1, apifyWindowEnd });
  }
  console.log(`Netlify sync complete: checked=${outcome.checked}, inserted=${outcome.inserted}, failed=${outcome.failed}`);
}

main().catch((error) => {
  console.error('Netlify sync failed:', error.message);
  process.exit(1);
});
