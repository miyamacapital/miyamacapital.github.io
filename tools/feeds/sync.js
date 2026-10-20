#!/usr/bin/env node
'use strict';

/**
 * tools/feeds/sync.js — keep data/articles.json (the research catalog behind the
 * archive pages and the homepage "latest research" cards) in step with the three
 * publishing platforms. Node 20+, standard library only.
 *
 * Sources
 *   vocus    zh-TW  https://api.vocus.cc/api/contents?salonId=…&num=…&page=…
 *                   (the salon has no RSS feed; this is the paginated content list the
 *                   salon page itself loads, newest first, `count` = total)
 *   substack en     https://memos.miyamacap.com/feed              (RSS, newest 20 posts)
 *   note     ja     https://note.com/miyamacapitaljp/rss          (RSS, newest 25 posts)
 *
 * Usage
 *   node tools/feeds/sync.js             append new posts to data/articles.json
 *   node tools/feeds/sync.js --check     dry run: print what would be added, write nothing
 *
 * Options
 *   --no-verify           skip the GET check that every new url answers 2xx
 *   --source a,b          only these sources (vocus, substack, note)
 *   --since YYYY-MM-DD    ignore posts published (local date) before this day
 *   --file <path>         catalog path (default: data/articles.json next to this repo)
 *   --report <path>       also write a Markdown report (used as the PR body)
 *
 * Rules
 *   - A post is new when its canonical url (https, no query/hash, no trailing slash) is not
 *     in the catalog. Existing entries are never modified; new ones are appended textually,
 *     so the diff is additions only. Running twice in a row is a no-op the second time.
 *   - id continues the per-language sequence: art-NNN (zh-TW), art-en-NNN (en), art-ja-NNN (ja).
 *     New posts of one language are numbered oldest first, so newer posts get higher ids.
 *   - date is the publisher's local calendar day: Asia/Taipei, America/Los_Angeles, Asia/Tokyo.
 *   - summary is the platform's own text (vocus abstract, Substack subtitle, note feed excerpt or,
 *     when that is empty, the opening paragraphs of the note post) trimmed to one or two sentences.
 *     Nothing is invented; if no usable text exists the summary is left empty and reported.
 *   - category is guessed from the title with CATEGORY_KEYWORDS below, default "macro".
 *   - tags is [] and featured is false; curate by hand in the PR if wanted.
 *
 * Exit codes: 0 ok (also when nothing is new), 1 when the catalog is invalid, the result fails
 * validation, or every requested source failed. A single failed source is reported (and
 * written to $GITHUB_OUTPUT as sources_failed) but does not stop the others.
 */

const fs = require('fs');
const path = require('path');

const USER_AGENT = 'Mozilla/5.0 (compatible; miyama-research-sync/1.0; +https://www.miyamacap.com)';
const VOCUS_SALON_ID = '6931e3fdfd89780001e176a6'; // https://vocus.cc/salon/miyama-capital
const VOCUS_PAGE_SIZE = 50;
const NOTE_CREATOR = 'miyamacapitaljp';
const SUMMARY_SOFT_MAX = 200; // add the 2nd sentence only while the summary stays under this
const SUMMARY_HARD_MAX = 240; // a single sentence longer than this is cut at a word boundary + "…"
const FETCH_TIMEOUT_MS = 30000;

const SOURCES = [
  { key: 'vocus', lang: 'zh-TW', platform: 'vocus', timeZone: 'Asia/Taipei', idPrefix: 'art-', fetchPosts: fetchVocus },
  { key: 'substack', lang: 'en', platform: 'substack', timeZone: 'America/Los_Angeles', idPrefix: 'art-en-', fetchPosts: fetchSubstack },
  { key: 'note', lang: 'ja', platform: 'note', timeZone: 'Asia/Tokyo', idPrefix: 'art-ja-', fetchPosts: fetchNote },
];

