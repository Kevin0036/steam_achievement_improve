import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCardView, createYearSnapshot, sameYearSnapshot } from '../../millennium/themes/AchievementCollection/src/js/ac/view.js';

const compare = (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.appid - b.appid;
const makeView = () => {
    let sorts = 0;
    const view = createCardView({ sortCards: cards => { sorts++; return [...cards].sort(compare); } });
    return { view, sorts: () => sorts };
};
const seq = (view, cards, options = {}) => view.select(cards, { binding: 'sequential', ...options }).ids;

test('reuses sorted view for the same card array', () => {
    const { view, sorts } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    const first = view.select(cards);
    assert.strictEqual(view.select(cards), first);
    const patched = cards.map(card => ({ ...card, common: 1 }));
    const sameOrder = view.select(patched);
    assert.deepEqual(sameOrder.cards.map(card => card.appid), [2, 1]);
    assert.equal(sorts(), 1);
});

test('metadata-only patches reuse order and return updated card references', () => {
    const { view, sorts } = makeView();
    const firstCards = [{ appid: 1, completedAt: 10, rare: 1 }, { appid: 2, completedAt: 20, rare: 0 }];
    view.select(firstCards);
    const nextCards = [{ ...firstCards[0], rare: 2 }, { ...firstCards[1], rare: 3 }];
    const next = view.select(nextCards).cards;
    assert.deepEqual(next.map(card => card.appid), [2, 1]);
    assert.strictEqual(next[0], nextCards[1]);
    assert.equal(sorts(), 1);
});

test('date backfill freezes page order but refreshes card references, then sorts once at completion', () => {
    const { view, sorts } = makeView();
    const initial = [{ appid: 1, completedAt: null }, { appid: 2, completedAt: 20 }];
    assert.deepEqual(view.select(initial).cards.map(card => card.appid), [2, 1]);
    const partial = [{ ...initial[0], completedAt: 30 }, initial[1]];
    const stable = view.select(partial, { freezeOrder: true }).cards;
    assert.deepEqual(stable.map(card => card.appid), [2, 1]);
    assert.strictEqual(stable[1], partial[0]);
    assert.deepEqual(view.select(partial, { freezeOrder: false }).cards.map(card => card.appid), [1, 2]);
    assert.equal(sorts(), 2);
});

test('sequential binding is completion order: oldest first, undated last', () => {
    const { view } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }, { appid: 3, completedAt: 5 }, { appid: 4, completedAt: null }];
    assert.deepEqual(seq(view, cards), [3, 1, 2, 4]);
});

test('sequential binding: an old completion that shows up late goes to its date, not to the end of the year', () => {
    // 潜水员戴夫：2024-09 打完，之前被误判没收进来，修好后才露面
    const { view } = makeView();
    const old = [{ appid: 11, completedAt: 100 }, { appid: 12, completedAt: 200 }, { appid: 13, completedAt: 300 }, { appid: 14, completedAt: 400 }];
    assert.deepEqual(seq(view, old), [11, 12, 13, 14]);
    assert.deepEqual(seq(view, [...old, { appid: 99, completedAt: 250 }]), [11, 12, 99, 13, 14]);
    // 真正新打完的接在最后
    assert.deepEqual(seq(view, [...old, { appid: 99, completedAt: 250 }, { appid: 7, completedAt: 500 }]), [11, 12, 99, 13, 14, 7]);
});

test('sequential binding is always the exact reverse of newest first', () => {
    const { view } = makeView();
    const cards = Array.from({ length: 40 }, (_, i) => ({ appid: 1000 + i, completedAt: ((i * 7919) % 97) * 1000 + i }));
    assert.deepEqual(seq(view, cards), [...view.select(cards).ids].reverse());
});

test('sequential: date backfill freezes the order, then sorts once dates are in', () => {
    const { view } = makeView();
    const preview = [{ appid: 1, completedAt: null }, { appid: 2, completedAt: null }];
    assert.deepEqual(seq(view, preview), [1, 2]);
    const dated = [{ ...preview[0], completedAt: 30 }, { ...preview[1], completedAt: 20 }];
    assert.deepEqual(seq(view, dated, { freezeOrder: true }), [1, 2], 'display stays stable while dates are still arriving');
    assert.deepEqual(seq(view, dated), [2, 1]);
});

