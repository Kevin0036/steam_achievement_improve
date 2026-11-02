/**
 * 阅读设置面板：书口年份索引 / 册子风格（年度之树 / 年度目标由 TREE_FEATURE 收起）。
 *
 * 纯 DOM，挂在卡册宿主上；改动立即写进 reading.js 并通知 page.js 重建册子。
 * 主题版的其它选项仍在 Millennium 的主题设置里 —— 这里只放需要开关和滑块的几项。
 */

import { getThemeOption } from './env.js';
import { ALBUM_STYLES, readReading, TARGET_MAX, TARGET_MIN, TARGET_STEP, TREE_FEATURE, writeReading } from './reading.js';
import { copyText } from './clipboard.js';
import { openAccountsDialog } from './accountsui.js';
import { STR } from './strings.js';

function el(doc, tag, className, { text = null, attrs = null } = {}) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value != null) node.setAttribute(name, String(value));
    }
    return node;
}

export function openReadingSettings(host, { onClose = null, diagnostics = null, onExtraScan = null } = {}) {
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    const prefs = readReading();
    let closed = false;

    const root = el(doc, 'div', 'ac-set', {
        attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'ac-set-title' },
    });
    const backdrop = el(doc, 'div', 'ac-set__backdrop', { attrs: { 'aria-hidden': 'true' } });
    const panel = el(doc, 'div', 'ac-set__panel');

    const head = el(doc, 'header', 'ac-set__head');
    head.append(
        el(doc, 'p', 'ac-set__eyebrow', { text: STR.theme }),
        el(doc, 'h2', 'ac-set__title', { text: STR.reading.title, attrs: { id: 'ac-set-title' } }),
        el(doc, 'p', 'ac-set__desc', { text: STR.reading.desc }),
    );

    const rows = el(doc, 'div', 'ac-set__rows');

    function makeSwitch(label, checked, onChange) {
        const button = el(doc, 'button', 'ac-set__switch', {
            attrs: {
                type: 'button',
                role: 'switch',
                'aria-checked': String(checked),
                'aria-label': label,
            },
        });
        button.append(el(doc, 'i', null, { attrs: { 'aria-hidden': 'true' } }));
        button.addEventListener('click', () => {
            const next = button.getAttribute('aria-checked') !== 'true';
            button.setAttribute('aria-checked', String(next));
            onChange(next);
        });
        return button;
    }

    function row(label, desc, control, extra) {
        const item = el(doc, 'div', 'ac-set__row');
        const text = el(doc, 'div', 'ac-set__text');
        const title = el(doc, 'div', 'ac-set__label');
        title.append(el(doc, 'b', null, { text: label }));
        if (extra) title.append(el(doc, 'em', 'ac-set__tag', { text: extra }));
        text.append(title, el(doc, 'p', 'ac-set__hint', { text: desc }));
        item.append(text, control);
        return item;
    }

    rows.append(
        row(
            STR.reading.tabsLabel,
            STR.reading.tabsDesc,
            makeSwitch(STR.reading.tabsLabel, prefs.tabs, (next) => writeReading({ tabs: next })),
        ),
    );

    // 册子风格：换款只改宿主的 data-album，不用重建册子
    const chips = el(doc, 'div', 'ac-set__chips', { attrs: { role: 'group', 'aria-label': STR.reading.albumLabel } });
    for (const item of ALBUM_STYLES) {
        const chip = el(doc, 'button', 'ac-set__chip', {
            text: item.name,
            attrs: { type: 'button', 'data-album-id': item.id, 'aria-pressed': String(item.id === prefs.album) },
        });
        chip.addEventListener('click', () => {
            writeReading({ album: item.id });
            for (const other of chips.children) {
                other.setAttribute('aria-pressed', String(other === chip));
            }
        });
        chips.append(chip);
    }
    const albumRow = el(doc, 'div', 'ac-set__row ac-set__row--stack');
    const albumText = el(doc, 'div', 'ac-set__text');
    albumText.append(
        el(doc, 'div', 'ac-set__label', { text: STR.reading.albumLabel }),
        el(doc, 'p', 'ac-set__hint', { text: STR.reading.albumDesc }),
    );
    albumRow.append(albumText, chips);
    rows.append(albumRow);

    if (TREE_FEATURE) {
        const hint = el(doc, 'p', 'ac-set__notice');
        const yearPages = String(getThemeOption('年份特殊页', '关闭')) === '开启';
        hint.textContent = STR.reading.treeNeedPages;
        hint.hidden = yearPages;
        rows.append(
            row(
                STR.reading.treeLabel,
                STR.reading.treeDesc,
                makeSwitch(STR.reading.treeLabel, prefs.tree, (next) => writeReading({ tree: next })),
                STR.reading.treeTag,
            ),
            hint,
        );

        // 年度目标：拖动时只更新读数，松手（change）才写入并重建册子
        const value = el(doc, 'output', 'ac-set__value', {
            text: STR.reading.targetValue(prefs.target),
            attrs: { for: 'ac-set-target' },
        });
        const range = el(doc, 'input', 'ac-set__range', {
            attrs: {
                id: 'ac-set-target',
                type: 'range',
                min: String(TARGET_MIN),
                max: String(TARGET_MAX),
                step: String(TARGET_STEP),
                value: String(prefs.target),
                'aria-label': STR.reading.targetLabel,
            },
        });
        range.addEventListener('input', () => {
            value.textContent = STR.reading.targetValue(Number(range.value));
        });
        range.addEventListener('change', () => {
            writeReading({ target: Number(range.value) });
        });
        const slider = el(doc, 'div', 'ac-set__slider');
        const ticks = el(doc, 'div', 'ac-set__ticks', { attrs: { 'aria-hidden': 'true' } });
        ticks.append(
            el(doc, 'span', null, { text: STR.reading.targetValue(TARGET_MIN) }),
            el(doc, 'span', null, { text: STR.reading.targetValue(TARGET_MAX) }),
        );
        slider.append(value, range, ticks);

        const targetRow = el(doc, 'div', 'ac-set__row ac-set__row--stack');
        const targetText = el(doc, 'div', 'ac-set__text');
        targetText.append(
            el(doc, 'div', 'ac-set__label', { text: STR.reading.targetLabel }),
            el(doc, 'p', 'ac-set__hint', { text: STR.reading.targetDesc }),
        );
        targetRow.append(targetText, slider);
        rows.append(targetRow);
    }

    // 库外收录放在设置里：主页工具栏只留常用入口
    if (typeof onExtraScan === 'function') {
        const scan = el(doc, 'button', 'ac-set__done', {
            text: STR.reading.extraButton,
            attrs: { type: 'button' },
        });
        scan.addEventListener('click', () => {
            close();
            onExtraScan();
        });
        rows.append(row(STR.reading.extraLabel, STR.reading.extraDesc, scan));
    }

    // 多账号合并：来源管理单独开一个对话框，阅读设置本身保持轻量
    const accountsButton = el(doc, 'button', 'ac-set__done', {
        text: STR.reading.accountsButton,
        attrs: { type: 'button' },
    });
    accountsButton.addEventListener('click', () => {
        openAccountsDialog(host);
    });
    rows.append(row(STR.reading.accountsLabel, STR.reading.accountsDesc, accountsButton));

    const foot = el(doc, 'footer', 'ac-set__foot');
    const feedback = el(doc, 'button', 'ac-set__feedback', {
        text: STR.reading.feedback,
        attrs: { type: 'button', title: STR.reading.feedbackHint },
    });
    const diag = el(doc, 'div', 'ac-set__diag', { attrs: { role: 'status' } });
    const diagLine = el(doc, 'pre', 'ac-set__diag-line');
    const diagStatus = el(doc, 'p', 'ac-set__diag-status');
    diag.hidden = true;

    feedback.addEventListener('click', async () => {
        let line = '';
        try {
            line = typeof diagnostics === 'function' ? String(diagnostics() ?? '').trim() : '';
        } catch {
            line = '';
        }
        diag.hidden = false;
        if (!line) {
            diagLine.textContent = '';
            diagLine.hidden = true;
            diagStatus.textContent = STR.reading.feedbackUnavailable;
            return;
        }
        diagLine.hidden = false;
        diagLine.textContent = line;
        diagStatus.textContent = STR.reading.feedbackCopying;
        const ok = await copyText(doc, line);
        diagStatus.textContent = ok ? STR.reading.feedbackCopied : STR.reading.feedbackFailed;
    });

    const done = el(doc, 'button', 'ac-set__done', { text: STR.reading.done, attrs: { type: 'button' } });
    done.addEventListener('click', close);
    foot.append(feedback, done);
    diag.append(diagLine, diagStatus);

    const closeButton = el(doc, 'button', 'ac-set__close', {
        text: '×',
        attrs: { type: 'button', 'aria-label': STR.reading.close },
    });
    closeButton.addEventListener('click', close);

    function close() {
        if (closed) return;
        closed = true;
        win?.removeEventListener('keydown', onKeyDown, true);
        root.remove();
        onClose?.();
    }

    function onKeyDown(event) {
        if (event.defaultPrevented) return;
        // 多账号管理叠加在本面板之上：Esc 归它，别把下面的设置一起关掉
        if (host.querySelector('.ac-acc')) return;
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    }

    root.addEventListener('click', (event) => {
        if (event.target === root || event.target === backdrop) close();
    });

    panel.append(head, rows, diag, foot, closeButton);
    root.append(backdrop, panel);
    host.append(root);
    win?.addEventListener('keydown', onKeyDown, true);
    rows.querySelector('.ac-set__switch')?.focus?.({ preventScroll: true });

    return { close, destroy: close, get root() { return root; } };
}
