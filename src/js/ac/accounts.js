/**
 * 成就收藏册 · 多账号合并（只读）
 *
 * 小号已经全成就、大号还没打的游戏，一直留在大号看不到的地方。
 * 这里通过小号**已经寄出的只读快照**把它们并进当前册子：
 *
 *   · 来源：本机 `ac:v1:share` 里别的账号的寄信记录（自动发现），
 *           或用户手动输入的 9 位借阅码；
 *   · 只读：只 GET 快照，不写分享服务器，也不碰 editKey；
 *     封面取景仍可在本机微调，只影响本地显示，不会回写快照；
 *   · 当前账号优先：同一个 appid 两边都有时，保留当前账号自己的卡；
 *   · 外部卡只存在本机：不写进当前账号的日期 / 顺序 / 新收录等缓存，
 *     寄信和借阅时也只带上当前账号自己的卡。
 */

import {
    MAX_CARDS,
    SNAPSHOT_KIND,
    SNAPSHOT_SCHEMA,
    fetchAlbum,
    fetchAlbumByCode,
    isSteamArtUrl,
    isSteamAvatarUrl,
    listShareRecords,
} from './share.js';
import { log, warn, tagged } from './utils.js';

const out = tagged('accounts');

const CONFIG_KEY = 'ac:v1:accounts';
const CONFIG_VERSION = 1;
const CODE_RE = /^\d{9}$/;
/** 打开卡包时最多每 10 分钟取一次；设置面板里的「刷新」会强制取回 */
const REFRESH_MIN_AGE_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;
const ART_SLOTS = ['hero', 'capsule', 'header', 'logo'];

/** localStorage 不可用时的兜底；正常路径始终读 localStorage */
let memoryConfig = null;

/* ── 配置 ───────────────────────────────────────────────────────────────── */

function defaultConfig() {
    return { version: CONFIG_VERSION, enabled: true, manual: [], ignored: [], snapshots: {} };
}

function readRaw() {
    try {
        if (typeof localStorage !== 'undefined') {
            const raw = localStorage.getItem(CONFIG_KEY);
            if (raw) return JSON.parse(raw);
        }
    } catch (err) {
        warn('读取多账号设置失败，按默认值处理', err);
    }
    if (memoryConfig) {
        try {
            return JSON.parse(JSON.stringify(memoryConfig));
        } catch {
            return null;
        }
    }
    return null;
}

function writeRaw(config) {
    memoryConfig = config;
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
    } catch (err) {
        warn('保存多账号设置失败（本次会话仍生效）', err);
    }
}

function writeConfig(config) {
    const next = { ...config, version: CONFIG_VERSION };
    writeRaw(next);
    return next;
}

export function readConfig() {
    return normalizeConfig(readRaw());
}

function normalizeConfig(raw) {
    const config = defaultConfig();
    if (!raw || typeof raw !== 'object') return config;
    config.enabled = raw.enabled !== false;

    for (const row of Array.isArray(raw.manual) ? raw.manual : []) {
        const code = normalizeCode(row?.code);
        if (!code) continue;
        const id = `code:${code}`;
        if (config.manual.some((entry) => entry.id === id)) continue;
        config.manual.push({ id, code, addedAt: Number.isFinite(row?.addedAt) ? row.addedAt : 0 });
    }

    config.ignored = Array.isArray(raw.ignored)
        ? [...new Set(raw.ignored.filter((id) => typeof id === 'string' && id))]
        : [];

    const snapshots = raw.snapshots && typeof raw.snapshots === 'object' ? raw.snapshots : {};
    for (const [id, snapshot] of Object.entries(snapshots)) {
        const normalized = normalizeSnapshot(snapshot);
        if (normalized) config.snapshots[id] = normalized;
    }
    return config;
}

/* ── 快照校验 ───────────────────────────────────────────────────────────── */

function normalizeCode(value) {
    const text = String(value ?? '').replace(/[\s-]/g, '');
    return CODE_RE.test(text) ? text : null;
}

