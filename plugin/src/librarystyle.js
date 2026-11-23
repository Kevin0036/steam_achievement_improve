/**
 * 库内成就进度展示（「穹光地平线」Horizon Aura）的样式注入与轻量 DOM 同步。
 *
 * 插件模块的 document 与真正显示游戏库的窗口不是同一个；原来要等第一次打开
 * 成就卡包、卡包在主窗口里挂载时，才顺带把样式补进那个文档——在此之前按完成度
 * 排序看到的还是 Valve 的旧样式。这里在插件加载时就通过 Millennium 的窗口钩子
 * 拿到每个 Steam 窗口（"SP ..."）的 document，直接注入样式并挂上轻量观察器：
 *
 *   1. 样式层：只注入 art + tokens + library 三份，互不干扰卡册主样式；
 *   2. 同步层：对桌面端带有成就完成度文字（._2EqIgCcLt4h8d4NKik-VAp）的信息条，
 *      解析百分比写入 --ac-pct / data-ac-pct / data-ac-tier，并追加一层只读的
 *      <span class="ac-hz"> 渲染穹光排印、进度光轨与星仪徽印；
 *   3. 全集合校准：Steam 本地的 achievement_progress.json 在游戏新增成就集合后，
 *      若玩家没再启动过该游戏（rt_last_time_played <= cache_time）不会自动刷新，
 *      库内 DOM 仍只画 1 枚本体奖杯。这里结合卡册已经向 Steam 服务端核实过的
 *      allSets 缓存（ac:v1:<账号>:sets / state），为已确认全集合完成的 100% 卡片
 *      补上 data-ac-sets="all"，让「全卷无瑕」与卡册保持同一口径。
 *
 * 绝不删除或改写 React 自己维护的子节点（仅用 CSS 隐藏原生文字 span），并在排序
 * 切换离开成就完成度时自动清理，确保虚拟滚动复用节点与卸载过程零报错、零闪屏。
 */

import artCss from '../../src/css/ac/art.css';
import tokensCss from '../../src/css/ac/tokens.css';
import libraryCss from '../../src/css/ac/library.css';
import gameachCss from '../../src/css/ac/gameach.css';
import { syncBottomBarPets } from './bottombarpets.js';

