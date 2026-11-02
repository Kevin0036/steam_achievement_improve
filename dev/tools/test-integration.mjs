/**
 * 成就收藏册 · 集成测试（Node，无需 Steam、无需浏览器）
 *
 * 做法：在 import 主题模块之前，先把 env.js 要探测的那些全局装到 globalThis 上
 * —— env.js 的探测顺序是 `window.X ?? window.opener?.X`，在没有 window 的环境里
 * 它会退到 globalThis，所以桩可以直接装在 globalThis 上。
 *
 * 这样 store.js / datasource.js / model.js / cache.js 会**原样跑真实代码**，
 * 包括主数据源读取、判定口径、完成日期的串行补全与取消机制。
 *
 * 用法：node tools/test-integration.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AC = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection', 'src', 'js', 'ac');

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

const NOW = Math.floor(Date.now() / 1000);
const storageData = new Map();

const APPS = {
    1001: {
        appid: 1001,
        display_name: 'Fixture Complete A',
        rt_last_time_played: NOW - 100,
        minutes_playtime_forever: 1200,
        header_filename: '160c9bebc0b3825cc7903ea7d2b3e2c1cdd136c3/library_header.jpg',
        library_capsule_filename: 'd2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule.jpg',
    },
    1002: { appid: 1002, display_name: 'Fixture Complete B', rt_last_time_played: NOW - 9000, minutes_playtime_forever: 300 },
    1003: { appid: 1003, display_name: 'Fixture Complete C', rt_last_time_played: NOW - 50000, minutes_playtime_forever: 88 },
    1004: { appid: 1004, display_name: 'Fixture Incomplete', rt_last_time_played: NOW - 10, minutes_playtime_forever: 60 },
    1005: { appid: 1005, display_name: 'Fixture ZeroTotal', rt_last_time_played: NOW - 20, minutes_playtime_forever: 10 },
    1006: { appid: 1006, display_name: 'Fixture NoCache', rt_last_time_played: NOW - 30, minutes_playtime_forever: 10 },
};

const PROGRESS = [
    [1001, { appid: 1001, unlocked: 36, total: 36, percentage: 100, all_unlocked: true, cache_time: NOW - 86400 * 3, vetted: true }],
    [1002, { appid: 1002, unlocked: 69, total: 69, percentage: 100, all_unlocked: true, cache_time: NOW - 86400 * 30, vetted: true }],
    [1003, { appid: 1003, unlocked: 12, total: 12, percentage: 100, all_unlocked: true, cache_time: NOW - 86400 * 200, vetted: true }],
    [1004, { appid: 1004, unlocked: 38, total: 67, percentage: 56.7, all_unlocked: false, cache_time: NOW - 86400, vetted: true }],
    [1005, { appid: 1005, unlocked: 0, total: 0, percentage: 0, all_unlocked: false, cache_time: NOW - 86400, vetted: false }],
    // 已经不在库里的游戏（家庭共享借玩过之类）：appStore 查不到概览，名字要靠 appInfoStore
    [2001, { appid: 2001, unlocked: 5, total: 5, percentage: 100, all_unlocked: true, cache_time: NOW - 86400 * 9, vetted: true }],
];

/** 每款游戏的成就解锁时间（用于验证「完成日期 = 最后一个成就的解锁时间」） */
const UNLOCK_TIMES = {
    1001: [NOW - 100000, NOW - 50000, NOW - 777],
    1002: [NOW - 900000, NOW - 4242],
    1003: [NOW - 1000, NOW - 999],
    2001: [NOW - 3000000, NOW - 2500000],
};

/** 全球解锁率：偶数下标是稀有（< 10%） */
const rarity = (i) => (i % 2 === 0 ? 3.5 : 55);

let calls = [];
let globalCalls = [];
let progressUpdateCalls = 0;
let clockSkewFor = null;
/** 模拟服务端残缺 schema：mapCache 说 3/3，完整个人列表其实有 45 个 */
let partialSchemaFor = null;
/** 这些 appid 第一次请求返回 EResult 2（CM 偶发失败），第二次才正常 */
const failOnce = new Set();
/** 服务端 GetAchievementsProgress 的数据；默认空，只回这里列出的 appid */
const SERVICE_PROGRESS = new Map();

/* ── 全局桩 ─────────────────────────────────────────────────────────────── */

