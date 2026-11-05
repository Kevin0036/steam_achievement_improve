/**
 * 徽章翻新（DLC 成就集合也打通：蓝徽章 → 蓝紫徽章）的验收：node --test tools/test-badge-upgrade.mjs
 *
 * 画面效果要靠抓帧看，这里测能量化的部分：
 *   · 数字一格格往上涨、只涨不跌、最后落在新数字上；
 *   · 开演前卡槽里还是旧样子，放回去以后是新样子，舞台不留残余；
 *   · 单页四张、重播、减少动态效果、中途销毁都不出错；
 *   · 音效确定、不爆音，每颗光球汇入时都真的有声音。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test, before, after } from 'node:test';
import { createPreviewServer } from './preview-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const THEME = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection');
const load = (file) => import(pathToFileURL(path.join(THEME, 'src/js/ac', file)).href);
const { upgradeOrbCount, upgradeSteps, upgradeTimeline } = await load('upgradefx.js');
const { renderUpgradeSfx } = await load('introsound.js');

let browser;
let server;
let base;

before(async () => {
    server = createPreviewServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ ...(process.env.AC_CHROMIUM ? { executablePath: process.env.AC_CHROMIUM } : { channel: 'msedge' }), headless: true });
});

after(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
});

/* ── 纯函数 ───────────────────────────────────────────────────────────── */

test('光球颗数：跟着新拿到的成就数走，4～16 颗，不知道时 6 颗', () => {
    assert.equal(upgradeOrbCount(1), 4);
    assert.equal(upgradeOrbCount(9), 9);
    assert.equal(upgradeOrbCount(120), 16);
    assert.equal(upgradeOrbCount(NaN), 6);
    assert.equal(upgradeOrbCount(0), 6);
});

test('时间表：汇入越来越密，全部汇入后端详、放回、收尾依次排开', () => {
    for (const n of [1, 4, 9, 16]) {
        const t = upgradeTimeline(n);
        assert.equal(t.arrivals.length, n);
        assert.ok(t.arrivals[0] > t.lift, '卡拿稳了光球才汇进来');
        for (let k = 1; k < n; k += 1) assert.ok(t.arrivals[k] > t.arrivals[k - 1]);
        for (let k = 2; k < n; k += 1) {
            assert.ok(t.arrivals[k] - t.arrivals[k - 1] <= t.arrivals[k - 1] - t.arrivals[k - 2] + 1, '间隔只会越来越短');
        }
        assert.equal(t.completeAt, t.arrivals.at(-1));
        assert.ok(t.completeAt < t.fallAt && t.fallAt < t.landAt && t.landAt < t.end);
        assert.ok(t.end < 7000, `整段 ${t.end}ms，不能拖太久`);
    }
});

test('数字：稀有、普通穿插着涨，只涨不跌，最后一格正好是新数字', () => {
    const cases = [
        [{ rare: 36, common: 23, playtimeMin: 1726 }, { rare: 42, common: 32, playtimeMin: 2098 }],
        [{ rare: 0, common: 10 }, { rare: 2, common: 11 }],
        [{ rare: 5, common: 5 }, { rare: 5, common: 30 }],
        [{ rare: 3, common: 4 }, { rare: 3, common: 4 }],
    ];
    for (const [from, to] of cases) {
        const gain = to.rare - from.rare + to.common - from.common;
        const n = upgradeOrbCount(gain);
        const steps = upgradeSteps(from, to, n);
        assert.equal(steps.length, n);
        let prev = from;
        for (const step of steps) {
            assert.ok(step.rare >= prev.rare && step.common >= prev.common, `不能往回跳：${JSON.stringify(steps)}`);
            if (Number.isFinite(step.playtimeMin)) assert.ok(step.playtimeMin >= (prev.playtimeMin ?? -Infinity));
            prev = step;
        }
        assert.equal(steps.at(-1).rare, to.rare);
        assert.equal(steps.at(-1).common, to.common);
        if (Number.isFinite(to.playtimeMin)) assert.equal(steps.at(-1).playtimeMin, to.playtimeMin);
    }
});

