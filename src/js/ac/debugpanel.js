/**
 * 调试版专用：卡包页左上角的「动画重播」面板。
 *
 * 只在 build-plugin.mjs --debug 构建出来的插件里出现（构建时注入 __AC_DEBUG__ = true），
 * 正式版不挂。用来在真实的 Steam（Chromium 126）里挑着重复播入册动画和徽章翻新，
 * 做法和预览端 preview/intro-tiers.html 一样：在现有的册子上直接重播，不改任何数据和缓存。
 *
 *   · 入册：挑一张这一档游玩时长的卡，假装它刚入册；
 *   · 徽章翻新：册子里有真的蓝紫徽章卡就用它（翻新前的数字取只算本体的那份），
 *     没有就拿一张卡假装又拿了 6 金 9 银、多玩了 6.2 小时；
 *   · 卡槽：可以把这张卡临时挪到前几格（四卡版式看四个角）。
 * 演完一秒半后把册子还原成真实数据（挪过位置、假装翻新过的都恢复）。
 */

import { introTierOf } from './introfx.js';

/** 快速通关档指定闪电还是火焰；book.js 的 introFastStyle 读它 */
export const debugState = { fastStyle: null };

const ACTS = [
    ['lightning', '闪电', '15 小时以内'],
    ['fire', '火焰', '15 小时以内'],
    ['standard', '标准', '15～50 小时'],
    ['heavy', '厚重', '超过 50 小时'],
    ['upgrade', '徽章翻新', 'DLC 集合打通'],
];

const STYLE = `
.ac-debug { position: absolute; top: 12px; left: 12px; z-index: 2147483000; width: 236px; padding: 10px 12px 12px;
  font: 12px/1.45 "Be Vietnam Pro", "Microsoft YaHei UI", sans-serif; color: #e8e2d4; background: rgba(16, 15, 18, .92);
  border: 1px solid rgba(214, 183, 122, .35); border-radius: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, .45); }
.ac-debug[data-collapsed] { width: auto; padding: 6px 10px; }
.ac-debug[data-collapsed] > :not(.ac-debug__head) { display: none; }
.ac-debug__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; user-select: none; }
.ac-debug__head b { font-weight: 600; color: #d6b77a; }
.ac-debug__head span { color: #8e939b; font-size: 11px; }
.ac-debug__acts { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 8px; }
.ac-debug__acts button { padding: 6px 8px; color: inherit; font: inherit; text-align: left; cursor: pointer;
  background: #1d1c21; border: 1px solid rgba(255, 255, 255, .1); border-radius: 7px; }
.ac-debug__acts button small { display: block; color: #8e939b; font-size: 10.5px; }
.ac-debug__acts button[data-act="upgrade"] { grid-column: 1 / -1; border-color: rgba(182, 88, 196, .45); }
.ac-debug__acts button:hover:not(:disabled) { border-color: rgba(214, 183, 122, .55); }
.ac-debug__acts button:disabled { opacity: .5; cursor: wait; }
.ac-debug__row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; color: #a3a8b0; }
.ac-debug__row select { padding: 2px 6px; color: #e8e2d4; font: inherit; background: #1d1c21; border: 1px solid rgba(255, 255, 255, .14); border-radius: 6px; }
.ac-debug__status { margin-top: 8px; min-height: 2.9em; color: #a3a8b0; font-size: 11px; white-space: pre-line; }
`;

/**
 * @param {HTMLElement} container  卡包页（.ac-cardpack）
 * @param {{ getBook: () => object|null, getCards: () => object[], version?: string }} api
 * @returns {() => void} 卸载
 */