// Category guess: the first row with a keyword found in the title wins (case-insensitive).
// Titles that match nothing are "macro", the catalog's default. Keywords come from the
// titles that were categorised by hand in data/articles.json; extend the lists as needed.
const CATEGORY_KEYWORDS = [
  ['framework', ['槓鈴', 'バーベル', 'barbell']], // before "philosophy": these titles also mention 人生
  ['realestate', [
    '都更', '房價', '房市', '房產', '房地產', '不動產', '建商', '房貸', '租金', '蓋房子',
    '不動産', '住宅', '都市再開発', '地価', 'マンション',
    'real estate', 'housing', 'property market', 'mortgage', 'rents',
  ]],
  ['philosophy', [
    '投資哲學', '哲學', '心法', '認識自己', '人生', '好運', '運氣', '散戶', '聖杯', '護城河',
    '痛苦守恆', '讀後', '十五年', '選股', '財富', '囚徒困境：探討', '實戰智慧', '左側交易', '右側交易',
    '從頭來過', 'Proxy', 'Anti-Fragile', 'Buy, Borrow, Die', '主動投資',
    '投資哲学', "Founder's Note", '個人投資家', '相場師', '自己認識', '哲学', '15年', '株選び', '水位管理', '運」', '最初の一株',
    'philosophy', 'mindset', 'discipline', 'luck', 'the thing itself',
  ]],
  ['framework', [
    '框架', '法則', '方法論', '容錯', '風控', '系統思維', '系統設計', '多agent', 'multi-agent', '正確用法',
    '判讀', '人力重新定價', '詐騙', 'longshot', '錯的時鐘', '賣方報告', '訊號品質',
    'フレームワーク', 'システム思考', '法則',
    'framework', 'playbook', 'checklist', 'mental model', 'how to read',
  ]],
  ['commentary', [
    '評論', '快評', '觀察', '地形', '隨筆', '雜談', '財報裡', 'KOL', '人才', '軟體公司', '說故事',
    '未實現利得稅', '恐慌',
    'コラム', '雑感', '未実現利益',
    'commentary', 'narrative', 'panic', 'the map',
  ]],
];

// note body previews start with a disclaimer line and end with a "read more" link that are not
// part of the summary. Short lines without sentence punctuation are headings or bylines.
const BOILERPLATE_PARAGRAPHS = [
  /^本稿は.{0,40}向けの.{0,30}(である|です)。?$/, // 本稿は機関投資家・Family Office 向けの専門的分析である。
  /^(続きをみる|もっと見る|続きを読む|read more|continue reading)/i,
  /^(本文|目次)\s*[:：]?$/,
];
// Plain-text previews glue a section heading onto the first sentence ("エグゼクティブ・サマリー2026年…").
const GLUED_HEADING = /^(?:\d+[.．、]\s*)?(?:エグゼクティブ・?サマリー|要旨|要約|概要|序論|序文|はじめに|結論|まとめ|摘要|前言|導言|結語|executive summary|summary|introduction|tl;dr)(?:\s*[:：—–-]+\s*|\s+|(?=[0-9０-９「『（(〔]))/i;
// Editorial marks and source citations that the hand-written summaries leave out.
const SUMMARY_NOISE = [
  /^〔[^〕]{0,40}〕\s*/, // 〔2026-03-24 追記〕
  /^\d+[.．]\s+(?=\S)/, // "1. " list marker
  /[（(]\s*(?:出所|出典|資料|source|sources|via)\s*[:：][^（）()]*[）)]/gi, // （出所：Bloomberg、…）
  /[（(][^（）()]{0,80}(?:最終)?確認[）)]/g, // （資源エネルギー庁「…」、2026年3月確認）
];

// ---------------------------------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const opts = {
    check: false,
    verify: true,
    sources: SOURCES.map((s) => s.key),
    since: null,
    file: path.join(__dirname, '..', '..', 'data', 'articles.json'),
    report: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '--check' || arg === '--dry-run') opts.check = true;
    else if (arg === '--no-verify') opts.verify = false;
    else if (arg === '--source' || arg === '--sources') {
      opts.sources = next().split(',').map((s) => s.trim()).filter(Boolean);
      const unknown = opts.sources.filter((s) => !SOURCES.some((x) => x.key === s));
      if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(', ')}`);
    } else if (arg === '--since') {
      opts.since = next();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(opts.since)) throw new Error('--since expects YYYY-MM-DD');
    } else if (arg === '--file') opts.file = path.resolve(next());
    else if (arg === '--report') opts.report = path.resolve(next());
    else if (arg === '--help' || arg === '-h') {
      const banner = /\/\*\*([\s\S]*?)\*\//.exec(fs.readFileSync(__filename, 'utf8'));
      process.stdout.write((banner ? banner[1] : '').replace(/^ \* ?/gm, '').trim() + '\n');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

// ---------------------------------------------------------------------------------------------
// HTTP

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, accept = '*/*') {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status} for ${url}`);
        error.permanent = true;
        throw error;
      }
      return await res.text();
    } catch (error) {
      lastError = error;
      if (error.permanent) break;
      await sleep(1500 * attempt);
    }
  }
  throw new Error(`fetch failed: ${url}: ${lastError && lastError.message}`);
}

