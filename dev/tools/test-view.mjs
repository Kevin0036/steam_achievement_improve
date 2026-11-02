import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCardView, createYearSnapshot, sameYearSnapshot } from '../../millennium/themes/AchievementCollection/src/js/ac/view.js';

const compare = (a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || a.appid - b.appid;
const makeView = (order = []) => {
    let sorts = 0, writes = [];
    const view = createCardView({
        sortCards: cards => { sorts++; return [...cards].sort(compare); },
        readOrder: () => order,
        writeOrder: ids => { writes.push(ids); order = ids; },
        orderKey: card => `${card.completedAt ?? 0}|${card.name ?? ''}`,
    });
    return { view, sorts: () => sorts, writes: () => writes };
};

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

test('sequential binding appends newly seen cards and writes order only when permitted', () => {
    const { view, sorts, writes } = makeView([1]);
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }, { appid: 3, completedAt: 5 }];
    assert.deepEqual(view.select(cards, { binding: 'sequential', persist: false }).cards.map(card => card.appid), [1, 3, 2]);
    assert.equal(writes().length, 0);
    view.select(cards, { binding: 'sequential', persist: true });
    assert.deepEqual(writes(), [[1, 3, 2]]);
    assert.equal(sorts(), 0);
});

test('sequential never persists provisional appid order before dates are known', () => {
    const { view, writes } = makeView();
    const preview = [{ appid: 1, completedAt: null }, { appid: 2, completedAt: null }];
    assert.deepEqual(view.select(preview, { binding: 'sequential' }).ids, [1, 2]);
    assert.equal(writes().length, 0, 'undated cards must not be written as arrival order');
    const dated = [{ ...preview[0], completedAt: 30 }, { ...preview[1], completedAt: 20 }];
    assert.deepEqual(view.select(dated, { binding: 'sequential', freezeOrder: true }).ids, [1, 2],
        'display stays stable while dates are still arriving');
    assert.equal(writes().length, 0);
    assert.deepEqual(view.select(dated, { binding: 'sequential' }).ids, [2, 1]);
    assert.deepEqual(writes(), [[2, 1]], 'seeded once all dates are known, oldest first');
});

test('sequential appends new cards only after their dates arrive', () => {
    const { view, writes } = makeView([2, 1]);
    const base = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    view.select(base, { binding: 'sequential' });
    const fresh = [{ appid: 3, completedAt: null }, { appid: 4, completedAt: null }];
    assert.deepEqual(view.select([...base, ...fresh], { binding: 'sequential' }).ids, [2, 1, 3, 4]);
    assert.equal(writes().length, 0, 'fresh cards wait for their dates');
    const dated = [...base, { ...fresh[0], completedAt: 40 }, { ...fresh[1], completedAt: 30 }];
    assert.deepEqual(view.select(dated, { binding: 'sequential' }).ids, [2, 1, 4, 3]);
    assert.deepEqual(writes(), [[2, 1, 4, 3]]);
});

test('seeded sequential history keeps old positions when later dates change', () => {
    const { view, writes } = makeView();
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    view.select(cards, { binding: 'sequential' });
    const corrected = [{ ...cards[0], completedAt: 50 }, cards[1]];
    assert.deepEqual(view.select(corrected, { binding: 'sequential' }).ids, [1, 2]);
    assert.equal(writes().length, 1, 'no rewrite for already shelved cards');
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
    const { view } = makeView([1, 2]);
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

test('client cards replace provisional sequential ordering before it is persisted', () => {
    const { view, writes } = makeView();
    const cached = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    view.select(cached, { binding: 'sequential', persist: false });
    const client = [{ ...cached[0], completedAt: 30 }, cached[1]];
    assert.deepEqual(view.select(client, { binding: 'sequential', persist: true }).cards.map(card => card.appid), [2, 1]);
    assert.deepEqual(writes(), [[2, 1]]);
});

test('repeated binding switches always restore the selected ordering', () => {
    const { view } = makeView([1, 2]);
    const cards = [{ appid: 1, completedAt: 10 }, { appid: 2, completedAt: 20 }];
    for (let i = 0; i < 3; i++) {
        assert.deepEqual(view.select(cards).ids, [2, 1]);
        assert.deepEqual(view.select(cards, { binding: 'sequential' }).ids, [1, 2]);
    }
});
