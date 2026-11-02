/**
 * 年份跨页前后的两页：月份足迹 / 本年目录。
 *
 * 年份页占左页、年度最爱占右页，这个跨页的前后各会多出半页。
 * 这两页让册子做翻页做不到的事：
 *   月份足迹 —— 放在跨页之前，看这一年的节奏：哪个月打满了什么、最久和最难的一款；
 *   本年目录 —— 放在跨页之后、这一年第一张卡的对面，点一行直接翻到那张卡。
 *
 * 外壳沿用年度最爱的版式（ac-year--annual），两页都只读取卡片已有字段，不额外请求数据。
 */

import { artImage, formatCardDate } from './cardview.js';
import { STR } from './strings.js';

const TEXT = STR.yearFill;

/** 一列放得下的最多行数；超过两列的部分折成「还有 N 款」 */
const MAX_ROWS_PER_COLUMN = 22;
const SINGLE_COLUMN_LIMIT = 11;
const LIST_HEIGHT_CQH = 62;
const ROW_HEIGHT_MAX_CQH = 4;

function el(doc, tag, className, text = null) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function shell(doc, { kicker, tag, title, sub, variant, yearKey, label }) {
    const root = el(doc, 'div', `ac-year ac-year--annual ac-yf ac-yf--${variant}`);
    root.dataset.year = yearKey;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', label);

    const page = el(doc, 'div', 'ac-year__page');
    const head = el(doc, 'div', 'ac-year__head');
    head.append(
        el(doc, 'span', 'ac-year__head-kicker', kicker),
        el(doc, 'i', 'ac-year__head-rule'),
        el(doc, 'span', 'ac-year__head-tag', tag),
    );
    page.append(head, el(doc, 'h2', 'ac-year__title', title));
    if (sub) page.append(el(doc, 'p', 'ac-year__sub', sub));
    root.append(page);
    return { root, page };
}

function monthOf(game) {
    const date = new Date(Number(game?.completedAt) * 1000);
    return Number.isFinite(date.getTime()) ? date.getMonth() : null;
}

function bestBy(games, score) {
    let best = null;
    let bestScore = 0;
    for (const game of games) {
        const value = score(game);
        if (Number.isFinite(value) && value > bestScore) {
            best = game;
            bestScore = value;
        }
    }
    return best ? { game: best, value: bestScore } : null;
}

function recordNode(doc, label, value, note) {
    const node = el(doc, 'div', 'ac-yf__record');
    node.append(
        el(doc, 'span', 'ac-yf__record-label', label),
        el(doc, 'span', 'ac-yf__record-value', value),
        el(doc, 'span', 'ac-yf__record-note', note),
    );
    return node;
}

export function createYearMonths(doc, { yearKey, year, games }) {
    const { root, page } = shell(doc, {
        kicker: TEXT.monthsKicker,
        tag: year,
        title: TEXT.monthsTitle,
        variant: 'months',
        yearKey,
        label: TEXT.monthsAria(year),
    });

    const buckets = Array.from({ length: 12 }, () => []);
    for (const game of games) {
        const month = monthOf(game);
        if (month != null) buckets[month].push(game);
    }
    const peak = Math.max(...buckets.map((bucket) => bucket.length));

    const grid = el(doc, 'div', 'ac-yf__grid');
    buckets.forEach((bucket, month) => {
        const cell = el(doc, 'div', 'ac-yf__month');
        if (bucket.length === 0) cell.dataset.empty = '';
        if (peak > 0 && bucket.length === peak) cell.dataset.peak = '';
        const head = el(doc, 'div', 'ac-yf__month-head');
        head.append(el(doc, 'b', 'ac-yf__month-name', TEXT.month(month + 1)));
        if (bucket.length > 0) head.append(el(doc, 'span', 'ac-yf__month-count', TEXT.count(bucket.length)));
        cell.append(head);

        if (bucket.length > 0) {
            const thumbs = el(doc, 'div', 'ac-yf__thumbs');
            const shown = bucket.length > 3 ? bucket.slice(0, 2) : bucket;
            for (const game of shown) {
                thumbs.append(artImage(doc, game.art?.capsule ?? game.art?.hero ?? [], 'ac-yf__thumb', game.name));
            }
            if (bucket.length > shown.length) {
                thumbs.append(el(doc, 'span', 'ac-yf__thumb ac-yf__thumb--more', `+${bucket.length - shown.length}`));
            }
            cell.append(thumbs);
        }
        grid.append(cell);
    });
    page.append(grid);

    const records = el(doc, 'div', 'ac-yf__records');
    if (peak > 0) {
        const peakMonths = buckets.flatMap((bucket, month) => (bucket.length === peak ? [month + 1] : []));
        records.append(
            recordNode(doc, TEXT.peakLabel, peakMonths.map(TEXT.month).join('、'), TEXT.count(peak)),
        );
    }
    const longest = bestBy(games, (game) => Number(game.playtimeMin));
    if (longest) {
        records.append(recordNode(doc, TEXT.longestLabel, longest.game.name, `${Math.round(longest.value / 60)}h`));
    }
    const rarest = bestBy(games, (game) => Number(game.rare));
    if (rarest) records.append(recordNode(doc, TEXT.rarestLabel, rarest.game.name, TEXT.rareCount(rarest.value)));
    page.append(records);

    return root;
}

/**
 * @param {object} options
 * @param {{ index: number, serial: string, game: object }[]} options.entries 册内顺序
 * @param {(index: number) => void} options.onJump 翻到这张卡
 */
export function createYearIndex(doc, { yearKey, year, entries, onJump }) {
    const { root, page } = shell(doc, {
        kicker: TEXT.indexKicker,
        tag: year,
        title: TEXT.indexTitle,
        sub: TEXT.indexSub(entries.length),
        variant: 'index',
        yearKey,
        label: TEXT.indexAria(year),
    });

    const columns = entries.length > SINGLE_COLUMN_LIMIT ? 2 : 1;
    const capacity = columns * MAX_ROWS_PER_COLUMN;
    const overflow = entries.length > capacity ? entries.length - (capacity - 1) : 0;
    const shown = overflow > 0 ? entries.slice(0, capacity - 1) : entries;
    const rows = Math.ceil((shown.length + (overflow > 0 ? 1 : 0)) / columns);

    const list = el(doc, 'div', 'ac-yf__list');
    list.style.setProperty('--cols', String(columns));
    list.style.setProperty('--rows', String(rows));
    list.style.setProperty('--row', `${Math.min(ROW_HEIGHT_MAX_CQH, LIST_HEIGHT_CQH / Math.max(rows, 1)).toFixed(2)}cqh`);

    for (const { index, serial, game } of shown) {
        const row = el(doc, 'button', 'ac-yf__row');
        row.type = 'button';
        row.setAttribute('aria-label', TEXT.jump(game.name));
        row.append(
            el(doc, 'span', 'ac-yf__serial', serial),
            el(doc, 'span', 'ac-yf__name', game.name),
            el(doc, 'span', 'ac-yf__date', String(formatCardDate(game.completedAt) ?? '').slice(5)),
        );
        row.addEventListener('click', () => onJump?.(index));
        list.append(row);
    }
    if (overflow > 0) list.append(el(doc, 'span', 'ac-yf__row ac-yf__row--more', TEXT.more(overflow)));
    page.append(list);

    return root;
}
