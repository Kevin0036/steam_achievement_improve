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
import * as accounts from './accounts.js';
import {
    availableSortKeys,
    buildArt,
    buildCard,
    buildCatalogueIndex,
    classify,
    completionEvidence,
    computeCompletedAt,
    computeRarityCounts,
    confirmCompletion,
    mergeExtraProgress,
    sortCards,
    summarize,
    verifyExtraCompletion,
} from './model.js';
import { Generation, log, warn, tagged } from './utils.js';

const out = tagged('store');

/** 相邻两次日期请求之间留一点间隔，避免把序列打满 */
const DATE_FETCH_GAP_MS = 180;
/** 读取失败的隔这么久再试一次 */
const DATE_RETRY_DELAY_MS = 1500;
/** 每轮日期补全中，一个游戏最多请求这么多次：第一次 + 失败后重试一次 */
const MAX_ATTEMPTS = 2;
/** 稀有数来自全球解锁率，会慢慢漂移：取回超过这么久的，顺带刷新 */
const RARE_REFRESH_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 每次打开卡包最多顺带刷新这么多条，不会某天一下子把整册重新请求一遍 */
const RARE_REFRESH_PER_OPEN = 4;
const DATE_FETCH_PER_OPEN = 80;
const MISSING_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const ERROR_COOLDOWN_MS = 5 * 60 * 1000;

let failures = new Map();
function cooling(kind, card) {
    const entry = failures.get(`${kind}:${card.appid}`);
    return entry?.total === card.total && entry.retryAt > Date.now();
}

function recordFailure(kind, card, reason, ttl = MISSING_COOLDOWN_MS) {
    failures.set(`${kind}:${card.appid}`, { total: card.total, reason, retryAt: Date.now() + ttl });
    cache.writeFailures(failures);
}

function clearFailure(kind, appid) {
    if (failures.delete(`${kind}:${appid}`)) cache.writeFailures(failures);
}

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
        /** unavailable：确定取不到完成日期的 appid（补日期入口据此出现） */
        dates: { enabled: true, running: false, done: 0, total: 0, ok: 0, failed: 0, unavailable: new Set() },
        /** 手动补日期的修订号：每次改一张手动日期 +1，展示层据此在补日期期间也重排 */
        manualRevision: 0,
        /** 新收录、还没播入册动画的游戏；ready = 它们的完成日期已经有结果（拿到或确定拿不到） */
        intro: { appids: [], ready: false },
        /** 库外游戏扫描：正在核对玩过但已不在库里的游戏 */
        extraScan: {
            running: false,
            finished: false,
            done: 0,
            total: 0,
            added: [],
            rejected: [],
            rejectedTotal: 0,
            unavailable: [],
        },
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

/* ── 手动补的完成日期 ───────────────────────────────────────────────────── */

/** appid → 秒级时间戳；load() 时从缓存读入，set / clear 时就地维护 */
let manualDates = new Map();

/** appid → 分钟；和手动日期一样，load() 时读入、set / clear 时就地维护 */
let manualTimes = new Map();

/**
 * 手动日期优先级最高：接口取不到日期的卡（家庭共享移除等）靠它进入时间排序和年份页。
 * 同时清掉缓存里已经被用户撤销、但 state 快照还没重写时残留的旧手动日期。
 */
function applyManualDates(cards) {
    let changed = false;
    const next = cards.map((card) => {
        const manual = manualDates.get(card.appid);
        if (manual != null) {
            if (card.completedAt === manual && card.completedAtSource === 'manual') return card;
            changed = true;
            return { ...card, completedAt: manual, completedAtSource: 'manual' };
        }
        if (card.completedAtSource === 'manual') {
            changed = true;
            return { ...card, completedAt: null, completedAtSource: 'none' };
        }
        return card;
    });
    return changed ? next : cards;
}

/** 手动时长覆盖接口值；撤销后由 clearManualTime 退回接口值 */
function applyManualTimes(cards) {
    let changed = false;
    const next = cards.map((card) => {
        const manual = manualTimes.get(card.appid);
        if (manual != null) {
            if (card.playtimeMin === manual && card.playtimeSource === 'manual') return card;
            changed = true;
            return { ...card, playtimeMin: manual, playtimeSource: 'manual' };
        }
        if (card.playtimeSource === 'manual') {
            changed = true;
            return { ...card, playtimeMin: null, playtimeSource: 'none' };
        }
        return card;
    });
    return changed ? next : cards;
}

/** 接口里的游玩时长（分钟）；概览不存在或没有这个字段就是 null */
function apiPlaytime(appid) {
    const minutes = data.getOverview(appid)?.minutes_playtime_forever;
    return Number.isFinite(minutes) ? minutes : null;
}

/* ── 组装卡片 ───────────────────────────────────────────────────────────── */

