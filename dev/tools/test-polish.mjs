/**
 * v1.2.2 发布前打磨的三处：导出选卡、年份目录分张 / 月份足迹叠放、书签翻阅分档。
 * 跑的是预览页和真实的 book.js / export.js / yearfill.js。
 *
 * 预览服务要先开着：npm run preview
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const BASE = process.env.AC_PREVIEW_URL ?? 'http://127.0.0.1:4173';

let browser;
before(async () => { browser = await chromium.launch({ ...(process.env.AC_CHROMIUM ? { executablePath: process.env.AC_CHROMIUM } : { channel: 'msedge' }), headless: true }); });
after(async () => { await browser?.close(); });

async function open(query) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${BASE}/preview/cardpack.html?binding=sequential&owner=Player&${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-card');
    return { page, errors };
}

/** 预览页按 atYear 定位时会连翻几页：等页码停稳再开始测 */
async function settle(page) {
    let last = null;
    let since = Date.now();
    for (let i = 0; i < 100; i += 1) {
        const now = await page.evaluate(() => window.__book.page);
        if (now !== last) { last = now; since = Date.now(); }
        // 定位时每翻一页都要等图到位，中间可能停一秒多
        if (Date.now() - since > 2000) return;
        await page.waitForTimeout(100);
    }
}

/* ── 导出选卡 ───────────────────────────────────────────────────────────── */

test('导出：默认全选，按年份和搜索挑卡，Esc 只退回选项', async () => {
    const { page, errors } = await open('years=1&fresh=1');
    await page.evaluate(() => window.__export.open());
    await page.click('.ac-export__pick');
    const total = await page.locator('.ac-export__pickrow').count();
    assert.equal(await page.locator('.ac-export__pickrow input:checked').count(), total);

    await page.getByRole('button', { name: '全不选' }).click();
    assert.equal(await page.textContent('.ac-export__picksum'), `已选 0 / ${total} 张`);
    const year = page.locator('.ac-export__year').last();
    await year.click();
    assert.equal(await year.getAttribute('data-state'), 'all');
    const inYear = await page.locator('.ac-export__pickrow input:checked').count();
    assert.ok(inYear > 0 && inYear < total);
    await year.click();
    assert.equal(await page.locator('.ac-export__pickrow input:checked').count(), 0);

    await page.fill('.ac-export__search', 'outer');
    assert.equal(await page.locator('.ac-export__pickrow:not([hidden])').count(), 1);
    // 搜索时的全选只选搜到的那些
    await page.getByRole('button', { name: '全选' }).click();
    await page.fill('.ac-export__search', '');
    assert.equal(await page.locator('.ac-export__pickrow input:checked').count(), 1);

    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.ac-export').count(), 1, 'Esc 不能把整个导出弹窗关掉');
    assert.equal(await page.locator('.ac-export__picker').isHidden(), true);
    assert.equal(await page.textContent('.ac-export__option .ac-export__count'), '1');
    assert.deepEqual(errors, []);
    await page.close();
});

test('导出：一张都没选时不勾成就卡片，也不能只靠它开始导出', async () => {
    const { page } = await open('');
    await page.evaluate(() => window.__export.open());
    for (const type of ['tickets', 'stamps']) {
        const box = page.locator(`.ac-export__check[data-type="${type}"]`);
        if (await box.isEnabled()) await box.uncheck();
    }
    await page.click('.ac-export__pick');
    await page.getByRole('button', { name: '全不选' }).click();
    await page.getByRole('button', { name: '完成' }).click();
    assert.equal(await page.locator('.ac-export__check[data-type="cards"]').isChecked(), false);
    assert.equal(await page.getByRole('button', { name: '开始导出' }).isDisabled(), true);
    await page.close();
});

