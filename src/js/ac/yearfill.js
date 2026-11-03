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

import { artImage, formatCardDate, formatHours } from './cardview.js';
import { STR } from './strings.js';

const TEXT = STR.yearFill;

/**
 * 目录沿用 1.2.1 的行距（每行 4cqh、11 款以内单列）：一列最多 14 行，两列就是一张；
 * 一年打完的游戏超过一张，就在这一页里分张翻，每一款都点得到（滚轮仍然留给翻书）。
 */
const MAX_ROWS_PER_COLUMN = 14;
const SINGLE_COLUMN_LIMIT = 11;
const LIST_HEIGHT_CQH = 62;
const ROW_HEIGHT_MAX_CQH = 4;
/** 分张时给底下的翻张按钮留出的高度 */
const PAGER_HEIGHT_CQH = 4;
/** 月份格子里最多叠这么多张封面，多出来的用角标写「+N」，点开格子再看全部 */
const MONTH_THUMBS = 4;
/** 点开一个月后一张放多少款（4 列 × 3 行），再多就在放大的这一页里分张 */
const DETAIL_COLUMNS = 4;
const DETAIL_PER_SHEET = 12;
const DETAIL_OPEN_MS = 320;

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

/**
 * @param {object} options
 * @param {object[]} options.games 这一年的游戏（册内顺序）
 * @param {number[]} [options.indices] 和 games 一一对应的册内序号，点开月份后点一款就翻到那张卡
 * @param {(index: number) => void} [options.onJump]
 */
export function createYearMonths(doc, { yearKey, year, games, indices = null, onJump = null }) {
    const { root, page } = shell(doc, {
        kicker: TEXT.monthsKicker,
        tag: year,
        title: TEXT.monthsTitle,
        variant: 'months',
        yearKey,
        label: TEXT.monthsAria(year),
    });

    const buckets = Array.from({ length: 12 }, () => []);
    games.forEach((game, i) => {
        const month = monthOf(game);
        if (month != null) buckets[month].push({ game, index: indices?.[i] ?? null });
    });
    const peak = Math.max(...buckets.map((bucket) => bucket.length));

    const grid = el(doc, 'div', 'ac-yf__grid');
    const detail = createMonthDetail(doc, root, { year, onJump });
    buckets.forEach((bucket, month) => {
        // 有游戏的月份是按钮：格子里放不下的，点开放大看全部
        const cell = el(doc, bucket.length > 0 ? 'button' : 'div', 'ac-yf__month');
        if (bucket.length > 0) {
            cell.type = 'button';
            cell.setAttribute('aria-label', TEXT.monthOpen(month + 1, bucket.length));
            cell.addEventListener('click', () => detail.open(month, bucket, cell));
        }
        if (bucket.length === 0) cell.dataset.empty = '';
        if (peak > 0 && bucket.length === peak) cell.dataset.peak = '';
        const head = el(doc, 'div', 'ac-yf__month-head');
        head.append(el(doc, 'b', 'ac-yf__month-name', TEXT.month(month + 1)));
        if (bucket.length > 0) head.append(el(doc, 'span', 'ac-yf__month-count', TEXT.count(bucket.length)));
        cell.append(head);

        if (bucket.length > 0) {
            const thumbs = el(doc, 'div', 'ac-yf__thumbs');
            // 封面像一叠扑克牌那样错开叠放；放不下的不再硬塞，角标写出还有几款
            const shown = bucket.slice(0, MONTH_THUMBS);
            for (const { game } of shown) {
                thumbs.append(artImage(doc, game.art?.capsule ?? game.art?.hero ?? [], 'ac-yf__thumb', game.name));
            }
            thumbs.style.setProperty('--n', String(shown.length));
            if (bucket.length > shown.length) {
                thumbs.append(el(doc, 'span', 'ac-yf__more', `+${bucket.length - shown.length}`));
            }
            cell.append(thumbs);
        }
        grid.append(cell);
    });
    page.append(grid);

    const records = monthRecords(doc, games);
    if (peak > 0) {
        const peakMonths = buckets.flatMap((bucket, month) => (bucket.length === peak ? [month + 1] : []));
        records.prepend(
            recordNode(doc, TEXT.peakLabel, peakMonths.map(TEXT.month).join('、'), TEXT.count(peak)),
        );
    }
    page.append(records);
    root.append(detail.element);
    return root;
}

/**
 * 点开一个月：从那个格子放大到整页，列出这个月的每一款。
 * 背景是透明的，底下仍是这本册子自己的纸，换册子风格不用另配。
 */