async function fetchJson(url) {
  const text = await fetchText(url, 'application/json');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON from ${url}: ${error.message}`);
  }
}

// GET (not HEAD: the platforms do not all answer HEAD) and drop the body.
async function verifyUrl(url) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.body) await res.body.cancel().catch(() => {});
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return { ok: res.ok, status: res.status };
    } catch (error) {
      if (attempt === 2) return { ok: false, status: 0, error: error.message };
      await sleep(2000);
    }
  }
  return { ok: false, status: 0 };
}

// ---------------------------------------------------------------------------------------------
// Text helpers

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', middot: '·', times: '×',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code) => {
    if (code[0] === '#') {
      const n = /^#x/i.test(code) ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
    }
    const key = code.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : all;
  });
}

function normalizeSpace(text) {
  return text.replace(/\u00a0/g, ' ').replace(/[ \t\r\f\v]+/g, ' ').trim();
}

// HTML or plain text -> array of trimmed paragraphs.
function toParagraphs(text) {
  const stripped = String(text || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article|figure|figcaption|pre|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(stripped)
    .split(/\n+/)
    .map(normalizeSpace)
    .filter(Boolean);
}

// Sentence terminators: CJK 。！？ end a sentence anywhere; . ! ? only before whitespace or the end,
// and a period does not count after common abbreviations or a single capital (J. Powell).
const ABBREVIATION = /(?:^|[\s(])(?:[A-Z]|U\.S|U\.K|E\.U|e\.g|i\.e|vs|Mr|Mrs|Ms|Dr|Prof|No|St|Inc|Ltd|Co|Jr|Sr|Fig|approx|etc|al)\.$|^\d+\.$/;
const CLOSERS = /["”’」』）)\]]/;

function splitSentences(text) {
  const sentences = [];
  let buffer = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    buffer += ch;
    let ends = false;
    if (ch === '。' || ch === '！' || ch === '？') ends = true;
    else if (ch === '!' || ch === '?') ends = i + 1 >= text.length || /\s/.test(text[i + 1]);
    else if (ch === '.') ends = (i + 1 >= text.length || /\s/.test(text[i + 1])) && !ABBREVIATION.test(buffer.trimEnd());
    if (!ends) continue;
    while (i + 1 < text.length && (/[。！？!?]/.test(text[i + 1]) || CLOSERS.test(text[i + 1]))) buffer += text[++i];
    sentences.push(buffer.trim());
    buffer = '';
  }
  if (buffer.trim()) sentences.push(buffer.trim());
  return sentences.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

function isHeadingLike(paragraph) {
  return paragraph.length < 40 && !/[。．！？!?.…][\s"”’」』）)\]]*$/.test(paragraph);
}

function endsWithCjk(text) {
  return /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef][\s"\u201d\u2019」』）)\]]*$/.test(text);
}

function hardTrim(text) {
  if (text.length <= SUMMARY_HARD_MAX) return text;
  const head = text.slice(0, SUMMARY_HARD_MAX);
  let cut = Math.max(head.lastIndexOf(' '), head.search(/[，、；：,;:](?!.*[，、；：,;:])/));
  if (cut < SUMMARY_HARD_MAX * 0.6) cut = SUMMARY_HARD_MAX;
  return head.slice(0, cut).replace(/[\s，、；：,;:.]+$/, '') + '…';
}

// One or two sentences of the platform's own text. mode "subtitle": the text is already a
// short standfirst (Substack); mode "body": a body preview whose disclaimer lines, headings
// and bylines must be dropped first (vocus abstract, note preview).
function summarize(text, mode) {
  let paragraphs = toParagraphs(text).filter((p) => !BOILERPLATE_PARAGRAPHS.some((re) => re.test(p)));
  if (mode === 'body') {
    paragraphs = paragraphs
      .map((p) => p.replace(GLUED_HEADING, ''))
      .map((p) => SUMMARY_NOISE.reduce((acc, re) => acc.replace(re, ''), p))
      .map(normalizeSpace)
      .filter((p) => p && !isHeadingLike(p));
  }
  if (!paragraphs.length) return '';
  const sentences = splitSentences(paragraphs.join(' '));
  if (!sentences.length) return '';
  let summary = sentences[0];
  if (sentences[1]) {
    const joined = endsWithCjk(summary) ? summary + sentences[1] : `${summary} ${sentences[1]}`;
    if (joined.length <= SUMMARY_SOFT_MAX) summary = joined;
  }
  return hardTrim(stripUnbalancedQuote(summary));
}

// A subtitle that ends with a quote mark nothing opened keeps the mark out of the card.
function stripUnbalancedQuote(text) {
  const count = (str, ch) => str.split(ch).length - 1;
  const last = text.slice(-1);
  if (last === '"' && count(text, '"') % 2 === 1) return text.slice(0, -1).trimEnd();
  for (const [open, close] of [['\u201c', '\u201d'], ['「', '」'], ['『', '』']]) {
    if (last === close && count(text, close) > count(text, open)) return text.slice(0, -1).trimEnd();
  }
  return text;
}

function guessCategory(title) {
  const haystack = String(title || '').toLowerCase();
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((keyword) => haystack.includes(keyword.toLowerCase()))) return category;
  }
  return 'macro';
}

function localDate(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type) => parts.find((p) => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function parseDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`unparseable date: ${value}`);
  return date;
}

function cleanUrl(value) {
  const url = new URL(String(value).trim());
  url.protocol = 'https:';
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function canonicalKey(value) {
  try {
    const url = new URL(cleanUrl(value));
    return url.hostname.toLowerCase().replace(/^www\./, '') + url.pathname;
  } catch (error) {
    return String(value).trim();
  }
}

// ---------------------------------------------------------------------------------------------
// RSS (regex based; the feeds are RSS 2.0 with CDATA or entity-escaped text)

function tagText(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i').exec(block);
  if (!match) return '';
  const value = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value);
  return (cdata ? cdata[1] : decodeEntities(value)).trim();
}

function parseRssItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml))) {
    const block = match[1];
    items.push({
      title: normalizeSpace(tagText(block, 'title')),
      link: tagText(block, 'link') || tagText(block, 'guid'),
      description: tagText(block, 'description'),
      pubDate: tagText(block, 'pubDate') || tagText(block, 'dc:date'),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// Sources. Each returns [{ title, url, publishedAt: Date, summary }].

async function fetchVocus() {
  const posts = [];
  const seen = new Set();
  for (let page = 1; page <= 100; page++) {
    const data = await fetchJson(`https://api.vocus.cc/api/contents?salonId=${VOCUS_SALON_ID}&num=${VOCUS_PAGE_SIZE}&page=${page}`);
    const items = Array.isArray(data.contents) ? data.contents : [];
    for (const item of items) {
      if (item.type && item.type !== 'article') continue;
      const article = item.article && typeof item.article === 'object' ? item.article : {};
      const id = article._id || item.contentId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (article.isSchedule === true) continue;
      const published = article.lastPublishAt || item.publishAt || article.createdAt;
      if (!published) continue;
      posts.push({
        title: normalizeSpace(article.title || item.title || ''),
        url: `https://vocus.cc/article/${id}`,
        publishedAt: parseDate(published),
        summary: summarize(article.abstract || '', 'body'),
      });
    }
    if (items.length < VOCUS_PAGE_SIZE) break;
    if (typeof data.count === 'number' && seen.size >= data.count) break;
  }
  if (!posts.length) throw new Error('vocus content list came back empty');
  return posts;
}