const STYLE_ID = 'ac-library-style';
// tokens.css 顶部有一句 @import ./art.css；art.css 已经拼在最前面，去掉避免相对路径 404
const CSS = `${artCss}\n${tokensCss}\n${libraryCss}\n${gameachCss}`.replace(/@import\s+url\(["']?\.\/[^)]+\);?/g, '');

const CARD_CLASS = '_1pwP4eeP1zQD7PEgmsep0W';
const COVER_CLASS = 'WYgDg9NyCcMIVuMyZ_NBC';
const PILL_CLASS = '_1LJqx_qFOC8199RBQO5kU8';
const FULL_TEXT_CLASS = '_2EqIgCcLt4h8d4NKik-VAp';
const SHORT_TEXT_CLASS = 'LTPd1K0p7pbPS9nEgQGLs';
const ALL_ACHIEVED_CLASS = '_1fddiVOLgn9nNxAEDjyV4k';
const DLC_FROM_2_CLASS = '-zN46pB8pmZXuCZhPxSMN';
const DLC_FROM_3_CLASS = 'ZIGP3oO2DN1MGwxWyf54t';
const HZ_CLASS = 'ac-hz';

// 游戏详情页 & 成就详情页实时水合目标（桌面端）
const GP_HIGHLIGHT_CLASS = '_2xTb6N-jUUQ-mIkMB6OVMm';
const DETAIL_HEADING_CLASS = '_2Cap9kDsIiQhd0jROKcZh1';
const DETAIL_ALL_COMPLETE_CLASS = '_1GSxIoYhz0hxXOYI0_NNnl';
const DETAIL_UNLOCKED_COUNT_CLASS = '_2d9vai7rjfYszJbUlShoM6';
const SUMMARY_COMPACT_CLASS = 'ac-summary-compact';
const MINI_ACH_CLASS = 'UAhWiMg9Q2VPsQQBj_ikT';
const MINI_COUNT_CLASS = '_2muiKHUkOiTvX-6arqnQUC';
const MINI_BAR_FILL_CLASS = '_1FnTqlsi2_-TJf1d5apoS6';
const SEG_UNLOCKED_CLASS = '_3WOeX9PHv29FSw4EKlG77h';
const SEG_DLC_CLASS = '_2enJwIutXoVwW16Bbu6S6O';
const AWARD_STACK_CLASS = '_2EZqJBCxzsAuIxcN4FeHLr';
const AWARD_DLC_CLASS = '_3K-0Zj_9geS1PUGbZyxt94';
const PBAR_FX_CLASS = 'ac-pbar-fx';
const PBAR_TIP_CLASS = 'ac-pbar-tip';

const seen = new Set();
const observers = new WeakMap();
let startupRetriesStarted = false;
let liveAllSetsIds = new Set();
let allSetsIds = new Set();
let allSetsSignature = '';

/** 与 datasource.js getAccountFingerprint 保持完全一致的 FNV-1a 32 位账号指纹 */
function getCurrentAccountScope() {
    try {
        const steamid =
            window.App?.GetCurrentUser?.()?.strSteamID ??
            window.opener?.App?.GetCurrentUser?.()?.strSteamID ??
            null;
        if (!steamid) return null;
        let hash = 2166136261;
        const text = String(steamid);
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    } catch {
        return null;
    }
}

function addPositiveAppid(set, value) {
    const n = Number(value);
    if (Number.isInteger(n) && n > 0 && n < 4294967296) set.add(n);
}

/** 读取当前账号已由卡册向 Steam 服务端核实过的全集合（本体 + 全部 DLC）appid 列表 */
export function readVerifiedAllSets(extraIds = null) {
    const ids = new Set();
    if (Array.isArray(extraIds)) {
        liveAllSetsIds = new Set();
        for (const id of extraIds) addPositiveAppid(liveAllSetsIds, id);
    }
    for (const id of liveAllSetsIds) ids.add(id);

    try {
        const scope = getCurrentAccountScope();
        const setKeys = scope ? [`ac:v1:${scope}:sets`, 'ac:v1:sets'] : ['ac:v1:sets'];
        const stateKeys = scope ? [`ac:v1:${scope}:state`, 'ac:v1:state'] : ['ac:v1:state'];

        for (const key of setKeys) {
            const raw = window.localStorage?.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw);
                for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) {
                    const [appid, entry] = Array.isArray(row) ? row : [];
                    if (entry?.sets?.allSets === true) addPositiveAppid(ids, appid);
                }
            } catch {
                /* 忽略损坏缓存 */
            }
            // 命中有作用域的键后不再读取旧无前缀键，避免串号
            if (scope && key.includes(`:${scope}:`)) break;
        }

        for (const key of stateKeys) {
            const raw = window.localStorage?.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw);
                for (const card of Array.isArray(parsed?.cards) ? parsed.cards : []) {
                    if (card?.allSets === true && card?.source !== 'external') {
                        addPositiveAppid(ids, card.appid);
                    }
                }
            } catch {
                /* 忽略损坏缓存 */
            }
            if (scope && key.includes(`:${scope}:`)) break;
        }
    } catch {
        /* localStorage 不可用时仅靠 Valve DOM */
    }
    return ids;
}

/** 同步内存中保存的 allSets 集合；有变动时返回 true */
function syncAllSetsCache(extraIds = null) {
    const next = readVerifiedAllSets(extraIds);
    const sig = [...next].sort((a, b) => a - b).join(',');
    const changed = sig !== allSetsSignature;
    allSetsIds = next;
    allSetsSignature = sig;
    return changed;
}

function appidFromReactFiber(el) {
    if (!el) return null;
    try {
        let fiber = null;
        for (const key of Object.keys(el)) {
            if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$')) {
                fiber = el[key];
                break;
            }
        }
        for (let cur = fiber, hops = 0; cur && hops < 16; cur = cur.return, hops += 1) {
            const props = cur.memoizedProps || cur.pendingProps;
            const candidate =
                props?.appid ??
                props?.app?.appid ??
                props?.details?.unAppID ??
                props?.overview?.appid;
            const num = Number(candidate);
            if (Number.isInteger(num) && num > 0) return num;
        }
    } catch {
        /* 忽略跨窗口/React 内部异常 */
    }
    return null;
}

