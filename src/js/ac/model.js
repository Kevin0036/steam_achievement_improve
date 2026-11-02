/**
 * 成就收藏册 · 数据模型与全成就判定
 *
 * 这个文件是**纯函数、零 Steam 依赖**的，因此可以用 Node 直接跑断言，
 * 不需要 Steam、不需要浏览器（见 tools/test-model.mjs）。
 *
 * ── 三条铁律（对应需求文档「不得错误地将其当成未全成就」「不得伪造数据」） ──
 *   1. total === 0 一律判为 unknown。客户端还没拉到数据 ≠ 这个游戏没有成就。
 *      实测本机 513 条记录里有 103 条 total: 0。
 *   2. 任何读取异常 / 超时 / 字段缺失 / 主数据源为空，结果都是 unknown，不是 incomplete。
 *   3. 客户端数据与我们的缓存冲突时一律以客户端为准。
 */

/** 全成就判定的唯一入口 */
export function classify(entry) {
    if (!entry || typeof entry !== 'object') return 'unknown';

    const { total, unlocked, all_unlocked: allUnlocked } = entry;

    // 铁律 1：total 为空或 0 => 数据缺失，绝不判为未完成
    if (!Number.isFinite(total) || total <= 0) return 'unknown';

    if (allUnlocked === true) return 'complete';

    if (!Number.isFinite(unlocked)) return 'unknown';

    if (unlocked >= total) return 'complete';
    if (unlocked < total) return 'incomplete';

    return 'unknown';
}

/**
 * 用**完整成就列表**复核服务端的「已完成」结论。
 *
 * Player.GetAchievementsProgress 对部分游戏只返回它已知的成就子集
 * （实测 3/45 的游戏被报成 3/3），单看 unlocked >= total 会误判。
 * evidence 来自 Apps.GetMyAchievementsForApp 或本地 achievements 缓存，
 * 是这款游戏完整的成就总数与本人已解锁数。
 *
 * 拿不到证据时维持原判：接口失败 / 缓存缺失不等于没打满（铁律 2）。
 *
 * @param {object} entry  进度条目
 * @param {{total?:number, achieved?:number}|null} evidence
 * @returns {boolean}
 */
export function confirmCompletion(entry, evidence) {
    if (classify(entry) !== 'complete') return false;
    if (!evidence || typeof evidence !== 'object') return true;

    const total = Number(evidence.total);
    if (!Number.isFinite(total) || total <= 0) return true;

    const achieved = Number(evidence.achieved);
    // 有本人已解锁数时它是最终判据；完整列表总数少于服务端总数时
    // 多出来的是归档成就，已全部解锁照样算全成就。
    if (Number.isFinite(achieved)) return achieved >= total;

    // 只有总数时：完整 schema 比服务端声称的总数还多 => 服务端只看到了一部分
    const claimed = Number(entry.total);
    return !(Number.isFinite(claimed) && total > claimed);
}

/**
 * 从 Apps.GetMyAchievementsForApp 的完整个人列表算出复核证据。
 * @returns {{total:number, achieved:number}|null}
 */
export function completionEvidence(data) {
    const list = data?.rgAchievements;
    if (!Array.isArray(list) || list.length === 0) return null;

    let achieved = 0;
    for (const item of list) if (item?.bAchieved === true) achieved += 1;
    return { total: list.length, achieved };
}

/**
 * 复核一款「准备手动收录」的库外游戏是否真的全成就。
 *
 * 三份证据按可信度合并：完整个人列表 > 官方成就表 > 服务端进度。
 * 总数一律取三者最大值 —— 游戏加了新成就后，旧口径不能再算全成就；
 * 只有服务端数据时，残缺 schema（3/3、实际 45 个）也会被官方表的总数拆穿。
 *
 * @param {{personal?:{total:number,achieved:number}|null, officialTotal?:number|null, service?:object|null}} input
 * @returns {{status:'complete'|'incomplete'|'unavailable', total:number|null, unlocked:number|null}}
 */