function installStubs() {
    globalThis.localStorage = {
        get length() {
            return storageData.size;
        },
        key: (index) => [...storageData.keys()][index] ?? null,
        getItem: (key) => storageData.get(key) ?? null,
        setItem: (key, value) => storageData.set(key, String(value)),
        removeItem: (key) => storageData.delete(key),
    };

    // 和 Steam 里一样：主题所在的子窗口自己有一个删减版 SteamClient（没有成就接口），
    // 完整的那个在 window.opener（主上下文）上。
    globalThis.SteamClient = { Window: {}, Apps: {} };
    globalThis.opener = { SteamClient: createFullSteamClient() };

    globalThis.App = {
        GetCurrentUser: () => ({ strSteamID: '76561197960265770', strAccountName: 'zo345f' }),
        cm: { GetServiceTransport: () => ({}) },
    };
    const playerService = {
        GetGameAchievements: async (_transport, { appid }) => {
            globalCalls.push(appid);
            const total = PROGRESS.find(([id]) => id === appid)?.[1].total ?? 0;
            return { GetEResult: () => 1, Body: () => ({ toObject: () => ({ achievements:
                Array.from({ length: total }, (_, i) => ({ internal_name: `A${i}`, player_percent_unlocked: String(rarity(i)) })),
            }) }) };
        },
        GetAchievementsProgress: async (_transport, { appids }) => {
            const rows = (Array.isArray(appids) ? appids : [])
                .map((id) => SERVICE_PROGRESS.get(Number(id)))
                .filter(Boolean);
            return { GetEResult: () => 1, Body: () => ({ toObject: () => ({ achievement_progress: rows }) }) };
        },
    };
    globalThis.MILLENNIUM_API = { findModuleExport: match => match(playerService) ? playerService : undefined };
    globalThis.friendStore = {
        currentUserSteamID: { GetAccountID: () => 42 },
        GetFriendState: (who) => {
            const id = typeof who === 'number' ? who : who.GetAccountID();
            if (id !== 42) return null;
            return {
                display_name: 'Kevin0036',
                persona: { m_strPlayerName: 'Kevin0036', avatar_url_full: 'https://avatars.example/abc_full.jpg' },
            };
        },
    };
    globalThis.appInfoStore = {
        EnsureAppInfoForAppIDs: async () => {},
        GetAppInfo: (appid) => (appid === 2001 ? { is_valid: true, name: 'Outer Wilds' } : { is_valid: false }),
    };

    globalThis.appStore = {
        get allApps() {
            return Object.values(APPS);
        },
        GetAppOverviewByAppID: (appid) => APPS[appid] ?? null,
    };
    globalThis.appDetailsStore = {
        GetAppDetails: (appid) =>
            appid === 1001
                ? {
                      libraryAssets: {
                          strHeroImage: 'baf02b93170c9ca0b0e6b28be34b04a77009213d/library_hero.jpg',
                          strHeaderImage: '160c9bebc0b3825cc7903ea7d2b3e2c1cdd136c3/library_header.jpg',
                      },
                  }
                : null,
    };

    globalThis.appAchievementProgressCache = createProgressManager();
}

function createFullSteamClient() {
    return {
        Apps: {
            GetMyAchievementsForApp: async (appid) => {
                const id = Number(appid);
                calls.push(id);

                if (failOnce.delete(id)) return { result: 2, message: 'busy' };

                if (clockSkewFor === id) {
                    return {
                        result: 1,
                        data: { rgAchievements: [{ strID: 'X', bAchieved: true, rtUnlocked: NOW + 86400 * 60 }] },
                    };
                }

                if (partialSchemaFor === id) {
                    return {
                        result: 1,
                        data: {
                            rgAchievements: Array.from({ length: 45 }, (_, i) => ({
                                strID: `P${i}`,
                                bAchieved: i < 3,
                                rtUnlocked: i < 3 ? NOW - 3000 + i : 0,
                            })),
                        },
                    };
                }

                // 和个人进度一致的完整列表：总数取 mapCache，已解锁数也取 mapCache
                const entry = PROGRESS.find(([pid]) => pid === id)?.[1];
                if (entry && entry.total > 0) {
                    const times = UNLOCK_TIMES[id] ?? [];
                    return {
                        result: 1,
                        data: {
                            rgAchievements: Array.from({ length: entry.total }, (_, i) => ({
                                strID: `A${i}`,
                                bAchieved: i < entry.unlocked,
                                rtUnlocked: i < times.length ? times[i] : 0,
                                flAchieved: 0,
                            })),
                        },
                    };
                }

                // 拿不到个人成就列表的游戏
                return { result: 1, data: { rgAchievements: [] } };
            },
        },
    };
}

function createProgressManager() {
    const manager = {
        m_achievementProgress: {
            nVersion: 3,
            mapCache: new Map(PROGRESS),
        },
        CMInterface: {},
        GetAchievementProgress(appid) {
            progressUpdateCalls += 1;
            // 模拟 Steam：只对缺失的游戏排队，批量请求后写回 mapCache
            if (Number(appid) === 1006 && !manager.m_achievementProgress.mapCache.has(1006)) {
                setTimeout(() => {
                    manager.m_achievementProgress?.mapCache.set(1006, {
                        appid: 1006,
                        unlocked: 3,
                        total: 10,
                        percentage: 30,
                        all_unlocked: false,
                        cache_time: NOW,
                        vetted: true,
                    });
                }, 30);
            }
            return 0;
        },
    };
    return manager;
}

/** 首次运行：缓存文件不存在，Init 完成后 CMInterface 已在，但进度要主动请求 */
function createEmptyProgressManager() {
    const manager = {
        m_achievementProgress: undefined,
        CMInterface: { steamid: { ConvertTo64BitString: () => '76561197960265770' } },
        requested: [],
        GetAchievementProgress(appid) {
            manager.requested.push(Number(appid));
            if (manager.requested.length === Object.keys(APPS).length) {
                setTimeout(() => {
                    const entries = new Map(PROGRESS);
                    entries.set(1006, {
                        appid: 1006,
                        unlocked: 3,
                        total: 10,
                        percentage: 30,
                        all_unlocked: false,
                        cache_time: NOW,
                        vetted: true,
                    });
                    manager.m_achievementProgress = { nVersion: 3, mapCache: entries };
                }, 50);
            }
            return 0;
        },
    };
    return manager;
}

/* ── 断言辅助 ───────────────────────────────────────────────────────────── */

let failures = 0;
let checks = 0;