function getCardAppid(pill) {
    const card = pill?.closest?.(`.${CARD_CLASS}`) ?? null;
    const fromPill = appidFromReactFiber(pill);
    if (fromPill) return fromPill;
    const fromCard = appidFromReactFiber(card);
    if (fromCard) return fromCard;
    if (!card) return null;

    const attrId = Number(card.dataset?.acAppid);
    if (Number.isInteger(attrId) && attrId > 0) return attrId;

    const imgs = card.querySelectorAll(`.${COVER_CLASS} img[src]`);
    for (const img of imgs) {
        const src = img.getAttribute('src') || '';
        const match = /\/(?:assets|apps)\/(\d+)(?:[/_?#]|$)/.exec(src);
        if (match) {
            const num = Number.parseInt(match[1], 10);
            if (Number.isInteger(num) && num > 0) return num;
        }
    }
    return null;
}

/** 解析百分比整数（兼容中 / 英 / 各类本地化格式，例如「已完成 95%」「95% Complete」「%95」） */
function parsePercent(pill) {
    const shortEl = pill.querySelector(`.${SHORT_TEXT_CLASS}`);
    const fullEl = pill.querySelector(`.${FULL_TEXT_CLASS}`);
    const raw = (shortEl?.textContent || fullEl?.textContent || '').trim();
    const match = raw.match(/\d+/);
    if (!match) return null;
    const value = Number.parseInt(match[0], 10);
    if (!Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, value));
}

function isBaseOrAllComplete(pill) {
    if (pill.classList.contains(ALL_ACHIEVED_CLASS)) return true;
    return Boolean(pill.querySelector(`.${DLC_FROM_2_CLASS}, .${DLC_FROM_3_CLASS}`));
}

function clearHorizon(pill) {
    const layer = pill.querySelector(`:scope > .${HZ_CLASS}`);
    if (layer) layer.remove();
    if (pill.dataset.acHz !== undefined) delete pill.dataset.acHz;
    if (pill.dataset.acPct !== undefined) delete pill.dataset.acPct;
    if (pill.dataset.acTier !== undefined) delete pill.dataset.acTier;
    if (pill.dataset.acSets !== undefined) delete pill.dataset.acSets;
    if (pill.style.getPropertyValue('--ac-pct')) pill.style.removeProperty('--ac-pct');
}

function createHorizonLayer(doc) {
    const root = doc.createElement('span');
    root.className = HZ_CLASS;
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML =
        '<span class="ac-hz-sheen"></span>' +
        '<span class="ac-hz-scrim"></span>' +
        '<span class="ac-hz-aura"></span>' +
        '<span class="ac-hz-dust"></span>' +
        '<span class="ac-hz-content">' +
            '<span class="ac-hz-num-block">' +
                '<span class="ac-hz-num">' +
                    '<span class="ac-hz-digits"></span>' +
                    '<span class="ac-hz-sym">%</span>' +
                '</span>' +
            '</span>' +
            '<span class="ac-hz-crest"></span>' +
        '</span>' +
        '<span class="ac-hz-rail"><span class="ac-hz-beam"></span></span>';
    return root;
}

/** 同步单个信息条到「穹光地平线」状态（幂等，未变化时不碰 DOM） */
export function hydrateHorizonPill(pill, doc = pill?.ownerDocument) {
    if (!pill || !doc) return;
    // Big Picture / Gamepad 模式结构不同，跳过
    if (pill.closest?.('.BasicUI')) {
        clearHorizon(pill);
        return;
    }
    const fullEl = pill.querySelector(`.${FULL_TEXT_CLASS}`);
    if (!fullEl) {
        clearHorizon(pill);
        return;
    }
    const pct = parsePercent(pill);
    if (pct === null) {
        clearHorizon(pill);
        return;
    }

    const done = isBaseOrAllComplete(pill);
    const tier = done ? 'done' : pct >= 90 && pct < 100 ? 'near' : pct >= 40 ? 'mid' : 'low';
    const pctStr = String(pct);

    if (pill.dataset.acHz !== '1') pill.dataset.acHz = '1';
    if (pill.dataset.acPct !== pctStr) pill.dataset.acPct = pctStr;
    if (pill.dataset.acTier !== tier) pill.dataset.acTier = tier;
    if (pill.style.getPropertyValue('--ac-pct') !== pctStr) {
        pill.style.setProperty('--ac-pct', pctStr);
    }

    // 仅在 100%（AllAchieved）且卡册已核实全集合完成时补标 data-ac-sets="all"，修正 Steam 本地旧缓存
    if (pct === 100 && pill.classList.contains(ALL_ACHIEVED_CLASS) && allSetsIds.size > 0) {
        const appid = getCardAppid(pill);
        if (appid && allSetsIds.has(appid)) {
            if (pill.dataset.acSets !== 'all') pill.dataset.acSets = 'all';
        } else if (pill.dataset.acSets !== undefined) {
            delete pill.dataset.acSets;
        }
    } else if (pill.dataset.acSets !== undefined) {
        delete pill.dataset.acSets;
    }

    let layer = pill.querySelector(`:scope > .${HZ_CLASS}`);
    if (!layer) {
        layer = createHorizonLayer(doc);
        pill.appendChild(layer);
    }
    const digits = layer.querySelector('.ac-hz-digits');
    if (digits && digits.textContent !== pctStr) {
        digits.textContent = pctStr;
    }
}

const STAR_SLOTS = [16, 78, 36, 84, 52, 24, 68, 42, 80, 28];
const GOLDEN_RATIO = 0.6180339887498949;
const PBAR_STARS_HTML = (() => {
    let html = '';
    for (let i = 0; i < STAR_SLOTS.length; i += 1) {
        const phase = ((i + 1) * GOLDEN_RATIO) % 1;
        const dur = 5.4 + (i % 4) * 0.95;
        const delay = -(phase * dur);
        const b = (0.6 + ((i * 37) % 10) * 0.04).toFixed(2);
        html += `<span class="ac-pbar-star" style="top:${STAR_SLOTS[i]}%;animation-duration:${dur.toFixed(2)}s;animation-delay:${delay.toFixed(2)}s"><i style="--sb:${b}"></i></span>`;
    }
    return html;
})();

/** 从 60747 Grid 进度条的 grid-template-columns ("79fr 11fr" / "32fr 4fr 8fr") 精确计算填充百分比 */
function parseGridTrackPct(track) {
    if (!track) return null;
    const raw = track.style?.gridTemplateColumns || track.getAttribute?.('style') || '';
    const frMatches = [...raw.matchAll(/([\d.]+)\s*fr\b/gi)].map((m) => Number.parseFloat(m[1]));
    if (frMatches.length >= 2) {
        const total = frMatches.reduce((a, b) => a + b, 0);
        if (total > 0) {
            const unlocked = frMatches.slice(0, -1).reduce((a, b) => a + b, 0);
            return Math.max(0, Math.min(100, (unlocked / total) * 100));
        }
    }
    return null;
}

function parseRatioOrPctFromText(text) {
    if (!text) return null;
    const ratio = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)/.exec(text);
    if (ratio) {
        const u = Number.parseInt(ratio[1].replace(/,/g, ''), 10);
        const t = Number.parseInt(ratio[2].replace(/,/g, ''), 10);
        if (Number.isFinite(u) && Number.isFinite(t) && t > 0) {
            return Math.max(0, Math.min(100, (u / t) * 100));
        }
    }
    const pct = /(\d+)\s*%/.exec(text);
    if (pct) {
        const v = Number.parseInt(pct[1], 10);
        if (Number.isFinite(v)) return Math.max(0, Math.min(100, v));
    }
    return null;
}

