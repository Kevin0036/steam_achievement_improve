/**
 * 成就收藏册 · 年份特殊页
 *
 * 每一年在册子里插入一张手账（同一叶的正反两面）：
 *   · 正面「年份页」：手写年份 + 红色橡皮章 + 年度数据；三枚徽章邮票插在集邮册的透明插袋里，
 *     邮戳是这款游戏的完成日期（徽章可选普通 1–5 级 / 闪亮徽章）；
 *   · 背面「年度最爱」：三张票根放游戏横幅，第 1 名的存根上压一枚红章。
 * 两页不会同时摊开，翻过这一叶才看得到背面。
 *
 * 槽位由用户点选，选择写进 cache.js 的 yearpages；徽章图案来自 badges.js。
 * 这一文件只负责画页面与选择器，不知道翻页结构（那在 book.js 里）。
 */

import { artImage, formatCardDate } from './cardview.js';
import { badgeOptions, levelLabel, loadBadge, peekBadge } from './badges.js';
import { STR } from './strings.js';

const SLOTS = 3;

const YEAR_TEXT = STR.year;

const SVG_NS = 'http://www.w3.org/2000/svg';
const ART_BASE = 'https://shared.steamstatic.com/store_item_assets/steam/apps/';

function el(doc, tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (value == null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else node.setAttribute(key, value === true ? '' : String(value));
        }
    }
    return node;
}

function svgEl(doc, tag, attrs = {}, text = null) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    if (text != null) node.textContent = text;
    return node;
}

/** 完成时间 → 年份键。没有完成日期的归入 'unknown'（排在最前，不插年份页）。 */
export function yearKeyOf(card) {
    const t = Number(card?.completedAt);
    if (!Number.isFinite(t) || t <= 0) return 'unknown';
    const year = new Date(t * 1000).getFullYear();
    return Number.isFinite(year) ? String(year) : 'unknown';
}

export function isYearKey(key) {
    return key !== 'unknown' && /^\d{4}$/.test(String(key));
}

export function yearLabel(key) {
    return isYearKey(key) ? String(key) : YEAR_TEXT.unknownYear;
}

/** 统一成 3 个槽；坏数据只丢那一项 */
export function normalizeSelection(raw) {
    const selection = { badges: [], banners: [] };
    const appidOf = (value) => {
        if (value == null || value === '') return null;
        const appid = Number(value);
        return Number.isFinite(appid) ? appid : null;
    };
    for (let i = 0; i < SLOTS; i += 1) {
        const badge = raw?.badges?.[i];
        const badgeAppid = appidOf(badge?.appid);
        selection.badges.push(badgeAppid == null ? null : { appid: badgeAppid, level: badge.level ?? 5 });
        selection.banners.push(appidOf(raw?.banners?.[i]));
    }
    return selection;
}

/* ── 页面共用的零件 ─────────────────────────────────────────────────────── */

/** 这一年的合计：款数、成就数、稀有成就、游玩时长 */
function yearStats(games) {
    let achievements = 0;
    let rare = 0;
    let minutes = 0;
    let rareKnown = false;
    let timeKnown = false;
    for (const game of games) {
        if (Number.isFinite(game.total)) achievements += game.total;
        if (Number.isFinite(game.rare)) {
            rare += game.rare;
            rareKnown = true;
        }
        if (Number.isFinite(game.playtimeMin) && game.playtimeMin > 0) {
            minutes += game.playtimeMin;
            timeKnown = true;
        }
    }
    return {
        count: games.length,
        achievements,
        rare: rareKnown ? rare : null,
        hours: timeKnown ? Math.round(minutes / 60) : null,
    };
}

function pickedBadges(selection, byId) {
    return selection.badges.map((picked) => {
        const game = picked ? byId.get(Number(picked.appid)) ?? null : null;
        return { game, level: game ? picked.level : null };
    });
}

function pickedBanners(selection, byId) {
    return selection.banners.map((appid) => (appid ? byId.get(Number(appid)) ?? null : null));
}

