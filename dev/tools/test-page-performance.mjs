/** Run the real Page effects with a small React/DOM boundary; no Steam required. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import STR from '../../millennium/themes/AchievementCollection/src/js/ac/strings.js';
import { createCardView, createYearSnapshot, sameYearSnapshot } from '../../millennium/themes/AchievementCollection/src/js/ac/view.js';

const source = readFileSync(new URL('../../millennium/themes/AchievementCollection/src/js/ac/page.js', import.meta.url), 'utf8')
    .replace(/^import [\s\S]*?;\r?$/gm, '').replace(/^export /gm, '');
function harness({ binding = 'newest', running = false, history = [1, 2], options: extraOptions = {},
    reading = { tabs: true, tree: false, target: 15 }, treeFeature = true } = {}) {
    let state = { phase: 'ready', cards: [{ appid: 1, name: 'A', completedAt: 2023 }, { appid: 2, name: 'B', completedAt: 2024 }],
        dates: { running, unavailable: new Set() }, intro: { appids: [], ready: false }, manualRevision: 0, owner: {} };
    let hooks = [], cursor = 0, effects = [], listener, yearReads = 0, sorts = 0, historyReads = 0;
    const books = [], introduced = [];
    const options = { '卡册装订方式': binding, '年份特殊页': '开启', ...extraOptions };
    const win = { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    globalThis.window = win;
    const host = { ownerDocument: { defaultView: win }, replaceChildren() {}, querySelector() {} };
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
        createElement(type, props) { if (props?.ref && props.className === 'ac-book-host') props.ref.current = host; return {}; },
    };
    const writes = [];
    const cache = { readPosition: () => null, readOrder: () => { historyReads++; return history; }, writeOrder(ids) { writes.push(ids); }, readYearSelections: () => ({}) };
    const store = { getState: () => state, subscribe(fn) { listener = fn; return () => {}; }, load() {}, loadOwner() {}, pause() {}, ensureAccountScope() {},
        markIntroduced(ids) { introduced.push(...ids); state = { ...state, intro: { ...state.intro, appids: state.intro.appids.filter(id => !ids.includes(id)) } }; listener?.(); } };
    const deps = { getReact: () => React, getReactDom() {}, getThemeOption: (key, fallback) => options[key] ?? fallback,
        isPluginMode: () => false, ensureNodeStyles() {}, store, cache,
        createBook(_host, opts) { const book = { opts, initialCards: opts.cards.slice(), cards: opts.cards.slice(), updates: [], replacements: [], intros: [], page: 0, position: {},
            destroy() { this.destroyed = true; }, updateCard(id, card, options) { this.updates.push({ id, options }); this.cards[this.cards.findIndex(c => c.appid === id)] = card; },
            replaceCards(cards) { this.replacements.push(cards); this.cards = cards.slice(); },
            introduce(cards, ids) { this.cards = cards.slice(); this.intros.push(ids); return new Promise(resolve => { this.completeIntro = resolve; }); } }; books.push(book); return book; },
        openExportDialog() {}, markOnboardingSeen() {}, shouldShowOnboarding: () => false, showOnboarding() {},
        markTreeNoticeSeen() {}, shouldShowTreeNotice: () => false, showTreeNotice() {},
        readReading: () => ({ ...reading }), TREE_FEATURE: treeFeature, openReadingSettings() {},
        yearKeyOf: card => { yearReads++; return card.completedAt; },
        sortCards: cards => { sorts++; return [...cards].sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)); },
        createCardView, createYearSnapshot, sameYearSnapshot, tagged: () => ({ log() {} }), STR };
    const Page = new Function(...Object.keys(deps), source + '\nreturn Page;')(...Object.values(deps));
    function render(patch = {}) { state = { ...state, ...patch }; listener?.(); cursor = 0; effects = []; Page(); for (const effect of effects) effect(); }
    return { render, books, introduced, setOptions: patch => Object.assign(options, patch), get state() { return state; },
        reads: () => yearReads, sorts: () => sorts, historyReads: () => historyReads, writes: () => writes };
}

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

test('sequential binding self-heals legacy appid order once dates arrive', () => {
    const h = harness({ binding: 'sequential', history: [], running: true });
    h.render({ cards: [{ appid: 1, name: 'A', completedAt: null }, { appid: 2, name: 'B', completedAt: null }] });
    assert.deepEqual(h.books[0].initialCards.map(c => c.appid), [1, 2]);
    assert.deepEqual(h.writes(), []);
    h.render({ cards: [{ appid: 1, name: 'A', completedAt: 2024 }, { appid: 2, name: 'B', completedAt: 2023 }] });
    assert.equal(h.books[0].replacements.length, 0, 'frozen while dates are still arriving');
    h.render({ dates: { ...h.state.dates, running: false } });
    assert.deepEqual(h.books[0].replacements.at(-1).map(c => c.appid), [2, 1]);
    assert.deepEqual(h.writes(), [[2, 1]]);
});

test('each page mount reads its own sequential history', () => {
    const a = harness({ binding: 'sequential', history: [1, 2] }); a.render();
    const b = harness({ binding: 'sequential', history: [2, 1] }); b.render();
    assert.deepEqual(a.books[0].cards.map(c => c.appid), [1, 2]);
    assert.deepEqual(b.books[0].cards.map(c => c.appid), [2, 1]);
    assert.equal(a.historyReads(), 1); assert.equal(b.historyReads(), 1);
});

test('metadata patches do not regroup years and sequential manual dates preserve order', () => {
    const h = harness({ binding: 'sequential', running: true }); h.render();
    h.render({ cards: [{ ...h.state.cards[0], rare: 7 }, h.state.cards[1]] });
    assert.equal(h.books[0].updates.length, 1); assert.equal(h.books[0].replacements.length, 0);
    h.render({ manualRevision: 1, cards: [{ ...h.state.cards[0], completedAt: 2025 }, h.state.cards[1]] });
    assert.deepEqual(h.books[0].replacements.at(-1).map(c => c.appid), [1, 2]);
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