function ensureProgressBarOverlays(track, doc) {
    if (!track || !doc) return;
    if (!track.querySelector(`:scope > .${PBAR_FX_CLASS}`)) {
        const fx = doc.createElement('span');
        fx.className = PBAR_FX_CLASS;
        fx.setAttribute('aria-hidden', 'true');
        fx.innerHTML = `<span class="ac-pbar-sweep"></span><span class="ac-pbar-stars">${PBAR_STARS_HTML}</span>`;
        track.appendChild(fx);
    }
    if (!track.querySelector(`:scope > .${PBAR_TIP_CLASS}`)) {
        const tip = doc.createElement('span');
        tip.className = PBAR_TIP_CLASS;
        tip.setAttribute('aria-hidden', 'true');
        track.appendChild(tip);
    }
}

/** 精简成就详情页顶部概览文字（隐藏冗长多行原文，安全追加单行精炼排印，不改动 React 子节点） */
function hydrateSummaryUnlockedCount(host, doc) {
    if (!host?.classList?.contains(DETAIL_HEADING_CLASS)) return;
    const box = host.querySelector(`.${DETAIL_UNLOCKED_COUNT_CLASS}`);
    if (!box) return;

    let primaryText = '';
    for (let i = 0; i < box.children.length; i += 1) {
        const child = box.children[i];
        if (!child.classList?.contains(SUMMARY_COMPACT_CLASS)) {
            primaryText = (child.textContent || '').trim();
            break;
        }
    }
    if (!primaryText) return;

    const pctMatch = /(\d+)\s*%/.exec(primaryText);
    const beforeParen = primaryText.replace(/[（(][^）)]*[）)]/g, ' ');
    const nums = [...beforeParen.matchAll(/\d[\d,]*/g)].map((m) => m[0]);
    if (nums.length < 2) {
        if (box.dataset.acCompact !== undefined) delete box.dataset.acCompact;
        const old = box.querySelector(`:scope > .${SUMMARY_COMPACT_CLASS}`);
        if (old) old.remove();
        return;
    }

    const unlockedStr = nums[0];
    const totalStr = nums[1];
    let pctStr = pctMatch ? pctMatch[1] : '';
    if (!pctStr) {
        const u = Number.parseInt(unlockedStr.replace(/,/g, ''), 10);
        const t = Number.parseInt(totalStr.replace(/,/g, ''), 10);
        pctStr = t > 0 ? String(Math.round((u / t) * 100)) : '0';
    }

    const labelText = /[\u3040-\u30ff]/.test(primaryText)
        ? '解除済み'
        : primaryText.includes('解鎖')
            ? '已解鎖'
            : /[\u4e00-\u9fff]/.test(primaryText)
                ? '已解锁'
                : 'Unlocked';
    const sig = `${labelText}|${unlockedStr}|${totalStr}|${pctStr}`;

    if (box.dataset.acCompact !== '1') box.dataset.acCompact = '1';
    let compact = box.querySelector(`:scope > .${SUMMARY_COMPACT_CLASS}`);
    if (!compact) {
        compact = doc.createElement('span');
        compact.className = SUMMARY_COMPACT_CLASS;
        compact.setAttribute('aria-hidden', 'true');
        compact.innerHTML =
            '<span class="ac-sc-label"></span>' +
            '<span class="ac-sc-ratio"><span class="ac-sc-u"></span><span class="ac-sc-slash">/</span><span class="ac-sc-t"></span></span>' +
            '<span class="ac-sc-pct"></span>';
        box.appendChild(compact);
    }
    if (compact.dataset.acSig !== sig) {
        compact.dataset.acSig = sig;
        const elLabel = compact.querySelector('.ac-sc-label');
        const elU = compact.querySelector('.ac-sc-u');
        const elT = compact.querySelector('.ac-sc-t');
        const elPct = compact.querySelector('.ac-sc-pct');
        if (elLabel) elLabel.textContent = labelText;
        if (elU) elU.textContent = unlockedStr;
        if (elT) elT.textContent = totalStr;
        if (elPct) elPct.textContent = `${pctStr}%`;
    }
}