function assemble() {
    const { status, entries } = data.readEffectiveProgress();
    if (status !== 'ready') {
        return { status, cards: [], unknownApps: [], noCacheCount: 0 };
    }

    const libraryApps = data.listLibraryApps();
    const catalogue = buildCatalogueIndex(libraryApps.map((a) => a.appid));
    const extras = cache.readExtras(data.getAccountFingerprint());

    // 手动收录的库外游戏：Steam 已不再给进度时用收录时确认过的总数；
    // 如果客户端/服务端后来又有进度，则仍以进度为准（加了新成就就要重新打满）
    const progressOf = (appid) => {
        const extra = extras.get(appid);
        if (!extra) return entries.get(appid) ?? null;
        return mergeExtraProgress(extra, entries.get(appid) ?? null);
    };
    const sourceOf = (appid) => (extras.has(appid) ? 'manual-extra' : 'client-cache');

    const cards = [];
    const unknownApps = [];
    /** 明确没打满的（不是「不知道」）：游戏加了新成就后会落到这里 */
    const incomplete = [];
    let noCacheCount = 0;

    for (const overview of libraryApps) {
        const appid = overview?.appid;
        if (!Number.isFinite(appid)) continue;

        const progress = progressOf(appid);

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
                source: sourceOf(appid),
            }),
        );
    }

    // mapCache 里有、但库列表里没有的游戏（隐藏 / 家庭共享 / 已移除）也一并收进来，
    // 否则「卡片数量与客户端数据一致」这条验收对不上。
    const seen = new Set(libraryApps.map((a) => a?.appid));
    for (const [appid, entry] of entries) {
        if (seen.has(appid)) continue;
        // 服务端批量进度里也可能有库外游戏「看似全满」的残缺条目（扫描时批量查过）。
        // 它们只是扫描线索，不能直接变成卡片；库外卡片只认客户端本地缓存和复核过的收录。
        if (!data.getProgressEntry(appid)) continue;
        const progress = progressOf(appid);
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
                source: sourceOf(appid),
            }),
        );
        seen.add(appid);
    }

    // 手动收录的库外游戏：服务端可能也有一条残缺进度（扫描时批量查过），
    // 以收录时核对过的结论为准；只有总数变大（游戏加了新成就）才重新判定。
    for (const [appid, extra] of extras) {
        if (seen.has(appid)) continue;
        const progress = progressOf(appid);
        if (classify(progress) !== 'complete') continue;
        const overview = data.getOverview(appid);
        const card = buildCard({
            appid,
            overview,
            libraryAssets: data.getLibraryAssets(appid),
            progress,
            completedAt: null,
            catalogueIndex: catalogue.get(appid) ?? null,
            source: 'manual-extra',
        });
        if (card.nameMissing && extra.name) {
            card.name = extra.name;
            card.nameMissing = false;
        }
        cards.push(card);
        seen.add(appid);
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

/* ── 全成就复核 ─────────────────────────────────────────────────────────── */

/**
 * 服务端 Player.GetAchievementsProgress 对部分游戏只返回它已知的成就子集
 * （例如 45 个成就的游戏被报成 3/3）。凡是「本地 mapCache 不能证明全成就」的卡，
 * 都用 Apps.GetMyAchievementsForApp 的完整个人列表复核；
 * 接口不可用时退回本地 achievements 汇总缓存；两者都没有就维持原判（铁律 2）。
 */
const completionChecks = new Map();
let completionReport = { checked: 0, rejected: [], unverified: [] };

async function confirmCompletions(cards, isCurrent) {
    if (!data.probeAchievementsApi()) {
        out.log('全成就复核：个人成就接口不可用，改用服务端解锁记录');
    }

    const effective = data.readEffectiveProgress();
    const fingerprint = data.getAccountFingerprint() ?? 'anon';
    const extras = cache.readExtras(fingerprint === 'anon' ? null : fingerprint);
    const kept = [];
    const dates = new Map();
    const rejected = [];
    const unverified = [];
    let checked = 0;

    for (const card of cards) {
        if (!isCurrent()) return null;

        // 手动收录时已经用完整列表确认过；Steam 已不提供这款游戏的进度
        if (extras.has(card.appid)) {
            kept.push(card);
            continue;
        }

        // 本地 mapCache 也可能只缓存了成就子集（3/45 被记成 3/3），
        // 不能单凭它放行，同样要用完整个人列表复核。
        const progress = effective.entries.get(card.appid) ?? null;
        const key = `${fingerprint}:${card.appid}`;
        const memo = completionChecks.get(key);
        if (memo && memo.claimed === card.total) {
            if (memo.ok) kept.push(card);
            else rejected.push({ appid: card.appid, evidence: memo.evidence });
            continue;
        }

        const result = await data.requestAchievements(card.appid);
        if (!isCurrent()) return null;
        let evidence = result.ok ? completionEvidence(result.data) : null;
        if (!evidence) {
            // 已移出家庭库的游戏可能查不到个人成就列表，服务端解锁记录仍然可用
            const user = await data.requestUserAchievements(card.appid);
            if (!isCurrent()) return null;
            if (user) evidence = { total: user.total, achieved: user.achieved };
        }
        if (!evidence) evidence = await data.requestAchievementSummary(card.appid);
        if (!isCurrent()) return null;

        if (!evidence) {
            completionChecks.delete(key);
            unverified.push(card.appid);
            kept.push(card);
            continue;
        }

        checked += 1;
        const ok = confirmCompletion(progress ?? card, evidence);
        completionChecks.set(key, { claimed: card.total, ok, evidence });
        if (!ok) {
            rejected.push({ appid: card.appid, evidence });
            continue;
        }

        kept.push(card);
        if (result.ok) {
            const completedAt = computeCompletedAt(result.data);
            if (completedAt != null) {
                dates.set(card.appid, {
                    completedAt,
                    rare: null,
                    common: null,
                    unrated: card.total,
                    total: card.total,
                    fetchedAt: 0,
                });
            }
        }
    }

    completionReport = { checked, rejected, unverified };
    if (rejected.length > 0 || unverified.length > 0) {
        const nameOf = new Map(cards.map((card) => [card.appid, card.name]));
        const label = (appid) => nameOf.get(appid) || `App ${appid}`;
        const list = (items) => {
            const text = items.slice(0, 12).map((item) => label(item.appid ?? item)).join('、');
            return items.length > 12 ? `${text} 等 ${items.length} 款` : text;
        };
        out.log(
            `全成就复核：剔除 ${rejected.length} 款${rejected.length ? `（${list(rejected)}）` : ''}`
            + ` · 未能复核 ${unverified.length} 款${unverified.length ? `（${list(unverified)}）` : ''}`,
        );
    } else if (checked > 0) {
        out.log(`全成就复核：${checked} 款候选全部确认`);
    }
    return { cards: kept, dates, report: completionReport };
}

/* ── 账号作用域与多账号合并 ─────────────────────────────────────────────── */

/** 当前登录的 accountId；拿不到时多账号合并整体停用 */
let currentAccountId = null;

/**
 * 缓存键按账号隔离。页面在首次渲染（读页码）之前就要调用它，
 * 否则会先读到上一个账号的缓存键。
 */
export function ensureAccountScope() {
    const fingerprint = data.getAccountFingerprint();
    cache.setAccountScope(fingerprint);
    return fingerprint;
}

async function resolveAccountId() {
    try {
        const owner = await data.getOwner();
        currentAccountId = owner?.accountId ?? null;
    } catch {
        currentAccountId = null;
    }
    // 登录信息可能比首次探测晚到：确认账号后重新落一次缓存作用域
    ensureAccountScope();
    return currentAccountId;
}

/** 当前账号自己的卡永远优先：同一款游戏两边都有时，外部卡直接不出现 */
function withExternal(cards, external) {
    if (external.length === 0) return cards;
    const own = new Set(cards.map((card) => card.appid));
    return [...cards, ...external.filter((card) => !own.has(card.appid))];
}

function mergedCards(cards) {
    return withExternal(cards, accounts.getCards({ currentAccountId }));
}

/** 外部卡没有 syncedAt 之外的版本号，这里用界面看得到的字段判断是否需要重绘 */
function externalSignature(cards) {
    return cards
        .map((card) => `${card.appid}:${card.owner?.persona ?? ''}:${card.owner?.avatar ?? ''}:`
            + `${card.name}:${card.total}:${card.completedAt ?? 0}:${card.playtimeMin ?? 0}:`
            + `${card.rare ?? -1}:${card.common ?? -1}:${card.unrated ?? -1}`)
        .join('|');
}

/**
 * 设置面板改过多账号来源后重新合并；只有外部卡真的变了才 emit。
 * @returns {number} 现在合并了几张外部卡
 */
export function applyExternalAccounts() {
    const external = accounts.getCards({ currentAccountId });
    const before = state.cards.filter((card) => card.source === 'external');
    if (externalSignature(external) === externalSignature(before)) return external.length;

    const cards = withExternal(
        state.cards.filter((card) => card.source !== 'external'),
        external,
    );
    setState(
        {
            cards,
            summary: summarize(cards, state.summary.totalLibraryApps ?? data.listLibraryApps().length),
            sortKeys: availableSortKeys(cards),
        },
        null,
        'external',
    );
    out.log(`多账号合并：当前显示 ${external.length} 张外部卡`);
    return external.length;
}

/** 后台取回别的账号的快照；失败不打扰正常加载，设置面板里能看到来源状态 */
function refreshExternalAccounts(accountId, isCurrent) {
    accounts.refreshAll({
        currentAccountId: accountId,
        isCurrent,
        onUpdate: () => {
            if (isCurrent()) applyExternalAccounts();
        },
    })
        .then((result) => {
            if (!isCurrent()) return;
            if (result?.failed > 0) out.log(`多账号合并：${result.failed} 个来源取回失败`);
        })
        .catch((err) => warn('多账号合并刷新失败', err));
}

/* 设置面板用的入口：账号 id 只在内部使用，不显示、不进界面文案 */

export async function ensureAccountId() {
    if (currentAccountId == null) await resolveAccountId();
    return currentAccountId;
}

export function getCurrentAccountId() {
    return currentAccountId;
}

export function getAccountSources() {
    return accounts.listSources({ currentAccountId });
}

export function accountsEnabled() {
    return accounts.readConfig().enabled;
}

export function setAccountsEnabled(enabled) {
    accounts.setEnabled(enabled);
    applyExternalAccounts();
}

export function addAccountSource(code) {
    return accounts.addSourceByCode(code);
}

export function removeAccountSource(id) {
    const removed = accounts.removeSource(id);
    applyExternalAccounts();
    return removed;
}

/** 设置面板的「刷新快照」；force=false 时沿用 10 分钟节流 */
export async function refreshAccountSources({ force = false } = {}) {
    const isCurrent = generation.guard();
    if (currentAccountId == null) return { ok: false, reason: 'no-account', fetched: 0, failed: 0 };
    const result = await accounts.refreshAll({
        currentAccountId,
        force,
        isCurrent,
        onUpdate: () => {
            if (isCurrent()) applyExternalAccounts();
        },
    });
    if (isCurrent()) applyExternalAccounts();
    return result;
}

/* ── 加载 ───────────────────────────────────────────────────────────────── */

let syncing = false;

/**
 * @param {{ silent?: boolean }} [options]
 *        silent = true 时不清屏，用客户端数据静默校正首屏缓存
 */
export async function load({ silent = false } = {}) {
    stopCachedMetadata();
    ensureAccountScope();
    const isCurrent = generation.guard();
    const accountId = await resolveAccountId();
    if (!isCurrent()) return;
    syncing = true;
    manualDates = cache.readManualDates();
    manualTimes = cache.readManualTimes();
    failures = cache.readFailures();

    // 1) 先上本地派生缓存，让首屏立刻有东西
    if (!silent) {
        const cached = cache.readState();
        if (cached && cached.cards.length > 0) {
            const ownCards = applyManualTimes(applyManualDates(cached.cards));
            const cachedCards = mergedCards(ownCards);
            setState(
                {
                    phase: 'ready',
                    cards: cachedCards,
                    fromCache: true,
                    stale: cached.stale,
                    syncing: false,
                    error: null,
                    summary: summarize(cachedCards, data.listLibraryApps().length),
                    sortKeys: availableSortKeys(cachedCards),
                    // 缓存里可能已经有上次没来得及入册的新卡：先藏着，别在首屏一闪而过
                    intro: { appids: detectFresh(ownCards, [], false), ready: false },
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

    refreshExternalAccounts(accountId, isCurrent);

    // 2) 读客户端数据（这是唯一的数据真相来源）
    let assembled;
    let toppedUp = new Set();
    try {
        assembled = assemble();
        const retainedAppids = new Set([
            ...state.cards.map((card) => card.appid),
            ...(cache.readShelved() ?? []),
            ...manualDates.keys(),
            ...manualTimes.keys(),
            ...cache.readExtras(data.getAccountFingerprint()).keys(),
        ]);
        // 服务端进度是 Steam 自己算「完美游戏」的口径，先把本地缓存缺口补齐
        const remote = await data.ensureServiceProgress({ retainedAppids });
        if (!isCurrent()) return;
        const remoteOk = remote?.ok === true && (remote?.count ?? 0) > 0;
        if ((remote?.added?.length ?? 0) > 0) assembled = assemble();

        if (remoteOk) {
            toppedUp = new Set(remote.added ?? []);
        } else {
            // 服务端接口不可用（离线 / 旧客户端）才退回本地缓存补齐
            const result = await data.ensureProgressCache({ retainedAppids });
            if (!isCurrent()) return;
            toppedUp = new Set(result?.toppedUp ?? result?.attempted ?? []);
            if (assembled.status !== 'ready' || (result?.added?.length ?? 0) > 0) {
                assembled = assemble();
            }
        }
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
        const cards = mergedCards(state.cards.filter((card) => card.source !== 'external'));
        setState(
            {
                phase: hasCache ? 'ready' : 'not-ready',
                cards,
                summary: summarize(cards, state.summary.totalLibraryApps ?? data.listLibraryApps().length),
                sortKeys: availableSortKeys(cards),
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

    // 全成就复核：服务端返回的残缺 schema 不能单独作为入册依据
    const validation = await confirmCompletions(assembled.cards, isCurrent);
    if (!validation || !isCurrent()) return;
    assembled = { ...assembled, cards: validation.cards };

    // 3) 用客户端数据校正（客户端永远优先，缓存只是首屏加速）
    //    完成日期 / 稀有数来自之前按需请求的结果；名字只沿用本次会话里 appInfoStore 查到的
    //    （不从本地缓存里拿 —— 缓存不能覆盖客户端，铁律 3）
    const dates = cache.readDates();
    for (const [appid, entry] of validation.dates) {
        if (!dates.has(appid)) dates.set(appid, entry);
    }
    // 手动日期 / 时长放在成就接口之后合并：用户填的就是最终值，接口后来取到了也以手动为准
    const cards = applyManualTimes(
        applyManualDates(
            assembled.cards.map((card) => {
                let next = card;
                const known = dates.get(card.appid);
                // 成就总数变了（游戏加了新成就、又被重新打满）：旧的完成日期不算数，重新取
                if (known && known.total === card.total) {
                    next = {
                        ...next,
                        completedAt: known.completedAt,
                        completedAtSource: known.completedAt != null ? 'achievements-api' : 'none',
                        rare: known.rare,
                        common: known.common,
                        unrated: Number.isFinite(known.unrated) ? known.unrated : known.rare == null ? card.total : 0,
                        rarityFetchedAt: known.fetchedAt,
                    };
                }
                if (next.nameMissing && resolvedNames.has(card.appid)) next = { ...next, name: resolvedNames.get(card.appid), nameMissing: false };
                return next;
            }),
        ),
    );

    const shown = mergedCards(cards);
    const summary = summarize(shown, data.listLibraryApps().length);

    // 补缓存才浮出来的老游戏不是「新全成就」：直接记为已入册，不播入册动画。
    // 真正刚完成的游戏会先被 Steam 的成就通知写进 mapCache，不会走到这里。
    const shelved = cache.readShelved();
    if (shelved && toppedUp.size > 0) {
        let changed = false;
        for (const card of cards) {
            if (toppedUp.has(card.appid) && !shelved.has(card.appid)) {
                shelved.add(card.appid);
                changed = true;
            }
        }
        if (changed) cache.writeShelved(shelved);
    }
    const fresh = detectFresh(cards, assembled.incomplete).filter((appid) => !toppedUp.has(appid));
    if (fresh.length > 0) out.log(`新收录 ${fresh.length} 款：${fresh.join(', ')}`);

    setState(
        {
            phase: cards.length === 0 && shown.length === 0 ? 'empty' : 'ready',
            cards: shown,
            unknownApps: assembled.unknownApps,
            noCacheCount: assembled.noCacheCount,
            summary,
            fromCache: false,
            stale: false,
            syncing: false,
            waitingForSource: false,
            error: null,
            syncedAt: Date.now(),
            sortKeys: availableSortKeys(shown),
            intro: { appids: fresh, ready: false },
        },
        null,
        'client',
    );

    cache.writeState(cards);
    out.log(getDiagnostics());

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
        const eligible = cards.filter((c) => !cooling('rarity', c));
        const aging = eligible.filter((c) => c.rare != null && c.common != null && c.unrated === 0
            && Date.now() - (dates.get(c.appid)?.fetchedAt ?? 0) > RARE_REFRESH_AGE_MS)
            .sort((a, b) => (dates.get(a.appid)?.fetchedAt ?? 0) - (dates.get(b.appid)?.fetchedAt ?? 0));
        const missing = eligible.filter((c) => c.rare == null || c.common == null || c.unrated !== 0);
        for (const card of [...missing, ...aging.slice(0, RARE_REFRESH_PER_OPEN)]) {
            if (!active()) return;
            const result = await data.requestGlobalAchievements(card.appid, { signal, expectedTotal: card.total });
            if (!active()) return;
            const current = state.cards.find((c) => c.appid === card.appid);
            const rarity = computeRarityCounts(result, current?.total);
            if (!current) continue;
            if (!rarity || rarity.unrated === current.total) {
                // null 也可能来自离线、超时或接口暂不可用，不能据此认定长期缺失。
                recordFailure('rarity', current, result ? 'no-global-percentages' : 'request-unavailable',
                    result ? MISSING_COOLDOWN_MS : ERROR_COOLDOWN_MS);
                continue;
            }
            // A partial response must not erase a more complete classification.
            if (current.rare != null && Number.isFinite(current.unrated) && rarity.unrated > current.unrated) {
                recordFailure('rarity', current, 'partial-global-percentages');
                continue;
            }
            if (rarity.unrated > 0) recordFailure('rarity', current, 'partial-global-percentages');
            else clearFailure('rarity', card.appid);
            const fetchedAt = Date.now();
            patchCard(card.appid, { ...rarity, raritySource: result.source, rarityFetchedAt: fetchedAt });
            const known = dates.get(card.appid);
            dates.set(card.appid, {
                completedAt: known?.total === current.total ? known.completedAt : null,
                total: current.total, ...rarity, fetchedAt,
            });
            cache.writeDates(dates);
            updated++;
            await sleep(DATE_FETCH_GAP_MS);
        }
        if (!active()) return;
        cache.writeState(state.cards);
        cache.flushWrites();
        out.log(`全球完成率：更新 ${updated}/${cards.length} 款`);
    })().catch((err) => warn('读取全球完成率失败', err));

    (async () => {
        for (const card of cards) {
            if (!active()) return;
            const existing = data.getLibraryAssets(card.appid);
            if (!existing && cooling('art', card)) continue;
            const assets = existing ?? await data.requestLibraryAssets(card.appid, { signal });
            if (!active()) return;
            if (!assets) {
                recordFailure('art', card, 'request-unavailable', ERROR_COOLDOWN_MS);
                continue;
            }
            clearFailure('art', card.appid);
            const art = buildArt(card.appid, data.getOverview(card.appid), assets);
            const current = state.cards.find((c) => c.appid === card.appid);
            if (current && JSON.stringify(current.art) !== JSON.stringify(art)) patchCard(card.appid, { art });
        }
        if (active()) {
            cache.writeState(state.cards);
            cache.flushWrites();
        }
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
    data.resetProgressBootstrap();
    data.resetServiceProgress();
    completionChecks.clear();
    stopDateBackfill();
    log('手动刷新，已丢弃所有在途请求');
    await load({ silent: false });
}

/* ── 完成日期补全（串行 · 去重 · 限流） ─────────────────────────────────── */

let backfillToken = null;
/** 当前这一轮里已经有结果的游戏（拿到日期，或确定拿不到） */
const settled = new Set();
/** 确定取不到完成日期的游戏（接口没有解锁时间 / 重试后仍失败），只在本次运行里有效 */
const dateUnavailable = new Set();

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
        // 用户手动填过日期的，不再请求成就接口（多半也取不到）
        if (manualDates.has(card.appid)) continue;
        if (cooling('date', card)) continue;
        const entry = known.get(card.appid);
        if (!entry || entry.total !== card.total || entry.completedAt == null) {
            (fresh.has(card.appid) ? first : missing).push(card);
        }
    }
    missing.sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));
    return [...first, ...missing].slice(0, DATE_FETCH_PER_OPEN).map((c) => c.appid);
}

/** 这一轮根本不会去取日期（设置里关了，或者客户端没有成就接口）：没有日期的卡只能靠手动补 */
function markUndatedUnavailable(cards) {
    for (const card of cards) {
        if (card.completedAt == null && !manualDates.has(card.appid)) dateUnavailable.add(card.appid);
    }
}

function startDateBackfill(cards, known, fresh = [], isCurrent = () => true) {
    stopDateBackfill();
    settled.clear();
    dateUnavailable.clear();
    for (const card of cards) {
        if (card.completedAt == null && cooling('date', card)) dateUnavailable.add(card.appid);
    }
    state = { ...state, dates: { ...state.dates, unavailable: new Set(dateUnavailable) } };

    if (!state.dates.enabled) {
        out.log('完成日期读取已在主题设置里关闭');
        markUndatedUnavailable(cards);
        setState({ dates: { ...state.dates, enabled: false, running: false, unavailable: new Set(dateUnavailable) } });
        settleIntro();
        return;
    }
    if (!data.probeAchievementsApi()) {
        warn('SteamClient.Apps.GetMyAchievementsForApp 不可用，完成日期全部留空');
        markUndatedUnavailable(cards);
        setState({ dates: { ...state.dates, running: false, total: 0, done: 0, unavailable: new Set(dateUnavailable) } });
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
    const attempts = new Map();
    const queue = targets.map((appid) => ({ appid, notBefore: 0 }));
    let done = 0;
    let ok = 0;
    let failed = 0;

    setState({
        dates: { enabled: true, running: true, done: 0, total: targets.length, ok: 0, failed: 0, unavailable: new Set(dateUnavailable) },
    });
    // 新收录的日期可能早就在缓存里了（上次没来得及播动画），那就不用等这一轮
    settleIntro();
    out.log(`开始补完成日期：${targets.length} 款`);

    /** 这个游戏有结果了（拿到日期，或确定拿不到） */
    const finish = (appid, hasDate) => {
        settled.add(appid);
        done += 1;
        if (hasDate) {
            ok += 1;
            dateUnavailable.delete(appid);
        } else {
            failed += 1;
            if (!manualDates.has(appid)) dateUnavailable.add(appid);
        }
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
                    clearFailure('date', appid);
                    dates.set(appid, {
                        completedAt, rare: card.rare, common: card.common, unrated: card.unrated,
                        total: card.total, fetchedAt: card.rarityFetchedAt ?? 0,
                    });
                    cache.writeDates(dates);
                    // 接口结果照常存进日期缓存（清除手动日期时还能退回来），
                    // 但绝不能覆盖用户当前填的手动日期
                    if (!manualDates.has(appid)) {
                        patchCard(appid, { completedAt, completedAtSource: 'achievements-api' });
                    }
                    finish(appid, true);
                } else {
                    // 拿到了成就列表却没有可用的解锁时间：这是确定的结果，这次运行里不再问
                    attempts.set(appid, MAX_ATTEMPTS);
                    if (card) recordFailure('date', card, 'no-unlock-time');
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
                if (card) recordFailure('date', card, result.reason, ERROR_COOLDOWN_MS);
                finish(appid, card?.completedAt != null);
                out.log(`${appid} 的成就读取失败：${result.reason}`);
            }

            setState(
                { dates: { ...state.dates, done, ok, failed, unavailable: new Set(dateUnavailable) } },
                [appid],
                'dates-progress',
            );
            if (freshSet.has(appid)) settleIntro();

            await sleep(DATE_FETCH_GAP_MS);
        }

        if (token.cancelled || !isCurrent()) return;
        cache.writeState(state.cards);
        cache.flushWrites();
        setState(
            { dates: { ...state.dates, running: false, done, ok, failed, unavailable: new Set(dateUnavailable) } },
            null,
            'dates-done',
        );
        settleIntro();
        out.log(`完成日期补全结束：取得 ${ok}，未取得 ${failed}`);
    })().catch((err) => warn('完成日期补全流程异常', err));
}

/** 只替换一张卡，避免整表重渲染 */
function patchCard(appid, patch, extra = null) {
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
            ...(extra ?? {}),
        },
        [appid],
        'card-patched',
    );
}