test('导出：只挑几张时编号仍是册子里的编号，烫金层照常一张', async () => {
    const { page, errors } = await open('');
    const result = await page.evaluate(async () => {
        const cards = window.__book.cards;
        const output = await window.__exportBuild({ cardIds: [cards[2].appid, cards[9].appid], types: { cards: true, tickets: false, stamps: false } });
        return output.files.map((file) => file.path.split('/').pop().split('_')[0]);
    });
    assert.deepEqual(result, ['No.003', 'No.003', 'No.010', 'No.010', '烫金层.png']);
    assert.deepEqual(errors, []);
    await page.close();
});

/* ── 年份目录 / 月份足迹 ────────────────────────────────────────────────── */

test('目录：一年上百款时分张，每一款都点得到，翻张不翻书', async () => {
    const { page, errors } = await open('years=1&fresh=1&atYear=2025&face=index&stress=100');
    await page.waitForFunction(() => document.querySelector('.ac-leaf[data-visible] .ac-yf--index'), null, { timeout: 8000 });
    await settle(page);
    const index = page.locator('.ac-leaf[data-visible] .ac-yf--index');
    const sheets = await index.locator('.ac-yf__list').count();
    const rows = await index.locator('.ac-yf__row').count();
    const sub = await index.locator('.ac-year__sub').textContent();
    assert.equal(rows, Number(/(\d+) 款/.exec(sub)[1]), '目录里的行数要等于这一年的款数');
    assert.equal(sheets, Math.ceil(rows / 28));
    // 沿用 1.2.1 的宽松行距：每一行 4cqh（书高的 4%）
    const rowRatio = await page.evaluate(() => {
        const row = document.querySelector('.ac-leaf[data-visible] .ac-yf__list:not([hidden]) .ac-yf__row');
        return row.getBoundingClientRect().height / document.querySelector('.ac-book').getBoundingClientRect().height;
    });
    assert.ok(Math.abs(rowRatio - 0.04) < 0.002, `行高是书高的 ${(rowRatio * 100).toFixed(2)}%`);
    assert.equal(await index.locator('.ac-yf__list:not([hidden])').count(), 1);

    const before = await page.evaluate(() => window.__book.page);
    await index.locator('.ac-yf__page-btn').last().click();
    assert.match(await index.locator('.ac-yf__page-label').textContent(), /^2 \/ \d+ 张 · 第 29–/);
    assert.equal(await page.evaluate(() => window.__book.page), before, '翻目录不能顺带翻书');
    assert.equal(await index.locator('.ac-yf__page-btn').first().isEnabled(), true);

    // 每一张都放得下：最后一行不出页
    const fits = await page.evaluate(() => {
        const root = document.querySelector('.ac-leaf[data-visible] .ac-yf--index');
        const list = root.querySelector('.ac-yf__list:not([hidden])');
        const pager = root.querySelector('.ac-yf__pager');
        return list.getBoundingClientRect().bottom <= pager.getBoundingClientRect().top + 1
            && pager.getBoundingClientRect().bottom <= root.getBoundingClientRect().bottom;
    });
    assert.ok(fits);

    // 点第二张里的一行，跳到那张卡
    await index.locator('.ac-yf__list:not([hidden]) .ac-yf__row').first().click();
    await page.waitForTimeout(200);
    assert.notEqual(await page.evaluate(() => window.__book.page), before);
    assert.deepEqual(errors, []);
    await page.close();
});

test('目录：款数不多时不分张，也没有翻张按钮', async () => {
    const { page } = await open('years=1&fresh=1&atYear=2025&face=index');
    await page.waitForFunction(() => document.querySelector('.ac-leaf[data-visible] .ac-yf--index'), null, { timeout: 8000 });
    const index = page.locator('.ac-leaf[data-visible] .ac-yf--index');
    assert.equal(await index.locator('.ac-yf__list').count(), 1);
    assert.equal(await index.locator('.ac-yf__pager').count(), 0);
    await page.close();
});