/** 同步游戏页右侧「成就」抬头与成就详情页概览框的状态档位、全集合徽章校准与星尘叠层 */
export function hydrateGameAchHeader(host, doc = host?.ownerDocument) {
    if (!host || !doc || host.closest?.('.BasicUI')) return;

    hydrateSummaryUnlockedCount(host, doc);

    const firstSeg = host.querySelector(`.${SEG_UNLOCKED_CLASS}`);
    const track = firstSeg?.parentElement ?? null;
    let pctFloat = parseGridTrackPct(track);
    if (pctFloat === null) pctFloat = parseRatioOrPctFromText(host.textContent || '');
    if (pctFloat === null) return;

    const pctRounded = Math.round(pctFloat);
    const pctCss = `${Number(pctFloat.toFixed(2))}%`;
    const pctIntStr = String(pctRounded);

    const hasDlcAward = Boolean(host.querySelector(`.${AWARD_STACK_CLASS}.${AWARD_DLC_CLASS}`));
    const hasDlcSeg = Boolean(track?.querySelector(`:scope > .${SEG_DLC_CLASS}`));
    const hasAllGroupsBanner = Boolean(host.closest?.(`.${DETAIL_ALL_COMPLETE_CLASS}`));
    const appid = appidFromReactFiber(host);
    const verifiedAll = Boolean(appid && allSetsIds.has(appid));

    const isComplete = pctRounded >= 100;
    const isAllSets = isComplete && (hasDlcAward || (hasAllGroupsBanner && hasDlcSeg) || verifiedAll);
    const tier = isAllSets ? 'all100' : isComplete ? 'base100' : pctRounded >= 90 ? 'near' : 'progress';

    if (host.dataset.acPct !== pctIntStr) host.dataset.acPct = pctIntStr;
    if (host.dataset.acTier !== tier) host.dataset.acTier = tier;
    if (host.style.getPropertyValue('--ac-pct') !== pctCss) host.style.setProperty('--ac-pct', pctCss);

    if (isAllSets) {
        if (host.dataset.acSets !== 'all') host.dataset.acSets = 'all';
    } else if (host.dataset.acSets !== undefined) {
        delete host.dataset.acSets;
    }

    if (track) ensureProgressBarOverlays(track, doc);
}

