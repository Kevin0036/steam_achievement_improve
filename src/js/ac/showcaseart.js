/**
 * 成就收藏册 · 完满主义者展柜：锁区游戏的封面补救
 *
 * 背景：Valve 的展柜封面是服务端按访问者所在地区渲染的。锁区游戏在部分账号上
 *       既没有 <img>，也可能给出一个加载失败的地址，格子只剩一条信息栏。
 *       但成就链接里仍然带着 appid（/stats/<appid>/achievements），
 *       于是可以按 appid 直接重建 CDN 地址。
 *
 * 取图顺序（用户指定的回退链）：
 *   header_schinese → header_tchinese → header_japanese → header
 *   每一档依次尝试 shared.fastly.steamstatic.com → shared.steamstatic.com
 *   → shared.akamai.steamstatic.com。
 *
 * 只探测、不盲改：
 *   · 已有能正常显示的封面 → 一个字节都不动；
 *   · 用 new Image() 先试加载（社区页 CSP 允许 https 图片，但不允许跨域 fetch）；
 *   · 第一个真正加载成功的地址才写回 <img>，失败则留一个占位块；
 *   · 每个格子打 data-ac-cover 标记，MutationObserver 反复重入也不会重复探测。
 */

import { SHOWCASE } from './selectors.js';
import STR from './strings.js';
import { tagged, warn } from './utils.js';

const out = tagged('showcaseart');

const HOSTS = [
    'https://shared.fastly.steamstatic.com',
    'https://shared.steamstatic.com',
    'https://shared.akamai.steamstatic.com',
];
const HEADER_FILES = ['header_schinese.jpg', 'header_tchinese.jpg', 'header_japanese.jpg', 'header.jpg'];

const PROBE_TIMEOUT_MS = 2500;
/** 已有 <img> 正在加载时，最多等这么久；超时仍没结果就当作坏图处理 */
const IMAGE_WAIT_MS = 4000;

/** appid → 可用地址 / null（本轮页面生命周期内记住结论，避免反复探测） */
const resolved = new Map();

export function appidFromHref(href) {
    if (typeof href !== 'string') return null;
    const patterns = [
        /\/stats\/(\d+)(?:\/|$)/,
        /\/apps?\/(\d+)(?:\/|$)/,
        /\/achievements\/(\d+)(?:\/|$)/,
        /[?&]appid=(\d+)/,
    ];
    for (const pattern of patterns) {
        const match = href.match(pattern);
        if (match) return Number(match[1]);
    }
    return null;
}

/** 某款游戏的完整候选地址（语言回退 × 镜像回退），按优先级排列 */
export function coverCandidates(appid) {
    const path = `/store_item_assets/steam/apps/${appid}/`;
    return HOSTS.flatMap((host) => HEADER_FILES.map((file) => `${host}${path}${file}`));
}

function appidFromSlot(slot) {
    const link = slot.querySelector(SHOWCASE.slotLink);
    const fromHref = appidFromHref(link?.getAttribute('href'));
    if (fromHref) return fromHref;

    const img = slot.querySelector(SHOWCASE.cover);
    const src = img?.getAttribute('src') ?? '';
    const match = src.match(/\/apps\/(\d+)(?:\/|$)/);
    return match ? Number(match[1]) : null;
}

/** 用一张脱离文档的图片试加载，不占版面、不触发页面上的 error 图标 */
function loadable(doc, url) {
    return new Promise((resolve) => {
        const ImageCtor = doc.defaultView?.Image ?? globalThis.Image;
        if (typeof ImageCtor !== 'function') return resolve(false);

        const probe = new ImageCtor();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            probe.onload = null;
            probe.onerror = null;
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
        probe.onload = () => finish(probe.naturalWidth > 0);
        probe.onerror = () => finish(false);
        probe.src = url;
    });
}

async function firstLoadable(doc, urls) {
    for (const url of urls) {
        if (await loadable(doc, url)) return url;
    }
    return null;
}

