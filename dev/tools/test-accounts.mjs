/**
 * 成就收藏册 · 多账号合并测试（Node，无需 Steam、无需浏览器）
 *
 * 覆盖两件事：
 *   1. 本地缓存按账号隔离：旧的无前缀缓存只迁移一次，切账号不串数据；
 *   2. 只读快照的发现 / 取回 / 合并规则：当前账号优先、同 appid 只留一张、
 *      当前账号自己的快照不合并、网络失败保留上次缓存。
 *
 * 用法：node tools/test-accounts.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AC = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection', 'src', 'js', 'ac');

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

/* ── 存储与网络桩 ───────────────────────────────────────────────────────── */

const storage = new Map();
globalThis.localStorage = {
    get length() {
        return storage.size;
    },
    key: (index) => [...storage.keys()][index] ?? null,
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
};

const NOW = Math.floor(Date.now() / 1000);
let requested = [];
let routes = new Map();

globalThis.fetch = async (url) => {
    const { pathname } = new URL(url);
    requested.push(pathname);
    const route = routes.get(pathname);
    if (!route) return respond(404, { error: 'not_found' });
    if (route instanceof Error) throw route;
    return respond(200, route);
};

function respond(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(payload),
    };
}

function snapshot({ name, friendCode, updatedAt, cards }) {
    return {
        schemaVersion: 1,
        kind: 'achievement-album',
        owner: { name, avatar: 'https://avatars.steamstatic.com/alt_full.jpg', friendCode },
        album: { perPage: 1, binding: 'sequential', showStats: true, yearPages: false, yearSpread: false },
        cards,
        years: {},
        sharedAt: NOW - 1000,
        updatedAt,
        revision: 2,
    };
}

const art = (appid) => ({
    hero: [`https://shared.steamstatic.com/store_item_assets/steam/apps/${appid}/hero.jpg`],
    capsule: [],
    header: ['https://evil.example/not-a-steam-url.jpg'],
    logo: [],
});

const ALT_DOC = snapshot({
    name: '小号',
    friendCode: '777',
    updatedAt: NOW - 100,
    cards: [
        { appid: 5001, name: 'Alt Game One', completedAt: NOW - 5000, playtimeMin: 600, total: 10, rare: 4, common: 6, unrated: 0, art: art(5001) },
        { appid: 5002, name: 'Alt Game Two', completedAt: null, playtimeMin: null, total: 8, rare: null, common: null, unrated: 8, art: {} },
    ],
});

const SELF_DOC = snapshot({
    name: '大号',
    friendCode: '42',
    updatedAt: NOW - 50,
    cards: [
        { appid: 5003, name: 'Should Never Merge', completedAt: NOW - 10, playtimeMin: 1, total: 1, rare: 0, common: 1, unrated: 0, art: {} },
    ],
});

const OTHER_DOC = snapshot({
    name: '小小号',
    friendCode: '888',
    updatedAt: NOW - 10,
    cards: [
        { appid: 5001, name: 'Alt Game One v2', completedAt: NOW - 4000, playtimeMin: 700, total: 12, rare: 5, common: 7, unrated: 0, art: art(5001) },
        { appid: 5004, name: 'Third Account Game', completedAt: NOW - 300, playtimeMin: 30, total: 3, rare: null, common: null, unrated: 3, art: {} },
    ],
});

/* ── 开跑 ───────────────────────────────────────────────────────────────── */

const cache = await import(`file://${path.join(AC, 'cache.js').replace(/\\/g, '/')}`);
const share = await import(`file://${path.join(AC, 'share.js').replace(/\\/g, '/')}`);
const accounts = await import(`file://${path.join(AC, 'accounts.js').replace(/\\/g, '/')}`);

