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
 *               失败名单独存，区分长期缺失与短暂错误。
 *   shelved  —— 已经收进册子的 appid。和当前全成就列表一比，多出来的就是「新收录」，
 *               首次进入卡包时播放入册动画（见 book.js introduce）。
 *   order    —— 「顺序入册」的稳定次序（只追加）。旧卡的编号与位置不随新卡变化。
 *   position —— 上次离开时翻到哪一页。记 appid（该页第一张卡）和页码，回来时优先按 appid
 *               锚定，卡片重排 / 每页数量改了也不会飘走。
 *   manual   —— 用户手动填的完成日期（appid → 秒级时间戳）。优先级高于成就接口：
 *               家庭共享移除、游戏已不在库里等取不到日期的卡，靠它进入时间排序和年份页。
 *               和日期缓存分开存，清除手动日期时还能退回接口取到的值。
 *   manual-time —— 用户手动填的游玩时长（appid → 分钟）。和手动日期一样只存在本地，
 *               用于 Steam 取不到时长的游戏；清除后同样退回接口值。
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
const KEY_MANUAL_TIME = `${NS}:v${CACHE_VERSION}:manual-time`;
const KEY_EXTRA = `${NS}:v${CACHE_VERSION}:extra`;
const KEY_FAILURES = `${NS}:v${CACHE_VERSION}:failures`;
const RARE_CACHE_VERSION = 4;
// 完成日期缓存换过两次格式：:dates 是在成就接口还没接通时写下的（失败名单不可信），
// :completion 整份共用一个 30 天期限。两者都直接弃用，见 readDates()。
const LEGACY_KEYS_DATES = [`${NS}:v${CACHE_VERSION}:dates`, `${NS}:v${CACHE_VERSION}:completion`];

/**
 * 按账号隔离的键（前缀 `ac:v1:<账号作用域>:`）。
 * 同一个客户端里切换账号时，完成日期 / 顺序 / 手动填写不能互相污染。
 * `ac:v1:extra` 内部已经按账号指纹分桶，保持全局；`ac:v1:share` 也不归这里管。
 */
const SCOPED_KEY_PREFIX = `${NS}:v${CACHE_VERSION}:`;
const SCOPED_LEGACY_KEYS = [
    KEY_STATE, KEY_DATES, KEY_SHELVED, KEY_ORDER, KEY_POSITION,
    KEY_YEAR_SELECTIONS, KEY_MANUAL, KEY_MANUAL_TIME, KEY_FAILURES,
];

/**
 * undefined = 还没确认账号（沿用旧的无前缀键，兼容未升级的调用）；
 * null = 确认了「认不出账号」，只用内存缓存，不落盘；
 * 字符串 = 账号作用域。
 */
let accountScope = null;
let scopeReady = false;

function resolveKey(key) {
    if (!scopeReady || !accountScope) return key;
    if (key === KEY_EXTRA) return key;
    if (!key.startsWith(SCOPED_KEY_PREFIX)) return key;
    return `${SCOPED_KEY_PREFIX}${accountScope}:${key.slice(SCOPED_KEY_PREFIX.length)}`;
}

/** 升级前写下的无前缀缓存只认领一次：复制到第一个登录的账号名下，再删掉旧键 */
function migrateLegacyKeys(scope) {
    const target = (key) => `${SCOPED_KEY_PREFIX}${scope}:${key.slice(SCOPED_KEY_PREFIX.length)}`;
    for (const legacy of SCOPED_LEGACY_KEYS) {
        try {
            const raw = getStore().getItem(legacy);
            if (raw == null) continue;
            const next = target(legacy);
            if (getStore().getItem(next) == null) getStore().setItem(next, raw);
            getStore().removeItem(legacy);
        } catch (err) {
            warn('迁移旧缓存失败（按没有缓存处理）', err);
        }
    }
}

/**
 * 由 store 在确认当前账号后调用（同步）。
 * 切换作用域前先把待写队列落盘，避免上一个账号的数据写到下一个账号名下。
 */
export function setAccountScope(scope) {
    const next = scope == null || scope === '' ? null : String(scope);
    if (scopeReady && accountScope === next) return;
    flushWrites();
    accountScope = next;
    scopeReady = true;
    if (next) migrateLegacyKeys(next);
}

const TTL_STATE_MS = 24 * 60 * 60 * 1000;
const COALESCE_MS = 1000;
const COALESCED_KEYS = new Set([KEY_STATE, KEY_DATES, KEY_FAILURES]);
let pendingWrites = new Map();
let writeTimer = null;

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
let memoryStore = null;
function getStore() {
    // 认不出当前账号时宁可不落盘：写到内存里，至少本次会话可用，也不会串给下一个账号
    if (scopeReady && !accountScope) {
        if (!memoryStore) memoryStore = memoryStorage();
        return memoryStore;
    }
    if (!store) store = storage();
    return store;
}

