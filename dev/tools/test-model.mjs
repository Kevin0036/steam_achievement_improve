/**
 * model.js 的离线断言。
 *
 * 需求文档技术原则第 8 条要求「最小化补充方案」——这里就是那个最小补充：
 * 不引入测试框架、不加 package.json、不引入依赖，一个一次性 Node 脚本跑完。
 *
 * 用法：node tools/test-model.mjs
 *
 * model.js 是纯函数、零 Steam 依赖，所以可以直接被 Node 加载。
 * 但它是 .js（主题里没有 package.json 声明 type），为了让 Node 稳定地按 ESM
 * 解析，这里先复制成 .mjs 再 import。
 */

import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection');
const MODEL_SRC = path.join(THEME, 'src', 'js', 'ac', 'model.js');
const SELFTEST_SRC = path.join(THEME, 'src', 'js', 'ac', 'selftest.js');

const TMP = path.join(HERE, '..', '.tmp');
mkdirSync(TMP, { recursive: true });

// selftest.js 里有依赖 Steam / DOM 的 import，不能整体加载。
// 但它导出的用例表本身是纯数据，所以只把「用例定义」那一段抽出来。
const modelCopy = path.join(TMP, 'model.mjs');
copyFileSync(MODEL_SRC, modelCopy);

const model = await import(`file://${modelCopy.replace(/\\/g, '/')}`);

// 从 selftest.js 里抽出 MODEL_CASES / DATE_CASES 的字面量定义
import { readFileSync } from 'node:fs';

const selftestSrc = readFileSync(SELFTEST_SRC, 'utf8');

function extractCases(name, probe) {
    const start = selftestSrc.indexOf(`export const ${name} = [`);
    if (start < 0) throw new Error(`找不到 ${name}`);
    const end = selftestSrc.indexOf('\n];', start);
    if (end < 0) throw new Error(`找不到 ${name} 的结尾`);
    const literal = selftestSrc.slice(start + `export const ${name} = `.length, end + 2);
    // 用例里用到 NOW，注入后再求值
    const NOW = probe;
    // eslint-disable-next-line no-new-func
    return new Function('NOW', `return ${literal};`)(NOW);
}

const NOW = Math.floor(Date.now() / 1000);
const modelCases = extractCases('MODEL_CASES', NOW);
const dateCases = extractCases('DATE_CASES', NOW);

let failures = 0;

function run(title, cases, fn, pick) {
    console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
    for (const testCase of cases) {
        let actual;
        try {
            actual = fn(testCase.input);
        } catch (err) {
            actual = `抛错: ${err?.message ?? err}`;
        }
        const pass = actual === testCase.expect;
        if (!pass) failures += 1;
        console.log(`${pass ? '  ok  ' : ' FAIL '} ${testCase.name}`);
        if (!pass) {
            console.log(`        期望 ${JSON.stringify(testCase.expect)}  实际 ${JSON.stringify(actual)}`);
        }
    }
}

run('全成就判定 classify()', modelCases, (input) => model.classify(input));

const NOW2 = NOW;
run('完成时间 computeCompletedAt()', dateCases, (input) => model.computeCompletedAt(input));

/* ── 额外的结构性断言（不属于上面两张表） ──────────────────────────────── */

