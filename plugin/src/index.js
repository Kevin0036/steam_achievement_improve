/**
 * 插件版入口。
 *
 * Millennium 会把打包后的这个文件注入 SharedJSContext（也就是 Steam 主界面），
 * 因此这里不需要主题的 TargetJs：注册侧栏面板、启动库内入口都在这里完成。
 *
 * import 顺序有硬约束：mode.js 必须排在任何 src/js/ac/* 之前，
 * 它负责打开本实例的插件模式并把设置接给 getThemeOption。
 */

import { PLUGIN_VERSION, PLUGIN_NAME } from './mode.js';
import './styles.js';
import { waitForGlobal } from '../../src/js/ac/env.js';
import { buildPanel, buildPanelContent } from './panel.js';
import { maybeCheckOnOpen, openUpdateDialog } from './update.js';

const GUARD = Symbol.for('ac.plugin.runtime');

function log(...args) {
    try {
        console.info('%c[成就收藏册 · 插件]', 'color:#66c0f4;font-weight:600', ...args);
    } catch {
        /* 忽略 */
    }
}

/* 通知后端「前端已就绪」。与 Millennium 自带插件打包器的约定一致。 */
function signalFrontendReady() {
    try {
        window.MILLENNIUM_BACKEND_IPC?.postMessage?.(1, { pluginName: PLUGIN_NAME });
    } catch {
        /* 后端尚未就绪时由 Millennium 自行重试 */
    }
}

/**
 * 主题配置一变化，Millennium 会把所有 webkit 钩子（包括插件注册的展柜脚本）一起清空。
 * 前端定期重发 FRONT_END_LOADED，后端收到后重新注册钩子；回到 Steam 窗口时也补一次。
 * 频率刻意放低：这只是一次跨进程通知，不需要秒级。
 */
const HEARTBEAT_MS = 60 * 1000;
const FOCUS_MIN_GAP_MS = 15 * 1000;

function startBackendHeartbeat() {
    let last = Date.now();
    const signal = () => {
        last = Date.now();
        signalFrontendReady();
    };
    window.setInterval(signal, HEARTBEAT_MS);
    window.addEventListener('focus', () => {
        if (Date.now() - last >= FOCUS_MIN_GAP_MS) signal();
    });
}

function registerPanel(React) {
    try {
        window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS ||= {};
        window.MILLENNIUM_SIDEBAR_NAVIGATION_PANELS[PLUGIN_NAME] = buildPanel(React);
        log(`侧栏面板已注册 · v${PLUGIN_VERSION}`);
    } catch (err) {
        log('注册侧栏面板失败', err);
    }
}

/** 卡册页面右上角「设置」按钮：优先打开 Millennium 的插件面板，旧版退回模态。 */
function openPluginSettings() {
    const api = window.MILLENNIUM_API;

    if (typeof api?.openQuickAccess === 'function') {
        try {
            api.openQuickAccess({ plugin: PLUGIN_NAME });
            return;
        } catch (err) {
            log('打开快速访问面板失败，改用模态', err);
        }
    }

    const React = window.SP_REACT;
    if (!React || typeof api?.showModal !== 'function') {
        log('MILLENNIUM_API.showModal 不可用，无法打开设置');
        return;
    }

    const owner = window.PLUGIN_LIST?.core?.mainWindow ?? window;
    try {
        api.showModal(buildPanelContent(React), owner, {
            strTitle: '成就收藏册',
            popupHeight: 780,
            popupWidth: 720,
            bNeverPopOut: true,
        });
    } catch (err) {
        log('打开设置模态失败', err);
    }
}

async function bootstrap() {
    signalFrontendReady();
    startBackendHeartbeat();

    const React = await waitForGlobal('SP_REACT', { timeout: 20000 });
    if (!React) {
        log('SP_REACT 未出现，插件面板与设置入口不可用');
        return;
    }

    registerPanel(React);
    window.addEventListener('ac:open-settings', openPluginSettings);
    window.addEventListener('ac:cardpack-opened', (event) => {
        maybeCheckOnOpen(event?.detail?.host ?? null);
    });
    window.addEventListener('ac:update-open', (event) => {
        openUpdateDialog(event?.detail?.host ?? null);
    });
    log(`已启动 · v${PLUGIN_VERSION}`);
}

if (!window[GUARD]) {
    window[GUARD] = true;
    bootstrap().catch((err) => log('初始化失败', err));
}
