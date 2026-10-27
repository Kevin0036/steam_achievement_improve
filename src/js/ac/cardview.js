/**
 * 成就收藏册 · 卡片的 DOM
 *
 * 正面（参照参考图 4，去掉底部的小黑盒标识）自上而下：
 *   彩虹边框 → 宽幅插画（渐隐进卡面底色）→ 放射光 + 星芒 → 徽章
 *   → “游戏名” → 《完美通关》+ 月桂 → 头像 · 昵称 · 完成日期 → 分隔线
 *   → 金杯（稀有成就）· 银杯（普通成就）· 秒表（游玩时长）
 * 背面：同一圈彩虹边框，里面是游戏的竖版胶囊封面（不合规的封面会被换掉 / 裁边，见 capsule.js）。
 *
 * 纯 DOM、不依赖 React：预览页和 Steam 里的卡包页面用的是同一份代码。
 * 所有文案来自 strings.js；所有数字都来自真实数据，缺哪项就不画哪项，绝不编造。
 */

import STR from './strings.js';
import { PLACEHOLDER, absoluteUrl, inspectCapsule, peekCapsule, trimFrame } from './capsule.js';

/* ── 小工具 ──────────────────────────────────────────────────────────── */

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

/**
 * 按候选地址链加载图片：前一个失败就换下一个，全部失败时打上 data-missing，
 * 由 CSS 显示占位底色（而不是一个破图标）。
 */
export function artImage(doc, urls, className, alt = '') {
    const list = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    const img = el(doc, 'img', className, { alt, draggable: 'false', decoding: 'async' });
    let i = 0;
    const next = () => {
        if (i >= list.length) {
            img.removeAttribute('src');
            img.dataset.missing = '';
            return;
        }
        img.src = list[i];
        i += 1;
    };
    img.addEventListener('error', next);
    next();
    return img;
}

/** 依 appid 决定的伪随机数：同一张卡每次打开星芒位置都一样 */
function seeded(seed) {
    let t = seed >>> 0;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
}

