/**
 * Steam 底部「管理下载」长条上的原创双像素桌宠彩蛋（MIT License）。
 *
 * 设计要点：
 *   1. 不修改 Steam React 树：舞台挂载在主窗口 document.body（position: fixed），
 *      通过 ResizeObserver + resize 紧贴 BottomBar 上缘（脚底踩在底栏上边框线上）；
 *   2. 舞台本身 pointer-events: none，仅两只像素宠物本体接收点击与拖拽，
 *      且显式声明 -webkit-app-region: no-drag，绝不误触 Steam 窗口拖动或底栏按钮；
 *   3. 仅在库相关页面（库主页 / 游戏页 / 下载页 / 成就卡包）显示，切到商店 / 社区 / 个人资料时
 *      自动隐藏休眠；静止 45 秒后自然打盹，Steam 失焦或最小化时自动停表回收 Canvas 显存；
 *   4. 受插件设置「底部栏像素桌宠」控制，开关即时生效，无需重启 Steam。
 */

import pixelPets from './pixelpets.js';
import bottomBarPetsCss from './bottombarpets.css';
import { OPTIONS, readOptions } from './settings.js';

const STYLE_ID = 'ac-bottombar-pets-style';
const STAGE_ATTR = 'data-ac-bb-pets';

// Steam 桌面端底部栏（「添加游戏 / 管理下载 / 好友与聊天」）与库本地内容区选择器
const BOTTOM_BAR_SEL = '._3vCzSrrXZzZjVJFZNg9SGu';
const LOCAL_CONTENT_SEL = '.RGNMWtyj73_-WdhflrmuY';
const BROWSER_WRAPPER_SEL = '._1bGewp3tfzqAF6fVTFFUOz';
const FALLBACK_CHILD_SEL = '._2EQ7ghgqIdjKv9jsQC0Zq9, ._2foCkpRXhqq0UGVE50BWqj, ._1TdaAqMFadi0UTqilrkelR';

// 仅在库界面（含游戏详情 / 下载页 / 成就卡包）显示，踩在底栏上缘（还原 Obsidian Prism 原高度）；
// 切到商店 / 社区 / 个人资料等原生浏览器页时自动隐藏休眠。右缘留 14px 避开滚动条。
const RIGHT_GUTTER_PX = 14;
const FOOT_OVERLAP_PX = 9;
const ACTIVITY_THROTTLE_MS = 8000;

const controllers = new WeakMap();
const activeDocs = new Set();

function isEnabled() {
    try {
        return readOptions()[OPTIONS.bottomPets] !== '关闭';
    } catch {
        return true;
    }
}

function ensureStyle(doc) {
    if (!doc?.head) return;
    let node = doc.getElementById(STYLE_ID);
    if (!node) {
        node = doc.createElement('style');
        node.id = STYLE_ID;
        node.textContent = bottomBarPetsCss;
        doc.head.appendChild(node);
    } else if (node.textContent !== bottomBarPetsCss) {
        node.textContent = bottomBarPetsCss;
    }
}

function findBottomBar(doc) {
    if (!doc?.body) return null;
    const direct = doc.querySelector(BOTTOM_BAR_SEL);
    if (direct) return direct;

    // 兜底：若 Steam 将来换了 BottomBar 类名，从内部按钮向上找高度 32~68px 的底栏容器
    const probe = doc.querySelector(FALLBACK_CHILD_SEL);
    if (!probe) return null;
    let cur = probe.parentElement;
    for (let hops = 0; cur && cur !== doc.body && hops < 5; hops += 1, cur = cur.parentElement) {
        const rect = cur.getBoundingClientRect();
        if (rect.height >= 32 && rect.height <= 68 && rect.width >= 300) return cur;
    }
    return null;
}

function isLocalLibraryVisible(doc) {
    const local = doc?.querySelector?.(LOCAL_CONTENT_SEL);
    if (local) {
        // 切到商店 / 社区 / 个人资料时 Steam 会给 LocalContentContainer 挂上 style="display: none"
        if (local.style.display === 'none') return false;
        const rect = local.getBoundingClientRect();
        return rect.width >= 100 && rect.height >= 100;
    }
    // 兜底：若未来类名变动，检测到可见的原生 BrowserWrapper 时隐藏
    const browser = doc?.querySelector?.(BROWSER_WRAPPER_SEL);
    if (browser && browser.style.display !== 'none') {
        const rect = browser.getBoundingClientRect();
        if (rect.width >= 100 && rect.height >= 100) return false;
    }
    return true;
}