function normalizeSnapshot(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const owner = normalizeOwner(raw.owner);
    const error = typeof raw.error === 'string' && raw.error ? raw.error.slice(0, 200) : null;
    // 取回失败时没有账号信息，但错误说明要留着给设置面板看
    if (!owner && !error) return null;

    const cards = [];
    for (const card of Array.isArray(raw.cards) ? raw.cards : []) {
        const normalized = normalizeCard(card);
        if (!normalized) continue;
        cards.push(normalized);
        if (cards.length >= MAX_CARDS) break;
    }

    return {
        owner,
        cards: owner ? cards : [],
        sharedAt: secondsOrZero(raw.sharedAt),
        updatedAt: secondsOrZero(raw.updatedAt),
        revision: Number.isFinite(raw.revision) ? raw.revision : 0,
        fetchedAt: Number.isFinite(raw.fetchedAt) ? raw.fetchedAt : 0,
        error,
    };
}

function normalizeOwner(raw) {
    const friendCode = String(raw?.friendCode ?? '').trim();
    if (!/^\d{1,10}$/.test(friendCode)) return null; // 没有好友代码就无法确认是不是当前账号
    const name = typeof raw?.name === 'string' ? raw.name.trim().slice(0, 64) : null;
    return {
        name: name || null,
        avatar: isSteamAvatarUrl(raw?.avatar) ? raw.avatar : null,
        friendCode,
    };
}

function normalizeCard(raw) {
    const appid = positiveInt(raw?.appid);
    const total = nonNegativeInt(raw?.total);
    if (!appid || !Number.isFinite(total) || total <= 0) return null;
    return {
        appid,
        name: String(raw?.name ?? '').trim().slice(0, 160) || `App ${appid}`,
        completedAt: secondsOrNull(raw?.completedAt),
        playtimeMin: nonNegativeInt(raw?.playtimeMin),
        total,
        rare: nonNegativeInt(raw?.rare),
        common: nonNegativeInt(raw?.common),
        unrated: nonNegativeInt(raw?.unrated),
        art: normalizeArt(appid, raw?.art),
    };
}

function normalizeArt(appid, art) {
    const outArt = {};
    for (const slot of ART_SLOTS) {
        outArt[slot] = [];
        const seen = new Set();
        for (const url of Array.isArray(art?.[slot]) ? art[slot] : []) {
            if (outArt[slot].length >= 4) break;
            if (!isSteamArtUrl(url, appid) || seen.has(url)) continue;
            seen.add(url);
            outArt[slot].push(url);
        }
    }
    return outArt;
}