function badgeImageCard(game, level) {
    const data = peekBadge(game.appid);
    if (level === 'cover') return game.art?.capsule ?? game.art?.hero ?? [];
    const key = level === 'foil' ? 'foil' : String(level);
    const url = data?.levels?.[key]?.url;
    if (url) return [url];
    if (data?.current && Number(data.current.level) === Number(level)) return [data.current.url];
    return game.art?.capsule ?? game.art?.hero ?? [];
}

function badgeNode(doc, game, level, className) {
    const key = level === 'foil' ? 'foil' : String(level);
    const peek = level === 'cover' ? null : peekBadge(game.appid);
    const hasArt = !!peek?.levels?.[key]?.url || (peek?.current && Number(peek.current.level) === Number(level));
    const img = artImage(doc, badgeImageCard(game, level), className, game.name);
    if (!hasArt) img.dataset.cover = '';
    // 定义晚到：先用封面顶着，等 loadBadge 回来再换成真正的等级图案
    if (level !== 'cover' && !peek?.levels?.[key]?.url) {
        loadBadge(game.appid).then((loaded) => {
            const url = loaded?.levels?.[key]?.url;
            if (!url || !img.isConnected) return;
            delete img.dataset.cover;
            delete img.dataset.missing;
            img.src = url;
        });
    }
    return img;
}

/** 库里的游戏标志（透明 PNG）；没有 art.logo 的旧缓存 / 预览数据按约定路径找 */
function logoUrls(game) {
    if (Array.isArray(game.art?.logo) && game.art.logo.length > 0) return game.art.logo;
    return [`/assets/${game.appid}/logo.png`, `${ART_BASE}${game.appid}/logo.png`];
}

/** 标志图 + 取不到时顶上的游戏名（CSS 按 img[data-missing] 切换） */
function logoNode(doc, game) {
    const box = el(doc, 'span', 'ac-year__logo', { 'aria-hidden': 'true' });
    box.append(artImage(doc, logoUrls(game), 'ac-year__logo-img', ''));
    box.append(el(doc, 'span', 'ac-year__logo-text', { text: game.name }));
    return box;
}

/** 槽位按钮：点开这一年的选择器 */
function slotButton(doc, className, { kind, index, game, onPick, rot = null, rank = null }) {
    const filled = !!game;
    let label;
    if (kind === 'badge') label = filled ? YEAR_TEXT.changeBadge(game.name) : YEAR_TEXT.pickBadge;
    else label = filled ? YEAR_TEXT.changeBanner(game.name) : YEAR_TEXT.pickBanner;
    if (rank != null) label = `${YEAR_TEXT.rankAria(rank)} · ${label}`;
    const button = el(doc, 'button', `${className}${filled ? '' : ' is-empty'}`, {
        type: 'button',
        'data-slot': String(index),
        'data-rank': rank == null ? null : String(rank),
        'aria-label': label,
    });
    if (rot != null) button.style.setProperty('--rot', `${rot}deg`);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onPick(kind, index);
    });
    return button;
}

function plus(doc) {
    return el(doc, 'span', 'ac-year__plus', { text: '+', 'aria-hidden': 'true' });
}

let svgSeq = 0;

