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

        // 手动补完成日期 / 时长
        manualDatesButton: '补日期 / 时长',
        manualDatesTitle: '手动补完成日期与时长',
        // 工具条上的新版本提醒（插件版）
        updateButton: (version) => `新版本 v${version}`,
        updateTitle: (version) => `v${version} 已发布，点击查看更新内容`,
        updateRestart: '重启 Steam 完成更新',
        updateRestartTitle: (version) => `v${version} 已安装，重启 Steam 后生效`,
        manualDatesDesc:
            '有些游戏（比如已经不在库里的家庭共享游戏）Steam 取不到完成日期或游玩时长。' +
            '可以在这里自己填，只保存在本地。',
        manualDatesRunning: '后台还在读取完成日期；取不到的游戏可以先手动补。',
        manualDatesEmpty: '所有卡片都有完成日期和游玩时长了。',
        manualDatesInput: (name) => `${name} 的完成日期`,
        manualTimesInput: (name) => `${name} 的完成时长（小时）`,
        manualTimesPlaceholder: '时长（小时）',
        manualDatesClear: '清除',
        manualDatesClearFor: (name) => `清除 ${name} 的手动填写`,
        manualDatesManual: '手动',
        manualDatesClose: '关闭',

        // 收录库外游戏（已不在库里，比如被移出家庭共享）
        extraTitle: '收录库外游戏',
        extraDesc:
            '已经不在库里的游戏不会出现在册子里。扫描玩过的游戏，' +
            'Steam 确认成就全部解锁后才会自动收录；完成日期仍然在这张卡上补。',
        extraScan: '扫描玩过的游戏',
        extraScanning: (done, total) =>
            total > 0 ? `正在核对… ${done} / ${total}` : '正在读取游玩记录…',
        extraFailed: '读取失败，请稍后再试。',
        extraScanEmpty: '没有找到需要核对的库外游戏。',
        extraScanDone: (added, rejected, unavailable) =>
            `扫描完成：收录 ${added} 款`
            + (rejected > 0 ? `，${rejected} 款未满` : '')
            + (unavailable > 0 ? `，${unavailable} 款无法复核` : ''),
        extraScanAdded: (name) => `已收录《${name}》`,
        extraScanRejected: (name, unlocked, total) => `${name}：${unlocked} / ${total}，未满`,
        extraScanUnavailable: (name) => `${name}：没有成就数据`,
        extraTag: '库外',
        extraRemove: '移除',
        extraRemoveConfirm: '确认移除？',
        extraRemoveFor: (name) => `移除《${name}》的库外收录`,
    },

    /* ── 阅读设置（readingpanel.js） ─────────────────────────────────────── */
    reading: {
        title: '阅读设置',
        desc: '这里的改动会立即生效，并保存在本机。其它设置仍在 Millennium 的主题设置里。',
        tabsLabel: '书口年份索引',
        tabsDesc: '书口露出一列年份标签，点一下直接翻到那一年的年份页。',
        introSoundLabel: '入册音效',
        introSoundDesc: '新卡落进卡槽时的轻声提示。',
        albumLabel: '册子风格',
        albumDesc: '换一本册子的纸张、书皮和边框，立即生效。',
        treeLabel: '年度之树',
        treeTag: '实验',
        treeDesc: '年份页的背面画一棵随全成就款数生长的树；满树之后超出的款数记作「盈枝」。',
        treeNeedPages: '还没开启「年份特殊页」：树要等它开启后才会出现。',
        targetLabel: '每年目标',
        targetDesc: '树的生长以这个款数为目标；达到目标后不再长高，超出的部分只标「盈枝」。',
        targetValue: (n) => `${n} 款`,
        feedback: '日志反馈',
        feedbackHint: '复制库内款数 / mapCache 条目 / 服务端条目 / 全成就 / total=0 / 无缓存，发给开发者排查。',
        feedbackCopying: '正在复制…',
        feedbackCopied: '已复制，粘贴发给开发者即可。',
        feedbackFailed: '复制失败，请手动选中下面这行复制。',
        feedbackUnavailable: '当前环境读不到 Steam 数据，请打开卡包后再试。',
        extraLabel: '收录库外游戏',
        extraDesc: '已经不在库里的游戏（比如被移出家庭共享）不会出现在册子里。扫描玩过的游戏，Steam 确认成就全部解锁后才会自动收录。',
        extraButton: '扫描库外游戏',
        accountsLabel: '多账号管理',
        accountsDesc: '把小号等其它账号已经寄出的只读快照并进当前账号的册子；外部卡只在本机显示。',
        accountsButton: '管理',
        done: '完成',
        close: '关闭设置',
    },

    /* ── 多账号管理（accountsui.js） ─────────────────────────────────────── */
    accounts: {
        title: '多账号管理',
        desc: '把别的 Steam 账号已经寄出的只读快照并进这本册子。同一款游戏以当前账号的卡为准；合并进来的卡只在本机显示。',
        enableLabel: '合并其他账号的收藏',
        enableHint: '关掉后立刻回到只显示当前账号的册子，来源记录会保留。',
        sourcesTitle: '来源',
        autoLabel: '本机借阅记录',
        codeLabel: (code) => `借阅码 ${code}`,
        meta: (count, updated) => `${count} 张卡 · ${updated}`,
        neverUpdated: '尚未取回',
        errorPrefix: '取回失败：',
        empty: '还没有发现别的账号的快照。先在小号上寄一次信，或者输入 9 位借阅码。',
        loading: '正在读取来源…',
        addLabel: '添加借阅码',
        addPlaceholder: '9 位借阅码',
        add: '添加',
        addBad: '借阅码应为 9 位数字。',
        addOk: '已添加，正在取回快照…',
        remove: '移除',
        removeFor: (name) => `移除 ${name} 的来源`,
        refresh: '刷新快照',
        refreshing: '正在取回快照…',
        refreshDone: (ok, failed) => `取回 ${ok} 个来源${failed > 0 ? `，${failed} 个失败` : ''}。`,
        refreshFailed: '暂时无法刷新，请先打开一次卡包或稍后再试。',
        noAccount: '读不到当前 Steam 账号，暂时无法合并。',
        hint: '只读取快照，不写分享服务器；寄信和借阅仍然只包含当前账号自己的卡。',
        close: '关闭',
    },

    /* ── 一次性提示（onboarding.js 的 showTreeNotice） ──────────────────── */
    notice: {
        eyebrow: '1.1.6 · 实验功能',
        title: '年度之树',
        desc: '每一年的全成就款数会画成一棵树：完成得越多，树越繁茂；满树之后的款数会记成「盈枝」。',
        points: [
            '在卡包右上角的「设置」里打开「年度之树」即可尝鲜。',
            '需要开启「年份特殊页」。',
            '年度目标可以在同一个设置面板里用滑块调整（5～50 款）。',
        ],
        open: '去设置开启',
        later: '以后再说',
        close: '关闭提示',
    },

    /* ── 印刷素材导出（export.js） ──────────────────────────────────────── */
    export: {
        title: '导出印刷素材',
        desc: '按印刷规格导出收藏册里的实体收藏品：300 DPI，四周留 3 mm 出血，可直接送印后裁剪。',
        cards: '成就卡片',
        cardsDesc: (n) => `${n} 张 · 每张正面与反面，全部共用一张烫金层`,
        cardsDescPicked: (n, total) =>
            n === total
                ? `全部 ${total} 张 · 每张正面与反面，共用一张烫金层`
                : n === 0
                  ? `还没有选卡片 · 点「选择」挑要导出的卡`
                  : `已选 ${n} / ${total} 张 · 每张正面与反面，共用一张烫金层`,
        pickCards: '选择',
        pickTitle: '选择要导出的卡片',
        pickSearch: '搜索游戏名',
        pickAll: '全选',
        pickNone: '全不选',
        pickDone: '完成',
        pickCount: (n, total) => `已选 ${n} / ${total} 张`,
        pickEmpty: '没有找到这款游戏',
        pickYearUnknown: '未知年份',
        tickets: '年度最爱票根',
        ticketsDesc: (n) => `${n} 张 · 按「年度最爱」已选的横幅`,
        stamps: '年份页徽章邮票',
        stampsDesc: (n) => `${n} 枚 · 按年份页已选的徽章`,
        emptyCards: '收藏册里还没有卡片',
        emptyTickets: '还没有在「年度最爱」里选横幅',
        emptyStamps: '还没有在年份页里选徽章',
        note: '卡片 / 票根 / 邮票导出为 JPG；所有卡片共用一张透明背景的烫金层 PNG，可与任意一张正面按同尺寸对齐。',
        total: (n) => `共 ${n} 个文件`,
        preparing: '正在准备字体与样式…',
        start: '开始导出',
        cancel: '取消',
        cancelRun: '取消导出',
        cancelling: '正在取消…',
        close: '关闭',
        progress: (done, total) => `${done} / ${total}`,
        done: (n, size) => `已生成 ${n} 个文件（${size}）`,
        failed: (n) => `${n} 项导出失败，已跳过`,
        error: (message) => `导出失败：${message}`,
        downloadAgain: '重新下载 ZIP',
        cardFront: '正面',
        cardBack: '反面',
        foil: '烫金层',
        readmeName: '说明.txt',
        downloadName: (stamp) => `成就收藏册_印刷素材_${stamp}.zip`,
        folderCards: '成就卡片',
        folderTickets: '年度最爱票根',
        folderStamps: '年份页徽章邮票',
        readme: ({ date, cardCount, ticketCount, stampCount, failed }) =>
            [
                '成就收藏册 · 印刷素材',
                `导出时间：${date}`,
                `本次导出：成就卡片 ${cardCount} 张、票根 ${ticketCount} 张、邮票 ${stampCount} 枚` +
                    (failed > 0 ? `；另有 ${failed} 项失败被跳过` : ''),
                '',
                '通用规格',
                '· 分辨率 300 DPI',
                '· 四周各留 3 mm 出血（35 px），按成品尺寸裁切即可',
                '· 成就卡片成品 63.5 × 88.9 mm，含出血 820 × 1120 px',
                '· 票根成品 150 × 41 mm，含出血 1842 × 555 px',
                '· 邮票成品 30 × 36.4 mm，含出血 424 × 500 px',
                '',
                '烫金层',
                '· 仅成就卡片提供，全部卡片共用一份，透明背景 PNG，与卡片正面同尺寸（820 × 1120 px）',
                '· 图案是徽章外轮廓与三颗星芒，可直接作为烫金 / 烫银的专色或蒙版图层',
                '· 烫金层与任意一张正面按同一像素坐标对齐，叠放即可检查位置',
                '',
                '说明',
                '· 成就卡片的出血延续了卡片的彩色边框，裁剪时不会露出白边',
                '· 票根的缺口与邮票的齿孔之外是白色，属于出血与裁切余量，不是画面缺失',
                '· JPG 已写入 300 DPI 元数据，导入印刷软件后请确认分辨率与出血设置',
            ].join('\n'),
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
        hint: '滚轮或点击页面翻页，下拉书签跳至另一端；悬停长按右键调整封面',
        hintReadOnly: '滚轮或点击页面翻页，下拉书签跳至另一端',
        endTitle: '未完待续',
        endDesc: '下一款完美通关的游戏，会收进这一页',
        bookmark: '跳到最远的一端',
        label: '成就收藏册，左右两页，滚轮或点击页面翻页',
        pageStatus: (page, total) => `第 ${page} / ${total} 页`,
        introduced: (names) => `新收录：${names.join('、')}`,
        statsCards: '收藏卡',
        statsGold: '金杯',
        statsSilver: '银杯',
        statsLabel: (cards, gold, silver) =>
            `收藏册内共 ${cards} 张收藏卡` +
            (gold == null ? '，金杯统计中' : `，金杯 ${gold} 个`) +
            (silver == null ? '，银杯统计中' : `，银杯 ${silver} 个`),
        // 书口年份索引
        yearTab: (year, count) => `${year} 年 · ${count} 款`,
        yearTabJump: (year) => `跳到 ${year} 年`,
        yearTabGap: (from, to, count) => `${from}–${to} 年（${count} 个年份）`,
        yearTabGapJump: (year) => `跳到 ${year} 年附近`,
    },

    /* ── 年度之树（treepage.js） ────────────────────────────────────────── */
    /* ── 成就小屋（pethouse.js；只有装了桌宠插件才替换「未完待续」） ───────── */
    house: {
        title: '成就小屋',
        signSub: (name) => `${name}的家`,
        nextSlot: '下一款完美通关的游戏，会挂在这里',
        cup: {
            platinum: (n) => `白金奖杯 · 完美通关 ${n} 款`,
            gold: (n) => (n == null ? '金杯 · 统计中' : `金杯 · 稀有成就 ${n} 个`),
            silver: (n) => (n == null ? '银杯 · 统计中' : `银杯 · 普通成就 ${n} 个`),
        },
        petLabel: (name) => `${name}，点一下和它打招呼`,
        pageAria: '成就小屋',
        greet: ['今天也来摸鱼吗？', '收藏册我刚擦过一遍～', '下一张邮票挂哪儿好呢'],
        cheer: (name) => `《${name}》的邮票挂上墙啦！`,
    },

    yearFill: {
        monthsKicker: 'FOOTPRINTS OF THE YEAR',
        monthsTitle: '月份足迹',
        month: (month) => `${month} 月`,
        count: (count) => `${count} 款`,
        rareCount: (count) => `${count} 项稀有`,
        peakLabel: '最高产',
        longestLabel: '最久的一款',
        rarestLabel: '稀有成就最多',
        indexKicker: 'CONTENTS OF THE YEAR',
        indexTitle: '本年目录',
        indexSub: (count) => `这一年收进册子的 ${count} 款 · 点一行直接翻到那一页`,
        jump: (name) => `翻到 ${name}`,
        sheet: (n, total, from, to) => `${n} / ${total} 张 · 第 ${from}–${to} 款`,
        monthOpen: (month, count) => `${month} 月 · ${count} 款，点开看全部`,
        monthClose: '收起这个月',
        monthAria: (year, month) => `${year} 年 ${month} 月`,
        monthSummary: (year, count, hours, rare) =>
            [`${year} · ${count} 款`, hours ? `共 ${hours}` : null, rare > 0 ? `稀有成就 ${rare} 项` : null].filter(Boolean).join(' · '),
        sheetPrev: '目录上一张',
        sheetNext: '目录下一张',
        monthsAria: (year) => `${year} 年月份足迹`,
        indexAria: (year) => `${year} 年目录`,
    },
    tree: {
        eyebrow: 'TREE OF THE YEAR',
        title: '年度之树',
        types: ['樱花', '新叶', '夏荫', '碧玉', '银杏', '枫叶', '赤枫', '紫藤', '蓝花楹', '白梅', '海棠', '琥珀'],
        stages: {
            flower: ['新芽', '绿荫', '初绽', '渐盛', '盛放', '满树'],
            leaf: ['新芽', '绿荫', '初染', '渐浓', '尽染', '满树'],
        },
        aria: (year, name, lit, target, status) =>
            `${year} 年年度之树：${name}，生长 ${lit} / ${target}，${status}`,
        pageAria: (year) => `${year} 年，年度之树`,
        lit: (lit, target) => `生长 ${lit}/${target}`,
        over: (n) => `盈枝 +${n}`,
        game: (name, date, hours) => [name, date, hours].filter(Boolean).join(' · '),
    },

    /* ── 封面取景（coveredit.js + book.js 的编辑器） ────────────────────── */
    coverEdit: {
        frontTitle: (name) => `调整 ${name} 的正面取景`,
        backTitle: (name) => `调整 ${name} 的背面显示`,
        frontEyebrow: '封面取景 · 正面',
        backEyebrow: '封面显示 · 背面',
        frontHint: '滚轮缩放 100%–120%，拖动卡片选择原图里的取景位置',
        backHint: '默认：铺满卡片，竖版封面上下各裁约 3%；拉伸：横向拉伸铺满，画面略扁',
        backModeLabel: '背面显示方式',
        modeFit: '默认',
        modeStretch: '拉伸',
        sourceLabel: '封面原图与取景范围',
        sourceMeta: (w, h, crop) => `原图 ${w}×${h} · 取景宽度 ${crop}%`,
        reset: '重置',
        done: '完成',
        saveHint: '再次长按鼠标右键保存并退出，Esc 也可以',
        savedFront: '正面取景已保存',
        savedBack: '背面显示已保存',
    },

    /* ── 新手引导（onboarding.js） ──────────────────────────────────────── */
    onboarding: {
        label: '新手引导',
        skip: '跳过引导',
        prev: '上一步',
        next: '下一步',
        start: '开始收藏',
        count: (n, total) => `${n} / ${total}`,
        tryHint: '动手试一下，也可以直接下一步',
        tryDone: '就是这样',
        steps: {
            card: { title: '收藏卡', desc: '每款全成就的游戏，都会收成一张卡。' },
            turn: { title: '翻页', desc: '滚动滚轮，或者点一下这一页。' },
            ribbon: { title: '书签', desc: '往下拉书签，直接翻到册子的另一端。' },
            cover: { title: '封面取景', desc: '在卡片上长按右键，调整封面露出的部分。' },
            tabs: { title: '年份索引', desc: '点书口的年份标签，跳到那一年。' },
            months: { title: '月份足迹', desc: '每年开头记着每个月打满了哪些游戏。点一个月，展开看当月全部。' },
            date: { title: '补日期与时长', desc: '读不到日期或时长的游戏，在这里补上。' },
            settings: { title: '设置', desc: '册子风格、年份特殊页、入册音效和印刷素材都在这里。' },
            borrow: { title: '借阅室', desc: '把册子寄给朋友，也能翻看朋友的册子。' },
        },
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
