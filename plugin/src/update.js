/**
 * 插件自更新。
 *
 * Millennium 的自动更新对本插件不可靠，所以插件自己问 GitHub 最新 release：
 *   · 每次进入卡包都检查（Steam 常常开着好几天，不能只在启动后查一次）；
 *   · 有新版时卡册右上角一直留着提醒，弹窗等引导和入册动画结束才出现；
 *   · 弹窗三个选择：自动更新 / 前往发布页 / 暂不更新（这一版不再弹窗，提醒还在）；
 *   · 关掉弹窗只是这次 Steam 运行期间不再弹；
 *   · 自动更新走后端 Lua：下载 release 资产并替换插件文件，重启 Steam 后生效。
 *
 * 网络与文件写入全部在后端完成，前端只负责展示。后端不可用时退回浏览器 fetch，
 * 这时只提示、不自动安装。
 *
 * 和卡册之间走两个 window 事件，主题版没有这边的监听，不受影响：
 *   ac:update-notice —— 这边告诉卡册该显示什么提醒（detail 为 null 表示没有）；
 *   ac:update-open   —— 卡册告诉这边可以弹窗了，或者用户点了提醒。
 */

import { ensureNodeStyles } from '../../src/js/ac/env.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './mode.js';
import { openReleasesPage, RELEASES_PAGE } from './release.js';
import { decideUpdate, releaseNotesText } from './updatelogic.js';

const REPO = 'Kevin0036/steam_achievement_improve';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const STATE_KEY = 'ac:plugin:update:v1';
const OPEN_CHECK_DELAY_MS = 1200;
/**
 * 短时间反复进出卡包时用上一次的结果。GitHub 未登录接口每小时只有 60 次，
 * 而且按出口 IP 算，共用网络的用户会互相占额度。
 */
const RECHECK_GAP_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;
const REQUIRED_ASSETS = [
    'AchievementCollection-plugin.js',
    'AchievementCollection-backend.lua',
    'AchievementCollection-showcase.js',
    'AchievementCollection-showcase.css',
];

/* ── 本地状态 ───────────────────────────────────────────────────────────── */