/* ── 手动补的完成日期（展示层入口） ─────────────────────────────────────── */

/** @param {number} completedAt 秒级时间戳 */
export function setManualDate(appid, completedAt) {
    if (!Number.isFinite(appid) || !Number.isFinite(completedAt) || completedAt <= 0) return false;
    const card = state.cards.find((c) => c.appid === appid);
    if (!card || card.source === 'external') return false;

    manualDates.set(appid, completedAt);
    cache.writeManualDates(manualDates);
    // 补日期流程还在跑的时候也立即重排：manualRevision 会让展示层重新装订
    patchCard(appid, { completedAt, completedAtSource: 'manual' }, {
        manualRevision: state.manualRevision + 1,
    });
    out.log(`手动补完成日期：${appid}`);
    return true;
}

/** 撤销手动日期后这张卡应该回到的状态：接口缓存里还有同版本的日期就用它，否则无日期 */
function cachedDateState(card, known) {
    if (known && known.total === card.total && known.completedAt != null) {
        return { completedAt: known.completedAt, completedAtSource: 'achievements-api' };
    }
    return { completedAt: null, completedAtSource: 'none' };
}

/**
 * 撤销手动日期。成就接口之前取到过有效日期的，退回那个值；否则回到「无日期」。
 */
export function clearManualDate(appid) {
    if (!manualDates.has(appid)) return false;
    const card = state.cards.find((c) => c.appid === appid);
    if (card?.source === 'external') return false;
    manualDates.delete(appid);
    cache.writeManualDates(manualDates);

    const known = cache.readDates().get(appid);
    const restore = card ? cachedDateState(card, known) : { completedAt: null, completedAtSource: 'none' };
    // 手动填过的卡这一轮不会去请求日期，退回无日期后要重新算作「取不到」，
    // 否则它会从补日期列表里消失，入口按钮也可能跟着不见
    if (restore.completedAt == null) dateUnavailable.add(appid);
    patchCard(appid, restore, {
        manualRevision: state.manualRevision + 1,
        dates: { ...state.dates, unavailable: new Set(dateUnavailable) },
    });
    out.log(`已撤销手动完成日期：${appid}`);
    return true;
}

