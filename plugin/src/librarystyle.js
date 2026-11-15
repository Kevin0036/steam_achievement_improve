/**
 * 库内成就信息条的样式（library.css）单独注入 Steam 主窗口。
 *
 * 插件模块的 document 与真正显示游戏库的窗口不是同一个；原来要等第一次打开
 * 成就卡包、卡包在主窗口里挂载时，才顺带把样式补进那个文档——在此之前按完成度
 * 排序看到的还是 Valve 的旧样式。这里在插件加载时就通过 Millennium 的窗口钩子
 * 拿到每个 Steam 窗口（"SP ..."）的 document，直接注入，重启后立刻生效。
 *
 * 只注入 art + tokens + library 三份（变量 + 信息条规则），不把整包卡册样式塞进
 * 主窗口：卡册样式等卡包打开时按原机制注入，互不影响。
 */

import artCss from '../../src/css/ac/art.css';
import tokensCss from '../../src/css/ac/tokens.css';
import libraryCss from '../../src/css/ac/library.css';

const STYLE_ID = 'ac-library-style';
// tokens.css 顶部有一句 @import ./art.css；art.css 已经拼在最前面，去掉避免相对路径 404
const CSS = `${artCss}\n${tokensCss}\n${libraryCss}`.replace(/@import\s+url\(["']?\.\/[^)]+\);?/g, '');
const seen = new Set();

export function ensureLibraryStyles(doc) {
    if (!doc?.createElement) return;
    try {
        let style = doc.querySelector(`style[data-ac="${STYLE_ID}"]`);
        if (!style) {
            style = doc.createElement('style');
            style.dataset.ac = STYLE_ID;
            (doc.head || doc.documentElement)?.appendChild(style);
        }
        if (style.textContent !== CSS) style.textContent = CSS;
        if (seen.size < 8) seen.add(doc);
    } catch {
        // 窗口正在关闭 / 跨域：忽略这一个文档
    }
}

/** 心跳时补一次：Steam UI 重载后 <style> 会丢，但窗口对象通常还在 */
export function refreshLibraryStyles() {
    for (const doc of seen) {
        try {
            if (doc.body) ensureLibraryStyles(doc);
        } catch {
            // 忽略已关闭的窗口
        }
    }

    // 钩子没覆盖到主窗口时的兜底；这些对象不一定带 document，取不到就跳过
    const candidates = [];
    try {
        candidates.push(window.PLUGIN_LIST?.core?.mainWindow?.document);
    } catch {
        /* 忽略 */
    }
    for (const ref of [window, window.opener, window.top]) {
        try {
            if (ref?.document?.body) candidates.push(ref.document);
        } catch {
            /* 跨窗口访问被拒时忽略 */
        }
    }
    for (const doc of candidates) {
        if (doc) ensureLibraryStyles(doc);
    }
}

export function installLibraryWindowHook() {
    const register = window.Millennium?.AddWindowCreateHook;
    if (typeof register !== 'function') {
        console.warn('[成就收藏册 · 插件] AddWindowCreateHook 不可用，库内样式需要打开一次卡册才会生效');
        return false;
    }
    try {
        register((win) => {
            if (!win?.m_strName?.startsWith('SP ')) return;
            const doc = win.m_popup?.document;
            if (doc?.body) ensureLibraryStyles(doc);
        });
        return true;
    } catch (err) {
        console.warn('[成就收藏册 · 插件] 注册窗口钩子失败，库内样式需要打开一次卡册才会生效', err);
        return false;
    }
}