async function fetchSubstack() {
  const items = parseRssItems(await fetchText('https://memos.miyamacap.com/feed', 'application/rss+xml, application/xml'));
  if (!items.length) throw new Error('Substack feed has no items');
  return items.filter((item) => item.link && item.pubDate).map((item) => ({
    title: item.title,
    url: cleanUrl(item.link),
    publishedAt: parseDate(item.pubDate),
    summary: summarize(item.description, 'subtitle'),
  }));
}

// note's RSS description is often empty or only the disclaimer line. The public endpoint of the
// post itself carries the full HTML body; its opening paragraphs are used only when the feed text
// gave nothing, and only for posts that are actually new (see resolveSummary).
async function fetchNoteBody(key) {
  const data = await fetchJson(`https://note.com/api/v3/notes/${key}`);
  const note = data && data.data ? data.data : {};
  return typeof note.body === 'string' ? note.body : '';
}

async function fetchNote() {
  const items = parseRssItems(await fetchText(`https://note.com/${NOTE_CREATOR}/rss`, 'application/rss+xml, application/xml'));
  if (!items.length) throw new Error('note feed has no items');
  return items.filter((item) => item.link && item.pubDate).map((item) => {
    const url = cleanUrl(item.link);
    return {
      title: item.title,
      url,
      publishedAt: parseDate(item.pubDate),
      summary: summarize(item.description, 'body'),
      fetchSummary: async () => summarize(await fetchNoteBody(url.split('/').pop()), 'body'),
    };
  });
}