/** @param {number} minutes 手动填的完成时长 */
export function setManualTime(appid, minutes) {
    if (!Number.isFinite(appid) || !Number.isFinite(minutes) || minutes <= 0) return false;
    const card = state.cards.find((c) => c.appid === appid);
    if (!card || card.source === 'external') return false;

    const rounded = Math.max(1, Math.round(minutes));
    manualTimes.set(appid, rounded);
    cache.writeManualTimes(manualTimes);
    patchCard(appid, { playtimeMin: rounded, playtimeSource: 'manual' }, {
        manualRevision: state.manualRevision + 1,
    });
    out.log(`手动补完成时长：${appid}`);
    return true;
}

/** 撤销手动时长：接口里有概览就用接口值，没有就回到「没有时长」 */
export function clearManualTime(appid) {
    if (!manualTimes.has(appid)) return false;
    const card = state.cards.find((c) => c.appid === appid);
    if (card?.source === 'external') return false;
    manualTimes.delete(appid);
    cache.writeManualTimes(manualTimes);

    const minutes = apiPlaytime(appid);
    patchCard(appid, { playtimeMin: minutes, playtimeSource: minutes == null ? 'none' : 'api' }, {
        manualRevision: state.manualRevision + 1,
    });
    out.log(`已撤销手动完成时长：${appid}`);
    return true;
}

