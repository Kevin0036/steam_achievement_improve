/**
 * share.js 的离线断言。
 *
 * share.js 依赖主题里的 orderForBook / yearpages / coveredit，所以把整个
 * src/js/ac 目录复制到 .tmp 并加上 "type":"module"，再在 Node 里直接加载。
 *
 * 用法：node tools/test-share.mjs
 */

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection');
const SRC_AC = path.join(THEME, 'src', 'js', 'ac');
const TMP = path.join(HERE, '..', '.tmp', 'share-test');

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
cpSync(SRC_AC, path.join(TMP, 'ac'), { recursive: true });
writeFileSync(path.join(TMP, 'package.json'), '{"type":"module"}\n', 'utf8');

const share = await import(pathToFileURL(path.join(TMP, 'ac', 'share.js')).href);
const require = createRequire(import.meta.url);
const { validateSnapshot } = require(path.join(HERE, '..', 'share-server', 'snapshot.js'));

const ART = 'https://shared.steamstatic.com/store_item_assets/steam/apps';
const artUrl = (appid, file = 'library_hero.jpg') => `${ART}/${appid}/${file}?t=1700000000`;
const avatarUrl = 'https://avatars.steamstatic.com/abc123_full.jpg';

function artFor(appid, extra = {}) {
    return {
        hero: [artUrl(appid)],
        capsule: [artUrl(appid, 'library_600x900.jpg')],
        header: [artUrl(appid, 'header.jpg')],
        logo: [artUrl(appid, 'logo.png')],
        ...extra,
    };
}

function card(appid, overrides = {}) {
    return {
        appid,
        name: `Game ${appid}`,
        completedAt: Date.UTC(2025, 5, 1) / 1000,
        playtimeMin: 600,
        total: 20,
        rare: 3,
        common: 17,
        unrated: 0,
        art: artFor(appid),
        ...overrides,
    };
}

const ALBUM = { perPage: 1, binding: 'sequential', showStats: true, yearPages: false, yearSpread: false };
const OWNER = { persona: '阿凯', avatar: avatarUrl, accountId: 39734272, steamid: '76561198000000000' };
const defaultCover = () => ({ front: { s: 1, x: 0, y: 0 }, back: { mode: 'fit' } });

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures += 1;
        console.error(`FAIL  ${name}`);
        console.error(`      ${err.message}`);
    }
}

console.log('share.js');

test('基本信息与 owner 白名单：不含 SteamID / accountId，保留好友代码', () => {
    const doc = share.buildSnapshot({ cards: [card(413150)], owner: OWNER, album: ALBUM, coverOf: defaultCover });
    assert.equal(doc.schemaVersion, 1);
    assert.equal(doc.kind, 'achievement-album');
    assert.deepEqual(doc.owner, { name: '阿凯', avatar: avatarUrl, friendCode: '39734272' });
    assert.equal(doc.sharedAt, undefined);
    assert.equal(doc.updatedAt, undefined);
    assert.equal(doc.revision, undefined);

    const json = JSON.stringify(doc);
    assert.ok(!json.includes('76561198000000000'), 'SteamID64 泄漏');
    assert.ok(!/"(steamid|steamid64|accountid|accountId|account_id)"/i.test(json), '出现禁用字段名');
});

test('owner 头像与昵称的清洗', () => {
    const doc = share.buildSnapshot({
        cards: [card(1)],
        owner: { persona: '  名字很长'.repeat(20), avatar: 'data:image/png;base64,AAAA', accountId: null },
        album: ALBUM,
        coverOf: defaultCover,
    });
    assert.equal(doc.owner.avatar, null);
    assert.equal(doc.owner.friendCode, undefined);
    assert.ok(doc.owner.name.length <= 64);

    const insecure = share.buildSnapshot({
        cards: [card(1)],
        owner: { persona: 'x', avatar: 'http://avatars.steamstatic.com/a.jpg' },
        album: ALBUM,
        coverOf: defaultCover,
    });
    assert.equal(insecure.owner.avatar, null);
});