function readJson(key) {
    const storageKey = resolveKey(key);
    try {
        let parsed;
        if (pendingWrites.has(key)) {
            parsed = { version: CACHE_VERSION, ...pendingWrites.get(key)() };
        } else {
            const raw = getStore().getItem(storageKey);
            if (!raw) return null;
            parsed = JSON.parse(raw);
        }
        if (!parsed || typeof parsed !== 'object') return null;
        if (parsed.version !== CACHE_VERSION) {
            out.log(`缓存版本不匹配（${parsed.version} → ${CACHE_VERSION}），丢弃`);
            getStore().removeItem(storageKey);
            return null;
        }
        return parsed;
    } catch (err) {
        warn('读取缓存失败，按没有缓存处理', err);
        try {
            getStore().removeItem(storageKey);
        } catch {}
        return null;
    }
}

function writeJsonNow(key, payload) {
    try {
        getStore().setItem(resolveKey(key), JSON.stringify({ version: CACHE_VERSION, ...payload }));
    } catch (err) {
        // 配额满了不能影响功能，静默降级
        warn('写入缓存失败（不影响功能）', err);
    }
}

function scheduleWrite(key, payloadFactory) {
    pendingWrites.set(key, payloadFactory);
    if (writeTimer == null) writeTimer = setTimeout(flushWrites, COALESCE_MS);
}

/** Persist latest coalesced snapshots; safe to call at lifecycle boundaries. */
export function flushWrites() {
    if (writeTimer != null) clearTimeout(writeTimer);
    writeTimer = null;
    const batch = [...pendingWrites];
    pendingWrites.clear();
    for (const [key, factory] of batch) {
        try { writeJsonNow(key, factory()); }
        catch (err) { warn('写入缓存失败（不影响功能）', err); }
    }
}

function writeJson(key, payload) {
    if (COALESCED_KEYS.has(key)) {
        // Keep transformations and JSON serialization off the hot update path.
        const factory = typeof payload === 'function' ? payload : () => payload;
        scheduleWrite(key, factory);
        return;
    }
    writeJsonNow(key, payload);
}

/* ── 卡片快照 ───────────────────────────────────────────────────────────── */

export function readState() {
    const parsed = readJson(KEY_STATE);
    if (!parsed) return null;

    const cards = (Array.isArray(parsed.cards) ? parsed.cards : [])
        .filter((card) => card && card.source !== 'external') // 外部账号的卡只从快照来，不进本地快照
        .map((card) =>
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
    writeJson(KEY_STATE, () => ({
        rareVersion: RARE_CACHE_VERSION,
        savedAt: Date.now(),
        cards: cards.filter((card) => card?.source !== 'external'),
    }));
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
        if (!Number.isFinite(appid) || (completedAt !== null && !Number.isFinite(completedAt)) || !Number.isFinite(total)) continue;
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
    writeJson(KEY_DATES, () => ({
        rareVersion: RARE_CACHE_VERSION,
        entries: [...dates].map(([appid, d]) => [appid, d.completedAt, d.rare, d.total, d.fetchedAt, d.common, d.unrated]),
    }));
}

/* Separate negative cache: never let a failed request overwrite successful data. */
export function readFailures() {
    const result = new Map();
    const parsed = readJson(KEY_FAILURES);
    for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        const [key, failure] = Array.isArray(row) ? row : [];
        if (typeof key !== 'string' || !/^(date|rarity|art):\d+$/.test(key)
            || !Number.isFinite(failure?.total) || !Number.isFinite(failure?.retryAt)
            || failure.retryAt <= Date.now() || typeof failure.reason !== 'string') continue;
        result.set(key, failure);
    }
    return result;
}

