/**
 * 翻页手感和入册动画的验收：node --test tools/test-book-motion.mjs
 *
 * 手感没法用眼睛回归，所以测可以量化的部分：
 *   · 滚轮：一格一页、停手后最多再翻一页、很快停稳、反向立刻改向；
 *   · 入册：三档的分档规则、时长、音效的电平和起音、收尾不留残余。
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
const { FIRE, HEAVY_END, HEAVY_LAND_AT, introTierOf, LIGHTNING } = await load('introfx.js');
const { INTRO_LEAD, renderIntroSfx } = await load('introsound.js');

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

async function openBook(query = 'binding=sequential&fresh=1&at=30') {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/preview/cardpack.html?${query}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-leaf[data-visible] .ac-card');
    await page.waitForTimeout(500);
    const box = await page.locator('.ac-book__pages').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    return { page, errors };
}

/** 记录每次页码变化的时刻：滚轮停手之后书还翻了几页、多久才停 */
const recorder = () => {
    const state = { turns: [], wheels: [] };
    window.__motion = state;
    let last = window.__book.page;
    // 在滚轮事件发生的当下记录，排除测试工具本身的延迟
    window.addEventListener('wheel', (event) => {
        state.wheels.push({ at: performance.now(), page: window.__book.page, dy: event.deltaY });
    }, { capture: true, passive: true });
    const tick = () => {
        if (window.__book.page !== last) {
            last = window.__book.page;
            state.turns.push({ page: last, at: performance.now() });
        }
        requestAnimationFrame(tick);
    };
    tick();
};

/* ── 滚轮 ─────────────────────────────────────────────────────────────── */