console.log(`\n── 结构性断言 ${'─'.repeat(48)}`);
const extra = [
    [
        '「最近完成」排序在没有日期时不出现在选项里',
        () => model.availableSortKeys([{ completedAt: null }, { completedAt: null }]).includes('completed') === false,
    ],
    [
        '「最近完成」排序在有日期时出现',
        () => model.availableSortKeys([{ completedAt: 1 }]).includes('completed') === true,
    ],
    [
        '排序：没有日期的卡片排到最后（不会被当成很久以前）',
        () => {
            const cards = [
                { name: 'a', completedAt: null },
                { name: 'b', completedAt: 100 },
                { name: 'c', completedAt: 200 },
            ];
            return model.sortCards(cards, 'completed').map((c) => c.name).join('') === 'cba';
        },
    ],
    [
        '收藏编号按 appid 稳定排序',
        () => {
            const map = model.buildCatalogueIndex([300, 100, 200, 100]);
            return map.get(100) === 1 && map.get(200) === 2 && map.get(300) === 3;
        },
    ],
    [
        '美术文件名里的路径穿越会被拒掉（回退到固定文件名）',
        () => {
            const card = model.buildCard({
                appid: 1,
                overview: { display_name: 'x', header_filename: '../../evil.jpg' },
                progress: { total: 5, unlocked: 5, all_unlocked: true },
            });
            return (
                card.art.header[0].includes('/1/header.jpg') &&
                card.art.header.every((url) => !url.includes('evil'))
            );
        },
    ],
    [
        'Steam 哈希目录中的正反面封面可用',
        () => {
            const card = model.buildCard({
                appid: 3265700,
                overview: {
                    display_name: 'Vampire Crawlers',
                    header_filename: '160c9bebc0b3825cc7903ea7d2b3e2c1cdd136c3/library_header.jpg',
                    library_capsule_filename: 'd2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule.jpg',
                },
                libraryAssets: {
                    strHeroImage: 'baf02b93170c9ca0b0e6b28be34b04a77009213d/library_hero.jpg',
                },
                progress: { total: 5, unlocked: 5, all_unlocked: true },
            });
            return (
                card.art.hero[0].includes('/assets/3265700/baf02b93170c9ca0b0e6b28be34b04a77009213d/library_hero.jpg') &&
                card.art.capsule[0].includes('/assets/3265700/d2b2ab54dfdf9304856d25867bb6d659562d6d10/library_capsule.jpg') &&
                card.art.header[0].includes('/assets/3265700/160c9bebc0b3825cc7903ea7d2b3e2c1cdd136c3/library_header.jpg')
            );
        },
    ],
    [
        'Steam 资源哈希只接受安全的相对路径',
        () => {
            const card = model.buildCard({
                appid: 1,
                overview: { display_name: 'x', library_capsule_filename: '../evil.jpg' },
                libraryAssets: { strHeroImage: '../../evil.jpg' },
                progress: { total: 5, unlocked: 5, all_unlocked: true },
            });
            return card.art.hero.every((url) => !url.includes('evil')) && card.art.capsule.every((url) => !url.includes('evil'));
        },
    ],
    [
        'buildCard 不把 cache_time 当作完成日期',
        () => {
            const card = model.buildCard({
                appid: 1,
                overview: { display_name: 'x' },
                progress: { total: 5, unlocked: 5, all_unlocked: true, cache_time: 1727852106 },
            });
            return card.completedAt === null && card.cacheTime === 1727852106;
        },
    ],
    [
        'buildCard 对 total=0 的记录给出 unknown 且 source 为 none',
        () => {
            const card = model.buildCard({ appid: 1, overview: null, progress: { total: 0, unlocked: 0 } });
            return card.state === 'unknown' && card.source === 'none';
        },
    ],
    [
        '稀有度尚未统计时整张卡标记为未统计，而非默认银杯',
        () => {
            const card = model.buildCard({ appid: 1, overview: null, progress: { total: 5, unlocked: 5, all_unlocked: true } });
            return card.rare === null && card.common === null && card.unrated === 5;
        },
    ],
    [
        '全球解锁率边界：9.99% 是金杯，10% 是银杯',
        () => {
            const result = model.computeRarityCounts({ rgAchievements: [{ flAchieved: 9.99 }, { flAchieved: 10 }] });
            return result?.rare === 1 && result.common === 1 && result.unrated === 0;
        },
    ],
    [
        '部分成就缺全球解锁率时保留已知金银杯并单独计未统计',
        () => {
            const result = model.computeRarityCounts({
                rgAchievements: [{ flAchieved: 3 }, { flAchieved: 55 }, { bAchieved: true }],
            });
            return result?.rare === 1 && result.common === 1 && result.unrated === 1;
        },
    ],
    [
        'Steam 列表少于进度总数时，缺失条目计为未统计',
        () => {
            const result = model.computeRarityCounts({ rgAchievements: [{ flAchieved: 3 }, { flAchieved: 55 }] }, 5);
            return result?.rare === 1 && result.common === 1 && result.unrated === 3;
        },
    ],
    [
        '没有概览的游戏：名字先占位并标记 nameMissing',
        () => {
            const card = model.buildCard({ appid: 753640, overview: null, progress: { total: 5, unlocked: 5, all_unlocked: true } });
            return card.nameMissing === true && card.rare === null;
        },
    ],
    [
        '本地缺条时用服务端进度',
        () => {
            const merged = model.mergeProgress(null, { total: 42, unlocked: 42, all_unlocked: true });
            return merged?.total === 42 && merged?.all_unlocked === true;
        },
    ],
    [
        '本地 total=0 时用服务端进度',
        () => {
            const merged = model.mergeProgress({ total: 0, unlocked: 0 }, { total: 42, unlocked: 42, all_unlocked: true });
            return merged?.total === 42 && merged?.unlocked === 42;
        },
    ],
    [
        '本地已全成就时不会被较旧的服务端进度降级',
        () => {
            const merged = model.mergeProgress(
                { total: 42, unlocked: 42, all_unlocked: true, cache_time: 100 },
                { total: 42, unlocked: 41, all_unlocked: false, cache_time: 200 },
            );
            return merged?.all_unlocked === true && merged?.unlocked === 42;
        },
    ],
    [
        '本地进度过期时用服务端的全成就',
        () => {
            const merged = model.mergeProgress(
                { total: 42, unlocked: 37, all_unlocked: false, cache_time: 100 },
                { total: 42, unlocked: 42, all_unlocked: true, cache_time: 200 },
            );
            return merged?.all_unlocked === true;
        },
    ],
    [
        '游戏新增 DLC 成就时以更大的总数作废旧全成就',
        () => {
            const merged = model.mergeProgress(
                { total: 42, unlocked: 42, all_unlocked: true },
                { total: 50, unlocked: 42, all_unlocked: false },
            );
            return merged?.total === 50 && merged?.all_unlocked === false;
        },
    ],
    [
        '数字相同时保留缓存时间更新的那一条',
        () => {
            const merged = model.mergeProgress(
                { total: 42, unlocked: 40, all_unlocked: false, cache_time: 300 },
                { total: 42, unlocked: 40, all_unlocked: false, cache_time: 100 },
            );
            return merged?.cache_time === 300;
        },
    ],
    [
        '服务端残缺 schema：3/3 但完整列表是 45 个只解锁 3 个 → 不算全成就',
        () => model.confirmCompletion(
            { total: 3, unlocked: 3, all_unlocked: true },
            { total: 45, achieved: 3 },
        ) === false,
    ],
    [
        '完整列表确认全部解锁 → 全成就',
        () => model.confirmCompletion(
            { total: 20, unlocked: 20, all_unlocked: true },
            { total: 20, achieved: 20 },
        ) === true,
    ],
    [
        '服务端 133/133 但真实总数 243 → 不算全成就',
        () => model.confirmCompletion(
            { total: 133, unlocked: 133, all_unlocked: true },
            { total: 243, achieved: 133 },
        ) === false,
    ],
    [
        '拿不到完整列表时不能推翻服务端的全成就',
        () => model.confirmCompletion(
            { total: 20, unlocked: 20, all_unlocked: true },
            null,
        ) === true,
    ],
    [
        '未完成的条目无论证据如何都不算全成就',
        () => model.confirmCompletion(
            { total: 20, unlocked: 19, all_unlocked: false },
            { total: 20, achieved: 20 },
        ) === false,
    ],
    [
        '完整列表总数更少（归档成就）但已全部解锁 → 仍算全成就',
        () => model.confirmCompletion(
            { total: 50, unlocked: 50, all_unlocked: true },
            { total: 45, achieved: 45 },
        ) === true,
    ],
    [
        '完整列表说没打满时，服务端的 all_unlocked 不可信',
        () => model.confirmCompletion(
            { total: 16, unlocked: 16, all_unlocked: true },
            { total: 99, achieved: 16 },
        ) === false,
    ],
    [
        '只有总数、没有已解锁数时，完整 schema 更大即证伪',
        () => model.confirmCompletion(
            { total: 3, unlocked: 3, all_unlocked: true },
            { total: 45 },
        ) === false,
    ],
    [
        'completionEvidence 统计完整列表的总数与已解锁数',
        () => {
            const evidence = model.completionEvidence({
                rgAchievements: [{ bAchieved: true }, { bAchieved: false }, { bAchieved: true }],
            });
            return evidence?.total === 3 && evidence?.achieved === 2;
        },
    ],
    [
        'completionEvidence 对空列表返回 null',
        () => model.completionEvidence({ rgAchievements: [] }) === null,
    ],
    [
        '库外收录：完整列表 34/34 → 全成就',
        () => {
            const result = model.verifyExtraCompletion({ personal: { total: 34, achieved: 34 } });
            return result.status === 'complete' && result.total === 34;
        },
    ],
    [
        '库外收录：完整列表 33/34 → 未完成',
        () => model.verifyExtraCompletion({ personal: { total: 34, achieved: 33 } }).status === 'incomplete',
    ],
    [
        '库外收录：服务端 3/3 但官方 schema 45 → 不能收录',
        () => {
            const result = model.verifyExtraCompletion({ officialTotal: 45, service: { total: 3, unlocked: 3, all_unlocked: true } });
            return result.status === 'incomplete' && result.total === 45;
        },
    ],
    [
        '库外收录：服务端 45/45 且官方 schema 45 → 全成就',
        () => model.verifyExtraCompletion({ officialTotal: 45, service: { total: 45, unlocked: 45, all_unlocked: true } }).status === 'complete',
    ],
    [
        '库外收录：游戏加了新成就（35/40）→ 未完成',
        () => model.verifyExtraCompletion({ officialTotal: 40, service: { total: 35, unlocked: 35, all_unlocked: true } }).status === 'incomplete',
    ],
    [
        '库外收录：没有官方 schema 时相信服务端的全成就',
        () => model.verifyExtraCompletion({ service: { total: 20, unlocked: 20, all_unlocked: true } }).status === 'complete',
    ],
    [
        '库外收录：完整列表优先于残缺的服务端数据',
        () => model.verifyExtraCompletion({ personal: { total: 45, achieved: 3 }, service: { total: 3, unlocked: 3, all_unlocked: true } }).status === 'incomplete',
    ],
    [
        '库外收录：没有任何证据 → 无法复核',
        () => model.verifyExtraCompletion({}).status === 'unavailable',
    ],
    [
        '库外收录：没有服务端条目时用收录结论',
        () => {
            const result = model.mergeExtraProgress({ total: 34, unlocked: 34 }, null);
            return result.total === 34 && result.all_unlocked === true && result.source === 'manual-extra';
        },
    ],
    [
        '库外收录：服务端总数更大（加了新成就）时用服务端进度',
        () => {
            const result = model.mergeExtraProgress(
                { total: 34, unlocked: 34 },
                { total: 40, unlocked: 35, all_unlocked: false },
            );
            return result.total === 40 && result.all_unlocked === false && result.source === 'manual-extra';
        },
    ],
    [
        '库外收录：服务端残缺 3/3 不覆盖已核实的 34/34',
        () => model.mergeExtraProgress({ total: 34, unlocked: 34 }, { total: 3, unlocked: 3, all_unlocked: true }).total === 34,
    ],
    [
        '库外收录：服务端 total=0 时用收录结论',
        () => model.mergeExtraProgress({ total: 20, unlocked: 20 }, { total: 0, unlocked: 0 }).all_unlocked === true,
    ],
    [
        '库外收录：服务端总数相同时以核实过的收录结论为准',
        () => model.mergeExtraProgress({ total: 20, unlocked: 20 }, { total: 20, unlocked: 18 }).unlocked === 20,
    ],
];

for (const [name, fn] of extra) {
    let pass = false;
    let detail = '';
    try {
        pass = fn() === true;
    } catch (err) {
        detail = `  (${err?.message ?? err})`;
    }
    if (!pass) failures += 1;
    console.log(`${pass ? '  ok  ' : ' FAIL '} ${name}${detail}`);
}

rmSync(modelCopy, { force: true });

console.log('');
if (failures > 0) {
    console.error(`✘ ${failures} 项失败`);
    process.exit(1);
}
console.log('✔ 全部通过');