function positiveInt(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeInt(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function secondsOrNull(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function secondsOrZero(value) {
    return secondsOrNull(value) ?? 0;
}

/* ── 来源 ───────────────────────────────────────────────────────────────── */

function sameAccount(friendCode, accountId) {
    return accountId != null && String(friendCode) === String(accountId);
}

/** 来源 id 会进设置界面和本地配置，不能带 token；用稳定的短指纹代替 */
function tokenId(token) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < token.length; i += 1) {
        hash ^= token.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `local:${hash.toString(16).padStart(8, '0')}`;
}

/** 本机寄信记录里别的账号的快照；当前账号自己的记录直接排除 */
function discoveredSources(currentAccountId) {
    return listShareRecords()
        .filter((record) => !sameAccount(record.accountId, currentAccountId))
        .map((record) => ({
            id: tokenId(record.token),
            kind: 'local',
            token: record.token,
            code: normalizeCode(record.code),
            updatedAt: record.updatedAt,
            self: false,
        }));
}

function manualSources(config) {
    return config.manual.map((entry) => ({
        id: entry.id,
        kind: 'code',
        code: entry.code,
        updatedAt: 0,
        self: false,
    }));
}

function activeSources(config, currentAccountId) {
    const ignored = new Set(config.ignored);
    return [...discoveredSources(currentAccountId), ...manualSources(config)]
        .filter((source) => !ignored.has(source.id));
}

/**
 * 设置面板用的来源列表。刻意不返回 token / accountId：
 * 界面只需要昵称、卡片数和状态。editKey 永远不会出现在这里。
 */
export function listSources({ currentAccountId = null } = {}) {
    const config = readConfig();
    return activeSources(config, currentAccountId).map((source) => {
        const snapshot = config.snapshots[source.id] ?? null;
        return {
            id: source.id,
            kind: source.kind,
            code: source.code || '',
            self: Boolean(snapshot?.owner && sameAccount(snapshot.owner.friendCode, currentAccountId)),
            owner: snapshot?.owner ?? null,
            cardCount: snapshot?.cards.length ?? 0,
            sharedAt: snapshot?.sharedAt ?? 0,
            updatedAt: snapshot?.updatedAt ?? source.updatedAt ?? 0,
            fetchedAt: snapshot?.fetchedAt ?? 0,
            error: snapshot?.error ?? null,
        };
    });
}

/* ── 合并成卡片 ─────────────────────────────────────────────────────────── */

/**
 * 当前账号能看到的全部外部卡片。
 * 不知道当前账号（accountId 为 null）时返回空数组：宁可不合并，
 * 也不能把自己账号的快照当成「另一个账号」再并一遍。
 */
export function getCards({ currentAccountId = null } = {}) {
    const config = readConfig();
    if (!config.enabled || currentAccountId == null) return [];

    const list = [];
    for (const source of activeSources(config, currentAccountId)) {
        const snapshot = config.snapshots[source.id];
        if (!snapshot?.owner || snapshot.cards.length === 0) continue;
        if (sameAccount(snapshot.owner.friendCode, currentAccountId)) continue;
        list.push({ source, snapshot });
    }
    // 同一款游戏出现在多个快照里时，更新时间更晚的那份优先
    list.sort((a, b) => (b.snapshot.updatedAt - a.snapshot.updatedAt)
        || (b.snapshot.fetchedAt - a.snapshot.fetchedAt));

    const seen = new Set();
    const cards = [];
    for (const { source, snapshot } of list) {
        for (const card of snapshot.cards) {
            if (seen.has(card.appid)) continue;
            seen.add(card.appid);
            cards.push(toExternalCard(card, snapshot.owner, source.id));
        }
    }
    return cards;
}

function toExternalCard(card, owner, sourceId) {
    return {
        appid: card.appid,
        name: card.name,
        nameMissing: false,
        art: card.art,

        unlocked: card.total,
        total: card.total,
        state: 'complete',

        source: 'external',
        cacheTime: null,
        completedAt: card.completedAt,
        completedAtSource: card.completedAt != null ? 'external' : 'none',

        rare: card.rare,
        common: card.common,
        unrated: Number.isFinite(card.unrated)
            ? card.unrated
            : card.rare == null ? card.total : Math.max(0, card.total - (card.rare ?? 0) - (card.common ?? 0)),

        playtimeMin: card.playtimeMin,
        playtimeSource: card.playtimeMin == null ? 'none' : 'external',
        lastPlayed: null,
        catalogueIndex: null,
        hasDlcAchievements: null,
        syncedAt: Date.now(),

        // 卡面归属：显示小号的昵称 / 头像，而不是当前账号
        owner: { persona: owner.name || null, avatar: owner.avatar },
        external: { id: sourceId },
    };
}

/* ── 设置操作 ───────────────────────────────────────────────────────────── */

export function setEnabled(enabled) {
    const config = readConfig();
    config.enabled = Boolean(enabled);
    writeConfig(config);
    return config.enabled;
}

export function addSourceByCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized) return { ok: false, reason: 'format' };
    const config = readConfig();
    const id = `code:${normalized}`;
    const duplicate = config.manual.some((entry) => entry.id === id);
    config.ignored = config.ignored.filter((item) => item !== id);
    if (!duplicate) config.manual.push({ id, code: normalized, addedAt: Date.now() });
    writeConfig(config);
    return { ok: true, id, duplicate };
}

