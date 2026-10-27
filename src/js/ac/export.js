/**
 * 成就收藏册 · 印刷素材导出
 *
 * 把三种实体收藏品按印刷规格渲染成图片：
 *   · 成就卡片：正面 JPG、反面 JPG，全册共用一张烫金层 PNG；
 *   · 年度最爱票根：JPG；
 *   · 年份页徽章邮票：JPG。
 *
 * 渲染走的是和页面完全相同的 DOM（createCardFront / createCardBack /
 * createTicketStub / createBadgeStamp），放进离屏的固定宽度容器里，
 * 再把 CSS、字体、图片全部内联进 SVG，最后用 <img> + canvas 光栅化。
 *
 * 两个必须遵守的前提：
 *   1. SVG 必须用 data URL 载入（blob URL 会让 foreignObject 污染 canvas）；
 *   2. background-clip: text 的文字在 foreignObject 里不会绘制，
 *      所以「完美通关」和票根排名先用 canvas 画成图片再替换。
 *
 * 尺寸：300 DPI，四周各 3 mm 出血（35 px）。票根 / 邮票按页内实际比例
 * 排版后再裁切，保证和屏幕上看到的比例完全一致。
 */

import { BIG_SPARKS, createCardBack, createCardFront } from './cardview.js';
import { createBadgeStamp, createTicketStub, isYearKey, normalizeSelection, yearKeyOf } from './yearpages.js';
import { getTone, toneToCss } from './tone.js';
import { loadBadge } from './badges.js';
import { inspectCapsule, peekCapsule } from './capsule.js';
import { STR } from './strings.js';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const DPI = 300;
const BLEED = 35;
const ROOT_FOLDER = '成就收藏册_印刷素材';
const FONT_URL =
    'https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@400;500;600;700;800&display=swap';

const SIZES = {
    card: { trimW: 750, trimH: 1050, bleedW: 820, bleedH: 1120 },
    ticket: {
        trimW: 1772,
        trimH: 485,
        bleedW: 1842,
        bleedH: 555,
        stageH: 485 / 0.166,
    },
    stamp: {
        trimW: 354,
        trimH: 430,
        bleedW: 424,
        bleedH: 500,
        stageH: 354 / 0.174,
    },
};

/** 离屏容器里补上的少量样式；正式 CSS 在序列化时才塞进 stage。 */
const BASE_CSS = `
.ac-export-root {
    position: relative;
    overflow: hidden;
    background: #fff;
    container-type: size;
}
.ac-export-root * {
    animation: none !important;
    transition: none !important;
}
.ac-export-root .ac-cf__spark { opacity: 0.9; }
.ac-export-root .ac-cf__spark--dust { opacity: 0.24; }
`;

const RULE_STYLE = 1;
const RULE_IMPORT = 3;
const RULE_MEDIA = 4;
const RULE_SUPPORTS = 12;

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function el(doc, tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (value == null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else if (key === 'style') node.style.cssText = value;
            else node.setAttribute(key, value === true ? '' : String(value));
        }
    }
    return node;
}

const sleep = (win, ms) => new Promise((resolve) => win.setTimeout(resolve, ms));
const pad3 = (n) => String(n).padStart(3, '0');