/** 弹窗里的「清除」：这张卡的日期和时长一起撤销 */
export function clearManualEntry(appid) {
    const hadDate = clearManualDate(appid);
    const hadTime = clearManualTime(appid);
    return hadDate || hadTime;
}

/**
 * 一键清除所有手动日期与时长。插件设置面板可能还没 load() 过卡包数据，
 * 所以以缓存里的手动填写为准，同时清掉内存里的那一份。
 * @returns {number} 清掉了几张卡
 */
export function clearAllManualEntries() {
    const clearedDates = new Set([...cache.readManualDates().keys(), ...manualDates.keys()]);
    const clearedTimes = new Set([...cache.readManualTimes().keys(), ...manualTimes.keys()]);
    const cleared = new Set([...clearedDates, ...clearedTimes]);
    if (cleared.size === 0) return 0;

    manualDates = new Map();
    manualTimes = new Map();
    cache.writeManualDates(manualDates);
    cache.writeManualTimes(manualTimes);

    const known = cache.readDates();
    let changed = false;
    const cards = state.cards.map((card) => {
        let next = card;
        if (clearedDates.has(card.appid)) {
            next = { ...next, ...cachedDateState(card, known.get(card.appid)) };
            // 同 clearManualDate：退回无日期的卡重新算作「取不到」
            if (next.completedAt == null && card.source !== 'external') dateUnavailable.add(card.appid);
            changed = true;
        }
        if (clearedTimes.has(card.appid)) {
            const minutes = apiPlaytime(card.appid);
            next = { ...next, playtimeMin: minutes, playtimeSource: minutes == null ? 'none' : 'api' };
            changed = true;
        }
        return next;
    });

    if (changed) {
        const datedCount = cards.filter((c) => c.completedAt != null).length;
        setState(
            {
                cards,
                summary: { ...state.summary, datedCount },
                sortKeys: availableSortKeys(cards),
                manualRevision: state.manualRevision + 1,
                dates: { ...state.dates, unavailable: new Set(dateUnavailable) },
            },
            null,
            'manual-entries-cleared',
        );
    }
    out.log(`已清除全部手动填写：${cleared.size} 款`);
    return cleared.size;
}