function ok(label, condition, detail = '') {
    checks += 1;
    if (!condition) failures += 1;
    console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? `  ${detail}` : ''}`);
}

function eq(label, actual, expected) {
    ok(label, actual === expected, `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate, { timeout = 12000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (predicate()) return true;
        await sleep(interval);
    }
    return false;
}

/* ── 开跑 ───────────────────────────────────────────────────────────────── */

installStubs();

const data = await import(`file://${path.join(AC, 'datasource.js').replace(/\\/g, '/')}`);
const store = await import(`file://${path.join(AC, 'store.js').replace(/\\/g, '/')}`);

console.log('\n── 主数据源只读 ─────────────────────────────────────');
{
    const described = data.describeSource();
    eq('mapCache 条数', described.entryCount, 6);
    eq('全成就条数', described.completeCount, 4);
    eq('total===0 条数', described.zeroTotalCount, 1);
    eq('数据源状态', described.status, 'ready');
    ok('GetMyAchievementsForApp 可用（子窗口的 SteamClient 没有，去 opener 上找到了）', described.achievementsApi === true);
    eq('库内游戏数', described.libraryAppCount, 6);
    eq('缓存就绪时没有触发 GetAchievementProgress', progressUpdateCalls, 0);
}

console.log('\n── 组装卡片（load） ─────────────────────────────────');
{
    await store.load({ silent: false });
    const s = store.getState();

    eq('阶段', s.phase, 'ready');
    eq('卡片数', s.cards.length, 4);
    eq('数据未知的游戏数', s.unknownApps.length, 1);
    eq('缺失的库内游戏已被补齐', s.noCacheCount, 0);
    eq('只为缺失的那款游戏排了队', progressUpdateCalls, 1);
    eq('覆盖成就总数', s.summary.achievementCount, 36 + 69 + 12 + 5);

    const names = s.cards.filter((c) => c.appid < 2000).map((c) => c.name).sort();
    ok('游戏名来自 appStore', names.join(',') === 'Fixture Complete A,Fixture Complete B,Fixture Complete C', names.join(','));

    const byId = new Map(s.cards.map((c) => [c.appid, c]));
    ok('未完成的游戏没有进入卡包', !byId.has(1004));
    ok('total=0 的游戏没有进入卡包，而是进了未知列表', !byId.has(1005) && s.unknownApps[0].appid === 1005);

    const card = byId.get(1001);
    eq('卡片状态', card.state, 'complete');
    eq('已解锁数', card.unlocked, 36);
    eq('总数', card.total, 36);
    eq('完成日期来自完整个人列表，而不是 cache_time', card.completedAt, NOW - 777);
    ok('cacheTime 只用于诊断', card.cacheTime === NOW - 86400 * 3);
    ok(
        '封面优先取客户端本地图片缓存（和 Steam 自己的 BuildCachedLibraryAssetURL 同一条路）',
        card.art.capsule[0].startsWith('/assets/1001/'),
        card.art.capsule.join(','),
    );
    ok(
        '候选链里有 appid 拼的线上地址兜底',
        card.art.capsule.some((url) => url.includes('/store_item_assets/steam/apps/1001/')),
        card.art.capsule.join(','),
    );
    ok(
        'Steam 哈希目录资源优先用于正反面封面',
        card.art.hero[0].includes('/assets/1001/baf02b93170c9ca0b0e6b28be34b04a77009213d/library_hero.jpg') &&
            card.art.capsule[0].includes('/assets/1001/d2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule.jpg') &&
            card.art.header[0].includes('/assets/1001/160c9bebc0b3825cc7903ea7d2b3e2c1cdd136c3/library_header.jpg'),
        `${card.art.hero[0]} | ${card.art.capsule[0]} | ${card.art.header[0]}`,
    );
    ok('收藏编号按 appid 排序', card.catalogueIndex === 1, String(card.catalogueIndex));
}

console.log('\n── 完成日期：串行补全 ───────────────────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    const finished = await waitUntil(() => {
        const s = store.getState();
        if (s.dates.running || s.cards.length === 0) return false;
        if (!s.cards.every((c) => c.rare != null && c.common != null && c.unrated === 0)) return false;
        const known = cache.readDates();
        return s.cards.every((c) => known.get(c.appid)?.rare != null);
    });

    ok('补全流程结束', finished);

    const s = store.getState();
    eq('复核时已顺带取到日期，不再排队补日期', s.dates.total, 0);
    eq('成功条数', s.dates.ok, 4);
    eq('失败条数', s.dates.failed, 0);

    const byId = new Map(s.cards.map((c) => [c.appid, c]));
    eq('1001 的完成时间 = 最大的 rtUnlocked', byId.get(1001).completedAt, NOW - 777);
    eq('1002 的完成时间', byId.get(1002).completedAt, NOW - 4242);
    eq('1003 的完成时间', byId.get(1003).completedAt, NOW - 999);

    eq('1001 的稀有成就数（全球解锁率 < 10%）', byId.get(1001).rare, 18);
    eq('1001 已知的普通成就数（全球解锁率 >= 10%）', byId.get(1001).common, 18);
    eq('官方列表统计完整', byId.get(1001).unrated, 0);
    eq('1002 的稀有成就数', byId.get(1002).rare, 35);

    eq('每个 appid 只请求了一次', new Set(calls).size, calls.length);
    eq('请求数量', calls.length, 4);
    eq('请求顺序稳定（串行、按卡片顺序）', calls.join(','), '1001,1002,1003,2001');

    ok('「最近完成」排序在有日期后出现', store.getState().sortKeys.includes('completed'));

    const sorted = store.selectVisibleCards();
    ok('最近完成排序生效', sorted[0].appid === 1001, sorted.map((c) => c.appid).join(','));
    eq('倒序：最早完成的在最后', sorted.map((c) => c.appid).join(','), '1001,1003,1002,2001');
}

