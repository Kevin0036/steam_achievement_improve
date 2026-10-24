/**
 * 成就收藏册 · 本地派生缓存
 *
 * 定位：**缓存，不是数据源**。
 *   唯一作用是让卡包打开时立刻有内容，随后用客户端数据静默校正。
 *   任何情况下都不允许用缓存去覆盖客户端状态（铁律 3）。
 *
 * 三份缓存：
 *   state    —— 规范化后的卡片数组，TTL 24 小时，只用于首屏
 *   dates    —— appid → 完成时间 / 稀有成就数。来自按需请求，代价高。
 *               完成时间是既成事实，不会过期：只要成就总数没变，它就一直有效
 *               （游戏加了新成就 → 总数变了 → 这一条作废，等重新全成就后再取）。
 *               稀有数带独立版本；旧统计失效时只清稀有数并保留完成日期，随后由 store 刷新。
 *               每条各自记录取回时间，稀有数（全球解锁率会慢慢漂移）由 store 每次少量轮换刷新，
 *               不会出现「到期那天整册几百个请求一起重来」。
 *               读取失败的不落盘：下次打开卡包会重试。
 *   shelved  —— 已经收进册子的 appid。和当前全成就列表一比，多出来的就是「新收录」，
 *               首次进入卡包时播放入册动画（见 book.js introduce）。
 *   order    —— 「顺序入册」的稳定次序（只追加）。旧卡的编号与位置不随新卡变化。
 *   position —— 上次离开时翻到哪一页。记 appid（该页第一张卡）和页码，回来时优先按 appid
 *               锚定，卡片重排 / 每页数量改了也不会飘走。
 *   manual   —— 用户手动填的完成日期（appid → 秒级时间戳）。优先级高于成就接口：
 *               家庭共享移除、游戏已不在库里等取不到日期的卡，靠它进入时间排序和年份页。
 *               和日期缓存分开存，清除手动日期时还能退回接口取到的值。
 */

import { CACHE_VERSION } from './selectors.js';
import { log, warn, tagged } from './utils.js';

const out = tagged('cache');

const NS = 'ac';
const KEY_STATE = `${NS}:v${CACHE_VERSION}:state`;
const KEY_DATES = `${NS}:v${CACHE_VERSION}:completed`;
const KEY_SHELVED = `${NS}:v${CACHE_VERSION}:shelved`;
const KEY_ORDER = `${NS}:v${CACHE_VERSION}:order`;
const KEY_POSITION = `${NS}:v${CACHE_VERSION}:position`;
const KEY_YEAR_SELECTIONS = `${NS}:v${CACHE_VERSION}:yearpages`;
const KEY_MANUAL = `${NS}:v${CACHE_VERSION}:manual`;
const RARE_CACHE_VERSION = 4;
// 完成日期缓存换过两次格式：:dates 是在成就接口还没接通时写下的（失败名单不可信），
// :completion 整份共用一个 30 天期限。两者都直接弃用，见 readDates()。
const LEGACY_KEYS_DATES = [`${NS}:v${CACHE_VERSION}:dates`, `${NS}:v${CACHE_VERSION}:completion`];

const TTL_STATE_MS = 24 * 60 * 60 * 1000;

function storage() {
    try {
        // Steam 里 localStorage 一定可用；私有模式等异常情况走内存兜底
        if (typeof localStorage !== 'undefined') {
            const probeKey = `${NS}:probe`;
            localStorage.setItem(probeKey, '1');
            localStorage.removeItem(probeKey);
            return localStorage;
        }
    } catch (err) {
        warn('localStorage 不可用，改用内存缓存', err);
    }
    return memoryStorage();
}

function memoryStorage() {
    const map = new Map();
    return {
        // 必须实现 length / key()，否则 clearAll() 会静默失效
        get length() {
            return map.size;
        },
        key: (i) => [...map.keys()][i] ?? null,
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
        removeItem: (k) => map.delete(k),
    };
}

let store = null;
function getStore() {
    if (!store) store = storage();
    return store;
}

function readJson(key) {
    try {
        const raw = getStore().getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.version !== CACHE_VERSION) {
            out.log(`缓存版本不匹配（${parsed.version} → ${CACHE_VERSION}），丢弃`);
            getStore().removeItem(key);
            return null;
        }
        return parsed;
    } catch (err) {
        warn('读取缓存失败，按没有缓存处理', err);
        try {
            getStore().removeItem(key);
        } catch {}
        return null;
    }
}

