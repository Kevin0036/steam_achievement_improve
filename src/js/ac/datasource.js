/**
 * 成就收藏册 · 数据层
 *
 * 这是整个项目**唯一**接触 Steam 数据的地方。展示层不认识任何 Steam API。
 *
 * ── 主数据源（第一层）：客户端内存里的成就进度缓存，只读 ─────────────────
 *   window.appAchievementProgressCache.m_achievementProgress.mapCache
 *
 *   注意是**两层**：管理器 → m_achievementProgress → mapCache。
 *   写成 appAchievementProgressCache.mapCache 会静默拿到 undefined，
 *   结果全部游戏都会变成「数据未知」。
 *
 *   ⚠️ 正常读取只碰 mapCache，不调用 GetAchievementProgress() / SaveCacheFile()。
 *      唯一例外：Steam 的缓存可能完全不存在，也可能只覆盖一部分库内游戏
 *      （它只在成就通知等时机刷新进度）。此时 ensureProgressCache() 会对
 *      mapCache 里缺失的库内游戏调用 GetAchievementProgress()，让 Steam 自己
 *      合并成一次批量请求并写回缓存；同一个 appid 在一次 Steam 会话里只排一次队。
 *
 * ── 全球完成率：Steam Player.GetGameAchievements 服务 ──────────────────
 *   通过客户端已有 CM 连接获取 player_percent_unlocked（0–100）。
 *   离线时只读已有 achievementmap（版本 5）作为兜底，不依赖预览服务。
 *
 * ── 完成日期（第三层）：按需、串行、限流 ─────────────────────────────────
 *   SteamClient.Apps.GetMyAchievementsForApp(appid) → data.rgAchievements
 *   使用 bAchieved 与 rtUnlocked（Unix 秒）取最后一个成就的解锁时间。
 *   此接口的 flAchieved 在真实客户端可能整批为 0，绝不用于全球完成率分类。
 *   注意这个接口只在主上下文的 SteamClient 上有，子窗口里的是删减版（见 env.getSteamClientMethod）。
 *
 *   约束：串行一次一个、按 appid 去重、8 秒超时。
 *         失败了本次运行里最多再试一次（store.js 隔 1.5 秒排到队尾），仍失败就留空，
 *         等下次启动 Steam 再说；取到的完成日期永久缓存，不会反复请求。
 */

import { DATA } from './selectors.js';
import {
    getAchievementCache,
    getApp,
    getMillenniumApi,
    getAppDetailsCache,
    getAppDetailsStore,
    getAppInfoStore,
    getAppStore,
    getFriendStore,
    getLoginStore,
    getSteamClientMethod,
} from './env.js';
import { log, waitFor, warn, tagged } from './utils.js';

const out = tagged('data');

/* ── 第一层：只读客户端缓存 ─────────────────────────────────────────────── */

/**
 * @returns {{status:'ready'|'not-ready', entries:Map<number, object>}}
 */
export function readProgress() {
    const manager = getAchievementCache();
    const progress = manager?.[DATA.progressField];

    // 铁律 2 的具体场景：异步 Init 未完成 / 版本号不匹配 / 读取失败，
    // 都会让 m_achievementProgress 是 undefined。这**不是**「没有全成就游戏」。
    if (!progress) return { status: 'not-ready', entries: new Map() };

    const raw = progress[DATA.progressMap];
    if (!raw) return { status: 'not-ready', entries: new Map() };

    let entries;
    try {
        // 运行时是真 Map（new Map(x.data.mapCache)）；文件镜像里是 [k, v] 数组。
        // 两种都接受，避免客户端实现细节变化时静默拿空数据。
        entries = raw instanceof Map ? new Map(raw) : new Map(raw);
    } catch (err) {
        warn('mapCache 结构异常，按数据未就绪处理', err);
        return { status: 'not-ready', entries: new Map() };
    }

    if (entries.size === 0) return { status: 'not-ready', entries };

    return { status: 'ready', entries };
}

export function getProgressEntry(appid) {
    const { status, entries } = readProgress();
    if (status !== 'ready') return null;
    return entries.get(appid) ?? entries.get(String(appid)) ?? null;
}

/** 首次运行等待 Steam 建立缓存的最长时间 */
const CACHE_BOOTSTRAP_TIMEOUT_MS = 20000;
/** 已有部分缓存时，补齐缺失条目等待的最长时间（Steam 一次批量请求通常很快） */
const CACHE_TOPUP_TIMEOUT_MS = 8000;

let progressBootstrap = null;
/** 本次 Steam 会话里已经排过队的 appid：避免每次进入卡包都重复请求 */
const progressRequested = new Set();