test('音效：确定、不爆音，每颗光球汇入时都有声音', () => {
    const rate = 48000;
    const timeline = upgradeTimeline(12);
    const a = renderUpgradeSfx(rate, timeline);
    const b = renderUpgradeSfx(rate, timeline);
    assert.deepEqual(a, b, '同样的时间表要渲染出同样的声音');
    let peak = 0;
    for (const x of a) {
        assert.ok(Number.isFinite(x));
        peak = Math.max(peak, Math.abs(x));
    }
    assert.ok(peak > 0.2 && peak <= 0.4, `峰值 ${peak}`);
    const rms = (fromMs, toMs) => {
        const i0 = Math.round((fromMs / 1000) * rate);
        const i1 = Math.round((toMs / 1000) * rate);
        let sum = 0;
        for (let i = i0; i < i1; i += 1) sum += a[i] ** 2;
        return Math.sqrt(sum / (i1 - i0));
    };
    for (const at of timeline.arrivals) assert.ok(rms(at, at + 60) > 0.01, `${at}ms 汇入时要有声音`);
    assert.ok(rms(timeline.landAt, timeline.landAt + 120) > 0.05, '放回卡槽要有落定声');
});

/* ── 浏览器里跑正式代码 ───────────────────────────────────────────────── */

async function openBook(query = 'binding=sequential&owner=Player') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/preview/cardpack.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-leaf[data-visible] .ac-card');
    await page.waitForTimeout(400);
    return { page, errors };
}

const leftovers = (page) =>
    page.evaluate(() => ({
        nodes: document.querySelectorAll('.ac-intro, .ac-intro-veil, .ac-intro-burst, .ac-intro-fx, .ac-upgrade__fill').length,
        incoming: document.querySelectorAll('.ac-slot[data-incoming], .ac-slot[data-upgrade]').length,
        intro: document.querySelector('.ac-book').hasAttribute('data-intro'),
        transform: document.querySelector('.ac-book').style.transform,
    }));

/** 翻新后摊开的那张卡：徽章、杯数、时长 */
const shownCard = (page, appid) =>
    page.evaluate((id) => {
        const cards = [...document.querySelectorAll(`.ac-leaf[data-visible] .ac-slot .ac-card[data-appid="${id}"]`)];
        const full = cards.map((card) => card.querySelector('.ac-cf')).find(Boolean);
        if (!full) return null;
        const num = (kind) => full.querySelector(`.ac-cf__stat--${kind} .ac-cf__num`)?.textContent ?? null;
        return {
            sets: full.dataset.sets ?? null, gold: num('gold'), silver: num('silver'), time: num('time'),
            setsDate: full.querySelector('.ac-cf__sets time')?.textContent ?? null,
            rule: full.querySelector('.ac-cf__rule') != null,
        };
    }, appid);

/** 演一次翻新，同时每帧记下替身卡上的金杯 / 银杯数 */
const runUpgrade = (page, slot = null) =>
    page.evaluate(async (at) => {
        const samples = [];
        let running = true;
        const tick = () => {
            const ghost = document.querySelector('.ac-intro .ac-cf');
            if (ghost) {
                const read = (kind) => Number(ghost.querySelector(`.ac-cf__stat--${kind} .ac-cf__num b`)?.textContent);
                const box = ghost.getBoundingClientRect();
                const title = ghost.querySelector('.ac-cf__title').getBoundingClientRect();
                const row = ghost.querySelector('.ac-cf__sets-text');
                samples.push({
                    gold: read('gold'), silver: read('silver'), fill: ghost.querySelector('.ac-upgrade__fill') != null,
                    // 标题相对卡片的位置（按卡高归一）：全程不该变，「全集合」那一行出现时卡面不能跳
                    titleAt: (title.top - box.top) / box.height,
                    setsOpacity: row ? Number(getComputedStyle(row).opacity) : null,
                });
            }
            if (running) requestAnimationFrame(tick);
        };
        tick();
        const card = window.__upgradeCard();
        const before = { gold: card.rare, silver: card.common };
        const startedAt = performance.now();
        await window.__demoUpgrade(at);
        running = false;
        return { appid: card.appid, before, elapsed: performance.now() - startedAt, samples };
    }, slot);

