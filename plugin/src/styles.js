/**
 * 插件把卡包 CSS 作为字符串打包进来，运行时注入一个 <style>。
 * 这样更新只需要覆盖一个 index.js，不会出现「JS 新、CSS 旧」的半更新状态。
 *
 * 注入目标不能只看模块自己的 document：卡册可能被渲染在模态窗口或另一个
 * Steam 窗口里（模块顶层与 DOM 所在文档不一定是同一个）。所以同时注册一个
 * 「按节点所在文档补样式」的 ensurer，由 Page / 面板在挂载时调用。
 */

import pluginCss from '../plugin.css';
import { setStyleEnsurer } from '../../src/js/ac/env.js';

const STYLE_ID = 'ac-plugin-style';
let loggedCrossDocument = false;

export function ensureStyles(doc) {
    if (!doc?.createElement) return;
    let style = doc.querySelector(`style[data-ac="${STYLE_ID}"]`);
    if (!style) {
        style = doc.createElement('style');
        style.dataset.ac = STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
    }
    if (style.textContent !== pluginCss) style.textContent = pluginCss;

    if (!loggedCrossDocument && doc !== document) {
        loggedCrossDocument = true;
        try {
            console.info(
                '%c[成就收藏册 · 插件]',
                'color:#66c0f4;font-weight:600',
                '卡册样式已注入实际窗口（与插件模块不同文档）',
                doc.location?.href ?? '',
            );
        } catch {
            /* 忽略 */
        }
    }
}

ensureStyles(document);
setStyleEnsurer(ensureStyles);

export default pluginCss;