function createMonthDetail(doc, root, { year, onJump }) {
    const win = doc.defaultView;
    const panel = el(doc, 'div', 'ac-yf__detail');
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    const head = el(doc, 'div', 'ac-yf__detail-head');
    const title = el(doc, 'h3', 'ac-yf__detail-title');
    const sub = el(doc, 'p', 'ac-yf__detail-sub');
    const titles = el(doc, 'div', 'ac-yf__detail-titles');
    titles.append(title, sub);
    const close = el(doc, 'button', 'ac-yf__detail-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', TEXT.monthClose);
    head.append(titles, close);
    const body = el(doc, 'div', 'ac-yf__detail-body');
    panel.append(head, body);

    let from = null;
    let animation = null;
    const reduce = () => win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    /** 格子在这一页里的位置，换算成 clip-path 的四边留白 */
    function insetOf(cell) {
        const box = root.getBoundingClientRect();
        const rect = cell.getBoundingClientRect();
        const r = (value, size) => `${Math.max(0, (value / size) * 100).toFixed(2)}%`;
        return `inset(${r(rect.top - box.top, box.height)} ${r(box.right - rect.right, box.width)} ${r(box.bottom - rect.bottom, box.height)} ${r(rect.left - box.left, box.width)} round 0.7cqh)`;
    }

    function render(month, bucket) {
        title.textContent = TEXT.month(month + 1);
        const minutes = bucket.reduce((sum, { game }) => sum + (Number(game.playtimeMin) > 0 ? Number(game.playtimeMin) : 0), 0);
        const rare = bucket.reduce((sum, { game }) => sum + (Number(game.rare) > 0 ? Number(game.rare) : 0), 0);
        sub.textContent = TEXT.monthSummary(year, bucket.length, formatHours(minutes), rare);
        panel.setAttribute('aria-label', TEXT.monthAria(year, month + 1));

        const sheets = [];
        for (let i = 0; i < bucket.length; i += DETAIL_PER_SHEET) sheets.push(bucket.slice(i, i + DETAIL_PER_SHEET));
        const grids = sheets.map((sheet, n) => {
            const grid = el(doc, 'div', 'ac-yf__detail-grid');
            grid.style.setProperty('--cols', String(DETAIL_COLUMNS));
            grid.hidden = n > 0;
            for (const { game, index } of sheet) {
                const item = el(doc, index == null ? 'div' : 'button', 'ac-yf__game');
                if (index != null) {
                    item.type = 'button';
                    item.setAttribute('aria-label', TEXT.jump(game.name));
                    item.addEventListener('click', () => {
                        hide(true);
                        onJump?.(index);
                    });
                }
                const date = String(formatCardDate(game.completedAt) ?? '').slice(5);
                const hours = formatHours(game.playtimeMin);
                item.append(
                    artImage(doc, game.art?.capsule ?? game.art?.hero ?? [], 'ac-yf__game-art', game.name),
                    el(doc, 'span', 'ac-yf__game-name', game.name),
                    el(doc, 'span', 'ac-yf__game-meta', [date, hours].filter(Boolean).join(' · ')),
                );
                grid.append(item);
            }
            return grid;
        });
        body.replaceChildren(...grids);

        if (sheets.length > 1) {
            let current = 0;
            const pager = el(doc, 'div', 'ac-yf__pager');
            const prev = el(doc, 'button', 'ac-yf__page-btn ac-yf__page-btn--prev');
            const label = el(doc, 'span', 'ac-yf__page-label');
            const next = el(doc, 'button', 'ac-yf__page-btn ac-yf__page-btn--next');
            prev.type = 'button';
            next.type = 'button';
            prev.setAttribute('aria-label', TEXT.sheetPrev);
            next.setAttribute('aria-label', TEXT.sheetNext);
            const show = (to) => {
                current = Math.max(0, Math.min(sheets.length - 1, to));
                grids.forEach((grid, n) => { grid.hidden = n !== current; });
                const first = current * DETAIL_PER_SHEET + 1;
                label.textContent = TEXT.sheet(current + 1, sheets.length, first, first + sheets[current].length - 1);
                prev.disabled = current === 0;
                next.disabled = current === sheets.length - 1;
            };
            prev.addEventListener('click', () => show(current - 1));
            next.addEventListener('click', () => show(current + 1));
            pager.append(prev, label, next);
            body.append(pager);
            show(0);
        }
    }

    function open(month, bucket, cell) {
        animation?.cancel();
        render(month, bucket);
        from = cell;
        panel.hidden = false;
        root.classList.add('is-month-open');
        win?.addEventListener('keydown', onKey, true);
        if (!reduce() && panel.animate) {
            animation = panel.animate(
                [{ clipPath: insetOf(cell), opacity: 0.6 }, { clipPath: 'inset(0% 0% 0% 0% round 0px)', opacity: 1 }],
                { duration: DETAIL_OPEN_MS, easing: 'cubic-bezier(.2,.8,.25,1)' },
            );
        }
        close.focus?.({ preventScroll: true });
    }

    /** jumped：点了一款要翻走，就不播收回动画了 */
    function hide(jumped = false) {
        if (panel.hidden) return;
        win?.removeEventListener('keydown', onKey, true);
        const cell = from;
        from = null;
        const done = () => {
            panel.hidden = true;
            root.classList.remove('is-month-open');
            animation = null;
        };
        animation?.cancel();
        if (jumped || reduce() || !panel.animate || !cell?.isConnected) {
            done();
            return;
        }
        root.classList.remove('is-month-open');
        animation = panel.animate(
            [{ clipPath: 'inset(0% 0% 0% 0% round 0px)', opacity: 1 }, { clipPath: insetOf(cell), opacity: 0 }],
            { duration: DETAIL_OPEN_MS * 0.8, easing: 'cubic-bezier(.4,0,.6,1)' },
        );
        animation.finished.then(done, () => {});
        cell.focus?.({ preventScroll: true });
    }

    function onKey(event) {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        // 翻走了还开着：悄悄收起，Esc 留给别人
        if (!root.closest('.ac-leaf[data-visible]') && root.closest('.ac-leaf')) {
            hide(true);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        hide();
    }

    close.addEventListener('click', () => hide());
    // 面板里的空白处不能落到书页上：那会顺带翻页
    panel.addEventListener('click', (event) => event.stopPropagation());

    return { element: panel, open, close: hide };
}

function monthRecords(doc, games) {
    const records = el(doc, 'div', 'ac-yf__records');
    const longest = bestBy(games, (game) => Number(game.playtimeMin));
    if (longest) {
        records.append(recordNode(doc, TEXT.longestLabel, longest.game.name, `${Math.round(longest.value / 60)}h`));
    }
    const rarest = bestBy(games, (game) => Number(game.rare));
    if (rarest) records.append(recordNode(doc, TEXT.rarestLabel, rarest.game.name, TEXT.rareCount(rarest.value)));
    return records;
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
    const perSheet = columns * MAX_ROWS_PER_COLUMN;
    const sheets = [];
    for (let i = 0; i < entries.length; i += perSheet) sheets.push(entries.slice(i, i + perSheet));
    if (sheets.length === 0) sheets.push([]);
    const paged = sheets.length > 1;
    // 分张时每一张都按满张的行高排，翻张时列表不会忽高忽低
    const rows = paged ? MAX_ROWS_PER_COLUMN : Math.ceil(entries.length / columns);
    const height = paged ? LIST_HEIGHT_CQH - PAGER_HEIGHT_CQH : LIST_HEIGHT_CQH;
    const rowHeight = Math.min(ROW_HEIGHT_MAX_CQH, height / Math.max(rows, 1)).toFixed(2);

    const lists = sheets.map((sheet, n) => {
        const list = el(doc, 'div', 'ac-yf__list');
        list.style.setProperty('--cols', String(columns));
        list.style.setProperty('--rows', String(rows));
        list.style.setProperty('--row', `${rowHeight}cqh`);
        list.hidden = n > 0;
        for (const { index, serial, game } of sheet) {
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
        page.append(list);
        return list;
    });

    if (paged) {
        let current = 0;
        const pager = el(doc, 'div', 'ac-yf__pager');
        const prev = el(doc, 'button', 'ac-yf__page-btn ac-yf__page-btn--prev');
        const label = el(doc, 'span', 'ac-yf__page-label');
        const next = el(doc, 'button', 'ac-yf__page-btn ac-yf__page-btn--next');
        prev.type = 'button';
        next.type = 'button';
        prev.setAttribute('aria-label', TEXT.sheetPrev);
        next.setAttribute('aria-label', TEXT.sheetNext);
        const show = (to) => {
            current = Math.max(0, Math.min(sheets.length - 1, to));
            lists.forEach((list, n) => { list.hidden = n !== current; });
            const from = current * perSheet + 1;
            label.textContent = TEXT.sheet(current + 1, sheets.length, from, from + sheets[current].length - 1);
            prev.disabled = current === 0;
            next.disabled = current === sheets.length - 1;
        };
        prev.addEventListener('click', () => show(current - 1));
        next.addEventListener('click', () => show(current + 1));
        pager.append(prev, label, next);
        page.append(pager);
        show(0);
    }

    return root;
}