console.log('\n── 不在库里的游戏：名字从 appInfoStore 补上 ──────────');
{
    const ok2001 = await waitUntil(() => store.getState().cards.find((c) => c.appid === 2001)?.nameMissing === false);
    const card = store.getState().cards.find((c) => c.appid === 2001);
    ok('名字补上了', ok2001 && card.name === 'Outer Wilds', card?.name);
}

console.log('\n── 册子的主人：昵称 / 头像 ───────────────────────────');
{
    const owner = await data.getOwner();
    eq('昵称来自 friendStore（顶栏同一来源）', owner.persona, 'Kevin0036');
    ok('绝不把账号名当昵称', owner.persona !== 'zo345f');
    eq('头像', owner.avatar, 'https://avatars.example/abc_full.jpg');
}

console.log('\n── 缓存：不覆盖客户端、日期写入 ─────────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);

    // 篡改缓存，再重新 load —— 客户端数据必须赢
    const poisoned = store.getState().cards.map((c) => ({ ...c, name: '被篡改的名字', completedAt: 1 }));
    cache.writeState(poisoned);

    await store.load({ silent: false });
    const s = store.getState();
    ok(
        '客户端数据覆盖了被篡改的缓存',
        s.cards.every((c) => c.name !== '被篡改的名字'),
        s.cards.map((c) => c.name).join(','),
    );
    ok('完成日期从缓存回填（没有重新请求）', s.cards.every((c) => c.completedAt != null));

    const dates = cache.readDates();
    eq('日期缓存条数', dates.size, 4);
    eq('日期缓存里的值', dates.get(1001)?.completedAt, NOW - 777);
    eq('稀有数一起进了缓存', dates.get(1001)?.rare, 18);
    eq('普通数一起进了缓存', dates.get(1001)?.common, 18);
    eq('未统计数一起进了缓存', dates.get(1001)?.unrated, 0);
    eq('缓存里记着取回时的成就总数', dates.get(1001)?.total, 36);
    ok('重新 load 后稀有数从缓存回填', store.getState().cards.find((c) => c.appid === 1001)?.rare === 18);
}

console.log('\n── 旧版稀有数缓存：保留日期并重新计算 ─────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    const key = cache.CACHE_KEYS.KEY_DATES;
    const payload = JSON.parse(localStorage.getItem(key));
    payload.entries = payload.entries.map(([appid, completedAt, rare, total, fetchedAt]) => [appid, completedAt, total, total, fetchedAt]);
    delete payload.rareVersion;
    localStorage.setItem(key, JSON.stringify(payload));

    const migrated = cache.readDates();
    eq('旧缓存中的完成日期保留', migrated.get(1001)?.completedAt, NOW - 777);
    eq('旧稀有数被清空等待重算', migrated.get(1001)?.rare, null);
    eq('旧普通数被清空等待重算', migrated.get(1001)?.common, null);
    eq('旧未统计数被清空等待重算', migrated.get(1001)?.unrated, null);
    eq('旧稀有数标记为待刷新', migrated.get(1001)?.fetchedAt, 0);

    cache.writeDates(migrated);
    store.dispose();
    calls = [];
    globalCalls = [];
    await store.load({ silent: false });
    await waitUntil(() => globalCalls.length === 4);
    eq('旧缓存的四款游戏都重新请求官方完成率', globalCalls.length, 4);
    eq('已有完成日期不再请求', calls.length, 0);
    eq('重新计算后稀有成就数正确', store.getState().cards.find((c) => c.appid === 1001)?.rare, 18);
    eq('重新计算不影响已保存的完成日期', store.getState().cards.find((c) => c.appid === 1001)?.completedAt, NOW - 777);
}

console.log('\n── 完成日期：永久缓存，只在必要时请求 ───────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    store.dispose();

    // 1) 什么都没变：打开卡包一个请求都不发
    calls = [];
    await store.load({ silent: false });
    await waitUntil(() => store.getState().dates.running === false);
    await sleep(300);
    eq('日期都在缓存里时不发请求', calls.length, 0);
    ok('倒序：最近完成的在最前面', store.selectVisibleCards()[0].appid === 1001);

    // 2) 成就总数变了（加了新成就又被打满）：旧日期作废，只重取这一款
    const dates = cache.readDates();
    dates.set(1003, { ...dates.get(1003), total: 10 });
    cache.writeDates(dates);
    store.dispose();
    calls = [];
    await store.load({ silent: false });
    await waitUntil(() => store.getState().dates.running === false && calls.length > 0);
    eq('总数变了的那一款被重新请求', calls.join(','), '1003');
    eq('重新取回后总数对上了', cache.readDates().get(1003)?.total, 12);

    // 3) 稀有数取回已久：每次打开最多顺带刷新几条，最旧的先刷
    const aged = cache.readDates();
    for (const [appid, entry] of aged) aged.set(appid, { ...entry, fetchedAt: Date.now() - 40 * 86400 * 1000 - appid });
    cache.writeDates(aged);
    store.dispose();
    calls = [];
    globalCalls = [];
    await store.load({ silent: false });
    await waitUntil(() => globalCalls.length === 4);
    eq('只刷新了上限以内的条数（4 款全部过期，上限 4）', globalCalls.length, 4);
    eq('最旧的先刷', globalCalls[0], 2001);
    eq('完成日期无需重取', calls.length, 0);
    store.dispose();
    calls = [];
    await store.load({ silent: false });
    await sleep(300);
    eq('刷新过的不会再刷', calls.length, 0);
}