/** 红色橡皮章：一圈字 + 中间的主字 + 一行小字 */
function rubberStamp(doc, { ring: ringText, main, unit }, modifier) {
    const wrap = el(doc, 'span', `ac-year__seal ac-year__seal--${modifier}`, { 'aria-hidden': 'true' });
    const svg = svgEl(doc, 'svg', { viewBox: '0 0 120 120' });
    svgSeq += 1;
    const id = `ac-year-ring-${svgSeq}`;
    const defs = svgEl(doc, 'defs');
    defs.append(svgEl(doc, 'path', { id, d: 'M60,60 m-45,0 a45,45 0 1,1 90,0 a45,45 0 1,1 -90,0' }));
    svg.append(defs);
    svg.append(svgEl(doc, 'circle', { cx: 60, cy: 60, r: 57, fill: 'none', stroke: 'currentColor', 'stroke-width': 3.2 }));
    svg.append(svgEl(doc, 'circle', { cx: 60, cy: 60, r: 34, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.6 }));
    const ring = svgEl(doc, 'text', { class: 'ring' });
    ring.append(svgEl(doc, 'textPath', { href: `#${id}`, textLength: 278, lengthAdjust: 'spacing' }, ringText));
    svg.append(ring);
    svg.append(svgEl(doc, 'text', { class: 'main', x: 60, y: 66, 'text-anchor': 'middle' }, main));
    svg.append(svgEl(doc, 'text', { class: 'unit', x: 60, y: 81, 'text-anchor': 'middle' }, unit));
    wrap.append(svg);
    return wrap;
}

/* ── 正面：年份页 ───────────────────────────────────────────────────────── */

/** 年度数据：银杯 = 解锁成就，金杯 = 稀有成就，秒表 = 游玩时长 */
function statsRow(doc, stats) {
    const row = el(doc, 'div', 'ac-year__stats');
    const cells = [
        ['silver', stats.achievements, YEAR_TEXT.statAchievements],
        ['gold', stats.rare, YEAR_TEXT.statRare],
        ['time', stats.hours == null ? null : `${stats.hours}h`, YEAR_TEXT.statHours],
    ];
    cells.forEach(([kind, value, label], i) => {
        if (i > 0) row.append(el(doc, 'i', 'ac-year__sep', { 'aria-hidden': 'true' }));
        const cell = el(doc, 'div', `ac-year__stat ac-year__stat--${kind}`);
        const main = el(doc, 'div', 'ac-year__stat-main');
        main.append(el(doc, 'i', 'ac-year__icon', { 'aria-hidden': 'true' }));
        main.append(el(doc, 'b', null, { text: value == null ? '—' : String(value) }));
        cell.append(main, el(doc, 'span', 'ac-year__stat-label', { text: label }));
        row.append(cell);
    });
    return row;
}

/** 邮戳：几道波浪注销线横过票顶，圆戳压在票的右上角，戳里是完成日期 */
function postmark(doc, date) {
    const wrap = el(doc, 'span', 'ac-year__postmark', { 'aria-hidden': 'true' });
    const svg = svgEl(doc, 'svg', { viewBox: '0 0 132 64' });
    for (let i = 0; i < 3; i += 1) {
        svg.append(svgEl(doc, 'path', {
            d: `M2 ${22 + i * 10} q 8 -5 16 0 t 16 0 t 16 0 t 16 0`,
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': 2.2,
            'stroke-linecap': 'round',
        }));
    }
    svg.append(svgEl(doc, 'circle', { cx: 100, cy: 32, r: 29, fill: 'none', stroke: 'currentColor', 'stroke-width': 2.4 }));
    svg.append(svgEl(doc, 'circle', { cx: 100, cy: 32, r: 22.5, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.1 }));
    const [y, m, d] = date.split('.');
    svg.append(svgEl(doc, 'text', { x: 100, y: 30, 'text-anchor': 'middle', class: 'y' }, y));
    svg.append(svgEl(doc, 'text', { x: 100, y: 43, 'text-anchor': 'middle', class: 'md' }, `${m}.${d}`));
    wrap.append(svg);
    return wrap;
}

/**
 * 一枚徽章邮票（齿孔 + 票面 + 徽章）。页面和印刷导出共用。
 * 票面不印等级；闪亮徽章多一层镭射光泽。
 */
export function createBadgeStamp(doc, game, level) {
    const stamp = el(doc, 'span', 'ac-year__stamp');
    const perf = el(doc, 'span', 'ac-year__perf');
    const face = el(doc, 'span', 'ac-year__stamp-face');
    if (game) {
        face.append(badgeNode(doc, game, level, 'ac-year__badge'));
        if (level === 'foil') face.append(el(doc, 'span', 'ac-year__holo', { 'aria-hidden': 'true' }));
    } else {
        face.append(plus(doc));
    }
    perf.append(face);
    stamp.append(perf);
    return stamp;
}

