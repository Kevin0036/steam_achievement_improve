/**
 * 成就收藏册 · 第一次进入的引导
 *
 * 聚光灯式：其余区域压暗，一步只照亮一个真实的东西，旁边用一句话说明。
 * 翻页、书签和封面取景这几步可以真的动手，做到了自动走下一步。
 * 看过一次就记进 localStorage，之后可以在设置面板里重新打开。
 *
 * 纯 DOM，不依赖 React，预览页和 Steam 里的卡包用的是同一份代码。
 */

import STR from './strings.js';

const KEY = 'ac:v1:onboarding';
/**
 * 引导的版本，记在 KEY 里。引导大改时加一，所有人升级后会再看一遍。
 *   1：1.2.1 及以前的文字引导（当时只记 '1'）
 *   2：1.2.2 的聚光灯引导。用得少的老用户可能还不熟悉基本操作，所以让大家都再看一次
 */
const GUIDE_VERSION = 2;
const TREE_NOTICE_KEY = 'ac:v1:notice:year-tree';

function el(doc, tag, className, { text = null, attrs = null } = {}) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value != null) node.setAttribute(name, String(value));
    }
    return node;
}

/**
 * 没看过当前版本的引导才自动显示；localStorage 不可用时按「没看过」处理（每次进来都提示）。
 * 按大小比较而不是判断相等：以后再加版本，看过更新引导的人不会被旧值误判。
 */
export function shouldShowOnboarding() {
    try {
        return !(Number(localStorage.getItem(KEY)) >= GUIDE_VERSION);
    } catch {
        return true;
    }
}

export function markOnboardingSeen() {
    try {
        localStorage.setItem(KEY, String(GUIDE_VERSION));
    } catch {
        /* 无痕 / 权限受限时只影响下次是否再提示，不影响卡册本身 */
    }
}

/** 1.1.6 的「年度之树」尝鲜提示：只在升级后弹一次 */
export function shouldShowTreeNotice() {
    try {
        return localStorage.getItem(TREE_NOTICE_KEY) !== '1';
    } catch {
        return true;
    }
}

export function markTreeNoticeSeen() {
    try {
        localStorage.setItem(TREE_NOTICE_KEY, '1');
    } catch {
        /* 同上：只影响是否再提示 */
    }
}

/**
 * 年度之树的尝鲜提示（单页，没有翻页圆点）。
 *
 * @param {HTMLElement} host 卡册宿主节点
 * @param {{onOpenSettings?: () => void, onClose?: () => void}} [hooks]
 * @returns {{ close(): void, destroy(): void }}
 */
export function showTreeNotice(host, { onOpenSettings = null, onClose = null } = {}) {
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    let closed = false;

    const root = el(doc, 'div', 'ac-onboarding ac-onboarding--notice', {
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ac-tree-notice-title' },
    });
    const backdrop = el(doc, 'div', 'ac-onboarding__backdrop', { attrs: { 'aria-hidden': 'true' } });
    const panel = el(doc, 'div', 'ac-onboarding__panel');

    const head = el(doc, 'div', 'ac-onboarding__head');
    head.append(
        el(doc, 'div', 'ac-onboarding__badge', { attrs: { 'aria-hidden': 'true' } }),
        el(doc, 'div', 'ac-onboarding__eyebrow', { text: STR.notice.eyebrow }),
    );

    const slide = el(doc, 'div', 'ac-onboarding__slide');
    const title = el(doc, 'h2', 'ac-onboarding__title', { text: STR.notice.title });
    title.id = 'ac-tree-notice-title';
    const desc = el(doc, 'p', 'ac-onboarding__desc', { text: STR.notice.desc });
    const points = el(doc, 'ul', 'ac-onboarding__points');
    for (const point of STR.notice.points) points.append(el(doc, 'li', null, { text: point }));
    slide.append(title, desc, points);

    const foot = el(doc, 'div', 'ac-onboarding__foot ac-onboarding__foot--notice');
    const later = el(doc, 'button', 'ac-onboarding__prev', { text: STR.notice.later, attrs: { type: 'button' } });
    foot.append(later);
    let open = null;
    if (typeof onOpenSettings === 'function') {
        open = el(doc, 'button', 'ac-onboarding__next is-finish', { text: STR.notice.open, attrs: { type: 'button' } });
        foot.append(open);
    }

    const closeButton = el(doc, 'button', 'ac-onboarding__close', {
        text: '×',
        attrs: { type: 'button', 'aria-label': STR.notice.close },
    });

    function close() {
        if (closed) return;
        closed = true;
        win?.removeEventListener('keydown', onKeyDown, true);
        root.remove();
        onClose?.();
    }

    function onKeyDown(event) {
        if (event.defaultPrevented) return;
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    }

    later.addEventListener('click', close);
    open?.addEventListener('click', () => {
        close();
        onOpenSettings();
    });
    closeButton.addEventListener('click', close);
    root.addEventListener('click', (event) => {
        if (event.target === root || event.target === backdrop) close();
    });

    panel.append(head, slide, foot, closeButton);
    root.append(backdrop, panel);
    host.append(root);
    win?.addEventListener('keydown', onKeyDown, true);
    (open ?? later).focus?.({ preventScroll: true });

    return { close, destroy: close, get root() { return root; } };
}

