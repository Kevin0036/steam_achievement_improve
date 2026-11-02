/**
 * 复制到剪贴板：Steam 的 CEF 里 navigator.clipboard 不一定可用。
 * 主题跑在 SP Desktop 子窗口里，那里的 SteamClient 是删减版，
 * SetClipboardText 往往只在主上下文（window.opener）上，所以逐个窗口探测。
 */
const CLIPBOARD_TIMEOUT_MS = 1200;

/** writeText 在部分 CEF 环境里既不 resolve 也不 reject，不能无限等 */
function withTimeout(promise, ms, win) {
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            const timer = (win?.setTimeout ?? setTimeout)(() => reject(new Error('clipboard timeout')), ms);
            Promise.resolve(promise).finally(() => (win?.clearTimeout ?? clearTimeout)(timer));
        }),
    ]);
}

function findSteamClipboard(win) {
    const targets = [];
    for (const get of [() => win, () => win?.opener, () => win?.top]) {
        try {
            const target = get();
            if (target && !targets.includes(target)) targets.push(target);
        } catch {
            /* 跨源窗口读不到就算了 */
        }
    }
    for (const target of targets) {
        try {
            const utils = target.SteamClient?.Utils;
            if (typeof utils?.SetClipboardText === 'function') return utils.SetClipboardText.bind(utils);
        } catch {
            /* 旧版客户端没有这个接口，继续找下一个窗口 */
        }
    }
    return null;
}

export async function copyText(doc, text) {
    const win = doc?.defaultView;
    const setClipboard = findSteamClipboard(win);
    if (setClipboard) {
        try {
            setClipboard(text);
            return true;
        } catch {
            /* 接口在但调用失败，继续往下试 */
        }
    }
    // 用户点击后的同一个任务里执行，最不容易被当成无手势操作拦掉
    const prev = doc?.activeElement;
    try {
        const area = doc.createElement('textarea');
        let ok = false;
        try {
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
            doc.body.append(area);
            area.select();
            ok = doc.execCommand?.('copy') ?? false;
        } finally {
            area.remove();
        }
        if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus({ preventScroll: true });
        if (ok) return true;
    } catch {
        /* 兜底都失败就交给下面的 navigator.clipboard */
    }
    try {
        const clipboard = win?.navigator?.clipboard;
        if (typeof clipboard?.writeText !== 'function') throw new Error('clipboard unavailable');
        await withTimeout(clipboard.writeText(text), CLIPBOARD_TIMEOUT_MS, win);
        return true;
    } catch {
        return false;
    }
}
