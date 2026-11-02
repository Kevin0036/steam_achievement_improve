'use strict';

/**
 * 快照校验器（服务端独立实现，不信任客户端）。
 *
 * 输入是插件上传的 JSON；输出是**按白名单重建**的文档，未知字段一律丢弃。
 * 校验通过才允许落库，任何一条问题都会返回 400 和 problems 列表。
 * 格式定义见 achievement_improve/docs/分享收藏册-MVP-TODO.md §3。
 */

const SCHEMA_VERSION = 1;
const KIND = 'achievement-album';
const MAX_CARDS = 3000;
const MAX_YEARS = 60;
const MAX_DOC_BYTES = 512 * 1024;
const MAX_PROBLEMS = 20;

const ART_SLOTS = ['hero', 'capsule', 'header', 'logo'];
const ART_ORIGIN = 'https://shared.steamstatic.com/store_item_assets/steam/apps/';
const STEAM_CDN_HOST = 'shared.steamstatic.com';
const BANNED_KEY = /(steam_?id|account_?id)/i;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findBannedFields(value, path = '', depth = 0, out = []) {
    if (depth > 12 || out.length >= MAX_PROBLEMS) return out;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length && out.length < MAX_PROBLEMS; i += 1) {
            findBannedFields(value[i], `${path}[${i}]`, depth + 1, out);
        }
        return out;
    }
    if (!isObject(value)) return out;
    for (const [key, child] of Object.entries(value)) {
        if (out.length >= MAX_PROBLEMS) return out;
        const where = path ? `${path}.${key}` : key;
        if (BANNED_KEY.test(key)) out.push(`${where}: 不允许出现 SteamID / accountId 字段`);
        findBannedFields(child, where, depth + 1, out);
    }
    return out;
}

function isSteamAvatarUrl(value) {
    if (typeof value !== 'string' || value.length > 512) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.hostname === 'steamstatic.com' || url.hostname.endsWith('.steamstatic.com'));
    } catch {
        return false;
    }
}

function isSteamArtUrl(value, appid) {
    if (typeof value !== 'string' || value.length > 512 || !value.startsWith(ART_ORIGIN)) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && url.hostname === STEAM_CDN_HOST
            && url.pathname.startsWith(`/store_item_assets/steam/apps/${appid}/`);
    } catch {
        return false;
    }
}

const BADGE_HOSTS = new Set(['cdn.akamai.steamstatic.com', 'shared.steamstatic.com', 'steamcommunity-a.akamaihd.net']);

function isBadgeArtUrl(value, appid) {
    if (typeof value !== 'string' || value.length > 300) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:'
            && BADGE_HOSTS.has(url.hostname)
            && url.pathname.startsWith(`/steamcommunity/public/images/items/${appid}/`);
    } catch {
        return false;
    }
}

/**
 * @param {unknown} raw
 * @returns {{ok: true, doc: object} | {ok: false, problems: string[]}}
 */
function validateSnapshot(raw) {
    const problems = [];
    const add = (path, message) => {
        if (problems.length < MAX_PROBLEMS) problems.push(`${path}: ${message}`);
    };
    const fail = () => ({ ok: false, problems });

    if (!isObject(raw)) return { ok: false, problems: ['snapshot: 必须是 JSON 对象'] };

    const banned = findBannedFields(raw);
    if (banned.length) return { ok: false, problems: banned };

    if (raw.schemaVersion !== SCHEMA_VERSION) {
        if (Number.isInteger(raw.schemaVersion) && raw.schemaVersion > SCHEMA_VERSION) {
            return { ok: false, problems: [`schemaVersion: 服务器只支持 ${SCHEMA_VERSION}，请升级插件后再分享`] };
        }
        add('schemaVersion', `必须是 ${SCHEMA_VERSION}`);
    }
    if (raw.kind !== KIND) add('kind', `必须是 "${KIND}"`);

    const owner = normalizeOwner(raw.owner, add);
    const album = normalizeAlbum(raw.album, add);
    const cards = normalizeCards(raw.cards, add);
    const years = normalizeYears(raw.years, cards, add);

    if (problems.length) return fail();

    return {
        ok: true,
        doc: {
            schemaVersion: SCHEMA_VERSION,
            kind: KIND,
            owner,
            album,
            cards,
            years,
        },
    };
}

function normalizeOwner(raw, add) {
    if (!isObject(raw)) {
        add('owner', '必须是对象');
        return { name: null, avatar: null };
    }

    let name = null;
    if (raw.name !== null && raw.name !== undefined) {
        if (typeof raw.name !== 'string') add('owner.name', '必须是字符串或 null');
        else {
            name = raw.name.trim() || null;
            if (name && [...name].length > 64) add('owner.name', '超过 64 个字符');
        }
    }

    let avatar = null;
    if (raw.avatar !== null && raw.avatar !== undefined) {
        if (typeof raw.avatar !== 'string') add('owner.avatar', '必须是字符串或 null');
        else if (!isSteamAvatarUrl(raw.avatar)) add('owner.avatar', '只允许 steamstatic.com 的 https 地址');
        else avatar = raw.avatar;
    }

    const owner = { name, avatar };
    if (raw.friendCode !== null && raw.friendCode !== undefined) {
        if (typeof raw.friendCode !== 'string' || !/^\d{1,10}$/.test(raw.friendCode)) {
            add('owner.friendCode', '必须是 1–10 位数字字符串');
        } else {
            owner.friendCode = raw.friendCode;
        }
    }
    return owner;
}

