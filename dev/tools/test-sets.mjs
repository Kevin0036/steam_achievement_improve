/**
 * 成就集合判定的测试（Node，无需 Steam、无需浏览器）：node tools/test-sets.mjs
 *
 * 和 test-integration.mjs 一样，先把 Steam 的全局桩装到 globalThis 上，再原样加载 store / datasource / model。
 * 夹具照真实接口的形状造（字段名来自 steamui 里的 protobuf 定义）：
 *   进度   GetAchievementsProgress / mapCache：groups_completed_base / groups_total_base / groups_completed_dlc / groups_total_dlc / base_game_total
 *   成就表 GetGameAchievements：achievements[].groupid / archived / player_percent_unlocked，groups[].dlcappid / archived
 *   本人   GetUserAchievements：achievements[].unlocked / unlock_time，groups[].is_completed
 *
 * 覆盖：
 *   · DLC 集合没买（编程农场）：蓝徽章，不再被完整列表剔除；
 *   · 买了 DLC 没打完：蓝徽章，杯数和日期只算本体；
 *   · 本体 + DLC 都打通：蓝紫徽章，杯数算上 DLC，日期仍是本体打满的那天；
 *   · 一个 DLC 打通、另一个没买：蓝徽章；本体没打满：不进册子；
 *   · 归档成就、归档集合、查不到集合、没有集合字段的老进度；
 *   · 成绩单缓存（同一个指纹不重查）、跨两次打开的徽章翻新判定与记录。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AC = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection', 'src', 'js', 'ac');
const load = (file) => import(`file://${path.join(AC, file).replace(/\\/g, '/')}`);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const storageData = new Map();

/* ── 夹具 ───────────────────────────────────────────────────────────────── */

/** 成就：[名字, 所在集合, 全球解锁率, 是否解锁, 解锁时间, 是否归档] */
const A = (name, group, pct, unlocked, at = 0, archived = false) => ({ name, group, pct, unlocked, at, archived });

const BASE_DONE = NOW - 200 * DAY;
const DLC_DONE = NOW - 3 * DAY;