export function removeSource(id) {
    if (typeof id !== 'string' || !id) return false;
    const config = readConfig();
    config.ignored = [...new Set([...config.ignored, id])];
    config.manual = config.manual.filter((entry) => entry.id !== id);
    delete config.snapshots[id];
    writeConfig(config);
    return true;
}

/* ── 取回快照 ───────────────────────────────────────────────────────────── */

/**
 * 取回到期（或指定强制）的来源。一个来源失败只影响它自己：
 * 上一次成功取回的卡片继续用，错误写进来源状态供设置面板显示。
 */
export async function refreshAll({ currentAccountId = null, force = false, isCurrent = () => true, onUpdate = null } = {}) {
    const config = readConfig();
    if (!config.enabled) return { ok: true, fetched: 0, failed: 0, skipped: 'disabled' };

    const sources = activeSources(config, currentAccountId);
    const due = sources.filter((source) => {
        if (force) return true;
        const snapshot = config.snapshots[source.id];
        return !snapshot || Date.now() - (snapshot.fetchedAt ?? 0) > REFRESH_MIN_AGE_MS;
    });
    if (due.length === 0) return { ok: true, fetched: 0, failed: 0, cached: true };

    let fetched = 0;
    let failed = 0;
    let changed = false;

    for (const source of due) {
        if (!isCurrent()) break;
        try {
            const doc = source.kind === 'local'
                ? await fetchAlbum(source.token, { timeout: FETCH_TIMEOUT_MS })
                : await fetchAlbumByCode(source.code, { timeout: FETCH_TIMEOUT_MS });
            if (!isCurrent()) break;
            if (doc?.kind !== SNAPSHOT_KIND || doc?.schemaVersion !== SNAPSHOT_SCHEMA) {
                throw new Error('快照格式不认识，请让对方更新到最新版后再同步一次。');
            }
            const snapshot = normalizeSnapshot({
                owner: doc.owner,
                cards: doc.cards,
                sharedAt: doc.sharedAt,
                updatedAt: doc.updatedAt,
                revision: doc.revision,
                fetchedAt: Date.now(),
            });
            if (!snapshot) throw new Error('快照里没有可用的账号信息，请让对方重新寄一次。');
            config.snapshots[source.id] = snapshot;
            fetched += 1;
            changed = true;
        } catch (err) {
            if (!isCurrent()) break;
            failed += 1;
            const previous = config.snapshots[source.id] ?? null;
            const message = firstLine(err?.message) || '取回快照失败';
            config.snapshots[source.id] = {
                ...(previous ?? {
                    owner: null, cards: [], sharedAt: 0, updatedAt: 0, revision: 0, fetchedAt: 0,
                }),
                error: message,
            };
            changed = true;
            out.log(`取回快照失败（${source.kind === 'local' ? '本机记录' : source.code}）：${message}`);
        }
    }

    if (!isCurrent()) return { ok: false, stale: true, fetched, failed };

    if (changed) {
        // 取回期间用户可能又加了 / 删了来源：只合并 snapshots，其它设置以最新一次为准
        const latest = readConfig();
        const activeIds = new Set(activeSources(latest, currentAccountId).map((source) => source.id));
        const snapshots = {};
        for (const [id, snapshot] of Object.entries({ ...latest.snapshots, ...config.snapshots })) {
            if (activeIds.has(id)) snapshots[id] = snapshot;
        }
        writeConfig({ ...latest, snapshots });
        if (typeof onUpdate === 'function') {
            try {
                onUpdate();
            } catch (err) {
                warn('多账号合并更新回调失败', err);
            }
        }
    }

    return { ok: failed === 0, fetched, failed };
}

function firstLine(value) {
    return String(value ?? '').split('\n')[0].trim();
}