function createDocController(doc) {
    const win = doc.defaultView;
    if (!win || !doc.body || !pixelPets?.mountDualMascotStage) return null;

    let stage = null;
    let rig = null;
    let barEl = null;
    let localEl = null;
    let barRo = null;
    let localMo = null;
    let bodyMo = null;
    let disposed = false;
    let lastActAt = 0;
    let lastRectKey = '';
    let syncQueued = false;

    const detachBarObserver = () => {
        try {
            barRo?.disconnect();
        } catch {
            /* 忽略 */
        }
        barRo = null;
        barEl = null;
    };

    const detachLocalObserver = () => {
        try {
            localMo?.disconnect();
        } catch {
            /* 忽略 */
        }
        localMo = null;
        localEl = null;
    };

    const destroyRig = () => {
        detachBarObserver();
        detachLocalObserver();
        try {
            rig?.dispose?.();
        } catch {
            /* 忽略 */
        }
        rig = null;
        if (stage) {
            try {
                stage.remove();
            } catch {
                /* 忽略 */
            }
            stage = null;
        }
        lastRectKey = '';
    };

    const ensureLocalObserver = () => {
        const nextLocal = doc.querySelector(LOCAL_CONTENT_SEL);
        if (nextLocal === localEl) return;
        detachLocalObserver();
        if (!nextLocal) return;
        localEl = nextLocal;
        const MO = win.MutationObserver || window.MutationObserver;
        if (typeof MO === 'function') {
            localMo = new MO(() => scheduleSync());
            try {
                localMo.observe(nextLocal, { attributes: true, attributeFilter: ['style', 'class'] });
            } catch {
                /* 忽略 */
            }
        }
    };

    const hideStage = () => {
        if (stage) stage.style.display = 'none';
        try {
            rig?.park?.(true);
        } catch {
            /* 忽略 */
        }
    };

    const syncPosition = () => {
        if (disposed) return;
        if (!isEnabled()) {
            destroyRig();
            return;
        }

        ensureLocalObserver();

        const nextBar = findBottomBar(doc);
        if (!nextBar) {
            hideStage();
            detachBarObserver();
            return;
        }

        const rect = nextBar.getBoundingClientRect();
        const barVisible = rect.width >= 260 && rect.height >= 20 && rect.bottom > 0 && rect.top < win.innerHeight + 4;
        if (!barVisible || !isLocalLibraryVisible(doc)) {
            hideStage();
            return;
        }

        ensureStyle(doc);

        if (!stage || !stage.isConnected) {
            // 清理可能残留的旧节点
            for (const stale of doc.querySelectorAll(`[${STAGE_ATTR}]`)) {
                try {
                    stale.remove();
                } catch {
                    /* 忽略 */
                }
            }
            stage = doc.createElement('div');
            stage.className = 'ac-bb-pets ag-cs-dual-stage';
            stage.setAttribute(STAGE_ATTR, '1');
            stage.setAttribute('data-mascot-stage', 'true');
            stage.setAttribute('aria-hidden', 'true');
            doc.body.appendChild(stage);
        }

        if (stage.style.display === 'none') stage.style.display = '';

        const left = Math.round(rect.left);
        const width = Math.max(240, Math.round(rect.width - RIGHT_GUTTER_PX));
        const bottom = Math.max(0, Math.round(win.innerHeight - rect.top - FOOT_OVERLAP_PX));
        const rectKey = `${left},${width},${bottom}`;
        if (rectKey !== lastRectKey) {
            lastRectKey = rectKey;
            stage.style.left = `${left}px`;
            stage.style.width = `${width}px`;
            stage.style.bottom = `${bottom}px`;
        }

        if (barEl !== nextBar) {
            detachBarObserver();
            barEl = nextBar;
            const RO = win.ResizeObserver || window.ResizeObserver;
            if (typeof RO === 'function') {
                barRo = new RO(() => scheduleSync());
                try {
                    barRo.observe(nextBar);
                } catch {
                    /* 忽略 */
                }
            }
        }

        if (!rig) {
            try {
                rig = pixelPets.mountDualMascotStage(stage, {
                    popoverRightWidth: 0,
                });
            } catch (err) {
                console.warn('[成就收藏册 · 桌宠] 挂载失败', err);
                rig = null;
            }
        } else {
            try {
                rig.resume?.();
            } catch {
                /* 忽略 */
            }
        }
    };

    const scheduleSync = () => {
        if (disposed || syncQueued) return;
        syncQueued = true;
        const raf = win.requestAnimationFrame?.bind(win) ?? ((fn) => window.setTimeout(fn, 16));
        raf(() => {
            syncQueued = false;
            syncPosition();
        });
    };

    const onUserActivity = () => {
        if (disposed || !rig) return;
        const now = Date.now();
        if (now - lastActAt < ACTIVITY_THROTTLE_MS) return;
        lastActAt = now;
        try {
            rig.notify?.('activity', {});
        } catch {
            /* 忽略 */
        }
    };

    const onResize = () => scheduleSync();
    const onUnload = () => dispose();

    win.addEventListener('resize', onResize, { passive: true });
    win.addEventListener('beforeunload', onUnload);
    doc.addEventListener('pointerdown', onUserActivity, { passive: true, capture: true });
    doc.addEventListener('pointermove', onUserActivity, { passive: true, capture: true });
    doc.addEventListener('wheel', onUserActivity, { passive: true, capture: true });
    doc.addEventListener('keydown', onUserActivity, { passive: true, capture: true });

    // 监听底栏或本地内容区出现 / 重建（防抖节流）
    const MO = win.MutationObserver || window.MutationObserver;
    if (typeof MO === 'function') {
        bodyMo = new MO(() => {
            if (disposed) return;
            if (!barEl || !barEl.isConnected || !localEl || !localEl.isConnected || (stage && !stage.isConnected)) {
                scheduleSync();
            }
        });
        try {
            bodyMo.observe(doc.body, { childList: true, subtree: true });
        } catch {
            /* 忽略 */
        }
    }

    function celebrate() {
        if (disposed || !rig || !isEnabled()) return;
        try {
            rig.notify?.('aura-complete', {});
        } catch {
            /* 忽略 */
        }
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        destroyRig();
        try {
            bodyMo?.disconnect();
        } catch {
            /* 忽略 */
        }
        bodyMo = null;
        try {
            win.removeEventListener('resize', onResize);
            win.removeEventListener('beforeunload', onUnload);
            doc.removeEventListener('pointerdown', onUserActivity, true);
            doc.removeEventListener('pointermove', onUserActivity, true);
            doc.removeEventListener('wheel', onUserActivity, true);
            doc.removeEventListener('keydown', onUserActivity, true);
        } catch {
            /* 忽略 */
        }
        controllers.delete(doc);
        activeDocs.delete(doc);
    }

    syncPosition();

    return {
        sync: syncPosition,
        celebrate,
        dispose,
    };
}