function sanitizeName(value) {
    return String(value ?? '')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 48);
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function stampNow(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function dateText(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 并发池：导出前预取完成日期、徽章、封面体检时用，避免一次压满请求 */
async function pool(items, limit, worker) {
    const queue = [...items];
    const workers = Array.from({ length: Math.max(1, Math.min(limit, queue.length)) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            try {
                await worker(item);
            } catch {
                // 单项失败不阻塞导出
            }
        }
    });
    await Promise.all(workers);
}

/* ── 选择与排序 ─────────────────────────────────────────────────────────── */

/** 和 book.js 的装订顺序保持一致（含年份分组），用于给卡片编号 */
export function orderForBook(cards, { binding = 'sequential', yearPages = false } = {}) {
    const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
    const indices = list.map((_, i) => i);
    if (!yearPages) {
        const ordered = binding === 'newest' ? [...indices].reverse() : indices;
        return ordered.map((i) => list[i]);
    }
    const buckets = new Map();
    list.forEach((card, i) => {
        const key = yearKeyOf(card);
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(i);
    });
    const keys = [...buckets.keys()].sort((a, b) => {
        if (a === 'unknown') return -1;
        if (b === 'unknown') return 1;
        return Number(a) - Number(b);
    });
    const ordered = [];
    for (const key of keys) {
        const bucket = buckets.get(key);
        for (const index of binding === 'newest' ? [...bucket].reverse() : bucket) {
            ordered.push(list[index]);
        }
    }
    return ordered;
}

/** 年份选择 → 实际要导出的票根 / 邮票（只导已填且游戏还在册子里的槽位） */
function planAssets(cards, yearSelections) {
    const byId = new Map(cards.map((card) => [card.appid, card]));
    const years = Object.keys(yearSelections ?? {})
        .filter((key) => isYearKey(key))
        .sort((a, b) => Number(a) - Number(b));
    const tickets = [];
    const stamps = [];
    for (const year of years) {
        const selection = normalizeSelection(yearSelections[year]);
        selection.banners.forEach((appid, index) => {
            const game = appid == null ? null : byId.get(Number(appid));
            if (game) tickets.push({ year, index, game });
        });
        selection.badges.forEach((picked, index) => {
            const game = picked ? byId.get(Number(picked.appid)) : null;
            if (game) stamps.push({ year, index, game, level: picked.level ?? 5 });
        });
    }
    return { tickets, stamps };
}

/** 弹窗里用来显示数量；返回可选类型与各自数量 */
export function countExportables(cards, yearSelections) {
    const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
    const assets = planAssets(list, yearSelections);
    return { cardCount: list.length, ticketCount: assets.tickets.length, stampCount: assets.stamps.length };
}

/* ── CSS / 字体 / 图片内联 ──────────────────────────────────────────────── */

/** 只收集会出现在卡片 / 年份页上的规则；书、状态页、选择器的样式没必要带进去 */
function relevantSelector(selector) {
    return (
        /(^|,)\s*:root(?![\w-])/.test(selector) ||
        /(?:^|[\s,>+~])\.ac-(?:card|cf|cb|year|sr-only|export-root)(?![\w])/.test(selector) ||
        /\.ac-(?:card|cf|cb|year)__/.test(selector)
    );
}

function rewriteRoot(text) {
    return text.replace(/(^|,)(\s*):root(?![\w-])/g, '$1$2.ac-export-root');
}

function collectRules(rules) {
    const out = [];
    for (const rule of rules) {
        if (rule.type === RULE_STYLE) {
            const selector = rule.selectorText || '';
            if (relevantSelector(selector)) out.push(rewriteRoot(rule.cssText));
            continue;
        }
        if (rule.type === RULE_IMPORT) {
            try {
                if (rule.styleSheet) out.push(...collectRules(rule.styleSheet.cssRules));
            } catch {
                // 跨域 @import（Google Fonts）拿不到规则；字体由 loadFontCss 单独内联
            }
            continue;
        }
        if (rule.type === RULE_MEDIA || rule.type === RULE_SUPPORTS) {
            try {
                const inner = collectRules(rule.cssRules ?? []);
                if (inner.length === 0) continue;
                const head = rule.type === RULE_MEDIA ? '@media' : '@supports';
                out.push(`${head} ${rule.conditionText}{${inner.join('\n')}}`);
            } catch {
                // 忽略无法展开的条件规则
            }
        }
    }
    return out;
}

/*
 * CSSOM 的 rule.cssText 会把 `background: var(--ac-rainbow)` 之类带 var() 的
 * 简写序列化成空值，导致导出的卡片丢掉彩虹边框。所以优先读样式表的原始文本，
 * 再按选择器筛掉和卡片 / 年份页无关的规则；CSSOM 只作为跨域等情况的兜底。
 */

function stripCssComments(text) {
    return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 按顶层规则切分 CSS 文本；引号和括号里的 {} ; 不算结构字符 */
function splitCssBlocks(text) {
    const blocks = [];
    let start = 0;
    let depth = 0;
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (quote) {
            if (ch === '\\') i += 1;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '{') depth += 1;
        else if (ch === '}') {
            if (depth > 0) depth -= 1;
            if (depth === 0) {
                blocks.push(text.slice(start, i + 1));
                start = i + 1;
            }
        } else if (ch === ';' && depth === 0) {
            blocks.push(text.slice(start, i + 1));
            start = i + 1;
        }
    }
    if (text.slice(start).trim()) blocks.push(text.slice(start));
    return blocks;
}

/** 保留 :root / .ac-* 规则和必要的 @ 规则，其余丢弃 */
function filterRawCss(text) {
    const out = [];
    for (const raw of splitCssBlocks(stripCssComments(text))) {
        const block = raw.trim();
        if (!block) continue;
        if (block.startsWith('@')) {
            const brace = block.indexOf('{');
            const name = (brace < 0 ? block : block.slice(0, brace))
                .trim()
                .split(/[\s({]/)[0]
                .toLowerCase();
            if (name === '@font-face' || name === '@keyframes' || name === '@-webkit-keyframes' || name === '@property') {
                out.push(block);
                continue;
            }
            if (name === '@media' || name === '@supports' || name === '@layer' || name === '@container') {
                if (brace < 0) continue;
                const inner = filterRawCss(block.slice(brace + 1, block.lastIndexOf('}')));
                if (inner) out.push(`${block.slice(0, brace)}{${inner}}`);
                continue;
            }
            // @import / @charset / @namespace：字体和本地导入已经单独处理
            continue;
        }
        const brace = block.indexOf('{');
        if (brace < 0) continue;
        const selector = block.slice(0, brace).trim();
        if (relevantSelector(selector)) out.push(rewriteRoot(block));
    }
    return out.join('\n');
}

function fetchCssText(win, url, cache) {
    if (!cache.has(url)) {
        const pending = (async () => {
            const res = await win.fetch(url, { credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.text();
        })();
        cache.set(url, pending);
    }
    return cache.get(url);
}

function resolveCssUrl(win, spec, base) {
    try {
        return new win.URL(spec, base || win.location?.href || undefined).href;
    } catch {
        return '';
    }
}

function sameOriginUrl(win, url) {
    try {
        const target = new win.URL(url);
        const here = new win.URL(win.location.href);
        if (target.protocol === 'file:' || here.protocol === 'file:') return target.protocol === here.protocol;
        return target.origin === here.origin;
    } catch {
        return false;
    }
}

const IMPORT_RE = /@import\s+(?:url\(\s*(?:(['"])(.*?)\1|([^'")]+))\s*\)|(['"])(.*?)\4)\s*([^;]*);/gi;

/** 展开本地 @import；Google Fonts 等跨域导入直接丢掉（字体另外内联） */
async function expandImports(win, text, base, cache, depth = 0) {
    if (depth > 4 || !text.includes('@import')) return text;
    let out = text;
    for (const match of text.matchAll(IMPORT_RE)) {
        const spec = (match[2] ?? match[3] ?? match[5] ?? '').trim();
        const suffix = (match[6] ?? '').trim();
        let replacement = '';
        if (spec) {
            const url = resolveCssUrl(win, spec, base);
            if (url && sameOriginUrl(win, url)) {
                try {
                    const raw = await fetchCssText(win, url, cache);
                    const expanded = await expandImports(win, raw, url, cache, depth + 1);
                    const filtered = filterRawCss(expanded);
                    if (filtered) replacement = /^[a-z]/i.test(suffix) ? `@media ${suffix}{${filtered}}` : filtered;
                } catch {
                    // 拿不到就当作没有这个导入
                }
            }
        }
        out = out.split(match[0]).join(replacement);
    }
    return out;
}

async function collectCss(doc) {
    const win = doc.defaultView;
    const docs = [doc];
    if (win?.document && win.document !== doc) docs.push(win.document);
    const cache = new Map();
    const seenSheets = new Set();
    const seenText = new Set();
    const out = [];
    const push = (text) => {
        const value = String(text ?? '').trim();
        if (!value || seenText.has(value)) return;
        seenText.add(value);
        out.push(value);
    };

    for (const target of docs) {
        for (const sheet of target.styleSheets ?? []) {
            const node = sheet.ownerNode;
            const href = sheet.href || node?.href || '';
            if (/^https?:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\b/i.test(href)) continue;
            const key = href || node;
            if (key && seenSheets.has(key)) continue;
            if (key) seenSheets.add(key);

            let relevant;
            try {
                relevant = collectRules(sheet.cssRules);
            } catch {
                // 跨域样式表（没有 CORS 头）拿不到规则
                continue;
            }
            if (relevant.length === 0) continue;

            let raw = '';
            try {
                if (node?.tagName === 'STYLE') raw = node.textContent ?? '';
                else if (href) raw = await fetchCssText(win, href, cache);
            } catch {
                raw = '';
            }
            if (raw) {
                raw = stripCssComments(raw);
                if (raw.includes('@import')) {
                    raw = await expandImports(win, raw, href || win?.location?.href || '', cache);
                }
            }
            const filtered = raw ? filterRawCss(raw) : '';
            push(filtered || relevant.join('\n'));
        }
    }
    return out.join('\n');
}

function readDataUrl(win, blob) {
    return new Promise((resolve, reject) => {
        const reader = new win.FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsDataURL(blob);
    });
}

/**
 * 徽章图在 cdn.akamai.steamstatic.com 上不返回 CORS 头，客户端页面不能 fetch；
 * 同一张图在 shared.steamstatic.com 的 community_assets 路径可以跨域读取。
 */
function steamImageAlternates(url) {
    const list = [url];
    const match = /^https?:\/\/[^/]+\/steamcommunity\/public\/images\/items\/(.+)$/i.exec(url);
    if (match) list.push(`https://shared.steamstatic.com/community_assets/images/items/${match[1]}`);
    return list;
}

async function fetchDataUrl(win, url) {
    let lastError = null;
    for (const candidate of steamImageAlternates(url)) {
        try {
            const res = await win.fetch(candidate, { credentials: 'omit' });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return await readDataUrl(win, await res.blob());
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError ?? new Error('fetch failed');
}

let fontCssValue = '';
let fontCssPromise = null;
let fontFailedAt = 0;

/**
 * 取 Google Fonts 的 woff2 并转成 data URL。样式表是跨域的，
 * 只能重新 fetch；Steam 客户端离线或被墙时直接退回系统字体。
 */
async function loadFontCss(doc) {
    if (fontCssValue) return fontCssValue;
    if (fontFailedAt && Date.now() - fontFailedAt < 10 * 60 * 1000) return '';
    if (fontCssPromise) return fontCssPromise;
    const win = doc.defaultView;
    fontCssPromise = (async () => {
        const controller = new win.AbortController();
        const timer = win.setTimeout(() => controller.abort(), 6000);
        try {
            const res = await win.fetch(FONT_URL, { credentials: 'omit', signal: controller.signal });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const text = await res.text();
            const blocks = text.match(/@font-face\s*\{[^}]*\}/g) ?? [];
            const converted = await Promise.all(
                blocks.map(async (block) => {
                    const match = /url\((['"]?)([^'")]+)\1\)/.exec(block);
                    if (!match) return null;
                    try {
                        const data = await fetchDataUrl(win, match[2]);
                        return block.replace(match[0], `url("${data}")`);
                    } catch {
                        return null;
                    }
                }),
            );
            fontCssValue = converted.filter(Boolean).join('\n');
            if (!fontCssValue) fontFailedAt = Date.now();
        } catch {
            fontFailedAt = Date.now();
            fontCssValue = '';
        } finally {
            win.clearTimeout(timer);
            fontCssPromise = null;
        }
        return fontCssValue;
    })();
    return fontCssPromise;
}

async function waitForFonts(doc) {
    const win = doc.defaultView;
    try {
        if (doc.fonts?.ready) await Promise.race([doc.fonts.ready, sleep(win, 2500)]);
    } catch {
        // 字体没加载完也能导出，只是退回后备字体
    }
}

/** 等 stage 里的图片加载稳定：artImage 会沿候选链换 src，等它换完 */
async function settleImages(doc, root) {
    const win = doc.defaultView;
    const deadline = Date.now() + 6000;
    let last = '';
    let stableSince = Date.now();
    while (Date.now() < deadline) {
        const imgs = [...root.querySelectorAll('img')];
        const state = imgs
            .map((img) => `${img.complete ? 1 : 0}:${img.naturalWidth}:${img.getAttribute('src') ?? ''}`)
            .join('|');
        if (state !== last) {
            last = state;
            stableSince = Date.now();
        }
        if (imgs.every((img) => img.complete) && Date.now() - stableSince > 200) break;
        await sleep(win, 50);
    }
}

/** 等 <img> 载入完成；decode() 在个别 Chromium 上会一直不落地，所以只看 load/error */
function waitImage(img, ms = 3000) {
    if (img.complete) return Promise.resolve();
    const win = img.ownerDocument?.defaultView;
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            img.removeEventListener('load', finish);
            img.removeEventListener('error', finish);
            resolve();
        };
        img.addEventListener('load', finish);
        img.addEventListener('error', finish);
        win?.setTimeout(finish, ms);
    });
}

/** 所有图片先抓成 data URL，foreignObject 离屏光栅化时才不会污染 canvas */
async function inlineImages(doc, root) {
    const win = doc.defaultView;
    for (const img of [...root.querySelectorAll('img')]) {
        const src = img.currentSrc || img.getAttribute('src') || '';
        if (!src) continue;
        if (src.startsWith('data:')) continue;
        try {
            const data = await fetchDataUrl(win, src);
            img.removeAttribute('srcset');
            img.src = data;
            await waitImage(img);
        } catch {
            img.removeAttribute('src');
            img.alt = '';
            img.dataset.missing = '';
            // 序列化后的 foreignObject 会把无 src 的 img 画成破图图标，直接隐藏
            img.style.setProperty('display', 'none', 'important');
        }
    }
}

/* ── 渐变文字 → canvas 图片 ─────────────────────────────────────────────── */

function splitTopLevel(value) {
    const parts = [];
    let depth = 0;
    let quote = '';
    let start = 0;
    for (let i = 0; i < value.length; i += 1) {
        const ch = value[i];
        if (quote) {
            if (ch === quote && value[i - 1] !== '\\') quote = '';
            continue;
        }
        if (ch === '"' || ch === "'") quote = ch;
        else if (ch === '(') depth += 1;
        else if (ch === ')') depth -= 1;
        else if (ch === ',' && depth === 0) {
            parts.push(value.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(value.slice(start));
    return parts;
}

function parseColorStop(part) {
    const text = part.trim();
    const match = /^(.*?)(?:\s+(-?[\d.]+)%)?$/.exec(text);
    if (!match) return null;
    const color = match[1].trim();
    if (!color) return null;
    return { color, offset: match[2] == null ? null : Number(match[2]) / 100 };
}

/**
 * 把 computed background-image 里的 linear-gradient 搬到 canvas。
 * 只处理卡片 / 票根实际用到的格式；解析失败时用 fallback 纯色。
 */
function paintForGradient(ctx, image, width, height, fallback) {
    const match = /^(?:repeating-)?linear-gradient\((.*)\)$/i.exec(String(image ?? '').trim());
    if (!match) return fallback;
    const parts = splitTopLevel(match[1]).map((part) => part.trim()).filter(Boolean);
    let angle = 180;
    const angleMatch = /^(-?[\d.]+)deg$/.exec(parts[0] ?? '');
    if (angleMatch) {
        angle = Number(angleMatch[1]);
        parts.shift();
    }
    const stops = parts.map(parseColorStop).filter(Boolean);
    if (stops.length === 0) return fallback;
    if (stops.length === 1) return stops[0].color;
    if (stops[0].offset == null) stops[0].offset = 0;
    if (stops.at(-1).offset == null) stops.at(-1).offset = 1;
    for (let i = 1; i < stops.length - 1; i += 1) {
        if (stops[i].offset != null) continue;
        let next = i + 1;
        while (next < stops.length && stops[next].offset == null) next += 1;
        const from = stops[i - 1].offset;
        const to = next < stops.length ? stops[next].offset : 1;
        const step = (to - from) / (next - i + 1);
        for (let j = i; j < next; j += 1) stops[j].offset = from + step * (j - i + 1);
    }
    const rad = ((angle - 90) * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const length = Math.abs(width * dx) + Math.abs(height * dy);
    const cx = width / 2;
    const cy = height / 2;
    const gradient = ctx.createLinearGradient(
        cx - (dx * length) / 2,
        cy - (dy * length) / 2,
        cx + (dx * length) / 2,
        cy + (dy * length) / 2,
    );
    for (const stop of stops) {
        const offset = Math.max(0, Math.min(1, stop.offset));
        try {
            gradient.addColorStop(offset, stop.color);
        } catch {
            // 不认识的色值就跳过这一站
        }
    }
    return gradient;
}

/** 把一个 background-clip:text 的节点画成图片，并替换掉原节点（保持原盒尺寸） */
function gradientNodeToImage(doc, node, fallback) {
    const win = doc.defaultView;
    const text = node.textContent ?? '';
    if (!text) return null;
    const box = node.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    const cs = win.getComputedStyle(node);
    const fontSize = parseFloat(cs.fontSize) || 16;
    const scale = 2;
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(box.width * scale));
    canvas.height = Math.max(1, Math.ceil(box.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${fontSize}px ${cs.fontFamily}`;
    ctx.letterSpacing = cs.letterSpacing && cs.letterSpacing !== 'normal' ? cs.letterSpacing : '0px';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = paintForGradient(ctx, cs.backgroundImage, box.width, box.height, fallback);

    const range = doc.createRange();
    range.selectNodeContents(node);
    const tr = range.getBoundingClientRect();
    const metrics = ctx.measureText(text);
    const ascent = metrics.fontBoundingBoxAscent ?? fontSize * 0.8;
    const descent = metrics.fontBoundingBoxDescent ?? fontSize * 0.2;
    const baseline = (box.height - (ascent + descent)) / 2 + ascent;
    const x = Math.max(0, tr.left - box.left);
    ctx.fillText(text, x, baseline);

    const img = doc.createElement('img');
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.draggable = false;
    img.style.cssText = `display:block;width:${box.width}px;height:${box.height}px;`;
    if (cs.filter && cs.filter !== 'none') img.style.filter = cs.filter;
    img.src = canvas.toDataURL('image/png');
    node.replaceWith(img);
    return img;
}

function replaceGradientText(doc, root) {
    for (const node of [...root.querySelectorAll('.ac-cf__perfect span')]) {
        gradientNodeToImage(doc, node, '#6ff09a');
    }
    for (const node of [...root.querySelectorAll('.ac-year__stub-rank')]) {
        const rank = node.closest('.ac-year__ticket')?.dataset.rank ?? '1';
        const fallback = rank === '2' ? '#8a96a6' : rank === '3' ? '#c07a45' : '#d9a52b';
        gradientNodeToImage(doc, node, fallback);
    }
}

/* ── 离屏 stage、序列化、光栅化 ─────────────────────────────────────────── */

function createHost(doc) {
    const host = el(doc, 'div', 'ac-export-host', {
        style: 'position:fixed;left:-40000px;top:0;width:0;height:0;overflow:visible;pointer-events:none;',
    });
    doc.body.append(host);
    return host;
}

function createStage(doc, width, height) {
    const root = el(doc, 'div', 'ac-export-root', {
        style: `position:absolute;left:0;top:0;width:${width}px;height:${height}px;`,
    });
    root.setAttribute('xmlns', XHTML_NS);
    const style = el(doc, 'style', null, { 'data-ac-export-base': '' });
    style.textContent = BASE_CSS;
    root.append(style);
    return root;
}

function num(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(4);
}

function serializeStage(doc, root, cssText, width, height) {
    const style = el(doc, 'style', null, { 'data-ac-export-css': '' });
    style.textContent = cssText;
    root.insertBefore(style, root.firstChild);
    let inner;
    try {
        inner = new (doc.defaultView.XMLSerializer)().serializeToString(root);
    } finally {
        style.remove();
    }
    return (
        `<svg xmlns="${SVG_NS}" width="${num(width)}" height="${num(height)}" ` +
        `viewBox="0 0 ${num(width)} ${num(height)}">` +
        `<foreignObject x="0" y="0" width="${num(width)}" height="${num(height)}">` +
        `${inner}</foreignObject></svg>`
    );
}

async function svgToImage(doc, svgText) {
    const win = doc.defaultView;
    const blob = new win.Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const dataUrl = await readDataUrl(win, blob);
    const img = doc.createElement('img');
    const loaded = new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('SVG 光栅化失败'));
    });
    img.src = dataUrl;
    await loaded;
    return img;
}

async function rasterizeStage(doc, root, cssText, width, height, crop) {
    const img = await svgToImage(doc, serializeStage(doc, root, cssText, width, height));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(crop.w));
    canvas.height = Math.max(1, Math.round(crop.h));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, canvas.width, canvas.height);
    return canvas;
}

/* ── 出血、烫金层 ───────────────────────────────────────────────────────── */

/** 成品原样放在 3 mm 出血正中；四周留白，不拉伸复制成品边缘（会多出一圈重影边） */
function composeBleed(doc, trimCanvas, size) {
    const full = doc.createElement('canvas');
    full.width = size.bleedW;
    full.height = size.bleedH;
    const ctx = full.getContext('2d');
    if (!ctx) return trimCanvas;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, full.width, full.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(trimCanvas, BLEED, BLEED);
    return full;
}

/**
 * 卡片的出血不是另画一圈边，而是把卡片自己的彩虹边框渐变按相同的绝对几何
 * 铺满整张出血画布：卡面与出血落在同一条渐变上，裁切到哪里都不会露白。
 */
function paintBleed(doc, root, face) {
    const win = doc.defaultView;
    const rect = face.getBoundingClientRect();
    const style = win.getComputedStyle(face);
    const image = style.backgroundImage;
    if (!image || image === 'none') return;

    const resolve = (text, axis) => {
        const value = String(text ?? '').trim();
        const pct = /^(-?[\d.]+)%$/.exec(value);
        if (pct) return (Number(pct[1]) / 100) * (axis === 'x' ? rect.width : rect.height);
        const px = /^(-?[\d.]+)px$/.exec(value);
        if (px) return Number(px[1]);
        return axis === 'x' ? rect.width : rect.height;
    };
    const size = String(style.backgroundSize || '').trim().split(/\s+/);
    const imageW = resolve(size[0], 'x');
    const imageH = resolve(size[1] ?? size[0], 'y');
    const px = Number.parseFloat(style.getPropertyValue('--px'));
    const py = Number.parseFloat(style.getPropertyValue('--py'));

    root.style.backgroundImage = image;
    root.style.backgroundSize = `${imageW}px ${imageH}px`;
    root.style.backgroundPosition =
        `${(rect.width - imageW) * (Number.isFinite(px) ? px : 0.5) + BLEED}px ` +
        `${(rect.height - imageH) * (Number.isFinite(py) ? py : 0.5) + BLEED}px`;
    root.style.backgroundRepeat = 'no-repeat';
}

function badgeSource(doc, root, badge) {
    const win = doc.defaultView;
    const fromBadge = /url\((['"]?)(.*?)\1\)/.exec(win.getComputedStyle(badge).backgroundImage)?.[2];
    if (fromBadge && fromBadge !== 'none') return fromBadge;
    const raw = win.getComputedStyle(root).getPropertyValue('--ac-badge-img').trim();
    return /url\((['"]?)(.*?)\1\)/.exec(raw)?.[2] ?? '';
}

function drawStar(ctx, x, y, size) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(size / 20, size / 20);
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.bezierCurveTo(10.9, 6.2, 13.8, 9.1, 20, 10);
    ctx.bezierCurveTo(13.8, 10.9, 10.9, 13.8, 10, 20);
    ctx.bezierCurveTo(9.1, 13.8, 6.2, 10.9, 0, 10);
    ctx.bezierCurveTo(6.2, 9.1, 9.1, 6.2, 10, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

function decodeDataUrl(url) {
    const comma = url.indexOf(',');
    if (comma < 0) return '';
    const meta = url.slice(0, comma);
    const body = url.slice(comma + 1);
    if (/;base64/i.test(meta)) {
        try {
            const binary = atob(body);
            const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
            return new TextDecoder().decode(bytes);
        } catch {
            return '';
        }
    }
    try {
        return decodeURIComponent(body);
    } catch {
        return body;
    }
}

// 只留下 SVG 里描边用金色渐变（url(#rim)）的路径，其余填充、深色描边、高光全部去掉
const FOIL_STYLE =
    '<style>' +
    'path,circle,rect,polygon,ellipse,line,polyline{fill:none!important;stroke:none!important}' +
    'path[stroke="url(#rim)"]{stroke:url(#rim)!important}' +
    '#ac-foil-mask rect{fill:#fff!important}' +
    '#ac-foil-mask path{fill:#000!important}' +
    '</style>';

/**
 * 丝带描边的顶边原本压在星形下面，去掉填充后会露到星形内部。
 * 用 SVG 自己的星形路径做一个遮罩，把丝带被星形盖住的部分重新藏起来。
 */
function foilSvgMarkup(text) {
    const star = /d="([^"]+)"[^>]*fill="url\(#blue\)"/.exec(text)?.[1];
    let svg = text.replace(/<svg\b[^>]*>/, (tag) => `${tag}${FOIL_STYLE}`);
    if (!star) return svg;
    const mask =
        '<mask id="ac-foil-mask" maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="158">' +
        '<rect x="-20" y="-20" width="140" height="158" fill="#fff"/>' +
        `<path d="${star}" fill="#000"/>` +
        '</mask>';
    svg = svg.replace(/<svg\b[^>]*>/, (tag) => `${tag}${mask}`);
    return svg.replace(/(<path\b[^>]*stroke-width="4\.6"[^>]*?)\/>/g, '$1 mask="url(#ac-foil-mask)"/>');
}

/** 把徽章现成 SVG 改成「只有金色描边」的版本，再光栅化成图片 */
async function badgeGoldImage(doc, root, badge) {
    const source = badgeSource(doc, root, badge);
    if (!source) return null;
    let text = '';
    if (source.startsWith('data:')) {
        text = decodeDataUrl(source);
    } else {
        try {
            const res = await doc.defaultView.fetch(source, { credentials: 'omit' });
            if (res.ok) text = await res.text();
        } catch {
            return null;
        }
    }
    if (!/<svg\b/i.test(text)) return null;
    try {
        return await svgToImage(doc, foilSvgMarkup(text));
    } catch {
        return null;
    }
}

/**
 * 烫金层：徽章的金色描边取自现成的徽章 SVG（只保留 rim 描边），
 * 再叠上页面上的三颗大星芒。透明背景，成品尺寸 + 出血。
 */
async function buildFoil(doc, root, size) {
    const canvas = doc.createElement('canvas');
    canvas.width = size.bleedW;
    canvas.height = size.bleedH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;

    const rootRect = root.getBoundingClientRect();
    const badge = root.querySelector('.ac-cf__badge');
    let bx = 0;
    let by = 0;
    let bw = 0;
    let bh = 0;
    if (badge) {
        const rect = badge.getBoundingClientRect();
        bx = rect.left - rootRect.left;
        by = rect.top - rootRect.top;
        bw = rect.width;
        bh = rect.height;
    }

    const gold = (fromX, fromY, toX, toY) => {
        const gradient = ctx.createLinearGradient(fromX, fromY, toX, toY);
        gradient.addColorStop(0, '#fff6d6');
        gradient.addColorStop(0.45, '#f7d77e');
        gradient.addColorStop(1, '#d49b2c');
        return gradient;
    };

    // 星芒按固定版式绘制，不读星星自身的 DOM 位置：宿主样式把星芒挤到角上时，
    // 烫金层也不会把星星画进出血区。
    const inner = root.querySelector('.ac-cf__inner');
    const card = root.querySelector('.ac-card');
    if (inner && card) {
        const innerRect = inner.getBoundingClientRect();
        const cardWidth = card.getBoundingClientRect().width;
        for (const [left, top, width] of BIG_SPARKS) {
            const side = (width / 100) * cardWidth;
            const x = innerRect.left - rootRect.left + (left / 100) * innerRect.width - side / 2;
            const y = innerRect.top - rootRect.top + (top / 100) * innerRect.height - side / 2;
            ctx.fillStyle = gold(x, y, x + side, y + side);
            drawStar(ctx, x, y, side);
        }
    }

    if (!badge || bw < 1 || bh < 1) return canvas;
    const image = await badgeGoldImage(doc, root, badge);
    if (image) ctx.drawImage(image, bx, by, bw, bh);
    return canvas;
}

/* ── 编码：JPEG / PNG 写入 300 DPI，ZIP 打包 ───────────────────────────── */

function canvasToBlob(canvas, win, type, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas encode failed'))), type, quality);
    });
}

function setJpegDpi(bytes, dpi = DPI) {
    let offset = 2;
    while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
        const marker = bytes[offset + 1];
        if (marker === 0xda) break;
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (marker === 0xe0 && bytes[offset + 4] === 0x4a && bytes[offset + 5] === 0x46) {
            bytes[offset + 11] = 1;
            bytes[offset + 12] = (dpi >> 8) & 0xff;
            bytes[offset + 13] = dpi & 0xff;
            bytes[offset + 14] = (dpi >> 8) & 0xff;
            bytes[offset + 15] = dpi & 0xff;
            return bytes;
        }
        offset += 2 + length;
    }
    const app0 = new Uint8Array([
        0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x01, 0x2c, 0x01, 0x2c,
        0x00, 0x00,
    ]);
    const out = new Uint8Array(bytes.length + app0.length);
    out.set(bytes.subarray(0, 2), 0);
    out.set(app0, 2);
    out.set(bytes.subarray(2), 2 + app0.length);
    return out;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
        let value = i;
        for (let j = 0; j < 8; j += 1) {
            value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        }
        table[i] = value >>> 0;
    }
    return table;
})();

function crc32(data) {
    let value = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) {
        value = CRC_TABLE[(value ^ data[i]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function setPngDpi(bytes, dpi = DPI) {
    const ppm = Math.round(dpi / 0.0254);
    const chunk = new Uint8Array(4 + 4 + 9 + 4);
    const view = new DataView(chunk.buffer);
    view.setUint32(0, 9);
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);
    view.setUint32(8, ppm);
    view.setUint32(12, ppm);
    chunk[16] = 1;
    view.setUint32(17, crc32(chunk.subarray(4, 17)));
    const ihdrEnd = 8 + 4 + 4 + 13 + 4;
    const out = new Uint8Array(bytes.length + chunk.length);
    out.set(bytes.subarray(0, ihdrEnd), 0);
    out.set(chunk, ihdrEnd);
    out.set(bytes.subarray(ihdrEnd), ihdrEnd + chunk.length);
    return out;
}

async function jpegFile(win, canvas, quality = 0.95) {
    const blob = await canvasToBlob(canvas, win, 'image/jpeg', quality);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return new Blob([setJpegDpi(bytes)], { type: 'image/jpeg' });
}

async function pngFile(win, canvas) {
    const blob = await canvasToBlob(canvas, win, 'image/png');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return new Blob([setPngDpi(bytes)], { type: 'image/png' });
}

function dosTime(date) {
    return {
        time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
        date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    };
}

/** 只做 store（不压缩）的 ZIP；文件名带 UTF-8 标记，Windows 资源管理器可直接解压中文名 */
function zipStore(entries) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    for (const entry of entries) {
        const name = enc.encode(entry.name);
        const data = entry.data;
        const crc = crc32(data);
        const when = dosTime(entry.date ?? new Date());
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, 0, true);
        lv.setUint16(10, when.time, true);
        lv.setUint16(12, when.date, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, data.length, true);
        lv.setUint32(22, data.length, true);
        lv.setUint16(26, name.length, true);
        lv.setUint16(28, 0, true);
        local.set(name, 30);

        const cd = new Uint8Array(46 + name.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, when.time, true);
        cv.setUint16(14, when.date, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, data.length, true);
        cv.setUint32(24, data.length, true);
        cv.setUint16(28, name.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        cd.set(name, 46);

        parts.push(local, data);
        central.push(cd);
        offset += local.length + data.length;
    }
    const centralSize = central.reduce((sum, part) => sum + part.length, 0);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);
    parts.push(...central, end);
    return new Blob(parts, { type: 'application/zip' });
}

/* ── 单个素材的渲染 ─────────────────────────────────────────────────────── */

function cardLabel(serial, card) {
    return `No.${pad3(serial)}_${card.appid}_${sanitizeName(card.name) || 'game'}`;
}

function ticketLabel(item) {
    return `${item.year}_${String(item.index + 1).padStart(2, '0')}_${sanitizeName(item.game.name) || 'game'}`;
}

async function prepareCard(doc, card) {
    const firstCapsule = card.art?.capsule?.[0];
    if (!firstCapsule) return;
    try {
        if (peekCapsule(doc, firstCapsule) === undefined) await inspectCapsule(doc, firstCapsule);
    } catch {
        // 体检失败就按普通封面处理
    }
}

async function renderCard(ctx, card, serial, tone) {
    const { doc, host, owner, cssText, size } = ctx;
    const root = createStage(doc, size.bleedW, size.bleedH);
    host.append(root);
    const label = cardLabel(serial, card);
    try {
        const cardEl = el(doc, 'div', 'ac-card', {
            style: `position:absolute;left:${BLEED}px;top:${BLEED}px;width:${size.trimW}px;`,
        });
        root.append(cardEl);

        cardEl.append(createCardFront(doc, card, { owner }));
        const front = cardEl.querySelector('.ac-cf');
        if (tone && front) front.style.setProperty('--ac-tone', toneToCss(tone));
        // 去掉卡边的高光/投影线：印刷出血要与卡边连成一片，不能出现裁切线
        if (front) {
            front.style.boxShadow = 'none';
            paintBleed(doc, root, front);
        }
        await settleImages(doc, root);
        replaceGradientText(doc, root);
        await inlineImages(doc, root);
        let bleed = await rasterizeStage(doc, root, cssText, size.bleedW, size.bleedH, {
            x: 0,
            y: 0,
            w: size.bleedW,
            h: size.bleedH,
        });
        await ctx.addFile(`${STR.export.folderCards}/${label}_${STR.export.cardFront}.jpg`, await jpegFile(doc.defaultView, bleed));
        bleed.width = 0;

        const back = createCardBack(doc, card);
        back.style.boxShadow = 'none';
        cardEl.replaceChildren(back);
        await settleImages(doc, root);
        await inlineImages(doc, root);
        bleed = await rasterizeStage(doc, root, cssText, size.bleedW, size.bleedH, {
            x: 0,
            y: 0,
            w: size.bleedW,
            h: size.bleedH,
        });
        await ctx.addFile(`${STR.export.folderCards}/${label}_${STR.export.cardBack}.jpg`, await jpegFile(doc.defaultView, bleed));
        bleed.width = 0;
    } finally {
        root.remove();
    }
}

/** 烫金层每张卡片都一样：借用第一张卡片的版式生成一次，全册共用 */
async function renderFoil(ctx, card) {
    const { doc, host, owner, size } = ctx;
    const root = createStage(doc, size.bleedW, size.bleedH);
    host.append(root);
    try {
        const cardEl = el(doc, 'div', 'ac-card', {
            style: `position:absolute;left:${BLEED}px;top:${BLEED}px;width:${size.trimW}px;`,
        });
        root.append(cardEl);
        cardEl.append(createCardFront(doc, card, { owner }));
        const canvas = await buildFoil(doc, root, size);
        await ctx.addFile(`${STR.export.folderCards}/${STR.export.foil}.png`, await pngFile(doc.defaultView, canvas));
        canvas.width = 0;
    } finally {
        root.remove();
    }
}

async function renderTicket(ctx, item) {
    const { doc, host, cssText, size } = ctx;
    const root = createStage(doc, size.trimW, size.stageH);
    host.append(root);
    try {
        const year = el(doc, 'div', 'ac-year ac-year--annual', {
            style: 'position:absolute;inset:0;text-align:center;',
        });
        const ticket = createTicketStub(doc, item.game, item.index);
        ticket.style.cssText += ';--shift:0cqh;--rot:0deg;transform:none;filter:none;';
        year.append(ticket);
        root.append(year);
        await settleImages(doc, root);
        replaceGradientText(doc, root);
        await inlineImages(doc, root);
        const trim = await rasterizeStage(doc, root, cssText, size.trimW, size.stageH, {
            x: 0,
            y: 0,
            w: size.trimW,
            h: size.trimH,
        });
        const bleed = composeBleed(doc, trim, size);
        await ctx.addFile(`${STR.export.folderTickets}/${ticketLabel(item)}.jpg`, await jpegFile(doc.defaultView, bleed));
        trim.width = 0;
        bleed.width = 0;
    } finally {
        root.remove();
    }
}

async function renderStamp(ctx, item) {
    const { doc, host, cssText, size } = ctx;
    const root = createStage(doc, size.trimW, size.stageH);
    host.append(root);
    try {
        const year = el(doc, 'div', 'ac-year ac-year--year', { style: 'position:absolute;inset:0;' });
        const stamp = createBadgeStamp(doc, item.game, item.level);
        stamp.style.cssText += ';position:absolute;left:0;top:0;filter:none;';
        year.append(stamp);
        root.append(year);
        await settleImages(doc, root);
        await inlineImages(doc, root);
        const trim = await rasterizeStage(doc, root, cssText, size.trimW, size.stageH, {
            x: 0,
            y: 0,
            w: size.trimW,
            h: size.trimH,
        });
        const bleed = composeBleed(doc, trim, size);
        await ctx.addFile(`${STR.export.folderStamps}/${ticketLabel(item)}.jpg`, await jpegFile(doc.defaultView, bleed));
        trim.width = 0;
        bleed.width = 0;
    } finally {
        root.remove();
    }
}

/* ── 导出主流程 ─────────────────────────────────────────────────────────── */

/**
 * 生成 ZIP。返回 { blob, fileName, files, failed, cancelled }。
 * cancelToken.cancelled = true 时在当前文件结束后停下。
 */
export async function buildExportZip({
    doc,
    cards,
    owner = {},
    yearSelections = {},
    binding = 'sequential',
    yearPages = false,
    types = { cards: true, tickets: true, stamps: true },
    onProgress = null,
    cancelToken = null,
}) {
    const win = doc.defaultView;
    const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
    const ordered = orderForBook(list, { binding, yearPages });
    const assets = planAssets(list, yearSelections);
    const chosen = {
        cards: types.cards !== false && ordered.length > 0,
        tickets: types.tickets !== false && assets.tickets.length > 0,
        stamps: types.stamps !== false && assets.stamps.length > 0,
    };
    const total =
        (chosen.cards ? ordered.length * 2 + 1 : 0) +
        (chosen.tickets ? assets.tickets.length : 0) +
        (chosen.stamps ? assets.stamps.length : 0);
    const files = [];
    const failed = [];
    let done = 0;
    const cancelled = () => !!cancelToken?.cancelled;

    if (total === 0) return { blob: null, fileName: '', files: [], failed, cancelled: false };
    onProgress?.({ done: 0, total, label: STR.export.preparing });

    const [fontCss, cssText] = await Promise.all([loadFontCss(doc), collectCss(doc)]);
    const fullCss = [cssText, fontCss, BASE_CSS].filter(Boolean).join('\n');
    await waitForFonts(doc);

    const tones = new Map();
    if (chosen.cards) {
        await pool(ordered, 3, async (card) => {
            if (cancelled()) return;
            await prepareCard(doc, card);
            const tone = await getTone(doc, card.appid, card.art?.hero ?? [], 1.25);
            if (tone) tones.set(card.appid, tone);
        });
    }
    if (chosen.stamps) {
        const ids = [...new Set(assets.stamps.filter((item) => item.level !== 'cover').map((item) => item.game.appid))];
        await pool(ids, 3, (appid) => loadBadge(appid));
    }
    if (cancelled()) return { blob: null, fileName: '', files, failed, cancelled: true };
    await waitForFonts(doc);

    const host = createHost(doc);
    const ctx = {
        doc,
        host,
        owner,
        cssText: fullCss,
        size: SIZES.card,
        async addFile(path, blob) {
            done += 1;
            files.push({ path, blob, date: new Date() });
            onProgress?.({ done, total, label: path });
            // 让进度条有机会重绘，也便于取消
            await sleep(win, 0);
        },
    };

    try {
        if (chosen.cards) {
            report: for (let i = 0; i < ordered.length; i += 1) {
                if (cancelled()) break report;
                const card = ordered[i];
                try {
                    await renderCard(ctx, card, i + 1, tones.get(card.appid));
                } catch (err) {
                    failed.push(`No.${pad3(i + 1)} ${card.name ?? card.appid}`);
                }
                await sleep(win, 0);
            }
            if (!cancelled()) {
                try {
                    await renderFoil(ctx, ordered[0]);
                } catch {
                    failed.push(STR.export.foil);
                }
            }
        }
        if (chosen.tickets) {
            for (const item of assets.tickets) {
                if (cancelled()) break;
                try {
                    await renderTicket({ ...ctx, size: SIZES.ticket }, item);
                } catch {
                    failed.push(`${item.year} 票根 ${item.index + 1} · ${item.game.name ?? item.game.appid}`);
                }
                await sleep(win, 0);
            }
        }
        if (chosen.stamps) {
            for (const item of assets.stamps) {
                if (cancelled()) break;
                try {
                    await renderStamp({ ...ctx, size: SIZES.stamp }, item);
                } catch {
                    failed.push(`${item.year} 邮票 ${item.index + 1} · ${item.game.name ?? item.game.appid}`);
                }
                await sleep(win, 0);
            }
        }
    } finally {
        host.remove();
    }

    if (cancelled()) return { blob: null, fileName: '', files, failed, cancelled: true };

    const now = new Date();
    const readme = STR.export.readme({
        date: dateText(now),
        cardCount: chosen.cards ? ordered.length : 0,
        ticketCount: chosen.tickets ? assets.tickets.length : 0,
        stampCount: chosen.stamps ? assets.stamps.length : 0,
        failed: failed.length,
    });
    const entries = [
        {
            name: `${ROOT_FOLDER}/${STR.export.readmeName}`,
            data: new TextEncoder().encode(`\uFEFF${readme}`),
            date: now,
        },
    ];
    for (const file of files) {
        entries.push({
            name: `${ROOT_FOLDER}/${file.path}`,
            data: new Uint8Array(await file.blob.arrayBuffer()),
            date: file.date,
        });
    }
    return {
        blob: zipStore(entries),
        fileName: STR.export.downloadName(stampNow(now)),
        files,
        failed,
        cancelled: false,
    };
}

/* ── 导出弹窗 ───────────────────────────────────────────────────────────── */

function saveBlob(doc, name, blob) {
    const win = doc.defaultView;
    const url = win.URL.createObjectURL(blob);
    const anchor = el(doc, 'a', null, { href: url, download: name, rel: 'noopener' });
    anchor.style.display = 'none';
    doc.body.append(anchor);
    anchor.click();
    anchor.remove();
    win.setTimeout(() => win.URL.revokeObjectURL(url), 60000);
}

/**
 * 一键导出入口。host 必须是覆盖卡册的定位容器；弹窗自己管理生命周期。
 * @returns {{ close: () => void }}
 */
export function openExportDialog({ host, cards, owner = {}, yearSelections = {}, binding = 'sequential', yearPages = false, onClose }) {
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    const { cardCount, ticketCount, stampCount } = countExportables(cards, yearSelections);
    const overlay = el(doc, 'div', 'ac-export', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'ac-export-title',
    });
    const backdrop = el(doc, 'div', 'ac-export__backdrop', { 'aria-hidden': 'true' });
    const panel = el(doc, 'div', 'ac-export__panel');
    const header = el(doc, 'header', 'ac-export__head');
    const titles = el(doc, 'div', 'ac-export__titles');
    titles.append(el(doc, 'h2', 'ac-export__title', { id: 'ac-export-title', text: STR.export.title }));
    titles.append(el(doc, 'p', 'ac-export__desc', { text: STR.export.desc }));
    const closeButton = el(doc, 'button', 'ac-export__x', {
        type: 'button',
        'aria-label': STR.export.close,
        text: '×',
    });
    header.append(titles, closeButton);

    const options = el(doc, 'div', 'ac-export__options');
    const checks = {};
    const rows = [
        {
            type: 'cards',
            count: cardCount,
            label: STR.export.cards,
            desc: STR.export.cardsDesc(cardCount),
            empty: STR.export.emptyCards,
        },
        {
            type: 'tickets',
            count: ticketCount,
            label: STR.export.tickets,
            desc: STR.export.ticketsDesc(ticketCount),
            empty: STR.export.emptyTickets,
        },
        {
            type: 'stamps',
            count: stampCount,
            label: STR.export.stamps,
            desc: STR.export.stampsDesc(stampCount),
            empty: STR.export.emptyStamps,
        },
    ];
    for (const row of rows) {
        const option = el(doc, 'label', `ac-export__option${row.count > 0 ? '' : ' is-empty'}`);
        const input = el(doc, 'input', 'ac-export__check', {
            type: 'checkbox',
            'data-type': row.type,
        });
        input.checked = row.count > 0;
        input.disabled = row.count === 0;
        const copy = el(doc, 'span', 'ac-export__copy');
        copy.append(
            el(doc, 'b', null, { text: row.label }),
            el(doc, 'span', null, { text: row.count > 0 ? row.desc : row.empty }),
        );
        option.append(input, copy, el(doc, 'span', 'ac-export__count', { text: String(row.count) }));
        options.append(option);
        checks[row.type] = input;
    }
    const note = el(doc, 'p', 'ac-export__note', { text: STR.export.note });
    const totalLine = el(doc, 'p', 'ac-export__total');
    const progressBox = el(doc, 'div', 'ac-export__progress');
    const bar = el(doc, 'div', 'ac-export__bar');
    const barFill = el(doc, 'i', null);
    bar.append(barFill);
    const status = el(doc, 'p', 'ac-export__status');
    progressBox.append(bar, status);
    progressBox.hidden = true;

    const footer = el(doc, 'footer', 'ac-export__foot');
    const cancelButton = el(doc, 'button', 'ac-export__btn', { type: 'button' });
    const actionButton = el(doc, 'button', 'ac-export__btn ac-export__btn--primary', { type: 'button' });
    footer.append(cancelButton, actionButton);
    panel.append(header, options, note, totalLine, progressBox, footer);
    overlay.append(backdrop, panel);
    host.append(overlay);

    let closed = false;
    let running = false;
    let finished = false;
    let result = null;
    let cancelToken = null;

    const selectedTypes = () => ({
        cards: checks.cards.checked,
        tickets: checks.tickets.checked,
        stamps: checks.stamps.checked,
    });
    const selectedFiles = () => {
        const types = selectedTypes();
        return (types.cards ? cardCount * 2 + 1 : 0) + (types.tickets ? ticketCount : 0) + (types.stamps ? stampCount : 0);
    };
    const refreshTotal = () => {
        const count = selectedFiles();
        totalLine.textContent = STR.export.total(count);
        actionButton.disabled = running || count === 0;
    };

    const resetFooter = () => {
        cancelButton.disabled = false;
        cancelButton.textContent = STR.export.cancel;
        actionButton.classList.add('ac-export__btn--primary');
        if (finished) {
            cancelButton.textContent = STR.export.close;
            actionButton.textContent = STR.export.downloadAgain;
            actionButton.disabled = !result?.blob;
            actionButton.classList.add('ac-export__btn--primary');
        } else {
            actionButton.textContent = STR.export.start;
            refreshTotal();
        }
    };

    const finishClose = () => {
        if (closed) return;
        closed = true;
        win.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        onClose?.();
    };
    const close = () => {
        if (running) {
            if (cancelToken) cancelToken.cancelled = true;
            cancelButton.disabled = true;
            actionButton.disabled = true;
            status.textContent = STR.export.cancelling;
            cancelButton.textContent = STR.export.cancelling;
            return;
        }
        finishClose();
    };

    const start = async () => {
        const types = selectedTypes();
        const count = selectedFiles();
        if (count === 0) return;
        running = true;
        finished = false;
        result = null;
        cancelToken = { cancelled: false };
        closeButton.disabled = true;
        cancelButton.textContent = STR.export.cancelRun;
        actionButton.textContent = STR.export.start;
        actionButton.disabled = true;
        for (const input of Object.values(checks)) input.disabled = true;
        progressBox.hidden = false;
        barFill.style.width = '0%';
        status.textContent = STR.export.preparing;
        totalLine.hidden = true;
        try {
            const output = await buildExportZip({
                doc,
                cards,
                owner,
                yearSelections,
                binding,
                yearPages,
                types,
                cancelToken,
                onProgress: ({ done, total, label }) => {
                    barFill.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
                    status.textContent = `${STR.export.progress(done, total)} · ${label}`;
                },
            });
            running = false;
            closeButton.disabled = false;
            for (const input of Object.values(checks)) input.disabled = input.dataset.type ? rows.find((r) => r.type === input.dataset.type).count === 0 : false;
            totalLine.hidden = false;
            if (output.cancelled) {
                finishClose();
                return;
            }
            if (!output.blob) {
                status.textContent = STR.export.error('没有生成任何文件');
                resetFooter();
                return;
            }
            result = output;
            finished = true;
            saveBlob(doc, output.fileName, output.blob);
            barFill.style.width = '100%';
            status.textContent =
                STR.export.done(output.files.length + 1, formatBytes(output.blob.size)) +
                (output.failed.length > 0 ? ` · ${STR.export.failed(output.failed.length)}` : '');
            resetFooter();
        } catch (err) {
            running = false;
            closeButton.disabled = false;
            for (const input of Object.values(checks)) {
                const row = rows.find((r) => r.type === input.dataset.type);
                input.disabled = row ? row.count === 0 : false;
            }
            totalLine.hidden = false;
            status.textContent = STR.export.error(err?.message ?? String(err));
            resetFooter();
        }
    };

    const onKeyDown = (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        close();
    };

    cancelButton.addEventListener('click', () => {
        if (finished && !running) finishClose();
        else close();
    });
    actionButton.addEventListener('click', () => {
        if (finished && result?.blob) saveBlob(doc, result.fileName, result.blob);
        else start();
    });
    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', () => {
        if (!running) finishClose();
    });
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay && !running) finishClose();
    });
    overlay.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    for (const input of Object.values(checks)) input.addEventListener('change', refreshTotal);

    win.addEventListener('keydown', onKeyDown, true);
    resetFooter();
    actionButton.focus?.({ preventScroll: true });

    return { close };
}

export const __debug = { SIZES, collectCss, orderForBook, planAssets, fetchDataUrl, steamImageAlternates };
