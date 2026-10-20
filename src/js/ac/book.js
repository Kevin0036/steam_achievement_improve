/**
 * 成就收藏册 · 书本（翻页 + 悬停检视 + 新卡入册）
 *
 * 版式：一本摊开的集邮册。左页 = 已经翻过去的那一张卡的背面（游戏胶囊封面），
 *       右页 = 当前这一张卡的正面。按完成时间**倒序**装订：第一页是最近完美通关的游戏，
 *       往后翻越来越早。编号按完成先后排（最早的是 No.001）——新卡拿下一个号，旧卡的号永远不变。
 *
 * 结构：每一「页」占一叶（leaf），一页放 1 张或 4 张卡（主题设置「单页卡片数量」）。
 *       叶的正面是右页、背面是左页，翻页 = 整叶绕书脊转 180°。集邮册的内页是硬卡纸，
 *       所以这里刻意做成刚性翻转，再用明暗变化表现翻起与落下，而不是软纸卷曲。
 *         · 未翻的叶叠在右边，第 k 叶在最上面；
 *         · 已翻的叶叠在左边，第 k-1 叶在最上面；
 *         · 最底下各垫一张固定页：左边是「未完待续」（下一款打满的游戏会收在最前面，正挨着它），
 *           右边是扉页（翻到最后才看到）。
 *       k 是**页码**，不是卡片下标；卡片下标 = 页码 × perPage + 页内序号。
 *
 * 交互：
 *   · 鼠标悬停在卡片上 → 3D 检视（跟随指针倾斜 + 反光），离开回正；
 *   · 单击右页卡片 → 向后翻一页；单击左页卡片 → 向前翻回一页；
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
 * @returns {{ destroy(): void, turn(dir: 1|-1): void, goTo(index: number): void,
 *             updateCard(appid: number, card: object): boolean,
 *             replaceCards(cards: Array, options?: {keepAppid?: number|null, atStart?: boolean}): void,
 *             introduce(cards: Array, appids: number[]): Promise<boolean>,
 *             get cards(): Array, get index(): number }}
 */