function readState() {
    try {
        const parsed = JSON.parse(window.localStorage.getItem(STATE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeState(patch) {
    try {
        window.localStorage.setItem(STATE_KEY, JSON.stringify({ ...readState(), ...patch }));
    } catch {
        /* localStorage 不可用时只是在下次会话重新检查 */
    }
}

/* 下面三项只活在这次 Steam 运行期间：重启之后都该重新判断 */
/** 最近一次查到的结果；检查失败时不覆盖，继续按它提醒 */
let lastRelease = null;
/** 这次运行里装好的版本：后端拿不到版本号时靠它显示「等待重启」 */
let installedVersion = null;
/** 用户关掉过弹窗的版本 */
let dismissedVersion = null;
let openDialog = null;

/* ── 后端 / 网络 ────────────────────────────────────────────────────────── */

function backendAvailable() {
    return typeof window.Millennium?.callServerMethod === 'function';
}

/**
 * 参数必须以数组形式交给 FFI：bridge 只把对象/数组当作 argumentList，
 * 传字符串会被静默丢弃，后端收到 nil。
 */
async function callBackend(method, args) {
    const list = Array.isArray(args) ? args : args == null ? [] : [args];
    const raw = await window.Millennium.callServerMethod(PLUGIN_NAME, method, list);
    if (typeof raw !== 'string') return raw;
    return JSON.parse(raw);
}

function normalizeRelease(data) {
    const latest = String(data?.tag_name ?? '').replace(/^v/i, '');
    if (!latest) throw new Error('GitHub 返回缺少版本号');
    const assets = {};
    for (const asset of data.assets ?? []) {
        if (asset?.name && asset?.browser_download_url) {
            assets[asset.name] = { url: asset.browser_download_url, size: asset.size ?? 0 };
        }
    }
    return {
        success: true,
        current: PLUGIN_VERSION,
        latest,
        tag: data.tag_name ?? `v${latest}`,
        url: data.html_url ?? RELEASES_PAGE,
        notes: data.body ?? '',
        assets,
    };
}

async function fetchFromGitHub() {
    const response = await fetch(API_LATEST, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`GitHub API ${response.status}`);
    return normalizeRelease(await response.json());
}

async function askGitHub() {
    let backendError = null;
    if (backendAvailable()) {
        try {
            const info = await callBackend('FetchRelease');
            if (info?.success && typeof info.raw === 'string') {
                try {
                    return { ...normalizeRelease(JSON.parse(info.raw)), onDisk: info.current ?? null };
                } catch (err) {
                    backendError = err?.message ?? String(err);
                }
            } else if (info?.error) {
                backendError = info.error;
            }
        } catch (err) {
            backendError = err?.message ?? String(err);
        }
    }
    try {
        return await fetchFromGitHub();
    } catch (err) {
        throw new Error(backendError || err?.message || '检查更新失败');
    }
}

/* ── 弹窗 ───────────────────────────────────────────────────────────────── */

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function resolveHost(host) {
    const doc = host?.ownerDocument ?? window.document;
    const cardpack = doc.querySelector('[data-ac="cardpack"]');
    return cardpack ?? host ?? doc.body;
}

function showUpdateDialog(info, { host, onSkip, onInstalled, onClosed } = {}) {
    const anchor = resolveHost(host);
    const doc = anchor.ownerDocument;
    ensureNodeStyles(anchor);

    const overlay = el(doc, 'div', 'ac-export ac-update');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ac-update-title');
    const backdrop = el(doc, 'div', 'ac-export__backdrop');
    backdrop.setAttribute('aria-hidden', 'true');
    const panel = el(doc, 'div', 'ac-export__panel ac-update__panel');
    const head = el(doc, 'header', 'ac-export__head');
    const titles = el(doc, 'div', 'ac-export__titles');
    titles.append(el(doc, 'h2', 'ac-export__title', `发现新版本 v${info.latest}`));
    titles.append(
        el(doc, 'p', 'ac-export__desc', `当前 v${info.current} → 最新 v${info.latest}。自动更新会下载并替换插件文件，重启 Steam 后生效。`),
    );
    const closeButton = el(doc, 'button', 'ac-export__x', '×');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', '关闭');
    head.append(titles, closeButton);

    const notes = el(doc, 'div', 'ac-update__notes');
    const body = releaseNotesText(info.notes);
    notes.textContent = body.length > 1200 ? `${body.slice(0, 1200)}…` : body;
    if (!notes.textContent) notes.hidden = true;

    const status = el(doc, 'p', 'ac-update__status');
    status.setAttribute('role', 'status');

    const footer = el(doc, 'footer', 'ac-export__foot');
    const skipButton = el(doc, 'button', 'ac-export__btn', '暂不更新');
    skipButton.type = 'button';
    const pageButton = el(doc, 'button', 'ac-export__btn', '前往发布页');
    pageButton.type = 'button';
    const installButton = el(doc, 'button', 'ac-export__btn ac-export__btn--primary', '自动更新');
    installButton.type = 'button';

    const assets = info.assets ?? {};
    const canInstall = backendAvailable() && REQUIRED_ASSETS.every((name) => assets?.[name]?.url);
    footer.append(skipButton, pageButton);
    if (canInstall) footer.append(installButton);

    panel.append(head);
    if (!notes.hidden) panel.append(notes);
    panel.append(status, footer);
    overlay.append(backdrop, panel);
    doc.body.append(overlay);

    let closed = false;
    let busy = false;
    let installed = false;
    const finish = () => {
        if (closed) return;
        closed = true;
        overlay.remove();
        doc.defaultView?.removeEventListener('keydown', onKeyDown, true);
        onClosed?.();
    };
    const onKeyDown = (event) => {
        if (event.key !== 'Escape' || event.defaultPrevented || busy) return;
        event.preventDefault();
        finish();
    };
    const close = () => finish();

    closeButton.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    doc.defaultView?.addEventListener('keydown', onKeyDown, true);

    const setStatus = (text, tone = '') => {
        status.textContent = text;
        status.className = `ac-update__status${tone ? ` is-${tone}` : ''}`;
    };
    const setBusy = (value) => {
        busy = value;
        closeButton.disabled = value;
        skipButton.disabled = value;
        pageButton.disabled = value;
        installButton.disabled = value;
    };

    skipButton.addEventListener('click', () => {
        if (!installed) writeState({ skippedVersion: info.latest });
        onSkip?.(info);
        finish();
    });
    pageButton.addEventListener('click', () => {
        openReleasesPage();
    });
    installButton.addEventListener('click', async () => {
        setBusy(true);
        setStatus('正在下载并安装更新，请稍候…');
        try {
            const result = await callBackend('InstallUpdate', {
                version: info.latest,
                tag: info.tag || `v${info.latest}`,
                assets,
            });
            if (!result?.success) throw new Error(result?.error || '后端返回失败');
            installed = true;
            writeState({ skippedVersion: null });
            setStatus(`已安装 v${result.version ?? info.latest}，重启 Steam 后生效。`, 'ok');
            installButton.remove();
            skipButton.textContent = '完成';
            pageButton.disabled = false;
            skipButton.disabled = false;
            closeButton.disabled = false;
            busy = false;
            onInstalled?.(info);
        } catch (err) {
            setStatus(`自动更新失败：${err?.message ?? err}。可以前往发布页手动下载。`, 'error');
            installButton.disabled = false;
            skipButton.disabled = false;
            pageButton.disabled = false;
            closeButton.disabled = false;
            busy = false;
        }
    });

    if (canInstall) installButton.focus();
    else pageButton.focus();

    return { close };
}

/* ── 检查入口 ───────────────────────────────────────────────────────────── */

let inflight = null;

function statusOf(info, manual = false) {
    return decideUpdate({
        latest: info.latest,
        running: PLUGIN_VERSION,
        onDisk: info.onDisk,
        installed: installedVersion,
        skipped: readState().skippedVersion,
        manual,
    });
}

/** 把现在该显示的提醒告诉卡册；卡册没开着时没有人听，下次进入会再发一遍 */
function publishNotice() {
    const info = lastRelease?.info;
    const status = info ? statusOf(info) : 'latest';
    const notice = status === 'latest'
        ? null
        : {
              latest: info.latest,
              restart: status === 'restart',
              prompt: status === 'update' && dismissedVersion !== info.latest && !openDialog,
          };
    window.dispatchEvent(new CustomEvent('ac:update-notice', { detail: notice }));
}

/** 弹出更新窗口。已经开着，或者还没有查到结果时什么也不做 */
export function openUpdateDialog(host = null) {
    const info = lastRelease?.info;
    if (!info || openDialog || statusOf(info, true) !== 'update') return;
    openDialog = showUpdateDialog(
        { ...info, current: PLUGIN_VERSION },
        {
            host,
            onInstalled: () => {
                installedVersion = info.latest;
            },
            onClosed: () => {
                openDialog = null;
                dismissedVersion = info.latest;
                publishNotice();
            },
        },
    );
    publishNotice();
}

async function refreshRelease(manual) {
    const fresh = lastRelease && Date.now() - lastRelease.at < RECHECK_GAP_MS;
    if (fresh && !manual) return null;
    try {
        const info = await askGitHub();
        lastRelease = { at: Date.now(), info: { ...info, latest: String(info.latest).replace(/^v/i, '') } };
        writeState({ lastCheckAt: Date.now(), lastErrorAt: null, lastError: null });
        return null;
    } catch (err) {
        const message = err?.message ?? String(err);
        writeState({ lastErrorAt: Date.now(), lastError: message });
        return message;
    }
}

async function runCheck({ manual = false, host = null } = {}) {
    const error = await refreshRelease(manual);
    const info = lastRelease?.info;
    // 这次没连上：手动检查要如实告知；自动检查下次进入再试，手里有上次的结果就接着提醒
    if (error && (manual || !info)) return { status: 'error', error, current: PLUGIN_VERSION };

    const status = statusOf(info, manual);
    publishNotice();
    if (manual && status === 'update') openUpdateDialog(host);
    return { status, latest: info.latest, current: PLUGIN_VERSION };
}

export async function checkForUpdates(options = {}) {
    // 手动检查不能吃自动检查的结果：那次可能已经被「暂不更新」拦下，点了按钮却没有反应
    if (inflight && options.manual) await inflight.catch(() => {});
    if (inflight) return inflight;
    inflight = runCheck(options).finally(() => {
        inflight = null;
    });
    return inflight;
}

/** 进入卡包：让页面先画完，再静默检查 */
export function maybeCheckOnOpen(host) {
    window.setTimeout(() => {
        checkForUpdates({ host }).catch(() => {});
    }, OPEN_CHECK_DELAY_MS);
}

/** 面板里的手动检查 */
export function checkNow(host) {
    return checkForUpdates({ manual: true, host }).catch((err) => ({
        status: 'error',
        error: err?.message ?? String(err),
    }));
}
