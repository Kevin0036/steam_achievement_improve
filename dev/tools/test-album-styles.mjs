/**
 * 册子风格与年份跨页前后两页的验收：node --test tools/test-album-styles.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test, before, after } from 'node:test';
import { createPreviewServer } from './preview-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const THEME = new URL('../../millennium/themes/AchievementCollection/', import.meta.url);
const BASE = 'binding=sequential&years=1&tabs=1&fresh=1';

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

async function open(query, ready) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/preview/cardpack.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector(ready);
    return { page, errors };
}

const titleFrame = (page) =>
    page.evaluate(() => getComputedStyle(document.querySelector('.ac-page--title .ac-page__paper'), '::before').content);

test('款式表、设置默认值和 CSS 对得上；没选中的三款已移除', () => {
    const css = readFileSync(new URL('src/css/ac/albumstyles.css', THEME), 'utf8');
    const reading = readFileSync(new URL('src/js/ac/reading.js', THEME), 'utf8');
    const settings = readFileSync(new URL('plugin/src/settings.js', THEME), 'utf8');
    const listed = [...reading.matchAll(/\{ id: '(\w+)', name:/g)].map((match) => match[1]);
    assert.deepEqual(listed, ['grid', 'dots', 'astral', 'velvet']);
    assert.match(settings, /ALBUM_IDS = \['grid', 'dots', 'astral', 'velvet'\]/);
    for (const id of listed.slice(1)) assert.ok(css.includes(`[data-album="${id}"]`), `缺 ${id}`);
    for (const id of ['stockbook', 'kraft', 'ivory']) assert.ok(!css.includes(`[data-album="${id}"]`), `${id} 应该已移除`);
});

test('构建列表包含新样式', () => {
    const build = readFileSync(new URL('./build-plugin.mjs', import.meta.url), 'utf8');
    for (const file of ['roomsound.css', 'yearfill.css', 'albumframes.css', 'albumstyles.css']) assert.ok(build.includes(`'${file}'`), file);
});

test('四款册子的扉页都没有实线方框', async () => {
    const { page, errors } = await open(BASE, '.ac-page--title');
    assert.equal(await titleFrame(page), 'none', '原版');
    for (const album of ['dots', 'astral', 'velvet']) {
        await page.evaluate((id) => { document.getElementById('host').dataset.album = id; }, album);
        assert.equal(await titleFrame(page), 'none', album);
    }
    assert.deepEqual(errors, []);
    await page.close();
});

test('开启年份特殊页就是四页：月份足迹、年份页、年度最爱、本年目录，没有树也没有空白页', async () => {
    const { page, errors } = await open(`${BASE}&atYear=2026&face=months`, '.ac-leaf[data-visible] .ac-yf--months');
    assert.equal(await page.locator('.ac-tree').count(), 0);
    assert.equal(await page.locator('.ac-page--blank').count(), 0);
    assert.equal(await page.locator('.ac-leaf[data-visible] .ac-yf--months .ac-year__sub').count(), 0, '月份足迹不再有副标题');
    assert.equal(await page.locator('.ac-leaf[data-visible] .ac-yf__month').count(), 12);
    assert.deepEqual(errors, []);
    await page.close();
});

test('最新优先的册子也用新页面，翻页不报错', async () => {
    const { page, errors } = await open('binding=newest&years=1&tabs=1&fresh=1&atYear=2026', '.ac-leaf');
    await page.waitForTimeout(1500);
    assert.ok((await page.locator('.ac-yf--months').count()) + (await page.locator('.ac-yf--index').count()) > 0);
    assert.equal(await page.locator('.ac-page--blank').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
});

test('年度之树的代码还在：?tree=1 能走到保留的旧路径', async () => {
    const { page, errors } = await open(`${BASE}&tree=1&atYear=2026&face=tree`, '.ac-leaf[data-visible] .ac-tree');
    assert.equal(await page.locator('.ac-yf').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
});

test('阅读设置：四款可选、没有树的开关，选中后写进本机设置', async () => {
    const { page, errors } = await open(`${BASE}&settings=1`, '.ac-set__chip');
    await page.waitForSelector('.ac-set__chip');
    assert.deepEqual(await page.locator('.ac-set__chip').allTextContents(), ['方格黑卡', '墨点手账', '月相星图', '绿绒牌桌']);
    assert.equal(await page.locator('.ac-set__range').count(), 0, '年度目标滑块应该收起');
    assert.equal(await page.getByText('年度之树').count(), 0);
    await page.locator('.ac-set__chip[data-album-id="astral"]').click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('ac:v1:reading')).album), 'astral');
    assert.equal(await page.locator('.ac-set__chip[aria-pressed="true"]').count(), 1);
    await page.locator('.ac-set__chip[data-album-id="grid"]').click();
    assert.deepEqual(errors, []);
    await page.close();
});

/* ── 点击翻页 ─────────────────────────────────────────────────────────── */

