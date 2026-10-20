/**
 * 成就收藏册 · 状态层
 *
 * 一个极小的状态容器：展示层只读它、订阅它，不认识任何 Steam API。
 * 另外承担两件事：
 *
 *   1. **取消令牌**（需求文档技术原则第 5 条）
 *      一个单调递增的 generation。任何异步操作开始时捕获当前值，
 *      回调返回时若 generation 已变化就直接丢弃结果。
 *      触发递增：页面卸载、路由离开、手动刷新、数据源切换。
 *
 *   2. **增量通知**
 *      完成日期是一个一个补上来的。每次都让 77 张卡整体重渲染太浪费，
 *      所以 emit 会带上「这次变了哪些 appid」，卡片组件按 appid 订阅。
 *
 *   3. **新收录**
 *      和上次记下的「已收进册子的游戏」比一比，多出来的就是新全成就的游戏。
 *      页面等它们的完成日期到了再播入册动画，播完调 markIntroduced() 记下来。
 */

import * as data from './datasource.js';
import * as cache from './cache.js';
import {
    availableSortKeys,
    buildArt,
    buildCard,
    buildCatalogueIndex,
    classify,
    computeCompletedAt,
    computeRarityCounts,
    sortCards,
    summarize,
} from './model.js';
import { Generation, log, warn, tagged } from './utils.js';

const out = tagged('store');

/** 相邻两次日期请求之间留一点间隔，避免把序列打满 */
const DATE_FETCH_GAP_MS = 180;
/** 读取失败的隔这么久再试一次 */
const DATE_RETRY_DELAY_MS = 1500;
/** 一次运行（Steam 启动到退出）里，一个游戏最多请求这么多次：第一次 + 失败后重试一次 */
const MAX_ATTEMPTS = 2;
/** 稀有数来自全球解锁率，会慢慢漂移：取回超过这么久的，顺带刷新 */
const RARE_REFRESH_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 每次打开卡包最多顺带刷新这么多条，不会某天一下子把整册重新请求一遍 */
const RARE_REFRESH_PER_OPEN = 4;

const listeners = new Set();
const generation = new Generation();

let state = initialState();

function initialState() {
    return {
        /** idle | loading | ready | not-ready | empty | error */
        phase: 'idle',
        /** 主数据源没就绪（m_achievementProgress 为空）。
         *  即便有缓存可以撑着，也必须明确告诉用户「正在等待 Steam 数据」，
         *  不能让缓存冒充成最新状态。 */
        waitingForSource: false,
        cards: [],
        /** 数据未知的库内游戏（total === 0），不进入卡包 */
        unknownApps: [],
        /** 库内完全没有缓存的游戏数量（只报数，不逐条列出） */
        noCacheCount: 0,
        summary: { cardCount: 0, achievementCount: 0, datedCount: 0, totalLibraryApps: 0 },
        /** 册子的主人（昵称 / 头像），拿不到就是 null —— 见 datasource.getOwner() */
        owner: null,
        /** 首屏用的是本地派生缓存 */
        fromCache: false,
        stale: false,
        syncing: false,
        error: null,
        syncedAt: null,
        sortKeys: ['name', 'recent', 'achievements', 'catalogue'],
        dates: { enabled: true, running: false, done: 0, total: 0, ok: 0, failed: 0 },
        /** 新收录、还没播入册动画的游戏；ready = 它们的完成日期已经有结果（拿到或确定拿不到） */
        intro: { appids: [], ready: false },
    };
}

/* ── 订阅 ───────────────────────────────────────────────────────────────── */

export function getState() {
    return state;
}

export function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function emit(changedAppids = null, reason = 'update') {
    for (const listener of [...listeners]) {
        try {
            listener({ changedAppids, reason });
        } catch (err) {
            warn('订阅者抛错（已忽略）', err);
        }
    }
}

function setState(patch, changedAppids = null, reason = 'update') {
    state = { ...state, ...patch };
    emit(changedAppids, reason);
}

/* ── 组装卡片 ───────────────────────────────────────────────────────────── */

