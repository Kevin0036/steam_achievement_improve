/**
 * 聚光灯引导的回归测试。跑的是预览页和真实的 book.js / onboarding.js，用真实的鼠标滚轮和拖拽。
 *
 * 预览服务要先开着：npm run preview
 * Playwright 的位置用 AC_PLAYWRIGHT_MODULE 指定（同 test-book-motion.mjs）。
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const BASE = process.env.AC_PREVIEW_URL ?? 'http://127.0.0.1:4173';

let browser;

before(async () => {
    browser = await chromium.launch({ ...(process.env.AC_CHROMIUM ? { executablePath: process.env.AC_CHROMIUM } : { channel: 'msedge' }), headless: true });
});

after(async () => {
    await browser?.close();
});

async function openGuide(query = 'binding=sequential', viewport = { width: 1280, height: 800 }, options = {}) {
    const context = await browser.newContext({ viewport, ...options });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${BASE}/preview/cardpack.html?owner=Player&onboard=1&${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-guide__tip');
    await page.waitForTimeout(650);
    return { page, errors };
}

const step = (page) => page.evaluate(() => document.querySelector('.ac-guide__title')?.textContent ?? null);
const count = (page) => page.evaluate(() => document.querySelector('.ac-guide__count')?.textContent ?? null);
const bookPage = (page) => page.evaluate(() => window.__book.page);
const next = (page) => page.click('.ac-guide__next');

async function goToStep(page, title) {
    for (let i = 0; i < 10; i += 1) {
        if ((await step(page)) === title) {
            await page.waitForTimeout(450);
            return;
        }
        await next(page);
        await page.waitForTimeout(60);
    }
    throw new Error(`走不到这一步：${title}`);
}

/** 聚光灯和说明框现在的位置 */
const geometry = (page) => page.evaluate(() => {
    const box = (node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
    };
    return {
        ring: box(document.querySelector('.ac-guide__ring')),
        tip: box(document.querySelector('.ac-guide__tip')),
        view: { width: innerWidth, height: innerHeight },
    };
});

const center = (rect) => ({ x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 });
const hitClass = (page, { x, y }) => page.evaluate(([px, py]) => document.elementFromPoint(px, py)?.className ?? '', [x, y]);

for (const [name, query, viewport] of [
    ['单卡', 'binding=sequential', { width: 1280, height: 800 }],
    ['四卡', 'binding=sequential&perPage=4', { width: 1280, height: 800 }],
    ['最新优先', '', { width: 1280, height: 800 }],
    ['小窗口', 'binding=sequential', { width: 900, height: 560 }],
    ['插件模态大小', 'binding=sequential&perPage=4', { width: 1180, height: 780 }],
]) {
    test(`${name}：每一步都照到东西，说明框不出窗口也不压住目标`, async () => {
        const { page, errors } = await openGuide(query, viewport);
        const seen = [];
        for (let i = 0; i < 10; i += 1) {
            await page.waitForTimeout(480);
            const { ring, tip, view } = await geometry(page);
            const title = await step(page);
            seen.push(title);
            assert.ok(ring.right - ring.left > 12 && ring.bottom - ring.top > 12, `${title} 聚光灯太小`);
            assert.ok(ring.left >= 0 && ring.top >= 0 && ring.right <= view.width && ring.bottom <= view.height, `${title} 聚光灯出窗口`);
            assert.ok(tip.left >= 0 && tip.top >= 0 && tip.right <= view.width && tip.bottom <= view.height, `${title} 说明框出窗口`);
            const overlapX = Math.min(ring.right, tip.right) - Math.max(ring.left, tip.left);
            const overlapY = Math.min(ring.bottom, tip.bottom) - Math.max(ring.top, tip.top);
            assert.ok(overlapX <= 0 || overlapY <= 0, `${title} 说明框压住了目标`);
            if (await page.evaluate(() => document.querySelector('.ac-guide__next').classList.contains('is-finish'))) break;
            await next(page);
        }
        assert.deepEqual(seen, ['收藏卡', '翻页', '书签', '封面取景', '补日期与时长', '设置', '借阅室']);
        assert.deepEqual(errors, []);
        await page.context().close();
    });
}