export function mountDebugPanel(container, { getBook, getCards, version = '' }) {
    const doc = container.ownerDocument;
    if (!doc.getElementById('ac-debug-style')) {
        const style = doc.createElement('style');
        style.id = 'ac-debug-style';
        style.textContent = STYLE;
        doc.head.append(style);
    }

    const panel = doc.createElement('div');
    panel.className = 'ac-debug';
    panel.innerHTML = `
      <div class="ac-debug__head" title="点击收起 / 展开"><b>调试 · 动画重播</b><span>${version ? `v${version}` : ''}</span></div>
      <div class="ac-debug__acts">${ACTS.map(([id, name, note]) => `<button type="button" data-act="${id}">${name}<small>${note}</small></button>`).join('')}</div>
      <label class="ac-debug__row">卡槽
        <select data-role="slot">
          <option value="">原来的位置</option>
          <option value="0">第 1 格（四卡：左上）</option>
          <option value="1">第 2 格（四卡：右上）</option>
          <option value="2">第 3 格（四卡：左下）</option>
          <option value="3">第 4 格（四卡：右下）</option>
        </select>
      </label>
      <div class="ac-debug__status" aria-live="polite">挑一个动画，在当前册子上重播。音效跟设置里的「入册音效」走。</div>`;
    container.append(panel);

    const buttons = [...panel.querySelectorAll('[data-act]')];
    const slotSelect = panel.querySelector('[data-role="slot"]');
    const status = panel.querySelector('.ac-debug__status');
    const say = (text) => {
        status.textContent = text;
    };
    let running = false;

    panel.querySelector('.ac-debug__head').addEventListener('click', () => {
        if (panel.hasAttribute('data-collapsed')) panel.removeAttribute('data-collapsed');
        else panel.setAttribute('data-collapsed', '');
    });

    const tierOf = (act) => (act === 'lightning' || act === 'fire' ? 'fast' : act);

    /** 把这张卡（或它的替身）放到指定格子；不指定就留在原位 */
    const arrange = (cards, card, replacement) => {
        const slot = slotSelect.value === '' ? null : Number(slotSelect.value);
        const order = cards.filter((item) => item !== card);
        order.splice(Number.isInteger(slot) ? Math.min(slot, order.length) : cards.indexOf(card), 0, replacement);
        return { order, moved: Number.isInteger(slot) && slot !== cards.indexOf(card) };
    };

    async function play(act) {
        const book = getBook();
        const cards = getCards() ?? [];
        if (running || !book || cards.length === 0) {
            if (!book || cards.length === 0) say('册子还没装订好，等卡片出来再试。');
            return;
        }
        running = true;
        for (const button of buttons) button.disabled = true;
        let restore = false;
        let keep = null;
        try {
            if (act === 'upgrade') {
                const real = cards.find((card) => card.allSets === true && card.sets?.base);
                const card = real ?? cards[Math.min(cards.length - 1, Math.max(0, book.index ?? 0))];
                const after = real ?? {
                    ...card,
                    allSets: true,
                    rare: (card.rare ?? 0) + 6,
                    common: (card.common ?? 0) + 9,
                    total: (card.total ?? 0) + 15,
                    playtimeMin: Number.isFinite(card.playtimeMin) ? card.playtimeMin + 372 : card.playtimeMin,
                    sets: { ...(card.sets ?? {}), allCompletedAt: Math.floor(Date.now() / 1000) },
                };
                const from = real
                    ? { rare: real.sets.base.rare, common: real.sets.base.common, total: real.sets.base.total }
                    : { rare: card.rare, common: card.common, total: card.total, playtimeMin: card.playtimeMin };
                const { order, moved } = arrange(cards, card, after);
                restore = moved || !real;
                keep = card.appid;
                say(`徽章翻新：${card.name}${real ? '（真的蓝紫徽章卡）' : '（假装又拿了 6 金 9 银）'}`);
                await book.upgrade(order, [{ appid: card.appid, from }]);
            } else {
                const tier = tierOf(act);
                const card = cards.find((item) => introTierOf(item) === tier);
                if (!card) {
                    say(`册子里没有「${tier}」这一档游玩时长的卡。`);
                    return;
                }
                debugState.fastStyle = tier === 'fast' ? act : null;
                const { order, moved } = arrange(cards, card, card);
                restore = moved;
                keep = card.appid;
                const hours = Number.isFinite(card.playtimeMin) ? ` · ${(card.playtimeMin / 60).toFixed(1)}h` : '';
                say(`入册「${ACTS.find(([id]) => id === act)[1]}」：${card.name}${hours}`);
                await book.introduce(order, [card.appid]);
            }
            if (restore) {
                await new Promise((resolve) => setTimeout(resolve, 1500));
                if (getBook() === book) book.replaceCards(getCards() ?? cards, { keepAppid: keep });
                say(`${status.textContent}\n演示结束，册子已还原成真实数据。`);
            }
        } catch (err) {
            say(`播放出错：${err?.message ?? err}`);
        } finally {
            debugState.fastStyle = null;
            running = false;
            for (const button of buttons) button.disabled = false;
        }
    }

    for (const button of buttons) button.addEventListener('click', () => play(button.dataset.act));
    return () => panel.remove();
}