async function resolveSummary(post) {
  if (post.summary || typeof post.fetchSummary !== 'function') return post.summary || '';
  try {
    return await post.fetchSummary();
  } catch (error) {
    process.stderr.write(`warning: summary lookup failed for ${post.url}: ${error.message}\n`);
    return '';
  }
}

// ---------------------------------------------------------------------------------------------
// Catalog

function validateCatalog(entries, label) {
  if (!Array.isArray(entries)) throw new Error(`${label}: catalog must be a JSON array`);
  const ids = new Set();
  const urls = new Set();
  entries.forEach((entry, index) => {
    const where = `${label}: entry ${index} (${entry && entry.id})`;
    if (!entry || typeof entry !== 'object') throw new Error(`${where} is not an object`);
    for (const key of ['id', 'title', 'date', 'lang', 'category', 'summary', 'url', 'platform']) {
      if (typeof entry[key] !== 'string') throw new Error(`${where}: "${key}" must be a string`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) throw new Error(`${where}: date must be YYYY-MM-DD`);
    if (!Array.isArray(entry.tags)) throw new Error(`${where}: tags must be an array`);
    if (typeof entry.featured !== 'boolean') throw new Error(`${where}: featured must be a boolean`);
    if (ids.has(entry.id)) throw new Error(`${where}: duplicate id`);
    ids.add(entry.id);
    const key = canonicalKey(entry.url);
    if (urls.has(key)) throw new Error(`${where}: duplicate url ${entry.url}`);
    urls.add(key);
  });
}

function idAllocator(entries, prefix) {
  const taken = new Set(entries.map((entry) => entry.id));
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  let max = 0;
  let width = 3;
  for (const entry of entries) {
    const match = pattern.exec(entry.id);
    if (!match) continue;
    max = Math.max(max, parseInt(match[1], 10));
    width = Math.max(width, match[1].length);
  }
  let next = max + 1;
  return function allocate() {
    let id;
    do {
      id = prefix + String(next++).padStart(width, '0');
    } while (taken.has(id));
    taken.add(id);
    return id;
  };
}

function buildEntry(source, post, id) {
  return {
    id,
    title: post.title,
    date: localDate(post.publishedAt, source.timeZone),
    lang: source.lang,
    category: guessCategory(post.title),
    summary: post.summary || '',
    url: post.url,
    platform: source.platform,
    tags: [],
    featured: false,
  };
}

// Append entries to the raw file text so that existing entries keep their exact bytes.
function appendToCatalogText(raw, newEntries) {
  const close = raw.lastIndexOf(']');
  if (close < 0) throw new Error('catalog text has no closing bracket');
  const head = raw.slice(0, close).replace(/\s+$/, '');
  const empty = head.endsWith('[');
  const rendered = newEntries
    .map((entry) => JSON.stringify(entry, null, 2).split('\n').map((line) => '  ' + line).join('\n'))
    .join(',\n');
  return `${head}${empty ? '\n' : ',\n'}${rendered}\n]\n`;
}

// ---------------------------------------------------------------------------------------------
// Reporting

function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\s+/g, ' ');
}

