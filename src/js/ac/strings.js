/**
 * 成就收藏册 · 全部界面文案
 *
 * 本地化集中点：要改文案只改这一个文件。
 *
 * 展柜的两句文案放在 showcaseStrings.js，好让社区页面的独立小包不必带上整本 STR；
 * 这里把它挂回 STR.showcase，调用方仍然只需要认识 STR。
 *
 * 已知取舍：展柜里的「99 项成就」是 Valve 服务端按其本地化渲染的
 * （英文客户端显示 "99 Achievements"）。我们**不改写**它，
 * 所以非中文客户端上会是「中英混排」。README 里写明了这一点。
 */

import { SHOWCASE_STR } from './showcaseStrings.js';

export const STR = {
    theme: '成就收藏册',

    /* ── 卡包页面 ───────────────────────────────────────────────────────── */
    page: {
        title: '成就卡包',
        heading: '成就卡包',

        // 状态页：都画在一本合上的册子上（见 cardpack.css 的 .ac-state）
        loadingTitle: '正在装订…',
        loadingDesc: '从 Steam 客户端的本地成就缓存里整理收藏卡，不会产生额外的数据请求。',

        notReadyTitle: '正在等待 Steam 数据…',
        notReadyDesc:
            '客户端的成就进度缓存还没有就绪（可能是客户端还没完成初始化）。' +
            '数据没到齐时不会显示空册子。',
        notReadyRetry: '重试',

        emptyTitle: '还没有可以收录的游戏',
        emptyDesc: '把任意一款游戏的成就全部解锁，它就会装订进这本收藏册。',

        errorTitle: '整理收藏卡时出错',
        errorDescFallback: '已保留现有的收藏册。',
        errorRetry: '重试',

        // 册子上的状态提示（只在需要时说一句，不喧宾夺主）
        waitingNote: '正在等待 Steam 数据，当前显示的是上次缓存的内容',
        staleAction: '刷新',
        datesNote: (done, total) => `正在读取完成日期… ${done} / ${total}`,
        datesNoteDone: (ok, failed) =>
            failed > 0 ? `完成日期已读取 ${ok} 个，${failed} 个未取得（这些卡片不显示日期）` : `完成日期已读取 ${ok} 个`,
        datesDisabled: '完成日期读取已在主题设置里关闭',

        // 手动补完成日期
        manualDatesButton: '补日期',
        manualDatesTitle: '手动补完成日期',
        manualDatesDesc:
            '有些游戏（比如已经不在库里的家庭共享游戏）Steam 取不到最后一个成就的解锁时间。' +
            '可以在这里自己填，日期只保存在本地。',
        manualDatesRunning: '后台还在读取完成日期；取不到的游戏可以先手动补。',
        manualDatesEmpty: '所有卡片的完成日期都已经有了。',
        manualDatesInput: (name) => `${name} 的完成日期`,
        manualDatesClear: '清除',
        manualDatesManual: '手动',
        manualDatesClose: '关闭',
    },

    /* ── 收藏卡（cardview.js） ──────────────────────────────────────────── */
    card: {
        perfect: '完美通关',
        badge: '完美通关徽章',
        dateTitle: '完成日期：该游戏最后一个成就的解锁时间',
        rare: (n) => `稀有成就 ${n} 项（全球解锁率低于 10%）`,
        common: (n) => `普通成就 ${n} 项`,
        unrated: (n) => `未统计全球完成率 ${n} 项`,
        playtime: (text) => `游玩时长 ${text}`,
        front: (name) => `${name} · 收藏卡正面，点击翻到下一页`,
        back: (name) => `${name} · 收藏卡背面，点击翻回上一页`,
    },

    /* ── 收藏册（book.js） ──────────────────────────────────────────────── */
    book: {
        title: '成就收藏册',
        subtitle: 'ACHIEVEMENT COLLECTION',
        hint: '滚轮或轻点卡片翻页，下拉书签跳至另一端',
        endTitle: '未完待续',
        endDesc: '下一款完美通关的游戏，会收进这一页',
        bookmark: '跳到最远的一端',
        label: '成就收藏册，左右两页，滚轮或点击卡片翻页',
        pageStatus: (page, total) => `第 ${page} / ${total} 页`,
        introduced: (names) => `新收录：${names.join('、')}`,
        statsCards: '收藏卡',
        statsGold: '金杯',
        statsSilver: '银杯',
        statsLabel: (cards, gold, silver) =>
            `收藏册内共 ${cards} 张收藏卡` +
            (gold == null ? '，金杯统计中' : `，金杯 ${gold} 个`) +
            (silver == null ? '，银杯统计中' : `，银杯 ${silver} 个`),
    },

    /* ── 年份特殊页（yearpages.js） ─────────────────────────────────────── */
    year: {
        eyebrow: 'Year in review',
        annualEyebrow: 'FAVORITES OF THE YEAR',
        unknownYear: '更早',
        yearAria: (year) => `${year} 年，年度回顾`,
        // 橡皮章上的字：一圈英文 + 中间的主字 + 小字
        yearSeal: (year, count) => ({ ring: `★ ALL ACHIEVEMENTS ★ ${year} `, main: String(count), unit: 'GAMES' }),
        annualSeal: (year) => ({ ring: '★ FAVORITE OF THE YEAR ', main: 'No.1', unit: String(year) }),
        statAchievements: '解锁成就',
        statRare: '稀有成就',
        statHours: '游玩时长',
        annualTitle: '年度最爱',
        annualSub: '这一年的三款心头好',
        rankAria: (n) => `年度最爱第 ${n} 名`,
        pickBadge: '贴一枚徽章',
        changeBadge: (name) => `更换徽章：${name}`,
        pickBanner: '放一张横幅',
        changeBanner: (name) => `更换横幅：${name}`,
        bannerHint: '从这一年的全成就里挑',
        pickerBadgeTitle: (year) => `${year} · 选徽章`,
        pickerBannerTitle: (year) => `${year} · 选横幅`,
        pickerBadgeDesc: '点一款游戏，再挑它的徽章等级',
        pickerBannerDesc: '点一款游戏，把它的横幅放上这一页',
        close: '关闭',
        searchPlaceholder: '搜索这一年的游戏',
        backToGames: '← 换一款游戏',
        loadingBadges: '正在读取徽章…',
        noBadgeData: '客户端里没有这款游戏的徽章图案，可以先用封面代替。',
        noBadgeMark: '无徽章',
        noBadgeHint: '客户端里没有这款游戏的徽章图案',
        coverOption: '封面代替',
        noGames: '这一年还没有全成就的游戏',
        usedMark: '已贴',
    },

    /* ── 展柜（定义在 showcaseStrings.js，单独打包给社区页面） ─────────── */
    showcase: SHOWCASE_STR,

    /* ── 自检 ───────────────────────────────────────────────────────────── */
    selftest: {
        header: '成就收藏册 · 挂钩点自检',
        selectors: 'DOM 挂钩点',
        globals: '全局对象探测路径',
        dataSource: '主数据源',
        entry: '卡包入口',
        model: '判定用例',
        ok: 'OK',
        missing: '缺失',
        skipped: '跳过',
    },
};

export default STR;