test('月份足迹：格子里最多叠 4 张封面，多的用角标，全都收在格子里', async () => {
    const { page } = await open('years=1&fresh=1&atYear=2025&face=months&stress=100');
    await page.waitForFunction(() => document.querySelector('.ac-leaf[data-visible] .ac-yf--months'), null, { timeout: 8000 });
    // 还在翻向这一年时书页带着透视变换，量出来的位置不准
    await settle(page);
    const cells = await page.evaluate(() => [...document.querySelectorAll('.ac-leaf[data-visible] .ac-yf__month')].map((cell) => {
        const box = cell.getBoundingClientRect();
        const parts = [...cell.querySelectorAll('.ac-yf__thumb, .ac-yf__more')];
        const head = cell.querySelector('.ac-yf__month-head').getBoundingClientRect();
        const count = cell.querySelector('.ac-yf__month-count')?.getBoundingClientRect();
        return {
            count: Number(cell.querySelector('.ac-yf__month-count')?.textContent.replace(/\D/g, '') ?? 0),
            shown: cell.querySelectorAll('.ac-yf__thumb').length,
            more: cell.querySelector('.ac-yf__more')?.textContent ?? null,
            button: cell.tagName === 'BUTTON',
            inside: parts.every((t) => {
                const r = t.getBoundingClientRect();
                return r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5;
            }),
            // 月份名和款数分在格子两头：按钮里的内容没撑满格子时，款数会贴着月份名
            countAtEnd: !count || Math.abs(count.right - head.right) < 1,
            headFull: head.width > box.width * 0.7,
        };
    }));
    assert.ok(cells.some((c) => c.count > 4), '要有放不下的月份才测得到角标');
    for (const cell of cells) {
        assert.equal(cell.button, cell.count > 0, '有游戏的月份才能点开');
        if (cell.count === 0) continue;
        assert.ok(cell.inside, '封面和角标不能挤出格子');
        assert.ok(cell.headFull && cell.countAtEnd, '格子里的内容要撑满格子（Chromium 126 的按钮默认不撑开）');
        assert.equal(cell.shown, Math.min(4, cell.count));
        assert.equal(cell.more, cell.count > 4 ? `+${cell.count - 4}` : null);
    }
    await page.close();
});

test('月份足迹：点开一个月看全部，分张、Esc 收回都不翻书，点一款翻到那张卡', async () => {
    const { page, errors } = await open('years=1&fresh=1&atYear=2025&face=months&stress=100');
    await page.waitForFunction(() => document.querySelector('.ac-leaf[data-visible] .ac-yf--months'), null, { timeout: 8000 });
    await settle(page);
    const start = await page.evaluate(() => window.__book.page);
    const cell = page.locator('.ac-leaf[data-visible] button.ac-yf__month').first();
    const count = Number((await cell.locator('.ac-yf__month-count').textContent()).replace(/\D/g, ''));
    await cell.click();
    const detail = page.locator('.ac-leaf[data-visible] .ac-yf__detail');
    await detail.waitFor();
    assert.equal(await detail.locator('.ac-yf__game').count(), count, '这个月的每一款都要列出来');
    assert.match(await detail.locator('.ac-yf__detail-sub').textContent(), new RegExp(`${count} 款`));
    assert.equal(await detail.locator('.ac-yf__detail-grid:not([hidden]) .ac-yf__game').count(), Math.min(12, count));
    if (count > 12) {
        await detail.locator('.ac-yf__page-btn').last().click();
        assert.match(await detail.locator('.ac-yf__page-label').textContent(), /^2 \/ /);
    }
    // 面板里的空白处点一下不能翻书
    const box = await detail.boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 12);
    assert.equal(await page.evaluate(() => window.__book.page), start);
    assert.equal(await detail.isVisible(), true);

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelector('.ac-leaf[data-visible] .ac-yf__detail').hidden);
    assert.equal(await page.evaluate(() => window.__book.page), start, 'Esc 只收起这个月');

    await cell.click();
    await detail.waitFor();
    await detail.locator('.ac-yf__detail-grid:not([hidden]) .ac-yf__game').first().click();
    await page.waitForTimeout(200);
    assert.notEqual(await page.evaluate(() => window.__book.page), start);
    assert.deepEqual(errors, []);
    await page.close();
});

