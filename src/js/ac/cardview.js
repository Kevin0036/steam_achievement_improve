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
import { applyCoverEdit } from './coveredit.js';

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

/** 图片真实宽高比：取景框按它算「覆盖」所需的显示高度（见 card.css 的 height 公式）；
    顺便记下横版图片，背面的拉伸方式靠它避开横向压扁。 */
function trackArtRatio(img, fallback) {
    img.style.setProperty('--ac-art-ratio', String(fallback));
    const apply = () => {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return;
        img.style.setProperty('--ac-art-ratio', String(w / h));
        img.toggleAttribute('data-art-wide', w > h);
    };
    img.addEventListener('load', apply);
    if (img.complete) apply();
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
 * @param {object} card   { appid, name, total, rare, common, unrated, playtimeMin, completedAt, allSets, art: {hero, capsule, header} }
 *   allSets：本体和所有 DLC 成就集合都全成就，徽章换成蓝紫渐变那一枚（只完成本体时照旧是蓝色）
 * @param {object} ctx    { owner: {persona, avatar}, lite }
 *   lite：书签翻阅时飞过的卡。封面、文字都保留，只省掉星星和高光这些一闪而过看不出来的效果
 */
export function createCardFront(doc, card, ctx = {}) {
    const root = el(doc, 'div', 'ac-cf');
    if (card.allSets === true) root.dataset.sets = 'all';
    const inner = el(doc, 'div', 'ac-cf__inner');
    root.append(inner);

    // 插画：宽幅主视觉优先，没有就退到竖版封面 / 横幅
    const heroUrls = [...(card.art?.hero ?? []), ...(card.art?.capsule ?? []), ...(card.art?.header ?? [])];
    // 取景框固定住渐隐的范围，图片自己在框里缩放 / 平移
    const frame = el(doc, 'div', 'ac-cf__artframe');
    const art = artImage(doc, heroUrls, 'ac-cf__art');
    trackArtRatio(art, 3.1);
    frame.append(art);
    inner.append(frame);
    inner.append(el(doc, 'div', 'ac-cf__rays', { 'aria-hidden': 'true' }));
    if (!ctx.lite) inner.append(sparkles(doc, card.appid));
    inner.append(el(doc, 'div', 'ac-cf__badge', { role: 'img', 'aria-label': card.allSets === true ? STR.card.badgeAll : STR.card.badge }));

    const body = el(doc, 'div', 'ac-cf__body');
    body.append(el(doc, 'div', 'ac-cf__title', { text: `“${card.name}”` }));

    const perfect = el(doc, 'div', 'ac-cf__perfect');
    perfect.append(el(doc, 'i', 'ac-cf__laurel', { 'aria-hidden': 'true' }));
    perfect.append(el(doc, 'span', null, { text: STR.card.perfect }));
    perfect.append(el(doc, 'i', 'ac-cf__laurel ac-cf__laurel--r', { 'aria-hidden': 'true' }));
    body.append(perfect);

    const date = formatCardDate(card.completedAt);
    const owner = card.owner ?? ctx.owner ?? {};
    if (owner.persona || date) {
        const row = el(doc, 'div', 'ac-cf__owner');
        if (owner.avatar) row.append(artImage(doc, owner.avatar, 'ac-cf__avatar'));
        if (owner.persona) row.append(el(doc, 'span', 'ac-cf__persona', { text: owner.persona }));
        if (date) row.append(el(doc, 'time', 'ac-cf__date', { text: date, title: STR.card.dateTitle }));
        body.append(row);
    }

    // 本体和所有 DLC 集合都打满了：分割线中间嵌一行「全集合 日期」，占的高度和细线一样
    body.append(createSetsRule(doc, card) ?? el(doc, 'div', 'ac-cf__rule', { 'aria-hidden': 'true' }));
    body.append(createCardStats(doc, card));

    inner.append(body);

    // 悬停时跟随指针的反光（pointer-events: none）
    if (!ctx.lite) root.append(el(doc, 'div', 'ac-card__glare', { 'aria-hidden': 'true' }));
    applyCoverEdit(root, card.appid);
    return root;
}

/**
 * 蓝紫卡上「全集合 2026.11.04」那一行（DLC 成就集合全部打满的那天），顶替杯数上方的细线。
 * 不是蓝紫卡、或者还不知道日期时返回 null，照旧画细线。徽章翻新时 book.js 也用它。
 */
export function createSetsRule(doc, card) {
    const date = card?.allSets === true ? formatCardDate(card.sets?.allCompletedAt) : null;
    if (!date) return null;
    const row = el(doc, 'div', 'ac-cf__sets');
    row.append(el(doc, 'i', 'ac-cf__sets-line', { 'aria-hidden': 'true' }));
    const text = el(doc, 'span', 'ac-cf__sets-text', { title: STR.card.setsDateTitle });
    text.append(el(doc, 'b', null, { text: STR.card.setsLabel }), el(doc, 'time', null, { text: date }));
    row.append(text, el(doc, 'i', 'ac-cf__sets-line ac-cf__sets-line--r', { 'aria-hidden': 'true' }));
    return row;
}

/** 卡面底部的金杯 / 银杯 / 时长一栏。徽章翻新时整栏换成新的，再让数字一格格涨上去 */
export function createCardStats(doc, card) {
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
    return stats;
}

/**
 * 就地改写统计栏里的数字（不重建节点，数字跳动时卡面不闪）。
 * values 里没给的项不动；返回这次真的变了的那几格，方便调用方给它们做个跳动。
 */
export function setCardStats(stats, { rare, common, playtimeMin } = {}) {
    const changed = [];
    const write = (kind, text) => {
        const node = stats.querySelector(`.ac-cf__stat--${kind}`);
        const b = node?.querySelector('.ac-cf__num b');
        if (!b || b.textContent === text) return;
        b.textContent = text;
        const span = b.nextElementSibling;
        if (span && kind !== 'time') span.textContent = `/${text}`;
        changed.push(node);
    };
    if (Number.isFinite(rare)) write('gold', String(rare));
    if (Number.isFinite(common)) write('silver', String(common));
    if (Number.isFinite(playtimeMin)) {
        const hours = formatHours(playtimeMin);
        if (hours) write('time', hours);
    }
    return changed;
}

/* ── 背面 ────────────────────────────────────────────────────────────── */

/**
 * 竖版封面的 2 倍图：Valve CDN 上同一目录、扩展名前加 `_2x`
 * （library_600x900.jpg → library_600x900_2x.jpg，library_capsule_schinese.jpg → library_capsule_schinese_2x.jpg）。
 * 客户端本地缓存里只有 1 倍图，所以只从 CDN 地址推，排在原来的候选链前面；取不到就照旧退回 1 倍图。
 */
export function hiResCapsules(urls) {
    const out = [];
    for (const url of urls) {
        if (typeof url !== 'string' || !url.includes('/store_item_assets/') || /_2x\.\w+(\?|$)/.test(url)) continue;
        const next = url.replace(/(\.(?:jpg|jpeg|png|webp))(\?|$)/i, '_2x$1$2');
        if (next !== url && !out.includes(next)) out.push(next);
    }
    return out;
}

/**
 * @param {{lite?: boolean, hiRes?: boolean}} [options]
 *   lite   书签翻阅时飞过的简化叶：去掉高光，也不用 2 倍图
 *   hiRes  用不用 2 倍图（默认跟着 lite 反过来）。入册动画的替身卡背只露半秒，
 *          用本机缓存里的 1 倍图，开演前不用等网络
 */
export function createCardBack(doc, card, { lite = false, hiRes = !lite } = {}) {
    const root = el(doc, 'div', 'ac-cb');
    const inner = el(doc, 'div', 'ac-cb__inner');
    // 卡背用 2 倍图，大卡面上更清晰。书签翻阅时一闪而过的简化叶照旧用 1 倍图：
    // 那时空中叠着很多叶，2 倍图的解码量是 4 倍，核显会掉帧
    const base = card.art?.capsule ?? [];
    const capsule = hiRes ? [...hiResCapsules(base), ...base] : base;
    const rest = [...(card.art?.hero ?? []), ...(card.art?.header ?? [])];
    inner.append(capsuleImage(doc, capsule, rest, card.name));
    if (!lite) inner.append(el(doc, 'div', 'ac-cb__gloss', { 'aria-hidden': 'true' }));
    root.append(inner);
    if (!lite) root.append(el(doc, 'div', 'ac-card__glare', { 'aria-hidden': 'true' }));
    applyCoverEdit(root, card.appid);
    return root;
}

/**
 * 背面的竖版封面。加载出来之后体检一次（见 capsule.js）：
 *   · Steam 代生成的占位竖图（横版 header 贴在模糊背景上）→ 换成宽幅主视觉居中裁成竖版；
 *   · 自带一圈纯色边框 → 把边框裁掉。
 * 体检结论有缓存，第二次起在图片加载的同一刻就生效。
 */
function capsuleImage(doc, capsule, rest, alt) {
    const media = el(doc, 'div', 'ac-cb__media');

    // 已知是占位图的，直接不走竖版封面这条链
    if (capsule.some((url) => peekCapsule(doc, url) === PLACEHOLDER)) {
        const art = artImage(doc, rest, 'ac-cb__art', alt);
        trackArtRatio(art, 2 / 3);
        media.append(art);
        return media;
    }

    const img = artImage(doc, [...capsule, ...rest], 'ac-cb__art', alt);
    trackArtRatio(img, 2 / 3);
    const candidates = new Set(capsule.map((url) => absoluteUrl(doc, url)));

    const apply = (verdict) => {
        if (verdict === PLACEHOLDER) {
            const art = artImage(doc, rest, 'ac-cb__art', alt);
            trackArtRatio(art, 2 / 3);
            img.replaceWith(art);
        } else if (Array.isArray(verdict)) {
            trimFrame(img, verdict);
        }
    };

    img.addEventListener('load', () => {
        const url = img.currentSrc || img.src;
        // 已经退到主视觉 / 横幅了，就不是竖版封面，不用体检
        if (!url || !candidates.has(absoluteUrl(doc, url))) return;
        const known = peekCapsule(doc, url);
        if (known !== undefined) apply(known);
        else inspectCapsule(doc, url).then(apply);
    });
    media.append(img);
    return media;
}