/**
 * 补齐库内游戏的成就进度缓存。
 *
 * Steam 只在成就通知等时机刷新进度，所以 achievement_progress.json 只覆盖
 * 一部分库内游戏是常态。以前这里只要缓存里**有任何一条**就返回，缺失的
 * 游戏永远不会被请求，卡册因此少卡；现在按库内列表找出 mapCache 里没有的
 * appid，交给 Steam 自己的 GetAchievementProgress() 排队。
 *
 * 同一个 appid 在一次 Steam 会话里最多排一次队；手动刷新会清空这个记录。
 *
 * @returns {Promise<{attempted:number[], added:number[], toppedUp:number[], ready:boolean}>}
 *          attempted = 本次实际排队的 appid，added = 排队后出现在 mapCache 里的 appid，
 *          toppedUp = 本次 Steam 会话里所有补过缓存的 appid（条目可能晚到）
 */
export function ensureProgressCache() {
    const before = readProgress();
    const libraryAppids = [
        ...new Set(listLibraryApps().map((app) => app?.appid).filter(Number.isFinite)),
    ];
    const missing = libraryAppids.filter(
        (appid) => !before.entries.has(appid) && !progressRequested.has(appid),
    );
    const toppedUp = () => [...progressRequested];

    if (missing.length === 0) {
        return Promise.resolve({ attempted: [], added: [], toppedUp: toppedUp(), ready: before.status === 'ready' });
    }
    if (progressBootstrap) return progressBootstrap;

    progressBootstrap = (async () => {
        let manager = getAchievementCache();
        if (!manager) {
            manager = await waitFor(() => getAchievementCache(), { timeout: 10000, interval: 150 });
        }
        if (!manager || typeof manager.GetAchievementProgress !== 'function') {
            return { attempted: [], added: [], toppedUp: toppedUp(), ready: false };
        }

        // Init() 完成前 m_CMInterface 是空的，此时排队会在 100ms 后抛错。
        if (!manager.CMInterface) {
            await waitFor(() => manager.CMInterface, { timeout: 10000, interval: 150 });
        }
        if (!manager.CMInterface) return { attempted: [], added: [], toppedUp: toppedUp(), ready: false };

        const attempted = [];
        for (const appid of missing) {
            try {
                manager.GetAchievementProgress(appid);
                attempted.push(appid);
                progressRequested.add(appid);
            } catch {
                // 单款失败不影响其余
            }
        }
        if (attempted.length === 0) {
            return { attempted, added: [], toppedUp: toppedUp(), ready: readProgress().status === 'ready' };
        }

        const wasReady = before.status === 'ready';
        out.log(
            wasReady
                ? `成就进度缓存缺少 ${attempted.length} 款库内游戏，向 Steam 请求补齐…`
                : `成就进度缓存未就绪，向 Steam 请求 ${attempted.length} 款游戏的进度…`,
        );

        const wanted = new Set(attempted);
        await waitFor(
            () => {
                const now = readProgress();
                if (now.status !== 'ready') return false;
                for (const appid of wanted) if (!now.entries.has(appid)) return false;
                return true;
            },
            {
                timeout: wasReady ? CACHE_TOPUP_TIMEOUT_MS : CACHE_BOOTSTRAP_TIMEOUT_MS,
                interval: 250,
            },
        );

        const after = readProgress();
        const added = attempted.filter((appid) => after.entries.has(appid));
        out.log(
            added.length === attempted.length
                ? `成就进度缓存已补齐 ${added.length} 款游戏`
                : `补齐成就进度：${added.length}/${attempted.length} 款（其余可能没有成就数据）`,
        );
        return { attempted, added, toppedUp: toppedUp(), ready: after.status === 'ready' };
    })()
        .catch((err) => {
            warn('初始化 Steam 成就进度缓存失败', err);
            return { attempted: [], added: [], toppedUp: toppedUp(), ready: false };
        })
        .finally(() => {
            progressBootstrap = null;
        });

    return progressBootstrap;
}

/** 手动刷新时允许再试一次 */
export function resetProgressBootstrap() {
    progressBootstrap = null;
    progressRequested.clear();
}

/* ── 游戏列表与美术资源 ─────────────────────────────────────────────────── */

export function listLibraryApps() {
    const store = getAppStore();
    const apps = store?.allApps;
    return Array.isArray(apps) ? apps : [];
}

export function getOverview(appid) {
    const store = getAppStore();
    try {
        return store?.GetAppOverviewByAppID?.(appid) ?? null;
    } catch {
        return null;
    }
}