/* ── 书签翻阅分档 ───────────────────────────────────────────────────────── */

test('书签翻阅：起步保持原样，高速段更快更省，收尾三叶完整，落定后不留残叶', async () => {
    const { page, errors } = await open('at=2');
    const box = await page.evaluate(() => {
        const r = document.querySelector('.ac-book__ribbon').getBoundingClientRect();
        const b = document.querySelector('.ac-book').getBoundingClientRect();
        return { x: r.left + r.width / 2, y: (b.bottom + r.bottom) / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await page.waitForFunction(() => document.querySelectorAll('.ac-riffle__leaf').length >= 16, null, { timeout: 3000 });
    const plan = await page.evaluate(() => [...document.querySelectorAll('.ac-riffle__leaf')].map((leaf) => ({
        lite: leaf.classList.contains('ac-riffle__leaf--lite'),
        fast: leaf.classList.contains('ac-riffle__leaf--fast'),
        duration: leaf.getAnimations().find((a) => a.effect?.getKeyframes?.().some((k) => String(k.transform).includes('rotateY')))?.effect.getTiming().duration ?? null,
    })));
    const n = plan.length;
    assert.equal(plan[0].lite, false, '第一叶完整');
    assert.deepEqual(plan.slice(n - 3).map((p) => p.lite), [false, false, false], '收尾三叶完整');
    assert.ok(plan.some((p) => p.fast), '中段要有高速叶');
    assert.ok(plan.filter((p) => p.fast).every((p) => p.lite), '高速叶都是简化叶');
    assert.equal(plan[1].fast, false, '刚起步的叶还不算高速');
    const durations = plan.map((p) => p.duration);
    assert.equal(durations[0], 560);
    assert.ok(Math.min(...durations) < 450, '中段飞得更快');
    // 一边飞一边看：已经落下又被盖住的叶要藏起来
    let hidden = 0;
    for (let i = 0; i < 40 && (await page.evaluate(() => Boolean(document.querySelector('.ac-riffle')))); i += 1) {
        hidden = Math.max(hidden, await page.evaluate(() => [...document.querySelectorAll('.ac-riffle__leaf')]
            .filter((leaf) => leaf.style.zIndex.startsWith('2') && leaf.style.visibility === 'hidden').length));
        await page.waitForTimeout(60);
    }
    assert.ok(hidden > 0, '落地后被盖住的叶要隐藏');
    await page.waitForSelector('.ac-riffle', { state: 'detached', timeout: 6000 });
    assert.deepEqual(errors, []);
    await page.close();
});

test('取样走后台解码：卡面底色和原来看起来一样', async () => {
    const { page } = await open('');
    const result = await page.evaluate(async () => {
        const { getTone, clearToneCache } = await import('/theme/src/js/ac/tone.js');
        // 底色是低饱和的暗色：近灰的颜色色相会乱跳但看不出来，所以按显示出来的 RGB 比
        const rgb = ({ h, s, l }) => {
            const k = (n) => (n + h / 30) % 12;
            const a = s * Math.min(l, 1 - l);
            return [0, 8, 4].map((n) => 255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
        };
        const realCreate = window.createImageBitmap;
        const gaps = [];
        for (const card of window.__book.cards.filter((c) => c.art?.hero?.length).slice(0, 12)) {
            clearToneCache();
            window.createImageBitmap = realCreate;
            const fast = await getTone(document, card.appid, card.art.hero, 1.25);
            clearToneCache();
            window.createImageBitmap = undefined;
            const slow = await getTone(document, card.appid, card.art.hero, 1.25);
            if (!fast || !slow) continue;
            const [a, b] = [rgb(fast), rgb(slow)];
            gaps.push(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
        }
        window.createImageBitmap = realCreate;
        clearToneCache();
        return gaps;
    });
    assert.ok(result.length >= 8, '取样要能拿到结果');
    assert.ok(Math.max(...result) < 6, `底色差得太多：${result.map((g) => g.toFixed(1)).join(', ')}`);
    await page.close();
});
