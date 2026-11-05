/**
 * 成就收藏册 · 完满主义者展柜：蓝紫徽章（本体 + 所有 DLC 成就集合都打通）
 *
 * 展柜是 Valve 服务端渲染的，格子里只画「已经完成的集合」：蓝色奖杯组是本体集合，
 * 带 .dlc 的紫色组是 DLC 集合，.empty 是一个都没完成。没完成、没买的 DLC 集合根本不出现，
 * 所以单看格子分不出 DLC 是 1/1 还是 1/2。
 *
 * 做法：本体奖杯亮着、又有 DLC 奖杯的格子才可能是蓝紫，只对它们去取这款游戏的成就页
 * （和展柜同域，格子本身就链过去）。成就页把整张成就表（每个集合的 dlcappid）和这位玩家的
 * 记录（每个集合是否完成）嵌在 <script id="valve-ssr-data"> 里，拿来交给 model.js 的 summarizeSets，
 * 和收藏册用同一套口径判定。
 *
 * 只读、不猜：取不到、解析不了、资料设为私密，格子都保持蓝徽章。
 * 结论在本页生命周期里记住（同一格 MutationObserver 反复重入也只请求一次），
 * 另存进 sessionStorage 一小时，刷新页面不用重取。
 */

import { SHOWCASE } from './selectors.js';
import { summarizeSets } from './model.js';
import { tagged } from './utils.js';

const out = tagged('showcase-sets');

const CACHE_KEY = 'ac:v1:showcase-sets';
const CACHE_TTL_MS = 60 * 60 * 1000;
/** 一页最多查这么多格：成就页一个三四百 KB，不能把展柜变成下载器 */
const MAX_LOOKUPS = 12;
const FETCH_TIMEOUT_MS = 10000;

/** href → Promise<boolean|null> */
const pending = new Map();
let lookups = 0;

function readCache() {
    try {
        const parsed = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeCache(href, allSets) {
    try {
        const cache = readCache();
        cache[href] = { allSets, at: Date.now() };
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
        // 存不了就每次重取，不影响结论
    }
}

/** 格子上的奖杯：本体亮着、而且有 DLC 奖杯，才值得去查 */
export function ribbonHint(slot) {
    const base = slot.querySelector('.showcase_completion_ribbon_group.base');
    const dlc = slot.querySelector('.showcase_completion_ribbon_group.dlc');
    return {
        baseDone: !!base && !base.classList.contains('empty'),
        dlcDone: !!dlc && !dlc.classList.contains('empty'),
    };
}

/**
 * 从成就页 HTML 里取出成就表和玩家记录，换成 summarizeSets 认的形状
 * （和 Player.GetGameAchievements / GetUserAchievements 的 toObject 一样）。
 * @returns {object|null}
 */
export function setsFromAchievementsPage(html, appid) {
    const match = /<script[^>]*id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!match) return null;
    let queries;
    try {
        const ssr = JSON.parse(match[1]);
        const raw = ssr?.renderContext?.queryData;
        queries = (typeof raw === 'string' ? JSON.parse(raw) : raw)?.queries;
    } catch {
        return null;
    }
    if (!Array.isArray(queries)) return null;
    const keyIs = (q, kind) => Array.isArray(q?.queryKey) && q.queryKey[0] === 'achievements' && Number(q.queryKey[1]) === appid && q.queryKey[2] === kind;
    const schema = queries.find((q) => keyIs(q, 'schema_v2'))?.state?.data;
    const user = queries.find((q) => keyIs(q, 'user_achievements'))?.state?.data;
    const percentages = queries.find((q) => keyIs(q, 'globalpercentages'))?.state?.data?.percentages ?? {};
    if (!Array.isArray(schema?.groups) || !user || typeof user.achievements !== 'object') return null;

    const groups = [];
    const achievements = [];
    for (const group of schema.groups) {
        const id = Number(group?.id) || 0;
        if (id !== 0) {
            groups.push({
                groupid: id,
                dlcappid: Number(group.dlcappid) || 0,
                archived: group.archived === true,
                developeronly: group.developeronly === true,
                localized_name: group.name ?? '',
            });
        }
        for (const row of Array.isArray(group?.achievements) ? group.achievements : []) {
            const pct = percentages[row.internal_key];
            achievements.push({
                internal_name: row.api_name,
                internal_key: row.internal_key,
                groupid: id,
                archived: row.archived === true,
                player_percent_unlocked: pct == null ? undefined : String(pct),
            });
        }
    }
    return {
        groups,
        achievements,
        user: {
            achievements: Object.values(user.achievements ?? {}),
            groups: Object.values(user.groups ?? {}),
        },
    };
}

async function lookup(href, appid) {
    const cached = readCache()[href];
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.allSets;
    if (lookups >= MAX_LOOKUPS) return null;
    lookups += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(href, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) return null;
        const sets = summarizeSets(setsFromAchievementsPage(await response.text(), appid));
        if (!sets) return null;
        writeCache(href, sets.allSets);
        out.log(`${appid}：本体${sets.base.complete ? '完成' : '未完成'} · DLC 集合 ${sets.dlcCompleted}/${sets.dlcSets}${sets.allSets ? ' → 蓝紫徽章' : ''}`);
        return sets.allSets;
    } catch (err) {
        out.log(`${appid} 的成就页取不到（保持蓝徽章）：${err?.message ?? err}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/** 同域的成就页地址：格子本身就链到这位玩家这款游戏的成就页 */
function achievementsHref(slot) {
    const link = slot.querySelector('a[href]');
    if (!link) return null;
    try {
        const url = new URL(link.getAttribute('href'), location.href);
        if (url.origin !== location.origin) return null;
        const match = /\/achievements\/(\d+)\/?$/.exec(url.pathname) ?? /\/stats\/(\d+)\//.exec(url.pathname);
        return match ? { href: url.href, appid: Number(match[1]) } : null;
    } catch {
        return null;
    }
}

/**
 * 给本体 + 所有 DLC 集合都打通的格子打上 data-ac-sets="all"（徽章和信息条换成蓝紫，见 showcase.css）。
 * 幂等：处理过的格子带 data-ac-sets-checked；异步结论回来时再落标记。
 * @returns {number} 这一轮新开始核对的格子数
 */
export function markAllSets(root) {
    let started = 0;
    for (const slot of root.querySelectorAll(SHOWCASE.slot)) {
        if (slot.dataset.acSetsChecked) continue;
        slot.dataset.acSetsChecked = '1';
        const { baseDone, dlcDone } = ribbonHint(slot);
        if (!baseDone || !dlcDone) continue;
        const target = achievementsHref(slot);
        if (!target) continue;
        started += 1;
        if (!pending.has(target.href)) pending.set(target.href, lookup(target.href, target.appid));
        pending.get(target.href).then((allSets) => {
            if (allSets === true) slot.dataset.acSets = 'all';
        });
    }
    return started;
}