export function formatCardDate(unixSeconds) {
    if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
    const d = new Date(unixSeconds * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function formatHours(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const hours = minutes / 60;
    return hours >= 100 ? `${Math.round(hours)}h` : `${hours.toFixed(1)}h`;
}

export function formatSerial(n) {
    return `No.${String(n).padStart(3, '0')}`;
}

/** 一页里有多张卡时，编号写成区间：No.097–100 */
export function formatSerialRange(from, to) {
    if (from === to) return formatSerial(from);
    return `No.${String(from).padStart(3, '0')}–${String(to).padStart(3, '0')}`;
}

/* ── 正面 ────────────────────────────────────────────────────────────── */

/** 徽章周围的三颗大星芒：x%、y%、宽度（cqw）、动画延迟（秒） */
export const BIG_SPARKS = [
    [68.5, 21, 6.2, 0],
    [72, 28.5, 4.2, 0.9],
    [29.5, 35, 6.6, 1.7],
];

/** 徽章周围的三颗大星芒（位置照参考图 4），外加一把细碎的小星点 */
function sparkles(doc, appid) {
    const box = el(doc, 'div', 'ac-cf__sparkles', { 'aria-hidden': 'true' });
    for (const [x, y, size, delay] of BIG_SPARKS) {
        box.append(
            el(doc, 'i', 'ac-cf__spark', {
                style: `left:${x}%;top:${y}%;width:${size}cqw;animation-delay:${delay}s`,
            }),
        );
    }
    const rand = seeded(appid);
    for (let i = 0; i < 16; i += 1) {
        const x = 6 + rand() * 88;
        const y = 34 + rand() * 60;
        // 别压在徽章正中
        if (Math.abs(x - 50) < 16 && y < 50) continue;
        const size = 0.9 + rand() * 1.3;
        box.append(
            el(doc, 'i', 'ac-cf__spark ac-cf__spark--dust', {
                style:
                    `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;width:${size.toFixed(2)}cqw;` +
                    `animation-delay:${(rand() * 4).toFixed(2)}s`,
            }),
        );
    }
    return box;
}

function stat(doc, kind, value, denominator, label) {
    const node = el(doc, 'div', `ac-cf__stat ac-cf__stat--${kind}`, { title: label });
    node.append(el(doc, 'i', 'ac-cf__icon', { 'aria-hidden': 'true' }));
    const num = el(doc, 'div', 'ac-cf__num');
    num.append(el(doc, 'b', null, { text: value }));
    if (denominator != null) num.append(el(doc, 'span', null, { text: `/${denominator}` }));
    node.append(num);
    node.append(el(doc, 'span', 'ac-sr-only', { text: label }));
    return node;
}

/**
 * @param {Document} doc
 * @param {object} card   { appid, name, total, rare, common, unrated, playtimeMin, completedAt, art: {hero, capsule, header} }
 * @param {object} ctx    { owner: {persona, avatar} }
 */
export function createCardFront(doc, card, ctx = {}) {
    const root = el(doc, 'div', 'ac-cf');
    const inner = el(doc, 'div', 'ac-cf__inner');
    root.append(inner);

    // 插画：宽幅主视觉优先，没有就退到竖版封面 / 横幅
    const heroUrls = [...(card.art?.hero ?? []), ...(card.art?.capsule ?? []), ...(card.art?.header ?? [])];
    inner.append(artImage(doc, heroUrls, 'ac-cf__art'));
    inner.append(el(doc, 'div', 'ac-cf__rays', { 'aria-hidden': 'true' }));
    inner.append(sparkles(doc, card.appid));
    inner.append(el(doc, 'div', 'ac-cf__badge', { role: 'img', 'aria-label': STR.card.badge }));

    const body = el(doc, 'div', 'ac-cf__body');
    body.append(el(doc, 'div', 'ac-cf__title', { text: `“${card.name}”` }));

    const perfect = el(doc, 'div', 'ac-cf__perfect');
    perfect.append(el(doc, 'i', 'ac-cf__laurel', { 'aria-hidden': 'true' }));
    perfect.append(el(doc, 'span', null, { text: STR.card.perfect }));
    perfect.append(el(doc, 'i', 'ac-cf__laurel ac-cf__laurel--r', { 'aria-hidden': 'true' }));
    body.append(perfect);

    const date = formatCardDate(card.completedAt);
    const owner = ctx.owner ?? {};
    if (owner.persona || date) {
        const row = el(doc, 'div', 'ac-cf__owner');
        if (owner.avatar) row.append(artImage(doc, owner.avatar, 'ac-cf__avatar'));
        if (owner.persona) row.append(el(doc, 'span', 'ac-cf__persona', { text: owner.persona }));
        if (date) row.append(el(doc, 'time', 'ac-cf__date', { text: date, title: STR.card.dateTitle }));
        body.append(row);
    }

    body.append(el(doc, 'div', 'ac-cf__rule', { 'aria-hidden': 'true' }));

    const stats = el(doc, 'div', 'ac-cf__stats');
    const total = card.total;
    const rare = Number.isFinite(card.rare) ? card.rare : 0;
    const common = Number.isFinite(card.common)
        ? card.common
        : Number.isFinite(card.rare) && Number.isFinite(total)
          ? Math.max(0, total - rare)
          : 0;
    if (rare > 0) stats.append(stat(doc, 'gold', String(rare), rare, STR.card.rare(rare)));
    if (common > 0) stats.append(stat(doc, 'silver', String(common), common, STR.card.common(common)));
    const hours = formatHours(card.playtimeMin);
    if (hours) stats.append(stat(doc, 'time', hours, null, STR.card.playtime(hours)));
    stats.dataset.count = String(stats.children.length);
    body.append(stats);

    inner.append(body);

    // 悬停时跟随指针的反光（pointer-events: none）
    root.append(el(doc, 'div', 'ac-card__glare', { 'aria-hidden': 'true' }));
    return root;
}

/* ── 背面 ────────────────────────────────────────────────────────────── */

export function createCardBack(doc, card) {
    const root = el(doc, 'div', 'ac-cb');
    const inner = el(doc, 'div', 'ac-cb__inner');
    const capsule = card.art?.capsule ?? [];
    const rest = [...(card.art?.hero ?? []), ...(card.art?.header ?? [])];
    inner.append(capsuleImage(doc, capsule, rest, card.name));
    inner.append(el(doc, 'div', 'ac-cb__gloss', { 'aria-hidden': 'true' }));
    root.append(inner);
    root.append(el(doc, 'div', 'ac-card__glare', { 'aria-hidden': 'true' }));
    return root;
}

/**
 * 背面的竖版封面。加载出来之后体检一次（见 capsule.js）：
 *   · Steam 代生成的占位竖图（横版 header 贴在模糊背景上）→ 换成宽幅主视觉居中裁成竖版；
 *   · 自带一圈纯色边框 → 把边框裁掉。
 * 体检结论有缓存，第二次起在图片加载的同一刻就生效。
 */
function capsuleImage(doc, capsule, rest, alt) {
    // 已知是占位图的，直接不走竖版封面这条链
    if (capsule.some((url) => peekCapsule(doc, url) === PLACEHOLDER)) {
        return artImage(doc, rest, 'ac-cb__art', alt);
    }

    const img = artImage(doc, [...capsule, ...rest], 'ac-cb__art', alt);
    const candidates = new Set(capsule.map((url) => absoluteUrl(doc, url)));

    const apply = (verdict) => {
        if (verdict === PLACEHOLDER) img.replaceWith(artImage(doc, rest, 'ac-cb__art', alt));
        else if (Array.isArray(verdict)) trimFrame(img, verdict);
    };

    img.addEventListener('load', () => {
        const url = img.currentSrc || img.src;
        // 已经退到主视觉 / 横幅了，就不是竖版封面，不用体检
        if (!url || !candidates.has(absoluteUrl(doc, url))) return;
        const known = peekCapsule(doc, url);
        if (known !== undefined) apply(known);
        else inspectCapsule(doc, url).then(apply);
    });
    return img;
}
