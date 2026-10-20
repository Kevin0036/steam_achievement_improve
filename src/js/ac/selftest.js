/**
 * 成就收藏册 · 挂钩点自检
 *
 * 在 CEF 开发者工具里运行：
 *     __acSelfTest()
 * 就会得到一份报告：每个挂钩点是否命中、全局对象实际走的是 `window` 还是
 * `window.opener`、主数据源是否就绪、mapCache 条数与全成就条数、入口命中级别、
 * 以及 model.js 的判定用例。
 *
 * 不引入任何测试框架，不加 package.json，不引入依赖。
 */

import * as data from './datasource.js';
import { REGISTRY, ROUTES, SHOWCASE } from './selectors.js';
import { snapshot as envSnapshot } from './env.js';
import { getMountStatus } from './mount.js';
import { computeCompletedAt, classify, sortCards, availableSortKeys } from './model.js';
import { STR } from './strings.js';
import { tagged } from './utils.js';

const out = tagged('selftest');

/* ── model.js 的判定用例（离线也能跑，见 tools/test-model.mjs） ─────────── */

export const MODEL_CASES = [
    {
        name: '全成就（all_unlocked）',
        input: { total: 36, unlocked: 36, all_unlocked: true },
        expect: 'complete',
    },
    {
        name: '全成就（unlocked >= total）',
        input: { total: 40, unlocked: 40 },
        expect: 'complete',
    },
    {
        name: '未完成',
        input: { total: 67, unlocked: 38, all_unlocked: false },
        expect: 'incomplete',
    },
    {
        name: '铁律 1：total === 0 => 未知，不是未完成',
        input: { total: 0, unlocked: 0, all_unlocked: false },
        expect: 'unknown',
    },
    {
        name: '铁律 1：total 缺失 => 未知',
        input: { unlocked: 5 },
        expect: 'unknown',
    },
    {
        name: '铁律 2：完全没有记录 => 未知',
        input: null,
        expect: 'unknown',
    },
    {
        name: '铁律 2：字段类型不对 => 未知',
        input: { total: '36', unlocked: '36' },
        expect: 'unknown',
    },
    {
        name: '边界：unlocked 缺失但 total 正常 => 未知',
        input: { total: 20 },
        expect: 'unknown',
    },
    {
        name: '边界：unlocked 超过 total => 完成',
        input: { total: 20, unlocked: 21 },
        expect: 'complete',
    },
];

export function runModelCases() {
    return MODEL_CASES.map((testCase) => {
        let actual;
        try {
            actual = classify(testCase.input);
        } catch (err) {
            actual = `抛错：${err?.message ?? err}`;
        }
        return { ...testCase, actual, pass: actual === testCase.expect };
    });
}

/* ── 数据源完成时间的用例 ───────────────────────────────────────────────── */

const NOW = Math.floor(Date.now() / 1000);

export const DATE_CASES = [
    {
        name: '取最后一个成就的解锁时间',
        input: { rgAchievements: [
            { bAchieved: true, rtUnlocked: NOW - 900 },
            { bAchieved: true, rtUnlocked: NOW - 100 },
            { bAchieved: false, rtUnlocked: 0 },
        ] },
        expect: NOW - 100,
    },
    {
        name: '未解锁的成就不参与取最大值',
        input: { rgAchievements: [
            { bAchieved: true, rtUnlocked: NOW - 500 },
            { bAchieved: false, rtUnlocked: NOW },
        ] },
        expect: NOW - 500,
    },
    {
        name: '一个成就都没解锁 => null（不伪造）',
        input: { rgAchievements: [{ bAchieved: false, rtUnlocked: 0 }] },
        expect: null,
    },
    {
        name: '空列表 => null',
        input: { rgAchievements: [] },
        expect: null,
    },
    {
        name: '结构不对 => null',
        input: {},
        expect: null,
    },
    {
        name: '明显未来时间 => null（防时钟错乱）',
        input: { rgAchievements: [{ bAchieved: true, rtUnlocked: NOW + 86400 * 30 }] },
        expect: null,
    },
];

