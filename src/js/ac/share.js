/**
 * 成就收藏册 · 分享快照
 *
 * 把当前册子整理成一份「冻结」的 JSON（schemaVersion 1，格式见
 * achievement_improve/docs/分享收藏册-MVP-TODO.md §3），由插件上传到分享 API。
 *
 * 三条硬规则：
 *   · 卡片先按完成时间升序整理，再交给 orderForBook() 决定册内顺序，借阅室不再重排；
 *   · art 只保留 Steam 公共 CDN 的地址，本地 /assets/ 一律剔除；
 *   · owner 只导出昵称 / 头像 / 好友代码，SteamID64 与 accountId 绝不出现在文档里。
 */

import { getThemeOption } from './env.js';
import { orderForBook } from './export.js';
import { isYearKey, normalizeSelection, yearKeyOf } from './yearpages.js';
import { peekBadgeUrl } from './badges.js';
import { getBack, getFront } from './coveredit.js';
import { getState } from './store.js';
import { getOwner } from './datasource.js';

export const SNAPSHOT_SCHEMA = 1;
export const SNAPSHOT_KIND = 'achievement-album';
export const MAX_CARDS = 3000;
export const MAX_SNAPSHOT_BYTES = 512 * 1024;

/** 分享 API 与借阅室地址：构建时写死，避免被改成钓鱼地址 */
export const API_BASE = 'https://ac-share.duckdns.org:8443';
export const VIEWER_BASE = 'https://kevin0036.github.io/';

/** 短码链接；借阅码本身就是朋友之间传递的凭证 */
export function codeViewerUrl(code) {
    const base = VIEWER_BASE.endsWith('/') ? VIEWER_BASE : `${VIEWER_BASE}/`;
    return `${base}?c=${encodeURIComponent(String(code ?? ''))}`;
}

const ART_SLOTS = ['hero', 'capsule', 'header', 'logo'];
const ART_HOST = 'shared.steamstatic.com';
const ART_ORIGIN = 'https://shared.steamstatic.com/store_item_assets/steam/apps/';
const BADGE_LEVELS = new Set([1, 2, 3, 4, 5, 'foil', 'cover']);
/** 徽章图案的官方 CDN（badges.js 拼出来的就是这一种） */
const BADGE_HOSTS = new Set(['cdn.akamai.steamstatic.com', 'shared.steamstatic.com', 'steamcommunity-a.akamaihd.net']);

/* ── 读取当前设置 ───────────────────────────────────────────────────────── */

/** 和 page.js 同一口径：主题设置优先，插件模式由 settings.js 的 provider 接上 */
export function readAlbumSettings() {
    const value = String(getThemeOption('卡册装订方式', '顺序入册'));
    const yearPages = String(getThemeOption('年份特殊页', '关闭')) === '开启';
    return {
        perPage: String(getThemeOption('单页卡片数量', '1')) === '4' ? 4 : 1,
        binding: value === '最新优先' || value === 'newest' ? 'newest' : 'sequential',
        showStats: String(getThemeOption('扉页统计', '开启')) !== '关闭',
        yearPages,
        // 1.2 起年份页固定四页、不再有这个选项；字段还留着，分享服务器的校验要求它
        yearSpread: yearPages,
    };
}

/** 当前账号昵称 / 头像 / accountId；store 里还没有时直接问 Steam */
export async function resolveShareOwner() {
    const cached = getState()?.owner ?? null;
    if (cached?.accountId) return cached;
    try {
        const fresh = await getOwner();
        if (fresh) return fresh;
    } catch {
        // 拿不到就退回归属不明的状态，由调用方提示
    }
    return cached;
}

/* ── 构建快照 ───────────────────────────────────────────────────────────── */

const defaultCoverOf = (appid) => ({ front: getFront(appid), back: getBack(appid) });

/** 访客的浏览器没有 badgeStore，徽章图案只能随快照带走 */
const defaultBadgeUrlOf = (appid, level) => {
    const url = peekBadgeUrl(appid, level);
    return isBadgeArtUrl(url, appid) ? url : null;
};

/**
 * @param {object} input
 * @param {Array} input.cards            当前册子的卡片（store 的原始顺序即可）
 * @param {object|null} [input.owner]    { persona, avatar, accountId, steamid? }
 * @param {object} input.album           readAlbumSettings() 的结果
 * @param {Record<string, object>} [input.yearSelections] cache.readYearSelections()
 * @param {(appid:number)=>{front?:object,back?:object}} [input.coverOf] 封面取景来源
 * @param {(appid:number, level:number|'foil'|'cover')=>string|null} [input.badgeUrlOf] 徽章图案来源
 * @returns {object} 可直接上传的文档（不含 sharedAt / updatedAt / revision）
 */