/* ── 新手引导 ───────────────────────────────────────────────────────────── */

const HOLE_PAD = 10;
const HOLE_RADIUS = 16;
const TIP_GAP = 18;
const TIP_EDGE = 12;
/** 目标会动（翻页、窗口缩放、册子重建），定时量一次比挂一圈监听简单 */
const TICK_MS = 160;
/** 试完之后停一下，让人看清结果再走 */
const DONE_HOLD_MS = 900;
/** 进入时要摊开书页的步骤，书页就位前先不判定目标没了 */
const ENTER_GRACE_MS = 800;
const TIP_SIDES = ['left', 'right', 'bottom', 'top'];

/** 这一对开页最靠前的一张卡。照卡槽不照卡：卡片跟着鼠标倾斜，聚光灯不能跟着晃。年份页这类没有卡的跨页就照整本书 */
function cardSlot(scope) {
    const cards = scope.querySelectorAll('.ac-leaf[data-visible] .ac-card');
    for (const card of cards) {
        const slot = card.closest('.ac-slot');
        if (card.tabIndex === 0 && slot && !slot.hasAttribute('data-incoming')) return slot;
    }
    return null;
}

function visibleCard(scope) {
    return cardSlot(scope) ?? scope.querySelector('.ac-book__pages');
}

/** 讲卡片的步骤：停在扉页、年份页这类没有卡的跨页时，先摊开到最近的一页卡，不然照不到卡、也没法试取景 */
function showCards(scope, book) {
    if (!cardSlot(scope)) book?.showNearestCards?.();
}

/** 点了能翻过去的那一页：平时是右页；翻到头时右页翻不动，改照左页 */
function turnablePage(scope) {
    const book = scope.querySelector('.ac-book');
    const pages = scope.querySelector('.ac-book__pages');
    if (!book || !pages) return null;
    const rect = pages.getBoundingClientRect();
    const stuck = book.hasAttribute(book.dataset.binding === 'sequential' ? 'data-at-end' : 'data-at-start');
    return { left: stuck ? rect.left : rect.left + rect.width / 2, top: rect.top, right: stuck ? rect.left + rect.width / 2 : rect.right, bottom: rect.bottom };
}

/** 书签大半截夹在书页里，只照露在书外的那一段 */
function ribbonTail(scope) {
    const ribbon = scope.querySelector('.ac-book__ribbon');
    const book = scope.querySelector('.ac-book');
    if (!ribbon || !book) return null;
    const rect = ribbon.getBoundingClientRect();
    return { left: rect.left, top: book.getBoundingClientRect().bottom, right: rect.right, bottom: rect.bottom };
}

/**
 * 书口两侧都可能有标签，照标签多的那一列。
 * 照标签本身合起来的范围，不照那一列的容器：容器宽度是 0，标签是绝对定位伸在它外面的
 */
function yearTabs(scope) {
    let best = null;
    for (const strip of scope.querySelectorAll('.ac-book__tabs')) {
        const rects = [...strip.querySelectorAll('.ac-book__tab')]
            .map((tab) => tab.getBoundingClientRect())
            .filter((rect) => rect.width > 0 && rect.height > 0);
        if (rects.length > (best?.length ?? 0)) best = rects;
    }
    if (!best) return null;
    return {
        left: Math.min(...best.map((r) => r.left)),
        top: Math.min(...best.map((r) => r.top)),
        right: Math.max(...best.map((r) => r.right)),
        bottom: Math.max(...best.map((r) => r.bottom)),
    };
}

/** 月份足迹那一页；点开某个月以后，详情也铺在同一页上 */
function yearMonthsPage(scope) {
    return scope.querySelector('.ac-leaf[data-visible] .ac-yf--months')?.closest('.ac-page') ?? null;
}