export function createBook(container, { cards, owner = {}, perPage: requestedPerPage = 1 }) {
    const doc = container.ownerDocument;
    const win = doc.defaultView;
    const perPage = Number(requestedPerPage) === 4 ? 4 : 1;
    let list = cards;      // 卡片顺序会随完成日期的补全而重排
    let n = list.length;
    const reduceMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)');

    let k = 0; // 右页显示第 k 页；左页显示第 k-1 页的背面
    const pageCount = () => Math.ceil(n / perPage);
    let busy = false;
    let disposed = false;
    const leaves = new Map();
    const timers = new Set();
    const animations = new Set();

    /** 还没入册的新卡（卡槽先空着，等入册动画） */
    let hidden = new Set();
    let introducing = false;
    /** 入册动画期间来的整册重排，等动画播完再做 */
    let deferredCards = null;
    /** 入册动画的 resolve：书被销毁时用它告诉调用方「没播完」 */
    let finishIntro = null;

    /* ── 骨架 ─────────────────────────────────────────────────────────── */

    const album = el(doc, 'div', 'ac-album', { role: 'region', 'aria-label': STR.book.label });
    const book = el(doc, 'div', 'ac-book', { 'data-per-page': String(perPage) });
    const ribbon = el(doc, 'div', 'ac-book__ribbon', { 'aria-hidden': 'true' });
    const board = el(doc, 'div', 'ac-book__board', { 'aria-hidden': 'true' });
    const pages = el(doc, 'div', 'ac-book__pages');
    const live = el(doc, 'div', 'ac-sr-only', { 'aria-live': 'polite' });

    const endPage = buildEndPage();
    const titlePage = buildTitlePage();
    pages.append(endPage, titlePage);
    book.append(ribbon, board, pages);
    album.append(book, live);
    container.append(album);

    function paper(face) {
        face.append(el(doc, 'div', 'ac-page__paper', { 'aria-hidden': 'true' }));
    }

    function shade(face) {
        face.append(el(doc, 'div', 'ac-page__shade', { 'aria-hidden': 'true' }));
    }

    /** 扉页：倒序装订后在册子的最后，右边 */
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
        shade(page);
        return page;
    }

    /** 「未完待续」：倒序装订后在册子的最前面，左边 —— 下一款打满的游戏就收在它旁边 */
    function buildEndPage() {
        const page = el(doc, 'div', 'ac-page ac-page--left ac-page--base ac-page--end');
        paper(page);
        const box = el(doc, 'div', 'ac-end');
        box.append(el(doc, 'div', 'ac-end__mark', { 'aria-hidden': 'true' }));
        box.append(el(doc, 'div', 'ac-end__title', { text: STR.book.endTitle }));
        box.append(el(doc, 'div', 'ac-end__desc', { text: STR.book.endDesc }));
        page.append(box);
        // 翻页提示跟着「第一眼看到的那一页」走
        if (n > 0) page.append(el(doc, 'div', 'ac-title__hint', { text: STR.book.hint }));
        shade(page);
        return page;
    }

    function buildCard(i, side) {
        const card = list[i];
        const node = el(doc, 'div', 'ac-card', {
            role: 'button',
            tabindex: '-1',
            'data-side': side,
            'data-index': String(i),
            'aria-label': side === 'front' ? STR.card.front(card.name) : STR.card.back(card.name),
        });
        const tilt = el(doc, 'div', 'ac-card__tilt');
        tilt.append(side === 'front' ? createCardFront(doc, card, { owner }) : createCardBack(doc, card));
        node.append(el(doc, 'div', 'ac-card__shadow', { 'aria-hidden': 'true' }), tilt);
        return node;
    }

    function buildFace(page, side) {
        const face = el(doc, 'div', `ac-leaf__face ac-leaf__face--${side} ac-page ac-page--${side === 'front' ? 'right' : 'left'}`);
        paper(face);
        const from = page * perPage;
        const to = Math.min(n, from + perPage) - 1;
        for (let s = 0; s < perPage; s += 1) {
            const i = from + s;
            const slot = el(doc, 'div', 'ac-slot', { 'data-slot': String(s) });
            if (i <= to) {
                slot.dataset.index = String(i);
                slot.append(buildCard(i, side));
                // 待入册的卡单独藏起来（一页里其余已入册的卡照常显示）
                if (hidden.has(list[i].appid)) slot.setAttribute('data-incoming', '');
            } else {
                slot.classList.add('ac-slot--empty');
            }
            face.append(slot);
        }
        // 编号按完成先后：倒序装订，第 i 张是第 n-i 个打满的
        const folio = perPage === 1 ? formatSerial(n - from) : formatSerialRange(n - to, n - from);
        face.append(el(doc, 'div', 'ac-page__folio', { text: folio, 'aria-hidden': 'true' }));
        shade(face);
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
        for (const slot of front.querySelectorAll('.ac-slot[data-index]')) {
            applyTone(slot, list[Number(slot.dataset.index)]);
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
            // 右边一摞：第 k 叶在最上；左边一摞：第 k-1 叶在最上
            leaf.style.zIndex = String(turned ? 100 - (k - 1 - i) : 100 - (i - k));
            const visible = i === k || i === k - 1;
            leaf.toggleAttribute('data-visible', visible);
            for (const card of leaf.querySelectorAll('.ac-card')) {
                const active = (card.dataset.side === 'front' && i === k) || (card.dataset.side === 'back' && i === k - 1);
                // 待入册的卡槽还是空的，别让键盘焦点落进去
                card.tabIndex = active && !card.closest('.ac-slot[data-incoming]') ? 0 : -1;
            }
        }

        book.dataset.leftDepth = String(depthLevel(k));
        book.dataset.rightDepth = String(depthLevel(total - k));
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

    /** 右页 / 左页当前那一面（叶的某一面，或底下的固定页） */
    const rightFace = (index) =>
        index < pageCount() ? leaves.get(index)?.querySelector('.ac-leaf__face--front') : titlePage;
    const leftFace = (index) => (index >= 0 ? leaves.get(index)?.querySelector('.ac-leaf__face--back') : endPage);

    function later(fn, ms) {
        const id = win.setTimeout(() => {
            timers.delete(id);
            fn();
        }, ms);
        timers.add(id);
    }

    const wait = (ms) => new Promise((resolve) => later(resolve, ms));

    function turn(dir) {
        if (busy || disposed || introducing) return;
        const focusAfter = album.contains(doc.activeElement);
        flip(dir).then((moved) => {
            if (moved) afterTurn(dir, focusAfter);
        });
    }

    /** 翻一页的动画本体，翻完 resolve(true)；没有可翻的叶时 resolve(false) */
    function flip(dir) {
        const i = dir > 0 ? k : k - 1;
        const leaf = leaves.get(i);
        if (!leaf) return Promise.resolve(false);

        resetTilt();

        if (reduceMotion?.matches) {
            k += dir;
            layout();
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
            mark(rightFace(k + 1), 'reveal');
            mark(leftFace(k - 1), 'cover');
        } else {
            mark(back, 'dim');
            mark(front, 'light');
            mark(leftFace(k - 2), 'reveal');
            mark(rightFace(k), 'cover');
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
                resolve(true);
            }, TURN_MS + 30);
        });
    }

    function afterTurn(dir, focusAfter) {
        const first = (dir > 0 ? k : k - 1) * perPage;
        const card = list[first];
        live.textContent = card ? `${formatPosition()} ${card.name}` : dir > 0 ? STR.book.title : STR.book.endTitle;
        if (!focusAfter) return;
        // 键盘用户：焦点留在刚才操作的那一侧（一页多张时落在该页第一张）
        const side = dir > 0 ? 'front' : 'back';
        (album.querySelector(`.ac-card[data-side="${side}"][data-index="${first}"]`) ?? album).focus?.({
            preventScroll: true,
        });
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

    pages.addEventListener('pointermove', onPointerMove);
    pages.addEventListener('pointerleave', onPointerLeave);
    pages.addEventListener('click', onClick);
    pages.addEventListener('keydown', onKeyDown);

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

    /** 等替身卡上的图加载出来再开演，最多等 1.5 秒 */
    function imagesReady(root) {
        const pending = [...root.querySelectorAll('img')].map(
            (img) =>
                new Promise((resolve) => {
                    if (img.complete && img.naturalWidth > 0) return resolve();
                    img.addEventListener('load', resolve);
                    // 候选链换下一张时也会报 error；整条链都失败了才算完
                    img.addEventListener('error', () => win.setTimeout(() => img.dataset.missing !== undefined && resolve(), 0));
                }),
        );
        return Promise.race([Promise.all(pending), wait(1500)]);
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
     * 调用前第 i 叶已经在右页、卡槽空着（data-incoming）。
     */
    async function fly(i) {
        const card = list[i];
        const page = Math.floor(i / perPage);
        const leaf = leaves.get(page);
        const slot = leaf?.querySelector(`.ac-leaf__face--front .ac-slot[data-index="${i}"]`);
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
        // 倒序装订：下标越大越早。从最早的一张开始收，最后停在最新的那一张上
        const targets = list
            .map((c, i) => (ids.has(c.appid) ? i : -1))
            .filter((i) => i >= 0)
            .sort((a, b) => b - a);
        // 单页四张时可以一次收满一页；单页一张时保留原来的 3 张上限
        const limit = perPage === 1 ? MAX_INTRO : perPage;
        const animated = reduceMotion?.matches ? [] : targets.slice(-limit);
        hidden = new Set(animated.map((i) => list[i].appid));

        k = Math.floor((animated[0] ?? targets.at(-1) ?? 0) / perPage);
        rebuild();

        let currentPage = k;
        for (let s = 0; s < animated.length; s += 1) {
            const i = animated[s];
            const page = Math.floor(i / perPage);
            if (page !== currentPage) {
                // 同页的新卡直接依次落槽；换页时真的往前翻一页，不挨着就直接摊开到那里
                if (page === k - 1) await flip(-1);
                else {
                    k = page;
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
        /** 当前右页第一张卡的卡片下标（page.js 用它把正在看的那张留在原处） */
        get index() {
            return k * perPage;
        },
        get cards() {
            return list;
        },
        turn,
        introduce,
        /** 不做动画，直接摊开到第 index 张所在的那一页（0 = 「未完待续」+ 最新的一张） */
        goTo(index) {
            if (busy || disposed || introducing) return;
            resetTilt();
            const card = Math.max(0, Math.trunc(index) || 0);
            k = card >= n ? pageCount() : Math.floor(card / perPage);
            layout();
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
            const leaf = leaves.get(Math.floor(i / perPage));
            if (!leaf) return true; // 不在可见窗口里，下次构建时自然用新数据
            for (const node of leaf.querySelectorAll(`.ac-card[data-index="${i}"]`)) {
                const side = node.dataset.side;
                const fresh = buildCard(i, side);
                node.replaceWith(fresh);
                if (side === 'front') applyTone(fresh.parentElement, card);
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
            const anchor = atStart ? null : keepAppid ?? list[k * perPage]?.appid ?? null;
            list = newCards;
            n = list.length;
            const anchorIndex = anchor == null ? 0 : Math.max(0, list.findIndex((c) => c.appid === anchor));
            k = Math.floor(anchorIndex / perPage);
            rebuild();
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
            album.remove();
            leaves.clear();
        },
    };
    return api;
}