/** 每款游戏：集合定义 + 成就 + 本人集合完成标记 + 进度条目 */
const GAMES = {
    // 编程农场：本体 6 个全拿了，新出的 DLC 集合没买（3 个，拿不到）
    3001: {
        name: 'Farmer (DLC 没买)',
        playtime: 1726,
        groups: [{ groupid: 7, dlcappid: 900001, localized_name: '新 DLC' }],
        achievements: [
            A('B0', 0, 3, true, BASE_DONE - 500), A('B1', 0, 50, true, BASE_DONE - 400), A('B2', 0, 5, true, BASE_DONE - 300),
            A('B3', 0, 60, true, BASE_DONE - 200), A('B4', 0, 70, true, BASE_DONE - 100), A('B5', 0, 2, true, BASE_DONE),
            A('D0', 7, 1, false), A('D1', 7, 1, false), A('D2', 7, 1, false),
        ],
        userGroups: [{ groupid: 0, is_completed: true, is_achievable: true }, { groupid: 7, is_completed: false, is_achievable: false }],
        progress: { unlocked: 6, total: 6, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 0, groups_total_dlc: 0, base_game_total: 6 },
    },
    // 买了 DLC、只打了一半：本体打满在前，DLC 的两个解锁更晚（不能把日期算到 DLC 上）
    3002: {
        name: 'Partial DLC',
        playtime: 600,
        groups: [{ groupid: 3, dlcappid: 900002, localized_name: '扩展' }],
        achievements: [
            A('B0', 0, 4, true, BASE_DONE - 50), A('B1', 0, 30, true, BASE_DONE - 40), A('B2', 0, 40, true, BASE_DONE - 30),
            A('B3', 0, 8, true, BASE_DONE - 20), A('B4', 0, 90, true, BASE_DONE),
            A('D0', 3, 2, true, DLC_DONE - 100), A('D1', 3, 20, true, DLC_DONE), A('D2', 3, 6, false), A('D3', 3, 15, false),
        ],
        userGroups: [{ groupid: 0, is_completed: true, is_achievable: true }, { groupid: 3, is_completed: false, is_achievable: true }],
        progress: { unlocked: 7, total: 9, all_unlocked: false, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 0, groups_total_dlc: 1, base_game_total: 5 },
    },
    // 本体 + DLC 都打通
    3003: {
        name: 'All Sets',
        playtime: 3000,
        groups: [{ groupid: 4, dlcappid: 900003, localized_name: '季票' }],
        achievements: [
            A('B0', 0, 3, true, BASE_DONE - 30), A('B1', 0, 33, true, BASE_DONE - 20), A('B2', 0, 44, true, BASE_DONE - 10), A('B3', 0, 9, true, BASE_DONE),
            A('D0', 4, 1, true, DLC_DONE - 30), A('D1', 4, 25, true, DLC_DONE - 20), A('D2', 4, 7, true, DLC_DONE),
        ],
        userGroups: [{ groupid: 0, is_completed: true }, { groupid: 4, is_completed: true }],
        progress: { unlocked: 7, total: 7, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 1, groups_total_dlc: 1, base_game_total: 4 },
    },
    // 一个 DLC 打通了，另一个没买：不算「所有 DLC 集合」
    3004: {
        name: 'One DLC Unowned',
        playtime: 900,
        groups: [{ groupid: 5, dlcappid: 900041, localized_name: '甲' }, { groupid: 6, dlcappid: 900042, localized_name: '乙' }],
        achievements: [
            A('B0', 0, 50, true, BASE_DONE - 10), A('B1', 0, 50, true, BASE_DONE - 5), A('B2', 0, 50, true, BASE_DONE),
            A('E0', 5, 5, true, DLC_DONE - 10), A('E1', 5, 5, true, DLC_DONE),
            A('F0', 6, 5, false), A('F1', 6, 5, false),
        ],
        userGroups: [{ groupid: 0, is_completed: true }, { groupid: 5, is_completed: true }, { groupid: 6, is_completed: false }],
        progress: { unlocked: 5, total: 5, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 1, groups_total_dlc: 1, base_game_total: 3 },
    },
    // 本体没打满（DLC 倒是打通了）：不进册子
    3005: {
        name: 'Base Incomplete',
        playtime: 100,
        groups: [{ groupid: 2, dlcappid: 900005 }],
        achievements: [A('B0', 0, 50, true, BASE_DONE), A('B1', 0, 50, false), A('D0', 2, 5, true, DLC_DONE)],
        userGroups: [{ groupid: 0, is_completed: false }, { groupid: 2, is_completed: true }],
        progress: { unlocked: 2, total: 3, all_unlocked: false, groups_completed_base: 0, groups_total_base: 1, groups_completed_dlc: 1, groups_total_dlc: 1, base_game_total: 2 },
    },
    // 没有集合字段的老进度（接口还没下发集合信息的游戏）：照原来的口径
    3006: {
        name: 'Legacy',
        playtime: 50,
        groups: [],
        achievements: [A('B0', 0, 50, true, BASE_DONE), A('B1', 0, 4, true, BASE_DONE - 9)],
        userGroups: [],
        progress: { unlocked: 2, total: 2, all_unlocked: true },
    },
    // 看得出用了集合，但集合接口这次查不到
    3007: {
        name: 'Sets Unavailable',
        playtime: 70,
        failSets: true,
        groups: [{ groupid: 1, dlcappid: 900007 }],
        achievements: [A('B0', 0, 50, true, BASE_DONE), A('D0', 1, 50, true, DLC_DONE)],
        userGroups: [{ groupid: 0, is_completed: true }, { groupid: 1, is_completed: true }],
        progress: { unlocked: 2, total: 2, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 1, groups_total_dlc: 1, base_game_total: 1 },
    },
    // 归档：本体里一个归档了、没拿到的成就不算；整个归档、一个都没拿的 DLC 集合看不见
    3008: {
        name: 'Archived',
        playtime: 400,
        groups: [{ groupid: 9, dlcappid: 900008, archived: true }],
        achievements: [
            A('B0', 0, 50, true, BASE_DONE - 10), A('B1', 0, 3, true, BASE_DONE), A('BX', 0, 1, false, 0, true),
            A('S0', 9, 1, false), A('S1', 9, 1, false),
        ],
        userGroups: [{ groupid: 0, is_completed: true }],
        progress: { unlocked: 2, total: 2, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 0, groups_total_dlc: 0, base_game_total: 2 },
    },
};