function markMissing(doc, slot, img) {
    img?.remove();
    slot.dataset.acCover = 'missing';
    if (slot.querySelector('.ac-showcase-cover-missing')) return;

    const note = doc.createElement('div');
    note.className = 'ac-showcase-cover-missing';
    note.textContent = STR.showcase.coverMissing;
    const bar = slot.querySelector(SHOWCASE.bar);
    if (bar) bar.before(note);
    else slot.querySelector('a')?.append(note);
}

function placeCover(doc, slot, url, existing) {
    let img = existing;
    if (!img || !img.isConnected) {
        img = doc.createElement('img');
        img.className = 'game_capsule';
        img.alt = '';
        img.decoding = 'async';
        const bar = slot.querySelector(SHOWCASE.bar);
        if (bar) bar.before(img);
        else slot.querySelector('a')?.prepend(img);
    }
    // 探测已经成功过一次；这里再失败通常说明 CDN 状态刚变了，退回占位块
    img.addEventListener('error', () => markMissing(doc, slot, img), { once: true });
    img.src = url;
    slot.dataset.acCover = 'repaired';
    out.log(`已补回封面：appid ${slot.dataset.acAppid ?? '?'}`);
}

function repairSlot(doc, slot, appid, img) {
    if (slot.dataset.acCover === 'loading') return;
    slot.dataset.acCover = 'loading';
    slot.dataset.acAppid = String(appid);

    if (resolved.has(appid)) {
        const url = resolved.get(appid);
        if (url) placeCover(doc, slot, url, img);
        else markMissing(doc, slot, img);
        return;
    }

    firstLoadable(doc, coverCandidates(appid)).then(
        (url) => {
            resolved.set(appid, url);
            if (!slot.isConnected) return;
            if (url) placeCover(doc, slot, url, img);
            else markMissing(doc, slot, img);
        },
        (err) => {
            warn(`探测封面失败：appid ${appid}`, err);
            if (slot.isConnected) markMissing(doc, slot, img);
        },
    );
}

/**
 * 检查一个格子：已有的好图不动；坏图 / 缺图按 appid 重建。
 * @returns {boolean} 这个格子是否需要（或已经开始）处理
 */
function evaluateSlot(doc, slot) {
    const state = slot.dataset.acCover;
    if (state === 'ok' || state === 'repaired' || state === 'loading') return false;
    if (state === 'missing') return false;

    const img = slot.querySelector(SHOWCASE.cover);
    if (img?.complete && img.naturalWidth > 0) {
        slot.dataset.acCover = 'ok';
        return false;
    }

    if (img && !img.complete) {
        // Valve 的图可能只是还没加载完，等它自己给结果，别抢跑
        slot.dataset.acCover = 'waiting';
        const settle = () => {
            if (!slot.isConnected || slot.dataset.acCover !== 'waiting') return;
            slot.removeAttribute('data-ac-cover');
            evaluateSlot(doc, slot);
        };
        img.addEventListener('load', settle, { once: true });
        img.addEventListener('error', settle, { once: true });
        const schedule = (fn, ms) =>
            doc.defaultView?.setTimeout ? doc.defaultView.setTimeout(fn, ms) : setTimeout(fn, ms);
        schedule(() => {
            if (!slot.isConnected || slot.dataset.acCover !== 'waiting') return;
            if (img.complete && img.naturalWidth > 0) {
                slot.dataset.acCover = 'ok';
                return;
            }
            slot.removeAttribute('data-ac-cover');
            const appid = appidFromSlot(slot);
            if (appid) repairSlot(doc, slot, appid, img);
        }, IMAGE_WAIT_MS);
        return false;
    }

    const appid = appidFromSlot(slot);
    if (!appid) return false;
    repairSlot(doc, slot, appid, img);
    return true;
}

/**
 * 给完满主义者展柜里所有缺图 / 坏图的格子补封面。
 * 幂等：可以随 MutationObserver 反复调用。
 */
export function repairShowcaseCovers(root) {
    if (!root?.querySelectorAll) return 0;
    let count = 0;
    for (const slot of root.querySelectorAll(SHOWCASE.slot)) {
        try {
            if (evaluateSlot(root.ownerDocument ?? globalThis.document, slot)) count += 1;
        } catch (err) {
            warn('补封面时出错（已忽略这个格子）', err);
        }
    }
    return count;
}