export function buildSnapshot({ cards, owner = null, album = {}, yearSelections = {}, coverOf = defaultCoverOf, badgeUrlOf = defaultBadgeUrlOf } = {}) {
    // 分享 / 借阅只带走当前账号自己的卡：合并进来的外部账号卡片只在本机显示
    const list = Array.isArray(cards) ? cards.filter((card) => card && card.source !== 'external') : [];
    if (list.length > MAX_CARDS) {
        throw new Error(`收藏册有 ${list.length} 张卡，超过分享上限 ${MAX_CARDS} 张。`);
    }

    const albumSettings = normalizeAlbum(album);
    const ordered = orderForBook(byCompletion(list), {
        binding: albumSettings.binding,
        yearPages: albumSettings.yearPages,
    });
    const outCards = ordered.map((card) => normalizeCard(card, coverOf));

    return {
        schemaVersion: SNAPSHOT_SCHEMA,
        kind: SNAPSHOT_KIND,
        owner: normalizeOwner(owner),
        album: albumSettings,
        cards: outCards,
        years: pruneYears(yearSelections, outCards, badgeUrlOf),
    };
}

/** 序列化并返回体积，供生成前提示 */
export function serializeSnapshot(doc) {
    const json = JSON.stringify(doc);
    return { json, bytes: new TextEncoder().encode(json).length };
}

/** 完成时间升序（未定档的排最后，同刻按 appid），与主题册页 view.js#sortByCompletion 一致 */
function byCompletion(cards) {
    return [...cards].sort((a, b) => {
        const left = a.completedAt ?? Infinity;
        const right = b.completedAt ?? Infinity;
        return left === right ? a.appid - b.appid : left - right;
    });
}

function normalizeAlbum(album) {
    return {
        perPage: Number(album?.perPage) === 4 ? 4 : 1,
        binding: album?.binding === 'newest' ? 'newest' : 'sequential',
        showStats: album?.showStats !== false,
        yearPages: album?.yearPages === true,
        yearSpread: album?.yearPages === true && album?.yearSpread === true,
    };
}

function normalizeOwner(owner) {
    const name = typeof owner?.persona === 'string' ? owner.persona.trim().slice(0, 64) : null;
    const avatar = isSteamAvatarUrl(owner?.avatar) ? owner.avatar : null;
    const out = { name: name || null, avatar };
    const friendCode = String(owner?.accountId ?? '').trim();
    if (/^\d{1,10}$/.test(friendCode)) out.friendCode = friendCode;
    return out;
}

function normalizeCard(card, coverOf) {
    const appid = positiveInt(card?.appid);
    if (!appid) throw new Error(`卡片缺少有效的 appid：${String(card?.appid)}`);

    const out = {
        appid,
        name: String(card?.name ?? '').trim().slice(0, 160) || `App ${appid}`,
        completedAt: secondsOrNull(card?.completedAt),
        playtimeMin: nonNegativeOrNull(card?.playtimeMin),
        total: nonNegativeOrNull(card?.total),
        rare: nonNegativeOrNull(card?.rare),
        common: nonNegativeOrNull(card?.common),
        unrated: nonNegativeOrNull(card?.unrated),
        art: normalizeArt(appid, card?.art),
    };

    const cover = normalizeCover(safeCover(coverOf, appid));
    if (cover) out.cover = cover;
    return out;
}

function safeCover(coverOf, appid) {
    try {
        return typeof coverOf === 'function' ? coverOf(appid) : null;
    } catch {
        return null;
    }
}

function normalizeArt(appid, art) {
    const out = {};
    for (const slot of ART_SLOTS) {
        const list = Array.isArray(art?.[slot]) ? art[slot] : [];
        const seen = new Set();
        out[slot] = [];
        for (const url of list) {
            if (out[slot].length >= 4) break;
            if (!isSteamArtUrl(url, appid) || seen.has(url)) continue;
            seen.add(url);
            out[slot].push(url);
        }
    }
    return out;
}

