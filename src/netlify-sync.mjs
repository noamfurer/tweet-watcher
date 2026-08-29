import crypto from 'node:crypto';

const ENDPOINT = 'https://tweetdeckbha.netlify.app/api/github-ingest';
const AUDIENCE = 'urn:tweetdeckbha:github-ingest';
const UA = 'tweet-watcher/2.0 (+https://github.com/noamfurer/tweet-watcher)';

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

function decodeXml(value = '') {
  return value
    .replace(/^<!\[CDATA\[|\]\]>$/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function field(xml, name) {
  return decodeXml(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] || '').trim();
}

function googleResultId(link) {
  const hex = crypto.createHash('sha256').update(link, 'utf8').digest('hex').slice(0, 15);
  return BigInt(`0x${hex}`).toString();
}

async function searchGoogleNews(query) {
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', `${query} site:x.com when:1d`);
  url.searchParams.set('hl', 'en-IL');
  url.searchParams.set('gl', 'IL');
  url.searchParams.set('ceid', 'IL:en');
  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok) throw new Error(`Google News returned ${response.status}`);
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  return items.flatMap((item) => {
    const source = field(item, 'source').toLowerCase();
    const link = field(item, 'link');
    const rawTitle = field(item, 'title');
    const body = rawTitle.replace(/\s+-\s+x\.com\s*$/i, '').trim();
    const postedAt = new Date(field(item, 'pubDate'));
    if (source !== 'x.com' || !link || !body || Number.isNaN(postedAt.getTime())) return [];
    return [{
      tweetId: googleResultId(link),
      authorName: 'X via Google News',
      handle: '@x.com',
      body,
      postedAt: postedAt.toISOString(),
      media: false,
      url: link,
    }];
  });
}

async function fetchUserTimeline(rawHandle) {
  const handle = String(rawHandle).replace(/^@/, '').replace(/^from:/i, '').trim();
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Invalid account watch');
  const response = await fetch(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses?count=100`, {
    headers: { 'user-agent': UA },
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

async function collectWatch(watch, index, total) {
  const isUser = watch.type === 'user';
  const tweets = isUser
    ? await fetchUserTimeline(watch.query)
    : await searchGoogleNews(String(watch.query));
  console.log(`[board ${index + 1}/${total}] collected ${tweets.length} item(s) via ${isUser ? 'account-feed' : 'news-index'}`);
  return { watchId: watch.id, tweets };
}

async function main() {
  // A push run is a one-time deployment verification. Regular scheduled and
  // externally-dispatched runs continue to obey the Israel activity window.
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
  const results = [];
  for (let index = 0; index < watches.length; index += 1) {
    try {
      results.push(await collectWatch(watches[index], index, watches.length));
    } catch (error) {
      console.warn(`[board ${index + 1}/${watches.length}] source unavailable: ${error.message}`);
      results.push({ watchId: watches[index].id, error: 'source-unavailable' });
    }
  }
  const outcome = await callNetlify('POST', { results });
  console.log(`Netlify sync complete: checked=${outcome.checked}, inserted=${outcome.inserted}, failed=${outcome.failed}`);
}

main().catch((error) => {
  console.error('Netlify sync failed:', error.message);
  process.exit(1);
});