function assemble() {
    const { status, entries } = data.readProgress();
    if (status !== 'ready') {
        return { status, cards: [], unknownApps: [], noCacheCount: 0 };
    }

    const libraryApps = data.listLibraryApps();
    const catalogue = buildCatalogueIndex(libraryApps.map((a) => a.appid));

    const cards = [];
    const unknownApps = [];
    /** 明确没打满的（不是「不知道」）：游戏加了新成就后会落到这里 */
    const incomplete = [];
    let noCacheCount = 0;

    for (const overview of libraryApps) {
        const appid = overview?.appid;
        if (!Number.isFinite(appid)) continue;

        const progress = entries.get(appid) ?? null;

        if (!progress) {
            // 客户端压根没缓存这个游戏 —— 不算「未知」，只是没数据，不做任何断言
            noCacheCount += 1;
            continue;
        }

        const state_ = classify(progress);
        if (state_ === 'unknown') {
            unknownApps.push({ appid, name: overview.display_name || `App ${appid}`, total: progress.total ?? null });
            continue;
        }
        if (state_ === 'incomplete') incomplete.push(appid);
        if (state_ !== 'complete') continue;

        cards.push(
            buildCard({
                appid,
                overview,
                libraryAssets: data.getLibraryAssets(appid),
                progress,
                completedAt: null, // 稍后由日期补全流程填
                catalogueIndex: catalogue.get(appid) ?? null,
                source: 'client-cache',
            }),
        );
    }

    // mapCache 里有、但库列表里没有的游戏（隐藏 / 家庭共享 / 已移除）也一并收进来，
    // 否则「卡片数量与客户端数据一致」这条验收对不上。
    const seen = new Set(libraryApps.map((a) => a?.appid));
    for (const [appid, progress] of entries) {
        if (seen.has(appid)) continue;
        const state_ = classify(progress);
        if (state_ === 'incomplete') incomplete.push(appid);
        if (state_ !== 'complete') continue;
        const overview = data.getOverview(appid);
        cards.push(
            buildCard({
                appid,
                overview,
                libraryAssets: data.getLibraryAssets(appid),
                progress,
                completedAt: null,
                catalogueIndex: catalogue.get(appid) ?? null,
                source: 'client-cache',
            }),
        );
    }

    return { status: 'ready', cards, unknownApps, incomplete, noCacheCount };
}

/* ── 新收录 ─────────────────────────────────────────────────────────────── */

/**
 * 和「已收进册子的游戏」比一比，返回新收录的 appid。
 *
 * 第一次（从来没记录过）不算新收录：把现有的全部记下，什么动画都不播。
 * 明确变回「没打满」的游戏（加了新成就）从记录里移出 —— 下次再打满时它会作为新收录再入册一次。
 * 只是「不知道」（total 为 0、数据缺失）的不移出，免得数据没到齐时误播动画。
 *
 * @param {boolean} [persist=true]  false 时只读不写（首屏缓存阶段用）
 */
function detectFresh(cards, incomplete = [], persist = true) {
    const shelved = cache.readShelved();
    const current = cards.map((c) => c.appid);
    if (!shelved) {
        if (persist) cache.writeShelved(current);
        return [];
    }
    if (persist) {
        let changed = false;
        for (const appid of incomplete) if (shelved.delete(appid)) changed = true;
        if (changed) cache.writeShelved(shelved);
    }
    return current.filter((appid) => !shelved.has(appid));
}

/** 入册动画播完：记进「已收进册子」 */
export function markIntroduced(appids) {
    const shelved = cache.readShelved() ?? new Set();
    for (const appid of appids) shelved.add(appid);
    cache.writeShelved(shelved);
    const rest = state.intro.appids.filter((appid) => !appids.includes(appid));
    setState({ intro: { appids: rest, ready: rest.length === 0 || state.intro.ready } }, null, 'intro-done');
    out.log(`新收录入册：${appids.join(', ')}`);
}

/** 新收录的完成日期都有结果了（或者补全流程已经结束），就可以播动画了 */
function settleIntro() {
    const { appids, ready } = state.intro;
    if (ready || appids.length === 0) return;
    const dated = new Set(state.cards.filter((c) => c.completedAt != null).map((c) => c.appid));
    if (state.dates.running && !appids.every((appid) => dated.has(appid) || settled.has(appid))) return;
    setState({ intro: { appids, ready: true } }, null, 'intro-ready');
}

