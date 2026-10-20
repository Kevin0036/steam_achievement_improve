/**
 * 成就收藏册 · 选择器 / 路由 / 模块判定 集中注册表
 *
 * 这是全项目**唯一**允许出现 Steam 内部标识的地方（另一个是 env.js）。
 * Steam 更新导致失效时，只需要改这一个文件。
 *
 * 每一项都带元信息：
 *   key        标识
 *   selector   DOM 选择器（社区页面的语义类名，不是易变的哈希类名）
 *   required   缺失时是否算「该功能不可用」
 *   feature    归属功能，便于按功能整体降级
 *   note       这条依赖的依据
 */

/* ── 路由 ───────────────────────────────────────────────────────────────── */

export const ROUTES = {
    /** 我们自己的库内页面。挂在库的内层 Switch 里，因此侧栏与游戏列表都保留。 */
    cardPack: '/library/achievementcards',

    /** Steam 自己的库内路由常量（module 80344 的字面值，已从 sp.js 核对） */
    libraryRoot: '/library',
    libraryHome: '/library/home',
    libraryAppPrefix: '/library/app/',
    libraryCollectionPrefix: '/library/collection/',
    libraryAllCollections: '/library/collections',
    downloads: '/library/downloads',
};

/* ── 社区页面：完满主义者展柜 ───────────────────────────────────────────── */

export const SHOWCASE = {
    /** 展柜容器；只有它存在我们才启动，其它社区页面零副作用 */
    root: '.profile_customization',
    slots: '.showcase_achievementscompletionist_slots',
    slot: '.showcase_achievementscompletionist_game',
    slotLink: 'a[href*="/achievements/"]',
    cover: 'img.game_capsule',
    bar: '.showcase_achievementscompletionist_game_bar',
    ribbons: '.showcase_achievementscompletionist_game_ribbons',
    counts: '.showcase_achievementscompletionist_game_counts',
    stat: '.showcase_stats_row .showcase_stat',
    statLabel: '.label',
};

/** 展柜上的挂钩点登记表（selftest 会逐条报告是否命中） */
export const REGISTRY = [
    {
        key: 'showcase.slots',
        selector: SHOWCASE.slots,
        required: true,
        feature: 'showcase',
        note: 'Valve 服务端渲染的语义类名，实测存在于线上 profilev2.css',
    },
    {
        key: 'showcase.slot',
        selector: SHOWCASE.slot,
        required: true,
        feature: 'showcase',
        note: '同上',
    },
    {
        key: 'showcase.bar',
        selector: SHOWCASE.bar,
        required: true,
        feature: 'showcase',
        note: '信息条容器，我们的主战场',
    },
    {
        key: 'showcase.ribbons',
        selector: SHOWCASE.ribbons,
        required: false,
        feature: 'showcase',
        fallback: null,
        note: '缺失时只是没有花结徽章，版式仍然成立',
    },
    {
        key: 'showcase.counts',
        selector: SHOWCASE.counts,
        required: false,
        feature: 'showcase',
        fallback: null,
        note: '文案由 Valve 渲染，我们不改写',
    },
];

/* ── 库内页面：入口判定 ─────────────────────────────────────────────────── */

/** Library Supernav 下拉菜单的标题（用于精确定位，避免污染 Store/Community/Profile 顶栏） */
export const SUPERNAV_TITLE = 'Library Supernav';

export const MENU = {
    /** 菜单项文案。不以 # 开头 => Valve 的本地化函数会原样输出。 */
    label: '成就卡包',
    icon: '★',
};

/**
 * 判定一个 React 元素是不是「库的内层路由表」（那个装着 /library/home 的 Switch）。
 *
 * 依据（已从 steamui/sp.js 核对）：
 *   <Switch>
 *     <Route path="/library/home">…</Route>
 *     <Route path="/library/app/:appid">…</Route>
 *     <Route path="/library/collection/:collectionid">…</Route>
 *     <Route path="/library/collections">…</Route>
 *     <Route>…Unknown Route…</Route>   ← 无 path 的兜底，react-router v5 的
 *                                          Switch 不会把它当成命中项
 *   </Switch>
 *
 * 判定条件刻意收得很紧：children 必须是数组，且其中**恰有一个** Route 的
 * path 等于 '/library/home'。这样不会误伤 gamepad 版或其它 Switch。
 */
export function isLibraryRouteSwitch(props) {
    const children = props?.children;
    if (!Array.isArray(children)) return false;

    let homeCount = 0;
    let hasAppRoute = false;
    for (const child of children) {
        const path = child?.props?.path;
        if (path === ROUTES.libraryHome) homeCount += 1;
        else if (typeof path === 'string' && path.startsWith(ROUTES.libraryAppPrefix)) hasAppRoute = true;
    }

    return homeCount === 1 && hasAppRoute;
}

/** 判定一个 React 元素是不是 Library Supernav（按 title 精确匹配） */
export function isLibrarySupernav(props) {
    return props?.title === SUPERNAV_TITLE && Array.isArray(props.menuItems);
}

/* ── Steam 内部数据字段 ─────────────────────────────────────────────────── */

export const DATA = {
    /** window.appAchievementProgressCache 的两层结构：管理器 → m_achievementProgress → mapCache */
    progressManager: 'appAchievementProgressCache',
    progressField: 'm_achievementProgress',
    progressMap: 'mapCache',

    /** 只读字段集，禁止调用 GetAchievementProgress / SaveCacheFile（会写缓存并排队 CM 请求） */
    /**
     * SteamClient.Apps.GetMyAchievementsForApp(appid) 的返回结构：
     *   { result, message, data: { rgAchievements: [ { strID, bAchieved, rtUnlocked, ... } ] } }
     */
    achievementsApi: 'Apps.GetMyAchievementsForApp',
};

/** 美术资源 URL 模板（Valve CDN 固定文件名，app overview 里有覆盖字段时优先用覆盖值） */
export const ART = {
    base: 'https://shared.steamstatic.com/store_item_assets/steam/apps/',
    header: 'header.jpg',
    capsule: 'library_600x900.jpg',
    hero: 'library_hero.jpg',
};

/** 缓存版本号：改动数据结构时递增，旧缓存会被丢弃 */
export const CACHE_VERSION = 1;