console.log('\n── 新收录：首次进入卡包时入册 ────────────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);

    // 第一次记录：现有的全部算作已入册，不播动画
    cache.clearAll();
    store.dispose();
    await store.load({ silent: false });
    eq('从来没记录过：不算新收录', store.getState().intro.appids.length, 0);
    eq('现有的全部记为已入册', cache.readShelved()?.size, 4);
    await waitUntil(() => store.getState().dates.running === false && store.getState().dates.done === 4);

    // 1003 是「新打满的」，而且没有缓存的日期
    cache.writeShelved([1001, 1002, 2001]);
    const dates = cache.readDates();
    dates.delete(1003);
    cache.writeDates(dates);
    store.dispose();
    calls = [];
    await store.load({ silent: false });
    eq('识别出新收录', store.getState().intro.appids.join(','), '1003');
    eq('日期没到之前不播', store.getState().intro.ready, false);
    await waitUntil(() => store.getState().intro.ready);
    ok('新收录的日期一到就可以播', store.getState().intro.ready);
    eq('新收录的最先请求', calls[0], 1003);
    ok('它拿到了完成日期', store.getState().cards.find((c) => c.appid === 1003)?.completedAt === NOW - 999);

    store.markIntroduced([1003]);
    eq('播完后不再是新收录', store.getState().intro.appids.length, 0);
    ok('播完后记为已入册', cache.readShelved()?.has(1003));

    // 播完以后再打开：不再播
    store.dispose();
    await store.load({ silent: false });
    eq('再次打开不再播', store.getState().intro.appids.length, 0);

    // 变回「没打满」（加了新成就）：从已入册里移出，下次打满还会再入册
    PROGRESS.find(([id]) => id === 1002)[1].all_unlocked = false;
    PROGRESS.find(([id]) => id === 1002)[1].unlocked = 60;
    globalThis.appAchievementProgressCache = createProgressManager();
    store.dispose();
    await store.load({ silent: false });
    ok('明确没打满的从已入册里移出', !cache.readShelved()?.has(1002));
    PROGRESS.find(([id]) => id === 1002)[1].all_unlocked = true;
    PROGRESS.find(([id]) => id === 1002)[1].unlocked = 69;
    globalThis.appAchievementProgressCache = createProgressManager();
    store.dispose();
    await store.load({ silent: false });
    eq('重新打满后作为新收录再入册', store.getState().intro.appids.join(','), '1002');
    store.markIntroduced([1002]);
}

console.log('\n── 多张新收录 + 没播完就关 Steam：下次照常播 ─────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);

    // 模拟 Steam 关闭期间打满了 1001、1002：已入册名单里没有它们，日期也一次没取过
    const shelved = cache.readShelved();
    shelved.delete(1001);
    shelved.delete(1002);
    cache.writeShelved(shelved);
    const dates = cache.readDates();
    dates.delete(1001);
    dates.delete(1002);
    cache.writeDates(dates);

    store.dispose();
    calls = [];
    await store.load({ silent: false });
    eq('两款同时被识别为新收录', [...store.getState().intro.appids].sort().join(','), '1001,1002');
    eq('日期没到齐前不播', store.getState().intro.ready, false);

    await waitUntil(() => store.getState().intro.ready);
    ok('两款日期都到了才 ready', store.getState().intro.ready);
    eq('两款各请求一次', [...calls].sort().join(','), '1001,1002');
    eq('1001 的完成日期', store.getState().cards.find((c) => c.appid === 1001)?.completedAt, NOW - 777);
    eq('1002 的完成日期', store.getState().cards.find((c) => c.appid === 1002)?.completedAt, NOW - 4242);

    // 用户没等入册动画开始就关了 Steam：不调用 markIntroduced
    store.dispose();
    calls = [];
    await store.load({ silent: false });
    eq('重新登录后两款仍在待入册队列', [...store.getState().intro.appids].sort().join(','), '1001,1002');
    await waitUntil(() => store.getState().intro.ready);
    ok('日期从缓存回填，不需要重新请求', calls.length === 0 && store.getState().intro.ready);

    store.markIntroduced([1001, 1002]);
    eq('播完后待入册清空', store.getState().intro.appids.length, 0);
    ok('两款都记为已入册', cache.readShelved()?.has(1001) && cache.readShelved()?.has(1002));

    store.dispose();
    await store.load({ silent: false });
    eq('再打开不再播', store.getState().intro.appids.length, 0);
}