function writeJson(key, payload) {
    try {
        getStore().setItem(key, JSON.stringify({ version: CACHE_VERSION, ...payload }));
    } catch (err) {
        // 配额满了不能影响功能，静默降级
        warn('写入缓存失败（不影响功能）', err);
    }
}

/* ── 卡片快照 ───────────────────────────────────────────────────────────── */

export function readState() {
    const parsed = readJson(KEY_STATE);
    if (!parsed) return null;

    const cards = (Array.isArray(parsed.cards) ? parsed.cards : []).map((card) =>
        parsed.rareVersion === RARE_CACHE_VERSION ? card : {
            ...card, rare: null, common: null, unrated: card.total ?? null,
        },
    );

    const age = Date.now() - (parsed.savedAt ?? 0);
    if (age > TTL_STATE_MS) {
        out.log('卡片缓存已过期（仅影响首屏速度）');
        return { cards, savedAt: parsed.savedAt ?? 0, stale: true };
    }

    return { cards, savedAt: parsed.savedAt ?? 0, stale: false };
}

export function writeState(cards) {
    writeJson(KEY_STATE, { rareVersion: RARE_CACHE_VERSION, savedAt: Date.now(), cards });
}

/* ── 完成日期（以及同一次请求里顺带算出的稀有成就数） ──────────────────── */

/**
 * @typedef {{completedAt:number, rare:number|null, common:number|null, unrated:number|null, total:number, fetchedAt:number}} DateEntry
 * @returns {Map<number, DateEntry>}
 */
export function readDates() {
    for (const key of LEGACY_KEYS_DATES) {
        try {
            getStore().removeItem(key);
        } catch {
            // 删不掉也不影响
        }
    }

    const dates = new Map();
    const parsed = readJson(KEY_DATES);
    const rareIsCurrent = parsed?.rareVersion === RARE_CACHE_VERSION;
    for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        const [appid, completedAt, rare, total, fetchedAt, common, unrated] = Array.isArray(row) ? row : [];
        if (!Number.isFinite(appid) || !Number.isFinite(completedAt) || !Number.isFinite(total)) continue;
        dates.set(appid, {
            completedAt,
            rare: rareIsCurrent && Number.isFinite(rare) ? rare : null,
            common: rareIsCurrent && Number.isFinite(common) ? common : null,
            unrated: rareIsCurrent && Number.isFinite(unrated) ? unrated : null,
            total,
            fetchedAt: rareIsCurrent && Number.isFinite(fetchedAt) ? fetchedAt : 0,
        });
    }
    return dates;
}

/** @param {Map<number, DateEntry>} dates */
export function writeDates(dates) {
    writeJson(KEY_DATES, {
        rareVersion: RARE_CACHE_VERSION,
        entries: [...dates].map(([appid, d]) => [appid, d.completedAt, d.rare, d.total, d.fetchedAt, d.common, d.unrated]),
    });
}

/* ── 已收进册子的游戏 ───────────────────────────────────────────────────── */

/** @returns {Set<number> | null}  null = 从来没记录过（第一次打开卡包） */
export function readShelved() {
    const parsed = readJson(KEY_SHELVED);
    if (!Array.isArray(parsed?.appids)) return null;
    return new Set(parsed.appids.filter(Number.isFinite));
}

export function writeShelved(appids) {
    writeJson(KEY_SHELVED, { appids: [...appids] });
}

/* ── 顺序入册的稳定次序 ─────────────────────────────────────────────────── */

/**
 * 「顺序入册」的 appid 次序 = 入册先后。
 * 只追加、不重排、不删除：旧卡的编号和位置因此永远不变；
 * 中间的游戏暂时读不到时也不会把后面的卡往前挤。
 *
 * @returns {number[]}
 */
export function readOrder() {
    const parsed = readJson(KEY_ORDER);
    if (!Array.isArray(parsed?.appids)) return [];
    return [...new Set(parsed.appids.filter(Number.isFinite))];
}

/** @param {number[]} appids */
export function writeOrder(appids) {
    const clean = [...new Set(appids.filter(Number.isFinite))];
    if (clean.length === 0) return;
    writeJson(KEY_ORDER, { appids: clean });
}

/* ── 上次翻到的位置 ─────────────────────────────────────────────────────── */