/* ── 加载 ───────────────────────────────────────────────────────────────── */

let syncing = false;

/**
 * @param {{ silent?: boolean }} [options]
 *        silent = true 时不清屏，用客户端数据静默校正首屏缓存
 */
export async function load({ silent = false } = {}) {
    stopCachedMetadata();
    const isCurrent = generation.guard();
    syncing = true;

    // 1) 先上本地派生缓存，让首屏立刻有东西
    if (!silent) {
        const cached = cache.readState();
        if (cached && cached.cards.length > 0) {
            setState(
                {
                    phase: 'ready',
                    cards: cached.cards,
                    fromCache: true,
                    stale: cached.stale,
                    syncing: false,
                    error: null,
                    summary: summarize(cached.cards, cached.cards.length),
                    sortKeys: availableSortKeys(cached.cards),
                    // 缓存里可能已经有上次没来得及入册的新卡：先藏着，别在首屏一闪而过
                    intro: { appids: detectFresh(cached.cards, [], false), ready: false },
                },
                null,
                'cache',
            );
        } else {
            setState({ phase: 'loading', error: null }, null, 'loading');
        }
    } else {
        setState({ syncing: true });
    }

    // 2) 读客户端数据（这是唯一的数据真相来源）
    let assembled;
    try {
        assembled = assemble();
    } catch (err) {
        if (!isCurrent()) return;
        out.fail('组装卡片时出错', err);
        // 铁律 2：出错 => 保留现有卡片，只报错，绝不清空
        setState({ phase: 'error', syncing: false, error: err?.message ?? String(err) }, null, 'error');
        return;
    }

    if (!isCurrent()) {
        out.log('加载结果已过期（generation 变化），丢弃');
        return;
    }

    if (assembled.status !== 'ready') {
        // 数据源没就绪 —— 有缓存就先撑着（但必须明确标注数据未就绪），
        // 没有缓存就走「正在等待 Steam 数据…」。
        const hasCache = state.cards.length > 0;
        setState(
            {
                phase: hasCache ? 'ready' : 'not-ready',
                syncing: false,
                fromCache: hasCache,
                waitingForSource: true,
                error: null,
            },
            null,
            'not-ready',
        );
        return;
    }

    // 3) 用客户端数据校正（客户端永远优先，缓存只是首屏加速）
    //    完成日期 / 稀有数来自之前按需请求的结果；名字只沿用本次会话里 appInfoStore 查到的
    //    （不从本地缓存里拿 —— 缓存不能覆盖客户端，铁律 3）
    const dates = cache.readDates();
    const cards = assembled.cards.map((card) => {
        let next = card;
        const known = dates.get(card.appid);
        // 成就总数变了（游戏加了新成就、又被重新打满）：旧的完成日期不算数，重新取
        if (known && known.total === card.total) {
            next = {
                ...next,
                completedAt: known.completedAt,
                completedAtSource: 'achievements-api',
                rare: known.rare,
                common: known.common,
                unrated: Number.isFinite(known.unrated) ? known.unrated : known.rare == null ? card.total : 0,
                rarityFetchedAt: known.fetchedAt,
            };
        }
        if (next.nameMissing && resolvedNames.has(card.appid)) next = { ...next, name: resolvedNames.get(card.appid), nameMissing: false };
        return next;
    });

    const summary = summarize(cards, data.listLibraryApps().length);
    const fresh = detectFresh(cards, assembled.incomplete);
    if (fresh.length > 0) out.log(`新收录 ${fresh.length} 款：${fresh.join(', ')}`);

    setState(
        {
            phase: cards.length === 0 ? 'empty' : 'ready',
            cards,
            unknownApps: assembled.unknownApps,
            noCacheCount: assembled.noCacheCount,
            summary,
            fromCache: false,
            stale: false,
            syncing: false,
            waitingForSource: false,
            error: null,
            syncedAt: Date.now(),
            sortKeys: availableSortKeys(cards),
            intro: { appids: fresh, ready: false },
        },
        null,
        'client',
    );

    cache.writeState(cards);

    // 4) 不在库里的游戏补上真名
    fillMissingNames(cards, isCurrent);

    // Global percentages and artwork load independently of completion dates.
    startCachedMetadata(cards, dates, isCurrent);

    // 5) 后台串行补完成日期；绝不再从个人成就接口取全球完成率。
    startDateBackfill(cards, dates, fresh, isCurrent);
}

