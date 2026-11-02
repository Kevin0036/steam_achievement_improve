/** Performance regressions against real modules; Steam APIs are fixture boundaries. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const theme = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../millennium/themes/AchievementCollection');
const url = file => pathToFileURL(path.join(theme, 'src/js/ac', file)).href;
const realSetTimeout = globalThis.setTimeout;
// Keep actual timeouts intact; only accelerate the deliberate inter-request gaps.
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(fn, ms === 180 || ms === 1500 ? 0 : ms, ...args);
const disk = new Map();
let writes = [];
globalThis.localStorage = {
    get length() { return disk.size; }, key: i => [...disk.keys()][i] ?? null,
    getItem: k => disk.get(k) ?? null,
    setItem: (k, v) => { writes.push(k); disk.set(k, String(v)); },
    removeItem: k => disk.delete(k),
};
let apps = [], entries = new Map(), nativeCalls = [], globalCalls = [], artCalls = [], progressCalls = [];
let dateMode = 'ok', globalMode = 'ok', assetsMode = 'ok';
const total = 3;
const now = Math.floor(Date.now() / 1000);
globalThis.SteamClient = { Apps: {
    GetMyAchievementsForApp: async appid => {
        nativeCalls.push(Number(appid));
        if (typeof dateMode === 'function') return dateMode(Number(appid));
        if (dateMode === 'error') return { result: 2 };
        return { result: 1, data: { rgAchievements: [{ strID: 'A', bAchieved: true, rtUnlocked: dateMode === 'missing' ? 0 : now - Number(appid) }] } };
    },
    RegisterForAppDetails: (appid, callback) => {
        artCalls.push(Number(appid));
        if (assetsMode === 'error') throw new Error('fixture unavailable');
        callback({ libraryAssets: { strHeroImage: 'fixture/library_hero.jpg' } });
        return { unregister() {} };
    },
} };
globalThis.App = { GetCurrentUser: () => ({ strSteamID: '76561198000000000' }), cm: { GetServiceTransport: () => ({}) } };
const service = { GetGameAchievements: async (_transport, { appid }) => {
    globalCalls.push(appid);
    if (globalMode === 'error') return { GetEResult: () => 2 };
    return { GetEResult: () => 1, Body: () => ({ toObject: () => ({ achievements:
        Array.from({ length: globalMode === 'partial' ? 1 : total }, (_, i) => ({ internal_name: `A${i}`, player_percent_unlocked: i ? '60' : '3' })),
    }) }) };
} };
globalThis.MILLENNIUM_API = { findModuleExport: match => match(service) ? service : undefined };
globalThis.appStore = { get allApps() { return apps; }, GetAppOverviewByAppID: id => apps.find(a => a.appid === id) };
globalThis.appDetailsStore = { GetAppDetails: () => assetsMode === 'ok' ? { libraryAssets: { strHeroImage: 'fixture/library_hero.jpg' } } : null };
globalThis.appAchievementProgressCache = { get m_achievementProgress() { return { mapCache: entries }; }, CMInterface: {},
    GetAchievementProgress(appid) { progressCalls.push(appid); entries.set(appid, { total, unlocked: total, all_unlocked: true }); },
};
const store = await import(url('store.js'));
const data = await import(url('datasource.js'));
const cache = await import(url('cache.js'));
const waitFor = async predicate => {
    const end = Date.now() + 5000;
    while (!predicate() && Date.now() < end) await new Promise(r => realSetTimeout(r, 5));
    assert.ok(predicate(), 'background work settles');
};
function reset(count = 1) {
    store.dispose(); cache.clearAll(); data.resetProgressBootstrap();
    apps = Array.from({ length: count }, (_, i) => ({ appid: 1001 + i, display_name: `Fixture ${i}`, minutes_playtime_forever: 10, rt_last_time_played: now - i }));
    entries = new Map(apps.map(a => [a.appid, { total, unlocked: total, all_unlocked: true }]));
    nativeCalls = []; globalCalls = []; artCalls = []; progressCalls = []; writes = [];
    dateMode = 'ok'; globalMode = 'ok'; assetsMode = 'ok';
}
async function loaded() {
    await store.load();
    await waitFor(() => !store.getState().dates.running && store.getState().cards.every(c => c.rare != null));
    await new Promise(r => realSetTimeout(r, 10));
}

test('progress top-up skips explicit unplayed games but keeps unknown playtime', async () => {
    reset();
    apps.push({ appid: 2001, minutes_playtime_forever: 0, rt_last_time_played: 0 }, { appid: 2002 },
        { appid: 2003, minutes_playtime_forever: 0, rt_last_time_played: 99 });
    const result = await data.ensureProgressCache();
    assert.deepEqual(result.attempted, [2002, 2003]);
});

test('zero-time and removed family games remain top-up candidates when retained', async () => {
    reset(); apps.push({ appid: 2001, minutes_playtime_forever: 0, rt_last_time_played: 0 });
    const result = await data.ensureProgressCache({ retainedAppids: [2001, 3001] });
    assert.deepEqual(result.attempted, [2001, 3001]);
});

test('store passes cached cards, shelved history and manual dates to progress top-up', async () => {
    reset();
    cache.writeState([{ appid: 4001, total, name: 'Old card' }]);
    cache.writeShelved([4002]); cache.writeManualDates(new Map([[4003, now - 100]]));
    await loaded();
    assert.deepEqual(progressCalls, [4001, 4002, 4003]);
    assert.ok(store.getState().cards.some(c => c.appid === 4003 && c.completedAtSource === 'manual'));
});

test('missing date persists cooldown and manual entry across disposal/reopen', async () => {
    reset(); dateMode = 'missing'; await loaded();
    assert.equal(nativeCalls.length, 1);
    assert.ok(store.getState().dates.unavailable.has(1001));
    store.dispose(); await loaded();
    assert.equal(nativeCalls.length, 1, 'reopen must not repeat known missing date');
    assert.ok(store.getState().dates.unavailable.has(1001));
    assert.ok(store.setManualDate(1001, now - 12));
    assert.equal(store.getState().cards[0].completedAtSource, 'manual');
});

test('rarity/art failures cool down independently from successful dates', async () => {
    reset(); globalMode = 'error'; assetsMode = 'error';
    await store.load(); await waitFor(() => !store.getState().dates.running && globalCalls.length === 1 && artCalls.length === 1);
    store.dispose(); await store.load(); await new Promise(r => realSetTimeout(r, 20));
    assert.equal(globalCalls.length, 1); assert.equal(artCalls.length, 1); assert.equal(nativeCalls.length, 1);
    assert.ok(store.getState().cards[0].completedAt != null);
    for (const kind of ['rarity', 'art']) {
        const failure = cache.readFailures().get(`${kind}:1001`);
        assert.ok(failure.retryAt - Date.now() <= 5 * 60 * 1000, `${kind}: temporary failure uses short cooldown`);
    }
});

test('partial rarity is saved without a date and does not refetch on reopen', async () => {
    reset(); dateMode = 'missing'; globalMode = 'partial'; await loaded();
    assert.equal(store.getState().cards[0].unrated, 2);
    store.dispose(); await loaded();
    assert.equal(globalCalls.length, 1); assert.equal(store.getState().cards[0].rare, 1);
    assert.equal(store.getState().cards[0].completedAt, null);
    assert.ok(cache.readFailures().get('rarity:1001').retryAt - Date.now() > 6 * 86400000);
});

test('changed achievement total invalidates cooldown', async () => {
    reset(); dateMode = 'missing'; await loaded();
    store.dispose(); entries.set(1001, { total: 4, unlocked: 4, all_unlocked: true });
    // 总数变了：复核缓存失效重新查一次，日期冷却也失效再查一次
    await loaded(); assert.equal(nativeCalls.length, 3);
});

test('cancelled date result does not mark unavailable or poison the next open', async () => {
    reset(); let resolve;
    dateMode = () => new Promise(r => { resolve = r; });
    await store.load(); await waitFor(() => Boolean(resolve)); store.pause();
    resolve({ result: 1, data: { rgAchievements: [] } });
    await new Promise(r => realSetTimeout(r, 10));
    dateMode = 'ok'; await loaded();
    assert.equal(nativeCalls.length, 3, '被取消的日期请求之外，复核和补日期各查一次');
    assert.equal(store.getState().dates.unavailable.size, 0);
});

// 复核会顺带取到日期，所以 80 款的单次上限不再是第一道闸：每款只请求一次，重开也不重复
test('review reads each candidate once, keeps its date and never repeats on reopen', async () => {
    reset(85); await loaded();
    assert.equal(nativeCalls.length, 85);
    assert.ok(store.getState().cards.every(card => card.completedAt != null));
    store.pause(); await loaded(); assert.equal(nativeCalls.length, 85);
});

test('expired cooldown retries during the same session', async () => {
    reset(); dateMode = 'missing'; await loaded();
    const actualNow = Date.now;
    try {
        Date.now = () => actualNow() + 8 * 86400000;
        dateMode = 'ok'; await loaded();
        assert.equal(nativeCalls.length, 2); assert.equal(store.getState().dates.unavailable.size, 0);
    } finally { Date.now = actualNow; }
});

test('state and date cache writes coalesce while reads see the latest pending value', () => {
    reset();
    cache.writeState([{ appid: 1, name: 'old' }]);
    cache.writeState([{ appid: 1, name: 'latest' }]);
    cache.writeDates(new Map([[1, { completedAt: 10, total: 3, rare: null, common: null, unrated: null, fetchedAt: 0 }]]));
    assert.equal(writes.filter(key => key === cache.CACHE_KEYS.KEY_STATE).length, 0);
    assert.equal(cache.readState().cards[0].name, 'latest');
    assert.equal(cache.readDates().get(1).completedAt, 10);
    cache.flushWrites();
    assert.equal(writes.filter(key => key === cache.CACHE_KEYS.KEY_STATE).length, 1);
    assert.equal(writes.filter(key => key === cache.CACHE_KEYS.KEY_DATES).length, 1);
    assert.equal(cache.readState().cards[0].name, 'latest');
});

test('coalesced caches defer entry construction and JSON serialization until flush', () => {
    reset();
    let iterations = 0, serializations = 0;
    class ObservedDates extends Map {
        [Symbol.iterator]() { iterations++; return super[Symbol.iterator](); }
    }
    const dates = new ObservedDates([[1, { completedAt: 10, total: 3 }]]);
    const cards = [{ appid: 1, toJSON() { serializations++; return { appid: 1 }; } }];
    for (let i = 0; i < 25; i++) { cache.writeDates(dates); cache.writeState(cards); }
    assert.equal(iterations, 0); assert.equal(serializations, 0);
    cache.flushWrites();
    assert.equal(iterations, 1); assert.equal(serializations, 1);
});

test('coalesced snapshots automatically persist the latest values after one second', async () => {
    reset();
    for (let i = 1; i <= 10; i++) {
        cache.writeState([{ appid: 1, name: `revision ${i}` }]);
        cache.writeDates(new Map([[1, { completedAt: i, total: 3 }]]));
    }
    assert.equal(disk.has(cache.CACHE_KEYS.KEY_STATE), false);
    await new Promise(r => realSetTimeout(r, 1100));
    assert.equal(JSON.parse(disk.get(cache.CACHE_KEYS.KEY_STATE)).cards[0].name, 'revision 10');
    assert.equal(JSON.parse(disk.get(cache.CACHE_KEYS.KEY_DATES)).entries[0][1], 10);
    for (const key of [cache.CACHE_KEYS.KEY_STATE, cache.CACHE_KEYS.KEY_DATES]) {
        assert.equal(writes.filter(k => k === key).length, 1);
    }
});

test('pause flushes pending failure records and manual dates stay synchronous', () => {
    reset();
    const failures = new Map([['date:1', { total: 3, reason: 'offline', retryAt: Date.now() + 1000 }]]);
    cache.writeFailures(failures);
    store.pause();
    assert.ok(writes.includes(cache.CACHE_KEYS.KEY_FAILURES));
    assert.equal(cache.readFailures().get('date:1').reason, 'offline');
    cache.writeManualDates(new Map([[1, 20]]));
    assert.ok(writes.includes(cache.CACHE_KEYS.KEY_MANUAL));
    assert.equal(cache.readManualDates().get(1), 20);
});

test('dispose flushes completed results before clearing mutable failure state', async () => {
    reset(2); let resolveSecond;
    dateMode = appid => appid === 1001
        ? { result: 1, data: { rgAchievements: [] } }
        : new Promise(resolve => { resolveSecond = resolve; });
    await store.load(); await waitFor(() => Boolean(resolveSecond));
    cache.writeState(store.getState().cards);
    store.dispose();
    assert.equal(cache.readFailures().get('date:1001').reason, 'no-unlock-time');
    assert.equal(JSON.parse(disk.get(cache.CACHE_KEYS.KEY_STATE)).cards.length, 2);
    resolveSecond({ result: 1, data: { rgAchievements: [] } });
    await new Promise(r => realSetTimeout(r, 10));
    assert.equal(cache.readFailures().has('date:1002'), false, 'late cancelled results remain ignored');
});

test('clearAll cancels pending writes so cleared state does not return later', async () => {
    reset();
    cache.writeState([{ appid: 1 }]);
    cache.clearAll();
    await new Promise(r => realSetTimeout(r, 1050));
    assert.equal(localStorage.getItem(cache.CACHE_KEYS.KEY_STATE), null);
});

after(() => { store.dispose(); globalThis.setTimeout = realSetTimeout; });
