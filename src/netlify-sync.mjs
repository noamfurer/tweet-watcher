import { chromium } from 'playwright';

const ENDPOINT = 'https://tweetdeckbha.netlify.app/api/github-ingest';
const AUDIENCE = 'urn:tweetdeckbha:github-ingest';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  return (day <= 4 && hour >= 7 && hour < 23) || (day === 5 && hour >= 7 && hour < 16);
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

async function scrapeWatch(browser, watch, index, total) {
  const query = watch.type === 'user'
    ? `from:${String(watch.query).replace(/^@/, '').replace(/^from:/i, '')}`
    : String(watch.query);
  const url =
    'https://twitterwebviewer.com/twitter-search?q=' +
    encodeURIComponent(query) +
    '&type=tweets&sort=latest';
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'he-IL',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    let loaded = false;
    for (let attempt = 1; attempt <= 2 && !loaded; attempt += 1) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('a[href*="/status/"]', { timeout: 30000 });
        loaded = true;
      } catch {
        console.warn(`[board ${index + 1}/${total}] attempt ${attempt}/2 did not return tweets`);
        if (attempt < 2) await page.waitForTimeout(4000);
      }
    }
    if (!loaded) return { watchId: watch.id, error: 'source-unavailable' };
    await page.waitForTimeout(1500);
    const tweets = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      for (const link of document.querySelectorAll('a[href*="/status/"]')) {
        const match = link.href.match(/(?:x|twitter)\.com\/([^\/?#]+)\/status\/(\d+)/);
        if (!match || seen.has(match[2])) continue;
        seen.add(match[2]);
        let element = link.parentElement;
        let card = null;
        for (let depth = 0; depth < 10 && element; depth += 1) {
          if (element.querySelector('time')) { card = element; break; }
          element = element.parentElement;
        }
        const time = card?.querySelector('time');
        const body = card?.querySelector('p.whitespace-pre-wrap, p[class*="whitespace-pre-wrap"]');
        out.push({
          tweetId: match[2],
          authorName: match[1],
          handle: `@${match[1]}`,
          body: body?.innerText.trim() || card?.innerText.replace(/\s+/g, ' ').trim().slice(0, 5000) || '',
          postedAt: time?.getAttribute('datetime') || new Date().toISOString(),
          media: Boolean(card?.querySelector('img, video')),
          url: `https://x.com/${match[1]}/status/${match[2]}`,
        });
      }
      return out;
    });
    console.log(`[board ${index + 1}/${total}] collected ${tweets.length} tweets`);
    return { watchId: watch.id, tweets };
  } finally {
    await context.close();
  }
}

async function main() {
  if (!isIsraelActivityWindow()) {
    console.log('Outside Israel activity window; Netlify sync skipped.');
    return;
  }
  const { watches = [] } = await callNetlify('GET');
  if (!Array.isArray(watches) || watches.length === 0) {
    console.log('No active board watches.');
    return;
  }
  console.log(`Syncing ${watches.length} private board watches.`);
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const results = [];
  try {
    for (let index = 0; index < watches.length; index += 1) {
      results.push(await scrapeWatch(browser, watches[index], index, watches.length));
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  } finally {
    await browser.close();
  }
  const outcome = await callNetlify('POST', { results });
  console.log(`Netlify sync complete: checked=${outcome.checked}, inserted=${outcome.inserted}, failed=${outcome.failed}`);
}

main().catch((error) => {
  console.error('Netlify sync failed:', error.message);
  process.exit(1);
});
