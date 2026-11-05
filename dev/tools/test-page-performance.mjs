/** Run the real Page effects with a small React/DOM boundary; no Steam required. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import STR from '../../millennium/themes/AchievementCollection/src/js/ac/strings.js';
import { createCardView, createYearSnapshot, sameYearSnapshot } from '../../millennium/themes/AchievementCollection/src/js/ac/view.js';
import { cardBeforeUpgrade } from '../../millennium/themes/AchievementCollection/src/js/ac/model.js';

const source = readFileSync(new URL('../../millennium/themes/AchievementCollection/src/js/ac/page.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
function harness({ binding = 'newest', running = false, options: extraOptions = {},
    reading = { tabs: true, tree: false, target: 15 }, treeFeature = true, guideDue = false } = {}) {
    let state = { phase: 'ready', cards: [{ appid: 1, name: 'A', completedAt: 2023 }, { appid: 2, name: 'B', completedAt: 2024 }],
        dates: { running, unavailable: new Set() }, intro: { appids: [], ready: false }, upgrade: { changes: [] }, manualRevision: 0, owner: {} };
    let hooks = [], cursor = 0, effects = [], listener, yearReads = 0, sorts = 0, classes = [];
    const books = [], introduced = [], upgraded = [];
    const options = { '卡册装订方式': binding, '年份特殊页': '开启', ...extraOptions };
    const listeners = new Map(), dispatched = [];
    const win = { addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener() {}, dispatchEvent(event) { dispatched.push(event.type); },
        setTimeout() { return 0; }, clearTimeout() {} };
    globalThis.window = win;
    let seenGuide = !guideDue;
    const stubNode = () => ({ append() { this.lastChild = stubNode(); }, setAttribute() {}, addEventListener() {} });
    const host = { ownerDocument: { defaultView: win, createElement: stubNode }, replaceChildren() {}, querySelector() {} };
    const changed = (a, b) => !a || !b || a.length !== b.length || a.some((v, i) => v !== b[i]);
    const React = {
        useState(initial) {
            const i = cursor++;
            if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
            return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }];
        },
        useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
        useMemo(fn, deps) { const i = cursor++; if (!hooks[i] || changed(hooks[i].deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
        useCallback(fn, deps) { return this.useMemo(() => fn, deps); },
        useEffect(fn, deps) { const i = cursor++; if (!hooks[i] || changed(hooks[i].deps, deps)) effects.push(() => { hooks[i]?.cleanup?.(); hooks[i] = { deps, cleanup: fn() }; }); },
        createElement(type, props) { if (props?.className) classes.push(props.className); if (props?.ref && props.className === 'ac-book-host') props.ref.current = host; return {}; },
    };
    const cache = { readPosition: () => null, readYearSelections: () => ({}) };
    const store = { getState: () => state, subscribe(fn) { listener = fn; return () => {}; }, load() {}, loadOwner() {}, pause() {}, ensureAccountScope() {},
        markIntroduced(ids) { introduced.push(...ids); state = { ...state, intro: { ...state.intro, appids: state.intro.appids.filter(id => !ids.includes(id)) } }; listener?.(); },
        markUpgraded(ids) { upgraded.push(...ids); state = { ...state, upgrade: { changes: state.upgrade.changes.filter(c => !ids.includes(c.appid)) } }; listener?.(); } };
    const deps = { getReact: () => React, getReactDom() {}, getThemeOption: (key, fallback) => options[key] ?? fallback,
        isPluginMode: () => false, ensureNodeStyles() {}, store, cache,
        createBook(_host, opts) { const book = { opts, initialCards: opts.cards.slice(), cards: opts.cards.slice(), updates: [], replacements: [], intros: [], page: 0, position: {},
            destroy() { this.destroyed = true; }, updateCard(id, card, options) { this.updates.push({ id, options }); this.cards[this.cards.findIndex(c => c.appid === id)] = card; },
            replaceCards(cards) { this.replacements.push(cards); this.cards = cards.slice(); },
            introduce(cards, ids) { this.cards = cards.slice(); this.intros.push(ids); return new Promise(resolve => { this.completeIntro = resolve; }); },
            upgrades: [],
            upgrade(cards, changes) { this.cards = cards.slice(); this.upgrades.push(changes.map(c => c.appid)); return new Promise(resolve => { this.completeUpgrade = resolve; }); } }; books.push(book); return book; },
        openExportDialog() {}, markOnboardingSeen() { seenGuide = true; }, shouldShowOnboarding: () => !seenGuide, showOnboarding() { return { destroy() {} }; },
        markTreeNoticeSeen() {}, shouldShowTreeNotice: () => false, showTreeNotice() {},
        readReading: () => ({ ...reading }), TREE_FEATURE: treeFeature, openReadingSettings() {},
        yearKeyOf: card => { yearReads++; return card.completedAt; },
        sortCards: cards => { sorts++; return [...cards].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)); },
        createCardView, createYearSnapshot, sameYearSnapshot, cardBeforeUpgrade, tagged: () => ({ log() {} }), STR };
    const Page = new Function(...Object.keys(deps), source + '\nreturn Page;')(...Object.values(deps));
    function render(patch = {}) { state = { ...state, ...patch }; listener?.(); cursor = 0; effects = []; classes = []; Page(); for (const effect of effects) effect(); }
    return { render, books, introduced, upgraded, setOptions: patch => Object.assign(options, patch), get state() { return state; },
        notify: detail => listeners.get('ac:update-notice')?.({ detail }), opens: () => dispatched.filter(type => type === 'ac:update-open').length,
        reads: () => yearReads, sorts: () => sorts, classes: () => classes };
}

test('the fill-in button counts zero recorded playtime as missing', () => {
    const h = harness();
    const cards = (minutes) => [
        { appid: 1, name: 'A', completedAt: 2023, playtimeMin: minutes },
        { appid: 2, name: 'B', completedAt: 2024, playtimeMin: 30 },
    ];
    h.render({ cards: cards(0) });
    assert.ok(h.classes().includes('ac-date-open'), 'Steam 记的 0 分钟卡面上不显示时长，要能手动补');
    h.render({ cards: cards(null) });
    assert.ok(h.classes().includes('ac-date-open'));
    h.render({ cards: cards(12) });
    assert.equal(h.classes().includes('ac-date-open'), false, '日期和时长都齐了就不显示');
});

test('the fill-in button only counts undated cards that are known to be unavailable', () => {
    const h = harness();
    const cards = [
        { appid: 1, name: 'A', completedAt: null, playtimeMin: 40 },
        { appid: 2, name: 'B', completedAt: 2024, playtimeMin: 30 },
    ];
    h.render({ cards });
    assert.equal(h.classes().includes('ac-date-open'), false, '日期还在取的路上，先不打扰');
    h.render({ dates: { ...h.state.dates, unavailable: new Set([1]) } });
    assert.ok(h.classes().includes('ac-date-open'));
    h.render({ cards: [{ ...cards[0], source: 'external' }, cards[1]], dates: { ...h.state.dates, unavailable: new Set([1]) } });
    assert.equal(h.classes().includes('ac-date-open'), false, '别的账号的只读卡不能在这里补');
});

test('update prompt waits for the new-card intro, then opens once', () => {
    const h = harness();
    h.render({ intro: { appids: [2], ready: false } });
    h.notify({ latest: '1.2.2', restart: false, prompt: true });
    h.render();
    assert.equal(h.opens(), 0);
    h.render({ intro: { appids: [], ready: false } });
    assert.equal(h.opens(), 1);
    h.notify({ latest: '1.2.2', restart: false, prompt: false });
    h.render();
    assert.equal(h.opens(), 1);
});

test('update prompt waits for the first-run guide', () => {
    const h = harness({ guideDue: true });
    h.render();
    h.notify({ latest: '1.2.2', restart: false, prompt: true });
    h.render();
    assert.equal(h.opens(), 0);
});

test('a broken book still gets the update prompt, a reminder alone never pops up', () => {
    const broken = harness();
    broken.render({ phase: 'error', cards: [], error: 'x' });
    broken.notify({ latest: '1.2.2', restart: false, prompt: true });
    broken.render();
    assert.equal(broken.opens(), 1);

    const quiet = harness();
    quiet.render();
    quiet.notify({ latest: '1.2.2', restart: false, prompt: false });
    quiet.render();
    assert.equal(quiet.opens(), 0);
});

test('progress-only notifications skip year scans, sorting and card patches', () => {
    const h = harness(); h.render(); const reads = h.reads(), sorts = h.sorts();
    for (let i = 0; i < 30; i++) h.render({ dates: { ...h.state.dates, done: i } });
    assert.equal(h.reads(), reads); assert.equal(h.sorts(), sorts);
    assert.equal(h.books[0].updates.length, 0); assert.equal(h.books[0].replacements.length, 0);
});

test('background dates defer year regrouping and rebuild once on completion', () => {
    const h = harness({ running: true }); h.render();
    h.render({ cards: [{ ...h.state.cards[0], completedAt: 2025 }, h.state.cards[1]] });
    assert.equal(h.books[0].updates[0].options?.deferYearRegroup, true);
    assert.equal(h.books[0].replacements.length, 0);
    h.render({ dates: { ...h.state.dates, running: false } });
    assert.equal(h.books[0].replacements.length, 1);
});

test('manual date and membership changes rebind during background work', () => {
    const h = harness({ running: true }); h.render();
    h.render({ manualRevision: 1, cards: [{ ...h.state.cards[0], completedAt: 2025 }, h.state.cards[1]] });
    assert.deepEqual(h.books[0].replacements.at(-1)?.map(c => c.appid), [1, 2]);
    h.render({ cards: [...h.state.cards, { appid: 3, name: 'C', completedAt: 2026 }] });
    assert.deepEqual(h.books[0].replacements.at(-1)?.map(c => c.appid), [3, 1, 2]);
});

test('manual playtime rebuilds year pages without resorting', () => {
    const h = harness(); h.render();
    const sorts = h.sorts();
    h.render({
        manualRevision: 1,
        cards: [{ ...h.state.cards[0], playtimeMin: 726, playtimeSource: 'manual' }, h.state.cards[1]],
    });
    assert.equal(h.books[0].replacements.length, 1);
    assert.equal(h.sorts(), sorts);
});

test('sequential binding sorts by completion date once dates arrive', () => {
    const h = harness({ binding: 'sequential', running: true });
    h.render({ cards: [{ appid: 1, name: 'A', completedAt: null }, { appid: 2, name: 'B', completedAt: null }] });
    assert.deepEqual(h.books[0].initialCards.map(c => c.appid), [1, 2]);
    h.render({ cards: [{ appid: 1, name: 'A', completedAt: 2024 }, { appid: 2, name: 'B', completedAt: 2023 }] });
    assert.equal(h.books[0].replacements.length, 0, 'frozen while dates are still arriving');
    h.render({ dates: { ...h.state.dates, running: false } });
    assert.deepEqual(h.books[0].replacements.at(-1).map(c => c.appid), [2, 1]);
});

test('metadata patches do not regroup years and sequential manual dates reorder by date', () => {
    const h = harness({ binding: 'sequential', running: true }); h.render();
    h.render({ cards: [{ ...h.state.cards[0], rare: 7 }, h.state.cards[1]] });
    assert.equal(h.books[0].updates.length, 1); assert.equal(h.books[0].replacements.length, 0);
    h.render({ manualRevision: 1, cards: [{ ...h.state.cards[0], completedAt: 2025 }, h.state.cards[1]] });
    assert.deepEqual(h.books[0].replacements.at(-1).map(c => c.appid), [2, 1]);
    h.render({ dates: { ...h.state.dates, running: false } });
    assert.equal(h.books[0].replacements.length, 1);
});

test('new cards remain hidden until ready and introduce only once', async () => {
    const h = harness();
    h.render({ cards: [...h.state.cards, { appid: 3, name: 'New', completedAt: 2026 }], intro: { appids: [3], ready: false } });
    const book = h.books[0];
    assert.deepEqual(book.initialCards.map(c => c.appid), [2, 1]); assert.equal(book.intros.length, 0);
    h.render({ intro: { ...h.state.intro, ready: true } });
    assert.deepEqual(book.intros, [[3]]);
    h.render({ dates: { ...h.state.dates, done: 1 } });
    assert.equal(book.intros.length, 1); assert.equal(book.replacements.length, 0);
    book.completeIntro(true); await Promise.resolve(); h.render();
    assert.deepEqual(h.introduced, [3]); assert.equal(book.intros.length, 1);
});

test('settings rebuild restarts pending intro and rejects the old callback', async () => {
    const h = harness();
    h.render({ cards: [...h.state.cards, { appid: 3, name: 'New', completedAt: 2026 }], intro: { appids: [3], ready: true } });
    const old = h.books[0];
    h.setOptions({ '单页卡片数量': '4' }); h.render();
    const next = h.books[1];
    assert.equal(old.destroyed, true);
    assert.deepEqual(next.initialCards.map(c => c.appid), [2, 1]);
    assert.deepEqual(next.intros, [[3]]);
    old.completeIntro(true); await Promise.resolve();
    assert.deepEqual(h.introduced, []);
    next.completeIntro(true); await Promise.resolve(); h.render();
    assert.deepEqual(h.introduced, [3]);
});

test('with the tree feature off, a saved tree preference no longer reaches the book', () => {
    const reading = { tabs: true, tree: true, target: 15 };
    const h = harness({ reading, treeFeature: false });
    h.render();
    assert.equal(h.books[0].opts.yearPages, true);
    assert.equal(h.books[0].opts.yearTree, false);
});

test('reading settings drive tabs, tree and target and rebuild only on change', () => {
    const reading = { tabs: true, tree: false, target: 15 };
    const h = harness({ reading });
    h.render();
    assert.equal(h.books.length, 1);
    assert.equal(h.books[0].opts.yearIndex, true);
    assert.equal(h.books[0].opts.yearTree, false);
    assert.equal(h.books[0].opts.yearTargets, 15);

    h.render();
    assert.equal(h.books.length, 1, 'unchanged reading settings keep the book');

    reading.tree = true;
    h.render();
    assert.equal(h.books.length, 2);
    assert.equal(h.books[1].opts.yearTree, true);

    reading.target = 30;
    h.render();
    assert.equal(h.books[2].opts.yearTargets, 30);

    reading.tabs = false;
    h.render();
    assert.equal(h.books[3].opts.yearIndex, false);
});

/* ── 徽章翻新（DLC 成就集合也打通了） ───────────────────────────────────── */