test('art 只保留本 appid 的 Steam CDN 地址，本地 /assets/ 与异构地址剔除', () => {
    const doc = share.buildSnapshot({
        cards: [
            card(413150, {
                art: {
                    hero: [
                        '/assets/413150/library_hero.jpg?c=3',
                        'https://evil.example/413150.jpg',
                        artUrl(999, 'library_hero.jpg'),
                        artUrl(413150, 'library_hero.jpg'),
                        artUrl(413150, 'library_hero.jpg'),
                        artUrl(413150, 'library_hero.jpg'),
                        artUrl(413150, 'library_hero.jpg'),
                        artUrl(413150, 'library_hero.jpg'),
                    ],
                    capsule: [],
                    header: ['/assets/413150/header.jpg?c=3'],
                    logo: [artUrl(413150, 'logo.png')],
                },
            }),
        ],
        owner: OWNER,
        album: ALBUM,
        coverOf: defaultCover,
    });
    const art = doc.cards[0].art;
    assert.deepEqual(art.hero, [artUrl(413150, 'library_hero.jpg')]);
    assert.deepEqual(art.capsule, []);
    assert.deepEqual(art.header, []);
    assert.deepEqual(art.logo, [artUrl(413150, 'logo.png')]);
    assert.equal(JSON.stringify(doc).includes('/assets/'), false);
});

test('卡片顺序与 orderForBook 一致（先按完成时间升序，再顺序入册 / 最新优先 / 年份分组）', () => {
    const cards = [
        card(100, { completedAt: Date.UTC(2024, 2, 1) / 1000 }),
        card(200, { completedAt: null }),
        card(300, { completedAt: Date.UTC(2025, 2, 1) / 1000 }),
        card(400, { completedAt: Date.UTC(2024, 8, 1) / 1000 }),
    ];
    const ids = (album, input = cards) => share.buildSnapshot({ cards: input, owner: OWNER, album, coverOf: defaultCover }).cards.map((c) => c.appid);

    assert.deepEqual(ids(ALBUM), [100, 400, 300, 200]);
    assert.deepEqual(ids({ ...ALBUM, binding: 'newest' }), [200, 300, 400, 100]);
    assert.deepEqual(ids({ ...ALBUM, yearPages: true }), [200, 100, 400, 300]);
    assert.deepEqual(ids({ ...ALBUM, yearPages: true, binding: 'newest' }), [200, 400, 100, 300]);

    // store 里的原始顺序不参与决定：打乱输入应得到同一份快照
    const shuffled = [cards[3], cards[1], cards[0], cards[2]];
    assert.deepEqual(ids(ALBUM, shuffled), ids(ALBUM));
    assert.deepEqual(ids({ ...ALBUM, yearPages: true }, shuffled), ids({ ...ALBUM, yearPages: true }));
});

test('年份槽位：清掉不存在的 appid / 非法等级，固定 3 槽，未知年份丢弃', () => {
    const doc = share.buildSnapshot({
        cards: [card(413150), card(730, { completedAt: null })],
        owner: OWNER,
        album: { ...ALBUM, yearPages: true },
        yearSelections: {
            2025: {
                badges: [{ appid: 413150, level: 5 }, { appid: 999, level: 5 }, { appid: 413150, level: 9 }],
                banners: [413150, 999, null],
            },
            2019: { badges: [{ appid: 413150, level: 1 }], banners: [413150] },
            abcd: { badges: [null, null, null], banners: [413150] },
        },
        coverOf: defaultCover,
    });
    assert.deepEqual(Object.keys(doc.years), ['2025']);
    assert.deepEqual(doc.years['2025'].badges, [{ appid: 413150, level: 5 }, null, null]);
    assert.deepEqual(doc.years['2025'].banners, [413150, null, null]);
});

test('年份徽章图：快照带上官方徽章地址，非官方地址丢弃，cover 不带图', () => {
    const badge = (appid) => `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/items/${appid}/abc123.png`;
    const doc = share.buildSnapshot({
        cards: [card(413150), card(730)],
        owner: OWNER,
        album: { ...ALBUM, yearPages: true },
        yearSelections: {
            2025: {
                badges: [{ appid: 413150, level: 'foil' }, { appid: 730, level: 5 }, { appid: 413150, level: 'cover' }],
                banners: [413150, null, null],
            },
        },
        coverOf: defaultCover,
        badgeUrlOf: (appid, level) => (level === 'cover' ? badge(appid) : appid === 413150 ? badge(appid) : 'https://evil.example.com/x.png'),
    });
    assert.deepEqual(doc.years['2025'].badges, [
        { appid: 413150, level: 'foil', url: badge(413150) },
        { appid: 730, level: 5 },
        { appid: 413150, level: 'cover' },
    ]);

    const checked = validateSnapshot(JSON.parse(JSON.stringify(doc)));
    assert.equal(checked.ok, true);
    assert.deepEqual(checked.doc.years['2025'].badges, [
        { appid: 413150, level: 'foil', url: badge(413150) },
        { appid: 730, level: 5 },
        { appid: 413150, level: 'cover' },
    ]);
    const tampered = JSON.parse(JSON.stringify(doc));
    tampered.years['2025'].badges[0].url = 'https://evil.example.com/steamcommunity/public/images/items/413150/x.png';
    const rejected = validateSnapshot(tampered);
    assert.equal(rejected.ok, true);
    assert.equal('url' in rejected.doc.years['2025'].badges[0], false);
});