test('滚一格只翻一页，页码当场更新', async () => {
    const { page, errors } = await openBook();
    await page.evaluate(recorder);
    const before = await page.evaluate(() => window.__book.page);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(800);
    const { turns, wheels, now } = await page.evaluate(() => ({ ...window.__motion, now: window.__book.page }));
    assert.equal(now - before, 1);
    const took = turns[0].at - wheels[0].at;
    assert.ok(took < 120, `页码过了 ${took.toFixed(0)}ms 才更新`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('隔一小会儿滚两格：两格都算数，不会吞掉第二格', async () => {
    const { page, errors } = await openBook();
    const before = await page.evaluate(() => window.__book.page);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(120);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(900);
    assert.equal((await page.evaluate(() => window.__book.page)) - before, 2);
    assert.deepEqual(errors, []);
    await page.close();
});

test('一次大滚动：几页同时在空中，停手后最多再起飞一页', async () => {
    const { page, errors } = await openBook();
    await page.evaluate(recorder);
    let mostInAir = 0;
    for (let i = 0; i < 30; i += 1) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(25);
        mostInAir = Math.max(mostInAir, await page.evaluate(() => document.querySelectorAll('.ac-leaf.is-flying').length));
    }
    const stoppedAt = await page.evaluate(() => performance.now());
    await page.waitForTimeout(1500);
    assert.ok(mostInAir >= 3, `空中最多只有 ${mostInAir} 页，看不到翻页过程`);
    assert.equal(await page.locator('.ac-leaf.is-flying').count(), 0, '书页要全部落定');
    assert.ok((await page.locator('.ac-leaf').count()) <= 8, '落定后不能留着多余的叶');
    const { turns } = await page.evaluate(() => ({ turns: window.__motion.turns }));
    const after = turns.filter((turn) => turn.at > stoppedAt);
    const settled = (turns.at(-1)?.at ?? stoppedAt) - stoppedAt;
    console.log('大滚动', { 共翻: turns.length, 停手后: after.length, 停稳ms: Math.round(settled) });
    assert.ok(turns.length >= 3, '滚动期间应该连续翻页');
    assert.ok(after.length <= 1, `停手后又起飞了 ${after.length} 页`); // 页码是起飞时更新的，最多还欠一页
    assert.ok(settled < 300, `停手后 ${settled.toFixed(0)}ms 页码才停`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('快滚时落点一侧始终垫着书页，不露空洞', async () => {
    const { page, errors } = await openBook();
    await page.evaluate(() => {
        window.__rest = { lowest: Infinity, frames: 0 };
        const watch = () => {
            if (document.querySelector('.ac-leaf.is-flying')) {
                window.__rest.frames += 1;
                const resting = document.querySelectorAll('.ac-leaf[data-turned]:not(.is-flying)').length;
                window.__rest.lowest = Math.min(window.__rest.lowest, resting);
            }
            requestAnimationFrame(watch);
        };
        requestAnimationFrame(watch);
    });
    for (let i = 0; i < 24; i += 1) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(25);
    }
    await page.waitForTimeout(900);
    const { lowest, frames } = await page.evaluate(() => window.__rest);
    assert.ok(frames > 20, `只采到 ${frames} 帧`);
    assert.ok(lowest >= 1, `有 ${lowest} 叶垫底`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('飞过的页来回翻，阴影不会粘在页面上', async () => {
    const { page, errors } = await openBook();
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(700);
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(700);
    const shades = await page.evaluate(() => [...document.querySelectorAll('.ac-leaf__face > .ac-page__shade')].map((node) => Number(getComputedStyle(node).opacity)));
    assert.ok(shades.length > 0);
    assert.ok(shades.every((value) => value === 0), `残留阴影：${Math.max(...shades)}`);
    assert.deepEqual(errors, []);
    await page.close();
});

for (const [name, query] of [['单卡', ''], ['四卡', '&perPage=4']]) {
    test(`书签（${name}）：拉一下很快动起来，等图时册子不被空白页盖住，主线程不长时间卡死`, async () => {
        const { page, errors } = await openBook(`binding=sequential&fresh=1&at=40${query}`);
        await page.evaluate(() => {
            window.__long = [];
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) window.__long.push(Math.round(entry.duration));
            }).observe({ entryTypes: ['longtask'] });
            window.__pull = {};
            document.querySelector('.ac-book__ribbon').addEventListener('pointerup', () => {
                window.__pull.at = performance.now();
                const watch = () => {
                    const stage = document.querySelector('.ac-riffle');
                    if (stage && !window.__pull.hidden) {
                        window.__pull.hidden = getComputedStyle(stage).visibility;
                        // 图早就在缓存里时第一帧就能露面；要保证的是露面时封面和第一叶的图都已经到位
                        const first = [stage.querySelector('.ac-riffle__cover'), stage.querySelector('.ac-riffle__leaf')];
                        window.__pull.ready = first.every((node) => [...(node?.querySelectorAll('img') ?? [])]
                            .every((img) => img.complete && img.naturalWidth > 0));
                    }
                    if (stage && getComputedStyle(stage).visibility === 'visible') {
                        window.__pull.shown = performance.now();
                        return;
                    }
                    requestAnimationFrame(watch);
                };
                watch();
            }, { capture: true });
        });
        const ribbon = await page.locator('.ac-book__ribbon').boundingBox();
        await page.mouse.click(ribbon.x + ribbon.width / 2, ribbon.y + ribbon.height - 6);
        await page.waitForSelector('.ac-riffle', { state: 'attached' });
        await page.waitForSelector('.ac-riffle', { state: 'detached', timeout: 6000 });
        const { pull, long } = await page.evaluate(() => ({ pull: window.__pull, long: window.__long }));
        const lag = pull.shown - pull.at;
        console.log(`书签${name}`, '起翻', `${Math.round(lag)}ms`, '最长任务', Math.max(0, ...long));
        assert.ok(pull.hidden === 'hidden' || pull.ready, '图到位之前不能露面');
        assert.ok(lag < 420, `拉书签后 ${Math.round(lag)}ms 才动`);
        assert.ok(Math.max(0, ...long) < 300, `主线程卡了 ${Math.max(...long)}ms`);
        assert.deepEqual(errors, []);
        await page.close();
    });
}

test('翻页后星星保持正常亮度，不会在等闪烁延迟时亮得刺眼', async () => {
    const { page, errors } = await openBook();
    for (let i = 0; i < 3; i += 1) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(60);
    }
    await page.waitForTimeout(750);
    const { count, brightest } = await page.evaluate(() => {
        const dust = [...document.querySelectorAll('.ac-leaf[data-visible] .ac-cf__spark--dust')];
        return { count: dust.length, brightest: Math.max(...dust.map((node) => Number(getComputedStyle(node).opacity))) };
    });
    assert.ok(count > 0, '要有星点可查');
    assert.ok(brightest <= 0.33, `星点亮到了 ${brightest}`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('滚到书的两端：翻不动时不报错、不留飞行层', async () => {
    const { page, errors } = await openBook('binding=sequential&fresh=1&at=2');
    for (let i = 0; i < 16; i += 1) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(30);
    }
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => window.__book.page), 0);
    assert.equal(await page.locator('.ac-leaf.is-flying').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
});

test('翻完之后页面可以正常点击翻页', async () => {
    const { page, errors } = await openBook();
    await page.mouse.wheel(0, 120);
    await page.waitForTimeout(800);
    const before = await page.evaluate(() => window.__book.page);
    const box = await page.locator('.ac-book__pages').boundingBox();
    await page.mouse.click(box.x + box.width * 0.94, box.y + box.height * 0.97);
    await page.waitForTimeout(1300);
    assert.equal(await page.evaluate(() => window.__book.page), before + 1);
    assert.deepEqual(errors, []);
    await page.close();
});

test('飞行途中销毁册子不报错', async () => {
    const { page, errors } = await openBook();
    await page.mouse.wheel(0, 120);
    await page.evaluate(() => window.__book.destroy());
    await page.waitForTimeout(700);
    assert.deepEqual(errors, []);
    await page.close();
});

test('书签跳转：掠过足够多的页，全程不报错，落点正确', async () => {
    const { page, errors } = await openBook('binding=sequential&fresh=1&at=40');
    // 书签上半截压在书底下，点露在外面的尾巴
    const ribbon = await page.locator('.ac-book__ribbon').boundingBox();
    await page.mouse.click(ribbon.x + ribbon.width / 2, ribbon.y + ribbon.height - 6);
    await page.waitForFunction(() => document.querySelectorAll('.ac-riffle__leaf').length >= 12, null, { timeout: 2500 });
    await page.waitForSelector('.ac-riffle', { state: 'detached', timeout: 6000 });
    const { pageNow, count } = await page.evaluate(() => ({ pageNow: window.__book.page, count: window.__book.pageCount }));
    assert.ok(pageNow === 0 || pageNow === count, `落在第 ${pageNow} 页`);
    assert.deepEqual(errors, []);
    await page.close();
});

test('反向滚动立刻改向，不把欠的页翻完', async () => {
    const { page, errors } = await openBook();
    await page.evaluate(recorder);
    for (let i = 0; i < 8; i += 1) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(25);
    }
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(900);
    const { wheels, now } = await page.evaluate(() => ({ ...window.__motion, now: window.__book.page }));
    const reverse = wheels.find((wheel) => wheel.dy < 0);
    // 页码起飞时就更新了，反向后往回翻一页：不能比反向那一刻更靠前
    const delta = now - reverse.page;
    assert.ok(delta <= 0, `反向后还往前多翻了：${delta}`);
    assert.deepEqual(errors, []);
    await page.close();
});

/* ── 分档 ─────────────────────────────────────────────────────────────── */

test('按游玩时长分三档，时长未知走标准档', () => {
    const tier = (hours) => introTierOf({ playtimeMin: hours * 60 });
    assert.equal(tier(0.5), 'fast');
    assert.equal(tier(14.9), 'fast');
    assert.equal(tier(15), 'standard');
    assert.equal(tier(50), 'standard');
    assert.equal(tier(50.1), 'heavy');
    assert.equal(tier(400), 'heavy');
    for (const card of [{ playtimeMin: null }, { playtimeMin: 0 }, {}, null]) assert.equal(introTierOf(card), 'standard');
});

/* ── 音效 ─────────────────────────────────────────────────────────────── */

test('入册音效：确定、不爆音、音量压得住、不是硬切进来的', () => {
    const rate = 48000;
    const first = renderIntroSfx(rate);
    const second = renderIntroSfx(rate);
    for (const tier of ['lightning', 'fire', 'standard', 'heavy']) {
        const samples = first[tier];
        assert.deepEqual(samples, second[tier], `${tier} 每次渲染应该一致`);
        assert.ok(samples.every(Number.isFinite), `${tier} 不能有 NaN`);
        const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        assert.ok(peak <= 0.4, `${tier} 峰值 ${peak}`);
        assert.ok(Math.abs(samples.at(-1)) < 1e-3, `${tier} 结尾要收干净`);

        // 落点之前有预告：开头是渐入的，且落点前已经有声音，声音不是凭空冒出来的
        const land = Math.round((INTRO_LEAD[tier] / 1000) * rate);
        const rms = (from, to) => Math.sqrt(samples.slice(from, to).reduce((sum, v) => sum + v * v, 0) / (to - from));
        assert.ok(rms(0, 96) < rms(land - 2400, land), `${tier} 开头要比落点前轻`);
        assert.ok(rms(land - 2400, land) > 1e-3, `${tier} 落点前要有预告`);

        // 落点不能一个采样就冲到顶
        const window = samples.slice(land, land + 4).reduce((max, value) => Math.max(max, Math.abs(value)), 0);
        assert.ok(window < peak, `${tier} 落点起音太硬`);
    }
});

/* ── 入册流程 ─────────────────────────────────────────────────────────── */

const INSTRUMENT = () => {
    const state = { contexts: [], starts: [] };
    window.__sound = state;
    const Native = window.AudioContext;
    window.AudioContext = class extends Native {
        constructor(...args) { super(...args); state.contexts.push(this); }
    };
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function patched(when = 0, offset = 0) {
        state.starts.push({ delay: when - this.context.currentTime, offset, seconds: this.buffer?.duration ?? 0 });
        return start.call(this, when, offset);
    };
};

async function runTier(page, tier, style = null) {
    return page.evaluate(async ([name, fast]) => {
        const startedAt = performance.now();
        const card = await window.__demoIntro(name, fast);
        return { name: card?.name, elapsed: performance.now() - startedAt };
    }, [tier, style]);
}

const leftovers = (page) => page.evaluate(() => ({
    nodes: document.querySelectorAll('.ac-intro, .ac-intro-veil, .ac-intro-burst, .ac-intro-sparks, .ac-intro-fx, .ac-intro-scorch').length,
    incoming: document.querySelectorAll('.ac-slot[data-incoming]').length,
    intro: document.querySelector('.ac-book').hasAttribute('data-intro'),
    transform: document.querySelector('.ac-book').style.transform,
}));

for (const [tier, style, min, max] of [
    ['fast', 'lightning', 1500, 2600],
    ['fast', 'fire', 2700, 3900],
    ['standard', null, 2300, 4000],
    ['heavy', null, 4000, 6500],
]) {
    test(`入册「${style ?? tier}」：时长对得上，播完不留残余`, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.addInitScript(INSTRUMENT);
        await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.ac-card');
        await page.mouse.click(8, 8); // 解锁音频，和用户点进卡包一样
        await page.waitForTimeout(400);
        const { name, elapsed } = await runTier(page, tier, style);
        console.log(style ?? tier, name, `${Math.round(elapsed)}ms`);
        assert.ok(name, '要有这一档的卡');
        assert.ok(elapsed > min && elapsed < max, `${tier} 播了 ${elapsed.toFixed(0)}ms`);
        assert.deepEqual(await leftovers(page), { nodes: 0, incoming: 0, intro: false, transform: '' });
        const visible = await page.locator('.ac-leaf[data-visible] .ac-card').allTextContents();
        assert.ok(visible.join(' ').includes(name), `入册后要看得到 ${name}`);
        assert.deepEqual(errors, []);
        await page.close();
    });
}

test('快速通关：卡片垂直落下，不倾斜、不横移', async () => {
    const moments = { lightning: [120, 200, 280], fire: [FIRE.start + 60, FIRE.start + 140, FIRE.start + 220] };
    for (const style of ['lightning', 'fire']) {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1&introSound=0`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.ac-card');
        await page.waitForTimeout(500);
        await page.evaluate((fast) => { window.__demoIntro('fast', fast); }, style);
        await page.waitForSelector('.ac-intro__card', { state: 'attached' });
        // 卡片节点先挂上、动画稍后才加：没等到动画就拨时间，拨了个空
        await page.waitForFunction(() => document.querySelector('.ac-intro__card')?.getAnimations().length > 0);
        const rects = await page.evaluate((times) => {
            const animations = document.getAnimations().filter((anim) => anim.effect?.target?.classList?.contains('ac-intro__card'));
            const card = document.querySelector('.ac-intro__card');
            return times.map((ms) => {
                for (const anim of animations) {
                    anim.pause();
                    anim.currentTime = ms;
                }
                const box = card.getBoundingClientRect();
                return { x: box.left + box.width / 2, y: box.top, ratio: box.height / box.width };
            });
        }, moments[style]);
        const [a, b, c] = rects;
        assert.ok(Math.abs(a.x - c.x) < 1.5, `${style} 横移了 ${Math.abs(a.x - c.x)}px`);
        assert.ok(a.y < b.y && b.y < c.y, `${style} 应该一路往下：${JSON.stringify(rects)}`);
        // 闪电不变形；火焰是卡通风，下落时故意拉长
        if (style === 'lightning') assert.ok(Math.abs(a.ratio - 1.4) < 0.02, `卡片倾斜了：${a.ratio}`);
        else assert.ok(a.ratio > 1.4, `火焰下落时应该被拉长：${a.ratio}`);
        await page.close();
    }
});

test('火焰：两侧火路先烧到位，卡片之后才出现', async () => {
    assert.ok(FIRE.race <= FIRE.start && FIRE.start < FIRE.land && FIRE.land < FIRE.burn && FIRE.burn < FIRE.end);
    const { page, errors } = await openBook('binding=sequential&fresh=1&introSound=0');
    await page.evaluate(() => { window.__demoIntro('fast', 'fire'); });
    await page.waitForSelector('.ac-intro__card', { state: 'attached' });
    // 卡片节点先挂上、动画稍后才加：没等到动画就拨时间，拨了个空
    await page.waitForFunction(() => document.querySelector('.ac-intro__card')?.getAnimations().length > 0);
    const opacity = await page.evaluate((moments) => {
        const card = document.querySelector('.ac-intro__card');
        const animations = document.getAnimations().filter((anim) => anim.effect?.target === card);
        return moments.map((ms) => {
            for (const anim of animations) {
                anim.pause();
                anim.currentTime = ms;
            }
            return Number(getComputedStyle(card).opacity);
        });
    }, [FIRE.race - 20, FIRE.start + 40]);
    assert.equal(opacity[0], 0, '火路烧到之前卡片不能露面');
    assert.equal(opacity[1], 1, '火路到位后卡片要落下');
    assert.deepEqual(errors, []);
    await page.close();
});

test('书签：中段的叶去掉星星高光但保留封面和文字，首尾保持完整', async () => {
    const { page, errors } = await openBook('binding=sequential&fresh=1&at=8&perPage=4');
    const ribbon = await page.locator('.ac-book__ribbon').boundingBox();
    await page.mouse.click(ribbon.x + ribbon.width / 2, ribbon.y + ribbon.height - 6);
    await page.waitForFunction(() => document.querySelectorAll('.ac-riffle__leaf').length >= 9, null, { timeout: 2500 });
    const report = await page.evaluate(() => {
        const leaves = [...document.querySelectorAll('.ac-riffle__leaf')];
        const lite = leaves.filter((leaf) => leaf.classList.contains('ac-riffle__leaf--lite'));
        return {
            firstFull: !leaves[0].classList.contains('ac-riffle__leaf--lite'),
            lite: lite.length,
            heaviest: Math.max(...lite.map((leaf) => leaf.querySelectorAll('*').length)),
            sparks: lite.reduce((sum, leaf) => sum + leaf.querySelectorAll('.ac-cf__spark, .ac-card__glare, .ac-cb__gloss, .ac-card__shadow').length, 0),
            titles: lite.reduce((sum, leaf) => sum + leaf.querySelectorAll('.ac-cf__title, .ac-cf__perfect, .ac-cf__stats').length, 0),
            art: lite.reduce((sum, leaf) => sum + leaf.querySelectorAll('.ac-cf__art, .ac-cb__art').length, 0),
        };
    });
    assert.ok(report.firstFull, '第一叶要和真实页面一致');
    assert.ok(report.lite >= 6, `只有 ${report.lite} 叶去掉了特效`);
    assert.equal(report.sparks, 0, '中段不带星星和高光');
    assert.ok(report.titles > 0, '文字要保留');
    assert.ok(report.art > 0, '封面要保留');
    assert.ok(report.heaviest < 200, `一叶就有 ${report.heaviest} 个节点`);
    await page.waitForSelector('.ac-riffle', { state: 'detached', timeout: 6000 });
    assert.deepEqual(errors, []);
    await page.close();
});

test('入册特效不干扰其他区域：卡槽之外不闪屏、不罩遮罩', async () => {
    for (const style of ['lightning', 'fire']) {
        const { page, errors } = await openBook('binding=sequential&fresh=1&introSound=0');
        await page.evaluate((fast) => {
            window.__watch = { far: 0 };
            window.__demoIntro('fast', fast);
            const rest = document.querySelector('.ac-book').getBoundingClientRect();
            const watch = () => {
                const canvas = document.querySelector('.ac-intro-fx');
                if (canvas) {
                    // 卡槽在右页，左页中央这块画布上不能有任何东西（全屏闪白、遮罩都会落在这里）
                    const box = canvas.getBoundingClientRect();
                    const scale = canvas.width / box.width;
                    const x = (rest.left + rest.width * 0.25 - box.left) * scale;
                    const y = (rest.top + rest.height * 0.5 - box.top) * scale;
                    const { data } = canvas.getContext('2d').getImageData(x, y, 30, 30);
                    for (let i = 3; i < data.length; i += 4) window.__watch.far = Math.max(window.__watch.far, data[i]);
                }
                requestAnimationFrame(watch);
            };
            requestAnimationFrame(watch);
        }, style);
        await page.waitForSelector('.ac-intro-fx', { state: 'attached' });
        await page.waitForSelector('.ac-intro-fx', { state: 'detached', timeout: 6000 });
        const report = await page.evaluate(() => window.__watch);
        assert.equal(report.far, 0, `${style} 影响到了左页`);
        assert.deepEqual(errors, []);
        await page.close();
    }
});

test('快速通关不指定演出时，闪电和火焰轮流播，刷新后接着轮', async () => {
    const { page, errors } = await openBook('binding=sequential&fresh=1&introSound=0');
    const play = () => page.evaluate(async () => {
        const seen = new Set();
        const watch = setInterval(() => {
            if (document.querySelector('.ac-intro-fx')) seen.add(document.querySelector('.ac-intro-scorch') ? 'fire' : 'lightning');
        }, 40);
        const scorched = new MutationObserver(() => { if (document.querySelector('.ac-intro-scorch')) seen.add('fire'); });
        scorched.observe(document.body, { childList: true, subtree: true });
        await window.__demoIntro('fast');
        clearInterval(watch);
        scorched.disconnect();
        return seen.has('fire') ? 'fire' : 'lightning';
    });
    const first = await play();
    const second = await play();
    assert.notEqual(first, second);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-card');
    await page.waitForTimeout(500);
    assert.equal(await play(), first, '刷新后要接着轮');
    assert.deepEqual(errors, []);
    await page.close();
});

test('闪电和火焰的画布真的画出了东西，全程不报错', async () => {
    for (const style of ['lightning', 'fire']) {
        const { page, errors } = await openBook('binding=sequential&fresh=1&introSound=0');
        await page.evaluate((fast) => { window.__demoIntro('fast', fast); }, style);
        await page.waitForSelector('.ac-intro-fx', { state: 'attached' });
        await page.waitForTimeout(700);
        const lit = await page.evaluate(() => {
            const canvas = document.querySelector('.ac-intro-fx');
            const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            let count = 0;
            for (let i = 3; i < data.length; i += 16) if (data[i] > 24) count += 1;
            return count;
        });
        assert.ok(lit > 200, `${style} 画布上只有 ${lit} 个亮点`);
        await page.waitForSelector('.ac-intro-fx', { state: 'detached', timeout: 6000 });
        assert.deepEqual(errors, []);
        await page.close();
    }
});

test('音效的落点对得上动画的落槽', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(INSTRUMENT);
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-card');
    await page.mouse.click(8, 8);
    await page.waitForTimeout(400);
    for (const [tier, style, act, land] of [['fast', 'lightning', 'lightning', LIGHTNING.land], ['fast', 'fire', 'fire', FIRE.land], ['heavy', null, 'heavy', HEAVY_LAND_AT]]) {
        await page.evaluate(() => { window.__sound.starts.length = 0; });
        await runTier(page, tier, style);
        const started = await page.evaluate(() => window.__sound.starts);
        assert.equal(started.length, 1, `${act} 只响一次`);
        // 反推声音落点：开始时刻 + lead - 已跳过的部分，和动画落点相差不超过 150ms
        const soundLand = started[0].delay * 1000 + INTRO_LEAD[act] - started[0].offset * 1000;
        assert.ok(Math.abs(soundLand - land) < 150, `${act} 声音落点 ${soundLand.toFixed(0)} / 动画 ${land}`);
    }
    await page.close();
});

test('厚重档总时长和常量一致', () => {
    assert.ok(HEAVY_END > HEAVY_LAND_AT);
    assert.ok(HEAVY_END >= 5000 && HEAVY_END <= 6000, `${HEAVY_END}`);
});

test('关掉音效后完全不出声', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(INSTRUMENT);
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1&introSound=0`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-card');
    await page.mouse.click(8, 8);
    await page.waitForTimeout(300);
    await runTier(page, 'fast');
    assert.deepEqual(await page.evaluate(() => window.__sound.contexts.length), 0);
    await page.close();
});

test('没有用户手势时：动画照常，音效跳过，之后也不会补响', async () => {
    // page.evaluate 自带用户手势，所以这里让预览页自己定时触发入册，
    // 播完之前不能调用任何 evaluate / waitForSelector
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.addInitScript(INSTRUMENT);
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1&intro=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6500);
    assert.deepEqual(await leftovers(page), { nodes: 0, incoming: 0, intro: false, transform: '' });
    const silent = await page.evaluate(() => ({
        created: window.__sound.contexts.length,
        state: window.__sound.contexts[0]?.state,
        starts: window.__sound.starts.length,
    }));
    assert.equal(silent.created, 1, '入册时应该尝试过出声');
    assert.equal(silent.state, 'suspended');
    assert.equal(silent.starts, 0, '解锁不了就不能排上音效');
    await page.mouse.click(8, 8);
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.__sound.starts.length), 0, '解锁后不能补响');
    assert.deepEqual(errors, []);
    await page.close();
});

test('入册中途离开：书销毁时不报错', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto(`${base}/preview/cardpack.html?binding=sequential&fresh=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.ac-card');
    await page.evaluate(() => {
        window.__demoIntro('fast', 'fire');
        setTimeout(() => window.__book.destroy(), 900);
    });
    await page.waitForTimeout(1800);
    assert.deepEqual(errors, []);
    await page.close();
});
