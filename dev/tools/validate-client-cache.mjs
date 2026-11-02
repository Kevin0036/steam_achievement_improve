/** Read-only validation of the theme's cache reader against this Steam library. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steam = path.dirname(workspace);
const modules = path.join(steam, 'millennium/themes/AchievementCollection/src/js/ac');
const { classify, computeRarityCounts, buildArt } = await import(pathToFileURL(path.join(modules, 'model.js')));
const { CARDS } = await import(pathToFileURL(path.join(workspace, 'preview/fixtures.js')));
const user = readdirSync(path.join(steam, 'userdata')).find((id) =>
    id !== '0' && existsSync(path.join(steam, 'userdata', id, 'config/librarycache/achievement_progress.json')),
);
assert.ok(user, 'Steam achievement progress cache exists');
const library = path.join(steam, 'userdata', user, 'config/librarycache');
const progress = JSON.parse(readFileSync(path.join(library, 'achievement_progress.json'), 'utf8'));
const complete = progress.mapCache.filter(([, entry]) => classify(entry) === 'complete');
const readDetails = (appid) => {
    const file = path.join(library, `${appid}.json`);
    return existsSync(file) ? readFileSync(file, 'utf8') : '[]';
};
globalThis.SteamClient = { Apps: { GetCachedAppDetails: async (appid) => readDetails(appid) } };
const { requestCachedAchievements } = await import(pathToFileURL(path.join(modules, 'datasource.js')));

let ratedGames = 0;
let previewMatches = 0;
let previewDifferences = 0;
const totals = { rare: 0, common: 0, unrated: 0 };
for (const [appid, entry] of complete) {
    const pairs = JSON.parse(readDetails(appid));
    const map = pairs.find(([key]) => key === 'achievementmap')?.[1];
    const groups = map?.version === 5 ? JSON.parse(map.data) : [];
    const rows = groups.find(([id]) => Number(id) === Number(appid))?.[1] ?? [];
    const rates = rows.map(([, achievement]) => achievement.flAchieved);
    const expected = { rare: 0, common: 0, unrated: entry.total - rates.length };
    for (const rate of rates) {
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 100) expected.unrated++;
        else if (rate < 10) expected.rare++;
        else expected.common++;
    }
    if (rates.length > entry.total) Object.assign(expected, { rare: 0, common: 0, unrated: entry.total });

    // Exercise both Steam's native cached-details route and the main-window cache route.
    delete globalThis.appDetailsCache;
    const fromNative = await requestCachedAchievements(appid);
    globalThis.appDetailsCache = { GetCachedDataForApp: async () => map?.data };
    const fromWindow = await requestCachedAchievements(appid);
    assert.deepEqual(fromNative, fromWindow, `${appid}: native and main-window cache agree`);
    const actual = computeRarityCounts(fromNative, entry.total) ?? { rare: 0, common: 0, unrated: entry.total };
    assert.deepEqual(actual, expected, `${appid}: exact percentages preserved by cache reader`);
    assert.equal(actual.rare + actual.common + actual.unrated, entry.total, `${appid}: totals balance`);
    if (actual.rare + actual.common > 0) ratedGames++;
    for (const key of Object.keys(totals)) totals[key] += actual[key];

    const preview = CARDS.find((card) => card.appid === appid);
    if (preview?.rare != null && actual.unrated === 0 && preview.total === entry.total) {
        // Preview fixtures are a historical snapshot; global percentages and disk coverage change.
        if (actual.rare === preview.rare) previewMatches++;
        else previewDifferences++;
    }
}
console.log(`ok ${complete.length} completed games: both cache routes agree with the source percentages`);
console.log(`${ratedGames} games have locally cached percentages; comparable preview counts: ${previewMatches} match, ${previewDifferences} differ`);
console.log(`Gold ${totals.rare}; silver ${totals.common}; unknown ${totals.unrated}`);

for (const appid of [3265700, 4488860]) {
    const artRoot = path.join(steam, 'appcache/librarycache', String(appid));
    const findAsset = (filename) => {
        const hash = readdirSync(artRoot).find((dir) => /^[a-f0-9]{40}$/.test(dir) && existsSync(path.join(artRoot, dir, filename)));
        assert.ok(hash, `${appid}: cached ${filename} exists`);
        return `${hash}/${filename}`;
    };
    const assets = { strHeroImage: findAsset('library_hero.jpg'), strHeaderImage: findAsset('library_header.jpg') };
    const art = buildArt(appid, { library_capsule_filename: findAsset('library_capsule.jpg') }, assets);
    for (const role of ['hero', 'header', 'capsule']) {
        const relative = new URL(art[role][0], 'http://steamloopback.host').pathname.slice(`/assets/${appid}/`.length);
        assert.ok(existsSync(path.join(artRoot, relative)), `${appid}: ${role} URL resolves to a real cached file`);
    }
    console.log(`ok ${appid}: front/back/capsule use existing hashed artwork paths`);
}