/** appInfoStore 查到的游戏名（只在内存里，本次会话有效） */
const resolvedNames = new Map();

let metadataController = null;

function stopCachedMetadata() {
    metadataController?.abort();
    metadataController = null;
}

function startCachedMetadata(cards, dates, isCurrent) {
    const controller = new AbortController();
    metadataController = controller;
    const signal = controller.signal;
    const active = () => !signal.aborted && isCurrent();

    // Each worker is serial; global stats never wait for artwork or date requests.
    (async () => {
        let updated = 0;
        const aging = cards.filter((c) => c.rare != null && c.common != null && c.unrated === 0
            && Date.now() - (dates.get(c.appid)?.fetchedAt ?? 0) > RARE_REFRESH_AGE_MS)
            .sort((a, b) => (dates.get(a.appid)?.fetchedAt ?? 0) - (dates.get(b.appid)?.fetchedAt ?? 0));
        const missing = cards.filter((c) => c.rare == null || c.common == null || c.unrated !== 0);
        for (const card of [...missing, ...aging.slice(0, RARE_REFRESH_PER_OPEN)]) {
            if (!active()) return;
            const result = await data.requestGlobalAchievements(card.appid, { signal, expectedTotal: card.total });
            if (!active()) return;
            const current = state.cards.find((c) => c.appid === card.appid);
            const rarity = computeRarityCounts(result, current?.total);
            if (!current || !rarity || rarity.unrated === current.total) continue;
            // A partial response must not erase a more complete classification.
            if (current.rare != null && Number.isFinite(current.unrated) && rarity.unrated > current.unrated) continue;
            const fetchedAt = Date.now();
            patchCard(card.appid, { ...rarity, raritySource: result.source, rarityFetchedAt: fetchedAt });
            const known = dates.get(card.appid);
            if (known?.total === current.total) {
                dates.set(card.appid, { ...known, ...rarity, fetchedAt });
                cache.writeDates(dates);
            }
            updated++;
            await sleep(DATE_FETCH_GAP_MS);
        }
        if (!active()) return;
        cache.writeState(state.cards);
        out.log(`全球完成率：更新 ${updated}/${cards.length} 款`);
    })().catch((err) => warn('读取全球完成率失败', err));

    (async () => {
        for (const card of cards) {
            if (!active()) return;
            const assets = await data.requestLibraryAssets(card.appid, { signal });
            if (!active()) return;
            if (!assets) continue;
            const art = buildArt(card.appid, data.getOverview(card.appid), assets);
            const current = state.cards.find((c) => c.appid === card.appid);
            if (current && JSON.stringify(current.art) !== JSON.stringify(art)) patchCard(card.appid, { art });
        }
        if (active()) cache.writeState(state.cards);
    })().catch((err) => warn('读取封面详情失败', err));
}

/** 名字只剩 appid 的卡（游戏已不在库里），用 appInfoStore 查真名后就地替换 */
function fillMissingNames(cards, isCurrent) {
    const missing = cards.filter((c) => c.nameMissing).map((c) => c.appid);
    if (missing.length === 0) return;

    data.resolveAppNames(missing)
        .then((names) => {
            for (const [appid, name] of names) resolvedNames.set(appid, name);
            if (!isCurrent() || names.size === 0) return;
            for (const [appid, name] of names) patchCard(appid, { name, nameMissing: false });
            cache.writeState(state.cards);
            out.log(`补上了 ${names.size} 个游戏名`);
        })
        .catch((err) => warn('查询游戏名失败（卡片上暂时显示 appid）', err));
}

/** 手动刷新：递增 generation，丢弃所有在途结果 */
export async function refresh() {
    generation.bump();
    data.resetInFlight();
    stopDateBackfill();
    log('手动刷新，已丢弃所有在途请求');
    await load({ silent: false });
}