function normalizeCover(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};

    const front = raw.front;
    if (front && typeof front === 'object') {
        const s = clamp(round2(Number(front.s)), 1, 1.2);
        const x = clamp(round2(Number(front.x)), -50, 50);
        const y = clamp(round2(Number(front.y)), -50, 50);
        if (Number.isFinite(s) && !(s === 1 && x === 0 && y === 0)) {
            out.front = { s, x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
        }
    }

    if (raw.back?.mode === 'stretch') out.back = { mode: 'stretch' };

    return out.front || out.back ? out : null;
}

function pruneYears(yearSelections, cards, badgeUrlOf) {
    const byAppid = new Map(cards.map((card) => [card.appid, card]));
    const presentYears = new Set(cards.map((card) => yearKeyOf(card)).filter(isYearKey));
    const out = {};

    const keys = Object.keys(yearSelections ?? {})
        .filter((key) => isYearKey(key) && presentYears.has(key))
        .sort((a, b) => Number(a) - Number(b));

    for (const key of keys) {
        const selection = normalizeSelection(yearSelections[key]);
        const badges = selection.badges.slice(0, 3).map((picked) => {
            if (!picked) return null;
            const appid = positiveInt(picked.appid);
            if (!appid || !byAppid.has(appid) || !BADGE_LEVELS.has(picked.level)) return null;
            const url = picked.level === 'cover' ? null : safeBadgeUrl(badgeUrlOf, appid, picked.level);
            return url ? { appid, level: picked.level, url } : { appid, level: picked.level };
        });
        const banners = selection.banners.slice(0, 3).map((appid) => {
            const id = positiveInt(appid);
            return id && byAppid.has(id) ? id : null;
        });
        while (badges.length < 3) badges.push(null);
        while (banners.length < 3) banners.push(null);
        if (badges.every((item) => item == null) && banners.every((item) => item == null)) continue;
        out[key] = { badges, banners };
    }

    return out;
}

/* ── 校验小工具 ─────────────────────────────────────────────────────────── */

function positiveInt(value) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : null;
}

function nonNegativeOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function secondsOrNull(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

function round2(value) {
    return Number.isFinite(value) ? Math.round(value * 100) / 100 : value;
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) return value;
    return Math.min(max, Math.max(min, value));
}

export function isSteamAvatarUrl(value) {
    if (typeof value !== 'string' || value.length > 512) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'steamstatic.com' || url.hostname.endsWith('.steamstatic.com'));
    } catch {
        return false;
    }
}

/** 只认 https://shared.steamstatic.com/store_item_assets/steam/apps/<appid>/... */
export function isSteamArtUrl(value, appid) {
    if (typeof value !== 'string' || value.length > 512) return false;
    if (!value.startsWith(ART_ORIGIN)) return false;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.hostname !== ART_HOST) return false;
        return url.pathname.startsWith(`/store_item_assets/steam/apps/${appid}/`);
    } catch {
        return false;
    }
}

/** 只认官方徽章 CDN 的 /steamcommunity/public/images/items/<appid>/... */
export function isBadgeArtUrl(value, appid) {
    if (typeof value !== 'string' || value.length > 300) return false;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || !BADGE_HOSTS.has(url.hostname)) return false;
        return url.pathname.startsWith(`/steamcommunity/public/images/items/${appid}/`);
    } catch {
        return false;
    }
}

function safeBadgeUrl(badgeUrlOf, appid, level) {
    try {
        const url = typeof badgeUrlOf === 'function' ? badgeUrlOf(appid, level) : null;
        return isBadgeArtUrl(url, appid) ? url : null;
    } catch {
        return null;
    }
}

/* ── 分享 API ───────────────────────────────────────────────────────────── */

export class ShareRequestError extends Error {
    constructor(message, { status = 0, code = 'network_error', problems = [] } = {}) {
        super(message);
        this.name = 'ShareRequestError';
        this.status = status;
        this.code = code;
        this.problems = problems;
    }
}

const STATUS_MESSAGES = {
    400: '快照没通过服务器校验。',
    403: '编辑凭证无效，可能已在别处换过新链接。',
    404: '链接不存在或已被收回。',
    413: '快照体积超过服务器上限。',
    429: '操作太频繁，请稍后再试。',
};