/* ── 库外游戏的扫描收录 ─────────────────────────────────────────────────── */

/** 一次扫描最多向服务端批量核对这么多款，避免把老账号的全部历史都翻一遍 */
const EXTRA_SCAN_LIMIT = 300;
/** 批量进度看起来全满 / 查不到时，最多再逐个深挖这么多款（时间预算会提前收工） */
const EXTRA_VERIFY_LIMIT = 40;
/** 深挖的时间预算：到点先收工，已经确认的照常入册 */
const EXTRA_VERIFY_BUDGET_MS = 90000;
/** 结果里最多列这么多款「未满」，避免弹窗被几十行刷屏 */
const EXTRA_REPORT_LIMIT = 12;

function setScanState(patch) {
    setState({ extraScan: { ...state.extraScan, ...patch } }, null, 'extra-scan');
}

/**
 * 收齐三份证据，判断一款库外游戏是否真的全成就。
 * 完整个人列表 → 官方成就表 → 服务端进度 / 个人解锁记录，逐级降级。
 */
async function inspectExtraGame(appid) {
    const personalResult = await data.requestAchievements(appid);
    const personal = personalResult.ok ? completionEvidence(personalResult.data) : null;
    const global = await data.requestGlobalAchievements(appid);
    const officialTotal = Array.isArray(global?.rgAchievements) && global.rgAchievements.length > 0
        ? global.rgAchievements.length
        : null;

    let service = null;
    let user = null;
    let evidence = verifyExtraCompletion({ personal, officialTotal });

    if (evidence.status !== 'complete') {
        service = await data.requestServiceProgress(appid);
        evidence = verifyExtraCompletion({ personal, officialTotal, service });

        // 服务端看到的总数比官方 schema 少，可能只是残缺进度（3/45 报成 3/3）；
        // 这种时候不能据此拒绝，用完整个人列表再确认一次。
        const serviceTotal = Number(service?.total);
        const servicePartial = Number.isFinite(officialTotal)
            && (!Number.isFinite(serviceTotal) || serviceTotal < officialTotal);
        if (evidence.status !== 'complete' && (evidence.status === 'unavailable' || servicePartial)) {
            user = await data.requestUserAchievements(appid);
            if (user) {
                evidence = verifyExtraCompletion({
                    personal: { total: user.total, achieved: user.achieved },
                    officialTotal,
                    service,
                });
            }
        }
    }

    const completedAt = (personalResult.ok ? computeCompletedAt(personalResult.data) : null)
        ?? user?.completedAt
        ?? null;
    return { evidence, completedAt };
}