const progressEntry = (appid) => ({ appid: Number(appid), percentage: 100, cache_time: NOW - DAY, vetted: true, ...GAMES[appid].progress });

let setCalls = new Map();
const countSetCall = (appid) => setCalls.set(appid, (setCalls.get(appid) ?? 0) + 1);

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
    globalThis.SteamClient = { Window: {}, Apps: {} };
    globalThis.opener = {
        SteamClient: {
            Apps: {
                // 完整个人列表：和 Steam 一样，DLC 集合的成就也在里面
                GetMyAchievementsForApp: async (appid) => {
                    const game = GAMES[Number(appid)];
                    if (!game) return { result: 1, data: { rgAchievements: [] } };
                    return {
                        result: 1,
                        data: {
                            rgAchievements: game.achievements.map((a) => ({
                                strID: a.name, bAchieved: a.unlocked, rtUnlocked: a.unlocked ? a.at : 0, flAchieved: a.pct,
                            })),
                        },
                    };
                },
            },
        },
    };
    globalThis.App = {
        GetCurrentUser: () => ({ strSteamID: '76561197960265770', strAccountName: 'sets' }),
        cm: { GetServiceTransport: () => ({}) },
    };
    const reply = (body, eresult = 1) => ({ GetEResult: () => eresult, Body: () => ({ toObject: () => body }) });
    const keyOf = (game, a) => game.achievements.indexOf(a) + 1;
    const playerService = {
        GetGameAchievements: async (_t, { appid }) => {
            const game = GAMES[appid];
            if (!game) return reply({}, 2);
            return reply({
                achievements: game.achievements.map((a) => ({
                    internal_name: a.name,
                    internal_key: keyOf(game, a),
                    player_percent_unlocked: String(a.pct),
                    ...(a.group ? { groupid: a.group } : {}),
                    ...(a.archived ? { archived: true } : {}),
                })),
                groups: game.groups,
            });
        },
        GetUserAchievements: async (_t, { appid }) => {
            const game = GAMES[appid];
            countSetCall(appid);
            if (!game || game.failSets) return reply({}, 2);
            return reply({
                achievements: game.achievements.map((a) => ({ internal_key: keyOf(game, a), unlocked: a.unlocked, unlock_time: a.unlocked ? a.at : 0 })),
                groups: game.userGroups,
            });
        },
        GetAchievementsProgress: async () => reply({ achievement_progress: [] }),
    };
    globalThis.MILLENNIUM_API = { findModuleExport: (match) => (match(playerService) ? playerService : undefined) };
    globalThis.friendStore = { currentUserSteamID: { GetAccountID: () => 77 }, GetFriendState: () => null };
    globalThis.appInfoStore = { EnsureAppInfoForAppIDs: async () => {}, GetAppInfo: () => ({ is_valid: false }) };
    globalThis.appStore = {
        get allApps() {
            return Object.keys(GAMES).map((id) => overview(id));
        },
        GetAppOverviewByAppID: (appid) => (GAMES[appid] ? overview(appid) : null),
    };
    globalThis.appDetailsStore = { GetAppDetails: () => null };
    globalThis.appAchievementProgressCache = {
        m_achievementProgress: { nVersion: 3, mapCache: new Map(Object.keys(GAMES).map((id) => [Number(id), progressEntry(id)])) },
        CMInterface: {},
        GetAchievementProgress: () => 0,
    };
}

const overview = (appid) => ({
    appid: Number(appid),
    display_name: GAMES[appid].name,
    rt_last_time_played: NOW - 1000,
    minutes_playtime_forever: GAMES[appid].playtime,
});

/** 改了夹具之后，把 mapCache 里的进度同步过去（模拟 Steam 刷新了进度） */
function refreshProgress(appid) {
    globalThis.appAchievementProgressCache.m_achievementProgress.mapCache.set(Number(appid), progressEntry(appid));
}