export function runDateCases() {
    return DATE_CASES.map((testCase) => {
        let actual;
        try {
            actual = computeCompletedAt(testCase.input);
        } catch (err) {
            actual = `抛错：${err?.message ?? err}`;
        }
        return { ...testCase, actual, pass: actual === testCase.expect };
    });
}

/* ── 挂钩点探测 ─────────────────────────────────────────────────────────── */

function probeSelectors() {
    return REGISTRY.map((entry) => {
        let hit = false;
        let count = 0;
        try {
            const nodes = document.querySelectorAll(entry.selector);
            count = nodes.length;
            hit = count > 0;
        } catch (err) {
            return { ...entry, hit: false, count: 0, error: err?.message ?? String(err) };
        }
        return { ...entry, hit, count };
    });
}

/* ── 报告 ───────────────────────────────────────────────────────────────── */

export function runSelfTest() {
    const env = envSnapshot();
    const source = data.describeSource();
    const mount = getMountStatus();
    const selectors = probeSelectors();
    const model = runModelCases();
    const dates = runDateCases();

    const report = {
        theme: STR.theme,
        route: ROUTES.cardPack,
        url: (() => {
            try {
                return window.location.href;
            } catch {
                return 'n/a';
            }
        })(),

        globals: env.keys,
        globalsVia: env.hits,
        dataSource: source,
        mount,
        selectors: selectors.map((s) => ({
            key: s.key,
            selector: s.selector,
            feature: s.feature,
            required: s.required,
            hit: s.hit,
            count: s.count,
            error: s.error,
        })),
        model: model.map((c) => ({ case: c.name, expect: c.expect, actual: c.actual, pass: c.pass })),
        dates: dates.map((c) => ({ case: c.name, expect: c.expect, actual: c.actual, pass: c.pass })),
        sortKeys: availableSortKeys([]).length,
        sortCardsSample: sortCards([], 'name').length,
        injectedNodes: document.querySelectorAll('[data-ac]').length,
        showcaseRoots: document.querySelectorAll(SHOWCASE.root).length,
    };

    return report;
}

/** 在控制台里以分组的可读形式打印 */
export function printSelfTest() {
    const report = runSelfTest();

    /* eslint-disable no-console */
    console.group(`%c${STR.selftest.header}`, 'font-weight:700');
    console.log('页面：', report.url);
    console.log('卡包路由：', report.route);

    console.group(STR.selftest.globals);
    for (const [key, info] of Object.entries(report.globals)) {
        console.log(`${info.value ? '✔' : '✘'} ${key}  ${info.value ? `（来自 ${info.via ?? '未知'}）` : '（未找到）'}`);
    }
    console.groupEnd();

    console.group(STR.selftest.dataSource);
    console.log(report.dataSource);
    console.groupEnd();

    console.group(STR.selftest.entry);
    console.log(`命中级别：${report.mount.level}（1=主选 / 2=替换库外壳 / 3=模态入口 / 4=禁用）`);
    console.log(report.mount);
    console.groupEnd();

    console.group(`${STR.selftest.selectors}（当前页面）`);
    for (const s of report.selectors) {
        console.log(`${s.hit ? '✔' : '·'} ${s.key}  x${s.count}  ${s.selector}`);
    }
    console.groupEnd();

    console.group(STR.selftest.model);
    for (const c of report.model) console.log(`${c.pass ? '✔' : '✘'} ${c.case}  → ${c.actual}`);
    console.groupEnd();

    console.group('完成日期');
    for (const c of report.dates) console.log(`${c.pass ? '✔' : '✘'} ${c.case}  → ${c.actual}`);
    console.groupEnd();

    console.log('注入节点数：', report.injectedNodes);
    console.groupEnd();
    /* eslint-enable no-console */

    out.log('自检报告（对象形式）', report);
    return report;
}

export function installSelfTest() {
    try {
        window.__acSelfTest = printSelfTest;
        window.__acSelfTestReport = runSelfTest;
        out.log('已注册 window.__acSelfTest()');
    } catch (err) {
        out.warn('注册自检入口失败', err);
    }
}