/**
 * 成就收藏册 · 书本（翻页 + 悬停检视 + 新卡入册）
 *
 * 版式：一本摊开的集邮册，**从右往左装订**（传统右开本）：
 *       右页 = 当前这一页的正面（完整卡面），左页 = 下一叶的背面（游戏胶囊封面）。
 *       阅读方向跟着右页走，和国内习惯一致；翻页时左页绕书脊向右转过去。
 *       按完成时间**正序**装订：第一页是 No.001，往后编号递增，最近完美通关的游戏在册子的最后。
 *       新卡拿下一个号，旧卡的号永远不变。没有记忆页码时直接摊在最新一页。
 *
 * 结构：每一「页」占一叶（leaf），一页放 1 张或 4 张卡（主题设置「单页卡片数量」）。
 *       叶的正面是左页、背面是右页，翻页 = 整叶绕书脊向右转 180°。集邮册的内页是硬卡纸，
 *       所以这里刻意做成刚性翻转，再用明暗变化表现翻起与落下，而不是软纸卷曲。
 *         · 未翻的叶叠在左边，第 k 叶在最上面；
 *         · 已翻的叶叠在右边，第 k-1 叶在最上面；
 *         · 最底下各垫一张固定页：右边是扉页，左边是「未完待续」（下一款打满的游戏会收在最后，
 *           翻到底后挨着它）。
 *       k 是**页码**，不是卡片数组下标。store 给的卡片按完成时间倒序（新的在前），
 *       所以第 k 页第 s 个卡槽是第 k × perPage + s + 1 个打满的游戏，
 *       数组下标 = n - 1 - (k × perPage + s)。
 *
 * 交互：
 *   · 鼠标悬停在卡片上 → 3D 检视（跟随指针倾斜 + 反光），离开回正；
 *   · 单击左页卡片 → 向后翻一页；单击右页卡片 → 向前翻回一页；
 *   · 滚轮 → 快速翻页，连续滚动会一叶接一叶地翻过去；
 *   · 点书签 / 向下拉书签 → 快速掠向离得最远的一端（最新页 ↔ No.001~004）；
 *   · 键盘：卡片可聚焦，Enter / 空格 等同于单击。不绑定方向键。
 *
 * 新卡入册（introduce）：新全成就的游戏先空着卡槽，卡片背面朝上从书的正中浮现，
 *       翻到正面，再落进自己的卡槽。好几张时从最早的一张开始，一页一页往前收。
 *
 * 性能：只保留当前位置前后各两叶的 DOM（其余按需创建 / 回收），卡再多 DOM 也是这么几叶；
 *       指针事件统一委托在书页容器上，并按帧节流；入册动画只动 transform / opacity。
 */

import STR from './strings.js';
import { artImage, createCardBack, createCardFront, formatSerial, formatSerialRange } from './cardview.js';
import { getTone, toneToCss } from './tone.js';

const TURN_MS = 1000; // 与 book.css 里的 --ac-turn 保持一致
const WHEEL_TURN_MS = 460; // 滚轮翻一页：比点击快，但不至于看不清
const WHEEL_RAPID_MS = 260; // 滚轮还在连续滚时，后续的叶翻得更快
const WHEEL_STEP = 100; // 累计多少滚轮距离翻一页（Windows 上一格通常是 100 / 120）
const WHEEL_QUEUE_MAX = 6;
const RIFFLE_LEAVES = 7; // 书签快速翻阅时真正掠过的叶数（远跳时中间页会快进，首末叶始终对得上）
const RIFFLE_TURN_MS = 480; // 每一叶掠过的时间
const RIFFLE_STAGGER_MS = 62; // 相邻两叶的起翻间隔
const KEEP_BEHIND = 2;
const KEEP_AHEAD = 2;
const TILT_X = 11; // 上下最大倾角（deg）
const TILT_Y = 14; // 左右最大倾角（deg）

/** 单页一张时，一次最多给这么多张新卡播入册动画（最新的几张），再多的直接放进册子 */
const MAX_INTRO = 3;
/** 单页一张时的卡槽高度（cqh），入册动画用它把长度单位换算回卡片尺度 */
const SLOT_HEIGHT_CQH = 74;
/** 入册动画的时间轴（ms）：浮现 → 翻面 → 停顿 → 落槽 */
const INTRO = { appear: 520, flipAt: 560, flip: 900, hold: 380, fly: 780 };

/** 卡片插画在卡面上露出部分的宽高比，供取色时裁出同一块区域 */
const ART_VISIBLE_RATIO = 1.25;

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

/** 已翻 / 未翻页数 → 书口厚度档位（0–4） */
function depthLevel(count) {
    if (count <= 0) return 0;
    if (count <= 2) return 1;
    if (count <= 8) return 2;
    if (count <= 20) return 3;
    return 4;
}

/**
 * @param {HTMLElement} container
 * @param {object} options
 * @param {Array}  options.cards  按**完成时间倒序**排好的卡片（最近完成的在最前面）
 * @param {object} [options.owner] { persona, avatar }
 * @param {number} [options.perPage] 每页卡片数：1（默认）或 4
 * @param {{page?: number, appid?: number|null}} [options.initial] 上次看到的页（优先按 appid 锚定）
 * @param {(position: {page: number, appid: number|null}) => void} [options.onPage] 每次翻页停稳后回调
 * @returns {{ destroy(): void, turn(dir: 1|-1): void, goTo(index: number): void,
 *             updateCard(appid: number, card: object): boolean,
 *             replaceCards(cards: Array, options?: {keepAppid?: number|null, atStart?: boolean}): void,
 *             introduce(cards: Array, appids: number[]): Promise<boolean>,
 *             get cards(): Array, get index(): number, get page(): number,
 *             get pageCount(): number, get position(): {page: number, appid: number|null} }}
 */
