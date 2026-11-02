/** Cached card ordering for React's frequently fired store subscription. */
export function createCardView({ sortCards, readOrder, writeOrder }) {
    let lastCards = null;
    let lastBinding = null;
    let lastFreeze = false;
    let lastPersist = false;
    let lastManualRevision = 0;
    let sortedBasis = new Map();
    let lastById = new Map();
    let lastIds = [];
    let lastResult = null;
    let history = null;

    function select(cards, { binding = 'newest', freezeOrder = false, persist = true, manualRevision = 0 } = {}) {
        if (cards === lastCards && binding === lastBinding && freezeOrder === lastFreeze
            && persist === lastPersist && manualRevision === lastManualRevision) {
            return lastResult;
        }
        const byId = new Map(cards.map(card => [card.appid, card]));
        const idsNow = cards.map(card => card.appid);
        const previousMembers = new Set(lastIds);
        const sameMembers = idsNow.length === lastIds.length && idsNow.every(id => previousMembers.has(id));
        const sameBinding = binding === lastBinding;
        let ids;
        if (binding === 'sequential') {
            if (!history) history = readOrder();
            const frozen = sameBinding && freezeOrder && sameMembers
                && manualRevision === lastManualRevision;
            if (frozen) ids = lastIds;
            else {
                const kept = history.filter(id => byId.has(id));
                const known = new Set(kept);
                const fresh = cards.filter(card => !known.has(card.appid));
                const freshIds = sortByCompletion(fresh).map(card => card.appid);
                ids = [...kept, ...freshIds];
                // Undated cards only have a provisional slot: persist once the batch is fully
                // dated, otherwise the appid order gets frozen in as "arrival order" for good.
                const settled = fresh.every(card => card.completedAt != null);
                if (persist && fresh.length && settled) {
                    history = [...history, ...freshIds];
                    writeOrder(history);
                }
            }
        } else {
            const sameNames = sameMembers && cards.every(card => lastById.get(card.appid)?.name === card.name);
            const sameKeys = sameMembers && cards.every(card => {
                const before = sortedBasis.get(card.appid);
                return before && before.completedAt === card.completedAt && before.name === card.name;
            });
            const frozen = freezeOrder && sameNames && manualRevision === lastManualRevision;
            if (sameBinding && sameMembers && (frozen || sameKeys)) ids = lastIds;
            else {
                ids = sortCards(cards).map(card => card.appid);
                sortedBasis = byId;
            }
        }
        // Identity is the order token. A recalculation with the same sequence needs no rebinding.
        if (ids.length === lastIds.length && ids.every((id, i) => id === lastIds[i])) ids = lastIds;
        const ordered = cards === lastCards && ids === lastIds && lastResult
            ? lastResult.cards : ids.map(id => byId.get(id));
        lastCards = cards;
        lastBinding = binding;
        lastFreeze = freezeOrder;
        lastPersist = persist;
        lastManualRevision = manualRevision;
        lastIds = ids;
        lastById = byId;
        lastResult = { cards: ordered, ids };
        return lastResult;
    }

    return { select };
}

/** Arrival order: completion time ascending, undated cards last, stable by appid. */
function sortByCompletion(cards) {
    return [...cards].sort((a, b) => {
        const left = a.completedAt ?? Infinity;
        const right = b.completedAt ?? Infinity;
        return left === right ? a.appid - b.appid : left - right;
    });
}

export function createYearSnapshot(cards, yearKeyOf) {
    return cards.map(card => [card.appid, yearKeyOf(card)]);
}

export function sameYearSnapshot(cards, snapshot, yearKeyOf) {
    return cards.length === snapshot.length && cards.every((card, index) =>
        card.appid === snapshot[index][0] && yearKeyOf(card) === snapshot[index][1]);
}
