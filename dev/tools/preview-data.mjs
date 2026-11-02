/** Preview adapters use the production completion rule and ordering. */
import { classify, sortCards } from '../../millennium/themes/AchievementCollection/src/js/ac/model.js';

export function buildPreviewCards(clientCards, progress) {
    if (!Array.isArray(clientCards) || !Array.isArray(progress)) throw new Error('无效的客户端快照或成就进度');
    const byId = new Map();
    for (const card of clientCards) {
        if (!Number.isInteger(card?.appid) || byId.has(card.appid)) throw new Error(`重复或无效的卡片 ${card?.appid}`);
        byId.set(card.appid, card);
    }
    const cards = [];
    for (const [appid, entry] of progress) {
        if (classify(entry) !== 'complete') continue;
        const card = byId.get(Number(appid));
        if (!card || card.total !== entry.total || card.unlocked !== entry.unlocked) {
            throw new Error(`${appid}: 客户端快照与当前进度不一致，请在 Steam 中打开卡包并等待加载后重新同步`);
        }
        const counts = [card.rare, card.common, card.unrated];
        const known = value => value == null || (Number.isInteger(value) && value >= 0);
        if (!counts.every(known) || (card.rare == null) !== (card.common == null) ||
            counts.reduce((sum, value) => sum + (value ?? 0), 0) !== card.total) {
            throw new Error(`${appid}: 奖杯统计与成就总数不一致`);
        }
        cards.push(card);
    }
    return sortCards(cards, 'completed');
}

/** Chromium localStorage prefixes strings with a one-byte encoding tag. */
export function decodeStorageString(buffer) {
    if (buffer[0] === 1) return buffer.subarray(1).toString('latin1');
    if (buffer[0] === 0 && buffer.length % 2 === 1) return buffer.subarray(1).toString('utf16le');
    throw new Error('Unsupported Chromium storage encoding');
}