test('年份索引：聚光灯罩住标签多的那一列标签本身（标签那一列的容器宽度是 0）', async () => {
    const { page, errors } = await openGuide('binding=sequential&years=1&tabs=1&perPage=4&at=70');
    await goToStep(page, '年份索引');
    await page.waitForTimeout(400);
    const { ring, tabs } = await page.evaluate(() => {
        const box = (node) => {
            const rect = node.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        };
        const strips = [...document.querySelectorAll('.ac-book__tabs')]
            .map((strip) => [...strip.querySelectorAll('.ac-book__tab')].filter((tab) => tab.getBoundingClientRect().width > 0).map(box));
        return { ring: box(document.querySelector('.ac-guide__ring')), tabs: strips.sort((a, b) => b.length - a.length)[0] };
    });
    assert.ok(tabs.length >= 2, '要有一列多个标签才测得出来');
    for (const tab of tabs) {
        assert.ok(tab.left >= ring.left && tab.right <= ring.right && tab.top >= ring.top && tab.bottom <= ring.bottom, '每个标签都要在聚光灯里');
    }
    const width = Math.max(...tabs.map((t) => t.right)) - Math.min(...tabs.map((t) => t.left));
    assert.ok(ring.right - ring.left < width + 30, '聚光灯不能比那一列标签宽出一大截');
    assert.deepEqual(errors, []);
    await page.context().close();
});

/** 聚光灯是不是正好照着一个卡槽 */
const ringOnSlot = (page) => page.evaluate(() => {
    const ring = document.querySelector('.ac-guide__ring').getBoundingClientRect();
    return [...document.querySelectorAll('.ac-leaf[data-visible] .ac-slot')].some((slot) => {
        if (!slot.querySelector('.ac-card')) return false;
        const r = slot.getBoundingClientRect();
        return Math.abs(r.left - ring.left - 10) < 3 && Math.abs(r.right - ring.right + 10) < 3;
    });
});