function renderReport(result, opts) {
  const lines = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`Automated sync of \`data/articles.json\` from vocus, Substack and note (${today}).`, '');
  if (result.added.length) {
    lines.push(`### Added ${result.added.length} ${result.added.length === 1 ? 'entry' : 'entries'}`, '');
    lines.push('| id | date | lang | category | title |', '|---|---|---|---|---|');
    for (const entry of result.added) {
      lines.push(`| ${entry.id} | ${entry.date} | ${entry.lang} | ${entry.category} | [${escapeCell(entry.title)}](${entry.url}) |`);
    }
    lines.push('');
    lines.push('<details><summary>Summaries (the platform\'s own text, cut to one or two sentences)</summary>', '');
    for (const entry of result.added) lines.push(`- **${entry.id}** ${escapeCell(entry.summary || '_(no summary text in the feed)_')}`);
    lines.push('', '</details>', '');
    lines.push('Categories are keyword guesses from the title; adjust by hand in this PR if needed. `tags` is empty and `featured` is false for new entries.', '');
  } else {
    lines.push('No new posts found.', '');
  }
  const noSummary = result.added.filter((entry) => !entry.summary);
  if (noSummary.length) {
    lines.push('### Entries without a summary (the feed had no usable text)', '');
    for (const entry of noSummary) lines.push(`- ${entry.id} ${escapeCell(entry.title)}`);
    lines.push('');
  }
  if (result.skipped.length) {
    lines.push('### Skipped this run (url check failed; retried next run)', '');
    for (const item of result.skipped) lines.push(`- ${item.url} — ${item.reason}`);
    lines.push('');
  }
  if (result.failedSources.length) {
    lines.push('### Sources that could not be read', '');
    for (const item of result.failedSources) lines.push(`- **${item.key}**: ${item.error}`);
    lines.push('');
  }
  if (opts.check) lines.push('_Dry run (--check): nothing was written._', '');
  return lines.join('\n');
}