/* ── 断言辅助 ───────────────────────────────────────────────────────────── */

let failures = 0;
let checks = 0;
function ok(label, condition, detail = '') {
    checks += 1;
    if (!condition) failures += 1;
    console.log(`${condition ? '  ok  ' : ' FAIL '} ${label}${detail ? `  ${detail}` : ''}`);
}
const eq = (label, actual, expected) => ok(label, JSON.stringify(actual) === JSON.stringify(expected), `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);

/* ── 纯函数：summarizeSets ──────────────────────────────────────────────── */

installStubs();
const model = await load('model.js');

console.log('\n── summarizeSets：照 Steam 成就页的口径 ──────────────');
{
    const raw = (appid) => {
        const game = GAMES[appid];
        const keyOf = (a) => game.achievements.indexOf(a) + 1;
        return {
            groups: game.groups,
            achievements: game.achievements.map((a) => ({
                internal_name: a.name, internal_key: keyOf(a), player_percent_unlocked: String(a.pct),
                ...(a.group ? { groupid: a.group } : {}), ...(a.archived ? { archived: true } : {}),
            })),
            user: {
                achievements: game.achievements.map((a) => ({ internal_key: keyOf(a), unlocked: a.unlocked, unlock_time: a.unlocked ? a.at : 0 })),
                groups: game.userGroups,
            },
        };
    };

    const farmer = model.summarizeSets(raw(3001));
    eq('编程农场：用了集合', farmer.hasSets, true);
    eq('编程农场：本体 6/6 完成', [farmer.base.achieved, farmer.base.total, farmer.base.complete], [6, 6, true]);
    eq('编程农场：DLC 集合 0/1，不是蓝紫', [farmer.dlcCompleted, farmer.dlcSets, farmer.allSets], [0, 1, false]);
    eq('编程农场：本体金杯 3、银杯 3', [farmer.base.rare, farmer.base.common], [3, 3]);
    eq('编程农场：完成日期是本体最后一个解锁', farmer.base.completedAt, BASE_DONE);

    const partial = model.summarizeSets(raw(3002));
    eq('DLC 打了一半：本体完成、不是蓝紫', [partial.base.complete, partial.allSets], [true, false]);
    eq('DLC 打了一半：本体日期不被 DLC 的解锁带晚', partial.base.completedAt, BASE_DONE);
    eq('DLC 打了一半：整体日期是 DLC 的最后一个解锁', partial.all.completedAt, DLC_DONE);

    const all = model.summarizeSets(raw(3003));
    eq('都打通：蓝紫', all.allSets, true);
    eq('都打通：算上 DLC 共 7 个，金 4 银 3', [all.all.total, all.all.rare, all.all.common], [7, 4, 3]);
    eq('都打通：只算本体时 4 个，金 2 银 2', [all.base.total, all.base.rare, all.base.common], [4, 2, 2]);

    eq('一个 DLC 没买：不是蓝紫', model.summarizeSets(raw(3004)).allSets, false);
    eq('本体没打满：本体不完成', model.summarizeSets(raw(3005)).base.complete, false);

    const archived = model.summarizeSets(raw(3008));
    eq('归档：本体里没拿到的归档成就不算，2/2 完成', [archived.base.achieved, archived.base.total, archived.base.complete], [2, 2, true]);
    eq('归档：一个都没拿的归档集合看不见，等于没用集合', [archived.hasSets, archived.dlcSets], [false, 0]);

    // 集合完成后又加了成就：is_completed 还是 true，算完成；杯数只数已经拿到的
    const grown = raw(3003);
    grown.achievements.push({ internal_name: 'NEW', internal_key: 99, player_percent_unlocked: '2', groupid: 4 });
    const sticky = model.summarizeSets(grown);
    eq('完成后又加了成就：仍算完成、仍是蓝紫', [sticky.allSets, sticky.all.total, sticky.all.achieved], [true, 8, 7]);
    eq('完成后又加了成就：金杯只数拿到的', sticky.all.rare, 4);

    eq('空成就表：null', model.summarizeSets({ achievements: [] }), null);
    eq('进度判定：本体集合完成就算全成就（DLC 没打完）', model.classify(progressEntry(3002)), 'complete');
    eq('进度判定：本体集合没完成', model.classify(progressEntry(3005)), 'incomplete');
    eq('进度判定：没有集合字段的照旧', model.classify(progressEntry(3006)), 'complete');
    eq('看得出用了集合：DLC 打了一半', model.suspectSets(progressEntry(3002)), true);
    eq('编程农场从进度上看不出来（要靠复核对不上时追查）', model.suspectSets(progressEntry(3001)), false);
}

/* ── 整条链路：store.load ───────────────────────────────────────────────── */

const store = await load('store.js');
const cache = await load('cache.js');
const cardOf = (appid) => store.getState().cards.find((card) => card.appid === appid) ?? null;

console.log('\n── 第一次打开：判定 ──────────────────────────────────');
await store.load({ silent: false });
{
    const farmer = cardOf(3001);
    ok('编程农场留在册子里（不再被完整列表剔除）', farmer != null);
    eq('编程农场：蓝徽章，总数 6，金 3 银 3', [farmer?.allSets, farmer?.total, farmer?.rare, farmer?.common], [false, 6, 3, 3]);
    eq('编程农场：完成日期', farmer?.completedAt, BASE_DONE);

    const partial = cardOf(3002);
    eq('DLC 打了一半：蓝徽章，只算本体 5 个（金 2 银 3）', [partial?.allSets, partial?.total, partial?.rare, partial?.common], [false, 5, 2, 3]);
    eq('DLC 打了一半：日期是本体打满那天', partial?.completedAt, BASE_DONE);

    const all = cardOf(3003);
    eq('都打通：蓝紫徽章，算上 DLC 7 个（金 4 银 3）', [all?.allSets, all?.total, all?.rare, all?.common], [true, 7, 4, 3]);
    eq('都打通：日期仍是本体打满那天（卡留在原来的位置）', all?.completedAt, BASE_DONE);
    eq('都打通：记下只算本体时的杯数（翻新动画要用）', all?.sets?.base, { total: 4, rare: 2, common: 2, unrated: 0 });
    eq('都打通：记下 DLC 集合全部打满那天（卡面「全集合」那一行）', all?.sets?.allCompletedAt, DLC_DONE);
    eq('DLC 打了一半：没有全集合日期', partial?.sets?.allCompletedAt, null);

    eq('一个 DLC 没买：蓝徽章', cardOf(3004)?.allSets, false);
    eq('本体没打满：不进册子', cardOf(3005), null);
    ok('老进度：照旧收进册子', cardOf(3006) != null && cardOf(3006).sets == null);
    eq('集合接口查不到：照进度留着，不当成蓝紫', [cardOf(3007) != null, cardOf(3007)?.allSets ?? false], [true, false]);
    eq('归档：留在册子里，总数 2', cardOf(3008)?.total, 2);
    eq('第一次打开：不播翻新动画', store.getState().upgrade.changes, []);
    eq('第一次打开：现有的蓝紫记为已看过', [...(cache.readUpgraded() ?? [])], [3003]);
}

console.log('\n── 第二次打开：成绩单缓存 ────────────────────────────');
{
    setCalls = new Map();
    store.dispose();
    await store.load({ silent: false });
    const asked = [...setCalls.keys()].filter((id) => id !== 3007);
    eq('进度没变的游戏不重查集合', asked, []);
    eq('第二次打开：还是没有翻新', store.getState().upgrade.changes, []);
}

console.log('\n── DLC 打通了：徽章翻新 ──────────────────────────────');
{
    const game = GAMES[3002];
    for (const a of game.achievements) {
        if (!a.unlocked) {
            a.unlocked = true;
            a.at = NOW - 60;
        }
    }
    game.userGroups[1].is_completed = true;
    game.progress = { ...game.progress, unlocked: 9, all_unlocked: true, groups_completed_dlc: 1 };
    game.playtime = 980;
    refreshProgress(3002);
    setCalls = new Map();
    store.dispose();
    await store.load({ silent: false });

    ok('进度变了才重查', (setCalls.get(3002) ?? 0) === 1);
    const card = cardOf(3002);
    eq('翻新后：蓝紫徽章，算上 DLC 9 个（金 4 银 5）', [card?.allSets, card?.total, card?.rare, card?.common], [true, 9, 4, 5]);
    eq('翻新后：日期不变，卡留在原位', card?.completedAt, BASE_DONE);
    const changes = store.getState().upgrade.changes;
    eq('要播一次翻新', changes.map((change) => change.appid), [3002]);
    eq('翻新前的数字：只算本体（金 2 银 3）、上次的时长', changes[0]?.from, { rare: 2, common: 3, total: 5, playtimeMin: 600 });

    store.markUpgraded([3002]);
    eq('播完：记为已看过', [...cache.readUpgraded()].sort(), [3002, 3003]);
    store.dispose();
    await store.load({ silent: false });
    eq('播过的不再播', store.getState().upgrade.changes, []);
}

console.log('\n── 出了新的 DLC 集合：退回蓝徽章 ─────────────────────');
{
    const game = GAMES[3003];
    game.groups.push({ groupid: 8, dlcappid: 900099, localized_name: '新出的' });
    game.achievements.push(A('N0', 8, 3, false));
    game.userGroups.push({ groupid: 8, is_completed: false });
    // 没买的集合不算进进度，指纹不变；蓝紫徽章过几天会重查成就表
    const sets = cache.readSets();
    const entry = sets.get(3003);
    sets.set(3003, { ...entry, checkedAt: Date.now() - 4 * DAY * 1000 });
    cache.writeSets(sets);
    cache.flushWrites();
    store.dispose();
    await store.load({ silent: false });
    const card = cardOf(3003);
    eq('退回蓝徽章，杯数只算本体', [card?.allSets, card?.total], [false, 4]);
    ok('移出「已看过」的记录，以后打通时再翻新一次', !cache.readUpgraded().has(3003));
}

console.log('\n── 以前就打完、这次才露面：不播入册动画 ───────────────');
{
    // 潜水员戴夫：2024 年就打完了，之前被完整列表误剔除，修好判定后才第一次出现在册子里
    GAMES[3009] = {
        name: 'Dave (以前就打完)',
        playtime: 2000,
        groups: [{ groupid: 2, dlcappid: 900009 }],
        achievements: [A('B0', 0, 30, true, NOW - 700 * DAY), A('B1', 0, 3, true, NOW - 690 * DAY), A('D0', 2, 5, false)],
        userGroups: [{ groupid: 0, is_completed: true }, { groupid: 2, is_completed: false }],
        progress: { unlocked: 2, total: 2, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 0, groups_total_dlc: 0, base_game_total: 2 },
    };
    // 真正刚打完的
    GAMES[3010] = {
        name: 'Just Finished',
        playtime: 300,
        groups: [{ groupid: 2, dlcappid: 900010 }],
        achievements: [A('B0', 0, 30, true, NOW - 600), A('B1', 0, 3, true, NOW - 60), A('D0', 2, 5, false)],
        userGroups: [{ groupid: 0, is_completed: true }, { groupid: 2, is_completed: false }],
        progress: { unlocked: 2, total: 2, all_unlocked: true, groups_completed_base: 1, groups_total_base: 1, groups_completed_dlc: 0, groups_total_dlc: 0, base_game_total: 2 },
    };
    refreshProgress(3009);
    refreshProgress(3010);
    store.dispose();
    await store.load({ silent: false });
    eq('两张都收进册子', [cardOf(3009) != null, cardOf(3010) != null], [true, true]);
    eq('只有刚打完的那张播入册动画', store.getState().intro.appids, [3010]);
    ok('以前就打完的直接记为已入册', cache.readShelved().has(3009));
    ok('刚打完的等入册动画播完才记', !cache.readShelved().has(3010));
}

console.log(`\n${failures === 0 ? '✔' : '✘'} ${checks - failures}/${checks} 项断言通过`);
store.dispose();
process.exit(failures === 0 ? 0 : 1);
