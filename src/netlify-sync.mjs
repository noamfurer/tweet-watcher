import fs from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://tweetdeckbha.netlify.app/api/github-ingest';
const AUDIENCE = 'urn:tweetdeckbha:github-ingest';
const UA = 'tweet-watcher/3.0 (+https://github.com/noamfurer/tweet-watcher)';
const APIFY_ACTOR = 'xquik~x-tweet-scraper';
const APIFY_STATE_PATH = 'state/netlify-board-sync.json';
const APIFY_MAX_CHARGE_USD = 0.0024;
const APIFY_MAX_ITEMS = 120;
const MIN_APIFY_WINDOW_MS = 12 * 60 * 1000;
const MAX_APIFY_LOOKBACK_MS = 45 * 60 * 1000;
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

function rowSearchTerms(row) {
  const value = row?.searchTerms ?? row?.searchTerm;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? [value] : [];
}

async function collectKeywordWatches(watches) {
  if (watches.length === 0) return { results: [], windowEnd: null, skipped: false };
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('APIFY_TOKEN is not configured');

  const state = await loadJson(APIFY_STATE_PATH, {});
  const now = Date.now();
  const untilMs = now - APIFY_LAG_MS;
  const savedEnd = Date.parse(state.apifyWindowEnd || '');
  if (Number.isFinite(savedEnd) && untilMs - savedEnd < MIN_APIFY_WINDOW_MS) {
    return { results: [], windowEnd: null, skipped: true };
  }
  const sinceMs = Math.max(
    Number.isFinite(savedEnd) ? savedEnd : 0,
    untilMs - MAX_APIFY_LOOKBACK_MS,
  );
  const since = apifyTime(new Date(sinceMs));
  const until = apifyTime(new Date(untilMs));
  const watchByTerm = new Map();
  const searchTerms = watches.map((watch) => {
    const term = `${String(watch.query).trim()} since:${since} until:${until}`;
    watchByTerm.set(term, watch);
    return term;
  });

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
      searchTerms,
      queryType: 'Latest',
      includeSearchTerms: true,
      maxItems: APIFY_MAX_ITEMS,
      outputVariant: 'rich',
      fieldStyle: 'camelCase',
    }),
    signal: AbortSignal.timeout(145_000),
  });
  if (!response.ok) throw new Error(`Apify returned HTTP ${response.status}`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('Apify returned an invalid response');

  const grouped = new Map(watches.map((watch) => [watch.id, []]));
  for (const row of rows) {
    const tweet = normalizeApifyTweet(row);
    if (!tweet) continue;
    const matched = new Set(
      rowSearchTerms(row)
        .map((term) => watchByTerm.get(term))
        .filter(Boolean),
    );
    if (matched.size === 0 && watches.length === 1) matched.add(watches[0]);
    for (const watch of matched) grouped.get(watch.id).push(tweet);
  }

  const total = [...grouped.values()].reduce((sum, items) => sum + items.length, 0);
  console.log(`[apify] collected ${total} item(s) for ${watches.length} keyword watch(es)`);
  return {
    results: watches.map((watch) => ({ watchId: watch.id, tweets: grouped.get(watch.id) })),
    windowEnd: new Date(untilMs).toISOString(),
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
