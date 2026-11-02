/**
 * 用本机真实数据校验 model.js 的判定口径。
 *
 * 数据来源（只读，不修改任何文件）：
 *   userdata/<id>/config/librarycache/achievement_progress.json
 *   —— 这就是客户端里 window.appAchievementProgressCache 的磁盘镜像，
 *      结构是 { nVersion: 3, mapCache: [[appid, {...}], ...] }。
 *
 * 用法：node tools/validate-real-data.mjs
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STEAM = path.join(HERE, '..', '..');
const THEME = path.join(STEAM, 'millennium', 'themes', 'AchievementCollection');
const MODEL_SRC = path.join(THEME, 'src', 'js', 'ac', 'model.js');

const TMP = path.join(HERE, '..', '.tmp');
mkdirSync(TMP, { recursive: true });
const modelCopy = path.join(TMP, 'model-validate.mjs');
copyFileSync(MODEL_SRC, modelCopy);
const model = await import(`file://${modelCopy.replace(/\\/g, '/')}`);

/* ── 找 userdata 目录 ───────────────────────────────────────────────────── */

const userdataRoot = path.join(STEAM, 'userdata');
const candidates = readdirSync(userdataRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name) && d.name !== '0')
    .map((d) => path.join(userdataRoot, d.name))
    .filter((dir) => existsSync(path.join(dir, 'config', 'librarycache', 'achievement_progress.json')));

if (candidates.length === 0) {
    console.error('✘ 找不到 achievement_progress.json');
    process.exit(1);
}

const cachePath = path.join(candidates[0], 'config', 'librarycache', 'achievement_progress.json');
console.log(`数据文件：${cachePath}`);

const raw = JSON.parse(readFileSync(cachePath, 'utf8'));

if (raw.nVersion !== 3) {
    console.error(`✘ nVersion = ${raw.nVersion}，与客户端期望的 3 不符`);
    process.exit(1);
}

const entries = new Map(raw.mapCache);

/* ── 逐条跑 classify() ──────────────────────────────────────────────────── */

const buckets = { complete: 0, incomplete: 0, unknown: 0, malformed: 0 };
const zeroTotal = [];
const completeSample = [];
const bucketsByMissingTotal = new Map();

for (const [appid, entry] of entries) {
    if (!entry || typeof entry !== 'object') {
        buckets.malformed += 1;
        continue;
    }
    const state = model.classify(entry);
    buckets[state] += 1;

    if (entry.total === 0) zeroTotal.push(appid);
    if (state === 'complete') completeSample.push({ appid, entry });
}

console.log('');
console.log('── 按 model.js 的口径分类 ──────────────────────────');
console.log(`  记录总数        ${entries.size}`);
console.log(`  complete        ${buckets.complete}`);
console.log(`  incomplete      ${buckets.incomplete}`);
console.log(`  unknown         ${buckets.unknown}`);
console.log(`  结构异常        ${buckets.malformed}`);
console.log(`  total === 0     ${zeroTotal.length}`);

/* ── 与实现计划的勘察数字对照 ───────────────────────────────────────────── */

console.log('');
console.log('── 与实现计划勘察结果的对照 ────────────────────────');