// 扉页那一种和年份页同理（每款都有日期时，扉页右边就是第一年的月份足迹）；预览数据里有一款没日期的排在最前，扉页右边就是卡，测不出来
for (const [name, query, before] of [
    ['停在年份页', 'binding=sequential&years=1&fresh=1&atYear=2025', 'year'],
    ['最新优先停在年份页', 'years=1&fresh=1&atYear=2024', 'year'],
]) {
    test(`${name}时打开引导：先摊开到最近的一页卡，照的是卡不是整本书`, async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(`${BASE}/preview/cardpack.html?owner=Player&${query}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.ac-book');
        await page.waitForTimeout(before ? 3500 : 900);
        const start = await page.evaluate(() => ({
            cards: document.querySelectorAll('.ac-leaf[data-visible] .ac-card').length,
            year: Boolean(document.querySelector('.ac-leaf[data-visible] .ac-year')),
        }));
        assert.equal(start.cards, 0, '开始时这一对开页上要没有卡');
        if (before === 'year') assert.ok(start.year, '要停在年份页上');
        await page.evaluate(() => window.__onboard());
        await page.waitForSelector('.ac-guide__tip');
        await page.waitForTimeout(600);
        assert.equal(await step(page), '收藏卡');
        assert.ok(await ringOnSlot(page), '第一步要照着一张卡');
        await goToStep(page, '封面取景');
        assert.ok(await ringOnSlot(page), '封面取景也要照着一张卡');
        assert.deepEqual(errors, []);
        await context.close();
    });
}

test('只看不碰的步骤挡住聚光灯，能动手的步骤放行', async () => {
    const { page } = await openGuide();
    const first = await geometry(page);
    assert.match(await hitClass(page, center(first.ring)), /ac-guide__shield/);
    await next(page);
    await page.waitForTimeout(450);
    const second = await geometry(page);
    const inside = await hitClass(page, center(second.ring));
    assert.doesNotMatch(inside, /ac-guide/);
    // 聚光灯外面仍然是遮罩
    assert.match(await hitClass(page, { x: 60, y: 400 }), /ac-guide__mask/);
    await page.context().close();
});

test('遮罩上滚轮不翻页，聚光灯里滚一下才翻，翻过去后自动走下一步', async () => {
    const { page, errors } = await openGuide();
    await goToStep(page, '翻页');
    const start = await bookPage(page);
    await page.mouse.move(60, 400);
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(300);
    assert.equal(await bookPage(page), start);
    assert.equal(await step(page), '翻页');

    const { ring } = await geometry(page);
    const { x, y } = center(ring);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => document.querySelector('.ac-guide.is-done'));
    assert.notEqual(await bookPage(page), start);
    assert.equal(await page.textContent('.ac-guide__status'), '就是这样');
    await page.waitForFunction(() => document.querySelector('.ac-guide__title').textContent === '书签');
    assert.equal(await page.evaluate(() => document.querySelector('.ac-guide.is-done')), null);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test('点一下聚光灯里的书页也算翻页', async () => {
    const { page } = await openGuide();
    await goToStep(page, '翻页');
    const start = await bookPage(page);
    const { ring } = await geometry(page);
    await page.mouse.click((ring.left + ring.right) / 2, ring.top + 24);
    await page.waitForFunction(() => document.querySelector('.ac-guide__title').textContent === '书签');
    assert.notEqual(await bookPage(page), start);
    await page.context().close();
});

test('翻到头时照的是还能翻的那一页', async () => {
    const { page } = await openGuide('binding=sequential&at=9999');
    await goToStep(page, '翻页');
    const { ring, view } = await geometry(page);
    assert.ok(center(ring).x < view.width / 2, '已经翻到最后，右页翻不动，要照左页');
    await page.context().close();
});

test('拉书签：快速翻阅落定之后才算完成，书签有下探提示，走了就收回', async () => {
    const { page, errors } = await openGuide();
    await goToStep(page, '书签');
    const nudging = () => page.evaluate(() => document.querySelector('.ac-book__ribbon').hasAttribute('data-guide-nudge'));
    assert.equal(await nudging(), true);
    const { ring } = await geometry(page);
    const { x, y } = center(ring);
    const start = await bookPage(page);
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForSelector('.ac-riffle', { state: 'attached' });
    assert.equal(await page.evaluate(() => document.querySelector('.ac-guide.is-done')), null, '书页还在飞不能算完成');
    await page.waitForFunction(() => document.querySelector('.ac-guide.is-done'), null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => document.querySelector('.ac-riffle')), null);
    assert.notEqual(await bookPage(page), start);
    await page.waitForFunction(() => document.querySelector('.ac-guide__title').textContent === '封面取景');
    assert.equal(await nudging(), false);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test('长按右键进取景：引导让开，Esc 只关编辑器，回来后走下一步', async () => {
    const { page, errors } = await openGuide();
    await goToStep(page, '封面取景');
    const { ring } = await geometry(page);
    const { x, y } = center(ring);
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'right' });
    await page.waitForSelector('.ac-coveredit', { timeout: 3000 });
    await page.mouse.up({ button: 'right' });
    await page.waitForFunction(() => document.querySelector('.ac-guide.is-away'));
    assert.equal(await page.isVisible('.ac-guide__tip'), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.ac-coveredit'));
    assert.notEqual(await page.$('.ac-guide'), null, 'Esc 不能把引导一起关掉');
    await page.waitForFunction(() => document.querySelector('.ac-guide__title').textContent === '补日期与时长', null, { timeout: 4000 });
    assert.equal(await page.isVisible('.ac-guide__tip'), true);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test('试成之后马上点下一步，不会连跳两步', async () => {
    const { page } = await openGuide();
    await goToStep(page, '翻页');
    const { ring } = await geometry(page);
    const { x, y } = center(ring);
    await page.mouse.move(x, y);
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => document.querySelector('.ac-guide.is-done'));
    await next(page);
    assert.equal(await step(page), '书签');
    await page.waitForTimeout(1100);
    assert.equal(await step(page), '书签');
    await page.context().close();
});

test('方向键切换步骤但不翻书，Esc 关闭，跳过和收尾都清干净', async () => {
    const { page, errors } = await openGuide();
    const start = await bookPage(page);
    await page.keyboard.press('ArrowRight');
    assert.equal(await count(page), '2 / 7');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await count(page), '1 / 7');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await count(page), '1 / 7');
    assert.equal(await bookPage(page), start);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ac-guide', { state: 'detached' });
    assert.equal(await page.evaluate(() => document.querySelector('[data-guide-nudge]')), null);

    await page.evaluate(() => window.__onboard());
    await page.click('.ac-guide__skip');
    await page.waitForSelector('.ac-guide', { state: 'detached' });

    await page.evaluate(() => window.__onboard());
    await goToStep(page, '借阅室');
    assert.equal(await page.textContent('.ac-guide__next'), '开始收藏');
    await next(page);
    await page.waitForSelector('.ac-guide', { state: 'detached' });
    assert.deepEqual(errors, []);
    await page.context().close();
});

test('开了书口年份索引时多一步，照的是标签那一列', async () => {
    const { page } = await openGuide('binding=sequential&years=1&tabs=1&fresh=1');
    // 年份索引和月份足迹各多一步
    assert.equal(await count(page), '1 / 9');
    await goToStep(page, '年份索引');
    const { ring } = await geometry(page);
    const tabs = await page.evaluate(() => [...document.querySelectorAll('.ac-book__tab')]
        .filter((tab) => tab.getBoundingClientRect().width > 0)
        .map((tab) => { const r = tab.getBoundingClientRect(); return (r.left + r.right) / 2; }));
    assert.ok(tabs.some((x) => x >= ring.left && x <= ring.right), '聚光灯要盖住标签');
    await page.context().close();
});

for (const [name, binding] of [['顺序入册', 'binding=sequential'], ['最新优先', 'binding=newest']]) {
    test(`月份足迹（${name}）：进入时摊开过去，点开一个月算试成，停一会儿再走下一步`, async () => {
        const { page, errors } = await openGuide(`${binding}&years=1&tabs=1&fresh=1`);
        await goToStep(page, '月份足迹');
        await page.waitForTimeout(300);
        const { ring } = await geometry(page);
        const sheet = await page.evaluate(() => {
            const node = document.querySelector('.ac-leaf[data-visible] .ac-yf--months')?.closest('.ac-page');
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        });
        assert.ok(sheet, '进入这一步要摊开到月份足迹');
        assert.ok(ring.left <= sheet.left && ring.right >= sheet.right && ring.top <= sheet.top && ring.bottom >= sheet.bottom, '聚光灯罩住整页月份足迹');
        assert.ok(ring.right - ring.left < sheet.right - sheet.left + 20, '只照这一页，不照整本书');

        const cell = await page.locator('.ac-leaf[data-visible] button.ac-yf__month[data-peak]').first().boundingBox();
        const at = { x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 };
        assert.doesNotMatch(await hitClass(page, at), /ac-guide/, '月份格子要点得到');
        await page.mouse.click(at.x, at.y);
        await page.waitForTimeout(400);
        assert.equal(await step(page), '月份足迹', '展开后先停一下');
        assert.equal(await page.textContent('.ac-guide__status'), '就是这样');
        assert.equal(await page.locator('.ac-leaf[data-visible] .ac-yf__detail:not([hidden])').count(), 1);
        await page.waitForTimeout(1700);
        assert.equal(await step(page), '补日期与时长');
        assert.deepEqual(errors, []);
        await page.context().close();
    });
}

test('月份足迹：只开年份页不开书口标签时也有这一步；没开年份页就没有', async () => {
    const { page } = await openGuide('binding=sequential&years=1&fresh=1');
    const seen = [];
    for (let i = 0; i < 10; i += 1) {
        seen.push(await step(page));
        if (await page.evaluate(() => document.querySelector('.ac-guide__next').classList.contains('is-finish'))) break;
        await next(page);
        await page.waitForTimeout(80);
    }
    assert.ok(seen.includes('月份足迹') && !seen.includes('年份索引'), seen.join('、'));
    await page.context().close();

    const plain = await openGuide('binding=sequential&fresh=1');
    const titles = [];
    for (let i = 0; i < 10; i += 1) {
        titles.push(await step(plain.page));
        if (await plain.page.evaluate(() => document.querySelector('.ac-guide__next').classList.contains('is-finish'))) break;
        await next(plain.page);
        await plain.page.waitForTimeout(80);
    }
    assert.ok(!titles.includes('月份足迹'), titles.join('、'));
    await plain.page.context().close();
});

test('窗口缩放时聚光灯跟着目标走', async () => {
    const { page } = await openGuide();
    const before = await geometry(page);
    await page.setViewportSize({ width: 1000, height: 640 });
    await page.waitForTimeout(700);
    const after = await geometry(page);
    assert.ok(after.ring.right < before.ring.right, '目标缩小后聚光灯也要跟过去');
    const slot = await page.evaluate(() => {
        const rect = document.querySelector('.ac-leaf[data-visible] .ac-card[data-side="front"]').closest('.ac-slot').getBoundingClientRect();
        return { left: rect.left, right: rect.right };
    });
    assert.ok(Math.abs(after.ring.left + 10 - slot.left) < 2 && Math.abs(after.ring.right - 10 - slot.right) < 2);
    await page.context().close();
});

test('册子不在时不抛错，直接收场', async () => {
    const { page, errors } = await openGuide();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ac-guide', { state: 'detached' });
    const closed = await page.evaluate(async () => {
        const { showOnboarding } = await import('/theme/src/js/ac/onboarding.js');
        const empty = document.createElement('div');
        document.body.append(empty);
        let calls = 0;
        const guide = showOnboarding(empty, { onClose: () => { calls += 1; } });
        guide.destroy();
        empty.remove();
        return calls;
    });
    assert.equal(closed, 1);
    assert.deepEqual(errors, []);
    await page.context().close();
});

test('没有补日期按钮时跳过这一步，引导中途出现或消失也跟着变', async () => {
    const { page, errors } = await openGuide();
    await page.keyboard.press('Escape');
    await page.waitForSelector('.ac-guide', { state: 'detached' });
    const button = await page.evaluateHandle(() => {
        const node = document.querySelector('.ac-date-open');
        node.remove();
        return node;
    });

    // 一开始就没有：6 步，补日期整步跳过
    await page.evaluate(() => window.__onboard());
    assert.equal(await count(page), '1 / 6');
    await goToStep(page, '封面取景');
    assert.equal(await count(page), '4 / 6');
    // 讲到一半按钮出现了（日期刚判定为取不到）：下一步就讲它
    await page.evaluate((node) => document.querySelector('.ac-plugin-settings').before(node), button);
    await next(page);
    assert.equal(await step(page), '补日期与时长');
    assert.equal(await count(page), '5 / 7');
    // 正在讲的时候按钮没了：不对着空处讲，自动走到下一步
    await page.evaluate(() => document.querySelector('.ac-date-open').remove());
    await page.waitForFunction(() => document.querySelector('.ac-guide__title').textContent === '设置');
    assert.equal(await count(page), '5 / 6');
    await page.click('.ac-guide__prev');
    assert.equal(await step(page), '封面取景');
    assert.deepEqual(errors, []);
    await page.context().close();
});

test('看过旧版文字引导的人升级后再看一次，看过新版的不再弹', async () => {
    const { page } = await openGuide();
    const result = await page.evaluate(async () => {
        const { markOnboardingSeen, shouldShowOnboarding } = await import('/theme/src/js/ac/onboarding.js');
        const key = 'ac:v1:onboarding';
        const check = (value) => {
            if (value == null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
            return shouldShowOnboarding();
        };
        const seen = { fresh: check(null), oldGuide: check('1'), junk: check('yes'), newer: check('3') };
        localStorage.removeItem(key);
        markOnboardingSeen();
        seen.afterSeen = shouldShowOnboarding();
        seen.stored = localStorage.getItem(key);
        localStorage.removeItem(key);
        return seen;
    });
    assert.deepEqual(result, { fresh: true, oldGuide: true, junk: true, newer: false, afterSeen: false, stored: '2' });
    await page.context().close();
});

test('减少动态效果时不做过渡和脉冲', async () => {
    const { page } = await openGuide('binding=sequential', { width: 1280, height: 800 }, { reducedMotion: 'reduce' });
    const before = await geometry(page);
    await next(page);
    const moved = await geometry(page);
    assert.notDeepEqual(moved.ring, before.ring, '切步之后聚光灯应该立刻到位');
    const pulse = await page.evaluate(() => getComputedStyle(document.querySelector('.ac-guide__ring'), '::after').animationName);
    assert.equal(pulse, 'none');
    await page.context().close();
});