/** 同步指定 Steam 窗口文档里的底部栏桌宠（仅存在 BottomBar 的主窗口才会真正显示） */
export function syncBottomBarPets(doc) {
    if (!doc?.body) return;
    try {
        if (doc.defaultView?.closed) return;
    } catch {
        return;
    }

    const existing = controllers.get(doc);
    if (!isEnabled()) {
        existing?.dispose();
        return;
    }

    // 还没挂载过时，先检查文档里是否已有 BottomBar（避免给聊天/设置等小窗口挂无关监听器）
    if (!existing) {
        const ctrl = createDocController(doc);
        if (ctrl) {
            controllers.set(doc, ctrl);
            activeDocs.add(doc);
        }
        return;
    }

    existing.sync();
}

/** 设置开关切换或心跳刷新时，同步所有已知 Steam 窗口 */
export function refreshAllBottomBarPets() {
    for (const doc of Array.from(activeDocs)) {
        try {
            if (doc.defaultView?.closed) {
                controllers.get(doc)?.dispose();
                continue;
            }
            syncBottomBarPets(doc);
        } catch {
            activeDocs.delete(doc);
        }
    }
}

/** 打开成就卡包时让两只小桌宠开心蹦一下 */
export function celebrateBottomBarPets() {
    if (!isEnabled()) return;
    for (const doc of Array.from(activeDocs)) {
        try {
            if (!doc.defaultView?.closed) controllers.get(doc)?.celebrate();
        } catch {
            /* 忽略 */
        }
    }
}