export function createBook(container, { cards, owner = {}, perPage: requestedPerPage = 1, initial = null, onPage = null }) {
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const perPage = Number(requestedPerPage) === 4 ? 4 : 1;
    let list = cards;      // 卡片顺序会随完成日期的补全而重排
    let n = list.length;
    const reduceMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)');

    const pageCount = () => Math.ceil(n / perPage);
    /** 页码 → 该页最靠前那张卡在 list 里的下标（第 1 页是 No.001，list 里在最后） */
    const firstIndexOfPage = (page) => Math.max(0, n - 1 - page * perPage);
    /** list 下标 → 页码（第 i 张卡是第几个打满的） */
    const pageOfIndex = (index) => {
        if (n <= 0) return 0;
        const i = Math.min(n - 1, Math.max(0, Math.trunc(index) || 0));
        return Math.floor((n - 1 - i) / perPage);
    };

    // 左页显示第 k 页的背面，右页显示第 k-1 页的正面；k = pageCount() 时左边是「未完待续」
    // 没有记忆时直接摊在最新一页，而不是从 No.001 开始
    let k = pageCount();
    {
        // 上次看到的那一页：appid 优先（换每页数量 / 卡片重排后仍然落在同一张卡上），页码兜底
        const found = initial?.appid != null ? list.findIndex((c) => c.appid === initial.appid) : -1;
        if (found >= 0) k = pageOfIndex(found);
        else if (Number.isFinite(initial?.page)) k = Math.max(0, Math.min(pageCount(), Math.trunc(initial.page)));
    }
    let busy = false;
    let disposed = false;
    const leaves = new Map();
    const timers = new Set();
    const animations = new Set();
    /** 滚轮翻页：还没翻完的页数，和「正在一串连续翻页里」的标记 */
    let wheelQueue = [];
    let wheelRunning = false;
    /** 书签正在被拉住 / 正在播放快速翻阅 */
    let pull = null;
    let riffleStage = null;

    /** 还没入册的新卡（卡槽先空着，等入册动画） */
    let hidden = new Set();
    let introducing = false;
    /** 入册动画期间来的整册重排，等动画播完再做 */
    let deferredCards = null;
    /** 入册动画的 resolve：书被销毁时用它告诉调用方「没播完」 */
    let finishIntro = null;

    /* ── 骨架 ─────────────────────────────────────────────────────────── */

    const album = el(doc, 'div', 'ac-album', { role: 'region', 'aria-label': STR.book.label, tabindex: '-1' });
    const book = el(doc, 'div', 'ac-book', { 'data-per-page': String(perPage) });
    const ribbon = el(doc, 'div', 'ac-book__ribbon', {
        role: 'button',
        tabindex: '0',
        title: STR.book.bookmark,
        'aria-label': STR.book.bookmark,
    });
    const board = el(doc, 'div', 'ac-book__board', { 'aria-hidden': 'true' });
    const pages = el(doc, 'div', 'ac-book__pages');
    const live = el(doc, 'div', 'ac-sr-only', { 'aria-live': 'polite' });

    const titlePage = buildTitlePage();
    const endPage = buildEndPage();
    pages.append(titlePage, endPage);
    book.append(ribbon, board, pages);
    album.append(book, live);
    container.append(album);

    function paper(face) {
        face.append(el(doc, 'div', 'ac-page__paper', { 'aria-hidden': 'true' }));
    }

    function shade(face) {
        face.append(el(doc, 'div', 'ac-page__shade', { 'aria-hidden': 'true' }));
    }

    /** 扉页：右开本的起点，右边 */
    function buildTitlePage() {
        const page = el(doc, 'div', 'ac-page ac-page--right ac-page--base ac-page--title');
        paper(page);
        const box = el(doc, 'div', 'ac-title');
        box.append(el(doc, 'div', 'ac-title__badge', { 'aria-hidden': 'true' }));
        box.append(el(doc, 'div', 'ac-title__name', { text: STR.book.title }));
        box.append(el(doc, 'div', 'ac-title__sub', { text: STR.book.subtitle }));
        box.append(el(doc, 'div', 'ac-title__rule', { 'aria-hidden': 'true' }));
        if (owner.persona) {
            const who = el(doc, 'div', 'ac-title__owner');
            if (owner.avatar) who.append(artImage(doc, owner.avatar, 'ac-title__avatar'));
            who.append(el(doc, 'span', null, { text: owner.persona }));
            box.append(who);
        }
        page.append(box);
        // 翻页提示跟着「第一眼看到的那一页」走
        if (n > 0) page.append(el(doc, 'div', 'ac-title__hint', { text: STR.book.hint }));
        shade(page);
        return page;
    }

    /** 「未完待续」：右开本的终点，左边 —— 下一款打满的游戏就收在它前面 */
    function buildEndPage() {
        const page = el(doc, 'div', 'ac-page ac-page--left ac-page--base ac-page--end');
        paper(page);
        const box = el(doc, 'div', 'ac-end');
        box.append(el(doc, 'div', 'ac-end__mark', { 'aria-hidden': 'true' }));
        box.append(el(doc, 'div', 'ac-end__title', { text: STR.book.endTitle }));
        box.append(el(doc, 'div', 'ac-end__desc', { text: STR.book.endDesc }));
        page.append(box);
        shade(page);
        return page;
    }

    /**
     * side 是叶的面：'front' 落在左页，'back' 落在右页。
     * 卡面反过来铺：左页看胶囊封面（卡背），右页看完整卡面（卡正面）。
     */
    function buildCard(i, side) {
        const card = list[i];
        const faceUp = side === 'back';
        const node = el(doc, 'div', 'ac-card', {
            role: 'button',
            tabindex: '-1',
            'data-side': side,
            'data-index': String(i),
            'aria-label': faceUp ? STR.card.front(card.name) : STR.card.back(card.name),
        });
        const tilt = el(doc, 'div', 'ac-card__tilt');
        tilt.append(faceUp ? createCardFront(doc, card, { owner }) : createCardBack(doc, card));
        node.append(el(doc, 'div', 'ac-card__shadow', { 'aria-hidden': 'true' }), tilt);
        return node;
    }

    function fillFace(face, page, side) {
        paper(face);
        const base = page * perPage; // 本页第一个编号（0 基）
        const until = Math.min(n, base + perPage); // 本页最后一个编号（0 基，不含）
        for (let s = 0; s < perPage; s += 1) {
            const serial = base + s + 1; // 页内从左到右、从上到下，编号递增
            const slot = el(doc, 'div', 'ac-slot', { 'data-slot': String(s) });
            if (serial <= n) {
                const i = n - serial;
                slot.dataset.index = String(i);
                slot.append(buildCard(i, side));
                // 待入册的卡单独藏起来（一页里其余已入册的卡照常显示）
                if (hidden.has(list[i].appid)) slot.setAttribute('data-incoming', '');
            } else {
                slot.classList.add('ac-slot--empty');
            }
            face.append(slot);
        }
        // 编号按完成先后：第 1 页是 No.001，往后递增
        const folio = perPage === 1 ? formatSerial(base + 1) : formatSerialRange(base + 1, until);
        face.append(el(doc, 'div', 'ac-page__folio', { text: folio, 'aria-hidden': 'true' }));
        shade(face);
    }

    function buildFace(page, side) {
        const face = el(doc, 'div', `ac-leaf__face ac-leaf__face--${side} ac-page ac-page--${side === 'front' ? 'left' : 'right'}`);
        fillFace(face, page, side);
        return face;
    }

    /** 不带翻面的平页，书签快速翻阅时用来盖住出发时的那一半对开页 */
    function buildFlatPage(page, side) {
        const face = el(doc, 'div', `ac-page ac-page--${side === 'front' ? 'left' : 'right'} ac-page--base`);
        fillFace(face, page, side);
        return face;
    }

    function applyTone(root, card) {
        getTone(doc, card.appid, card.art?.hero ?? [], ART_VISIBLE_RATIO).then((tone) => {
            if (tone && !disposed) root.querySelector('.ac-cf')?.style.setProperty('--ac-tone', toneToCss(tone));
        });
    }

    function buildLeaf(page) {
        const leaf = el(doc, 'div', 'ac-leaf', { 'data-index': String(page) });
        const front = buildFace(page, 'front');
        leaf.append(front, buildFace(page, 'back'));

        // 卡面底色：每张卡各取各的（异步，取到之前用默认底色）
        // 完整卡面现在铺在叶的背面（右页），两面都取一次，换页时不闪底色
        for (const face of leaf.querySelectorAll('.ac-leaf__face')) {
            for (const slot of face.querySelectorAll('.ac-slot[data-index]')) {
                applyTone(slot, list[Number(slot.dataset.index)]);
            }
        }
        return leaf;
    }

    /* ── 布局：维护可见窗口内的叶，设置叠放次序 ─────────────────────────── */

    function layout() {
        const total = pageCount();
        // 可见的两叶（k-1、k）+ 翻页时会被揭开的两叶（k-2、k+1）+ 前后各预载一叶
        const lo = Math.max(0, k - 1 - KEEP_BEHIND);
        const hi = Math.min(total - 1, k + KEEP_AHEAD);

        for (const [i, leaf] of leaves) {
            if (i < lo || i > hi) {
                leaf.remove();
                leaves.delete(i);
            }
        }
        for (let i = lo; i <= hi; i += 1) {
            if (!leaves.has(i)) {
                const leaf = buildLeaf(i);
                leaves.set(i, leaf);
                pages.append(leaf);
            }
        }

        for (const [i, leaf] of leaves) {
            const turned = i < k;
            leaf.toggleAttribute('data-turned', turned);
            // 左边一摞：第 k 叶在最上；右边一摞：第 k-1 叶在最上
            leaf.style.zIndex = String(turned ? 100 - (k - 1 - i) : 100 - (i - k));
            const visible = i === k || i === k - 1;
            leaf.toggleAttribute('data-visible', visible);
            for (const card of leaf.querySelectorAll('.ac-card')) {
                const active = (card.dataset.side === 'front' && i === k) || (card.dataset.side === 'back' && i === k - 1);
                // 待入册的卡槽还是空的，别让键盘焦点落进去
                card.tabIndex = active && !card.closest('.ac-slot[data-incoming]') ? 0 : -1;
            }
        }

        book.dataset.leftDepth = String(depthLevel(total - k));
        book.dataset.rightDepth = String(depthLevel(k));
        book.toggleAttribute('data-at-start', k === 0);
        book.toggleAttribute('data-at-end', k === total);
    }

    /** 可见窗口整个重建（换了卡片顺序 / 跳到别处时） */
    function rebuild() {
        for (const leaf of leaves.values()) leaf.remove();
        leaves.clear();
        layout();
    }

    /* ── 翻页 ─────────────────────────────────────────────────────────── */

    /** 第 spread 个对开页的右页：上一叶的背面；第 0 个对开页的右页是扉页 */
    const rightFaceAt = (spread) =>
        spread > 0 ? leaves.get(spread - 1)?.querySelector('.ac-leaf__face--back') : titlePage;
    /** 第 spread 个对开页的左页：这一叶的正面；翻到底时左页是「未完待续」 */
    const leftFaceAt = (spread) =>
        spread < pageCount() ? leaves.get(spread)?.querySelector('.ac-leaf__face--front') : endPage;

    function later(fn, ms) {
        const id = win.setTimeout(() => {
            timers.delete(id);
            fn();
        }, ms);
        timers.add(id);
    }

    const wait = (ms) => new Promise((resolve) => later(resolve, ms));

    /** 当前停在哪一页。appid 取该页最靠前的一张卡，下次进来靠它把位置锚回来。 */
    function currentPosition() {
        const page = Math.min(k, Math.max(0, pageCount() - 1));
        const card = n > 0 ? list[firstIndexOfPage(page)] : null;
        return { page: k, appid: card?.appid ?? null };
    }

    function notifyPage() {
        if (disposed) return;
        try {
            onPage?.(currentPosition());
        } catch {
            /* 展示层回写出错不能影响翻页 */
        }
    }

    /** 播报当前页（左页）；返回这一页最靠前的那张卡 */
    function announcePosition() {
        const card = k < pageCount() ? list[firstIndexOfPage(k)] : null;
        live.textContent = card ? `${formatPosition()} ${card.name}` : k >= pageCount() ? STR.book.endTitle : STR.book.title;
        return card;
    }

    /** 翻页动画的时长跟着这次翻页走（CSS 里的 --ac-turn 同时管翻转和明暗） */
    function setTurnDuration(ms) {
        if (ms === TURN_MS) album.style.removeProperty('--ac-turn');
        else album.style.setProperty('--ac-turn', `${ms}ms`);
    }

    function turn(dir) {
        if (busy || disposed || introducing) return;
        const focusAfter = album.contains(doc.activeElement);
        flip(dir).then((moved) => {
            if (moved) afterTurn(focusAfter);
            // 点击翻页时如果滚轮已经排了队，等这一页翻完接着翻
            if (!disposed && !wheelRunning && wheelQueue.length > 0) runWheelQueue(wheelQueue.shift());
        });
    }

    /** 滚轮翻页：连续滚动时一叶接一叶地翻，队列空了再播报最终位置 */
    async function runWheelQueue(first) {
        if (wheelRunning || disposed || introducing) {
            wheelQueue = [];
            return;
        }
        wheelRunning = true;
        let dir = first;
        let moved = false;
        while (!disposed && dir) {
            if (introducing) break;
            if ((dir > 0 && k >= pageCount()) || (dir < 0 && k <= 0)) break;
            const fast = wheelQueue.length > 0;
            const done = await flip(dir, fast ? WHEEL_RAPID_MS : WHEEL_TURN_MS);
            if (!done) break;
            moved = true;
            notifyPage();
            dir = wheelQueue.shift() ?? 0;
        }
        wheelQueue = [];
        wheelRunning = false;
        if (moved && !disposed) {
            resetTilt();
            announcePosition();
        }
    }

    let wheelAccum = 0;

    function onWheel(event) {
        if (disposed || introducing || event.ctrlKey) return;
        let delta = event.deltaY;
        if (!delta) return;
        if (event.deltaMode === 1) delta *= 16;
        else if (event.deltaMode === 2) delta *= album.clientHeight || 600;
        event.preventDefault();
        if (Math.sign(delta) !== Math.sign(wheelAccum)) wheelAccum = 0;
        wheelAccum += delta;
        const steps = Math.trunc(wheelAccum / WHEEL_STEP);
        if (!steps) return;
        wheelAccum -= steps * WHEEL_STEP;
        wheelAccum = Math.max(-WHEEL_STEP * 3, Math.min(WHEEL_STEP * 3, wheelAccum));
        // 一次事件最多排两页，别让触控板的一记甩动直接穿过整本书
        const dir = Math.sign(steps);
        const count = Math.min(Math.abs(steps), 2);
        for (let s = 0; s < count; s += 1) {
            if (busy || wheelRunning) {
                if (wheelQueue.length < WHEEL_QUEUE_MAX) wheelQueue.push(dir);
            } else {
                runWheelQueue(dir);
            }
        }
    }

    /** 翻一页的动画本体，翻完 resolve(true)；没有可翻的叶时 resolve(false) */
    function flip(dir, duration = TURN_MS) {
        const i = dir > 0 ? k : k - 1;
        const leaf = leaves.get(i);
        if (!leaf) return Promise.resolve(false);

        resetTilt();
        setTurnDuration(duration);

        if (reduceMotion?.matches) {
            k += dir;
            layout();
            setTurnDuration(TURN_MS);
            return Promise.resolve(true);
        }

        busy = true;
        book.dataset.turning = dir > 0 ? 'forward' : 'backward';

        // 明暗：翻起的那一面逐渐变暗、落下的那一面逐渐变亮；
        // 被揭开的下一页上，翻页投下的阴影逐渐退去；即将被盖住的那一页逐渐被阴影罩住。
        const front = leaf.querySelector('.ac-leaf__face--front');
        const back = leaf.querySelector('.ac-leaf__face--back');
        const marks = [];
        const mark = (face, value) => {
            if (!face) return;
            face.dataset.shade = value;
            marks.push(face);
        };
        if (dir > 0) {
            mark(front, 'dim');
            mark(back, 'light');
            mark(leftFaceAt(k + 1), 'reveal');
            mark(rightFaceAt(k), 'cover');
        } else {
            mark(back, 'dim');
            mark(front, 'light');
            mark(rightFaceAt(k - 2), 'reveal');
            mark(leftFaceAt(k), 'cover');
        }

        leaf.classList.add('is-turning');
        leaf.style.zIndex = '300';
        // 先让浏览器记住起点，再切换终点，transition 才会生效
        void leaf.offsetWidth;
        leaf.toggleAttribute('data-turned', dir > 0);

        return new Promise((resolve) => {
            later(() => {
                leaf.classList.remove('is-turning');
                for (const face of marks) delete face.dataset.shade;
                delete book.dataset.turning;
                k += dir;
                layout();
                busy = false;
                setTurnDuration(TURN_MS);
                resolve(true);
            }, duration + 30);
        });
    }

    function afterTurn(focusAfter) {
        const card = announcePosition();
        if (!focusAfter) return;
        // 键盘用户：焦点落在新左页的第一张卡上
        const i = card ? firstIndexOfPage(k) : -1;
        const target = i >= 0 ? album.querySelector(`.ac-card[data-side="front"][data-index="${i}"]`) : null;
        (target ?? album).focus?.({ preventScroll: true });
    }

    const formatPosition = () =>
        perPage === 1
            ? `${Math.min(k + 1, n)} / ${n}`
            : STR.book.pageStatus(Math.min(k + 1, pageCount()), pageCount());

    /* ── 悬停检视 ─────────────────────────────────────────────────────── */

    let hovered = null;
    let frame = 0;
    let pending = null;

    function applyTilt() {
        frame = 0;
        if (!pending || !hovered) return;
        const { x, y } = pending;
        pending = null;
        const rect = hovered.getBoundingClientRect();
        const px = Math.min(1, Math.max(0, (x - rect.left) / rect.width));
        const py = Math.min(1, Math.max(0, (y - rect.top) / rect.height));
        const s = hovered.style;
        s.setProperty('--rx', `${((0.5 - py) * 2 * TILT_X).toFixed(2)}deg`);
        s.setProperty('--ry', `${((px - 0.5) * 2 * TILT_Y).toFixed(2)}deg`);
        s.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
        s.setProperty('--my', `${(py * 100).toFixed(1)}%`);
        // 纯数字版本给 CSS calc() 用（阴影偏移、边框流光）
        s.setProperty('--px', px.toFixed(3));
        s.setProperty('--py', py.toFixed(3));
    }

    function resetTilt() {
        if (!hovered) return;
        hovered.removeAttribute('data-hover');
        for (const prop of ['--rx', '--ry', '--mx', '--my', '--px', '--py']) hovered.style.removeProperty(prop);
        hovered = null;
        pending = null;
    }

    function onPointerMove(event) {
        if (busy || introducing || event.pointerType === 'touch') return;
        const card = event.target.closest?.('.ac-card');
        if (card !== hovered) {
            resetTilt();
            if (card && card.tabIndex === 0) {
                hovered = card;
                card.setAttribute('data-hover', '');
            }
        }
        if (!hovered) return;
        pending = { x: event.clientX, y: event.clientY };
        if (!frame) frame = win.requestAnimationFrame(applyTilt);
    }

    function onPointerLeave() {
        resetTilt();
    }

    function activate(card) {
        if (!card || card.tabIndex !== 0) return;
        turn(card.dataset.side === 'front' ? 1 : -1);
    }

    function onClick(event) {
        activate(event.target.closest?.('.ac-card'));
    }

    function onKeyDown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest?.('.ac-card');
        if (!card) return;
        event.preventDefault();
        activate(card);
    }

    /* ── 书签：点一下 / 往下拉，快速掠向离得最远的一端 ─────────────────────
       默认摊在最新一页，所以第一下拉书签会翻向 No.001~004 所在的「尾页」；
       停在尾页时再拉，则回到最新一页。 */

    /** 这一下要去哪一页：离哪端远就去哪端；一样远时去最新一页 */
    function riffleTarget() {
        const total = pageCount();
        if (total <= 0) return 0;
        return k <= total - k ? total : 0;
    }

    function pageRange(from, to, step) {
        const pages = [];
        for (let p = from; step > 0 ? p <= to : p >= to; p += step) pages.push(p);
        return pages;
    }

    /**
     * 掠过的那一叠叶。距离近就逐叶翻；距离远时保留出发的第一叶和终点前的最后几叶，
     * 中间快进——第一叶盖住起点、最后一叶翻过去正好是终点，所以看不出跳页。
     */
    function rifflePages(from, target) {
        const distance = Math.abs(target - from);
        const count = Math.min(RIFFLE_LEAVES, distance);
        if (target > from) {
            if (distance <= count) return pageRange(from, target - 1, 1);
            return [from, ...pageRange(target - (count - 1), target - 1, 1)];
        }
        if (distance <= count) return pageRange(from - 1, target, -1);
        return [from - 1, ...pageRange(target + (count - 2), target, -1)];
    }

    /**
     * 盖在书上的一叠真实叶：
     *   向前翻——第一叶正面就是出发时的左页，右边先垫一张出发时的右页；
     *   向后翻——第一叶背面就是出发时的右页，左边先垫一张出发时的左页。
     * 终点已经先摊在下面，最后一叶落定时两面都和终点一致，撤掉这一层毫无跳变。
     */
    function buildRiffleStage(from, target) {
        const forward = target > from;
        const stage = el(doc, 'div', 'ac-riffle', { 'aria-hidden': 'true' });
        const cover = forward
            ? from > 0
                ? buildFlatPage(from - 1, 'back')
                : titlePage.cloneNode(true)
            : from < pageCount()
              ? buildFlatPage(from, 'front')
              : endPage.cloneNode(true);
        cover.classList.add('ac-riffle__cover');
        stage.append(cover);

        const leavesOut = rifflePages(from, target).map((page, i) => {
            const leaf = buildLeaf(page);
            leaf.classList.add('ac-riffle__leaf');
            leaf.style.zIndex = String(400 - i);
            // 只露第一叶；后面每一叶在上一叶起翻时再露出来，避免同角度下背面互相盖错
            if (i > 0) leaf.style.visibility = 'hidden';
            if (!forward) leaf.setAttribute('data-turned', '');
            stage.append(leaf);
            return leaf;
        });
        return { stage, forward, leavesOut };
    }

    async function riffleToFarEnd() {
        if (disposed || introducing || busy || riffleStage) return;
        const target = riffleTarget();
        const focusAfter = album.contains(doc.activeElement);
        resetTilt();
        if (target === k) {
            // 空册子才会走到这里：书签轻轻晃一下，当作回应
            if (!reduceMotion?.matches) {
                play(ribbon, [{ transform: 'translateY(0)' }, { transform: 'translateY(-2px)' }, { transform: 'translateY(0)' }], {
                    duration: 320,
                    easing: 'ease-out',
                });
            }
            return;
        }
        if (reduceMotion?.matches) {
            k = target;
            layout();
            notifyPage();
            announcePosition();
            return;
        }

        const from = k;
        busy = true;
        wheelQueue = [];
        book.dataset.riffle = '';
        const { stage, forward, leavesOut } = buildRiffleStage(from, target);
        riffleStage = stage;
        book.append(stage);

        try {
            // 先等这一叠叶上的图加载出来，否则翻起来还是空白纸
            await imagesReady(stage, 450);
            if (disposed) return;

            // 终点先摊在下面；上面这一叠仍然盖着起点，所以此刻换页看不出来
            k = target;
            layout();
            // 上一叶起翻的同一刻露出下一叶：新页从翻起的纸边下接上来
            leavesOut.forEach((leaf, i) => {
                if (i > 0) later(() => { leaf.style.visibility = 'visible'; }, (i - 1) * RIFFLE_STAGGER_MS);
            });

            await Promise.all(
                leavesOut.map((leaf, i) => {
                    const anim = leaf.animate(
                        forward
                            ? [{ transform: 'rotateY(0deg)' }, { transform: 'rotateY(180deg)' }]
                            : [{ transform: 'rotateY(180deg)' }, { transform: 'rotateY(0deg)' }],
                        {
                            duration: RIFFLE_TURN_MS,
                            delay: i * RIFFLE_STAGGER_MS,
                            easing: 'cubic-bezier(.42,.05,.28,1)',
                            fill: 'both',
                        },
                    );
                    animations.add(anim);
                    return anim.finished
                        .catch(() => {})
                        .then(() => {
                            animations.delete(anim);
                            // 落下的叶压到下一叶下面；下一叶仍在它上面，接续盖过去
                            if (!disposed) leaf.style.zIndex = String(200 - i);
                        });
                }),
            );
            if (disposed) return;
            notifyPage();
            announcePosition();
        } finally {
            if (riffleStage === stage) {
                stage.remove();
                riffleStage = null;
                delete book.dataset.riffle;
                busy = false;
            }
            if (focusAfter && !disposed) ribbon.focus?.({ preventScroll: true });
        }
    }

    function onRibbonPointerDown(event) {
        if (disposed || introducing || busy || event.button > 0) return;
        event.preventDefault();
        pull = { id: event.pointerId, y: event.clientY, dy: 0 };
        try {
            ribbon.setPointerCapture?.(event.pointerId);
        } catch {
            /* 没有活动的指针时捕获会失败，不影响下拉 */
        }
        ribbon.setAttribute('data-pulling', '');
    }

    function onRibbonPointerMove(event) {
        if (!pull || event.pointerId !== pull.id) return;
        pull.dy = Math.min(96, Math.max(0, event.clientY - pull.y));
        ribbon.style.transform = `translateY(${(pull.dy * 0.62).toFixed(1)}px)`;
    }

    function endRibbonPull(event, cancelled) {
        if (!pull || event.pointerId !== pull.id) return;
        const dy = pull.dy;
        pull = null;
        ribbon.removeAttribute('data-pulling');
        ribbon.style.removeProperty('transform');
        try {
            ribbon.releasePointerCapture?.(event.pointerId);
        } catch {
            /* 指针可能已经被系统释放 */
        }
        if (!cancelled && dy >= 16) riffleToFarEnd();
    }

    function onRibbonUp(event) {
        endRibbonPull(event, false);
    }

    function onRibbonCancel(event) {
        endRibbonPull(event, true);
    }

    function onRibbonKeyDown(event) {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        riffleToFarEnd();
    }

    pages.addEventListener('pointermove', onPointerMove);
    pages.addEventListener('pointerleave', onPointerLeave);
    pages.addEventListener('click', onClick);
    pages.addEventListener('keydown', onKeyDown);
    album.addEventListener('wheel', onWheel, { passive: false });
    ribbon.addEventListener('pointerdown', onRibbonPointerDown);
    ribbon.addEventListener('pointermove', onRibbonPointerMove);
    ribbon.addEventListener('pointerup', onRibbonUp);
    ribbon.addEventListener('pointercancel', onRibbonCancel);
    ribbon.addEventListener('keydown', onRibbonKeyDown);

    layout();

    /* ── 新卡入册 ─────────────────────────────────────────────────────── */

    /** Web Animations 的小封装：结束（或被取消）时 resolve，销毁书本时统一取消 */
    function play(node, keyframes, options) {
        const anim = node.animate(keyframes, { fill: 'both', ...options });
        animations.add(anim);
        return anim.finished.then(
            () => true,
            () => false,
        ).finally(() => animations.delete(anim));
    }

    /** 等替身卡上的图加载出来再开演，最多等 timeout 毫秒 */
    function imagesReady(root, timeout = 1500) {
        const pending = [...root.querySelectorAll('img')].map(
            (img) =>
                new Promise((resolve) => {
                    if (img.complete && img.naturalWidth > 0) return resolve();
                    img.addEventListener('load', resolve);
                    // 候选链换下一张时也会报 error；整条链都失败了才算完
                    img.addEventListener('error', () => win.setTimeout(() => img.dataset.missing !== undefined && resolve(), 0));
                }),
        );
        return Promise.race([Promise.all(pending), wait(timeout)]);
    }

    /** 替身卡的一面：和册子里的卡同一套 DOM，所以落进卡槽的那一刻严丝合缝 */
    function ghostFace(card, side) {
        const face = el(doc, 'div', `ac-intro__face ac-intro__face--${side}`);
        const node = el(doc, 'div', 'ac-card');
        const tilt = el(doc, 'div', 'ac-card__tilt');
        tilt.append(side === 'front' ? createCardFront(doc, card, { owner }) : createCardBack(doc, card));
        node.append(tilt);
        face.append(node);
        return face;
    }

    /** 翻面那一刻从书中央炸开的一圈星芒 */
    function sparkBurst(u, delay) {
        const box = el(doc, 'div', 'ac-intro-sparks', { 'aria-hidden': 'true' });
        const count = 18;
        for (let s = 0; s < count; s += 1) {
            const spark = el(doc, 'i', 'ac-intro__spark');
            const size = (1.8 + Math.random() * 2.6) * u;
            spark.style.width = `${size}px`;
            spark.style.height = `${size}px`;
            box.append(spark);
            const angle = ((s + Math.random() * 0.6) / count) * Math.PI * 2;
            const dist = (32 + Math.random() * 26) * u;
            const x = Math.cos(angle) * dist;
            const y = Math.sin(angle) * dist * 0.82;
            play(
                spark,
                [
                    { transform: 'translate(-50%, -50%) scale(0.2) rotate(0deg)', opacity: 0 },
                    { transform: `translate(calc(-50% + ${x * 0.55}px), calc(-50% + ${y * 0.55}px)) scale(1) rotate(45deg)`, opacity: 1, offset: 0.35 },
                    { transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px)) scale(0.4) rotate(90deg)`, opacity: 0 },
                ],
                { duration: 950 + Math.random() * 450, delay: delay + Math.random() * 140, easing: 'cubic-bezier(.2,.7,.3,1)' },
            );
        }
        return box;
    }

    /**
     * 一张新卡入册：背面朝上从书的正中浮现 → 翻到正面（星芒炸开、流光扫过）→ 落进卡槽。
     * 卡槽在右页（叶的背面），卡面也是正面朝上，落下去不用再翻一次。
     */
    async function fly(i) {
        const card = list[i];
        const page = pageOfIndex(i);
        const leaf = leaves.get(page);
        const slot = leaf?.querySelector(`.ac-leaf__face--back .ac-slot[data-index="${i}"]`);
        const reveal = () => {
            hidden.delete(card.appid);
            // 正反两面各有一个卡槽，都要放行
            for (const node of leaf?.querySelectorAll(`.ac-slot[data-index="${i}"]`) ?? []) {
                node.removeAttribute('data-incoming');
            }
        };

        const box = book.getBoundingClientRect();
        const at = slot?.getBoundingClientRect();
        if (!at?.width || !box.width) return reveal();

        const x = at.left - box.left;
        const y = at.top - box.top;
        // 出场位置：书的正中（书脊正上方）
        const cx = box.width / 2 - (x + at.width / 2);
        const cy = box.height / 2 - (y + at.height / 2);
        // 单页一张时卡槽高 74cqh，此时 u 恰好是 1cqh；单页四张时等比缩小
        const u = at.height / SLOT_HEIGHT_CQH;

        const veil = el(doc, 'div', 'ac-intro-veil', { 'aria-hidden': 'true' });
        const burst = el(doc, 'div', 'ac-intro-burst', { 'aria-hidden': 'true' });
        burst.style.width = `${128 * u}px`;
        const stage = el(doc, 'div', 'ac-intro', { 'aria-hidden': 'true' });
        stage.style.cssText = `left:${x}px;top:${y}px;width:${at.width}px;height:${at.height}px`;
        const mover = el(doc, 'div', 'ac-intro__card');
        const shadow = el(doc, 'div', 'ac-intro__shadow');
        shadow.style.filter = `blur(${2.6 * u}px)`;
        shadow.style.borderRadius = `${3 * u}px`;
        const flipper = el(doc, 'div', 'ac-intro__flip');
        const front = ghostFace(card, 'front');
        const back = ghostFace(card, 'back');
        const sheen = el(doc, 'div', 'ac-intro__sheen');
        sheen.append(el(doc, 'i'));
        front.firstChild.append(sheen);
        flipper.append(front, back);
        mover.append(shadow, flipper);
        mover.style.opacity = '0'; // 图还没加载好之前先藏着
        stage.append(mover);
        applyTone(front, card);
        book.append(stage);

        await imagesReady(stage);
        if (disposed) return;

        const { appear, flipAt, flip: flipMs, hold, fly: flyMs } = INTRO;
        const revealAt = flipAt + flipMs * 0.5;
        const flyAt = flipAt + flipMs + hold;
        const end = flyAt + flyMs;
        const sparks = sparkBurst(u, revealAt - 60);
        book.insertBefore(veil, stage);
        book.insertBefore(burst, stage);
        book.insertBefore(sparks, stage);

        const at01 = (ms) => ms / end;
        const pose = (dx, dy, scale, rotate = 0) => `translate(${dx}px, ${dy}px) rotate(${rotate}deg) scale(${scale})`;

        play(veil, [{ opacity: 0 }, { opacity: 1, offset: at01(appear) }, { opacity: 1, offset: at01(flyAt) }, { opacity: 0 }], {
            duration: end,
            easing: 'linear',
        });
        play(
            burst,
            [
                { opacity: 0, transform: 'translate(-50%, -50%) rotate(0deg) scale(0.55)' },
                { opacity: 0.5, transform: 'translate(-50%, -50%) rotate(6deg) scale(0.85)', offset: at01(appear) },
                { opacity: 1, transform: 'translate(-50%, -50%) rotate(16deg) scale(1.08)', offset: at01(revealAt + 120) },
                { opacity: 0.75, transform: 'translate(-50%, -50%) rotate(24deg) scale(1)', offset: at01(flyAt) },
                { opacity: 0, transform: 'translate(-50%, -50%) rotate(32deg) scale(1.2)' },
            ],
            { duration: end, easing: 'linear' },
        );
        play(
            shadow,
            [
                { opacity: 0, transform: `translateY(${7 * u}px) scaleX(1)` },
                { opacity: 0.8, transform: `translateY(${6 * u}px) scaleX(1)`, offset: at01(flipAt), easing: 'cubic-bezier(.6,0,.4,1)' },
                { opacity: 0.8, transform: `translateY(${6 * u}px) scaleX(0.1)`, offset: at01(revealAt), easing: 'cubic-bezier(.6,0,.4,1)' },
                { opacity: 0.8, transform: `translateY(${6 * u}px) scaleX(1)`, offset: at01(flipAt + flipMs) },
                { opacity: 0.8, transform: `translateY(${6 * u}px) scaleX(1)`, offset: at01(flyAt), easing: 'cubic-bezier(.55,0,.25,1)' },
                { opacity: 0.4, transform: `translateY(${1 * u}px) scaleX(0.97)` },
            ],
            { duration: end },
        );
        play(
            flipper,
            [
                { transform: 'rotateY(180deg)' },
                { transform: 'rotateY(180deg)', offset: at01(flipAt), easing: 'cubic-bezier(.62,0,.3,1)' },
                { transform: 'rotateY(-8deg)', offset: at01(flipAt + flipMs * 0.82), easing: 'ease-out' },
                { transform: 'rotateY(0deg)', offset: at01(flipAt + flipMs) },
                { transform: 'rotateY(0deg)' },
            ],
            { duration: end },
        );
        play(sheen.firstChild, [{ transform: 'translateX(-160%) skewX(-18deg)' }, { transform: 'translateX(330%) skewX(-18deg)' }], {
            duration: 760,
            delay: flipAt + flipMs * 0.7,
            easing: 'cubic-bezier(.3,.1,.3,1)',
        });
        const landed = play(
            mover,
            [
                { transform: pose(cx, cy + 12 * u, 0.66, -7), opacity: 0, easing: 'cubic-bezier(.2,.8,.2,1)' },
                { transform: pose(cx, cy, 1.1, -2.5), opacity: 1, offset: at01(appear), easing: 'ease-in-out' },
                { transform: pose(cx, cy - 1.5 * u, 1.2, 0), opacity: 1, offset: at01(revealAt), easing: 'ease-in-out' },
                { transform: pose(cx, cy, 1.12, 0), opacity: 1, offset: at01(flipAt + flipMs) },
                { transform: pose(cx, cy, 1.12, 0), opacity: 1, offset: at01(flyAt), easing: 'cubic-bezier(.55,0,.25,1)' },
                { transform: pose(0, 0, 0.975, 0), opacity: 1, offset: at01(flyAt + flyMs * 0.84), easing: 'ease-out' },
                { transform: pose(0, 0, 1, 0), opacity: 1 },
            ],
            { duration: end },
        );

        await landed;
        if (disposed) return;

        // 落槽：真卡现身、替身撤走（同一帧），卡槽亮一圈，徽章上掠过一道光
        reveal();
        const ring = el(doc, 'i', 'ac-intro-ring', { 'aria-hidden': 'true' });
        ring.style.borderRadius = `${3 * u}px`;
        ring.style.boxShadow =
            `0 0 0 ${0.35 * u}px rgba(255, 220, 120, 0.9), 0 0 ${4 * u}px ${1 * u}px rgba(255, 214, 89, 0.45)`;
        slot.append(ring);
        play(ring, [{ opacity: 0.95, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.12)' }], {
            duration: 820,
            easing: 'cubic-bezier(.2,.8,.2,1)',
        }).then(() => ring.remove());
        const real = slot.querySelector('.ac-card');
        real?.setAttribute('data-shine', '');
        later(() => real?.removeAttribute('data-shine'), 1600);

        await new Promise((resolve) => win.requestAnimationFrame(resolve));
        for (const node of [veil, burst, sparks, stage]) node.remove();
    }

    async function runIntro(newCards, appids) {
        const ids = new Set(appids);
        list = newCards;
        n = list.length;
        // 正序装订：新的在册子后面。从编号小的那张开始收，最后停在最新的那一张上。
        const targets = list
            .map((c, i) => (ids.has(c.appid) ? i : -1))
            .filter((i) => i >= 0)
            .sort((a, b) => b - a);
        // 单页四张时可以一次收满一页；单页一张时保留原来的 3 张上限
        const limit = perPage === 1 ? MAX_INTRO : perPage;
        const animated = reduceMotion?.matches ? [] : targets.slice(-limit);
        hidden = new Set(animated.map((i) => list[i].appid));

        // 让第一张新卡所在的那一页停在右页（正面朝上）
        let currentPage = pageOfIndex(animated[0] ?? targets.at(-1) ?? 0);
        k = Math.min(pageCount(), currentPage + 1);
        rebuild();

        for (let s = 0; s < animated.length; s += 1) {
            const i = animated[s];
            const page = pageOfIndex(i);
            if (page !== currentPage) {
                // 同页的新卡直接依次落槽；下一张在下一页就真的往后翻，跨页则直接摊到那一页
                if (page === currentPage + 1) await flip(1);
                else {
                    k = Math.min(pageCount(), page + 1);
                    rebuild();
                }
                currentPage = page;
            }
            if (disposed) return false;
            await wait(s === 0 ? 260 : 120);
            if (disposed) return false;
            await fly(i);
            if (disposed) return false;
        }

        hidden.clear();
        for (const slot of book.querySelectorAll('.ac-slot[data-incoming]')) slot.removeAttribute('data-incoming');
        live.textContent = STR.book.introduced(targets.map((i) => list[i].name).reverse());
        notifyPage();
        return true;
    }

    /**
     * 新收录的卡入册。newCards 是含新卡在内、已经排好序的整册；appids 是新卡。
     * @returns {Promise<boolean>} 播完为 true；书在中途被销毁为 false
     */
    function introduce(newCards, appids) {
        return new Promise((resolve) => {
            const settle = (done) => {
                if (finishIntro !== settle) return;
                finishIntro = null;
                introducing = false;
                delete book.dataset.intro;
                resolve(done);
            };
            const start = () => {
                if (disposed) return settle(false);
                if (busy) return later(start, 120);
                introducing = true;
                book.dataset.intro = '';
                resetTilt();
                runIntro(newCards, appids).then(
                    (done) => {
                        settle(done);
                        if (done && deferredCards) {
                            const next = deferredCards;
                            deferredCards = null;
                            api.replaceCards(next);
                        }
                    },
                    () => {
                        hidden.clear();
                        rebuild();
                        settle(true);
                    },
                );
            };
            finishIntro = settle;
            start();
        });
    }

    const api = {
        /** 当前页最靠前那张卡的列表下标（0 = 最新完成的那一张，落在最后一页） */
        get index() {
            return firstIndexOfPage(k);
        },
        get cards() {
            return list;
        },
        /** 当前页码（0 = 从 No.001 摊开的第一页） */
        get page() {
            return k;
        },
        get pageCount() {
            return pageCount();
        },
        /** 退出页面时记住用：页码 + 该页第一张卡的 appid */
        get position() {
            return currentPosition();
        },
        turn,
        introduce,
        /** 不做动画，直接摊开到第 index 张所在的那一页（那一页在右页） */
        goTo(index) {
            if (busy || disposed || introducing) return;
            resetTilt();
            const card = Math.max(0, Math.trunc(index) || 0);
            k = card >= n ? pageCount() : Math.min(pageCount(), pageOfIndex(card) + 1);
            layout();
            notifyPage();
        },
        /**
         * 就地换掉一张卡（完成日期是逐张补上来的，没必要整册重排）。
         * 找不到这张卡就什么都不做。
         */
        updateCard(appid, card) {
            if (disposed) return false;
            const i = list.findIndex((c) => c.appid === appid);
            if (i < 0) return false;
            list[i] = card;
            const leaf = leaves.get(pageOfIndex(i));
            if (!leaf) return true; // 不在可见窗口里，下次构建时自然用新数据
            for (const node of leaf.querySelectorAll(`.ac-card[data-index="${i}"]`)) {
                const side = node.dataset.side;
                const fresh = buildCard(i, side);
                node.replaceWith(fresh);
                if (side === 'back') applyTone(fresh.parentElement, card);
            }
            return true;
        },
        /**
         * 换一套卡片（补完日期后重新按完成时间装订）。
         * keepAppid 指定的那张卡会被摊开在同一个位置；atStart 则直接回到第一页。
         */
        replaceCards(newCards, { keepAppid = null, atStart = false } = {}) {
            if (disposed) return;
            if (introducing) {
                // 入册动画还在播：播完再重排，并且停在刚入册的那张上
                deferredCards = newCards;
                return;
            }
            resetTilt();
            const anchor = atStart ? null : keepAppid ?? list[firstIndexOfPage(k)]?.appid ?? null;
            list = newCards;
            n = list.length;
            if (anchor == null) k = 0;
            else {
                const anchorIndex = list.findIndex((c) => c.appid === anchor);
                k = anchorIndex >= 0 ? pageOfIndex(anchorIndex) : Math.min(k, pageCount());
            }
            rebuild();
            notifyPage();
        },
        destroy() {
            disposed = true;
            finishIntro?.(false);
            for (const anim of animations) anim.cancel();
            animations.clear();
            for (const id of timers) win.clearTimeout(id);
            timers.clear();
            if (frame) win.cancelAnimationFrame(frame);
            pages.removeEventListener('pointermove', onPointerMove);
            pages.removeEventListener('pointerleave', onPointerLeave);
            pages.removeEventListener('click', onClick);
            pages.removeEventListener('keydown', onKeyDown);
            album.removeEventListener('wheel', onWheel);
            ribbon.removeEventListener('pointerdown', onRibbonPointerDown);
            ribbon.removeEventListener('pointermove', onRibbonPointerMove);
            ribbon.removeEventListener('pointerup', onRibbonUp);
            ribbon.removeEventListener('pointercancel', onRibbonCancel);
            ribbon.removeEventListener('keydown', onRibbonKeyDown);
            pull = null;
            wheelQueue = [];
            wheelRunning = false;
            riffleStage = null;
            album.remove();
            leaves.clear();
        },
    };
    return api;
}