const purple = { appid: 2, name: 'B', completedAt: 2024, allSets: true, rare: 8, common: 12, total: 20, playtimeMin: 900 };
const upgradeOf = (from = { rare: 5, common: 7, total: 12, playtimeMin: 600 }) => ({ changes: [{ appid: 2, from }] });

test('a pending upgrade keeps the old blue card in the book until it plays', () => {
    const h = harness();
    h.render({ cards: [h.state.cards[0], purple], upgrade: upgradeOf(), fromCache: true });
    const book = h.books[0];
    const shown = book.initialCards.find(c => c.appid === 2);
    assert.deepEqual([shown.allSets, shown.rare, shown.common, shown.total, shown.playtimeMin], [false, 5, 7, 12, 600], '册子里先摆翻新前的蓝徽章卡');
    assert.equal(book.upgrades.length, 0, '首屏缓存阶段不播，等客户端数据');
    // 稀有数之类逐张补上来时，也不能把蓝紫徽章提前换上去
    h.render({ cards: [h.state.cards[0], { ...purple, rare: 9 }], fromCache: true });
    assert.equal(book.updates.some(u => u.id === 2), false);
});

test('the upgrade plays once after client data, then is marked as seen', async () => {
    const h = harness();
    h.render({ cards: [h.state.cards[0], purple], upgrade: upgradeOf(), fromCache: false });
    const book = h.books[0];
    assert.deepEqual(book.upgrades, [[2]]);
    assert.equal(book.cards.find(c => c.appid === 2).allSets, true, '交给动画的是蓝紫的新卡');
    h.render();
    assert.equal(book.upgrades.length, 1, '播放途中不会重复开播');
    book.completeUpgrade(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(h.upgraded, [2]);
    h.render();
    assert.equal(book.upgrades.length, 1);
});

test('the upgrade waits for the new-card intro', async () => {
    const h = harness();
    const fresh = { appid: 3, name: 'C', completedAt: 2026 };
    h.render({ cards: [h.state.cards[0], purple, fresh], intro: { appids: [3], ready: true }, upgrade: upgradeOf(), fromCache: false });
    const book = h.books[0];
    assert.deepEqual(book.intros, [[3]]);
    assert.equal(book.upgrades.length, 0, '入册动画还在播');
    book.completeIntro(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    h.render();
    assert.deepEqual(book.upgrades, [[2]]);
});

test('update prompt waits for the badge upgrade too', async () => {
    const h = harness();
    h.render({ cards: [h.state.cards[0], purple], upgrade: upgradeOf(), fromCache: false });
    h.notify({ latest: '1.2.3', restart: false, prompt: true });
    h.render();
    assert.equal(h.opens(), 0);
    h.books[0].completeUpgrade(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    h.render();
    assert.equal(h.opens(), 1);
});