console.log('\n── 铁律 2：主数据源未就绪时进入 not-ready，而不是空卡包 ──');
{
    store.dispose();
    // 必须先清掉本地派生缓存，否则「有缓存就先撑着」这条设计会生效，
    // 测的就不是「没有缓存时该怎么办」了。
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll();

    globalThis.appAchievementProgressCache = { m_achievementProgress: undefined };

    await store.load({ silent: false });
    const s = store.getState();
    eq('阶段', s.phase, 'not-ready');
    eq('没有渲染出空卡包', s.cards.length, 0);
    eq('明确标记了数据源未就绪', s.waitingForSource, true);

    // 有缓存时：卡片保留，但状态里必须仍然是「未就绪」
    globalThis.appAchievementProgressCache = createProgressManager();
    await store.load({ silent: false });
    eq('恢复数据源后重新拿到卡片', store.getState().cards.length, 4);
    eq('恢复后不再标记未就绪', store.getState().waitingForSource, false);
    eq('卡片被写回缓存', cache.readState().cards.length, 4);

    globalThis.appAchievementProgressCache = { m_achievementProgress: undefined };
    await store.load({ silent: false });
    const s2 = store.getState();
    eq('数据源再次失效时保留缓存卡片', s2.cards.length, 4);
    eq('并且明确标记未就绪', s2.waitingForSource, true);

    // 恢复
    globalThis.appAchievementProgressCache = createProgressManager();
}

console.log('\n── 首次运行：缓存缺失时引导 Steam 建立缓存 ───────');
{
    store.dispose();
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll();
    data.resetProgressBootstrap();
    progressUpdateCalls = 0;

    const manager = createEmptyProgressManager();
    globalThis.appAchievementProgressCache = manager;

    const started = Date.now();
    await store.load({ silent: false });
    const s = store.getState();

    eq(
        '请求覆盖全部库内游戏',
        [...new Set(manager.requested)].sort((a, b) => a - b).join(','),
        Object.keys(APPS).join(','),
    );
    eq('缓存建立后拿到卡片', s.cards.length, 4);
    eq('阶段', s.phase, 'ready');
    eq('不再标记未就绪', s.waitingForSource, false);
    ok('等到缓存建立后才结束加载', Date.now() - started >= 40, `${Date.now() - started}ms`);

    data.resetProgressBootstrap();
    globalThis.appAchievementProgressCache = createProgressManager();
}

console.log('\n── 铁律 2：数据源抛异常时保留现有卡片 ───────────────');
{
    store.dispose();
    await store.load({ silent: false });
    const before = store.getState().cards.length;
    ok('先有一批卡片', before === 4, String(before));

    // 让装配过程抛错：把 allApps 换成会抛的 getter
    const goodStore = globalThis.appStore;
    globalThis.appStore = {
        get allApps() {
            throw new Error('模拟读取失败');
        },
        GetAppOverviewByAppID: () => null,
    };

    await store.load({ silent: true });
    const s = store.getState();
    eq('阶段变成 error', s.phase, 'error');
    eq('卡片没有被清空', s.cards.length, before);
    ok('错误信息被记录下来', typeof s.error === 'string' && s.error.includes('模拟读取失败'), s.error);

    globalThis.appStore = goodStore;
}

console.log('\n── 取消机制：pause 之后在途结果不再写回 ─────────────');
{
    store.dispose();
    await store.load({ silent: false });

    // 等第一批请求开始，然后立刻 pause
    await waitUntil(() => store.getState().dates.done > 0);
    const doneAtPause = store.getState().dates.done;
    store.pause();
    await sleep(900);

    eq('pause 之后计数不再增长', store.getState().dates.done, doneAtPause);
    eq('running 已置为 false', store.getState().dates.running, false);
}

console.log('\n── 完成日期：时钟错乱防御 ───────────────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll(); // 清掉日期缓存，否则 1002 会直接命中缓存、根本走不到 API
    store.dispose();

    clockSkewFor = 1002;
    await store.load({ silent: false });
    await waitUntil(() => store.getState().dates.running === false && store.getState().dates.total > 0);
    const s = store.getState();
    const byId = new Map(s.cards.map((c) => [c.appid, c]));
    eq('未来时间不会被写成完成日期', byId.get(1002).completedAt, null);
    eq('另外两张卡不受影响', byId.get(1001).completedAt, NOW - 777);
    eq('被拒的那一个计入 failed', s.dates.failed, 1);
    ok('取不到日期的游戏被记为 unavailable', s.dates.unavailable.has(1002));
    ok('正常拿到日期的游戏不在 unavailable 里', !s.dates.unavailable.has(1001) && !s.dates.unavailable.has(1003));
    clockSkewFor = null;
}

console.log('\n── 手动补日期：一键清除 ─────────────────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    ok('手动填之前缓存里没有手动日期', cache.readManualDates().size === 0);

    store.setManualDate(1002, NOW - 120);
    eq('手动日期立即写进卡片', store.getState().cards.find((c) => c.appid === 1002)?.completedAt, NOW - 120);
    eq('手动日期写进缓存', cache.readManualDates().get(1002), NOW - 120);

    const cleared = store.clearAllManualEntries();
    eq('一键清除返回清掉的张数', cleared, 1);
    eq('缓存里的手动日期已清空', cache.readManualDates().size, 0);
    eq('卡片回到无日期', store.getState().cards.find((c) => c.appid === 1002)?.completedAt, null);
    eq('清除后再次调用返回 0', store.clearAllManualEntries(), 0);
}

