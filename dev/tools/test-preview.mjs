/** Preview/client parity checks: node tools/test-preview.mjs */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildPreviewCards, decodeStorageString } from './preview-data.mjs';
import { loadMatchingProgress, generateFixtures } from './make-preview-fixtures.mjs';
import { coverCandidates, appidFromHref } from '../../millennium/themes/AchievementCollection/src/js/ac/showcaseart.js';

const card = {
    appid: 9001, name: '客户端卡片', state: 'complete', total: 3, unlocked: 3,
    rare: 1, common: 2, unrated: 0, completedAt: 1234567890,
    art: { hero: ['/assets/9001/hash/library_hero.jpg?c=1'], capsule: [], header: [] },
};
const progress = [[9001, { total: 3, unlocked: 3, all_unlocked: true }]];
let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log(`ok ${name}`);
}

test('preserves exact client counts, completion date and hashed artwork', () => {
    assert.deepEqual(buildPreviewCards([card], progress), [card]);
});
test('does not turn missing percentages into silver trophies', () => {
    const unknown = { ...card, rare: null, common: null, unrated: 3, completedAt: null };
    assert.deepEqual(buildPreviewCards([unknown], progress), [unknown]);
});
test('rejects a changed achievement total instead of applying old counts', () => {
    assert.throws(() => buildPreviewCards([card], [[9001, { total: 4, all_unlocked: true }]]), /9001/);
});
test('rejects missing completed games and duplicate client cards', () => {
    assert.throws(() => buildPreviewCards([], progress), /9001/);
    assert.throws(() => buildPreviewCards([card, card], progress), /9001/);
});
test('rejects impossible trophy totals', () => {
    assert.throws(() => buildPreviewCards([{ ...card, common: 3 }], progress), /9001/);
});
test('uses the shared completion rule and removes games no longer complete', () => {
    assert.deepEqual(buildPreviewCards([card], [[9001, { total: 3, unlocked: 2 }]]), []);
    assert.deepEqual(buildPreviewCards([card], [[9001, { total: 0, all_unlocked: true }]]), []);
    assert.deepEqual(buildPreviewCards([card], [[9001, { total: 3, unlocked: 3 }]]), [card]);
});
test('sorts by exact client dates and keeps unavailable dates empty', () => {
    const undated = { ...card, appid: 9002, name: '未获取日期', completedAt: null };
    assert.deepEqual(buildPreviewCards([undated, card], [...progress, [9002, progress[0][1]]]), [card, undated]);
});
test('showcase covers fall back through Chinese header variants by appid', () => {
    const urls = coverCandidates(2458860);
    assert.deepEqual(urls.slice(0, 4), [
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2458860/header_schinese.jpg',
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2458860/header_tchinese.jpg',
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2458860/header_japanese.jpg',
        'https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/2458860/header.jpg',
    ]);
    assert.equal(new Set(urls).size, urls.length);
    assert.equal(urls.at(-1), 'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/2458860/header.jpg');

    assert.equal(appidFromHref('https://steamcommunity.com/stats/2458860/achievements/'), 2458860);
    assert.equal(appidFromHref('/profiles/76561197960265770/stats/2458860/achievements'), 2458860);
    assert.equal(appidFromHref('https://steamcommunity.com/app/2458860/'), 2458860);
    assert.equal(appidFromHref('?appid=2458860'), 2458860);
    assert.equal(appidFromHref('https://steamcommunity.com/profiles/76561197960265770'), null);
    assert.equal(appidFromHref(null), null);
});

globalThis.PLUGIN_LIST = {
    core: {
        activeTheme: {
            native: 'AchievementCollection',
            data: { Configuration: [{ Name: '旧版选项', Value: 'legacy' }] },
        },
        conditionals: { AchievementCollection: { '单页卡片数量': '4' } },
    },
};
const { getThemeOption } = await import('../../millennium/themes/AchievementCollection/src/js/ac/env.js?theme-option-test');
test('reads theme options from conditionals and keeps the legacy fallback', () => {
    assert.equal(getThemeOption('单页卡片数量', '1'), '4');
    assert.equal(getThemeOption('旧版选项', 'no'), 'legacy');
    assert.equal(getThemeOption('不存在的选项', 'fallback'), 'fallback');
    globalThis.PLUGIN_LIST.core.conditionals.AchievementCollection = {};
    assert.equal(getThemeOption('单页卡片数量', '1'), '1');
});