/* ── 完成日期补全（串行 · 去重 · 限流） ─────────────────────────────────── */

let backfillToken = null;
/** 本次运行里每个游戏请求过几次（只在内存里；Steam 重启后失败的会重新试） */
const attempts = new Map();
/** 当前这一轮里已经有结果的游戏（拿到日期，或确定拿不到） */
const settled = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function stopDateBackfill() {
    if (backfillToken) {
        backfillToken.cancelled = true;
        backfillToken = null;
    }
}

/**
 * 这一轮要请求哪些游戏、按什么顺序：
 *   1. 新收录的（入册动画在等它们的日期）；
 *   2. 还没有日期的，按最近游玩时间从近到远 —— 最近玩的多半也是最近打满的，
 *      册子最前面几页最先补齐；
 * 完成日期本身不会过期，所以平时打开卡包几乎不发请求。
 */
function planDateRequests(cards, known, fresh) {
    const first = [];
    const missing = [];
    for (const card of cards) {
        if ((attempts.get(card.appid) ?? 0) >= MAX_ATTEMPTS) continue;
        const entry = known.get(card.appid);
        if (!entry || entry.total !== card.total || entry.completedAt == null) {
            (fresh.has(card.appid) ? first : missing).push(card);
        }
    }
    missing.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
    return [...first, ...missing].map((c) => c.appid);
}

function startDateBackfill(cards, known, fresh = [], isCurrent = () => true) {
    stopDateBackfill();
    settled.clear();

    if (!state.dates.enabled) {
        out.log('完成日期读取已在主题设置里关闭');
        setState({ dates: { ...state.dates, enabled: false, running: false } });
        settleIntro();
        return;
    }
    if (!data.probeAchievementsApi()) {
        warn('SteamClient.Apps.GetMyAchievementsForApp 不可用，完成日期全部留空');
        setState({ dates: { ...state.dates, running: false, total: 0, done: 0 } });
        settleIntro();
        return;
    }

    const freshSet = new Set(fresh);
    const targets = planDateRequests(cards, known, freshSet);

    if (targets.length === 0) {
        setState({ dates: { ...state.dates, running: false, total: 0, done: 0, ok: state.summary.datedCount } });
        settleIntro();
        return;
    }

    const token = { cancelled: false };
    backfillToken = token;

    const dates = known;
    const queue = targets.map((appid) => ({ appid, notBefore: 0 }));
    let done = 0;
    let ok = 0;
    let failed = 0;

    setState({
        dates: { enabled: true, running: true, done: 0, total: targets.length, ok: 0, failed: 0 },
    });
    // 新收录的日期可能早就在缓存里了（上次没来得及播动画），那就不用等这一轮
    settleIntro();
    out.log(`开始补完成日期：${targets.length} 款`);

    /** 这个游戏有结果了（拿到日期，或确定拿不到） */
    const finish = (appid, hasDate) => {
        settled.add(appid);
        done += 1;
        if (hasDate) ok += 1;
        else failed += 1;
    };

    (async () => {
        while (queue.length > 0) {
            // 两道取消检查：路由离开/卸载置的 token，以及 generation 是否已经换代。
            // 任何一个变化都不再继续，也不把结果写回 state。
            if (token.cancelled || !isCurrent()) return;

            const { appid, notBefore } = queue.shift();
            if (notBefore > Date.now()) await sleep(notBefore - Date.now());
            if (token.cancelled || !isCurrent()) return;

            attempts.set(appid, (attempts.get(appid) ?? 0) + 1);
            const result = await data.requestAchievements(appid);
            if (token.cancelled || !isCurrent()) return;

            const card = state.cards.find((c) => c.appid === appid);
            if (result.ok) {
                const completedAt = computeCompletedAt(result.data);
                if (completedAt != null && card) {
                    dates.set(appid, {
                        completedAt, rare: card.rare, common: card.common, unrated: card.unrated,
                        total: card.total, fetchedAt: card.rarityFetchedAt ?? 0,
                    });
                    cache.writeDates(dates);
                    patchCard(appid, { completedAt, completedAtSource: 'achievements-api' });
                    finish(appid, true);
                } else {
                    // 拿到了成就列表却没有可用的解锁时间：这是确定的结果，这次运行里不再问
                    attempts.set(appid, MAX_ATTEMPTS);
                    finish(appid, card?.completedAt != null);
                }
            } else if (result.reason !== 'api-unavailable' && attempts.get(appid) < MAX_ATTEMPTS) {
                // 隔一会儿再试一次：新收录的插到最前面（入册动画在等它），其余的排到最后
                const retry = { appid, notBefore: Date.now() + DATE_RETRY_DELAY_MS };
                if (freshSet.has(appid)) queue.unshift(retry);
                else queue.push(retry);
                out.log(`${appid} 的成就读取失败（${result.reason}），稍后重试一次`);
            } else {
                // 已经有日期的（只是顺带刷新稀有数）失败了也不要紧，旧值照用
                finish(appid, card?.completedAt != null);
                out.log(`${appid} 的成就读取失败：${result.reason}`);
            }

            setState({ dates: { ...state.dates, done, ok, failed } }, [appid], 'dates-progress');
            if (freshSet.has(appid)) settleIntro();

            await sleep(DATE_FETCH_GAP_MS);
        }

        if (token.cancelled || !isCurrent()) return;
        cache.writeState(state.cards);
        setState({ dates: { ...state.dates, running: false, done, ok, failed } }, null, 'dates-done');
        settleIntro();
        out.log(`完成日期补全结束：取得 ${ok}，未取得 ${failed}`);
    })().catch((err) => warn('完成日期补全流程异常', err));
}