export function writeFailures(failures) {
    writeJson(KEY_FAILURES, () => ({ entries: [...failures] }));
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

const ORDER_FORMAT = 2;

/**
 * 「顺序入册」的 appid 次序 = 入册先后。
 * 只追加、不重排、不删除：旧卡的编号和位置因此永远不变；
 * 中间的游戏暂时读不到时也不会把后面的卡往前挤。
 *
 * 第 2 版起带格式版本：第 1 版是在完成日期还没取到时写下的，存进去的其实是 appid 次序，
 * 直接丢弃重建（完成日期缓存、手动日期等都不受影响）。
 *
 * @returns {number[]}
 */
export function readOrder() {
    const parsed = readJson(KEY_ORDER);
    if (parsed?.orderFormat !== ORDER_FORMAT) return [];
    if (!Array.isArray(parsed.appids)) return [];
    return [...new Set(parsed.appids.filter(Number.isFinite))];
}

/** @param {number[]} appids */
export function writeOrder(appids) {
    const clean = [...new Set(appids.filter(Number.isFinite))];
    if (clean.length === 0) return;
    writeJson(KEY_ORDER, { orderFormat: ORDER_FORMAT, appids: clean });
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

/* ── 手动补的游玩时长 ───────────────────────────────────────────────────── */

/** @returns {Map<number, number>} appid → 分钟 */
export function readManualTimes() {
    const manual = new Map();
    const parsed = readJson(KEY_MANUAL_TIME);
    for (const row of Array.isArray(parsed?.entries) ? parsed.entries : []) {
        const [appid, minutes] = Array.isArray(row) ? row : [];
        if (!Number.isFinite(appid) || !Number.isFinite(minutes) || minutes <= 0) continue;
        manual.set(appid, Math.round(minutes));
    }
    return manual;
}

/** @param {Map<number, number>} manual */
export function writeManualTimes(manual) {
    writeJson(KEY_MANUAL_TIME, {
        entries: [...manual].filter(([appid, minutes]) => Number.isFinite(appid) && Number.isFinite(minutes) && minutes > 0),
    });
}

/* ── 手动收录的库外游戏 ─────────────────────────────────────────────────── */

/**
 * 已不在库里的游戏（家庭共享移除等）Steam 不再给进度，靠用户手动收录。
 * 按账号指纹隔离：同一台机器切号时不能把小号的手动收录带到大号。
 *
 * @param {string|null} owner
 * @returns {Map<number, {total:number, unlocked:number, name:string|null, addedAt:number}>}
 */
export function readExtras(owner) {
    const extras = new Map();
    if (!owner) return extras;
    const parsed = readJson(KEY_EXTRA);
    const rows = parsed?.owners?.[owner];
    for (const row of Array.isArray(rows) ? rows : []) {
        const [appid, total, unlocked, name, addedAt] = Array.isArray(row) ? row : [];
        if (!Number.isFinite(appid) || appid <= 0) continue;
        if (!Number.isFinite(total) || total <= 0) continue;
        extras.set(appid, {
            total,
            unlocked: Number.isFinite(unlocked) ? unlocked : total,
            name: typeof name === 'string' && name.trim() ? name.trim() : null,
            addedAt: Number.isFinite(addedAt) ? addedAt : 0,
        });
    }
    return extras;
}

/** @param {Map<number, {total:number, unlocked:number, name:string|null, addedAt:number}>} extras */
export function writeExtras(owner, extras) {
    if (!owner) return;
    const parsed = readJson(KEY_EXTRA);
    const owners = { ...(parsed?.owners && typeof parsed.owners === 'object' ? parsed.owners : {}) };
    owners[owner] = [...extras].map(([appid, extra]) => [
        appid, extra.total, extra.unlocked, extra.name ?? null, extra.addedAt ?? 0,
    ]);
    writeJson(KEY_EXTRA, { owners });
}

/* ── 清理 ───────────────────────────────────────────────────────────────── */

/** 回滚用：删掉本项目写下的全部 localStorage 键，无任何副作用 */
export function clearAll() {
    try {
        if (writeTimer != null) clearTimeout(writeTimer);
        writeTimer = null;
        pendingWrites.clear();
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

try { globalThis.addEventListener?.('pagehide', flushWrites); } catch { /* Steam WebView lifecycle is optional */ }

/** 测试与排查用：getter 跟随当前账号作用域，直接拿到真正落盘的键名 */
export const CACHE_KEYS = {
    get KEY_STATE() { return resolveKey(KEY_STATE); },
    get KEY_DATES() { return resolveKey(KEY_DATES); },
    get KEY_SHELVED() { return resolveKey(KEY_SHELVED); },
    get KEY_ORDER() { return resolveKey(KEY_ORDER); },
    get KEY_POSITION() { return resolveKey(KEY_POSITION); },
    get KEY_YEAR_SELECTIONS() { return resolveKey(KEY_YEAR_SELECTIONS); },
    get KEY_MANUAL() { return resolveKey(KEY_MANUAL); },
    get KEY_MANUAL_TIME() { return resolveKey(KEY_MANUAL_TIME); },
    get KEY_EXTRA() { return KEY_EXTRA; },
    get KEY_FAILURES() { return resolveKey(KEY_FAILURES); },
};