/**
 * 三枚徽章邮票，插在一条横贯页面的透明插袋里。
 */
function badgeAlbum(doc, badges, onPick) {
    const album = el(doc, 'div', 'ac-year__album');
    const mounts = el(doc, 'div', 'ac-year__mounts');
    const rots = [-2.4, 1.6, -1.2];
    badges.forEach(({ game, level }, i) => {
        const button = slotButton(doc, 'ac-year__mount', { kind: 'badge', index: i, game, onPick, rot: rots[i] });
        button.append(createBadgeStamp(doc, game, level));
        const date = game ? formatCardDate(game.completedAt) : null;
        if (date) button.append(postmark(doc, date));
        button.append(el(doc, 'span', 'ac-year__cap', { text: game ? game.name : YEAR_TEXT.pickBadge }));
        mounts.append(button);
    });
    mounts.append(el(doc, 'span', 'ac-year__sleeve', { 'aria-hidden': 'true' }));
    album.append(mounts);
    return album;
}

function yearPage(doc, { year, stats, badges, onPick }) {
    const page = el(doc, 'div', 'ac-year__page');
    page.append(el(doc, 'div', 'ac-year__kicker', { text: YEAR_TEXT.eyebrow }));
    page.append(rubberStamp(doc, YEAR_TEXT.yearSeal(year, stats.count), 'year'));

    const yearBox = el(doc, 'div', 'ac-year__year', { 'aria-label': YEAR_TEXT.yearAria(year) });
    yearBox.append(el(doc, 'span', 'ac-year__swash', { 'aria-hidden': 'true' }));
    yearBox.append(el(doc, 'span', 'ac-year__digits', { text: year }));
    page.append(yearBox);

    page.append(statsRow(doc, stats));
    page.append(badgeAlbum(doc, badges, onPick));

    const deco = el(doc, 'div', 'ac-year__deco', { 'aria-hidden': 'true' });
    for (const name of ['a', 'b']) deco.append(el(doc, 'i', `ac-year__spark ac-year__spark--${name}`));
    page.append(deco);
    return page;
}

/* ── 背面：年度最爱 ─────────────────────────────────────────────────────── */

/** 页眉：左边小标题 — 细线 — 右边年份 */
function headRow(doc, left, right) {
    const head = el(doc, 'div', 'ac-year__head');
    head.append(el(doc, 'span', 'ac-year__head-kicker', { text: left }));
    head.append(el(doc, 'i', 'ac-year__head-rule', { 'aria-hidden': 'true' }));
    head.append(el(doc, 'span', 'ac-year__head-tag', { text: right }));
    return head;
}

/** 票身：左边是横幅 + 游戏标志，右边米色存根写名次、游戏名和完成日期 */
function ticketBody(doc, game, index) {
    const body = el(doc, 'span', 'ac-year__ticket-body');
    const main = el(doc, 'span', 'ac-year__ticket-main');
    if (game) {
        main.append(artImage(doc, game.art?.hero ?? game.art?.header ?? [], 'ac-year__ticket-img', ''));
        main.append(el(doc, 'span', 'ac-year__ticket-shade', { 'aria-hidden': 'true' }));
        main.append(logoNode(doc, game));
    } else {
        main.append(plus(doc));
        main.append(el(doc, 'span', 'ac-year__ticket-empty', { text: YEAR_TEXT.pickBanner }));
    }
    const stub = el(doc, 'span', 'ac-year__stub');
    stub.append(el(doc, 'b', 'ac-year__stub-rank', { text: String(index + 1).padStart(2, '0') }));
    stub.append(el(doc, 'span', 'ac-year__stub-name', { text: game ? game.name : YEAR_TEXT.bannerHint }));
    const date = game ? formatCardDate(game.completedAt) : null;
    if (date) stub.append(el(doc, 'em', 'ac-year__stub-date', { text: date }));
    body.append(main, stub);
    return body;
}