console.log('\n── 缓存按账号隔离 ───────────────────────────────────');
{
    // 模拟升级前的无前缀缓存：只应被第一个登录的账号认领一次
    storage.set('ac:v1:manual', JSON.stringify({ version: 1, entries: [[111, 1700000000]] }));
    storage.set('ac:v1:state', JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        cards: [{ appid: 111, name: 'Legacy Card', total: 5 }],
    }));

    cache.setAccountScope('scope-a');
    eq('旧手动日期迁移到账号 A', cache.readManualDates().get(111), 1700000000);
    eq('旧卡片快照迁移到账号 A', cache.readState()?.cards?.[0]?.name, 'Legacy Card');
    ok('旧的无前缀键迁移后删除', !storage.has('ac:v1:manual') && !storage.has('ac:v1:state'));
    eq('键名带上账号作用域', cache.CACHE_KEYS.KEY_STATE, 'ac:v1:scope-a:state');

    cache.writeManualDates(new Map([[222, 1800000000]]));
    cache.flushWrites();

    cache.setAccountScope('scope-b');
    eq('账号 B 读不到账号 A 的手动日期', cache.readManualDates().size, 0);
    cache.writeManualDates(new Map([[333, 1900000000]]));
    cache.flushWrites();

    cache.setAccountScope('scope-a');
    eq('切回账号 A 读到自己的手动日期', cache.readManualDates().get(222), 1800000000);
    ok('账号 B 的日期没有串进来', !cache.readManualDates().has(333));
    cache.setAccountScope('scope-b');
    eq('账号 B 读到自己的手动日期', cache.readManualDates().get(333), 1900000000);

    cache.setAccountScope(null);
    eq('认不出账号时不读任何账号的缓存', cache.readManualDates().size, 0);
    cache.writeManualDates(new Map([[444, 2000000000]]));
    cache.flushWrites();
    ok('认不出账号时不写本地缓存', ![...storage.values()].some((value) => String(value).includes('[[444,2000000000]]')));
    eq('认不出账号时本次会话仍可读', cache.readManualDates().get(444), 2000000000);
}

console.log('\n── 卡片快照不写入外部账号的卡 ───────────────────────');
{
    cache.setAccountScope('scope-a');
    cache.writeState([
        { appid: 1, name: 'Own Card' },
        { appid: 2, name: 'Alt Card', source: 'external' },
    ]);
    cache.flushWrites();
    const raw = JSON.parse(storage.get('ac:v1:scope-a:state'));
    eq('localStorage 里只有当前账号的卡', raw.cards.length, 1);
    eq('写进去的是当前账号那张', raw.cards[0]?.name, 'Own Card');
    eq('readState 也过滤外部卡', cache.readState()?.cards?.length, 1);
}

console.log('\n── 本机借阅记录 ─────────────────────────────────────');
{
    storage.set('ac:v1:share', JSON.stringify({
        777: {
            token: 'ALT_TOKEN_1', editKey: 'SECRET1', code: '123456789', url: 'https://kevin0036.github.io/?c=123456789',
            sharedAt: NOW - 1000, updatedAt: NOW - 100, revision: 2,
        },
        42: {
            token: 'SELF_TOKEN', editKey: 'SECRET2', code: '222222222', url: 'https://kevin0036.github.io/?c=222222222',
            sharedAt: NOW - 900, updatedAt: NOW - 50, revision: 1,
        },
    }));

    const records = share.listShareRecords();
    eq('读出两条本机分享记录', records.length, 2);
    ok('记录里没有 editKey', !JSON.stringify(records).includes('SECRET1'));
    eq('记录保留借阅码', records.find((row) => row.accountId === 777)?.code, '123456789');
}