/** 只替换一张卡，避免整表重渲染 */
function patchCard(appid, patch) {
    const index = state.cards.findIndex((c) => c.appid === appid);
    if (index < 0) return;

    const cards = state.cards.slice();
    cards[index] = { ...cards[index], ...patch };

    const datedCount = cards.filter((c) => c.completedAt != null).length;

    setState(
        {
            cards,
            summary: { ...state.summary, datedCount },
            sortKeys: availableSortKeys(cards),
        },
        [appid],
        'card-patched',
    );
}

/* ── 册子的主人 ─────────────────────────────────────────────────────────── */

let ownerLoaded = false;

/** 取当前账号的昵称/头像（拿不到就算了，卡面会只显示完成日期） */
export async function loadOwner() {
    if (ownerLoaded || state.owner) return;
    ownerLoaded = true;
    try {
        const owner = await data.getOwner();
        if (owner?.persona || owner?.avatar) {
            setState({ owner }, null, 'owner');
            out.log('当前账号', owner);
        } else {
            // 好友/个人资料数据可能还没就绪：下次打开卡包时再试
            ownerLoaded = false;
            out.log('暂时拿不到当前账号的昵称/头像，卡面只显示完成日期', owner);
        }
    } catch (err) {
        warn('读取当前账号信息失败', err);
    }
}

/* ── 派生视图：按完成时间倒序（最近完成的排在最前面） ───────────────────── */

export function selectVisibleCards() {
    return sortCards(state.cards, 'completed');
}

export function setDatesEnabled(enabled) {
    setState({ dates: { ...state.dates, enabled } });
}

/* ── 生命周期 ───────────────────────────────────────────────────────────── */

/**
 * 路由离开 / 页面卸载时调用。
 *
 * 刻意**不清空** state（同一会话里回到页面时能立刻出内容），
 * 但必须停掉后台的日期补全循环，并让所有在途结果作废 ——
 * 这是需求文档「不遗留持续运行的定时器」的落地。
 */
export function pause() {
    generation.bump();
    stopCachedMetadata();
    stopDateBackfill();
    data.resetInFlight();
    if (state.dates.running) {
        setState({ dates: { ...state.dates, running: false } }, null, 'paused');
    }
}

export function dispose() {
    resolvedNames.clear();
    attempts.clear();
    settled.clear();
    generation.bump();
    stopCachedMetadata();
    stopDateBackfill();
    data.resetInFlight();
    listeners.clear();
    state = initialState();
}

/** 供 selftest 用 */
export const __debug = { generation, assemble, initialState };