/** Steam's cached library artwork paths, such as `hash/library_hero.jpg`. */
export function getLibraryAssets(appid) {
    const store = getAppDetailsStore();
    try {
        return store?.GetAppDetails?.(appid)?.libraryAssets ?? null;
    } catch {
        return null;
    }
}

/** Read native details directly: the Steam store callback can overwrite unloaded disk caches. */
export async function requestLibraryAssets(appid, { signal } = {}) {
    const existing = getLibraryAssets(appid);
    if (existing || signal?.aborted) return existing;
    const register = getSteamClientMethod('Apps.RegisterForAppDetails');
    if (!register) return null;

    let subscription;
    try {
        return await withTimeout(new Promise((resolve) => {
            subscription = register(Number(appid), (details) => {
                if (details?.libraryAssets) resolve(details.libraryAssets);
            });
        }), TIMEOUT_MS, `LibraryAssets(${appid})`, signal);
    } catch (err) {
        if (!signal?.aborted) out.log(`读取 ${appid} 的封面详情失败：${err?.message ?? err}`);
        return null;
    } finally {
        subscription?.unregister?.();
    }
}

/* ── 第三层：完成日期 ───────────────────────────────────────────────────── */

const TIMEOUT_MS = 8000;

/** 串行队列：绝不并发，一次一个 */
class SerialQueue {
    #tail = Promise.resolve();

    enqueue(task) {
        const run = this.#tail.then(task, task);
        // 队列本身不能因为某个任务失败而断掉
        this.#tail = run.catch(() => {});
        return run;
    }
}

const queue = new SerialQueue();
/** 一个生命周期内一个 appid 只调一次 */
const inFlight = new Map();

function withTimeout(promise, ms, label, signal) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            reject(new Error(`${label} 已取消`));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`${label} 超时（${ms}ms）`));
        }, ms);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        promise.then(
            (value) => {
                cleanup();
                resolve(value);
            },
            (err) => {
                cleanup();
                reject(err);
            },
        );
    });
}

const ACHIEVEMENTS_API = 'Apps.GetMyAchievementsForApp';

/**
 * Same global percentages used by Steam activity and the local preview.
 * GetCachedDataForApp only reads Steam's existing cache; no CM request or cache write.
 */
export async function requestCachedAchievements(appid, { signal } = {}) {
    if (signal?.aborted) return null;
    let raw;
    const detailsCache = getAppDetailsCache();
    try {
        if (typeof detailsCache?.GetCachedDataForApp === 'function') {
            raw = await withTimeout(
                Promise.resolve(detailsCache.GetCachedDataForApp(Number(appid), 'achievementmap', 5)),
                TIMEOUT_MS, `AchievementMap(${appid})`, signal,
            );
        }
        if (raw == null && !signal?.aborted) {
            const fetchCachedDetails = getSteamClientMethod('Apps.GetCachedAppDetails');
            if (!fetchCachedDetails) return null;
            const text = await withTimeout(
                Promise.resolve(fetchCachedDetails(Number(appid))), TIMEOUT_MS, `GetCachedAppDetails(${appid})`, signal,
            );
            const pairs = JSON.parse(text);
            const entry = Array.isArray(pairs) ? new Map(pairs).get('achievementmap') : null;
            if (entry?.version !== 5) return null;
            raw = entry.data;
        }

        const groups = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const rows = Array.isArray(groups) ? groups.find((row) => Array.isArray(row) && Number(row[0]) === Number(appid))?.[1] : null;
        if (!Array.isArray(rows)) return null;
        const achievements = new Map();
        for (const row of rows) {
            if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[1] || typeof row[1] !== 'object') continue;
            achievements.set(row[0], { strID: row[0], flAchieved: row[1].flAchieved });
        }
        return achievements.size ? { rgAchievements: [...achievements.values()] } : null;
    } catch (err) {
        if (!signal?.aborted) out.log(`读取 ${appid} 的全球完成率缓存失败：${err?.message ?? err}`);
        return null;
    }
}