console.log('\n── 手动补时长：写入、覆盖与清除 ─────────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    const cardOf = (appid) => store.getState().cards.find((c) => c.appid === appid);
    const removed = cardOf(2001);
    ok('已移出库的游戏没有接口时长', removed?.playtimeMin == null, String(removed?.playtimeMin));

    ok('写入手动时长', store.setManualTime(2001, 726));
    eq('卡片立即显示手动时长', cardOf(2001)?.playtimeMin, 726);
    eq('手动时长来源标记为 manual', cardOf(2001)?.playtimeSource, 'manual');
    eq('手动时长写进缓存', cache.readManualTimes().get(2001), 726);

    const withDate = store.setManualDate(1002, NOW - 120);
    ok('同时补日期和时长', withDate && store.setManualTime(1003, 95));
    eq('一键清除返回有手动填写的张数', store.clearAllManualEntries(), 3);
    eq('缓存里的手动时长已清空', cache.readManualTimes().size, 0);
    eq('已移出库的游戏回到无时长', cardOf(2001)?.playtimeMin, null);
    eq('库内游戏恢复接口时长', cardOf(1003)?.playtimeMin, 88);
    eq('库内游戏恢复接口时长来源', cardOf(1003)?.playtimeSource, 'api');
    eq('日期也一并清除', cardOf(1002)?.completedAt, null);
}

console.log('\n── 完成日期：偶发失败会在末尾重试一次 ─────────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll();
    store.dispose();

    failOnce.add(1002);
    calls = [];
    await store.load({ silent: false });
    await waitUntil(() => store.getState().dates.running === false && calls.length > 0);
    const s = store.getState();
    eq('失败的那一款排到最后重试', calls.join(','), '1001,1002,1003,2001,1002');
    eq('重试拿到了日期', s.cards.find((c) => c.appid === 1002)?.completedAt, NOW - 4242);
    eq('没有失败计数', s.dates.failed, 0);
}

console.log('\n── 部分缓存：补齐缺失的库内游戏，且不误播入册动画 ──');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll();
    // 已有用户：册子里已经记着这四张卡
    cache.writeShelved([1001, 1002, 1003, 2001]);

    const entries = new Map(PROGRESS);
    const manager = {
        m_achievementProgress: { nVersion: 3, mapCache: entries },
        CMInterface: {},
        GetAchievementProgress(appid) {
            progressUpdateCalls += 1;
            if (Number(appid) === 1006) {
                setTimeout(() => {
                    entries.set(1006, {
                        appid: 1006,
                        unlocked: 5,
                        total: 5,
                        percentage: 100,
                        all_unlocked: true,
                        cache_time: NOW,
                        vetted: true,
                    });
                }, 30);
            }
            return 0;
        },
    };

    data.resetProgressBootstrap();
    progressUpdateCalls = 0;
    globalThis.appAchievementProgressCache = manager;
    store.dispose();

    await store.load({ silent: false });
    const s = store.getState();
    const card = s.cards.find((c) => c.appid === 1006);

    eq('只请求缺失的那款库内游戏', progressUpdateCalls, 1);
    eq('补出来的全成就游戏进入卡册', s.cards.length, 5);
    ok('补出来的正是 1006', Boolean(card) && card.state === 'complete');
    eq('不再有缺失缓存的库内游戏', s.noCacheCount, 0);
    eq('补出来的老游戏不算新收录', s.intro.appids.length, 0);
    ok('补出来的老游戏静默记为已入册', cache.readShelved()?.has(1006) === true);

    await waitUntil(() => store.getState().dates.running === false);
    data.resetProgressBootstrap();
    globalThis.appAchievementProgressCache = createProgressManager();
}

console.log('\n── 残缺 schema：mapCache 3/3 也要用完整列表复核 ─────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll();
    store.dispose();

    const entry = PROGRESS.find(([id]) => id === 1003)[1];
    const before = { unlocked: entry.unlocked, total: entry.total };
    entry.unlocked = 3;
    entry.total = 3;
    partialSchemaFor = 1003;
    calls = [];

    await store.load({ silent: false });
    const s = store.getState();
    ok(
        'mapCache 声称 3/3、完整列表只有 3/45 的游戏被剔除',
        !s.cards.some((c) => c.appid === 1003),
        s.cards.map((c) => c.appid).join(','),
    );
    eq('其余三款全成就仍在册', s.cards.length, 3);
    ok('复核确实读了完整个人列表', calls.includes(1003), calls.join(','));

    entry.unlocked = before.unlocked;
    entry.total = before.total;
    partialSchemaFor = null;
}

console.log('\n── 库外收录：服务端也有进度时仍然入册 ───────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    cache.clearAll();
    store.dispose();
    data.resetServiceProgress();

    const owner = data.getAccountFingerprint();
    ok('账号指纹可用于隔离库外收录', Boolean(owner));

    // 已移出家庭库的游戏：库列表和 mapCache 都没有，但服务端和收录缓存都有
    SERVICE_PROGRESS.set(3001, {
        appid: 3001, total: 7, unlocked: 7, percentage: 100,
        all_unlocked: true, cache_time: NOW, vetted: true,
    });
    cache.writeExtras(owner, new Map([
        [3001, { total: 7, unlocked: 7, name: 'Sekiro Fixture', addedAt: NOW }],
    ]));

    await store.load({ silent: false });
    const s = store.getState();
    const matched = s.cards.filter((c) => c.appid === 3001);
    eq('服务端也有进度条目时，库外收录没有被隐藏', matched.length, 1);
    eq('卡片来源仍是库外收录', matched[0]?.source, 'manual-extra');
    eq('进度沿用收录时核对过的总数', matched[0]?.total, 7);
    eq('名字来自收录记录', matched[0]?.name, 'Sekiro Fixture');
    eq('库内四款不受影响', s.cards.filter((c) => c.appid < 3000).length, 4);

    // 服务端总数更大 = 游戏加了新成就：旧的全成就结论作废
    SERVICE_PROGRESS.set(3001, {
        appid: 3001, total: 10, unlocked: 7, percentage: 70,
        all_unlocked: false, cache_time: NOW, vetted: true,
    });
    store.dispose();
    data.resetServiceProgress();
    await store.load({ silent: false });
    ok(
        '总数变大后库外卡片退出册子',
        !store.getState().cards.some((c) => c.appid === 3001),
        store.getState().cards.map((c) => c.appid).join(','),
    );
}

