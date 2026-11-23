/**
 * 成就收藏册 · 功能 A 的社区页面侧入口
 *
 * 这是 skin.json 里 `MatchRegexString: "https://steamcommunity\\.com(/.*)?"`
 * 那一条的 TargetJs，与 SpaceTheme 使用完全相同的匹配规则与机制。
 *
 * 只在检测到完满主义者展柜时才做任何事 —— **其它社区页面零副作用**。
 * 社区页面的形态是：一次服务端渲染 + 编辑器里的局部重渲染，
 * 所以用一个 MutationObserver 守着重入，并且重入是幂等的。
 */

import { SHOWCASE } from './selectors.js';
import { enhanceShowcase } from './showcase.js';
import { banner, debounce, log, warn, Disposables, tagged, waitFor } from './utils.js';

const THEME_NAME = '成就收藏册';
const VERSION = '1.1.0';

const out = tagged('profile');

(async function main() {
    const disposables = new Disposables();

    // 这一层只为「不要在没有展柜的页面上做事」——先确认页面里出现过展柜的信号。
    // 守卫必须在确认之后才落：社区页面打开时主题版和插件版可能各注入一份，
    // 如果先到的那份因为等不到展柜而退出，它不能把后来真正能干活的那份挡在门外。
    const hasTarget = await waitFor(
        () =>
            document.querySelector(SHOWCASE.slots) ||
            document.querySelector(SHOWCASE.bar) ||
            document.querySelector('.recent_game .game_info_achievements'),
        { timeout: 12000, interval: 250 },
    );

    if (!hasTarget) {
        log('当前社区页面没有完满主义者展柜或最近游玩成就区，功能 A 不做事');
        return;
    }

    // 真正要挂观察器时才占位：同一页面只留一份。
    if (window.__acShowcaseMounted) {
        log('展柜入口已由另一份脚本挂载，本份跳过');
        return;
    }
    window.__acShowcaseMounted = true;

    banner(THEME_NAME, VERSION);

    const RECENT_STARS_HTML = (() => {
        const slots = [18, 76, 38, 82, 52, 24, 68, 44];
        const phi = 0.6180339887498949;
        let outHtml = '';
        for (let i = 0; i < slots.length; i += 1) {
            const phase = ((i + 1) * phi) % 1;
            const dur = 5.4 + (i % 4) * 0.9;
            const delay = -(phase * dur);
            const b = (0.62 + ((i * 37) % 10) * 0.038).toFixed(2);
            outHtml += `<span class="ac-pbar-star" style="top:${slots[i]}%;animation-duration:${dur.toFixed(2)}s;animation-delay:${delay.toFixed(2)}s"><i style="--sb:${b}"></i></span>`;
        }
        return outHtml;
    })();

    const enhanceRecentGames = () => {
        for (const card of document.querySelectorAll('.recent_game')) {
            if (card.dataset.acRecent === '1') continue;
            const summary = card.querySelector('.game_info_achievement_summary');
            const segBar = card.querySelector('.achievement_segmented_bar');
            const oldBar = card.querySelector('.progress_bar');
            if (!summary && !segBar && !oldBar) continue;

            let pctFloat = null;
            if (segBar) {
                const raw = segBar.style?.gridTemplateColumns || segBar.getAttribute('style') || '';
                const frs = [...raw.matchAll(/([\d.]+)\s*fr\b/gi)].map((m) => Number.parseFloat(m[1]));
                const segCount = segBar.querySelectorAll(':scope > .segment').length;
                if (frs.length > 0) {
                    const total = frs.reduce((a, b) => a + b, 0);
                    if (total > 0) {
                        const unlockedFr =
                            segCount > 0 && segCount <= frs.length
                                ? frs.slice(0, segCount).reduce((a, b) => a + b, 0)
                                : frs.length >= 2
                                  ? frs.slice(0, -1).reduce((a, b) => a + b, 0)
                                  : frs[0];
                        pctFloat = Math.max(0, Math.min(100, (unlockedFr / total) * 100));
                    }
                }
            }
            if (pctFloat === null && summary) {
                const txt = summary.textContent || '';
                const ratio = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(txt);
                if (ratio) {
                    const u = Number.parseInt(ratio[1].replace(/,/g, ''), 10);
                    const t = Number.parseInt(ratio[2].replace(/,/g, ''), 10);
                    if (Number.isFinite(u) && Number.isFinite(t) && t > 0) {
                        pctFloat = Math.max(0, Math.min(100, (u / t) * 100));
                    }
                }
            }
            if (pctFloat === null && oldBar) {
                const m = /width\s*:\s*([\d.]+)%/.exec(oldBar.getAttribute('style') || '');
                if (m) pctFloat = Math.max(0, Math.min(100, Number.parseFloat(m[1])));
            }
            if (pctFloat === null) continue;

            const pctRounded = Math.round(pctFloat);
            const hasDlcCompleted = Boolean(card.querySelector('.game_info_achievements_ribbons .showcase_completion_ribbon_group.dlc:not(.empty)'));
            const hasDlcSeg = Boolean(segBar?.querySelector('.segment.dlc'));
            const tier =
                pctRounded >= 100
                    ? hasDlcCompleted || hasDlcSeg
                        ? 'all100'
                        : 'base100'
                    : pctRounded >= 90
                      ? 'near'
                      : 'progress';

            card.dataset.acTier = tier;
            card.dataset.acPct = String(pctRounded);
            card.style.setProperty('--ac-pct', `${Number(pctFloat.toFixed(2))}%`);
            card.dataset.acRecent = '1';

            const hostBar = segBar || card.querySelector('.achievement_progress_bar_ctn');
            if (hostBar && !hostBar.querySelector(':scope > .ac-pbar-fx')) {
                const fx = document.createElement('span');
                fx.className = 'ac-pbar-fx';
                fx.setAttribute('aria-hidden', 'true');
                fx.innerHTML = `<span class="ac-pbar-sweep"></span><span class="ac-pbar-stars">${RECENT_STARS_HTML}</span>`;
                hostBar.appendChild(fx);
                const tip = document.createElement('span');
                tip.className = 'ac-pbar-tip';
                tip.setAttribute('aria-hidden', 'true');
                hostBar.appendChild(tip);
            }
            out.log(`最近游玩已增强：${tier} (${pctRounded}%)`);
        }
    };

    const run = debounce(() => {
        try {
            // enhanceShowcase 对每个元素各自幂等，重入只处理新出现的节点
            for (const root of document.querySelectorAll(SHOWCASE.root)) {
                enhanceShowcase(root);
            }
            enhanceRecentGames();
        } catch (err) {
            warn('展柜增强出错（已忽略，不影响页面其余部分）', err);
        }
    }, 120);

    run();

    // 社区页面在「编辑展柜」时会重渲染整块区域，这里守着重入。
    // 只观察 childList，不观察 attributes，避免自己写 data-ac 触发自己；
    // 改写标签文字会触发一次 childList，但第二轮里元素已带标记，不会循环。
    const observer = new MutationObserver(run);
    observer.observe(document.body, { childList: true, subtree: true });
    disposables.addObserver(observer);

    disposables.addListener(window, 'pagehide', () => disposables.disposeAll());
    disposables.addListener(window, 'unload', () => disposables.disposeAll());

    out.log('展柜入口已挂载');
})();