const monthOpened = (scope) => Boolean(scope.querySelector('.ac-leaf[data-visible] .ac-yf__detail:not([hidden])'));

const within = (selector) => (scope) => scope.querySelector(selector);

/**
 * 引导的每一步。target 返回要照亮的节点或矩形，找不到就跳过这一步；
 * available 有的话代替 target 判断这一步有没有（目标要先翻过去才看得到的步骤），enter 在进入这一步时调用；
 * tryIt 表示这一步可以真的动手：聚光灯范围内的鼠标操作会落到册子上，做到了自动走下一步；hold 是做到之后停多久。
 */
const GUIDE_STEPS = [
    { key: 'card', target: visibleCard, enter: showCards, prefer: ['left', 'right'] },
    { key: 'turn', target: turnablePage, prefer: ['left', 'right'], tryIt: 'page', pad: 0 },
    { key: 'ribbon', target: ribbonTail, prefer: ['top'], tryIt: 'page', pad: 16 },
    { key: 'cover', target: visibleCard, enter: showCards, prefer: ['left', 'right'], tryIt: 'cover' },
    { key: 'tabs', target: yearTabs, prefer: ['left', 'right'], pad: 6 },
    {
        key: 'months',
        target: yearMonthsPage,
        // 月份足迹在每年开头，平时不在眼前：册子里有就算这一步，进入时摊开过去
        available: (scope, book) => Boolean(yearMonthsPage(scope) || book?.hasYearMonths),
        enter: (scope, book) => {
            if (!yearMonthsPage(scope)) book?.showYearMonths?.();
        },
        prefer: ['left', 'right'],
        tryIt: 'month',
        pad: 4,
        // 展开要放大一下，多停一会儿让人看清这个月的列表
        hold: 1600,
    },
    { key: 'date', target: within('.ac-date-open'), prefer: ['bottom'], pad: 6 },
    { key: 'settings', target: within('.ac-plugin-settings'), prefer: ['bottom'], pad: 6 },
    { key: 'borrow', target: within('.ac-borrow-open'), prefer: ['bottom'], pad: 6 },
];

/** 整层遮罩上挖一个圆角矩形的洞。洞也挖掉了点击范围，所以遮罩一个节点就能同时管明暗和拦截 */
function holePath({ x, y, w, h, width, height }) {
    const r = Math.min(HOLE_RADIUS, w / 2, h / 2);
    const n = (value) => Number(value.toFixed(1));
    return `path(evenodd, "M0 0H${n(width)}V${n(height)}H0Z`
        + `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}`
        + `V${n(y + h - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}`
        + `H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}`
        + `V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z")`;
}

/** 说明框放在目标哪一侧：先按这一步的偏好，放不下就挑空间最大的一侧，再贴着窗口边收回来 */
function placeTip(hole, tipWidth, tipHeight, prefer) {
    const room = {
        left: hole.x - TIP_GAP - TIP_EDGE,
        right: hole.width - hole.x - hole.w - TIP_GAP - TIP_EDGE,
        top: hole.y - TIP_GAP - TIP_EDGE,
        bottom: hole.height - hole.y - hole.h - TIP_GAP - TIP_EDGE,
    };
    const fits = (side) => room[side] >= (side === 'left' || side === 'right' ? tipWidth : tipHeight);
    const side = [...prefer, ...TIP_SIDES].find(fits)
        ?? TIP_SIDES.reduce((best, item) => (room[item] > room[best] ? item : best));

    const clamp = (value, max) => Math.max(TIP_EDGE, Math.min(max, value));
    const centerX = hole.x + hole.w / 2;
    const centerY = hole.y + hole.h / 2;
    const horizontal = side === 'left' || side === 'right';
    const left = horizontal
        ? clamp(side === 'left' ? hole.x - TIP_GAP - tipWidth : hole.x + hole.w + TIP_GAP, hole.width - tipWidth - TIP_EDGE)
        : clamp(centerX - tipWidth / 2, hole.width - tipWidth - TIP_EDGE);
    const top = horizontal
        ? clamp(centerY - tipHeight / 2, hole.height - tipHeight - TIP_EDGE)
        : clamp(side === 'top' ? hole.y - TIP_GAP - tipHeight : hole.y + hole.h + TIP_GAP, hole.height - tipHeight - TIP_EDGE);
    // 箭头跟着目标走，框被窗口边推开时箭头仍然指着目标
    const arrow = horizontal
        ? Math.max(18, Math.min(tipHeight - 18, centerY - top))
        : Math.max(18, Math.min(tipWidth - 18, centerX - left));
    return { side, left, top, arrow };
}

