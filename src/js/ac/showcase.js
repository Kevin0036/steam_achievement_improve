/**
 * 成就收藏册 · 功能 A：展柜 DOM 增强
 *
 * 这个模块刻意做得**很轻**，因为它面对的是 Valve 服务端渲染的社区页面，
 * 任何激进改写都可能在下一次改版时变成噪音。它只做两件事：
 *
 *   1. 给展柜根节点打上 data-ac="showcase"，方便自检报告。
 *   2. 整理统计行：
 *      · 「完美通关的 DLC」这类 DLC 栏位隐藏（打 data-ac-stat="hidden"，由 CSS 隐藏）；
 *      · 「已完成的游戏和组」改名为「完美通关的游戏」，原文保存在 data-ac-label-original 里。
 *      数字本身一个都不动。
 *
 * 徽章、隐藏「X 项为稀有」等纯视觉的部分全在 showcase.css 里，不需要 JS。
 *
 * 幂等：每个元素各自用 data 属性判断是否处理过；社区页面在编辑模式切换时会
 * 局部重渲染，重入时只处理新出现的节点。
 */

import { SHOWCASE } from './selectors.js';
import { repairShowcaseCovers } from './showcaseart.js';
import STR from './strings.js';
import { tagged } from './utils.js';

const out = tagged('showcase');

/** DLC 栏位：各语言里 Valve 都保留了「DLC」这个词 */
const DLC_LABEL = /\bDLC\b|DLC/i;

function tidyStats(root) {
    const stats = root.querySelectorAll(SHOWCASE.stat);
    let relabelled = false;
    let changed = 0;

    for (const stat of stats) {
        if (stat.dataset.acStat) {
            if (stat.dataset.acStat === 'games') relabelled = true;
            continue;
        }
        const label = stat.querySelector(SHOWCASE.statLabel);
        if (!label) continue;

        const text = label.textContent.trim();
        if (DLC_LABEL.test(text)) {
            stat.dataset.acStat = 'hidden';
            changed += 1;
            continue;
        }

        // 只改第一个非 DLC 栏位（即「已完成的游戏和组」），其余原样保留
        if (!relabelled) {
            label.dataset.acLabelOriginal = text;
            label.textContent = STR.showcase.perfectGames;
            stat.dataset.acStat = 'games';
            relabelled = true;
            changed += 1;
        } else {
            stat.dataset.acStat = 'kept';
        }
    }
    return changed;
}

export function enhanceShowcase(root) {
    if (!root || !root.querySelector(SHOWCASE.slots)) return 0;

    if (root.dataset.ac !== 'showcase') {
        root.dataset.ac = 'showcase';
        root.dataset.acTheme = 'AchievementCollection';
        out.log(`展柜已识别：${root.querySelectorAll(SHOWCASE.slot).length} 个格子`);
    }

    return tidyStats(root) + repairShowcaseCovers(root);
}