function normalizeAlbum(raw, add) {
    if (!isObject(raw)) {
        add('album', '必须是对象');
        return { perPage: 1, binding: 'sequential', showStats: true, yearPages: false, yearSpread: false };
    }

    if (raw.perPage !== 1 && raw.perPage !== 4) add('album.perPage', '只能是 1 或 4');
    if (raw.binding !== 'sequential' && raw.binding !== 'newest') add('album.binding', '只能是 sequential 或 newest');
    if (typeof raw.showStats !== 'boolean') add('album.showStats', '必须是布尔值');
    if (typeof raw.yearPages !== 'boolean') add('album.yearPages', '必须是布尔值');
    if (typeof raw.yearSpread !== 'boolean') add('album.yearSpread', '必须是布尔值');

    const yearPages = raw.yearPages === true;
    return {
        perPage: raw.perPage === 4 ? 4 : 1,
        binding: raw.binding === 'newest' ? 'newest' : 'sequential',
        showStats: raw.showStats !== false,
        yearPages,
        yearSpread: yearPages && raw.yearSpread === true,
    };
}

function normalizeCards(raw, add) {
    if (!Array.isArray(raw)) {
        add('cards', '必须是数组');
        return [];
    }
    if (raw.length > MAX_CARDS) add('cards', `最多 ${MAX_CARDS} 张`);

    const out = [];
    const seen = new Set();
    for (let i = 0; i < raw.length && i < MAX_CARDS; i += 1) {
        const card = normalizeCard(raw[i], i, add);
        if (!card) continue;
        if (seen.has(card.appid)) {
            add(`cards[${i}].appid`, `重复的 appid ${card.appid}`);
            continue;
        }
        seen.add(card.appid);
        out.push(card);
    }
    return out;
}

function normalizeCard(raw, index, add) {
    const path = `cards[${index}]`;
    if (!isObject(raw)) {
        add(path, '必须是对象');
        return null;
    }

    const appid = raw.appid;
    if (!Number.isInteger(appid) || appid <= 0 || appid > 0xffffffff) {
        add(`${path}.appid`, '必须是正整数');
    }

    let name = '';
    if (typeof raw.name !== 'string') add(`${path}.name`, '必须是字符串');
    else {
        name = raw.name.trim();
        if (!name) add(`${path}.name`, '不能为空');
        else if ([...name].length > 160) add(`${path}.name`, '超过 160 个字符');
    }

    const completedAt = nullableInt(raw.completedAt, { min: 1, max: 4102444800 });
    if (completedAt === undefined) add(`${path}.completedAt`, '必须是秒级时间戳或 null');

    const playtimeMin = nullableInt(raw.playtimeMin, { min: 0, max: 1e9 });
    if (playtimeMin === undefined) add(`${path}.playtimeMin`, '必须是非负整数或 null');

    const total = nullableInt(raw.total, { min: 0, max: 1e6 });
    if (total === undefined) add(`${path}.total`, '必须是非负整数或 null');

    const rare = nullableInt(raw.rare, { min: 0, max: 1e6 });
    if (rare === undefined) add(`${path}.rare`, '必须是非负整数或 null');

    const common = nullableInt(raw.common, { min: 0, max: 1e6 });
    if (common === undefined) add(`${path}.common`, '必须是非负整数或 null');

    const unrated = nullableInt(raw.unrated, { min: 0, max: 1e6 });
    if (unrated === undefined) add(`${path}.unrated`, '必须是非负整数或 null');

    const art = normalizeArt(raw.art, appid, path, add);
    const cover = normalizeCover(raw.cover, path, add);

    const card = {
        appid,
        name,
        completedAt: completedAt === undefined ? null : completedAt,
        playtimeMin: playtimeMin === undefined ? null : playtimeMin,
        total: total === undefined ? null : total,
        rare: rare === undefined ? null : rare,
        common: common === undefined ? null : common,
        unrated: unrated === undefined ? null : unrated,
        art,
    };
    if (cover) card.cover = cover;
    return card;
}

function nullableInt(value, { min, max }) {
    if (value === null || value === undefined) return null;
    if (!Number.isInteger(value) || value < min || value > max) return undefined;
    return value;
}

function normalizeArt(raw, appid, cardPath, add) {
    const art = {};
    if (raw !== undefined && raw !== null && !isObject(raw)) add(`${cardPath}.art`, '必须是对象');

    for (const slot of ART_SLOTS) {
        const list = isObject(raw) ? raw[slot] : undefined;
        art[slot] = [];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
            add(`${cardPath}.art.${slot}`, '必须是数组');
            continue;
        }
        if (list.length > 4) add(`${cardPath}.art.${slot}`, '最多 4 条');
        for (const url of list.slice(0, 4)) {
            if (!isSteamArtUrl(url, appid)) {
                add(`${cardPath}.art.${slot}`, '只允许本 appid 的 shared.steamstatic.com 地址');
                continue;
            }
            if (!art[slot].includes(url)) art[slot].push(url);
        }
    }
    return art;
}