/** 复核通过后写入缓存；不负责刷新界面 */
async function persistExtraGame(appid, evidence, completedAt) {
    const owner = data.getAccountFingerprint();
    if (!owner) return null;
    const names = await data.resolveAppNames([appid]);
    const name = names.get(appid) ?? null;

    const extras = cache.readExtras(owner);
    extras.set(appid, {
        total: evidence.total,
        unlocked: Number.isFinite(evidence.unlocked) ? evidence.unlocked : evidence.total,
        name,
        addedAt: Date.now(),
    });
    cache.writeExtras(owner, extras);

    if (completedAt != null) {
        const dates = cache.readDates();
        const known = dates.get(appid);
        if (!known || known.total !== evidence.total) {
            dates.set(appid, {
                completedAt,
                rare: null,
                common: null,
                unrated: evidence.total,
                total: evidence.total,
                fetchedAt: 0,
            });
            cache.writeDates(dates);
        }
    }

    const shelved = cache.readShelved() ?? new Set();
    shelved.add(appid);
    cache.writeShelved(shelved);
    return { appid, name, total: evidence.total, completedAt };
}

/** 撤销收录：连同这张卡的手动日期/时长和日期缓存一起清掉 */
export async function removeExtraGame(appid) {
    const owner = data.getAccountFingerprint();
    if (!owner) return false;
    const extras = cache.readExtras(owner);
    if (!extras.delete(appid)) return false;
    cache.writeExtras(owner, extras);

    if (manualDates.delete(appid)) cache.writeManualDates(manualDates);
    if (manualTimes.delete(appid)) cache.writeManualTimes(manualTimes);

    const dates = cache.readDates();
    if (dates.delete(appid)) cache.writeDates(dates);
    const shelved = cache.readShelved();
    if (shelved && shelved.delete(appid)) cache.writeShelved(shelved);

    await load({ silent: true });
    out.log(`已移除库外收录：${appid}`);
    return true;
}

const noopScan = { running: false };

/**
 * 扫描「玩过、但已经不在库里」的游戏，把其中确认全成就的收进册子。
 * 已移出家庭库的游戏不会再出现在库列表里，但客户端通常还记着游玩时长。
 *
 * 老账号的游玩记录可能上百条，逐款深挖代价太大：先用一次批量接口筛掉
 * 明确没打完的，只把「进度看似全满」和「服务端没记录」的少数几款交给
 * 完整个人列表复核。宁可漏收录，也不把没打完的游戏收进来。
 */