/** 同步游戏页顶部开始栏成就概览条（MiniAchievements） */
export function hydrateMiniAchievements(mini) {
    if (!mini || mini.closest?.('.BasicUI')) return;
    const countEl = mini.querySelector(`.${MINI_COUNT_CLASS}`);
    let pctFloat = parseRatioOrPctFromText(countEl?.textContent || '');
    if (pctFloat === null) {
        const fill = mini.querySelector(`.${MINI_BAR_FILL_CLASS}`);
        const w = fill?.style?.width || '';
        const m = /([\d.]+)%/.exec(w);
        if (m) pctFloat = Number.parseFloat(m[1]);
    }
    if (pctFloat === null || !Number.isFinite(pctFloat)) return;

    const pctRounded = Math.round(pctFloat);
    const pctIntStr = String(pctRounded);
    const appid = appidFromReactFiber(mini);
    const verifiedAll = Boolean(appid && allSetsIds.has(appid));
    const isComplete = pctRounded >= 100;
    const tier = isComplete && verifiedAll ? 'all100' : isComplete ? 'base100' : pctRounded >= 90 ? 'near' : 'progress';

    if (mini.dataset.acPct !== pctIntStr) mini.dataset.acPct = pctIntStr;
    if (mini.dataset.acTier !== tier) mini.dataset.acTier = tier;
}

function hydrateAllInDocument(doc) {
    if (!doc?.body) return;
    const existing = doc.getElementsByClassName(PILL_CLASS);
    for (let i = 0; i < existing.length; i += 1) {
        hydrateHorizonPill(existing[i], doc);
    }
    const gpHighlights = doc.getElementsByClassName(GP_HIGHLIGHT_CLASS);
    for (let i = 0; i < gpHighlights.length; i += 1) {
        hydrateGameAchHeader(gpHighlights[i], doc);
    }
    const detailHeads = doc.getElementsByClassName(DETAIL_HEADING_CLASS);
    for (let i = 0; i < detailHeads.length; i += 1) {
        hydrateGameAchHeader(detailHeads[i], doc);
    }
    const minis = doc.getElementsByClassName(MINI_ACH_CLASS);
    for (let i = 0; i < minis.length; i += 1) {
        hydrateMiniAchievements(minis[i]);
    }
}