/** Official schema + global percentages, independent of personal unlock dates. */
export async function requestGlobalAchievements(appid, { signal, expectedTotal } = {}) {
    if (signal?.aborted) return null;
    try {
        const api = getMillenniumApi();
        const match = (value) => value && typeof value.GetGameAchievements === 'function';
        const service = api?.findModuleExport?.(match)
            ?? Object.values(api?.findModuleByExport?.(match) ?? {}).find(match);
        const transport = getApp()?.cm?.GetServiceTransport?.();
        if (service && transport) {
            const result = await withTimeout(
                // Language is required by Player.GetGameAchievements, even when only rates are used.
                service.GetGameAchievements(transport, { appid: Number(appid), language: 'schinese' }),
                TIMEOUT_MS, `GlobalAchievements(${appid})`, signal,
            );
            if (result?.GetEResult() === 1) {
                let rows = result.Body().toObject().achievements;
                if (Array.isArray(rows) && rows.length) {
                    rows = rows.filter((row) => row.internal_name && !row.archived);
                    // Games may add achievements after the collection was completed.
                    // Classify the confirmed unlocked collection, never an arbitrary schema slice.
                    if (Number.isInteger(expectedTotal) && rows.length > expectedTotal) {
                        const steamid = getApp()?.GetCurrentUser?.()?.strSteamID;
                        if (steamid && typeof service.GetUserAchievements === 'function') {
                            const user = await withTimeout(
                                service.GetUserAchievements(transport, { appid: Number(appid), steamid }),
                                TIMEOUT_MS, `UserAchievements(${appid})`, signal,
                            );
                            if (user?.GetEResult() === 1) {
                                const own = user.Body().toObject().achievements;
                                const keys = new Set((Array.isArray(own) ? own : [])
                                    .filter((row) => row.unlocked === true && Number.isInteger(row.internal_key))
                                    .map((row) => row.internal_key));
                                const matched = rows.filter((row) => keys.has(row.internal_key));
                                if (keys.size === expectedTotal && matched.length === expectedTotal
                                    && new Set(matched.map((row) => row.internal_key)).size === expectedTotal) {
                                    rows = matched;
                                }
                            }
                        }
                    }
                    const unique = new Map();
                    for (const row of rows) {
                        if (!row.internal_name || row.archived) continue;
                        const raw = row.player_percent_unlocked;
                        const pct = (typeof raw === 'number' || typeof raw === 'string' && raw.trim() !== '')
                            ? Number(raw) : NaN;
                        unique.set(row.internal_name, {
                            strID: row.internal_name,
                            flAchieved: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : undefined,
                        });
                    }
                    if (unique.size) return { rgAchievements: [...unique.values()], source: 'player-service' };
                }
            } else {
                out.log(`读取 ${appid} 的全球完成率失败：eresult-${result?.GetEResult?.() ?? 'none'}`);
            }
        }
    } catch (err) {
        if (!signal?.aborted) out.log(`读取 ${appid} 的全球完成率失败：${err?.message ?? err}`);
    }
    if (signal?.aborted) return null;
    const cached = await requestCachedAchievements(appid, { signal });
    return cached ? { ...cached, source: 'achievementmap' } : null;
}

/** 该 API 在当前上下文里是否可用（供 selftest 报告） */
export function probeAchievementsApi() {
    return typeof getSteamClientMethod(ACHIEVEMENTS_API) === 'function';
}

/**
 * 取一个游戏的全部成就数据。
 *
 * @returns {Promise<{ok:true, data:object} | {ok:false, reason:string}>}
 */
export function requestAchievements(appid) {
    const fetchAchievements = getSteamClientMethod(ACHIEVEMENTS_API);
    if (!fetchAchievements) {
        return Promise.resolve({ ok: false, reason: 'api-unavailable' });
    }

    const key = String(appid);
    const existing = inFlight.get(key);
    if (existing) return existing;

    const task = queue.enqueue(async () => {
        try {
            const result = await withTimeout(
                Promise.resolve(fetchAchievements(key)),
                TIMEOUT_MS,
                `GetMyAchievementsForApp(${key})`,
            );

            // EResult.OK === 1
            if (!result || result.result !== 1) {
                return { ok: false, reason: `eresult-${result?.result ?? 'none'}` };
            }
            if (!Array.isArray(result.data?.rgAchievements)) {
                return { ok: false, reason: 'no-achievements-array' };
            }

            return { ok: true, data: result.data };
        } catch (err) {
            out.log(`读取 ${key} 的成就失败：${err?.message ?? err}`);
            return { ok: false, reason: 'error' };
        } finally {
            inFlight.delete(key);
        }
    });

    inFlight.set(key, task);
    return task;
}

/** 供路由离开时清空去重表（未完成的 Promise 由 generation 令牌负责丢弃结果） */
export function resetInFlight() {
    inFlight.clear();
}

/* ── 册子的主人（昵称 / 头像） ──────────────────────────────────────────── */

const STEAMID64_BASE = 76561197960265728n;

/** 64 位 steamID → 32 位 accountID */
function toAccountId(steamid) {
    try {
        return Number(BigInt(steamid) - STEAMID64_BASE);
    } catch {
        return null;
    }
}