test('decodes Chromium Latin-1 and UTF-16 storage without damaging Chinese names', () => {
    assert.equal(decodeStorageString(Buffer.from([1, 0x61, 0xe9])), 'aé');
    assert.equal(decodeStorageString(Buffer.concat([Buffer.from([0]), Buffer.from('中文', 'utf16le')])), '中文');
    assert.throws(() => decodeStorageString(Buffer.from([2, 0x61])), /encoding/i);
});

test('selects the matching account and rejects a changed completed library', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ac-preview-test-'));
    try {
        for (const [account, mapCache] of [['100', [[9002, progress[0][1]]]], ['200', progress]]) {
            const dir = path.join(root, 'userdata', account, 'config', 'librarycache');
            mkdirSync(dir, { recursive: true });
            writeFileSync(path.join(dir, 'achievement_progress.json'), JSON.stringify({ mapCache }));
        }
        assert.equal(loadMatchingProgress({ cards: [card] }, root).accountId, '200');
        assert.throws(() => loadMatchingProgress({ cards: [card, { ...card, appid: 9003 }] }, root), /没有账户/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// These routes must serve the client's unmodified image paths as local images.
const { createPreviewServer } = await import('./preview-server.mjs');
const server = createPreviewServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
    for (const appid of [3265700, 4488860]) {
        const { CARDS } = await import('../preview/fixtures.js');
        const current = CARDS.find(c => c.appid === appid);
        for (const role of ['hero', 'capsule', 'header']) {
            const url = current.art[role][0];
            assert.ok(url.startsWith(`/assets/${appid}/`), `${appid}: ${role} uses the client's path`);
            const response = await fetch(base + url);
            assert.equal(response.status, 200, `${appid}: ${role} loads locally`);
            assert.match(response.headers.get('content-type'), /^image\//);
            assert.ok((await response.arrayBuffer()).byteLength > 1000);
        }
    }
    passed++;
    console.log('ok both repaired games: all six front/back artwork routes load locally');
    for (const url of ['/assets/%2e%2e%2fconfig/loginusers.vdf', '/assets/1.json', '/%E0%A4%A', '/theme/%2e%2e%2fAchievementCollection-other/file.js']) {
        assert.equal((await fetch(base + url)).status, 403, url);
    }
    passed++;
    console.log('ok image routes reject non-images, traversal and malformed URLs');
    const css = await fetch(base + '/theme/src/css/ac/cardpack.css');
    assert.equal(await css.text(), await readFile(new URL('../../millennium/themes/AchievementCollection/src/css/ac/cardpack.css', import.meta.url), 'utf8'));
    for (const file of ['book.js', 'cardview.js', 'model.js', 'profile.js']) {
        const response = await fetch(base + '/theme/src/js/ac/' + file);
        assert.equal(await response.text(), await readFile(new URL('../../millennium/themes/AchievementCollection/src/js/ac/' + file, import.meta.url), 'utf8'));
    }
    passed++;
    console.log('ok preview serves production styles and renderers directly');
} finally {
    await new Promise(resolve => server.close(resolve));
}

const { CARDS, META } = await import('../preview/fixtures.js');
const snapshot = JSON.parse(await readFile(new URL('../preview/client-snapshot.json', import.meta.url), 'utf8'));
const actual = loadMatchingProgress(snapshot);
assert.equal(actual.cards.length, snapshot.cards.length);
assert.deepEqual(CARDS, buildPreviewCards(snapshot.cards, actual.progress));
assert.equal(META.clientSavedAt, snapshot.savedAt);
assert.deepEqual(META, generateFixtures(snapshot).meta);
for (const c of CARDS) assert.equal(c.rare + c.common + c.unrated, c.total, `${c.appid}: counts balance`);
console.log(`ok ${CARDS.length} preview cards exactly match the saved client snapshot`);
passed++;
const fixturesBefore = await readFile(new URL('../preview/fixtures.js', import.meta.url), 'utf8');
const snapshotBefore = await readFile(new URL('../preview/client-snapshot.json', import.meta.url), 'utf8');
const damaged = structuredClone(snapshot);
damaged.cards[0].rare += 1;
assert.throws(() => generateFixtures(damaged), /奖杯统计/);
assert.throws(() => generateFixtures({ ...snapshot, cards: [] }), /无效或空/);
assert.equal(await readFile(new URL('../preview/fixtures.js', import.meta.url), 'utf8'), fixturesBefore);
assert.equal(await readFile(new URL('../preview/client-snapshot.json', import.meta.url), 'utf8'), snapshotBefore);
console.log('ok invalid snapshots cannot overwrite the saved preview');
console.log(`${passed + 1} preview checks passed`);