/** 点书页的外边距：这里没有任何控件，只验证「页面本身」能翻 */
async function clickMargin(page, side) {
    const box = await page.locator('.ac-book__pages').boundingBox();
    const x = box.x + box.width * (side === 'left' ? 0.06 : 0.94);
    const y = box.y + box.height * 0.97;
    const before = await page.evaluate(() => window.__book.page);
    await page.mouse.click(x, y);
    await page.waitForTimeout(1300);
    return (await page.evaluate(() => window.__book.page)) - before;
}

test('年份跨页：点左右页都能翻，方向和滚轮一致', async () => {
    const { page, errors } = await open(`${BASE}&atYear=2026`, '.ac-leaf[data-visible] .ac-year');
    await page.waitForTimeout(2600);
    assert.equal(await clickMargin(page, 'right'), 1, '点右页向后翻');
    assert.equal(await page.locator('.ac-leaf[data-visible] .ac-yf--index').count(), 1, '翻到本年目录');
    assert.equal(await clickMargin(page, 'left'), -1, '点左页翻回来');
    assert.equal(await clickMargin(page, 'left'), -1, '再往前是月份足迹那一页');
    assert.equal(await page.locator('.ac-leaf[data-visible] .ac-yf--months').count(), 1);
    assert.equal(await clickMargin(page, 'right'), 1, '月份足迹也能点');
    assert.deepEqual(errors, []);
    await page.close();
});

test('最新优先的册子方向相反，和点卡片一致', async () => {
    const { page, errors } = await open('binding=newest&fresh=1&at=5', '.ac-card');
    await page.waitForTimeout(800);
    assert.equal(await clickMargin(page, 'left'), 1);
    assert.equal(await clickMargin(page, 'right'), -1);
    assert.deepEqual(errors, []);
    await page.close();
});

test('控件照常响应，不会顺带翻页', async () => {
    const { page, errors } = await open(`${BASE}&atYear=2026`, '.ac-leaf[data-visible] .ac-year__mount');
    await page.waitForTimeout(2600);
    const before = await page.evaluate(() => window.__book.page);
    await page.locator('.ac-leaf[data-visible] .ac-year__mount').first().click();
    await page.waitForSelector('.ac-year-picker');
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => window.__book.page), before, '换徽章时不翻页');
    assert.deepEqual(errors, []);
    await page.close();
});

test('只读册：邮票不能换，点上去就是翻页', async () => {
    const { page, errors } = await open(`${BASE}&readOnly=1&atYear=2026`, '.ac-leaf[data-visible] .ac-year__mount');
    await page.waitForTimeout(2600);
    const before = await page.evaluate(() => window.__book.page);
    const stamp = await page.locator('.ac-leaf[data-visible] .ac-year__mount').first().boundingBox();
    await page.mouse.click(stamp.x + stamp.width / 2, stamp.y + stamp.height / 2);
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.__book.page), before - 1, '年份页在左页，向前翻');
    assert.equal(await page.locator('.ac-year-picker').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
});

test('设置项已移除：源码里不再读取「年份页左右展开」', () => {
    for (const file of ['src/js/ac/page.js', 'src/js/ac/share.js', 'src/js/ac/readingpanel.js', 'plugin/src/panel.js', 'plugin/src/settings.js']) {
        assert.ok(!readFileSync(new URL(file, THEME), 'utf8').includes('年份页左右展开'), file);
    }
});

test('分享快照仍带 yearSpread：线上服务器的校验要求这个字段', () => {
    const share = readFileSync(new URL('src/js/ac/share.js', THEME), 'utf8');
    assert.match(share, /yearSpread: yearPages,/);
    const server = readFileSync(new URL('../share-server/snapshot.js', import.meta.url), 'utf8');
    assert.match(server, /typeof raw\.yearSpread !== 'boolean'/);
});

/* ── 四张卡的边框装饰 ─────────────────────────────────────────────────── */

async function readFrame(page, album) {
    await page.evaluate((id) => {
        const host = document.getElementById('host');
        if (id === 'grid') delete host.dataset.album;
        else host.dataset.album = id;
    }, album);
    return page.evaluate(() => {
        const face = document.querySelector('.ac-leaf[data-visible] .ac-slot').closest('.ac-leaf__face');
        const paper = face.querySelector('.ac-page__paper');
        const style = getComputedStyle(paper, '::before');
        const base = paper.getBoundingClientRect();
        const frame = {
            left: base.left + parseFloat(style.left),
            top: base.top + parseFloat(style.top),
            right: base.left + parseFloat(style.left) + parseFloat(style.width),
            bottom: base.top + parseFloat(style.top) + parseFloat(style.height),
        };
        const nodes = [...face.querySelectorAll('.ac-slot')];
        const slots = nodes.map((slot) => slot.getBoundingClientRect());
        return {
            image: style.backgroundImage,
            frame,
            page: { left: base.left, top: base.top, right: base.right, bottom: base.bottom },
            cards: {
                left: Math.min(...slots.map((s) => s.left)),
                top: Math.min(...slots.map((s) => s.top)),
                right: Math.max(...slots.map((s) => s.right)),
                bottom: Math.max(...slots.map((s) => s.bottom)),
            },
            // 卡位不再单独画框，整页边框是唯一的装饰
            slotFrame: getComputedStyle(nodes[0], '::before').content,
            folioTop: face.querySelector('.ac-page__folio')?.getBoundingClientRect().top,
            // 翻过去的页面是镜像的，卡位左右顺序会反过来，所以按实际位置算缝
            gapX: slots.length < 4 ? null : Math.max(slots[0].left, slots[1].left) - Math.min(slots[0].right, slots[1].right),
            gapY: slots.length < 4 ? null : Math.max(slots[0].top, slots[2].top) - Math.min(slots[0].bottom, slots[2].bottom),
        };
    });
}