/** @returns {{page:number, appid:number|null} | null} */
export function readPosition() {
    const parsed = readJson(KEY_POSITION);
    if (!parsed) return null;
    return {
        page: Number.isFinite(parsed.page) ? Math.max(0, Math.trunc(parsed.page)) : 0,
        appid: Number.isFinite(parsed.appid) ? parsed.appid : null,
    };
}

/** @param {{page:number, appid:number|null}} position */
export function writePosition(position) {
    if (!Number.isFinite(position?.page)) return;
    writeJson(KEY_POSITION, {
        page: Math.max(0, Math.trunc(position.page)),
        appid: Number.isFinite(position.appid) ? position.appid : null,
    });
}

/* ── 年份特殊页的选择 ───────────────────────────────────────────────────── */

/**
 * 每年三个徽章槽 + 三个横幅槽。
 * 徽章项为 { appid, level }（level 为 1–5、'foil' 或 'cover'），横幅项为 appid；
 * 空槽用 null 占位。读不出来的数据一律丢掉，不让坏缓存弄坏整页。
 *
 * @returns {Record<string, {badges: Array, banners: Array}>}
 */
export function readYearSelections() {
    const parsed = readJson(KEY_YEAR_SELECTIONS);
    const result = {};
    if (!parsed || typeof parsed.years !== 'object' || !parsed.years) return result;
    for (const [year, raw] of Object.entries(parsed.years)) {
        if (!raw || typeof raw !== 'object') continue;
        const badges = (Array.isArray(raw.badges) ? raw.badges : []).slice(0, 3).map((item) => {
            if (item?.appid == null || item.appid === '') return null;
            const appid = Number(item.appid);
            if (!Number.isFinite(appid)) return null;
            const level = item.level === 'foil' || item.level === 'cover' ? item.level : Number(item.level);
            if (level !== 'foil' && level !== 'cover' && !(Number.isFinite(level) && level >= 1 && level <= 5)) return null;
            return { appid, level };
        });
        const banners = (Array.isArray(raw.banners) ? raw.banners : []).slice(0, 3).map((appid) => {
            if (appid == null || appid === '') return null;
            const id = Number(appid);
            return Number.isFinite(id) ? id : null;
        });
        while (badges.length < 3) badges.push(null);
        while (banners.length < 3) banners.push(null);
        result[year] = { badges, banners };
    }
    return result;
}

/** @param {Record<string, {badges: Array, banners: Array}>} selections */
export function writeYearSelections(selections) {
    const years = {};
    for (const [year, raw] of Object.entries(selections ?? {})) {
        if (!raw || typeof raw !== 'object') continue;
        const badges = (Array.isArray(raw.badges) ? raw.badges : []).slice(0, 3);
        const banners = (Array.isArray(raw.banners) ? raw.banners : []).slice(0, 3);
        if (badges.every((item) => !item) && banners.every((item) => !item)) continue;
        years[year] = { badges, banners };
    }
    writeJson(KEY_YEAR_SELECTIONS, { years });
}

/* ── 手动补的完成日期 ───────────────────────────────────────────────────── */

/** @returns {Map<number, number>} appid → 秒级时间戳 */
export function readManualDates() {
    const manual = new Map();
    const parsed = readJson(KEY_MANUAL);
    for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        const [appid, completedAt] = Array.isArray(row) ? row : [];
        if (!Number.isFinite(appid) || !Number.isFinite(completedAt) || completedAt <= 0) continue;
        manual.set(appid, completedAt);
    }
    return manual;
}

/** @param {Map<number, number>} manual */
export function writeManualDates(manual) {
    writeJson(KEY_MANUAL, { entries: [...manual].filter(([appid, at]) => Number.isFinite(appid) && Number.isFinite(at)) });
}

/* ── 清理 ───────────────────────────────────────────────────────────────── */

/** 回滚用：删掉本项目写下的全部 localStorage 键，无任何副作用 */
export function clearAll() {
    try {
        const s = getStore();
        const doomed = [];
        for (let i = 0; i < s.length; i += 1) {
            const key = s.key(i);
            if (key && key.startsWith(`${NS}:`)) doomed.push(key);
        }
        doomed.forEach((key) => s.removeItem(key));
        out.log(`已清理 ${doomed.length} 个缓存键`);
        return doomed.length;
    } catch (err) {
        warn('清理缓存失败', err);
        return 0;
    }
}

export const CACHE_KEYS = { KEY_STATE, KEY_DATES, KEY_SHELVED, KEY_ORDER, KEY_POSITION, KEY_YEAR_SELECTIONS, KEY_MANUAL };