function writeGithubOutput(result) {
  if (!process.env.GITHUB_OUTPUT) return;
  const lines = [
    `added=${result.added.length}`,
    `sources_failed=${result.failedSources.map((item) => item.key).join(',')}`,
  ];
  fs.appendFileSync(process.env.GITHUB_OUTPUT, lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------------------------
// Main

async function sync(opts) {
  const raw = fs.readFileSync(opts.file, 'utf8');
  const catalog = JSON.parse(raw);
  validateCatalog(catalog, 'catalog');
  const known = new Set(catalog.map((entry) => canonicalKey(entry.url)));
  const result = { added: [], skipped: [], failedSources: [] };
  const activeSources = SOURCES.filter((source) => opts.sources.includes(source.key));

  for (const source of activeSources) {
    let posts;
    try {
      posts = await source.fetchPosts();
    } catch (error) {
      result.failedSources.push({ key: source.key, error: error.message });
      process.stderr.write(`error: ${source.key}: ${error.message}\n`);
      continue;
    }
    const fresh = [];
    const seenHere = new Set();
    for (const post of posts) {
      const key = canonicalKey(post.url);
      if (known.has(key) || seenHere.has(key)) continue;
      seenHere.add(key);
      if (opts.since && localDate(post.publishedAt, source.timeZone) < opts.since) continue;
      fresh.push(post);
    }
    fresh.sort((a, b) => a.publishedAt - b.publishedAt || a.title.localeCompare(b.title));
    process.stdout.write(`${source.key}: ${posts.length} posts in feed, ${fresh.length} new\n`);

    const allocate = idAllocator(catalog.concat(result.added), source.idPrefix);
    for (const post of fresh) {
      if (opts.verify) {
        const check = await verifyUrl(post.url);
        if (!check.ok) {
          const reason = check.error ? check.error : `HTTP ${check.status}`;
          result.skipped.push({ url: post.url, reason });
          process.stderr.write(`warning: skipping ${post.url} (${reason})\n`);
          continue;
        }
      }
      post.summary = await resolveSummary(post);
      const entry = buildEntry(source, post, allocate());
      result.added.push(entry);
      known.add(canonicalKey(entry.url));
    }
  }

  for (const entry of result.added) {
    process.stdout.write(`${opts.check ? 'would add' : 'add'} ${entry.id}  ${entry.date}  ${entry.lang.padEnd(5)}  ${entry.category.padEnd(11)}  ${entry.title}\n`);
    if (!entry.summary) process.stderr.write(`warning: ${entry.id} has no summary text in the feed\n`);
  }

  if (result.added.length && !opts.check) {
    const next = appendToCatalogText(raw, result.added);
    const parsed = JSON.parse(next);
    validateCatalog(parsed, 'result');
    if (parsed.length !== catalog.length + result.added.length) throw new Error('result: unexpected entry count');
    catalog.forEach((entry, index) => {
      if (JSON.stringify(parsed[index]) !== JSON.stringify(entry)) throw new Error(`result: existing entry ${entry.id} would change`);
    });
    result.added.forEach((entry, index) => {
      if (JSON.stringify(parsed[catalog.length + index]) !== JSON.stringify(entry)) throw new Error(`result: new entry ${entry.id} did not round-trip`);
    });
    fs.writeFileSync(opts.file, next);
  }

  const summaryLine = result.added.length
    ? `${opts.check ? 'Would add' : 'Added'} ${result.added.length} ${result.added.length === 1 ? 'entry' : 'entries'} (${activeSources.map((s) => `${s.key} ${result.added.filter((e) => e.platform === s.platform).length}`).join(', ')}).`
    : 'Nothing to add.';
  process.stdout.write(summaryLine + '\n');
  if (result.skipped.length) process.stdout.write(`Skipped ${result.skipped.length} url(s) that did not answer 2xx; they will be retried next run.\n`);

  if (opts.report) fs.writeFileSync(opts.report, renderReport(result, opts));
  writeGithubOutput(result);

  if (result.failedSources.length === activeSources.length) {
    throw new Error(`every source failed: ${result.failedSources.map((item) => `${item.key} (${item.error})`).join('; ')}`);
  }
  return result;
}

if (require.main === module) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\nRun with --help for usage.\n`);
    process.exit(2);
  }
  sync(opts).catch((error) => {
    process.stderr.write(`error: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  CATEGORY_KEYWORDS,
  SOURCES,
  appendToCatalogText,
  canonicalKey,
  cleanUrl,
  guessCategory,
  localDate,
  parseRssItems,
  splitSentences,
  summarize,
  sync,
  validateCatalog,
};
