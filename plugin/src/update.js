/**
 * 插件自更新。
 *
 * Millennium 的自动更新对本插件不可靠，所以插件自己问 GitHub 最新 release：
 *   · 进入卡包时静默检查一次（每个 Steam 会话一次）；
 *   · 有新版时弹窗：自动更新 / 前往发布页 / 暂不更新（跳过这一版）；
 *   · 自动更新走后端 Lua：下载 release 资产并替换插件文件，重启 Steam 后生效。
 *
 * 网络与文件写入全部在后端完成，前端只负责展示。后端不可用时退回浏览器 fetch，
 * 这时只提示、不自动安装。
 */

import { ensureNodeStyles } from '../../src/js/ac/env.js';
import { PLUGIN_NAME, PLUGIN_VERSION } from './mode.js';
import { openReleasesPage, RELEASES_PAGE } from './release.js';

const REPO = 'Kevin0036/steam_achievement_improve';
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const STATE_KEY = 'ac:plugin:update:v1';
const OPEN_CHECK_DELAY_MS = 1200;
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

/* 只在本个 Steam 会话里限一次；不跨会话节流，否则新版本发布后要等几小时才会提示 */
let checkedThisSession = false;

/* ── 版本号 ─────────────────────────────────────────────────────────────── */

function versionParts(value) {
    // 预发布后缀（1.1.7-beta）只影响显示，比较时按 1.1.7 处理，否则内测版永远收不到正式版
    const cleaned = String(value ?? '').trim().replace(/^v/i, '').split('-')[0];
    if (!/^\d+(\.\d+)*$/.test(cleaned)) return null;
    return cleaned.split('.').map((part) => Number.parseInt(part, 10));
}

export function isNewerVersion(candidate, current) {
    const a = versionParts(candidate);
    const b = versionParts(current);
    if (!a || !b) return false;
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const left = a[i] ?? 0;
        const right = b[i] ?? 0;
        if (left !== right) return left > right;
    }
    return false;
}

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
                    return normalizeRelease(JSON.parse(info.raw));
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

function showUpdateDialog(info, { host, onSkip, onInstalled } = {}) {
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
    const body = String(info.notes ?? '').trim();
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
            writeState({ installedVersion: info.latest, skippedVersion: null });
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

async function runCheck({ force = false, manual = false, host = null } = {}) {
    if (!manual && !force && checkedThisSession) {
        return { status: 'session', current: PLUGIN_VERSION };
    }
    checkedThisSession = true;
    const state = readState();

    let info;
    try {
        info = await askGitHub();
    } catch (err) {
        writeState({ lastErrorAt: Date.now(), lastError: err?.message ?? String(err) });
        return { status: 'error', error: err?.message ?? String(err), current: PLUGIN_VERSION };
    }

    const latest = String(info.latest ?? '').replace(/^v/i, '');
    const update = isNewerVersion(latest, PLUGIN_VERSION);
    writeState({ lastCheckAt: Date.now(), lastErrorAt: null, lastError: null });

    if (!update) return { status: 'latest', latest, current: PLUGIN_VERSION };
    if (state.installedVersion === latest) {
        return { status: 'installed', latest, current: PLUGIN_VERSION };
    }
    if (!manual && state.skippedVersion === latest) {
        return { status: 'skipped', latest, current: PLUGIN_VERSION };
    }

    showUpdateDialog(
        {
            ...info,
            latest,
            current: PLUGIN_VERSION,
            tag: info.tag || `v${latest}`,
            notes: info.notes ?? '',
            assets: info.assets ?? {},
        },
        {
            host,
            onSkip: () => {},
        },
    );
    return { status: 'update', latest, current: PLUGIN_VERSION };
}

export function checkForUpdates(options = {}) {
    if (inflight) return inflight;
    inflight = runCheck(options).finally(() => {
        inflight = null;
    });
    return inflight;
}

/** 首次进入卡包：让页面先画完，再做一次静默检查 */
export function maybeCheckOnOpen(host) {
    window.setTimeout(() => {
        checkForUpdates({ host }).catch(() => {});
    }, OPEN_CHECK_DELAY_MS);
}

/** 面板里的手动检查 */
export function checkNow(host) {
    return checkForUpdates({ force: true, manual: true, host }).catch((err) => ({
        status: 'error',
        error: err?.message ?? String(err),
    }));
}
