/**
 * 成就收藏册 · 借阅室打不开时的报错提示
 *
 * 借阅室出错原本只打印在 Steam 的开发者控制台里，用户看到的只是「点了没反应」。
 * 这里在「借阅室」按钮下面弹一张小卡片：写明没打开、给出报错的第一行，
 * 并能一键复制完整报错（版本 + 错误 + 调用栈前几行 + 客户端 UA），方便发给作者。
 *
 * 纯 DOM，不依赖 React；预览页和 Steam 里的卡包用同一份代码。
 */

import { copyText } from './clipboard.js';
import STR from './strings.js';

const VERSION = typeof __AC_PLUGIN_VERSION__ === 'string' ? __AC_PLUGIN_VERSION__ : '';
const STACK_LINES = 8;

function el(doc, tag, className, text = null) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** 报错的第一行：卡片上只放这一句 */
export function borrowErrorSummary(error) {
    const name = error?.name && error.name !== 'Error' ? `${error.name}: ` : '';
    const message = String(error?.message ?? error ?? '').split('\n')[0].trim();
    return `${name}${message}` || STR.borrowError.unknown;
}

/** 复制出去的完整报错。不含账号信息，只有版本、错误本身和客户端版本 */
export function borrowErrorReport(error, { version = VERSION, userAgent = '' } = {}) {
    const lines = [`成就收藏册${version ? ` v${version}` : ''} · 借阅室打开失败`, borrowErrorSummary(error)];
    const stack = String(error?.stack ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith('at '))
        .slice(0, STACK_LINES);
    lines.push(...stack);
    if (userAgent) lines.push(`UA: ${userAgent}`);
    return lines.join('\n');
}

/**
 * 在 host 里弹出报错卡片（host 一般是左上角工具条）。返回 { destroy }。
 * @param {HTMLElement} host
 * @param {object} options
 * @param {unknown} options.error
 * @param {() => void} [options.onClose]
 */
export function showBorrowError(host, { error, onClose = null } = {}) {
    const doc = host.ownerDocument;
    const win = doc.defaultView;
    let closed = false;
    let statusTimer = 0;

    const root = el(doc, 'div', 'ac-borrow-error');
    root.setAttribute('role', 'alert');

    const title = el(doc, 'div', 'ac-borrow-error__title', STR.borrowError.title);
    const detail = el(doc, 'code', 'ac-borrow-error__detail', borrowErrorSummary(error));
    const hint = el(doc, 'p', 'ac-borrow-error__hint', STR.borrowError.hint);

    const foot = el(doc, 'div', 'ac-borrow-error__foot');
    const status = el(doc, 'span', 'ac-borrow-error__status');
    status.setAttribute('aria-live', 'polite');
    const copy = el(doc, 'button', 'ac-borrow-error__copy', STR.borrowError.copy);
    copy.type = 'button';
    const dismiss = el(doc, 'button', 'ac-borrow-error__dismiss', STR.borrowError.dismiss);
    dismiss.type = 'button';
    foot.append(status, copy, dismiss);

    root.append(title, detail, hint, foot);
    host.append(root);

    copy.addEventListener('click', async () => {
        const report = borrowErrorReport(error, { userAgent: win?.navigator?.userAgent ?? '' });
        const ok = await copyText(doc, report);
        if (closed) return;
        status.textContent = ok ? STR.borrowError.copied : STR.borrowError.copyFailed;
        if (!ok) {
            // 复制不了就把完整报错摊开，至少能截图
            detail.textContent = report;
            detail.classList.add('is-full');
        }
        win?.clearTimeout(statusTimer);
        statusTimer = win?.setTimeout(() => {
            status.textContent = '';
        }, 2600);
    });

    function close() {
        if (closed) return;
        closed = true;
        win?.clearTimeout(statusTimer);
        win?.removeEventListener('keydown', onKeyDown, true);
        root.remove();
        onClose?.();
    }

    function onKeyDown(event) {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        close();
    }

    dismiss.addEventListener('click', close);
    win?.addEventListener('keydown', onKeyDown, true);
    copy.focus({ preventScroll: true });

    return { destroy: close };
}