export async function scanOutsideGames() {
    if (state.extraScan.running) return state.extraScan;
    const isCurrent = generation.guard();
    setScanState({
        running: true,
        finished: false,
        done: 0,
        total: 0,
        added: [],
        rejected: [],
        rejectedTotal: 0,
        unavailable: [],
    });
    // 刷新 / 换账号会让 generation 失效；别把 running 留在 true 卡死下一次扫描
    const stale = () => {
        setScanState({ running: false, finished: false });
        return noopScan;
    };

    try {
        const played = await data.requestPlayedApps();
        if (!isCurrent()) return stale();
        if (!played) {
            setScanState({ running: false });
            out.log('扫描库外游戏：客户端没有提供游玩记录');
            return { ok: false, reason: 'unavailable', added: [] };
        }

        const owner = data.getAccountFingerprint();
        if (!owner) {
            setScanState({ running: false });
            return { ok: false, reason: 'no-account', added: [] };
        }

        const library = new Set(data.listLibraryApps().map((app) => app?.appid).filter(Number.isFinite));
        const extras = cache.readExtras(owner);
        const known = new Set(state.cards.map((card) => card.appid));
        const candidates = played
            .filter((row) => row.playtime > 0 && !library.has(row.appid) && !extras.has(row.appid) && !known.has(row.appid))
            .sort((a, b) => b.playtime - a.playtime || b.lastPlayed - a.lastPlayed)
            .slice(0, EXTRA_SCAN_LIMIT);

        if (candidates.length === 0) {
            setScanState({ running: false, finished: true });
            out.log('扫描库外游戏：没有需要核对的游戏');
            return { ok: true, scanned: 0, added: [], rejected: [], unavailable: [] };
        }

        const progress = await data.requestServiceProgressBatch(candidates.map((row) => row.appid));
        if (!isCurrent()) return stale();

        const completeLooking = [];
        const unknown = [];
        const rejected = [];
        for (const row of candidates) {
            const entry = progress.get(row.appid);
            const total = Number(entry?.total);
            const unlocked = Number(entry?.unlocked);
            if (Number.isFinite(total) && total > 0 && Number.isFinite(unlocked) && unlocked < total) {
                rejected.push({ appid: row.appid, name: null, unlocked, total });
                continue;
            }
            const looksComplete = entry
                && (entry.all_unlocked === true
                    || (Number.isFinite(total) && total > 0 && Number.isFinite(unlocked) && unlocked >= total));
            (looksComplete ? completeLooking : unknown).push(row);
        }

        const verifyQueue = [...completeLooking, ...unknown].slice(0, EXTRA_VERIFY_LIMIT);
        const reportable = rejected.slice(0, EXTRA_REPORT_LIMIT);
        const names = await data.resolveAppNames(
            [...new Set([...verifyQueue, ...reportable].map((row) => row.appid))],
        );
        if (!isCurrent()) return stale();
        const nameOf = (appid) => names.get(appid) ?? null;
        for (const item of reportable) item.name = nameOf(item.appid);

        const added = [];
        const unavailable = [];
        let rejectedTotal = rejected.length;
        let done = 0;
        setScanState({ total: verifyQueue.length, rejected: [...reportable], rejectedTotal });

        const startedAt = Date.now();
        for (const candidate of verifyQueue) {
            if (!isCurrent()) return stale();
            if (Date.now() - startedAt > EXTRA_VERIFY_BUDGET_MS) break;
            const { evidence, completedAt } = await inspectExtraGame(candidate.appid);
            if (!isCurrent()) return stale();
            if (evidence.status === 'complete') {
                const saved = await persistExtraGame(candidate.appid, evidence, completedAt);
                if (saved) added.push(saved);
            } else if (evidence.status === 'incomplete') {
                rejectedTotal += 1;
                if (rejected.length < EXTRA_REPORT_LIMIT) {
                    rejected.push({ appid: candidate.appid, name: nameOf(candidate.appid), ...evidence });
                }
            } else {
                unavailable.push({ appid: candidate.appid, name: nameOf(candidate.appid) });
            }
            done += 1;
            setScanState({
                done,
                added: [...added],
                rejected: [...rejected],
                rejectedTotal,
                unavailable: [...unavailable],
            });
        }

        if (added.length > 0) await load({ silent: true });
        setScanState({ running: false, finished: true });
        const skipped = verifyQueue.length - done;
        out.log(
            `扫描库外游戏：核对 ${candidates.length} 款，深入复核 ${done} 款，收录 ${added.length} 款`
            + `${rejectedTotal > 0 ? `，未满 ${rejectedTotal} 款` : ''}`
            + `${unavailable.length > 0 ? `，无法复核 ${unavailable.length} 款` : ''}`
            + `${skipped > 0 ? `，超时跳过 ${skipped} 款` : ''}`,
        );
        return { ok: true, scanned: candidates.length, verified: done, added, rejected, unavailable };
    } catch (err) {
        warn('扫描库外游戏失败', err);
        setScanState({ running: false });
        return { ok: false, reason: 'error', added: [] };
    }
}

/* ── 册子的主人 ─────────────────────────────────────────────────────────── */

let ownerLoaded = false;

/** 取当前账号的昵称/头像（拿不到就算了，卡面会只显示完成日期） */
export async function loadOwner() {
    if (ownerLoaded || state.owner) return;
    ownerLoaded = true;
    try {
        const owner = await data.getOwner();
        if (owner?.accountId != null) {
            currentAccountId = owner.accountId;
            ensureAccountScope();
        }
        applyExternalAccounts();
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
    cache.flushWrites();
    if (state.dates.running) {
        setState({ dates: { ...state.dates, running: false } }, null, 'paused');
    }
}

export function dispose() {
    cache.flushWrites();
    resolvedNames.clear();
    manualDates = new Map();
    manualTimes = new Map();
    failures.clear();
    settled.clear();
    dateUnavailable.clear();
    currentAccountId = null;
    ownerLoaded = false;
    generation.bump();
    stopCachedMetadata();
    stopDateBackfill();
    data.resetInFlight();
    listeners.clear();
    state = initialState();
}

/**
 * 一条可复制的数据概况，用来排查「Steam 显示的全成就数和卡包对不上」。
 * 口径与卡册一致：库内 = appStore 全部条目，全成就 = assemble() 出的卡数，
 * total=0 包含 total 缺失的条目，无缓存 = 库内完全没有进度条目的游戏。
 * mapCache 是本地缓存条数；服务端 = Player.GetAchievementsProgress 补到的条数。
 */
export function getDiagnostics() {
    const local = data.readProgress();
    const effective = data.readEffectiveProgress();
    const stats = data.getServiceProgressStats();
    const library = data.listLibraryApps().length;
    const batch = stats.requested > 0
        ? `（请求 ${stats.requested} 款 · 失败 ${stats.failed} 批${stats.skipped > 0 ? ` · 跳过 ${stats.skipped} 批` : ''}）`
        : '';
    const remote = `服务端 ${stats.count}${stats.unavailable ? '（不可用）' : ''} 条${batch}`;

    if (effective.status !== 'ready') {
        return `成就收藏册诊断：缓存未就绪 · 库内 ${library} 款 · mapCache ${local.entries.size} 条 · ${remote}`;
    }

    const assembled = assemble();
    let zeroTotal = 0;
    for (const entry of effective.entries.values()) {
        if (!Number.isFinite(entry?.total) || entry.total <= 0) zeroTotal += 1;
    }
    const rejected = completionReport.rejected;
    const rejectedIds = new Set(rejected.map((item) => item.appid));
    const shown = assembled.cards.filter((card) => !rejectedIds.has(card.appid)).length;
    const review = rejected.length > 0
        ? ` · 复核剔除 ${rejected.length}（${rejected.slice(0, 8).map((item) => item.appid).join(',')}${rejected.length > 8 ? '…' : ''}）`
        : '';
    const external = state.cards.filter((card) => card.source === 'external').length;
    const merged = external > 0 ? ` · 多账号 ${external}` : '';
    return `成就收藏册诊断：库内 ${library} 款 · mapCache ${local.entries.size} 条 · ${remote} · 全成就 ${shown}${review} · total=0 ${zeroTotal} · 无缓存 ${assembled.noCacheCount}${merged}`;
}

/** 供 selftest 用 */
export const __debug = { generation, assemble, initialState };