/** 在指定 Steam 窗口文档上挂载 MutationObserver */
export function observeLibraryDocument(doc) {
    if (!doc?.body) return;
    const prev = observers.get(doc);
    if (prev && prev.root === doc.body) return;
    if (prev) {
        try {
            prev.observer.disconnect();
        } catch {
            /* 忽略 */
        }
    }

    const ObserverCtor = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
    if (typeof ObserverCtor !== 'function') return;

    const observer = new ObserverCtor((records) => {
        const batch = new Set();
        const headerBatch = new Set();
        const miniBatch = new Set();
        const queue = (pill) => {
            if (pill) batch.add(pill);
        };
        const queueHeader = (el) => {
            if (el) headerBatch.add(el);
        };
        const queueMini = (el) => {
            if (el) miniBatch.add(el);
        };
        const queueSubtree = (node) => {
            if (!node || node.nodeType !== 1) return;
            if (node.classList?.contains(HZ_CLASS) || node.classList?.contains(PBAR_FX_CLASS) || node.classList?.contains(PBAR_TIP_CLASS) || node.classList?.contains(SUMMARY_COMPACT_CLASS)) return;
            if (node.classList?.contains(PILL_CLASS)) queue(node);
            if (node.classList?.contains(GP_HIGHLIGHT_CLASS) || node.classList?.contains(DETAIL_HEADING_CLASS)) queueHeader(node);
            if (node.classList?.contains(MINI_ACH_CLASS)) queueMini(node);
            if (node.getElementsByClassName) {
                const pills = node.getElementsByClassName(PILL_CLASS);
                for (let i = 0; i < pills.length; i += 1) queue(pills[i]);
                const gp = node.getElementsByClassName(GP_HIGHLIGHT_CLASS);
                for (let i = 0; i < gp.length; i += 1) queueHeader(gp[i]);
                const dh = node.getElementsByClassName(DETAIL_HEADING_CLASS);
                for (let i = 0; i < dh.length; i += 1) queueHeader(dh[i]);
                const ms = node.getElementsByClassName(MINI_ACH_CLASS);
                for (let i = 0; i < ms.length; i += 1) queueMini(ms[i]);
            }
        };

        for (const m of records) {
            const raw = m.target;
            const el = raw && raw.nodeType === 1 ? raw : raw?.parentElement;
            if (!el) continue;

            // 忽略我们自己叠加层内部产生的变更，杜绝自触发循环
            if (
                el.classList?.contains(HZ_CLASS) ||
                el.classList?.contains(PBAR_FX_CLASS) ||
                el.classList?.contains(PBAR_TIP_CLASS) ||
                el.classList?.contains(SUMMARY_COMPACT_CLASS) ||
                el.closest?.(`.${HZ_CLASS}, .${PBAR_FX_CLASS}, .${SUMMARY_COMPACT_CLASS}`)
            ) {
                continue;
            }

            if (m.type === 'attributes') {
                if (m.attributeName === 'class') {
                    if (el.classList?.contains(PILL_CLASS)) queue(el);
                    const hdr = el.closest?.(`.${GP_HIGHLIGHT_CLASS}, .${DETAIL_HEADING_CLASS}`);
                    if (hdr) queueHeader(hdr);
                    const mn = el.closest?.(`.${MINI_ACH_CLASS}`);
                    if (mn) queueMini(mn);
                } else if (m.attributeName === 'src' && el.tagName === 'IMG') {
                    // 虚拟滚动复用同一个 100% 卡片槽位时，封面 src 变化会触发重新判定 appid / allSets
                    const card = el.closest?.(`.${CARD_CLASS}`);
                    const pill = card?.querySelector(`:scope > .${PILL_CLASS}`);
                    if (pill) queue(pill);
                }
                continue;
            }

            if (m.type === 'characterData') {
                if (el.classList?.contains(SHORT_TEXT_CLASS) || el.classList?.contains(FULL_TEXT_CLASS)) {
                    const pill = el.closest?.(`.${PILL_CLASS}`);
                    if (pill) queue(pill);
                } else if (el.classList?.contains(PILL_CLASS)) {
                    queue(el);
                } else if (el.closest) {
                    const hdr = el.closest(`.${GP_HIGHLIGHT_CLASS}, .${DETAIL_HEADING_CLASS}`);
                    if (hdr) queueHeader(hdr);
                    const mn = el.closest(`.${MINI_ACH_CLASS}`);
                    if (mn) queueMini(mn);
                }
                continue;
            }

            if (m.type === 'childList') {
                if (el.classList?.contains(PILL_CLASS)) {
                    queue(el);
                } else if (el.closest) {
                    const ancestorPill = el.closest(`.${PILL_CLASS}`);
                    if (ancestorPill) queue(ancestorPill);
                    const hdr = el.closest(`.${GP_HIGHLIGHT_CLASS}, .${DETAIL_HEADING_CLASS}`);
                    if (hdr) queueHeader(hdr);
                    const mn = el.closest(`.${MINI_ACH_CLASS}`);
                    if (mn) queueMini(mn);
                }

                for (const node of m.addedNodes) queueSubtree(node);
            }
        }

        for (const pill of batch) {
            if (pill.isConnected) hydrateHorizonPill(pill, doc);
        }
        for (const hdr of headerBatch) {
            if (hdr.isConnected) hydrateGameAchHeader(hdr, doc);
        }
        for (const mn of miniBatch) {
            if (mn.isConnected) hydrateMiniAchievements(mn);
        }
    });

    observer.observe(doc.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'src'],
    });
    observers.set(doc, { observer, root: doc.body });

    // 首屏已有卡片立即水合一次
    hydrateAllInDocument(doc);
}