console.log('\n── 自动发现并合并小号快照 ───────────────────────────');
{
    routes.set('/api/albums/ALT_TOKEN_1', ALT_DOC);
    routes.set('/api/albums/SELF_TOKEN', SELF_DOC);
    requested = [];
    accounts.setEnabled(true);

    const first = await accounts.refreshAll({ currentAccountId: 42, force: true });
    ok('刷新成功', first.failed === 0, JSON.stringify(first));
    ok('当前账号自己的快照不请求', !requested.some((p) => p.includes('SELF_TOKEN')), requested.join(','));

    const sources = accounts.listSources({ currentAccountId: 42 });
    const alt = sources.find((row) => row.kind === 'local');
    ok('本机记录被自动发现', Boolean(alt));
    eq('来源显示小号昵称', alt?.owner?.name, '小号');
    eq('来源显示卡片数', alt?.cardCount, 2);
    ok('来源列表不暴露 token', !JSON.stringify(sources).includes('ALT_TOKEN_1'));

    const cards = accounts.getCards({ currentAccountId: 42 });
    eq('合并出两张外部卡', cards.length, 2);
    const one = cards.find((card) => card.appid === 5001);
    eq('外部卡来源标记', one?.source, 'external');
    eq('卡面归属小号', one?.owner?.persona, '小号');
    eq('保留完成日期', one?.completedAt, NOW - 5000);
    eq('保留游玩时长', one?.playtimeMin, 600);
    eq('保留成就总数', one?.total, 10);
    eq('保留稀有数', one?.rare, 4);
    eq('完成状态为全成就', one?.state, 'complete');
    eq('只保留 Steam CDN 的美术地址', one?.art?.header?.length, 0);
    eq('主视觉地址保留', one?.art?.hero?.length, 1);
    ok('当前账号自己的卡没有混进来', !cards.some((card) => card.appid === 5003));
    eq('不知道当前账号时不合并', accounts.getCards({}).length, 0);
}

console.log('\n── 手动借阅码与多来源优先级 ─────────────────────────');
{
    eq('借阅码格式不对时拒绝', accounts.addSourceByCode('123').ok, false);
    const added = accounts.addSourceByCode('987654321');
    eq('添加 9 位借阅码', added.ok, true);
    routes.set('/api/albums/by-code/987654321', OTHER_DOC);

    await accounts.refreshAll({ currentAccountId: 42, force: true });
    const cards = accounts.getCards({ currentAccountId: 42 });
    eq('两个来源合出三张卡', cards.length, 3);
    const one = cards.find((card) => card.appid === 5001);
    eq('同 appid 由更新时间更晚的来源胜出', one?.name, 'Alt Game One v2');
    eq('胜出来源的归属正确', one?.owner?.persona, '小小号');

    const before = requested.length;
    await accounts.refreshAll({ currentAccountId: 42 });
    eq('刚刷新过不会重复请求', requested.length, before);
}

console.log('\n── 网络失败与移除 ───────────────────────────────────');
{
    accounts.addSourceByCode('000000000');
    await accounts.refreshAll({ currentAccountId: 42, force: true });
    const sources = accounts.listSources({ currentAccountId: 42 });
    const broken = sources.find((row) => row.code === '000000000');
    ok('失败来源留下错误说明', Boolean(broken?.error), JSON.stringify(broken));
    eq('失败不影响已合并的卡', accounts.getCards({ currentAccountId: 42 }).length, 3);

    accounts.removeSource('code:987654321');
    eq('移除来源后它的卡消失', accounts.getCards({ currentAccountId: 42 }).length, 2);
    await accounts.refreshAll({ currentAccountId: 42, force: true });
    eq('移除后刷新也不会回来', accounts.getCards({ currentAccountId: 42 }).length, 2);

    accounts.setEnabled(false);
    eq('关闭合并后回到当前账号', accounts.getCards({ currentAccountId: 42 }).length, 0);
    accounts.setEnabled(true);

    const localId = accounts.listSources({ currentAccountId: 42 }).find((row) => row.kind === 'local')?.id;
    accounts.removeSource(localId);
    eq('移除本机来源后卡片消失', accounts.getCards({ currentAccountId: 42 }).length, 0);
    await accounts.refreshAll({ currentAccountId: 42, force: true });
    eq('移除本机来源后不会被自动重新发现', accounts.getCards({ currentAccountId: 42 }).length, 0);
}

console.log('');
if (failures > 0) {
    console.error(`✘ ${failures} / ${checks} 项失败`);
    process.exit(1);
}
console.log(`✔ ${checks} 项断言全部通过`);
