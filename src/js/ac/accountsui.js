/**
 * 多账号管理对话框
 *
 * 主题版从阅读设置里打开，插件版从插件设置里打开（挂到 body 上）。
 * 只做三件事：开关合并、管理来源（本机借阅记录 / 手动 9 位借阅码）、刷新快照。
 * 来源列表刻意不显示 token / accountId，只显示昵称、借阅码和取回状态。
 */

import { ensureNodeStyles } from './env.js';
import { STR } from './strings.js';
import * as store from './store.js';

function el(doc, tag, className, { text = null, attrs = null } = {}) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value != null) node.setAttribute(name, String(value));
    }
    return node;
}

function dayLabel(seconds) {
    if (!seconds) return STR.accounts.neverUpdated;
    const date = new Date(seconds * 1000);
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

function sourceTitle(source) {
    const name = String(source.owner?.name ?? '').trim();
    if (name) return name;
    return source.kind === 'code'
        ? STR.accounts.codeLabel(source.code)
        : STR.accounts.autoLabel;
}

function sourceKind(source) {
    return source.kind === 'code' ? STR.accounts.codeLabel(source.code) : STR.accounts.autoLabel;
}

/**
 * @param {Element} host        样式注入与挂载点的参考节点（卡包宿主 / 插件面板根节点）
 * @param {{ mount?: Element, onClose?: Function }} [options]
 *        mount 给了就挂到它下面（插件版挂 body），否则挂到 host。
 */
export function openAccountsDialog(host, { mount = null, onClose = null } = {}) {
    const slot = mount ?? host;
    if (!slot) return null;
    const doc = slot.ownerDocument ?? document;
    const win = doc.defaultView;
    ensureNodeStyles(host);

    let closed = false;
    let busy = false;
    let accountReady = false;

    const overlayClass = mount ? 'ac-acc ac-acc--overlay' : 'ac-acc';
    const root = el(doc, 'div', overlayClass, {
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ac-acc-title' },
    });
    const backdrop = el(doc, 'div', 'ac-acc__backdrop', { attrs: { 'aria-hidden': 'true' } });
    const panel = el(doc, 'div', 'ac-acc__panel');

    const head = el(doc, 'header', 'ac-acc__head');
    head.append(
        el(doc, 'p', 'ac-set__eyebrow', { text: STR.theme }),
        el(doc, 'h2', 'ac-set__title', { text: STR.accounts.title, attrs: { id: 'ac-acc-title' } }),
        el(doc, 'p', 'ac-set__desc', { text: STR.accounts.desc }),
    );

    const toggleRow = el(doc, 'div', 'ac-acc__toggle');
    const toggleText = el(doc, 'div', 'ac-set__text');
    toggleText.append(
        el(doc, 'div', 'ac-set__label', { text: STR.accounts.enableLabel }),
        el(doc, 'p', 'ac-set__hint', { text: STR.accounts.enableHint }),
    );
    const toggle = el(doc, 'button', 'ac-set__switch', {
        attrs: {
            type: 'button',
            role: 'switch',
            'aria-checked': String(store.accountsEnabled()),
            'aria-label': STR.accounts.enableLabel,
        },
    });
    toggle.append(el(doc, 'i', null, { attrs: { 'aria-hidden': 'true' } }));
    toggle.addEventListener('click', () => {
        const next = toggle.getAttribute('aria-checked') !== 'true';
        toggle.setAttribute('aria-checked', String(next));
        store.setAccountsEnabled(next);
        renderSources();
        if (next) refresh({ force: false, quiet: true });
    });
    toggleRow.append(toggleText, toggle);

    const section = el(doc, 'section', 'ac-acc__section');
    const sectionHead = el(doc, 'div', 'ac-acc__section-head');
    sectionHead.append(el(doc, 'h3', 'ac-acc__section-title', { text: STR.accounts.sourcesTitle }));

    const refreshButton = el(doc, 'button', 'ac-acc__link', {
        text: STR.accounts.refresh,
        attrs: { type: 'button' },
    });
    refreshButton.addEventListener('click', () => refresh({ force: true }));
    sectionHead.append(refreshButton);
    section.append(sectionHead);

    const list = el(doc, 'div', 'ac-acc__list');
    section.append(list);

    const form = el(doc, 'form', 'ac-acc__add', { attrs: { novalidate: '' } });
    const input = el(doc, 'input', 'ac-acc__input', {
        attrs: {
            type: 'text',
            inputmode: 'numeric',
            autocomplete: 'off',
            maxlength: '11',
            placeholder: STR.accounts.addPlaceholder,
            'aria-label': STR.accounts.addLabel,
        },
    });
    const addButton = el(doc, 'button', 'ac-acc__add-btn', {
        text: STR.accounts.add,
        attrs: { type: 'submit' },
    });
    form.append(input, addButton);
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        const result = store.addAccountSource(input.value);
        if (!result.ok) {
            setStatus(STR.accounts.addBad, 'error');
            return;
        }
        input.value = '';
        setStatus(STR.accounts.addOk, 'ok');
        renderSources();
        refresh({ force: false, quiet: true });
    });
    section.append(form);

    const status = el(doc, 'p', 'ac-acc__status', { attrs: { role: 'status' } });
    status.hidden = true;

    function setStatus(text, tone = '') {
        status.textContent = text;
        status.hidden = !text;
        status.dataset.tone = tone;
    }

    function sourceRow(source) {
        const item = el(doc, 'div', 'ac-acc__source');

        const avatar = el(doc, 'span', 'ac-acc__avatar', { attrs: { 'aria-hidden': 'true' } });
        const fallback = () => {
            avatar.textContent = sourceTitle(source).slice(0, 1) || '·';
        };
        if (source.owner?.avatar) {
            const img = el(doc, 'img', null, { attrs: { alt: '', referrerpolicy: 'no-referrer' } });
            img.addEventListener('error', () => {
                img.remove();
                fallback();
            });
            img.src = source.owner.avatar;
            avatar.append(img);
        } else {
            fallback();
        }

        const text = el(doc, 'div', 'ac-acc__text');
        const title = el(doc, 'div', 'ac-acc__name', { text: sourceTitle(source) });
        const updated = source.updatedAt || source.sharedAt;
        // 没有昵称时标题就是来源类型，不再重复一遍
        const metaText = sourceKind(source) === sourceTitle(source)
            ? STR.accounts.meta(source.cardCount, dayLabel(updated))
            : `${sourceKind(source)} · ${STR.accounts.meta(source.cardCount, dayLabel(updated))}`;
        const meta = el(doc, 'p', 'ac-acc__meta', { text: metaText });
        text.append(title, meta);
        if (source.error) {
            text.append(el(doc, 'p', 'ac-acc__error', { text: `${STR.accounts.errorPrefix}${source.error}` }));
        }

        const remove = el(doc, 'button', 'ac-acc__remove', {
            text: STR.accounts.remove,
            attrs: { type: 'button', title: STR.accounts.removeFor(sourceTitle(source)) },
        });
        remove.addEventListener('click', () => {
            store.removeAccountSource(source.id);
            setStatus('', '');
            renderSources();
        });

        item.append(avatar, text, remove);
        return item;
    }

    function renderSources() {
        list.replaceChildren();
        const sources = accountReady ? store.getAccountSources() : [];
        if (!accountReady) {
            list.append(el(doc, 'p', 'ac-acc__empty', { text: STR.accounts.loading }));
        } else if (sources.length === 0) {
            list.append(el(doc, 'p', 'ac-acc__empty', { text: STR.accounts.empty }));
        } else {
            for (const source of sources) list.append(sourceRow(source));
        }
        refreshButton.disabled = busy || !accountReady || sources.length === 0 || !store.accountsEnabled();
        addButton.disabled = busy;
    }

    async function refresh({ force = true, quiet = false } = {}) {
        if (busy || closed) return;
        busy = true;
        renderSources();
        if (!quiet) setStatus(STR.accounts.refreshing);
        try {
            const result = await store.refreshAccountSources({ force });
            if (closed) return;
            if (result?.reason === 'no-account') {
                setStatus(STR.accounts.noAccount, 'error');
            } else if (result?.skipped === 'disabled' || result?.cached) {
                setStatus('', '');
            } else if (!quiet) {
                // 添加来源后的静默刷新不覆盖「已添加」，失败原因由来源行自己显示
                setStatus(
                    STR.accounts.refreshDone(result?.fetched ?? 0, result?.failed ?? 0),
                    result?.failed > 0 ? 'error' : 'ok',
                );
            }
        } catch {
            if (!closed) setStatus(STR.accounts.refreshFailed, 'error');
        } finally {
            busy = false;
            if (!closed) renderSources();
        }
    }

    const foot = el(doc, 'footer', 'ac-acc__foot');
    foot.append(
        el(doc, 'p', 'ac-acc__hint', { text: STR.accounts.hint }),
    );
    const closeButton = el(doc, 'button', 'ac-acc__done', {
        text: STR.accounts.close,
        attrs: { type: 'button' },
    });
    closeButton.addEventListener('click', close);
    foot.append(closeButton);

    const closeX = el(doc, 'button', 'ac-set__close', {
        text: '×',
        attrs: { type: 'button', 'aria-label': STR.accounts.close },
    });
    closeX.addEventListener('click', close);

    function close() {
        if (closed) return;
        closed = true;
        win?.removeEventListener('keydown', onKeyDown, true);
        root.remove();
        onClose?.();
    }

    function onKeyDown(event) {
        if (event.defaultPrevented || event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    }

    root.addEventListener('click', (event) => {
        if (event.target === root || event.target === backdrop) close();
    });

    panel.append(head, toggleRow, section, status, foot, closeX);
    root.append(backdrop, panel);
    slot.append(root);
    win?.addEventListener('keydown', onKeyDown, true);
    renderSources();
    toggle.focus?.({ preventScroll: true });

    (async () => {
        await store.ensureAccountId();
        if (closed) return;
        accountReady = store.getCurrentAccountId() != null;
        renderSources();
        if (!accountReady) {
            setStatus(STR.accounts.noAccount, 'error');
            return;
        }
        if (store.accountsEnabled()) refresh({ force: false });
    })();

    return { close, destroy: close, get root() { return root; } };
}