/**
 * @param {HTMLElement} host 卡册外层（.ac-cardpack）：引导要照到工具条，册子重建也不能把它带走
 * @param {{getBook?: () => ?{page: number}, onClose?: () => void}} [options]
 * @returns {{ close(): void, destroy(): void }}
 */
export function showOnboarding(host, { getBook = null, onClose = null } = {}) {
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    /**
     * 从第 from 步起往 dir 方向找下一个目标还在的步骤，没有就是 -1。
     * 不在打开时一次定死：补日期按钮可能晚出现，也可能填完就没了，每次换步都重新点名。
     */
    const has = (step) => Boolean((step.available ?? step.target)(host, getBook?.()));
    const seek = (from, dir) => {
        for (let i = from; i >= 0 && i < GUIDE_STEPS.length; i += dir) {
            if (has(GUIDE_STEPS[i])) return i;
        }
        return -1;
    };
    let index = seek(0, 1);
    // 册子正好在重建时一个目标都找不到：直接收场，别在 Steam 的界面里抛错
    if (index < 0) {
        onClose?.();
        return { close() {}, destroy() {}, root: null };
    }
    const reduceMotion = win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let closed = false;
    let lastHole = null;
    /** 进入这一步时翻到第几页，翻过去了才算试成 */
    let startPage = null;
    let coverOpened = false;
    let done = false;
    let doneTimer = 0;
    let enteredAt = Date.now();

    const root = el(doc, 'div', 'ac-guide', {
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': STR.onboarding.label },
    });
    const mask = el(doc, 'div', 'ac-guide__mask', { attrs: { 'aria-hidden': 'true' } });
    const shield = el(doc, 'div', 'ac-guide__shield', { attrs: { 'aria-hidden': 'true' } });
    const ring = el(doc, 'div', 'ac-guide__ring', { attrs: { 'aria-hidden': 'true' } });
    const tip = el(doc, 'div', 'ac-guide__tip');

    const head = el(doc, 'div', 'ac-guide__head');
    const count = el(doc, 'span', 'ac-guide__count');
    const skip = el(doc, 'button', 'ac-guide__skip', { text: STR.onboarding.skip, attrs: { type: 'button' } });
    head.append(count, skip);

    const body = el(doc, 'div', 'ac-guide__body', { attrs: { 'aria-live': 'polite', 'aria-atomic': 'true' } });
    const title = el(doc, 'h2', 'ac-guide__title');
    const desc = el(doc, 'p', 'ac-guide__desc');
    const status = el(doc, 'p', 'ac-guide__status');
    body.append(title, desc, status);

    const foot = el(doc, 'div', 'ac-guide__foot');
    const prev = el(doc, 'button', 'ac-guide__prev', { text: STR.onboarding.prev, attrs: { type: 'button' } });
    const next = el(doc, 'button', 'ac-guide__next', { attrs: { type: 'button' } });
    foot.append(prev, next);
    tip.append(head, body, foot);

    function setNudge(on) {
        host.querySelector('.ac-book__ribbon')?.toggleAttribute('data-guide-nudge', on);
    }

    /** 量一次目标，有变化才重画：每次都写样式的话，遮罩的过渡动画会被不停打断 */
    function sync(force = false) {
        const step = GUIDE_STEPS[index];
        const found = step.target(host);
        if (!found) return;
        const box = root.getBoundingClientRect();
        const rect = typeof found.getBoundingClientRect === 'function' ? found.getBoundingClientRect() : found;
        const pad = step.pad ?? HOLE_PAD;
        const x = Math.max(2, rect.left - box.left - pad);
        const y = Math.max(2, rect.top - box.top - pad);
        const right = Math.min(box.width - 2, rect.right - box.left + pad);
        const bottom = Math.min(box.height - 2, rect.bottom - box.top + pad);
        const hole = { x, y, w: right - x, h: bottom - y, width: box.width, height: box.height };
        const same = lastHole && Object.keys(hole).every((key) => Math.abs(hole[key] - lastHole[key]) < 0.5);
        if (same && !force) return;
        lastHole = hole;

        mask.style.clipPath = holePath(hole);
        ring.style.left = `${hole.x}px`;
        ring.style.top = `${hole.y}px`;
        ring.style.width = `${hole.w}px`;
        ring.style.height = `${hole.h}px`;
        ring.style.borderRadius = `${Math.min(HOLE_RADIUS, hole.w / 2, hole.h / 2)}px`;

        const place = placeTip(hole, tip.offsetWidth, tip.offsetHeight, step.prefer);
        tip.dataset.side = place.side;
        tip.style.left = `${place.left}px`;
        tip.style.top = `${place.top}px`;
        tip.style.setProperty('--ac-guide-arrow', `${place.arrow}px`);
    }

    function render() {
        const step = GUIDE_STEPS[index];
        const text = STR.onboarding.steps[step.key];
        const shown = GUIDE_STEPS.filter((item) => item === step || has(item));
        count.textContent = STR.onboarding.count(shown.indexOf(step) + 1, shown.length);
        title.textContent = text.title;
        desc.textContent = text.desc;
        status.textContent = step.tryIt ? STR.onboarding.tryHint : '';
        status.hidden = !step.tryIt;

        const last = seek(index + 1, 1) < 0;
        prev.disabled = seek(index - 1, -1) < 0;
        next.textContent = last ? STR.onboarding.start : STR.onboarding.next;
        next.classList.toggle('is-finish', last);

        root.toggleAttribute('data-try', Boolean(step.tryIt));
        root.classList.remove('is-done');
        setNudge(step.key === 'ribbon');

        sync(true);
        next.focus?.({ preventScroll: true });
        tip.classList.remove('is-enter');
        if (!reduceMotion) {
            void tip.offsetWidth;
            tip.classList.add('is-enter');
        }
    }

    function go(to) {
        if (closed || to < 0) return;
        win.clearTimeout(doneTimer);
        index = to;
        done = false;
        coverOpened = false;
        enteredAt = Date.now();
        GUIDE_STEPS[index].enter?.(host, getBook?.());
        startPage = getBook?.()?.page ?? null;
        render();
    }

    function markDone() {
        done = true;
        root.classList.add('is-done');
        status.textContent = STR.onboarding.tryDone;
        doneTimer = win.setTimeout(forward, GUIDE_STEPS[index].hold ?? DONE_HOLD_MS);
    }

    /** 翻页是否已经完成：快速翻阅途中页码就变了，要等书页落定 */
    function turned() {
        const page = getBook?.()?.page;
        return page != null && startPage != null && page !== startPage && !host.querySelector('.ac-riffle');
    }

    /** 下一步；已经是最后一步就收场 */
    function forward() {
        const to = seek(index + 1, 1);
        if (to < 0) close();
        else go(to);
    }

    function tick() {
        const step = GUIDE_STEPS[index];
        // 封面取景是全屏编辑器：引导先让开，编辑完再回来
        const editing = Boolean(host.querySelector('.ac-coveredit'));
        root.classList.toggle('is-away', editing);
        if (editing) {
            coverOpened = true;
            return;
        }
        // 正在讲的东西不见了（比如补日期按钮）：别对着空处讲，直接往下走。
        // 刚摊开过去的那一下书页可能还没就位，先等一等
        if (!step.target(host)) {
            if (step.enter && Date.now() - enteredAt < ENTER_GRACE_MS) return;
            forward();
            return;
        }
        if (
            !done
            && ((step.tryIt === 'page' && turned())
                || (step.tryIt === 'cover' && coverOpened)
                || (step.tryIt === 'month' && monthOpened(host)))
        ) markDone();
        setNudge(step.key === 'ribbon');
        sync();
    }

    function close() {
        if (closed) return;
        closed = true;
        win.clearInterval(timer);
        win.clearTimeout(doneTimer);
        doc.removeEventListener('keydown', onKeyDown, true);
        setNudge(false);
        root.classList.add('is-leaving');
        const fade = reduceMotion ? null : root.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' });
        if (fade) fade.finished.catch(() => {}).then(() => root.remove());
        else root.remove();
        onClose?.();
    }

    function onKeyDown(event) {
        if (event.defaultPrevented || root.classList.contains('is-away')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            go(event.key === 'ArrowRight' ? seek(index + 1, 1) : seek(index - 1, -1));
        }
    }

    prev.addEventListener('click', () => go(seek(index - 1, -1)));
    next.addEventListener('click', forward);
    skip.addEventListener('click', close);

    // 遮罩和说明框上的滚轮不能漏到册子；聚光灯里的滚轮直接落在册子上，到不了这里
    root.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });

    root.append(mask, shield, ring, tip);
    host.append(root);
    GUIDE_STEPS[index].enter?.(host, getBook?.());
    startPage = getBook?.()?.page ?? null;
    render();
    doc.addEventListener('keydown', onKeyDown, true);
    const timer = win.setInterval(tick, TICK_MS);

    return { close, destroy: close, get root() { return root; } };
}