test('sequential: a corrected date moves the card', () => {
    const { view } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    assert.deepEqual(seq(view, cards), [1, 2]);
    assert.deepEqual(seq(view, [{ ...cards[0], completedAt: 50 }, cards[1]]), [2, 1]);
});

test('year snapshot avoids rebuilding strings and detects only changed years or membership', () => {
    const key = card => card.completedAt == null ? 'undated' : String(new Date(card.completedAt * 1000).getUTCFullYear());
    const cards = [{ appid: 1, completedAt: 1700000000 }, { appid: 2, completedAt: null }];
    const snapshot = createYearSnapshot(cards, key);
    assert.equal(sameYearSnapshot(cards, snapshot, key), true);
    assert.equal(sameYearSnapshot([{ ...cards[0], rare: 1 }, cards[1]], snapshot, key), true);
    assert.equal(sameYearSnapshot([{ ...cards[0], completedAt: 1600000000 }, cards[1]], snapshot, key), false);
    assert.equal(sameYearSnapshot([cards[1], cards[0]], snapshot, key), false);
});

test('switching from sequential binding to newest recalculates even if dates are unchanged', () => {
    const { view } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    view.select(cards, { binding: 'sequential' });
    assert.deepEqual(view.select(cards).cards.map(card => card.appid), [2, 1]);
});

test('manual revision reorders immediately during backfill', () => {
    const { view } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    view.select(cards, { freezeOrder: true });
    const manual = [{ ...cards[0], completedAt: 30 }, cards[1]];
    assert.deepEqual(view.select(manual, { freezeOrder: true, manualRevision: 1 }).cards.map(card => card.appid), [1, 2]);
});

test('membership and name updates invalidate frozen order', () => {
    const { view, sorts } = makeView();
    const cards = [{ appid: 1, completedAt: 10, name: 'A' }, { appid: 2, completedAt: 20, name: 'B' }];
    view.select(cards, { freezeOrder: true });
    const renamed = [{ ...cards[0], name: 'Z' }, cards[1]];
    view.select(renamed, { freezeOrder: true });
    assert.equal(sorts(), 2, 'name changes re-evaluate tie ordering');
    const added = [...renamed, { appid: 3, completedAt: 50 }];
    assert.deepEqual(view.select(added, { freezeOrder: true }).cards.map(card => card.appid), [3, 2, 1]);
});

test('order token is stable after metadata patches and sorting that leaves IDs unchanged', () => {
    const { view } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    const first = view.select(cards);
    const changed = view.select([{ ...cards[0], completedAt: 11 }, cards[1]]);
    assert.strictEqual(changed.ids, first.ids);
});

test('repeated binding switches always restore the selected ordering', () => {
    const { view } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    for (let i = 0; i < 3; i++) {
        assert.deepEqual(view.select(cards).ids, [2, 1]);
        assert.deepEqual(view.select(cards, { binding: 'sequential' }).ids, [1, 2]);
    }
});

test('real data: Dave the Diver sits at 2024-09-15 in sequential binding', async () => {
    const { readFileSync, existsSync } = await import('node:fs');
    const file = process.env.AC_REAL_ORDER;
    if (!file || !existsSync(file)) return;
    const { state } = JSON.parse(readFileSync(file, 'utf8'));
    const { view } = makeView();
    const ids = seq(view, state.cards);
    const at = ids.indexOf(1868140);
    const by = new Map(state.cards.map(c => [c.appid, c]));
    console.log('Dave at', at, 'between', by.get(ids[at - 1])?.name, 'and', by.get(ids[at + 1])?.name);
    assert.ok(by.get(ids[at - 1]).completedAt <= by.get(1868140).completedAt);
    assert.ok(by.get(ids[at + 1]).completedAt >= by.get(1868140).completedAt);
});