export function verifyExtraCompletion({ personal, officialTotal, service } = {}) {
    const totals = [];
    if (Number.isFinite(personal?.total) && personal.total > 0) totals.push(personal.total);
    if (Number.isFinite(officialTotal) && officialTotal > 0) totals.push(officialTotal);
    if (Number.isFinite(service?.total) && service.total > 0) totals.push(service.total);

    if (totals.length === 0) return { status: 'unavailable', total: null, unlocked: null };
    const total = Math.max(...totals);

    let unlocked = null;
    if (Number.isFinite(personal?.achieved)) {
        unlocked = personal.achieved;
    } else if (Number.isFinite(service?.unlocked)) {
        unlocked = service.unlocked;
    } else if (service?.all_unlocked === true && Number.isFinite(service?.total)) {
        unlocked = service.total;
    }

    if (unlocked == null) return { status: 'unavailable', total, unlocked: null };
    return { status: unlocked >= total ? 'complete' : 'incomplete', total, unlocked };
}

/**
 * 手动收录的库外游戏与客户端/服务端后来的进度合并。
 *
 * 收录时的结论来自完整成就列表（见 verifyExtraCompletion），比
 * Player.GetAchievementsProgress 常见的残缺 schema 可靠。所以：
 *   1. 没有条目，或条目总数不大于收录总数 → 用收录结论；
 *   2. 条目总数更大 → 游戏加了新成就，旧的「全成就」作废，用条目。
 * 两种情况都保留 manual-extra 来源，卡面上的「库外」标记和移除入口才不会丢。
 *
 * @param {{total:number, unlocked:number}} extra
 * @param {object|null} entry  客户端 / 服务端进度条目
 * @returns {{total:number|null, unlocked:number|null, all_unlocked:boolean, source:'manual-extra'}|object}
 */
export function mergeExtraProgress(extra, entry) {
    const total = Number(extra?.total);
    const unlocked = Number(extra?.unlocked);
    const own = {
        total: Number.isFinite(total) ? total : null,
        unlocked: Number.isFinite(unlocked) ? unlocked : (Number.isFinite(total) ? total : null),
        all_unlocked: true,
        source: 'manual-extra',
    };

    const claimed = Number(entry?.total);
    if (!Number.isFinite(claimed) || claimed <= (Number.isFinite(total) ? total : 0)) return own;
    return { ...entry, source: 'manual-extra' };
}

/**
 * 合并本地 mapCache 与服务端 Player.GetAchievementsProgress 的同一条进度。
 *
 * 本地缓存只覆盖「Steam 最近刷新过」的游戏，缺条、total=0、进度过期都很常见；
 * 服务端是 Steam 自己算「完美游戏」用的权威数据。合并原则：
 *   1. 只有一边有可用数据就用那一边；
 *   2. 总数不同 → 取更大的（游戏加了新成就，旧缓存必须作废）；
 *   3. 总数相同 → all_unlocked 优先，其次解锁数更多，最后缓存时间更新的；
 *      打满不会退回，所以「完成」永远不会被「未完成」覆盖。
 *
 * @param {object|null} local
 * @param {object|null} remote
 * @returns {object|null}
 */
export function mergeProgress(local, remote) {
    const l = usableProgress(local);
    const r = usableProgress(remote);
    if (!l) return r ?? local ?? null;
    if (!r) return l;

    if (l.total !== r.total) return r.total > l.total ? r : l;

    if (r.all_unlocked === true && l.all_unlocked !== true) return r;
    if (l.all_unlocked === true && r.all_unlocked !== true) return l;

    const lu = Number.isFinite(l.unlocked) ? l.unlocked : -1;
    const ru = Number.isFinite(r.unlocked) ? r.unlocked : -1;
    if (lu !== ru) return ru > lu ? r : l;

    const lt = Number.isFinite(l.cache_time) ? l.cache_time : 0;
    const rt = Number.isFinite(r.cache_time) ? r.cache_time : 0;
    return rt > lt ? r : l;
}

