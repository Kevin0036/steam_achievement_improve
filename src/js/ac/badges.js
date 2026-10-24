/**
 * 成就收藏册 · 游戏徽章
 *
 * 年份特殊页要贴「这一年的全成就游戏」的徽章，普通 1–5 级和闪亮徽章都要能选。
 * 图案来源只有 Steam 客户端自己的 badgeStore：
 *   · GetCommunityItemDefinitions(appid) → 徽章定义（item_class 1 / item_type 1），
 *     item_key_values 里的 level_images 是各级图案的 hash；
 *   · GetBadgeData(appid) → 当前等级与图标（定义还没取回来时的兜底）。
 *
 * 这里只做三件事：解析定义、拼官方 CDN 地址、按 appid 缓存并合并并发请求。
 * 不主动扫全库，只有年份页要显示某个已选徽章、或选择器展开某款游戏时才取。
 */

import { getBadgeStore } from './env.js';
import { warn, tagged } from './utils.js';

const out = tagged('badges');

/** 官方图案 CDN；hash 自带扩展名（通常是 .png） */
const ITEM_CDN = 'https://cdn.akamai.steamstatic.com/steamcommunity/public/images/items/';

/** appid → { status: 'loading'|'ready', levels, current, promise } */
const cache = new Map();

/** 预览页注入的固定数据：appid → { levels: {1:hash|url…}, foil, names } */
function fixtures() {
    try {
        return (typeof window !== 'undefined' && window.__AC_BADGE_FIXTURES__) || null;
    } catch {
        return null;
    }
}

function imageUrl(appid, value) {
    if (!value) return null;
    if (/^(https?:)?\/\//i.test(value) || value.startsWith('/')) return value;
    return `${ITEM_CDN}${appid}/${value}`;
}

function normalizeLevelMap(appid, images, names = {}) {
    const levels = {};
    for (const key of ['1', '2', '3', '4', '5', 'foil']) {
        const url = imageUrl(appid, images?.[key]);
        if (url) levels[key] = { url, name: names?.[key] ?? '' };
    }
    return levels;
}

function fromFixture(appid) {
    const raw = fixtures()?.[appid];
    if (!raw) return null;
    const levels = normalizeLevelMap(appid, raw.levels ?? {}, raw.names ?? {});
    if (raw.foil) levels.foil = { url: imageUrl(appid, raw.foil), name: raw.names?.foil ?? '' };
    return { status: 'ready', levels, current: raw.current ?? null };
}

function badgeDefinition(defs) {
    if (!Array.isArray(defs)) return null;
    return defs.find((def) => Number(def?.item_class) === 1 && Number(def?.item_type) === 1) ?? null;
}

function parseKeyValues(def) {
    try {
        const raw = def?.item_key_values;
        if (!raw) return {};
        return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return {};
    }
}

function fromDefinition(appid, def) {
    const kv = parseKeyValues(def);
    const levels = normalizeLevelMap(appid, kv.level_images, kv.level_names);
    if (Object.keys(levels).length === 0) return null;
    return { status: 'ready', levels, current: null };
}

/** 当前等级徽章：`strIconURL` 是 Steam 给的完整地址（可能走客户端自己的 CDN 镜像） */
function currentIcon(appid) {
    try {
        const badge = getBadgeStore()?.GetBadgeData?.(appid);
        if (!badge?.strIconURL) return null;
        const level = Number(badge.nLevel);
        return {
            level: Number.isFinite(level) && level > 0 ? level : 5,
            url: badge.strIconURL,
            name: badge.strName ?? '',
        };
    } catch {
        return null;
    }
}

/**
 * 同步拿已经能拿到的数据：预览固定数据、已缓存结果、或 badgeStore 的当前徽章。
 * 年份页先用它把图铺上，随后 loadBadge() 取回各级图案再替换。
 */
export function peekBadge(appid) {
    const fixture = fromFixture(appid);
    if (fixture) return fixture;
    const entry = cache.get(appid);
    if (entry?.status === 'ready') return entry;
    const icon = currentIcon(appid);
    if (icon) return { status: 'ready', levels: { [icon.level]: { url: icon.url, name: icon.name } }, current: icon };
    return null;
}

/**
 * 取一款游戏的全部徽章等级。定义通常已在客户端缓存里，命中时同步返回；
 * 没命中时触发一次 CM 请求并短轮询，最多等 3 秒，最后退回当前等级图标。
 *
 * @returns {Promise<{levels: Record<string,{url:string,name:string}>, current: object|null}|null>}
 */
export function loadBadge(appid) {
    const fixture = fromFixture(appid);
    if (fixture) return Promise.resolve(fixture);

    const existing = cache.get(appid);
    if (existing?.promise) return existing.promise;

    const store = getBadgeStore();
    if (!store) {
        const icon = currentIcon(appid);
        const ready = icon
            ? { status: 'ready', levels: { [icon.level]: { url: icon.url, name: icon.name } }, current: icon }
            : { status: 'ready', levels: {}, current: null };
        cache.set(appid, ready);
        return Promise.resolve(ready);
    }

    const entry = { status: 'loading', levels: {}, current: null };
    cache.set(appid, entry);
    entry.promise = new Promise((resolve) => {
        let settled = false;
        let timer = 0;
        const finish = (data) => {
            if (settled) return;
            settled = true;
            if (timer) clearInterval(timer);
            Object.assign(entry, data ?? { status: 'ready', levels: {} });
            resolve(entry);
        };
        const attempt = () => {
            let def = null;
            try {
                def = badgeDefinition(store.GetCommunityItemDefinitions?.(appid));
            } catch (err) {
                warn(`读取徽章定义失败：${appid}`, err);
            }
            if (def) {
                const parsed = fromDefinition(appid, def);
                if (parsed) return finish(parsed);
            }
            return false;
        };

        // 先同步试一次（常见情况：客户端已经缓存过）
        if (attempt()) return;
        // 定义没命中：等 CM 回包。期间 peekBadge() 仍能先用当前等级的图标顶着。
        timer = setInterval(() => {
            if (settled) return;
            attempt();
        }, 200);
        setTimeout(() => {
            if (settled) return;
            const icon = currentIcon(appid);
            finish({
                status: 'ready',
                levels: icon ? { [icon.level]: { url: icon.url, name: icon.name } } : {},
                current: icon,
            });
        }, 3000);
    });
    return entry.promise;
}

/** 把徽章数据转成可选项：1–5 + foil（只列真的拿到图的等级） */
export function badgeOptions(data) {
    if (!data?.levels) return [];
    const order = ['1', '2', '3', '4', '5', 'foil'];
    return order
        .filter((key) => data.levels[key]?.url)
        .map((key) => ({
            level: key === 'foil' ? 'foil' : Number(key),
            key,
            url: data.levels[key].url,
            name: data.levels[key].name ?? '',
        }));
}

/** 年份页 / 选择器里显示用的等级标签 */
export function levelLabel(level) {
    if (level === 'foil') return 'FOIL';
    if (level === 'cover') return 'COVER';
    const n = Number(level);
    return Number.isFinite(n) && n > 0 ? `Lv.${n}` : '';
}

/** 供预览与测试清理内存缓存 */
export function __clearBadgeCache() {
    cache.clear();
}

export const __debug = { out };
