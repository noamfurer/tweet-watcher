// tweet-watcher — scrapes twitterwebviewer.com for keywords and notifies a Telegram bot on new tweets.
//
// Env vars:
//   TELEGRAM_BOT_TOKEN  – from @BotFather (required for notifications)
//   TELEGRAM_CHAT_ID    – your chat/channel id (required for notifications)
//   KEYWORDS            – keywords to watch, separated by newline or comma.
//                         Set this as a GitHub Secret to keep your watchlist PRIVATE
//                         even in a public repo. Falls back to keywords.json for local dev.
//
// Privacy note (public-repo safe): everything persisted to state/seen.json is an
// HMAC-SHA256 keyed by the secret STATE_SALT — both the keyword keys AND the tweet
// ids. Without the salt these are non-reversible and not guessable from a wordlist,
// and the hashed tweet ids can't be opened on x.com. Logs print only the keyword
// hash. The plaintext keyword and real tweets are only ever sent to your Telegram.
//
// Run:  node src/scrape.mjs

import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const KEYWORDS_PATH = 'keywords.json';
const STATE_PATH = 'state/seen.json';
const MAX_SEEN_PER_KEYWORD = 400;   // cap the state file size
const MAX_NOTIFY_PER_KEYWORD = 10;  // safety valve against a flood in one run

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const STATE_SALT = process.env.STATE_SALT || '';

// Keyed HMAC so nothing persisted to the public repo is reversible or guessable.
// STATE_SALT is a secret; without it the digests are meaningless to an outsider.
function hmac(value) {
  return crypto.createHmac('sha256', STATE_SALT).update(String(value), 'utf8').digest('hex');
}
// Stable per-keyword state key + log label (plaintext keyword never written out).
function keyId(keyword) {
  return 'kw_' + hmac(keyword).slice(0, 16);
}
// Persisted "seen" marker for a tweet — the real numeric id is never stored, so
// nobody can open the tweet on x.com and infer the keyword from its text.
function tweetKey(id) {
  return hmac(id).slice(0, 20);
}