function firstString(source, keys) {
    if (!source) return null;
    for (const key of keys) {
        let value;
        try {
            value = source[key];
        } catch {
            value = undefined;
        }
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

/** 只认能直接当 <img src> 用的地址 */
function usableImageUrl(value) {
    return typeof value === 'string' && /^(https?:|data:image\/)/i.test(value) ? value : null;
}

/**
 * 当前账号的昵称与头像。
 *
 * 主来源是 `window.friendStore`：Steam 顶栏右上角的昵称和头像就是
 *   friendStore.GetFriendState(friendStore.currentUserSteamID)
 * 上的 `persona.m_strPlayerName` 与 `persona.avatar_url_*`（sp.js 里的 useCurrentUserPersona 一系列 hook）。
 * 兜底是登录用户表 `loginStore.currentUser`（登录界面用的那一份，带 personaName / avatarUrl）。
 *
 * ⚠️ `window.App.GetCurrentUser()` 上只有**账号名**（strAccountName），
 *    它长得像昵称但其实是登录名，绝不能拿来当昵称显示。
 *
 * 拿不到就返回 null，卡面那一行只显示完成日期 —— 绝不编造。
 */
export async function getOwner() {
    try {
        const app = getApp();
        const current = app?.GetCurrentUser?.() ?? null;
        const steamid = firstString(current, ['strSteamID']);
        const accountId = steamid ? toAccountId(steamid) : null;

        let persona = null;
        let avatar = null;

        const friends = getFriendStore();
        const who = friends?.currentUserSteamID ?? accountId;
        if (who != null && typeof friends?.GetFriendState === 'function') {
            const self = friends.GetFriendState(who);
            const card = self?.persona ?? null;
            persona = firstString(card, ['m_strPlayerName']) ?? firstString(self, ['display_name']);
            avatar =
                usableImageUrl(card?.avatar_url_full) ??
                usableImageUrl(card?.avatar_url_medium) ??
                usableImageUrl(card?.avatar_url);
        }

        if (!persona || !avatar) {
            const user = getLoginStore()?.currentUser ?? null;
            persona = persona ?? firstString(user, ['personaName']);
            avatar = avatar ?? usableImageUrl(user?.avatarUrl);
        }

        return { steamid: steamid ?? null, accountId, persona, avatar };
    } catch (err) {
        warn('读取当前账号信息失败（不影响卡片本身）', err);
        return null;
    }
}

/* ── 不在库里的游戏的名字 ───────────────────────────────────────────────── */

/**
 * 用 Steam 自己的 appInfoStore 查游戏名。
 *
 * 成就进度缓存里可能有**已经不在库里**的游戏（家庭共享借玩过、已移除等），
 * appStore 查不到它们的概览，名字就只剩 appid。appInfoStore 是客户端给好友动态、
 * 聊天等处显示「任意游戏名」用的：先读它自己的本地缓存，缺的才合并成一次批量请求。
 *
 * @param {number[]} appids
 * @returns {Promise<Map<number, string>>}
 */
export async function resolveAppNames(appids) {
    const names = new Map();
    const store = getAppInfoStore();
    if (!store || typeof store.GetAppInfo !== 'function' || appids.length === 0) return names;

    try {
        if (typeof store.EnsureAppInfoForAppIDs === 'function') {
            await withTimeout(Promise.resolve(store.EnsureAppInfoForAppIDs(appids)), TIMEOUT_MS, 'EnsureAppInfoForAppIDs');
        }
    } catch (err) {
        out.log(`查询游戏名没有完成：${err?.message ?? err}`);
    }

    for (const appid of appids) {
        try {
            const info = store.GetAppInfo(appid);
            const name = info?.is_valid ? firstString(info, ['name']) : null;
            if (name) names.set(appid, name);
        } catch {
            // 单个查不到不影响别的
        }
    }
    return names;
}

/* ── 诊断 ───────────────────────────────────────────────────────────────── */

export function describeSource() {
    const manager = getAchievementCache();
    const hasManager = Boolean(manager);
    const hasProgress = Boolean(manager?.[DATA.progressField]);
    const { status, entries } = readProgress();

    let complete = 0;
    let zeroTotal = 0;
    if (status === 'ready') {
        for (const entry of entries.values()) {
            if (entry?.total === 0) zeroTotal += 1;
            if (entry?.all_unlocked === true) complete += 1;
        }
    }

    return {
        hasManager,
        hasProgress,
        status,
        entryCount: entries.size,
        completeCount: complete,
        zeroTotalCount: zeroTotal,
        achievementsApi: probeAchievementsApi(),
        libraryAppCount: listLibraryApps().length,
    };
}

export const __debug = { log, warn };

