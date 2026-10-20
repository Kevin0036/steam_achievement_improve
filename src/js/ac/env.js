/**
 * 成就收藏册 · 环境层（唯一允许直接触碰「全局对象名字」的地方之一）
 *
 * 为什么需要这一层：
 *   主题 JS 被 Millennium 以 <script type="module"> 注入到目标文档里，
 *   它自己所在的 `window` 与拥有 `SP_REACT` / `MILLENNIUM_API` / `SteamClient`
 *   的那个 window 是不是同一个，官方文档没有承诺，现有主题里两种写法都出现过
 *   （SpaceTheme 有 3 处走 `window.opener`，其余全部直接走 `window`）。
 *
 *   所以这里统一按 `window.X ?? window.opener?.X` 的顺序探测，
 *   并把**实际命中路径**记录下来，交给 selftest 打印。
 *   成本极低，收益是把一个未验证项变成一个自适应项。
 *
 * 另外：Steam 与 Millennium 的全局对象出现时机不同步
 * （`appAchievementProgressCache` 要等异步 Init 完成、
 *  `SteamClient` 要等客户端初始化），因此这里**不做长期缓存**，
 * 但提供一个 `waitForGlobal` 做有超时的等待。
 */

import { waitFor, tagged } from './utils.js';

const out = tagged('env');

const W = typeof window !== 'undefined' ? window : globalThis;

/** 上一次探测的命中路径，供 selftest 报告 */
const hits = new Map();

function readFrom(target, path) {
    try {
        const value = path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), target);
        return value;
    } catch {
        return undefined;
    }
}

function probe(path) {
    let value = readFrom(W, path);
    if (value !== undefined && value !== null) {
        hits.set(path, 'window');
        return value;
    }

    const opener = W.opener;
    if (opener && opener !== W) {
        value = readFrom(opener, path);
        if (value !== undefined && value !== null) {
            hits.set(path, 'window.opener');
            return value;
        }
    }

    if (!hits.has(path)) hits.set(path, null);
    return undefined;
}

/** 取一个可能是「晚到」的全局，等不到就返回 undefined（调用方自己降级） */
export async function waitForGlobal(path, { timeout = 20000, interval = 150 } = {}) {
    const existing = probe(path);
    if (existing !== undefined) return existing;

    out.log(`等待全局 ${path} …`);
    const found = await waitFor(() => probe(path), { timeout, interval });
    if (found === undefined) out.warn(`全局 ${path} 在 ${timeout}ms 内没有出现`);
    return found;
}

/**
 * 取 SteamClient 上的某个方法，例如 `Apps.GetMyAchievementsForApp`。
 *
 * 不能直接用 probe('SteamClient')：主题跑在「SP Desktop」这个子窗口里，
 * 子窗口自己就有一个 `SteamClient`，但那是删减版，`Apps.GetMyAchievementsForApp`
 * 之类的接口只在主上下文（window.opener，也就是 Steam 自己的 sp.js 所在的地方）上才有。
 * 所以这里按窗口逐个找**真正带着这个方法**的那一个，并绑定好 this。
 */
export function getSteamClientMethod(path) {
    const parts = path.split('.');
    const name = parts.pop();
    const targets = [['window', W]];
    if (W.opener && W.opener !== W) targets.push(['window.opener', W.opener]);

    for (const [via, target] of targets) {
        const owner = readFrom(target, ['SteamClient', ...parts].join('.'));
        let fn;
        try {
            fn = owner?.[name];
        } catch {
            fn = undefined;
        }
        if (typeof fn === 'function') {
            hits.set(`SteamClient.${path}`, via);
            return fn.bind(owner);
        }
    }
    hits.set(`SteamClient.${path}`, null);
    return undefined;
}

/* ── 具体全局的读取入口 ─────────────────────────────────────────────────── */

export const getMillenniumApi = () => probe('MILLENNIUM_API');
export const getReact = () => probe('SP_REACT');
export const getReactDom = () => probe('SP_REACTDOM');
export const getSteamClient = () => probe('SteamClient');
export const getAppStore = () => probe('appStore');
export const getAchievementCache = () => probe('appAchievementProgressCache');
export const getPluginList = () => probe('PLUGIN_LIST');
/** Steam 主应用实例（`window.App.GetCurrentUser()` 里有当前账号的 steamID / 账号名） */
export const getApp = () => probe('App');
/** Steam app details, including cached library artwork paths. */
export const getAppDetailsStore = () => probe('appDetailsStore');
/** Steam's read interface for userdata/config/librarycache/<appid>.json. */
export const getAppDetailsCache = () => probe('appDetailsCache');
/** 登录用户表（`currentUser` 带 personaName / avatarUrl，登录界面用的就是它；兜底用） */
export const getLoginStore = () => probe('loginStore');
/** 好友与个人资料（顶栏右上角的昵称和头像就是从这里取的） */
export const getFriendStore = () => probe('friendStore');
/** 游戏名 / 图标信息（不在库里的游戏也能查到名字） */
export const getAppInfoStore = () => probe('appInfoStore');

/** 从主题自己的条件配置里取一个选项值（当前 Millennium 存在 core.conditionals[主题目录名]） */
export function getThemeOption(name, fallback = undefined) {
    try {
        const native = probe('PLUGIN_LIST.core.activeTheme.native');
        const store = native ? probe('PLUGIN_LIST.core.conditionals')?.[native] : undefined;
        if (store && Object.prototype.hasOwnProperty.call(store, name)) {
            return store[name];
        }

        // 兼容 Millennium <=1.1.5 的旧配置结构
        const list = probe('PLUGIN_LIST.core.activeTheme.data.Configuration');
        const entry = list?.find?.((item) => item?.Name === name);
        return entry?.Value ?? fallback;
    } catch {
        return fallback;
    }
}

export function getThemeName() {
    return probe('PLUGIN_LIST.core.activeTheme.data.name') ?? null;
}

/** 一次性把关键全局都探一遍并发出来，用于初始化日志与 selftest */
export function snapshot() {
    const keys = [
        'MILLENNIUM_API',
        'SP_REACT',
        'SP_REACTDOM',
        'SP_JSX_FACTORY',
        'SteamClient',
        'appStore',
        'appAchievementProgressCache',
        'PLUGIN_LIST.core.activeTheme.data.name',
    ];
    const result = {};
    for (const key of keys) result[key] = { value: probe(key) !== undefined, via: hits.get(key) ?? null };
    return { keys: result, hits: Object.fromEntries(hits) };
}

export const __internal = { probe, hits };