function normalizeCover(raw, cardPath, add) {
    if (raw === undefined || raw === null) return null;
    if (!isObject(raw)) {
        add(`${cardPath}.cover`, '必须是对象');
        return null;
    }

    const out = {};
    if (raw.front !== undefined && raw.front !== null) {
        const front = raw.front;
        if (!isObject(front)) add(`${cardPath}.cover.front`, '必须是对象');
        else if (!Number.isFinite(front.s) || front.s < 1 || front.s > 1.2) add(`${cardPath}.cover.front.s`, '必须在 1–1.2 之间');
        else if (!Number.isFinite(front.x) || front.x < -50 || front.x > 50) add(`${cardPath}.cover.front.x`, '必须在 ±50 之间');
        else if (!Number.isFinite(front.y) || front.y < -50 || front.y > 50) add(`${cardPath}.cover.front.y`, '必须在 ±50 之间');
        else if (!(front.s === 1 && front.x === 0 && front.y === 0)) out.front = { s: front.s, x: front.x, y: front.y };
    }

    if (raw.back !== undefined && raw.back !== null) {
        if (!isObject(raw.back)) add(`${cardPath}.cover.back`, '必须是对象');
        else if (raw.back.mode === 'stretch') out.back = { mode: 'stretch' };
        else if (raw.back.mode !== 'fit') add(`${cardPath}.cover.back.mode`, '只能是 stretch');
    }

    return out.front || out.back ? out : null;
}

function normalizeYears(raw, cards, add) {
    if (raw === undefined || raw === null) return {};
    if (!isObject(raw)) {
        add('years', '必须是对象');
        return {};
    }

    const byAppid = new Set(cards.map((card) => card.appid));
    const keys = Object.keys(raw);
    if (keys.length > MAX_YEARS) add('years', `最多 ${MAX_YEARS} 个年份`);

    const out = {};
    for (const key of keys.slice(0, MAX_YEARS)) {
        if (!/^\d{4}$/.test(key)) {
            add(`years.${key}`, '年份键必须是 4 位数字');
            continue;
        }
        const selection = raw[key];
        if (!isObject(selection)) {
            add(`years.${key}`, '必须是对象');
            continue;
        }

        const badges = normalizeBadges(selection.badges, key, byAppid, add);
        const banners = normalizeBanners(selection.banners, key, byAppid, add);
        if (badges.every((item) => item == null) && banners.every((item) => item == null)) continue;
        out[key] = { badges, banners };
    }
    return out;
}

function normalizeBadges(raw, year, byAppid, add) {
    const path = `years.${year}.badges`;
    if (!Array.isArray(raw)) {
        add(path, '必须是数组');
        return [null, null, null];
    }
    const out = [];
    for (let i = 0; i < 3; i += 1) {
        const item = raw[i];
        if (item === null || item === undefined) {
            out.push(null);
            continue;
        }
        if (!isObject(item)) {
            add(`${path}[${i}]`, '必须是对象或 null');
            out.push(null);
            continue;
        }
        if (!Number.isInteger(item.appid) || item.appid <= 0) {
            add(`${path}[${i}].appid`, '必须是正整数');
            out.push(null);
            continue;
        }
        const level = item.level;
        const levelOk = (Number.isInteger(level) && level >= 1 && level <= 5) || level === 'foil' || level === 'cover';
        if (!levelOk) {
            add(`${path}[${i}].level`, '只能是 1–5、foil 或 cover');
            out.push(null);
            continue;
        }
        // 引用册子里不存在的游戏：清成空槽（与客户端导出规则一致）
        if (!byAppid.has(item.appid)) {
            out.push(null);
            continue;
        }
        const badge = { appid: item.appid, level };
        // 徽章图案地址：访客没有 badgeStore，只能靠快照带过去；不合法就丢掉（回退封面）
        if (isBadgeArtUrl(item.url, item.appid)) badge.url = item.url;
        out.push(badge);
    }
    return out;
}

function normalizeBanners(raw, year, byAppid, add) {
    const path = `years.${year}.banners`;
    if (!Array.isArray(raw)) {
        add(path, '必须是数组');
        return [null, null, null];
    }
    const out = [];
    for (let i = 0; i < 3; i += 1) {
        const item = raw[i];
        if (item === null || item === undefined) {
            out.push(null);
            continue;
        }
        if (!Number.isInteger(item) || item <= 0) {
            add(`${path}[${i}]`, '必须是正整数或 null');
            out.push(null);
            continue;
        }
        out.push(byAppid.has(item) ? item : null);
    }
    return out;
}

module.exports = {
    SCHEMA_VERSION,
    KIND,
    MAX_CARDS,
    MAX_YEARS,
    MAX_DOC_BYTES,
    validateSnapshot,
};
