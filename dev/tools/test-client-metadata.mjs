/** Regressions based on the actual Steam client: native rates are all zero. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const moduleUrl = file => pathToFileURL(path.join(root, 'millennium/themes/AchievementCollection/src/js/ac', file)).href;
const NOW = Math.floor(Date.now() / 1000);
const apps = Array.from({ length: 6 }, (_, i) => ({ appid: 9001 + i, display_name: `Client fixture ${i}` }));
const storage = new Map();
let nativeCalls = [], rpcCalls = [], subscriptions = 0;
globalThis.localStorage = {
    get length() { return storage.size; }, key: i => [...storage.keys()][i] ?? null,
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
};
globalThis.SteamClient = { Apps: {} };
globalThis.opener = {};
globalThis.appStore = { allApps: apps, GetAppOverviewByAppID: id => apps.find(a => a.appid === id) };
globalThis.appAchievementProgressCache = { m_achievementProgress: {
    mapCache: new Map(apps.map(({ appid }) => [appid, { total: 3, unlocked: 3, all_unlocked: true }])),
} };
const store = await import(moduleUrl('store.js'));
const cache = await import(moduleUrl('cache.js'));
const waitFor = async check => {
    const deadline = Date.now() + 3000;
    while (!check() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    assert.ok(check(), 'metadata update finished within 3 seconds');
};
const nativeAchievements = async appid => {
    nativeCalls.push(Number(appid));
    return { result: 1, data: { rgAchievements: [0, 0, 0].map((flAchieved, i) => ({
        strID: `A${i}`, flAchieved, bAchieved: true, rtUnlocked: NOW - Number(appid) + i,
    })) } };
};
const achievementMap = (appid, rates = [9.99, 10, 35]) => JSON.stringify([
    [Number(appid), rates.map((flAchieved, i) => [`A${i}`, { strID: `A${i}`, flAchieved }])],
]);
const seedDates = () => cache.writeDates(new Map(apps.map(({ appid }) => [appid, {
    completedAt: NOW - appid, rare: null, common: null, unrated: null, total: 3, fetchedAt: 0,
}])));
function installRpc(rates = ['9.99', '10', '35']) {
    const transport = {};
    globalThis.opener.App = { cm: { GetServiceTransport: () => transport }, GetCurrentUser: () => ({ strSteamID: '76561198000000000' }) };
    const service = { GetGameAchievements: async (actualTransport, request) => {
        assert.equal(actualTransport, transport); rpcCalls.push(request.appid);
        // The live Player service rejects requests without a language (EResult 8).
        if (!request.language) return { GetEResult: () => 8 };
        return { GetEResult: () => 1, Body: () => ({ toObject: () => ({ achievements:
            rates.map((pct, i) => ({ internal_name: `A${i}`, internal_key: i + 100, player_percent_unlocked: pct })),
        }) }) };
    } };
    globalThis.opener.MILLENNIUM_API = { findModuleByExport: match => match(service) ? { service } : undefined };
    return service;
}
function reset() {
    store.dispose(); cache.clearAll(); nativeCalls = []; rpcCalls = [];
    delete globalThis.opener.appDetailsCache; delete globalThis.opener.appDetailsStore;
    delete globalThis.opener.MILLENNIUM_API; delete globalThis.opener.App;
    globalThis.opener.SteamClient = { Apps: { GetMyAchievementsForApp: nativeAchievements } };
}
let failures = 0;
async function test(label, run) {
    reset();
    try { await run(); console.log(`ok ${label}`); }
    catch (err) { failures++; console.error(`FAIL ${label}: ${err.message}`); }
    finally { store.pause(); }
}
const classified = () => store.getState().cards.every(c => c.rare === 1 && c.common === 2 && c.unrated === 0);
await test('official string percentages classify all six games with dates disabled', async () => {
    seedDates(); installRpc(); store.setDatesEnabled(false);
    await store.load(); await waitFor(classified);
    // 关闭读取日期后不再补日期，但全成就复核仍会各查一次个人成就接口
    assert.equal(rpcCalls.length, 6); assert.equal(nativeCalls.length, 6);
    assert.equal(cache.readDates().get(9001).completedAt, NOW - 9001);
});
await test('all-zero date responses never overwrite official rarity', async () => {
    installRpc(); await store.load(); await waitFor(() => !store.getState().dates.running); await waitFor(classified);
    assert.equal(nativeCalls.length, 6);
    assert.equal(store.getState().cards[0].completedAt, NOW - 9001 + 2);
    assert.equal(cache.readDates().get(9001).rare, 1);
});
await test('native zero rates remain unclassified when global data is unavailable', async () => {
    await store.load(); await waitFor(() => !store.getState().dates.running);
    assert.ok(store.getState().cards.every(c => c.rare == null && c.common == null));
});
await test('Steam achievementmap remains an offline fallback', async () => {
    seedDates(); store.setDatesEnabled(false);
    globalThis.opener.SteamClient.Apps.GetCachedAppDetails = async id => JSON.stringify([
        ['achievementmap', { version: 5, data: achievementMap(id) }],
    ]);
    await store.load(); await waitFor(classified);
});
await test('official 0% is valid and absent percentages stay unclassified', async () => {
    installRpc(['0', '10', '']); store.setDatesEnabled(false);
    await store.load(); await waitFor(() => store.getState().cards.every(c => c.rare === 1 && c.common === 1 && c.unrated === 1));
});
await test('new locked achievements are excluded by matching official user keys', async () => {
    seedDates(); store.setDatesEnabled(false);
    // The schema order differs from the unlocked collection: slicing the first three is wrong.
    const service = installRpc(['1', '2', '10', '35', '0']);
    service.GetUserAchievements = async (_transport, request) => {
        assert.equal(request.steamid, '76561198000000000');
        return { GetEResult: () => 1, Body: () => ({ toObject: () => ({ achievements: [
            { internal_key: 104, unlocked: true }, { internal_key: 102, unlocked: true },
            { internal_key: 103, unlocked: true }, { internal_key: 100, unlocked: false },
            { internal_key: 101, unlocked: false },
        ] }) }) };
    };
    await store.load(); await waitFor(classified);
    assert.equal(nativeCalls.length, 0, 'dates API is not required to classify an expanded schema');
    assert.ok(store.getState().cards.every(c => c.total === 3));
});
await test('an expanded schema with an unconfirmed unlocked set remains unknown', async () => {
    seedDates(); store.setDatesEnabled(false);
    const service = installRpc(['1', '2', '10', '35']);
    let calls = 0;
    service.GetUserAchievements = async () => {
        calls++;
        return { GetEResult: () => 1, Body: () => ({ toObject: () => ({ achievements: [
            { internal_key: 100, unlocked: true }, { internal_key: 101, unlocked: true },
            { internal_key: 999, unlocked: true },
        ] }) }) };
    };
    await store.load(); await waitFor(() => calls === 6);
    assert.ok(store.getState().cards.every(c => c.rare == null && c.common == null));
});
await test('old all-gold cache is invalidated while preserving completion dates', async () => {
    seedDates();
    cache.flushWrites(); // The fixture below deliberately edits the persisted legacy payload.
    const payload = JSON.parse(storage.get(cache.CACHE_KEYS.KEY_DATES)); payload.rareVersion = 3;
    for (const row of payload.entries) { row[2] = 3; row[4] = Date.now(); row[5] = 0; row[6] = 0; }
    storage.set(cache.CACHE_KEYS.KEY_DATES, JSON.stringify(payload));
    assert.equal(cache.readDates().get(9001).rare, null);
    installRpc(); store.setDatesEnabled(false); await store.load(); await waitFor(classified);
    assert.equal(cache.readDates().get(9001).completedAt, NOW - 9001);
});
await test('cover loading bypasses the Steam callback that overwrites unloaded caches', async () => {
    seedDates(); installRpc(); store.setDatesEnabled(false);
    const disk = new Map(apps.map(a => [a.appid, achievementMap(a.appid)])), before = [...disk];
    globalThis.opener.appDetailsStore = {
        GetAppDetails: () => null,
        RegisterForAppData: id => { disk.set(id, 'overwritten'); throw Error('unsafe store registration'); },
    };
    globalThis.opener.SteamClient.Apps.RegisterForAppDetails = (id, callback) => {
        subscriptions++;
        const timer = setTimeout(() => callback({ libraryAssets: {
            strHeroImage: `hero${id}/library_hero.jpg`, strHeaderImage: `header${id}/library_header.jpg`,
        } }), 10);
        return { unregister() { clearTimeout(timer); subscriptions--; } };
    };
    await store.load();
    await waitFor(() => store.getState().cards.every(c => c.art.hero[0].includes(`/hero${c.appid}/library_hero.jpg`)));
    assert.deepEqual([...disk], before); assert.equal(subscriptions, 0);
});
await test('leaving discards a late RPC response and releases cover subscriptions', async () => {
    let deliver;
    const service = installRpc(), get = service.GetGameAchievements;
    service.GetGameAchievements = (...args) => new Promise(resolve => { deliver = async () => resolve(await get(...args)); });
    globalThis.opener.SteamClient.Apps.RegisterForAppDetails = () => {
        subscriptions++; return { unregister() { subscriptions--; } };
    };
    store.setDatesEnabled(false); await store.load(); await waitFor(() => typeof deliver === 'function');
    const cards = store.getState().cards; store.pause(); await deliver(); await new Promise(r => setTimeout(r, 30));
    assert.equal(store.getState().cards, cards); assert.equal(subscriptions, 0);
});
store.dispose();
if (failures) { console.error(`${failures} client metadata regressions failed`); process.exitCode = 1; }
else console.log('All 10 client metadata regressions passed');