function usableProgress(entry) {
    return entry && typeof entry === 'object' && Number.isFinite(entry.total) && entry.total > 0 ? entry : null;
}

/**
 * 从 SteamClient.Apps.GetMyAchievementsForApp 的返回里算出完成时间。
 *
 * 依据用户决策 3：完成日期 = 该游戏**最后一个成就的解锁时间**。
 * 这在 Steam 的数据里是精确可得的（每条成就都有 rtUnlocked，单位是 Unix 秒）。
 *
 * @param {{rgAchievements?: Array<{bAchieved?: boolean, rtUnlocked?: number}>}} [data]
 * @returns {number|null} 秒级时间戳；无法确证时返回 null（绝不推测）
 */
export function computeCompletedAt(data) {
    const list = data?.rgAchievements;
    if (!Array.isArray(list) || list.length === 0) return null;

    let latest = 0;
    let achievedCount = 0;

    for (const item of list) {
        if (!item || item.bAchieved !== true) continue;
        achievedCount += 1;
        // 客户端返回的 64 位整数有可能是字符串（protobuf 的 int64 常常这么传），
        // 所以数字、数字字符串、BigInt 都认
        const ts = toSeconds(item.rtUnlocked);
        if (ts != null && ts > latest) latest = ts;
    }

    // 一个成就都没解锁 => 没有完成时间可言
    if (achievedCount === 0 || latest <= 0) return null;

    // 别把明显不合理的未来时间当成日期（客户端时钟错乱时的防御）
    if (latest > Date.now() / 1000 + 86400) return null;

    return latest;
}

/** 把各种形态的时间戳统一成「秒」；认不出来就返回 null */
function toSeconds(value) {
    if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
    if (typeof value === 'bigint') return value > 0n ? Number(value) : null;
    if (typeof value === 'string') {
        const text = value.trim();
        if (!/^\d+$/.test(text)) return null;
        const n = Number(text);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    return null;
}

/** 全球解锁率低于这个百分比的成就算「稀有」（和预览、Valve 展柜同一口径） */
export const RARE_THRESHOLD = 10;

/**
 * 按 Steam 全球解锁率统计奖杯。缺少或无效的百分比单独计为未统计，
 * 不会让已有的金杯 / 银杯统计整批失效，也不会猜成银杯。
 *
 * @returns {{rare:number, common:number, unrated:number}|null}
 */
export function computeRarityCounts(data, expectedTotal) {
    const list = data?.rgAchievements;
    if (!Array.isArray(list)) return null;

    const total = Number.isInteger(expectedTotal) && expectedTotal >= 0 ? expectedTotal : list.length;
    if (list.length > total) return { rare: 0, common: 0, unrated: total };

    let rare = 0;
    let common = 0;
    let unrated = total - list.length;
    for (const item of list) {
        const pct = item?.flAchieved;
        if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
            unrated += 1;
        } else if (pct < RARE_THRESHOLD) {
            rare += 1;
        } else {
            common += 1;
        }
    }
    return { rare, common, unrated };
}

/**
 * 把一处数据源的结果规范化成统一的卡片对象。
 *
 * @param {object} input
 * @param {number} input.appid
 * @param {object|null} input.overview   window.appStore.GetAppOverviewByAppID(appid)
 * @param {object|null} input.libraryAssets  appDetailsStore.GetAppDetails(appid).libraryAssets
 * @param {object|null} input.progress   mapCache 里的一条记录
 * @param {number|null} input.completedAt 由 computeCompletedAt 得出，可为 null
 * @param {number|null} input.catalogueIndex
 * @param {'client-cache'|'client-api'|'none'} input.source
 * @param {number} input.syncedAt
 */
