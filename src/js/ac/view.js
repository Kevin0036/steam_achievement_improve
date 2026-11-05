/** Cached card ordering for React's frequently fired store subscription. */
/**
 * 两种装订都按完成时间排：
 *   · 最新优先：sortCards（完成时间倒序）
 *   · 顺序入册：完成时间正序，没有日期的排在最后
 * 顺序入册以前另记一份「入册先后」，以前打完、后来才露面的卡（例如之前被误判没收进来）会被
 * 挤到末尾，修起来还得靠一次性修复；现在直接按日期排，两种装订永远互为倒序。
 */
export function createCardView({ sortCards }) {
    let lastCards = null;
    let lastBinding = null;
    let lastFreeze = false;
    let lastManualRevision = 0;
    let sortedBasis = new Map();
    let lastById = new Map();
    let lastIds = [];
    let lastResult = null;

    function select(cards, { binding = 'newest', freezeOrder = false, manualRevision = 0 } = {}) {
        if (cards === lastCards && binding === lastBinding && freezeOrder === lastFreeze
            && manualRevision === lastManualRevision) {
            return lastResult;
        }
        const byId = new Map(cards.map(card => [card.appid, card]));
        const idsNow = cards.map(card => card.appid);
        const previousMembers = new Set(lastIds);
        const sameMembers = idsNow.length === lastIds.length && idsNow.every(id => previousMembers.has(id));
        const sameBinding = binding === lastBinding;
        const sameNames = sameMembers && cards.every(card => lastById.get(card.appid)?.name === card.name);
        const sameKeys = sameMembers && cards.every(card => {
            const before = sortedBasis.get(card.appid);
            return before && before.completedAt === card.completedAt && before.name === card.name;
        });
        // 补日期期间页面顺序先冻住，补完再统一排一次（手动改日期、增删卡、改名都立即重排）
        const frozen = freezeOrder && sameNames && manualRevision === lastManualRevision;
        let ids;
        if (sameBinding && sameMembers && (frozen || sameKeys)) ids = lastIds;
        else {
            const sorted = binding === 'sequential' ? sortByCompletion(cards) : sortCards(cards);
            ids = sorted.map(card => card.appid);
            sortedBasis = byId;
        }
        // Identity is the order token. A recalculation with the same sequence needs no rebinding.
        if (ids.length === lastIds.length && ids.every((id, i) => id === lastIds[i])) ids = lastIds;
        const ordered = cards === lastCards && ids === lastIds && lastResult
            ? lastResult.cards : ids.map(id => byId.get(id));
        lastCards = cards;
        lastBinding = binding;
        lastFreeze = freezeOrder;
        lastManualRevision = manualRevision;
        lastIds = ids;
        lastById = byId;
        lastResult = { cards: ordered, ids };
        return lastResult;
    }

    return { select };
}

/** 顺序入册：完成时间正序，没有日期的排在最后，同一时刻按 appid */
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