test('翻新：数字一格格涨上去，放回卡槽后是蓝紫徽章和新数字，不留残余', async () => {
    const { page, errors } = await openBook();
    const appid = await page.evaluate(() => window.__upgradeCard().appid);
    const { before, elapsed, samples } = await runUpgrade(page);
    const timeline = upgradeTimeline(upgradeOrbCount(15));
    console.log(`翻新 ${Math.round(elapsed)}ms，抓到 ${samples.length} 帧`);
    assert.ok(elapsed > timeline.end - 200 && elapsed < timeline.end + 2500, `播了 ${elapsed.toFixed(0)}ms`);
    assert.ok(samples.length > 60, '替身卡要真的在台上');
    // 数字只涨不跌，从旧数字一路涨到新数字（预览假装多了 6 金 9 银）
    const golds = samples.map((s) => s.gold).filter(Number.isFinite);
    const silvers = samples.map((s) => s.silver).filter(Number.isFinite);
    assert.equal(golds[0], before.gold);
    assert.equal(silvers[0], before.silver);
    for (let i = 1; i < golds.length; i += 1) assert.ok(golds[i] >= golds[i - 1], '金杯不能往回跳');
    for (let i = 1; i < silvers.length; i += 1) assert.ok(silvers[i] >= silvers[i - 1], '银杯不能往回跳');
    assert.equal(golds.at(-1), before.gold + 6);
    assert.equal(silvers.at(-1), before.silver + 9);
    assert.ok(new Set(golds).size >= 5, '金杯要一格格涨，不是一下跳到头');
    assert.deepEqual(await leftovers(page), { nodes: 0, incoming: 0, intro: false, transform: '' });
    const card = await shownCard(page, appid);
    assert.equal(card?.sets, 'all', '放回去的卡是蓝紫徽章');
    assert.equal(card.gold, `${before.gold + 6}/${before.gold + 6}`);
    assert.equal(card.silver, `${before.silver + 9}/${before.silver + 9}`);
    // 「全集合 日期」顶替了细线；预览假装 DLC 集合是今天打满的
    const now = new Date();
    const today = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
    assert.equal(card.setsDate, today);
    assert.equal(card.rule, false);
    // 这一行从看不见慢慢淡开，只亮不暗；标题全程不动
    const opacities = samples.map((s) => s.setsOpacity).filter(Number.isFinite);
    assert.ok(opacities.length > 30, '替身卡上要有这一行');
    assert.equal(opacities[0], 0);
    assert.ok(opacities.at(-1) > 0.99, `最后要完全显示，实际 ${opacities.at(-1)}`);
    for (let i = 1; i < opacities.length; i += 1) assert.ok(opacities[i] >= opacities[i - 1] - 1e-6, '淡入不能回退');
    assert.ok(opacities.filter((o) => o > 0.05 && o < 0.95).length >= 20, '要慢慢淡开，不是一下出现');
    const titles = samples.map((s) => s.titleAt);
    assert.ok(Math.max(...titles) - Math.min(...titles) < 0.002, `标题跳了 ${((Math.max(...titles) - Math.min(...titles)) * 100).toFixed(2)}%`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('开演前卡槽里还是旧卡：蓝徽章、旧杯数', async () => {
    const { page, errors } = await openBook();
    const appid = await page.evaluate(() => window.__upgradeCard().appid);
    const seen = await page.evaluate(async (id) => {
        window.__demoUpgrade();
        // 翻到那一页之后、拿起来之前（runUpgrade 先停 520ms 让人看清旧徽章）
        await new Promise((resolve) => setTimeout(resolve, 260));
        const full = [...document.querySelectorAll(`.ac-leaf[data-visible] .ac-slot .ac-card[data-appid="${id}"] .ac-cf`)][0];
        return {
            sets: full?.dataset.sets ?? null, gold: full?.querySelector('.ac-cf__stat--gold b')?.textContent ?? null, card: window.__upgradeCard().rare,
            setsRow: full?.querySelector('.ac-cf__sets') != null, rule: full?.querySelector('.ac-cf__rule') != null,
        };
    }, appid);
    assert.equal(seen.sets, null, '还没翻新时是蓝徽章');
    assert.equal(seen.setsRow, false, '还没翻新时没有「全集合」那一行');
    assert.equal(seen.rule, true);
    assert.equal(seen.gold, String(seen.card));
    await page.waitForTimeout(7500);
    assert.deepEqual(errors, []);
    await page.close();
});

test('重播：第二次从蓝徽章重新开始，结束时仍是新数字', async () => {
    const { page, errors } = await openBook();
    const appid = await page.evaluate(() => window.__upgradeCard().appid);
    await runUpgrade(page);
    const { before, samples } = await runUpgrade(page);
    assert.equal(samples.find((s) => Number.isFinite(s.gold))?.gold, before.gold, '重播时从旧数字开始');
    const card = await shownCard(page, appid);
    assert.equal(card?.sets, 'all');
    assert.equal(card.gold, `${before.gold + 6}/${before.gold + 6}`);
    assert.deepEqual(await leftovers(page), { nodes: 0, incoming: 0, intro: false, transform: '' });
    assert.deepEqual(errors, []);
    await page.close();
});

test('单页四张：每个卡槽都能翻新，拿起来时放大到看得清杯数', async () => {
    const { page, errors } = await openBook('binding=sequential&owner=Player&perPage=4');
    const appid = await page.evaluate(() => window.__upgradeCard().appid);
    for (const slot of [0, 3]) {
        const held = page.evaluate(async () => {
            // 抓卡片拿在手里时有多高（相对书）
            let max = 0;
            const bookBox = document.querySelector('.ac-book').getBoundingClientRect();
            const until = performance.now() + 4200;
            while (performance.now() < until) {
                const card = document.querySelector('.ac-intro .ac-card');
                if (card) max = Math.max(max, card.getBoundingClientRect().height / bookBox.height);
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }
            return max;
        });
        await runUpgrade(page, slot);
        const ratio = await held;
        assert.ok(ratio > 0.58, `四卡时拿起来的卡只有书高的 ${(ratio * 100).toFixed(0)}%`);
        const where = await page.evaluate((id) => {
            const card = document.querySelector(`.ac-leaf[data-visible] .ac-slot .ac-card[data-appid="${id}"]`);
            return { slot: card?.closest('.ac-slot')?.dataset.slot ?? null, sets: card?.querySelector('.ac-cf')?.dataset.sets ?? null };
        }, appid);
        assert.equal(where.sets, 'all');
        assert.deepEqual(await leftovers(page), { nodes: 0, incoming: 0, intro: false, transform: '' });
    }
    assert.deepEqual(errors, []);
    await page.close();
});

test('减少动态效果：不演，直接换成蓝紫徽章和新数字', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&owner=Player`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-leaf[data-visible] .ac-card');
    const appid = await page.evaluate(() => window.__upgradeCard().appid);
    const { elapsed, samples, before } = await runUpgrade(page);
    assert.ok(elapsed < 1500, `不该演动画，却等了 ${elapsed.toFixed(0)}ms`);
    assert.equal(samples.length, 0);
    const card = await shownCard(page, appid);
    assert.equal(card?.sets, 'all');
    assert.equal(card.gold, `${before.gold + 6}/${before.gold + 6}`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('翻新中途离开：书销毁时不报错', async () => {
    const { page, errors } = await openBook();
    await page.evaluate(() => {
        window.__demoUpgrade();
        setTimeout(() => window.__book.destroy(), 2600);
    });
    await page.waitForTimeout(3600);
    assert.deepEqual(errors, []);
    await page.close();
});