console.log('\n── 多账号合并：只读快照并进当前册子 ───────────────');
{
    const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
    const share = await import(`file://${path.join(AC, 'share.js').replace(/\\/g, '/')}`);
    const accounts = await import(`file://${path.join(AC, 'accounts.js').replace(/\\/g, '/')}`);

    store.dispose();
    data.resetServiceProgress();
    SERVICE_PROGRESS.delete(3001);
    await store.load({ silent: false });
    const base = store.getState().cards.length;
    ok('合并前先得到当前账号的册子', base > 0, String(base));

    const requested = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        const { pathname } = new URL(url);
        requested.push(pathname);
        if (pathname === '/api/albums/ALT_TOKEN_INT') {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    schemaVersion: 1,
                    kind: 'achievement-album',
                    owner: {
                        name: '小号',
                        avatar: 'https://avatars.steamstatic.com/alt_full.jpg',
                        friendCode: '777',
                    },
                    cards: [
                        // 与当前账号重复：当前账号的卡必须胜出
                        { appid: 1001, name: 'Alt Duplicate', completedAt: NOW - 100, playtimeMin: 1, total: 36, rare: 0, common: 36, unrated: 0, art: {} },
                        // 当前账号没有的卡：并进册子，卡面显示小号的昵称
                        {
                            appid: 3002, name: 'Alt Only Game', completedAt: NOW - 2000, playtimeMin: 400,
                            total: 20, rare: 5, common: 15, unrated: 0,
                            art: { hero: ['https://shared.steamstatic.com/store_item_assets/steam/apps/3002/hero.jpg'], capsule: [], header: [], logo: [] },
                        },
                    ],
                    sharedAt: NOW - 500,
                    updatedAt: NOW - 100,
                    revision: 1,
                }),
            };
        }
        return { ok: false, status: 404, text: async () => '{"error":"not_found"}' };
    };
    localStorage.setItem('ac:v1:share', JSON.stringify({
        '777': { token: 'ALT_TOKEN_INT', editKey: 'MUST_NOT_LEAK', code: '123456789', url: '', sharedAt: NOW, updatedAt: NOW, revision: 1 },
        '42': { token: 'SELF_TOKEN_INT', editKey: 'SELF_SECRET', code: '987654321', url: '', sharedAt: NOW, updatedAt: NOW, revision: 1 },
    }));
    accounts.setEnabled(true);

    store.dispose();
    await store.load({ silent: false });
    const merged = await waitUntil(
        () => store.getState().cards.some((card) => card.source === 'external'),
        { timeout: 6000 },
    );
    ok('外部账号的快照已合并进册子', merged);
    await sleep(100);

    const s = store.getState();
    const extra = s.cards.find((card) => card.appid === 3002);
    eq('多了一张小号的卡', s.cards.length, base + 1);
    eq('外部卡来源标记', extra?.source, 'external');
    eq('卡面归属小号', extra?.owner?.persona, '小号');
    eq('外部卡完成日期保留', extra?.completedAt, NOW - 2000);
    eq('外部卡游玩时长保留', extra?.playtimeMin, 400);
    eq('外部卡总数保留', extra?.total, 20);
    eq('外部卡状态是全成就', extra?.state, 'complete');
    ok('外部卡封面只保留 Steam CDN', extra?.art.hero[0]?.includes('shared.steamstatic.com'), extra?.art.hero[0]);

    const duplicate = s.cards.find((card) => card.appid === 1001);
    eq('重复的游戏保留当前账号自己的卡', duplicate?.name, 'Fixture Complete A');
    ok('当前账号自己的记录没有被请求', !requested.includes('/api/albums/SELF_TOKEN_INT'), requested.join(','));
    ok('至少请求了小号的只读快照', requested.includes('/api/albums/ALT_TOKEN_INT'), requested.join(','));

    const persisted = cache.readState();
    ok('外部卡没有写进本地卡片快照', !persisted?.cards?.some((card) => card.appid === 3002), JSON.stringify(persisted?.cards?.map((card) => card.appid)));
    const sharedDoc = share.buildSnapshot({ cards: s.cards });
    ok('寄信快照只包含当前账号自己的卡', !sharedDoc.cards.some((card) => card.appid === 3002), sharedDoc.cards.map((card) => card.appid).join(','));

    accounts.setEnabled(false);
    const count = store.applyExternalAccounts();
    eq('关闭多账号合并后回到当前账号', count, 0);
    ok('小号的卡已从册子移除', !store.getState().cards.some((card) => card.appid === 3002));
    eq('当前账号的卡不受影响', store.getState().cards.length, base);

    globalThis.fetch = originalFetch;
}

console.log('');
if (failures > 0) {
    console.error(`✘ ${failures} / ${checks} 项失败`);
    process.exit(1);
}
console.log(`✔ ${checks} 项断言全部通过`);