export function buildCard({
    appid,
    overview,
    libraryAssets = null,
    progress,
    completedAt = null,
    catalogueIndex = null,
    source = 'client-cache',
    syncedAt = Date.now(),
}) {
    const state = classify(progress);
    const displayName = overview?.display_name?.trim?.() || null;

    return {
        appid,

        // 名称：优先 app overview；不在库里的游戏没有 overview，先占个位，
        // 随后由 store 通过 appInfoStore 补上真名（nameMissing 标记的就是这种）
        name: displayName || `App ${appid}`,
        nameMissing: !displayName,

        // 美术资源：优先 app overview 里的覆盖文件名，缺省时退回固定文件名
        art: buildArt(appid, overview, libraryAssets),

        unlocked: Number.isFinite(progress?.unlocked) ? progress.unlocked : null,
        total: Number.isFinite(progress?.total) ? progress.total : null,
        state,

        source: state === 'unknown' ? 'none' : source,
        // cacheTime 是**缓存写入时间**，不是完成时间。只在诊断里用，绝不当作日期展示。
        cacheTime: Number.isFinite(progress?.cache_time) ? progress.cache_time : null,

        // 只在能确证时才填。为 null 时卡片上不渲染日期那一行。
        completedAt: Number.isFinite(completedAt) && completedAt > 0 ? completedAt : null,
        completedAtSource: Number.isFinite(completedAt) && completedAt > 0 ? 'achievements-api' : 'none',

        // 全球完成率尚未统计时全部显示为未统计，避免先把它们误画成银杯
        rare: null,
        common: null,
        unrated: Number.isFinite(progress?.total) && progress.total >= 0 ? progress.total : null,

        playtimeMin: Number.isFinite(overview?.minutes_playtime_forever) ? overview.minutes_playtime_forever : null,
        playtimeSource: Number.isFinite(overview?.minutes_playtime_forever) ? 'api' : 'none',
        lastPlayed: Number.isFinite(overview?.rt_last_time_played) ? overview.rt_last_time_played : null,

        catalogueIndex,
        hasDlcAchievements: null, // 本地数据没有基础游戏 / DLC 的拆分，不能假装能区分
        syncedAt,
    };
}

const ART_BASE = 'https://shared.steamstatic.com/store_item_assets/steam/apps/';

/**
 * 美术资源：每一项都是**候选地址链**，前面的加载失败就换下一个
 * （见 cardview.js 的 artImage）。
 *
 * 顺序照着 Steam 自己的做法来 —— 客户端渲染库里的封面时用的是
 *   BuildCachedLibraryAssetURL → `/assets/<appid>/<文件名>?c=<本地缓存版本>`
 *   BuildLibraryAssetURL       → `…/store_item_assets/steam/apps/<appid>/<文件名>?t=<上架时间>`
 * 页面本身就跑在 steamloopback.host 上，所以 `/assets/...` 是**同源直取客户端本地图片缓存**：
 * 快、离线可用，而且新上架游戏在 CDN 上还没有的那些图它也有。
 * 文件名优先用 appStore 给的真实文件名，再退回约定俗成的固定名。
 */
export function buildArt(appid, overview, libraryAssets) {
    const cache = Number.isFinite(overview?.local_cache_version) ? overview.local_cache_version : 0;
    const mtime = Number.isFinite(overview?.rt_store_asset_mtime) ? overview.rt_store_asset_mtime : 0;
    const heroFile = sanitizeAssetPath(libraryAssets?.strHeroImage) || 'library_hero.jpg';
    const headerFile =
        sanitizeAssetPath(libraryAssets?.strHeaderImage) ||
        sanitizeAssetPath(overview?.header_filename) ||
        'header.jpg';
    const capsuleFile = sanitizeAssetPath(overview?.library_capsule_filename) || 'library_600x900.jpg';
    const logoFile = sanitizeAssetPath(libraryAssets?.strLogoImage) || 'logo.png';

    const local = (file) => `/assets/${appid}/${file}?c=${cache}`;
    const legacy = (file) => `/assets/${appid}_${file}?c=${cache}`;
    const cdn = (file) => `${ART_BASE}${appid}/${file}?t=${mtime}`;

    return {
        hero: dedupe([
            local(heroFile),
            legacy('library_hero.jpg'),
            cdn(heroFile),
            local('library_hero.jpg'),
            cdn('library_hero.jpg'),
            local('library_header.jpg'),
            cdn('library_header.jpg'),
        ]),
        capsule: dedupe([
            local(capsuleFile),
            local('library_600x900.jpg'),
            local('library_capsule.jpg'),
            ...(capsuleFile.includes('/') ? [] : [legacy(capsuleFile)]),
            cdn(capsuleFile),
            cdn('library_600x900.jpg'),
            cdn('library_capsule.jpg'),
        ]),
        header: dedupe([
            local(headerFile),
            ...(headerFile.includes('/') ? [] : [legacy(headerFile)]),
            cdn(headerFile),
            local('header.jpg'),
            cdn('header.jpg'),
        ]),
        // 库里叠在主视觉上的透明标志（年份页的横幅用）
        logo: dedupe([local(logoFile), cdn(logoFile), local('logo.png'), cdn('logo.png')]),
    };
}

