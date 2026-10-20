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
const VERSION = '1.0.2';

const out = tagged('profile');

(async function main() {
    const disposables = new Disposables();

    // 这一层只为「不要在没有展柜的页面上做事」——先确认页面里出现过展柜的信号
    const hasShowcase = await waitFor(
        () => document.querySelector(SHOWCASE.slots) || document.querySelector(SHOWCASE.bar),
        { timeout: 12000, interval: 250 },
    );

    if (!hasShowcase) {
        log('当前社区页面没有完满主义者展柜，功能 A 不做事');
        return;
    }

    banner(THEME_NAME, VERSION);

    const run = debounce(() => {
        try {
            // enhanceShowcase 对每个元素各自幂等，重入只处理新出现的节点
            for (const root of document.querySelectorAll(SHOWCASE.root)) {
                enhanceShowcase(root);
            }
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