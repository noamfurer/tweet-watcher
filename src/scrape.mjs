// tweet-watcher — searches Google News' public X index and notifies Telegram.
// Plaintext watch terms come only from the KEYWORDS secret. State and logs use
// keyed HMAC identifiers, so the public repository does not reveal the watchlist.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const KEYWORDS_PATH = 'keywords.json';
const STATE_PATH = 'state/seen.json';
const MAX_SEEN_PER_KEYWORD = 400;
const MAX_NOTIFY_PER_KEYWORD = 10;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT = process.env.TELEGRAM_CHAT_ID;
const STATE_SALT = process.env.STATE_SALT || '';
const UA = 'tweet-watcher/2.0 (+https://github.com/noamfurer/tweet-watcher)';

function hmac(value) {
  return crypto.createHmac('sha256', STATE_SALT).update(String(value), 'utf8').digest('hex');
}

function keyId(keyword) {
  return 'kw_' + hmac(keyword).slice(0, 16);
}

function tweetKey(id) {
  return hmac(id).slice(0, 20);
}

async function loadJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}

async function saveJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

async function loadKeywords() {
  const raw = process.env.KEYWORDS;
  if (raw?.trim()) return raw.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
  return loadJson(KEYWORDS_PATH, []);
}

function escapeHtml(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

function resultId(link) {
  return crypto.createHash('sha256').update(link, 'utf8').digest('hex');
}

async function scrapeKeyword(keyword) {
  const safeKeywordId = keyId(keyword);
  const url = new URL('https://news.google.com/rss/search');
  url.searchParams.set('q', `${keyword} site:x.com when:1d`);
  url.searchParams.set('hl', 'en-IL');
  url.searchParams.set('gl', 'IL');
  url.searchParams.set('ceid', 'IL:en');
  const response = await fetch(url, { headers: { 'user-agent': UA } });
  if (!response.ok) {
    console.warn(`[${safeKeywordId}] news index returned HTTP ${response.status}`);
    return [];
  }
  const xml = await response.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
  return items.flatMap((item) => {
    const source = field(item, 'source').toLowerCase();
    const link = field(item, 'link');
    const text = field(item, 'title').replace(/\s+-\s+x\.com\s*$/i, '').trim();
    const time = new Date(field(item, 'pubDate'));
    if (source !== 'x.com' || !link || !text || Number.isNaN(time.getTime())) return [];
    return [{ id: resultId(link), handle: 'x.com', url: link, time: time.toISOString(), text }];
  });
}

async function sendTelegram(html, replyMarkup) {
  if (!TOKEN || !CHAT) throw new Error('Telegram credentials are missing');
  const payload = { chat_id: CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: false };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const response = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) console.error('[telegram] send failed', response.status);
}

function formatTweet(keyword, tweet) {
  const when = new Date(tweet.time).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' });
  return `🔔 <b>${escapeHtml(keyword)}</b>\n👤 ${escapeHtml(tweet.handle)} · ${escapeHtml(when)}\n\n${escapeHtml(tweet.text).slice(0, 800)}\n\n${tweet.url}`;
}

function whatsappButton(tweet) {
  const shareText = `${tweet.text.slice(0, 300)}\n\n${tweet.url}`.trim();
  return { inline_keyboard: [[{ text: '📲 שליחה בוואטסאפ', url: `https://wa.me/?text=${encodeURIComponent(shareText)}` }]] };
}

async function main() {
  const keywords = await loadKeywords();
  const state = await loadJson(STATE_PATH, {});
  if (!Array.isArray(keywords) || keywords.length === 0) throw new Error('No keywords configured');
  if (!STATE_SALT) throw new Error('STATE_SALT is not set');

  let totalNew = 0;
  for (const keyword of keywords) {
    const kid = keyId(keyword);
    let tweets;
    try {
      tweets = await scrapeKeyword(keyword);
    } catch {
      console.warn(`[${kid}] news index unavailable`);
      continue;
    }
    console.log(`[${kid}] found ${tweets.length} indexed item(s)`);
    const known = new Set(state[kid] || []);
    const firstRun = state[kid] === undefined;
    const fresh = tweets.filter((tweet) => !known.has(tweetKey(tweet.id))).reverse();
    if (firstRun && tweets.length === 0) {
      console.warn(`[${kid}] first run returned 0 items; leaving state unseeded`);
      continue;
    }
    if (firstRun) {
      console.log(`[${kid}] first run; seeding ${tweets.length} item(s)`);
      await sendTelegram(`✅ <b>הניטור הופעל</b>\nנמצאו ${tweets.length} תוצאות אחרונות. התראות יישלחו על תוצאות חדשות.`);
    } else {
      const toNotify = fresh.slice(0, MAX_NOTIFY_PER_KEYWORD);
      for (const tweet of toNotify) {
        await sendTelegram(formatTweet(keyword, tweet), whatsappButton(tweet));
        totalNew += 1;
      }
      console.log(`[${kid}] notified ${toNotify.length} new item(s)`);
    }
    const merged = [];
    const pushed = new Set();
    for (const key of [...tweets.map((tweet) => tweetKey(tweet.id)), ...(state[kid] || [])]) {
      if (pushed.has(key)) continue;
      pushed.add(key);
      merged.push(key);
      if (merged.length >= MAX_SEEN_PER_KEYWORD) break;
    }
    state[kid] = merged;
  }
  await saveJson(STATE_PATH, state);
  console.log(`Done. Sent ${totalNew} new notification(s).`);
}

main().catch((error) => {
  console.error('Fatal:', error.message);
  process.exit(1);
});