async function shareRequest(path, { method = 'GET', editKey = null, body = null, timeout = 15000 } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeout) : 0;
    const headers = { Accept: 'application/json' };
    if (body != null) headers['Content-Type'] = 'application/json';
    if (editKey) headers.Authorization = `Bearer ${editKey}`;

    let response;
    try {
        response = await fetch(`${API_BASE}${path}`, {
            method,
            headers,
            body: body == null ? undefined : JSON.stringify(body),
            signal: controller?.signal,
        });
    } catch (err) {
        throw new ShareRequestError('网络错误：连不上分享服务器，请检查网络后重试。', { code: 'network_error' });
    } finally {
        if (timer) clearTimeout(timer);
    }

    let payload = null;
    const text = await response.text().catch(() => '');
    if (text) {
        try {
            payload = JSON.parse(text);
        } catch {
            payload = null;
        }
    }

    if (!response.ok) {
        const message = STATUS_MESSAGES[response.status] ?? `服务器返回 HTTP ${response.status}。`;
        const problems = Array.isArray(payload?.problems) ? payload.problems : [];
        const detail = problems.length ? `${message}\n${problems.slice(0, 5).join('；')}` : message;
        throw new ShareRequestError(detail, {
            status: response.status,
            code: payload?.error ?? 'http_error',
            problems,
        });
    }

    return payload;
}

/** @returns {Promise<{token:string, editKey:string, code:string, url:string, sharedAt:number, updatedAt:number, revision:number}>} */
export function createAlbum(doc) {
    return shareRequest('/api/albums', { method: 'POST', body: doc });
}

export function updateAlbum(token, editKey, doc) {
    return shareRequest(`/api/albums/${encodeURIComponent(token)}`, { method: 'PUT', editKey, body: doc });
}

export function fetchAlbum(token, { timeout } = {}) {
    return shareRequest(`/api/albums/${encodeURIComponent(token)}`, { timeout });
}

export function fetchAlbumByCode(code, { timeout } = {}) {
    return shareRequest(`/api/albums/by-code/${encodeURIComponent(String(code ?? ''))}`, { timeout });
}

/** 只给分享者取回自己的借阅码 / 链接，需要 editKey */
export function fetchAlbumMeta(token, editKey) {
    return shareRequest(`/api/albums/${encodeURIComponent(token)}/meta`, { editKey });
}

export async function deleteAlbum(token, editKey) {
    await shareRequest(`/api/albums/${encodeURIComponent(token)}`, { method: 'DELETE', editKey });
}

/* ── 本机记录（只存本地，绝不上传） ─────────────────────────────────────── */

const RECORD_KEY = 'ac:v1:share';

function readStoreRaw() {
    try {
        const parsed = JSON.parse(localStorage.getItem(RECORD_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeStoreRaw(records) {
    try {
        if (Object.keys(records).length === 0) localStorage.removeItem(RECORD_KEY);
        else localStorage.setItem(RECORD_KEY, JSON.stringify(records));
    } catch {
        // 存储不可用时本次会话仍可使用，只是重启后要重新生成
    }
}

/** @returns {{token:string, editKey:string, code?:string, url:string, sharedAt:number, updatedAt:number, revision:number}|null} */
export function readShareRecord(accountId) {
    if (accountId == null || accountId === '') return null;
    const record = readStoreRaw()[String(accountId)];
    return record && typeof record === 'object' && typeof record.token === 'string' ? record : null;
}

/**
 * 本机所有寄信记录（多账号合并用来发现「另一个账号已经分享过的快照」）。
 * 只暴露只读快照所需的信息：**绝不返回 editKey**，也不把它带进界面的任何文案。
 *
 * @returns {Array<{accountId:number, token:string, code:string, url:string, sharedAt:number, updatedAt:number, revision:number}>}
 */
export function listShareRecords() {
    const records = readStoreRaw();
    const out = [];
    for (const [key, record] of Object.entries(records)) {
        const accountId = Number(key);
        if (!Number.isFinite(accountId) || typeof record?.token !== 'string' || !record.token) continue;
        out.push({
            accountId,
            token: record.token,
            code: typeof record.code === 'string' ? record.code : '',
            url: typeof record.url === 'string' ? record.url : '',
            sharedAt: Number.isFinite(record.sharedAt) ? record.sharedAt : 0,
            updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : 0,
            revision: Number.isFinite(record.revision) ? record.revision : 0,
        });
    }
    return out;
}

export function writeShareRecord(accountId, record) {
    if (accountId == null || accountId === '') return;
    const records = readStoreRaw();
    records[String(accountId)] = record;
    writeStoreRaw(records);
}

export function clearShareRecord(accountId) {
    if (accountId == null || accountId === '') return;
    const records = readStoreRaw();
    delete records[String(accountId)];
    writeStoreRaw(records);
}
