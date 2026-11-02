/**
 * 成就收藏册 · 第一次进入的引导
 *
 * 一页只讲一件事：点「下一页」逐步认识卡册，最后一页收下。
 * 看过一次就记进 localStorage，之后可以在设置面板里重新打开。
 *
 * 纯 DOM，挂在卡册内部的宿主节点上（position: absolute + inset: 0），
 * 不依赖 React，预览页和 Steam 里的卡包用的是同一份代码。
 */

import STR from './strings.js';

const KEY = 'ac:v1:onboarding';
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

/** 第一次进入才自动显示；localStorage 不可用时按「没看过」处理（每次进来都提示） */
export function shouldShowOnboarding() {
    try {
        return localStorage.getItem(KEY) !== '1';
    } catch {
        return true;
    }
}

export function markOnboardingSeen() {
    try {
        localStorage.setItem(KEY, '1');
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

/**
 * @param {HTMLElement} host 卡册宿主节点（会盖住整个容器）
 * @param {{yearPages?: boolean}} [options]
 * @param {{onClose?: () => void}} [hooks]
 * @returns {{ close(): void, destroy(): void }}
 */
export function showOnboarding(host, { yearPages = false } = {}, { onClose = null } = {}) {
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    const slides = STR.onboarding.slides;
    const total = slides.length;
    const reduceMotion = win?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let index = 0;
    let closed = false;

    const root = el(doc, 'div', 'ac-onboarding', {
        attrs: {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'ac-onboarding-title',
        },
    });
    const backdrop = el(doc, 'div', 'ac-onboarding__backdrop', { attrs: { 'aria-hidden': 'true' } });
    const panel = el(doc, 'div', 'ac-onboarding__panel');

    const head = el(doc, 'div', 'ac-onboarding__head');
    head.append(el(doc, 'div', 'ac-onboarding__badge', { attrs: { 'aria-hidden': 'true' } }));
    head.append(el(doc, 'div', 'ac-onboarding__eyebrow', { text: STR.onboarding.eyebrow }));
    panel.append(head);

    const slideBox = el(doc, 'div', 'ac-onboarding__slide', {
        attrs: { role: 'group', 'aria-live': 'polite', 'aria-atomic': 'true' },
    });
    const title = el(doc, 'h2', 'ac-onboarding__title');
    title.id = 'ac-onboarding-title';
    const desc = el(doc, 'p', 'ac-onboarding__desc');
    slideBox.append(title, desc);
    panel.append(slideBox);

    const dots = el(doc, 'div', 'ac-onboarding__dots', { attrs: { role: 'group', 'aria-label': STR.onboarding.stepsLabel } });
    const dotButtons = slides.map((slide, i) => {
        const dot = el(doc, 'button', 'ac-onboarding__dot', {
            text: String(i + 1),
            attrs: { type: 'button', 'aria-label': STR.onboarding.step(i + 1, slide.title) },
        });
        dot.addEventListener('click', () => go(i));
        dots.append(dot);
        return dot;
    });
    panel.append(dots);

    const foot = el(doc, 'div', 'ac-onboarding__foot');
    const prev = el(doc, 'button', 'ac-onboarding__prev', { text: STR.onboarding.prev, attrs: { type: 'button' } });
    const next = el(doc, 'button', 'ac-onboarding__next', { attrs: { type: 'button' } });
    foot.append(prev, next);
    panel.append(foot);

    const closeButton = el(doc, 'button', 'ac-onboarding__close', {
        text: '×',
        attrs: { type: 'button', 'aria-label': STR.onboarding.close },
    });
    panel.append(closeButton);

    function render() {
        const slide = slides[index];
        const text = slide.descOn && slide.descOff ? (yearPages ? slide.descOn : slide.descOff) : slide.desc;

        title.textContent = slide.title;
        desc.textContent = text;

        prev.disabled = index === 0;
        next.textContent = index === total - 1 ? STR.onboarding.start : STR.onboarding.next;
        next.classList.toggle('is-finish', index === total - 1);
        dotButtons.forEach((dot, i) => {
            dot.classList.toggle('is-active', i === index);
            if (i === index) dot.setAttribute('aria-current', 'step');
            else dot.removeAttribute('aria-current');
        });

        slideBox.classList.remove('is-enter');
        if (!reduceMotion) {
            void slideBox.offsetWidth;
            slideBox.classList.add('is-enter');
        }
    }

    function go(to) {
        if (closed || to < 0 || to >= total || to === index) return;
        index = to;
        render();
    }

    function close() {
        if (closed) return;
        closed = true;
        doc.removeEventListener('keydown', onKeyDown, true);
        root.remove();
        onClose?.();
    }

    function onKeyDown(event) {
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
            return;
        }
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault();
            event.stopPropagation();
            go(index + (event.key === 'ArrowRight' ? 1 : -1));
        }
    }

    prev.addEventListener('click', () => go(index - 1));
    next.addEventListener('click', () => {
        if (index === total - 1) close();
        else go(index + 1);
    });
    closeButton.addEventListener('click', close);
    root.addEventListener('click', (event) => {
        if (event.target === root || event.target === backdrop) close();
    });

    // 打开时把背后的书页钉住：滚轮不应该漏到册子上
    root.addEventListener('wheel', (event) => event.preventDefault(), { passive: false });

    root.append(backdrop, panel);
    host.append(root);
    render();
    next.focus?.({ preventScroll: true });

    doc.addEventListener('keydown', onKeyDown, true);

    return { close, destroy: close, get root() { return root; } };
}