export function ensureLibraryStyles(doc, { rehydrate = false } = {}) {
    if (!doc?.createElement) return;
    try {
        if (doc.defaultView?.closed) {
            seen.delete(doc);
            return;
        }
        const changed = syncAllSetsCache();
        let style = doc.querySelector(`style[data-ac="${STYLE_ID}"]`);
        if (!style) {
            style = doc.createElement('style');
            style.dataset.ac = STYLE_ID;
            (doc.head || doc.documentElement)?.appendChild(style);
        }
        if (style.textContent !== CSS) style.textContent = CSS;
        if (doc.body) {
            observeLibraryDocument(doc);
            if (rehydrate || changed) hydrateAllInDocument(doc);
            syncBottomBarPets(doc);
        }
        if (seen.size < 8) seen.add(doc);
    } catch {
        // 窗口正在关闭 / 跨域：忽略这一个文档
    }
}

function attachPopupWindow(popup) {
    if (!popup) return;
    try {
        const doc = popup.document;
        if (doc?.body) {
            ensureLibraryStyles(doc);
            return;
        }
        const onReady = () => {
            try {
                if (popup.document?.body) ensureLibraryStyles(popup.document);
            } catch {
                /* 忽略 */
            }
        };
        popup.addEventListener?.('DOMContentLoaded', onReady, { once: true });
        popup.addEventListener?.('load', onReady, { once: true });
        window.setTimeout(onReady, 300);
    } catch {
        /* 忽略 */
    }
}

function collectCandidateDocuments() {
    const candidates = new Set();
    const push = (doc) => {
        try {
            if (doc?.body && !doc.defaultView?.closed) candidates.add(doc);
        } catch {
            /* 忽略 */
        }
    };

    try {
        push(window.PLUGIN_LIST?.core?.mainWindow?.document);
    } catch {
        /* 忽略 */
    }
    try {
        const popups = window.g_PopupManager?.GetPopups?.();
        if (popups) {
            for (const p of popups) {
                if (!p?.m_strName || p.m_strName.startsWith('SP ')) {
                    push(p?.m_popup?.document || p?.window?.document);
                }
            }
        }
    } catch {
        /* 忽略 */
    }
    try {
        const wins = window.SteamUIStore?.WindowStore?.SteamUIWindows;
        if (wins) {
            for (const w of wins) push(w?.BrowserWindow?.document);
        }
    } catch {
        /* 忽略 */
    }
    for (const ref of [window, window.opener, window.top]) {
        try {
            push(ref?.document);
        } catch {
            /* 跨窗口访问被拒时忽略 */
        }
    }
    return candidates;
}

/** 心跳或卡册更新集合判定时补一次：Steam UI 重载后 <style> 会丢，或账号/allSets 刚就绪 */
export function refreshLibraryStyles(extraAllSets = null) {
    const changed = syncAllSetsCache(extraAllSets);

    for (const doc of Array.from(seen)) {
        try {
            if (doc.defaultView?.closed) {
                seen.delete(doc);
                continue;
            }
            if (doc.body) ensureLibraryStyles(doc, { rehydrate: changed });
        } catch {
            seen.delete(doc);
        }
    }

    for (const doc of collectCandidateDocuments()) {
        ensureLibraryStyles(doc, { rehydrate: changed });
    }

    // 启动早期主窗口或当前账号信息可能尚未就绪，补几次短延迟扫描
    if (!startupRetriesStarted) {
        startupRetriesStarted = true;
        for (const delay of [800, 2500, 6000]) {
            window.setTimeout(() => {
                const updated = syncAllSetsCache();
                for (const doc of collectCandidateDocuments()) {
                    ensureLibraryStyles(doc, { rehydrate: updated });
                }
            }, delay);
        }
    }
}

export function installLibraryWindowHook() {
    const register = window.Millennium?.AddWindowCreateHook;
    if (typeof register !== 'function') {
        console.warn('[成就收藏册 · 插件] AddWindowCreateHook 不可用，库内样式需要打开一次卡册才会生效');
        return false;
    }
    try {
        register((win) => {
            if (!win?.m_strName?.startsWith('SP ')) return;
            attachPopupWindow(win.m_popup);
        });
        return true;
    } catch (err) {
        console.warn('[成就收藏册 · 插件] 注册窗口钩子失败，库内样式需要打开一次卡册才会生效', err);
        return false;
    }
}
