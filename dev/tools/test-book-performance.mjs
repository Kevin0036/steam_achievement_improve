/** Real Chromium DOM/CSS regression checks using the production book renderer. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test, before, after } from 'node:test';
import { createPreviewServer } from './preview-server.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.AC_PLAYWRIGHT_MODULE ?? 'C:/Users/Kevin/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
let browser, server, base;
before(async () => {
    server = createPreviewServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });
async function run(fn, reducedMotion = 'reduce', screenshot = null) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion });
    try {
        await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
        await page.goto(`${base}/preview/cardpack.html?years=1&binding=sequential`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('.ac-leaf[data-visible]');
        const result = await page.evaluate(fn);
        if (screenshot) {
            mkdirSync(path.dirname(screenshot), { recursive: true });
            await page.screenshot({ path: screenshot });
        }
        return result;
    } finally { await page.close(); }
}

test('book owns input arrays at create, replacement and introduction boundaries', async () => {
    const result = await run(async () => {
        const { createBook } = await import('/theme/src/js/ac/book.js');
        const { CARDS } = await import('/preview/fixtures.js');
        const host = document.createElement('div'); document.body.append(host);
        const inputs = Object.freeze(CARDS.slice(0, 2));
        const book = createBook(host, { cards: inputs });
        book.updateCard(inputs[0].appid, { ...inputs[0], name: 'changed' });
        const create = inputs[0].name !== 'changed';
        book.replaceCards(inputs);
        book.updateCard(inputs[0].appid, { ...inputs[0], name: 'replaced' });
        const replace = inputs[0].name !== 'replaced';
        await book.introduce(inputs, [inputs[1].appid]);
        book.updateCard(inputs[0].appid, { ...inputs[0], name: 'introduced' });
        const intro = inputs[0].name !== 'introduced';
        book.destroy(); host.remove(); return { create, replace, intro };
    });
    assert.deepEqual(result, { create: true, replace: true, intro: true });
});

test('year regroup can be deferred until the final batched replacement', async () => {
    const result = await run(async () => {
        const { createBook } = await import('/theme/src/js/ac/book.js');
        const { CARDS } = await import('/preview/fixtures.js');
        const host = document.createElement('div'); document.body.append(host);
        let notifications = 0;
        const cards = CARDS.slice(0, 2).map(card => ({ ...card, completedAt: null }));
        const book = createBook(host, { cards, yearPages: true, onPage: () => notifications++ });
        const before = notifications;
        const changed = { ...cards[0], completedAt: 1700000000 };
        book.updateCard(changed.appid, changed, { deferYearRegroup: true });
        const deferred = notifications === before && book.cards[0] === changed;
        book.replaceCards([changed, cards[1]]);
        const rebuilt = notifications === before + 1;
        book.destroy(); host.remove(); return { deferred, rebuilt };
    });
    assert.deepEqual(result, { deferred: true, rebuilt: true });
});

test('hidden leaf sparkles pause and tilt promotion follows visible leaves', async () => {
    const result = await run(async () => {
        const hidden = document.querySelector('.ac-leaf:not([data-visible])');
        const visible = document.querySelector('.ac-leaf[data-visible]');
        const make = leaf => { const node = document.createElement('div'); node.className = 'ac-card'; node.innerHTML = '<div class="ac-card__tilt"><i class="ac-cf__spark"></i></div>'; leaf.append(node); return node; };
        const a = make(hidden), b = make(visible);
        return { hiddenAnimation: getComputedStyle(a.querySelector('i')).animationPlayState,
            hiddenTilt: getComputedStyle(a.firstChild).willChange, visibleTilt: getComputedStyle(b.firstChild).willChange };
    }, 'no-preference');
    assert.equal(result.hiddenAnimation, 'paused');
    assert.equal(result.hiddenTilt, 'auto');
    assert.equal(result.visibleTilt, 'transform');
});

test('normal motion preserves page turns, year spreads, four-card pages and introduction', async () => {
    const result = await run(async () => {
        const { createBook } = await import('/theme/src/js/ac/book.js');
        const { CARDS } = await import('/preview/fixtures.js');
        document.querySelector('#host').style.display = 'none';
        const host = document.createElement('div');
        host.className = 'ac-cardpack'; host.style.height = '100vh'; document.body.append(host);
        const cards = CARDS.slice(0, 9).map(card => ({ ...card, completedAt: 1704067200 }));
        const book = createBook(host, { cards: cards.slice(0, 8), perPage: 4, binding: 'sequential', yearPages: true, yearSpread: true });
        const root = host.querySelector('.ac-book');
        const waitFor = async predicate => {
            const end = performance.now() + 15000;
            while (!predicate()) {
                if (performance.now() > end) throw new Error('normal-motion state did not settle');
                await new Promise(resolve => setTimeout(resolve, 30));
            }
        };
        book.goTo(0);
        const fourCards = host.querySelectorAll('[data-show-front] .ac-leaf__face--front .ac-card').length;
        const firstPage = book.page;
        book.turn(-1);
        const animatedTurn = root.hasAttribute('data-turning');
        await waitFor(() => !root.hasAttribute('data-turning'));
        const movedBack = book.page === firstPage - 1;
        const yearFaces = host.querySelectorAll('[data-show-front] .ac-leaf__face--front .ac-year__page, [data-show-back] .ac-leaf__face--back .ac-year__page').length;
        book.turn(1);
        await waitFor(() => !root.hasAttribute('data-turning'));
        const returned = book.page === firstPage;
        const intro = book.introduce(cards, [cards.at(-1).appid]);
        const animatedIntro = root.hasAttribute('data-intro');
        await waitFor(() => !!host.querySelector('.ac-intro-veil'));
        const introduced = await intro;
        const cleanedUp = !root.hasAttribute('data-intro') && !host.querySelector('.ac-slot[data-incoming], .ac-intro-veil, .ac-intro-sparks');
        const retained = book.cards.length === cards.length;
        book.goTo(0);
        return { fourCards, animatedTurn, movedBack, yearFaces, returned, animatedIntro, introduced, cleanedUp, retained };
    }, 'no-preference', '.tmp/performance-validation/book-normal-motion.png');
    assert.deepEqual(result, { fourCards: 4, animatedTurn: true, movedBack: true, yearFaces: 2, returned: true, animatedIntro: true, introduced: true, cleanedUp: true, retained: true });
});