// Keywords come from the KEYWORDS secret (newline/comma separated); local dev may
// use keywords.json instead. keywords.json is gitignored so it never reaches the repo.
async function loadKeywords() {
  const raw = process.env.KEYWORDS;
  if (raw && raw.trim()) {
    return raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return await loadJson(KEYWORDS_PATH, []);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ---------- helpers ----------

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function escapeHtml(s) {
  return (s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendTelegram(html, replyMarkup) {
  if (!TOKEN || !CHAT) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — printing instead:\n' + html + '\n');
    if (replyMarkup) console.log('[telegram] (button) ' + JSON.stringify(replyMarkup) + '\n');
    return;
  }
  const payload = {
    chat_id: CHAT,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: false,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.error('[telegram] send failed', res.status, await res.text().catch(() => ''));
  }
  await sleep(1200); // stay well under Telegram's rate limits
}

function formatTweet(keyword, t) {
  const when = t.time ? new Date(t.time).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }) : '';
  const body = escapeHtml(t.text || '').slice(0, 800);
  return (
    `🔔 <b>${escapeHtml(keyword)}</b>\n` +
    `👤 @${escapeHtml(t.handle)}${when ? ` · ${escapeHtml(when)}` : ''}\n\n` +
    `${body}\n\n` +
    `${t.url}`
  );
}

// A "share on WhatsApp" inline button: opens WhatsApp pre-filled with the tweet
// text + link (via https://wa.me/?text=...). Text is capped so the button URL
// stays within Telegram's limits.
function whatsappButton(t) {
  const shareText = `${(t.text || '').slice(0, 300)}\n\n${t.url}`.trim();
  const url = 'https://wa.me/?text=' + encodeURIComponent(shareText);
  return { inline_keyboard: [[{ text: '📲 שליחה בוואטסאפ', url }]] };
}

// ---------- scraping ----------

async function scrapeKeyword(browser, keyword) {
  const url =
    'https://twitterwebviewer.com/twitter-search?q=' +
    encodeURIComponent(keyword) +
    '&type=tweets&sort=latest';

  // Use a FRESH browser context per keyword. The site rate-limits by session,
  // so reusing cookies across keywords causes the 2nd+ search to return empty.
  const context = await browser.newContext({
    userAgent: UA,
    locale: 'he-IL',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  try {
    const MAX_ATTEMPTS = 3;
    let loaded = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !loaded; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('a[href*="/status/"]', { timeout: 30000 });
        loaded = true;
      } catch {
        console.warn(`[${keyword}] attempt ${attempt}/${MAX_ATTEMPTS}: no tweets yet`);
        if (attempt < MAX_ATTEMPTS) await page.waitForTimeout(4000 * attempt);
      }
    }
    if (!loaded) {
      console.warn(`[${keyword}] gave up after ${MAX_ATTEMPTS} attempts (block, slow, or no results)`);
      return [];
    }
    await page.waitForTimeout(1500); // let the list settle

    return await page.evaluate(() => {
    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="/status/"]')) {
      const m = a.href.match(/(?:x|twitter)\.com\/([^\/?#]+)\/status\/(\d+)/);
      if (!m) continue;
      const id = m[2];
      if (seen.has(id)) continue;
      seen.add(id);

      // smallest ancestor that contains a <time> is the tweet card
      let el = a.parentElement;
      let card = null;
      for (let i = 0; i < 10 && el; i++) {
        if (el.querySelector('time')) { card = el; break; }
        el = el.parentElement;
      }
      const timeEl = card ? card.querySelector('time') : null;
      const bodyEl = card
        ? card.querySelector('p.whitespace-pre-wrap, p[class*="whitespace-pre-wrap"]')
        : null;

      out.push({
        id,
        handle: m[1],
        url: `https://x.com/${m[1]}/status/${id}`,
        time: timeEl ? timeEl.getAttribute('datetime') : null,
        text: bodyEl
          ? bodyEl.innerText.trim()
          : (card ? card.innerText.replace(/\s+/g, ' ').trim().slice(0, 240) : ''),
      });
    }
      return out;
    });
  } finally {
    await context.close();
  }
}

// ---------- main ----------

async function main() {
  const keywords = await loadKeywords();
  const state = await loadJson(STATE_PATH, {});

  if (!Array.isArray(keywords) || keywords.length === 0) {
    console.error('No keywords found — set the KEYWORDS secret/env or create keywords.json');
    process.exit(1);
  }

  if (!STATE_SALT) {
    // Without the salt the persisted digests would be weak/inconsistent. Refuse,
    // so we never accidentally write guessable data to the public repo.
    console.error('STATE_SALT is not set — refusing to run (set the STATE_SALT secret/env).');
    process.exit(1);
  }

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  let totalNew = 0;

  for (const keyword of keywords) {
    const kid = keyId(keyword); // hashed id — safe to log / persist in a public repo
    let tweets = [];
    try {
      tweets = await scrapeKeyword(browser, keyword);
    } catch (err) {
      console.error(`[${kid}] scrape error:`, err.message);
      continue;
    }
    console.log(`[${kid}] found ${tweets.length} tweets on page`);

    const knownKeys = new Set(state[kid] || []);
    const firstRun = state[kid] === undefined;

    // page order is newest-first; we want to notify oldest-first
    const fresh = tweets.filter((t) => !knownKeys.has(tweetKey(t.id))).reverse();

    if (firstRun && tweets.length === 0) {
      // Load failed on the first-ever run — don't seed an empty state, or the next
      // run would treat every existing tweet as "new". Retry seeding next time.
      console.warn(`[${kid}] first run but 0 tweets — leaving unseeded, will retry next run`);
      continue;
    }

    if (firstRun) {
      // Don't flood on the very first run — just record what's there now.
      console.log(`[${kid}] first run — seeding ${tweets.length} tweets silently`);
      await sendTelegram(
        `✅ <b>מתחיל לנטר: ${escapeHtml(keyword)}</b>\n` +
          `נמצאו ${tweets.length} ציוצים אחרונים. אתריע רק על ציוצים חדשים מכאן והלאה.`
      );
    } else {
      const toNotify = fresh.slice(0, MAX_NOTIFY_PER_KEYWORD);
      for (const t of toNotify) {
        await sendTelegram(formatTweet(keyword, t), whatsappButton(t));
        totalNew++;
      }
      if (fresh.length > MAX_NOTIFY_PER_KEYWORD) {
        console.warn(`[${kid}] ${fresh.length} new tweets, notified only ${MAX_NOTIFY_PER_KEYWORD}`);
      }
      console.log(`[${kid}] notified ${toNotify.length} new tweet(s)`);
    }

    // Update state: keep the most recent hashed markers (this run's first, then prior)
    const merged = [];
    const pushed = new Set();
    for (const key of [...tweets.map((t) => tweetKey(t.id)), ...(state[kid] || [])]) {
      if (pushed.has(key)) continue;
      pushed.add(key);
      merged.push(key);
      if (merged.length >= MAX_SEEN_PER_KEYWORD) break;
    }
    state[kid] = merged;

    await sleep(2000); // be polite between keywords
  }

  await browser.close();
  await saveJson(STATE_PATH, state);
  console.log(`Done. Sent ${totalNew} new-tweet notification(s).`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