/** 一张票（可点选槽位）。 */
function ticket(doc, game, index, onPick) {
    const rots = [-1.1, 0.9, -0.5];
    const button = slotButton(doc, 'ac-year__ticket', { kind: 'banner', index, game, onPick, rot: rots[index], rank: index + 1 });
    button.append(ticketBody(doc, game, index));
    return button;
}

/** 印刷导出的票根：不带旋转、阴影和点击行为，票身与页面完全同一套 DOM。 */
export function createTicketStub(doc, game, index) {
    const stub = el(doc, 'div', 'ac-year__ticket', {
        'data-slot': String(index),
        'data-rank': String(index + 1),
        'data-print': '',
    });
    stub.append(ticketBody(doc, game, index));
    return stub;
}

function annualPage(doc, { year, banners, onPick }) {
    const page = el(doc, 'div', 'ac-year__page');
    page.append(headRow(doc, YEAR_TEXT.annualEyebrow, year));
    page.append(el(doc, 'div', 'ac-year__title', { text: YEAR_TEXT.annualTitle }));
    page.append(el(doc, 'div', 'ac-year__sub', { text: YEAR_TEXT.annualSub }));

    const list = el(doc, 'div', 'ac-year__tickets');
    banners.forEach((game, i) => list.append(ticket(doc, game, i, onPick)));
    // 第 1 名的存根上压一枚红章，一半盖在存根上（只有填了第 1 名才盖）
    if (banners[0]) list.append(rubberStamp(doc, YEAR_TEXT.annualSeal(year), 'fav'));
    page.append(list);
    return page;
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

/**
 * 一张年份 / 年度最爱页面。
 *
 * @param {Document} doc
 * @param {object} options
 * @param {'year'|'annual'} options.mode 年份徽章页（year）或年度最爱横幅页（annual）
 * @param {string} options.yearKey
 * @param {Array} options.games 这一年的全成就游戏
 * @param {object} options.selection normalizeSelection() 的结果
 * @param {(mode:'badge'|'banner', slot:number)=>void} options.onPick
 */
export function createYearPage(doc, { mode, yearKey, games, selection = normalizeSelection(null), onPick }) {
    const year = yearLabel(yearKey);
    const root = el(doc, 'div', `ac-year ac-year--${mode}`, { 'data-year': yearKey, 'data-mode': mode });
    const byId = new Map(games.map((card) => [card.appid, card]));
    if (mode === 'year') {
        root.append(yearPage(doc, { year, stats: yearStats(games), badges: pickedBadges(selection, byId), onPick }));
    } else {
        root.append(annualPage(doc, { year, banners: pickedBanners(selection, byId), onPick }));
    }
    return root;
}

/* ── 选择器 ─────────────────────────────────────────────────────────────── */

function stop(event) {
    event.preventDefault();
    event.stopPropagation();
}

function hasBadgeLevels(data) {
    return !!data?.levels && Object.values(data.levels).some((item) => item?.url);
}

function gameTile(doc, game, { mode, selection, slot, onChoose, badgeState }) {
    const tile = el(doc, 'button', 'ac-year-picker__game', { type: 'button' });
    const thumb = el(doc, 'span', 'ac-year-picker__thumb');
    thumb.append(artImage(doc, mode === 'badge' ? game.art?.capsule ?? game.art?.hero : game.art?.hero ?? game.art?.header, 'ac-year-picker__thumb-img', game.name));
    tile.append(thumb);
    const meta = el(doc, 'span', 'ac-year-picker__game-meta');
    meta.append(el(doc, 'b', null, { text: game.name }));
    const date = formatCardDate(game.completedAt);
    if (date) meta.append(el(doc, 'i', null, { text: date }));
    tile.append(meta);

    const usedBadge = selection.badges.some((item) => Number(item?.appid) === game.appid);
    const usedBanner = selection.banners.some((appid) => Number(appid) === game.appid);
    if (mode === 'badge' && usedBadge) tile.append(el(doc, 'span', 'ac-year-picker__used', { text: YEAR_TEXT.usedMark }));
    if (mode === 'banner' && usedBanner) tile.append(el(doc, 'span', 'ac-year-picker__used', { text: YEAR_TEXT.usedMark }));
    if (mode === 'badge' && badgeState === 'no') {
        tile.classList.add('has-nobadge');
        tile.append(
            el(doc, 'span', 'ac-year-picker__nobadge', {
                text: YEAR_TEXT.noBadgeMark,
                title: YEAR_TEXT.noBadgeHint,
            }),
        );
    }

    tile.addEventListener('click', (event) => {
        stop(event);
        if (mode === 'banner') {
            onChoose(game, 'cover');
            return;
        }
        showBadgeLevels({ doc, game, slot, selection, onChoose, panel: tile.closest('.ac-year-picker__panel') });
    });
    return tile;
}

function levelButton(doc, game, option, selected, onChoose) {
    const button = el(doc, 'button', `ac-year-picker__level${selected ? ' is-selected' : ''}${option.level === 'foil' ? ' is-foil' : ''}`, {
        type: 'button',
        'data-level': String(option.level),
        'aria-label': `${game.name} ${levelLabel(option.level)}`,
    });
    const disc = el(doc, 'span', 'ac-year-picker__level-disc');
    disc.append(artImage(doc, [option.url], 'ac-year-picker__level-img', option.name || game.name));
    button.append(disc);
    const cap = el(doc, 'span', 'ac-year-picker__level-cap');
    cap.append(el(doc, 'b', null, { text: levelLabel(option.level) }));
    if (option.name) cap.append(el(doc, 'i', null, { text: option.name }));
    button.append(cap);
    button.addEventListener('click', (event) => {
        stop(event);
        onChoose(game, option.level);
    });
    return button;
}

/**
 * 展开一款游戏的徽章等级。定义不在客户端缓存里时先显示“正在读取”，
 * 期间仍然可以直接选「用封面代替」，不会把用户卡死在加载上。
 */
function showBadgeLevels({ doc, game, slot, selection, onChoose, panel }) {
    if (!panel) return;
    // 等级面板必须画在游戏列表里：整块 body 换掉会把搜索框和列表一起摘下来，
    // “换一款游戏”回来时就没有容器可填了。
    const scroll = panel.querySelector('.ac-year-picker__list');
    if (!scroll) return;
    panel.dataset.view = 'levels';

    const wrap = el(doc, 'div', 'ac-year-picker__levels');
    const back = el(doc, 'button', 'ac-year-picker__back', { type: 'button', text: YEAR_TEXT.backToGames });
    back.addEventListener('click', (event) => {
        stop(event);
        panel.dispatchEvent(new CustomEvent('ac:year-picker-back'));
    });
    wrap.append(back);

    const head = el(doc, 'div', 'ac-year-picker__levels-head');
    const thumb = el(doc, 'span', 'ac-year-picker__levels-thumb');
    thumb.append(artImage(doc, game.art?.capsule ?? game.art?.hero, 'ac-year-picker__levels-img', game.name));
    head.append(thumb);
    const who = el(doc, 'div', 'ac-year-picker__levels-who');
    who.append(el(doc, 'b', null, { text: game.name }));
    who.append(el(doc, 'i', null, { text: formatCardDate(game.completedAt) ?? '' }));
    head.append(who);
    wrap.append(head);

    const optionsBox = el(doc, 'div', 'ac-year-picker__level-options');
    const status = el(doc, 'p', 'ac-year-picker__status', { text: YEAR_TEXT.loadingBadges });
    wrap.append(status, optionsBox);

    const current = selection.badges[slot];
    const selectedLevel = Number(current?.appid) === game.appid ? current?.level : null;
    const draw = (data) => {
        const options = badgeOptions(data);
        status.remove();
        optionsBox.replaceChildren();
        for (const option of options) {
            optionsBox.append(levelButton(doc, game, option, option.level === selectedLevel, onChoose));
        }
        const cover = {
            level: 'cover',
            url: game.art?.capsule?.[0] ?? game.art?.hero?.[0] ?? '',
            name: YEAR_TEXT.coverOption,
        };
        optionsBox.append(levelButton(doc, game, cover, selectedLevel === 'cover', onChoose));
        if (options.length === 0) {
            optionsBox.prepend(el(doc, 'p', 'ac-year-picker__status', { text: YEAR_TEXT.noBadgeData }));
        }
    };

    const early = peekBadge(game.appid);
    if (early && Object.keys(early.levels ?? {}).length > 0) draw(early);
    loadBadge(game.appid).then((data) => {
        if (!wrap.isConnected) return;
        draw(data);
    });

    scroll.replaceChildren(wrap);
    const body = panel.querySelector('.ac-year-picker__body');
    if (body) body.scrollTop = 0;
}

function buildGameGrid({ doc, mode, games, selection, slot, onChoose, filter, badgeStates }) {
    const grid = el(doc, 'div', 'ac-year-picker__games');
    const query = String(filter ?? '').trim().toLowerCase();
    // 有徽章图案的排前面，还在确认的居中，确定没有图案的排最后
    const rank = (game) => {
        if (mode !== 'badge') return 0;
        const state = badgeStates?.get(game.appid);
        return state === 'yes' ? 0 : state === 'no' ? 2 : 1;
    };
    const ordered =
        mode === 'badge'
            ? games
                  .map((game, index) => ({ game, index }))
                  .sort((a, b) => rank(a.game) - rank(b.game) || a.index - b.index)
                  .map((entry) => entry.game)
            : games;
    const shown = query ? ordered.filter((game) => game.name.toLowerCase().includes(query)) : ordered;
    if (shown.length === 0) {
        grid.append(el(doc, 'p', 'ac-year-picker__empty', { text: YEAR_TEXT.noGames }));
        return grid;
    }
    for (const game of shown) {
        grid.append(gameTile(doc, game, { mode, selection, slot, onChoose, badgeState: badgeStates?.get(game.appid) }));
    }
    return grid;
}

/**
 * 打开某一年的选择器。
 *
 * @param {object} options
 * @param {Document} options.doc
 * @param {HTMLElement} options.host 挂载点（.ac-album）
 * @param {'badge'|'banner'} options.mode
 * @param {string} options.yearKey
 * @param {Array} options.games
 * @param {object} options.selection
 * @param {number} [options.slot] 从哪个槽位打开（0–2）
 * @param {(next: object) => void} options.onChange 已确认的新选择（3 个槽）
 * @param {() => void} [options.onClose]
 * @returns {{ close: () => void }}
 */
export function openYearPicker({ doc, host, mode, yearKey, games, selection, slot = 0, onChange, onClose }) {
    const win = doc.defaultView;
    const year = yearLabel(yearKey);
    const overlay = el(doc, 'div', 'ac-year-picker', {
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': mode === 'badge' ? YEAR_TEXT.pickerBadgeTitle(year) : YEAR_TEXT.pickerBannerTitle(year),
        'data-mode': mode,
    });
    const backdrop = el(doc, 'div', 'ac-year-picker__backdrop', { 'aria-hidden': 'true' });
    const panel = el(doc, 'div', 'ac-year-picker__panel');
    const header = el(doc, 'header', 'ac-year-picker__header');
    const titles = el(doc, 'div', 'ac-year-picker__titles');
    titles.append(el(doc, 'b', null, { text: mode === 'badge' ? YEAR_TEXT.pickerBadgeTitle(year) : YEAR_TEXT.pickerBannerTitle(year) }));
    titles.append(el(doc, 'span', null, { text: mode === 'badge' ? YEAR_TEXT.pickerBadgeDesc : YEAR_TEXT.pickerBannerDesc }));
    const closeButton = el(doc, 'button', 'ac-year-picker__close', { type: 'button', 'aria-label': YEAR_TEXT.close, text: '×' });
    header.append(titles, closeButton);

    const body = el(doc, 'div', 'ac-year-picker__body');
    const search = el(doc, 'input', 'ac-year-picker__search', {
        type: 'search',
        placeholder: YEAR_TEXT.searchPlaceholder,
        'aria-label': YEAR_TEXT.searchPlaceholder,
    });
    const listWrap = el(doc, 'div', 'ac-year-picker__list');
    body.append(search, listWrap);
    panel.append(header, body);
    overlay.append(backdrop, panel);
    host.append(overlay);

    let closed = false;
    let filter = '';
    const next = normalizeSelection(selection);
    const targetSlot = Math.max(0, Math.min(SLOTS - 1, Math.trunc(Number(slot)) || 0));
    /** appid → 'yes' | 'unknown' | 'no'：用于排序和“无徽章”角标 */
    const badgeStates = new Map();
    if (mode === 'badge') {
        for (const game of games) {
            badgeStates.set(game.appid, hasBadgeLevels(peekBadge(game.appid)) ? 'yes' : 'unknown');
        }
    }
    panel.dataset.view = 'games';

    const redraw = () => {
        panel.dataset.view = 'games';
        listWrap.replaceChildren(
            buildGameGrid({ doc, mode, games, selection: next, slot: targetSlot, onChoose: choose, filter, badgeStates }),
        );
    };

    // 徽章图案不一定都在客户端缓存里：打开选择器后慢慢确认，拿到结果再重新排序。
    // 限制同时探测的数量，避免一次打开就压满 CM 请求。
    let badgeRefreshTimer = 0;
    const scheduleBadgeRefresh = () => {
        if (badgeRefreshTimer || closed) return;
        badgeRefreshTimer = win.setTimeout(() => {
            badgeRefreshTimer = 0;
            if (closed || panel.dataset.view === 'levels') return;
            redraw();
        }, 200);
    };
    if (mode === 'badge') {
        const queue = games.filter((game) => badgeStates.get(game.appid) !== 'yes');
        let active = 0;
        const pump = () => {
            while (active < 4 && queue.length > 0) {
                const game = queue.shift();
                active += 1;
                const settle = (data) => {
                    const state = hasBadgeLevels(data) ? 'yes' : 'no';
                    if (badgeStates.get(game.appid) !== state) {
                        badgeStates.set(game.appid, state);
                        scheduleBadgeRefresh();
                    }
                };
                loadBadge(game.appid).then(settle, () => settle(null)).finally(() => {
                    active -= 1;
                    pump();
                });
            }
        };
        pump();
    }

    const choose = (game, level) => {
        if (mode === 'badge') {
            next.badges[targetSlot] = { appid: game.appid, level: level ?? 5 };
        } else {
            next.banners[targetSlot] = game.appid;
        }
        try {
            onChange?.(normalizeSelection(next));
        } finally {
            close();
        }
    };

    const backToGames = () => {
        redraw();
        search.focus?.({ preventScroll: true });
    };
    panel.addEventListener('ac:year-picker-back', backToGames);

    search.addEventListener('input', () => {
        filter = search.value;
        redraw();
    });

    const close = () => {
        if (closed) return;
        closed = true;
        doc.removeEventListener('keydown', onKeyDown, true);
        win?.removeEventListener('keydown', onKeyDown, true);
        overlay.remove();
        onClose?.();
    };
    const onKeyDown = (event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...panel.querySelectorAll('button, input, [tabindex="0"]')].filter((node) => !node.disabled);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable.at(-1);
        if (event.shiftKey && doc.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && doc.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };

    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay) close();
    });
    overlay.addEventListener('wheel', (event) => event.stopPropagation(), { passive: true });
    doc.addEventListener('keydown', onKeyDown, true);
    win?.addEventListener('keydown', onKeyDown, true);

    redraw();
    closeButton.focus?.({ preventScroll: true });

    return { close };
}

export const __debug = { SLOTS };