let failures = 0;
const check = (label, actual, expected) => {
    const pass = actual === expected;
    if (!pass) failures += 1;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${label}：实际 ${actual}，计划里是 ${expected}`);
};

check('记录总数', entries.size, 513);
check('全成就条数', buckets.complete, 77);
check('total === 0 条数', zeroTotal.length, 103);

/* ── 关键不变量：没有任何 total === 0 的记录被判成 incomplete ───────────── */

console.log('');
console.log('── 不变量检查 ──────────────────────────────────────');

const zeroMisjudged = [...entries.values()].filter(
    (e) => e && e.total === 0 && model.classify(e) === 'incomplete',
);
const zeroJudgedUnknown = [...entries.values()].filter(
    (e) => e && e.total === 0 && model.classify(e) === 'unknown',
);

const inv1 = zeroMisjudged.length === 0;
const inv2 = zeroJudgedUnknown.length === zeroTotal.length;
if (!inv1) failures += 1;
if (!inv2) failures += 1;
console.log(`${inv1 ? '  ok  ' : ' FAIL '} total===0 的记录里，被判成 incomplete 的有 ${zeroMisjudged.length} 条（必须为 0）`);
console.log(`${inv2 ? '  ok  ' : ' FAIL '} total===0 的记录全部落到 unknown：${zeroJudgedUnknown.length} / ${zeroTotal.length}`);

// 所有 complete 都真的满足 all_unlocked 或 unlocked>=total
const bogusComplete = completeSample.filter(
    (s) => !(s.entry.all_unlocked === true || (Number.isFinite(s.entry.unlocked) && s.entry.unlocked >= s.entry.total)),
);
const inv3 = bogusComplete.length === 0;
if (!inv3) failures += 1;
console.log(`${inv3 ? '  ok  ' : ' FAIL '} complete 的判定依据都成立（all_unlocked 或 unlocked>=total）：异常 ${bogusComplete.length} 条`);

// 没有 total > 0 却既不是 complete 也不是 incomplete 的
const oddOnes = [...entries.values()].filter((e) => {
    if (!e || !Number.isFinite(e.total) || e.total <= 0) return false;
    const st = model.classify(e);
    return st !== 'complete' && st !== 'incomplete';
});
const inv4 = oddOnes.length === 0;
if (!inv4) failures += 1;
console.log(`${inv4 ? '  ok  ' : ' FAIL '} 没有 total>0 却落到 unknown 的记录：异常 ${oddOnes.length} 条`);

/* ── 完成日期：用 userdata 侧的 librarycache 做一次抽样比对 ─────────────── */

console.log('');
console.log('── 完成日期抽样（对照 userdata 侧的 vecHighlight 最大解锁时间） ──────');

const libCacheDir = path.join(candidates[0], 'config', 'librarycache');
let compared = 0;
let matched = 0;
const samples = completeSample.slice(0, 40);

for (const { appid } of samples) {
    const file = path.join(libCacheDir, `${appid}.json`);
    if (!existsSync(file)) continue;

    let highlight;
    try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        const achievements = parsed.find?.((pair) => pair?.[0] === 'achievements')?.[1];
        highlight = achievements?.data?.vecHighlight;
    } catch {
        continue;
    }
    if (!Array.isArray(highlight) || highlight.length === 0) continue;

    // vecHighlight 是「按解锁时间倒序的最近若干条」，所以它的第一条就是已知的最新解锁时间。
    // 这是我们所持数据的**下界**：真正最后一个成就的时间只会不早于它。
    const newest = Math.max(...highlight.map((a) => (Number.isFinite(a?.rtUnlocked) ? a.rtUnlocked : 0)));
    if (newest <= 0) continue;

    compared += 1;
    // 因为 vecHighlight 被截断（上限 12 条），我们只能断言「API 给出的完成时间 >= 这个下界」
    // —— 这里没有 API 数据可对照，所以只报告下界本身，不做断言。
    if (compared <= 5) {
        console.log(`  · ${appid}  已知最新解锁时间下界 = ${new Date(newest * 1000).toISOString().slice(0, 10)}`);
    }
    matched += 1;
}

console.log(`  抽样了 ${compared} 个全成就游戏，全部有本地解锁时间记录`);
console.log('  （vecHighlight 上限 12 条，只能作为下界参考；真实完成日期由');
console.log('   SteamClient.Apps.GetMyAchievementsForApp 在运行时取得，见 datasource.js）');

rmSync(modelCopy, { force: true });

console.log('');
if (failures > 0) {
    console.error(`✘ ${failures} 项对照失败`);
    process.exit(1);
}
console.log('✔ 真实数据校验通过');