/**
 * 展柜锁区封面：把卡册里出现过的 appid 交给后端。
 *
 * 社区页的 CSP 不放行 millennium.host 的脚本，原来按 appid 探测并替换 <img> 的
 * 做法在客户端里已经跑不起来了。现在改由后端生成一份只含 --ac-cover 变量的 CSS
 * （appid → header_schinese/tchinese/japanese/header 回退链），用 add_browser_css 注入。
 * 这里只负责收集 appid。完美主义者展柜展示的是**所有全成就游戏**，
 * 而卡册卡片（state）只包含已生成卡片的那些，所以完成日期（completed）
 * 和手填日期（manual）这两个「全成就全集」也必须一起扫——否则不在卡册里的
 * 全成就游戏（尤其是锁区的）永远拿不到 --ac-cover 规则。
 *
 * 每分钟的心跳顺带同步一次：签名没变就不打扰后端；上次失败的话这次会重试。
 */

import { PLUGIN_NAME } from './mode.js';

const STATE_KEY = /^ac:v\d+:(?:[^:]+:)?state$/;
const SHELVED_KEY = /^ac:v\d+:(?:[^:]+:)?shelved$/;
const DONE_KEY = /^ac:v\d+:(?:[^:]+:)?(?:completed|manual)$/;

let publishedSignature = null;
let inFlight = null;

function addAppid(set, value) {
    const appid = Number(value);
    if (Number.isFinite(appid) && appid > 0 && appid < 4294967296) set.add(Math.floor(appid));
}

export function collectAppids() {
    const ids = new Set();
    try {
        for (let i = 0; i < localStorage.length; i += 1) {
            const key = localStorage.key(i);
            if (!key) continue;
            if (!STATE_KEY.test(key) && !SHELVED_KEY.test(key) && !DONE_KEY.test(key)) continue;
            let parsed;
            try {
                parsed = JSON.parse(localStorage.getItem(key) || 'null');
            } catch {
                continue;
            }
            if (STATE_KEY.test(key)) {
                for (const card of Array.isArray(parsed?.cards) ? parsed.cards : []) addAppid(ids, card?.appid);
            } else if (DONE_KEY.test(key)) {
                for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) addAppid(ids, row?.[0]);
            } else {
                for (const appid of Array.isArray(parsed?.appids) ? parsed.appids : []) addAppid(ids, appid);
            }
        }
    } catch {
        // localStorage 不可用时后端会继续用上次的列表
    }
    return [...ids].sort((a, b) => a - b);
}

async function publish(appids) {
    const raw = await window.Millennium.callServerMethod(PLUGIN_NAME, 'PublishShowcaseCovers', [{ appids }]);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

/** @returns {Promise<boolean>} 这次是否真的把新列表发给了后端 */
export function syncShowcaseCovers() {
    if (inFlight) return inFlight;
    if (typeof window.Millennium?.callServerMethod !== 'function') return Promise.resolve(false);

    const appids = collectAppids();
    if (appids.length === 0) return Promise.resolve(false);
    const signature = appids.join(',');
    if (signature === publishedSignature) return Promise.resolve(false);

    inFlight = publish(appids)
        .then((result) => {
            if (!result?.success) {
                console.warn('[成就收藏册 · 插件] 展柜封面同步失败', result?.error ?? result);
                return false;
            }
            publishedSignature = signature;
            console.info(`[成就收藏册 · 插件] 展柜封面列表已同步：${appids.length} 个 appid`);
            return true;
        })
        .catch((err) => {
            console.warn('[成就收藏册 · 插件] 展柜封面同步失败', err);
            return false;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}