test('封面取景：默认省略；非默认保留并夹紧；fit 不写出', () => {
    const doc = share.buildSnapshot({
        cards: [card(1), card(2)],
        owner: OWNER,
        album: ALBUM,
        coverOf: (appid) => (appid === 1
            ? { front: { s: 1, x: 0, y: 0 }, back: { mode: 'fit' } }
            : { front: { s: 2, x: 999, y: -999 }, back: { mode: 'stretch' } }),
    });
    assert.equal('cover' in doc.cards[0], false);
    assert.deepEqual(doc.cards[1].cover, {
        front: { s: 1.2, x: 50, y: -50 },
        back: { mode: 'stretch' },
    });
});

test('数值清洗与名称兜底', () => {
    const doc = share.buildSnapshot({
        cards: [
            card(42, {
                name: '   ',
                completedAt: Number.NaN,
                playtimeMin: -5,
                total: null,
                rare: undefined,
                common: 1.9,
                unrated: 'x',
            }),
            card(43, { name: '长'.repeat(200) }),
        ],
        owner: null,
        album: ALBUM,
        coverOf: defaultCover,
    });
    const first = doc.cards[0];
    assert.equal(first.name, 'App 42');
    assert.equal(first.completedAt, null);
    assert.equal(first.playtimeMin, null);
    assert.equal(first.total, null);
    assert.equal(first.rare, null);
    assert.equal(first.common, 1);
    assert.equal(first.unrated, null);
    assert.equal(doc.owner.name, null);
    assert.equal(doc.owner.avatar, null);
    assert.equal([...doc.cards[1].name].length, 160);
});

test('超过 3000 张卡直接拒绝；序列化体积可读', () => {
    const cards = Array.from({ length: 3001 }, (_, i) => card(i + 1));
    assert.throws(() => share.buildSnapshot({ cards, owner: OWNER, album: ALBUM, coverOf: defaultCover }), /上限/);

    const doc = share.buildSnapshot({ cards: [card(1)], owner: OWNER, album: ALBUM, coverOf: defaultCover });
    const { json, bytes } = share.serializeSnapshot(doc);
    assert.ok(bytes > 0);
    assert.equal(bytes, Buffer.byteLength(json, 'utf8'));
    assert.deepEqual(JSON.parse(json), doc);
});

test('服务端校验器接受 buildSnapshot 的输出，并拒绝夹带 SteamID 的版本', () => {
    const doc = share.buildSnapshot({
        cards: [card(413150), card(730, { completedAt: null })],
        owner: OWNER,
        album: { ...ALBUM, yearPages: true, yearSpread: true },
        yearSelections: { 2025: { badges: [{ appid: 413150, level: 'cover' }, null, null], banners: [730, null, null] } },
        coverOf: (appid) => ({ front: { s: appid === 413150 ? 1.1 : 1, x: 0, y: 0 }, back: { mode: appid === 413150 ? 'stretch' : 'fit' } }),
    });
    const result = validateSnapshot(doc);
    assert.equal(result.ok, true, result.ok ? '' : result.problems.join('；'));
    assert.equal(result.doc.cards.length, 2);
    const shared = result.doc.cards.find((item) => item.appid === 413150);
    assert.deepEqual(shared.cover.front, { s: 1.1, x: 0, y: 0 });

    const tampered = { ...doc, owner: { ...doc.owner, steamid: '76561198000000000' } };
    const rejected = validateSnapshot(tampered);
    assert.equal(rejected.ok, false);
    assert.ok(rejected.problems.some((line) => /steam_?id/i.test(line)));
});

if (failures > 0) {
    console.error(`\n${failures} 项失败`);
    process.exit(1);
}
console.log('\n全部通过');