function dedupe(list) {
    return [...new Set(list)];
}

/** Steam 的 libraryAssets / overview 可能返回「哈希目录/文件名」形式的相对路径。 */
function sanitizeAssetPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) return null;
    if (/[\\?#%:]/.test(value)) return null;
    const segments = value.split('/');
    if (segments.length > 2 || segments.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) return null;
    return segments.join('/');
}

/**
 * 收藏编号：按 appid 稳定排序后的目录序号。
 * 这是**编目索引**，不是统计数据，因此不构成伪造。
 */
export function buildCatalogueIndex(appids) {
    const sorted = [...new Set(appids)].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const map = new Map();
    sorted.forEach((appid, i) => map.set(appid, i + 1));
    return map;
}

/* ── 排序 / 筛选 ────────────────────────────────────────────────────────── */

export const SORT_KEYS = ['name', 'recent', 'achievements', 'catalogue', 'completed'];

export function sortCards(cards, key) {
    const list = [...cards];
    switch (key) {
        case 'recent':
            return list.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0) || compareName(a, b));
        case 'achievements':
            return list.sort((a, b) => (b.total ?? 0) - (a.total ?? 0) || compareName(a, b));
        case 'catalogue':
            return list.sort((a, b) => (a.catalogueIndex ?? 1e9) - (b.catalogueIndex ?? 1e9));
        case 'completed':
            // 没有日期的排到最后（不是按 0 排，否则会混进「很久以前」）
            return list.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0) || compareName(a, b));
        case 'name':
        default:
            return list.sort(compareName);
    }
}

const nameCollator = new Intl.Collator('zh-CN');
function compareName(a, b) {
    return nameCollator.compare(a.name, b.name);
}

export const FILTER_KEYS = ['all', 'base', 'dlc', 'dated', 'undated'];

export function filterCards(cards, key) {
    switch (key) {
        case 'dated':
            return cards.filter((c) => c.completedAt != null);
        case 'undated':
            return cards.filter((c) => c.completedAt == null);
        case 'dlc':
        case 'base':
            // 本地数据没有基础游戏 / DLC 的拆分口径，这两项只保留占位；
            // 真正可用时再在 buildCard 里填 hasDlcAchievements。
            return cards;
        case 'all':
        default:
            return cards;
    }
}

/**
 * 「最近完成」排序只有在真的拿到完成日期之后才允许出现在选项里。
 * 没有真实日期就不提供这个选项，绝不用 cache_time 之类的字段冒充。
 */
export function availableSortKeys(cards) {
    const base = ['name', 'recent', 'achievements', 'catalogue'];
    return cards.some((c) => c.completedAt != null) ? ['completed', ...base] : base;
}

/* ── 汇总 ───────────────────────────────────────────────────────────────── */

export function summarize(cards, totalLibraryApps) {
    return {
        cardCount: cards.length,
        achievementCount: cards.reduce((sum, c) => sum + (c.total ?? 0), 0),
        datedCount: cards.filter((c) => c.completedAt != null).length,
        totalLibraryApps,
    };
}