function assertFrame(result, label) {
    assert.match(result.image, /^url\("data:image\/svg/, label);
    assert.equal(result.slotFrame, 'none', `${label} 卡位不再单独画框`);
    for (const side of ['left', 'top']) assert.ok(result.frame[side] < result.cards[side] - 10, `${label} 框要包住卡片`);
    for (const side of ['right', 'bottom']) assert.ok(result.frame[side] > result.cards[side] + 10, `${label} 框要包住卡片`);
    assert.ok(result.frame.left > result.page.left && result.frame.right < result.page.right, `${label} 框超出了页面`);
    assert.ok(result.frame.top > result.page.top && result.frame.bottom < result.page.bottom, `${label} 框超出了页面`);
    assert.ok(result.frame.bottom <= result.folioTop, `${label} 框碰到了页码`);
}

test('四张卡共用整页边框：框住整组卡片、留在页面内、不碰页码，四款各不相同', async () => {
    const { page, errors } = await open('binding=sequential&perPage=4&fresh=1&at=9', '.ac-slot[data-slot="3"]');
    const frames = new Set();
    for (const album of ['grid', 'dots', 'astral', 'velvet']) {
        const result = await readFrame(page, album);
        assertFrame(result, `四卡 ${album}`);
        frames.add(result.image);
        assert.ok(result.gapX > 5 && Math.abs(result.gapX - result.gapY) < result.gapY, `${album} 横竖间距差太多：${result.gapX} / ${result.gapY}`);
    }
    assert.equal(frames.size, 4);
    assert.deepEqual(errors, []);
    await page.close();
});

test('单卡用同一张边框：单卡和四卡的装饰是统一的', async () => {
    const four = await open('binding=sequential&perPage=4&fresh=1&at=9', '.ac-slot[data-slot="3"]');
    const one = await open('binding=sequential&fresh=1&at=5', '.ac-slot');
    for (const album of ['grid', 'dots', 'astral', 'velvet']) {
        const single = await readFrame(one.page, album);
        assertFrame(single, `单卡 ${album}`);
        assert.equal(single.image, (await readFrame(four.page, album)).image, `${album} 两种版式用同一张图`);
    }
    assert.deepEqual([...one.errors, ...four.errors], []);
    await one.page.close();
    await four.page.close();
});

test('绿绒牌桌：卡片不再各带一圈黄铜', async () => {
    for (const query of ['binding=sequential&fresh=1&at=5&album=velvet', 'binding=sequential&perPage=4&fresh=1&at=9&album=velvet']) {
        const { page } = await open(query, '.ac-slot');
        const shadow = await page.evaluate(() =>
            getComputedStyle(document.querySelector('.ac-leaf[data-visible] .ac-slot'), '::after').boxShadow);
        assert.ok(!shadow.includes('180, 147, 90'), shadow);
        await page.close();
    }
});

test('整页边框不出现在年份页、月份足迹、目录和扉页', async () => {
    const { page, errors } = await open(`binding=sequential&years=1&perPage=4&fresh=1&atYear=2026`, '.ac-leaf[data-visible] .ac-year');
    await page.waitForTimeout(1500);
    const leaked = await page.evaluate(() =>
        [...document.querySelectorAll('.ac-page:not(.ac-page--cards):not(.ac-page--end) .ac-page__paper')]
            .filter((paper) => getComputedStyle(paper, '::before').backgroundImage !== 'none').length);
    assert.equal(leaked, 0);
    assert.deepEqual(errors, []);
    await page.close();
});

test('丝绒的四张卡：每张卡不再单独带黄铜圈', async () => {
    const { page, errors } = await open('binding=sequential&perPage=4&fresh=1&at=9&album=velvet', '.ac-slot[data-slot="3"]');
    const shadow = await page.evaluate(() =>
        getComputedStyle(document.querySelector('.ac-leaf[data-visible] .ac-slot[data-slot="0"]'), '::after').boxShadow);
    assert.ok(!shadow.includes('180, 147, 90'), shadow);
    await page.evaluate(() => { document.getElementById('host').dataset.album = ''; delete document.getElementById('host').dataset.album; });
    assert.deepEqual(errors, []);
    await page.close();
});

test('风格挑选页只有四款', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${base}/preview/album-styles.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.style');
    assert.deepEqual(await page.locator('.style b').allTextContents(), ['方格黑卡', '墨点手账', '月相星图', '绿绒牌桌']);
    await page.close();
});
