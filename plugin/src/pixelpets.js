/**
 * 成就收藏册 · 原创双像素桌宠引擎 v2（MIT License）
 *
 * 100% 原创像素美术、粒子画布、多阶段剧情动画与弹性物理引擎，零外部依赖，跨窗口安全：
 *   · 角色：珊瑚橙小蟹（crab）与薰衣草紫小猫（cat），PX = 3 整格渲染、柔和内高光与暗部层次；
 *   · 独立像素粒子层（fxCanvas）：飘升爱心、鎏金星芒、彩屑、像素泡泡、漂浮音符、暖火余烬与打盹 ZzZ；
 *   · 16+ 精致多阶段动画：蝴蝶停留、6 段种花开花、拉面/烤鱼进食、热饮袅袅、拆信阅读、激光点扑击、
 *     奖杯欢呼、手柄打游戏、吹像素泡泡、荧光棒应援（带光轨）、麦克风哼歌、暖火淡定、伸懒腰理毛；
 *   · 双宠互动剧情：互相招手、贴贴摸头、跳马越顶（Leapfrog）、双宠举杯庆典；
 *   · 鼠标物理交互：左键 5 段递进戳一戳、长按抚摸、右键投喂、拖拽甩腿（另一只眼神实时追随）、
 *     抛落重力弹跳与弹性落地缓冲、以及轻轻叠叠乐。
 */

const PX = 3;
const CANVAS_W = 96;
const CANVAS_H = 84;
const OX = 8;
const OY = 17;
const TICK_MS = 95;
const DOZE_TICK_MS = 340;
const DOZE_AFTER_MS = 45000;
const DOZE_AFTER_NIGHT_MS = 30000;

/* ── 调色板 ─────────────────────────────────────────────────────────────── */

const SHARED_COLORS = {
    o: '#141413', // 瞳孔
    k: '#aba49c', // 柔和符灰
    w: '#fffef8', // 亮白高光
    W: '#e8fff2', // 冰白荧光芯
    c: '#f0e2c6', // 信纸米
    r: '#eb5360', // 红心/蜡封/感叹
    p: '#f7a1b5', // 腮红/糖霜
    y: '#f2c54b', // 鎏金
    Y: '#ffe48a', // 亮金高光
    B: '#5da6f0', // 蓝蝴蝶/碗沿/手柄蓝键
    b: '#cfe9ff', // 浅蓝泡泡/高光
    D: '#6c8aa8', // 瓷杯/餐盘
    d: '#4f6882', // 瓷器暗部
    n: '#8d5f3c', // 木色/饼底/泥土
    N: '#694326', // 深土/深木
    g: '#76e38f', // 嫩叶/绿荧光棒
    G: '#47a660', // 深叶绿
    t: 'rgba(118, 227, 143, 0.36)', // 绿荧光光轨
    m: '#ff78d4', // 粉荧光棒
    u: 'rgba(255, 120, 212, 0.36)', // 粉荧光光轨
    f: '#e86f30', // 暖火橙
    F: '#b53924', // 深火红
    l: '#6f6a64', // 支架/手柄灰
    Z: '#2c2b30', // 手柄深灰
    L: '#ff3b4f', // 激光红点
    z: 'rgba(255, 59, 79, 0.28)', // 激光淡红光束
    M: '#e2dcd2', // 鱼骨
    P: '#e68c6e', // 烤鱼肉
    v: '#b8a8ff', // 浅紫泡泡
    e: 'rgba(210, 224, 240, 0.55)', // 热气轻烟
    h: '#80d8ff', // 水壶 / 透明睡泡蓝
};

const PALETTES = {
    crab: {
        ...SHARED_COLORS,
        '#': '#d97757',
        s: '#b95b3f',
        q: '#ec9679', // 顶部柔和受光边
    },
    cat: {
        ...SHARED_COLORS,
        '#': '#947fd6',
        s: '#715bb4',
        q: '#b4a2ea', // 顶部/耳尖柔和受光
    },
};

/* ── 像素图层工具 ───────────────────────────────────────────────────────── */

const L = (ox, oy, rows, extra = null) =>
    extra ? { ox, oy, rows, ...extra } : { ox, oy, rows };

function drawLayers(ctx, layers, palette, { mirror = false, tyPx = 0, rotDeg = 0 } = {}) {
    const anchorX = (OX + 8) * PX;
    const anchorY = (OY + 10) * PX;

    const paint = (list, flip) => {
        ctx.save();
        if (flip) {
            ctx.translate(anchorX, 0);
            ctx.scale(-1, 1);
            ctx.translate(-anchorX, 0);
        }
        let lastColor = '';
        for (const layer of list) {
            if (!layer || !layer.rows) continue;
            for (let ry = 0; ry < layer.rows.length; ry += 1) {
                const row = layer.rows[ry];
                const py = (OY + layer.oy + ry) * PX;
                for (let rx = 0; rx < row.length; rx += 1) {
                    const ch = row[rx];
                    if (ch === '.' || ch === ' ') continue;
                    const color = palette[ch];
                    if (!color) continue;
                    let run = 1;
                    while (rx + run < row.length && row[rx + run] === ch) run += 1;
                    if (color !== lastColor) {
                        ctx.fillStyle = color;
                        lastColor = color;
                    }
                    ctx.fillRect((OX + layer.ox + rx) * PX, py, run * PX, PX);
                    rx += run - 1;
                }
            }
        }
        ctx.restore();
    };

    const grounded = [];
    const backProps = [];
    const elastic = [];
    const frontGrounded = [];
    const symbols = [];
    for (const item of layers) {
        if (!item) continue;
        if (item.back) backProps.push(item);
        else if (item.frontGrounded) frontGrounded.push(item);
        else if (item.grounded) grounded.push(item);
        else if (item.sym) symbols.push(item);
        else elastic.push(item);
    }

    if (backProps.length) paint(backProps, mirror);
    if (grounded.length) paint(grounded, mirror);

    ctx.save();
    ctx.translate(0, Math.round(tyPx / PX) * PX);
    if (rotDeg) {
        ctx.translate(anchorX, anchorY);
        ctx.rotate((rotDeg * Math.PI) / 180);
        ctx.translate(-anchorX, -anchorY);
    }
    paint(elastic, mirror);
    ctx.restore();

    if (frontGrounded.length) paint(frontGrounded, mirror);

    if (symbols.length) {
        ctx.save();
        ctx.translate(0, Math.round(tyPx / PX) * PX);
        const placed = mirror
            ? symbols.map((s) => {
                  const w = Math.max(1, ...s.rows.map((r) => r.length));
                  return { ...s, ox: 16 - (s.ox + w) };
              })
            : symbols;
        paint(placed, false);
        ctx.restore();
    }
}

/* ── 角色像素骨架（带微妙受光高光与暗面层次） ──────────────────────────── */

const BODY = {
    crabStand: L(2, 0, [
        'q##########q',
        '############',
        '############',
        '############',
        '############',
        '############',
        '############',
        's##########s',
    ]),
    crabSquash: L(1, 2, [
        '.qqqqqqqqqqqq.',
        '##############',
        '##############',
        '##############',
        '##############',
        's############s',
    ]),
    crabTall: L(2, -1, [
        'q##########q',
        '############',
        '############',
        '############',
        '############',
        '############',
        '############',
        '############',
        's##########s',
    ]),
    crabTurnL: L(2, 0, ['q##########s', ...Array(6).fill('###########s'), 's##########s']),
    crabTurnR: L(2, 0, ['s##########q', ...Array(6).fill('s###########'), 's##########s']),
    crabLeanL: L(1, 0, ['q##########q.', '############.', '############.', '############.', '.############', '.############', '.############', '.s##########s']),
    crabLeanR: L(2, 0, ['.q##########q', '.############', '.############', '.############', '############.', '############.', '############.', 's##########s.']),

    catStand: L(2, 1, [
        'q##########q',
        '############',
        '############',
        '############',
        '############',
        '############',
        's##########s',
    ]),
    catSquash: L(1, 2, [
        '.qqqqqqqqqqqq.',
        '##############',
        '##############',
        '##############',
        '##############',
        's############s',
    ]),
    catTall: L(2, 0, [
        'q##########q',
        '############',
        '############',
        '############',
        '############',
        '############',
        '############',
        's##########s',
    ]),
    catLoaf: L(1, 4, [
        '.qqqqqqqqqqqq.',
        '##############',
        '##############',
        '##############',
        '##############',
        's############s',
    ]),
    catStretch: L(2, 0, [
        's##########q',
        '############',
        '############',
        '.###########',
        '.###########',
        '..##########',
        '############',
        's##########s',
    ]),
    catTurnL: L(2, 1, ['q##########s', ...Array(5).fill('###########s'), 's##########s']),
    catTurnR: L(2, 1, ['s##########q', ...Array(5).fill('s###########'), 's##########s']),
    catLeanL: L(1, 1, ['q##########q.', '############.', '############.', '############.', '.############', '.############', '.s##########s']),
    catLeanR: L(2, 1, ['.q##########q', '.############', '.############', '.############', '############.', '############.', 's##########s.']),
};

const EARS = {
    stand: L(2, -1, ['q..........q', '#q........q#']),
    tall: L(2, -2, ['q..........q', '#q........q#']),
    nod: L(2, 0, ['q..........q', '#q........q#']),
    squash: L(2, 1, ['q..........q', '#q........q#']),
    loaf: L(2, 2, ['q..........q', '#q........q#']),
    twitchL: L(2, -1, ['...........q', '#q........q#']),
    twitchR: L(2, -1, ['q...........', '#q........q#']),
    airplane: L(0, 0, ['q#............#q', '###..........###']),
};

const EYES_CRAB = {
    open: L(4, 2, ['o......o', 'o......o']),
    left: L(3, 2, ['o......o', 'o......o']),
    right: L(5, 2, ['o......o', 'o......o']),
    up: L(4, 1, ['o......o', 'o......o']),
    upL: L(3, 1, ['o......o', 'o......o']),
    upR: L(5, 1, ['o......o', 'o......o']),
    half: L(4, 3, ['o......o']),
    shut: L(3, 3, ['oo......oo']),
    happy: L(3, 2, ['.o......o.', 'o.o....o.o']),
    wide: L(3, 2, ['oo......oo', 'oo......oo']),
    squint: L(4, 2, ['o......o', '.o....o.', 'o......o']),
    blink: L(3, 3, ['ss......ss']),
};

const EYES_CAT = Object.fromEntries(
    Object.entries(EYES_CRAB).map(([k, v]) => [k, L(v.ox, v.oy + 1, v.rows)]),
);
EYES_CAT.loafShut = L(3, 6, ['oo......oo']);
EYES_CAT.loafHalf = L(4, 6, ['o......o']);

const BLUSH = {
    crab: L(3, 5, ['p........p']),
    cat: L(3, 6, ['p........p']),
};

const LEGS = {
    stand: L(3, 8, ['#.#....#.#', '#.#....#.#']),
    crouch: L(3, 9, ['#.#....#.#']),
    tuck: L(4, 8, ['#.#..#.#', '#.#..#.#']),
    walkA: L(3, 8, ['#.#....#.#', '#......#..']),
    walkB: L(3, 8, ['#.#....#.#', '..#......#']),
    dangleA: L(3, 8, ['#.#....#.#', '#.#.......', '#.#.......']),
    dangleB: L(3, 8, ['#.#....#.#', '.......#.#', '.......#.#']),
    flailA: L(2, 8, ['#...#..#...#', '#..........#']),
    flailB: L(4, 8, ['#.#..#.#', '..#..#..']),
    flailC: L(2, 8, ['#..#....#..#', '...#....#...']),
};

const CLAWS = {
    stubL: L(0, 5, ['q#', '##']),
    stubR: L(14, 5, ['#q', '##']),
    frontL: L(0, 5, ['ss', 'ss']),
    frontR: L(14, 5, ['ss', 'ss']),
    upL: L(0, -1, ['q#', '##', '#.']),
    upR: L(14, -1, ['#q', '##', '.#']),
    lowR: L(14, 7, ['###', '###']),
    reachR: L(14, 4, ['###..', '#####']),
    waveR: L(14, 0, ['.#q', '.##', '#..']),
    openL: L(0, 4, ['##', '.#', '##']),
    openR: L(14, 4, ['##', '#.', '##']),
};

const PAWS = {
    cheer: L(0, 2, ['#..............#', '#..............#']),
    up: L(0, 0, ['q#............#q', '##............##']),
    upR: L(14, 0, ['#q', '##']),
    groom1: L(12, 4, ['ss', 'ss']),
    groom2: L(12, 3, ['ss', 'ss']),
};

const TAIL = {
    up: L(14, 3, ['.q', '.#', '.#', '##']),
    sway: L(14, 3, ['.#', '.#', 's#', '#.']),
    curl: L(14, 4, ['q#', '.#', 's#']),
    loaf: L(14, 6, ['.#', '.#', 's#']),
    puff: L(14, 2, ['.q', '##', '##', 's#', '#.']),
    // 持右手道具时尾巴自然摆向左侧，避免和杯子/信纸/手柄重叠
    leftUp: L(0, 3, ['q.', '#.', '#.', '##']),
    leftSway: L(0, 3, ['#.', '#.', '#s', '.#']),
    leftCurl: L(0, 4, ['#q', '#.', '#s']),
};

/* ── 精致多帧道具 ───────────────────────────────────────────────────────── */

const PROPS = {
    // 拉面碗（带金黄面条、粉色鱼板、袅袅热气）+ 筷子
    bowl: L(13, 6, ['ypywy', 'DwwwD', 'DBBBD', '.DDD.']),
    bowlHalf: L(13, 6, ['.ywy.', 'DwwwD', 'DBBBD', '.DDD.']),
    bowlEmpty: L(13, 7, ['DkkkD', 'DBBBD', '.DDD.']),
    chop1: L(13, 3, ['...n', '..n.', '.n..', 'n...']),
    chop2: L(13, 2, ['...n', '..n.', '.ny.', 'y...']),
    chop3: L(13, 1, ['...n', '..ny', '.ny.', 'y...']),
    steamA: L(14, 3, ['.e..', 'e..e', '.e..']),
    steamB: L(14, 2, ['e..e', '.e..', '..e.']),

    // 烤鱼餐盘（带鱼尾与鱼眼：整鱼 → 吃一半 → 完整鱼骨）
    fishFull: L(12, 6, ['..qPP...', 'PPoPPqP.', 'DBBBBBBD', '.DDDDDD.']),
    fishHalf: L(12, 6, ['....PP..', 'M.M.PqP.', 'DBBBBBBD', '.DDDDDD.']),
    fishBone: L(12, 6, ['..M.M...', 'MoMMMMM.', 'DBBBBBBD', '.DDDDDD.']),

    // 暖热饮杯（瓷杯右移避让尾巴 + 双股蒸汽 + 举杯啜饮）
    mugRest1: L(14, 3, ['.e..e.', 'e..e..', 'DDDDD.', 'DnnnDD', 'DnnnD.', '.ddd..']),
    mugRest2: L(14, 3, ['e..e..', '.e..e.', 'DDDDD.', 'DnnnDD', 'DnnnD.', '.ddd..']),
    mugSip: L(12, 2, ['.e..', 'DDDDD', 'DnnnDD', 'DnnnD', '.ddd.']),

    // 草莓糖霜彩虹糖针甜甜圈（整块 → 咬一口 → 咬两口）
    donut0: L(13, 4, ['.ppp.', 'pywBp', 'pp.pn', 'nnnnn', '.NNN.']),
    donut1: L(13, 4, ['.pp..', 'pyw..', 'pp.pn', 'nnnnn', '.NNN.']),
    donut2: L(13, 5, ['..p..', '..pn.', '.nnn.']),

    // 信封（火漆印）→ 拆开 → 展开读信
    envClosed: L(14, 5, ['cccccc', 'ccwwcc', 'cwrrwc', 'cwwwwc', 'cccccc']),
    envOpen: L(14, 4, ['..cc..', '.cwwc.', 'cccccc', 'cwwwwc', 'cccccc']),
    letter: L(14, 1, ['ccccccc', 'cwwwwwc', 'cwkkkwc', 'cwwwwwc', 'cwkkkwc', 'cwwrrwc', 'ccccccc']),

    // 蝴蝶 6 位置多帧飞舞轨迹 + 头顶停落双帧微振翼
    bfR1: L(14, -4, ['B...B', 'bB.Bb', '.ByB.', '..k..']),
    bfR2: L(14, -3, ['b...b', 'BBkBB', '.ByB.']),
    bfMid1: L(7, -7, ['B...B', 'bB.Bb', '.ByB.', '..k..']),
    bfMid2: L(7, -6, ['b...b', 'BBkBB', '.ByB.']),
    bfL1: L(-2, -5, ['B...B', 'bB.Bb', '.ByB.', '..k..']),
    bfL2: L(-2, -4, ['b...b', 'BBkBB', '.ByB.']),
    bfPerch1: L(5, -4, ['B...B', 'bByBb', '.B.B.', '..k..']),
    bfPerch2: L(5, -3, ['.B.B.', 'bByBb', '..k..']),

    // 6 阶段种花（松土 → 种子 → 浇水嫩芽 → 展叶 → 花苞 → 鎏金珊瑚盛开）+ 迷你水壶
    soil: L(14, 8, ['.nnn.', 'nNNNn'], { grounded: true }),
    seed: L(14, 8, ['.nyn.', 'nNNNn'], { grounded: true }),
    sprout1: L(14, 6, ['..g..', '..G..', '.nNn.'], { grounded: true }),
    sprout2: L(13, 4, ['..g..', 'g.G.g', '..G..', '..G..', '.nNn.'], { grounded: true }),
    bud: L(13, 3, ['..p..', '.gyg.', 'g.G.g', '..G..', '..G..', '.nNn.'], { grounded: true }),
    bloom1: L(13, 1, ['..p..', '.pYp.', 'pYwYp', 'g.G.g', '..G..', '..G..', '.nNn.'], { grounded: true }),
    bloom2: L(13, 0, ['.pYp.', 'pYwYp', 'YwwwY', '.pYp.', 'g.G.g', '..G..', '..G..', '.nNn.'], { grounded: true }),
    waterCan1: L(12, 1, ['..hh.', 'h.hBh', '.hhh.', 'b....', '.b...']),
    waterCan2: L(12, 1, ['..hh.', 'h.hBh', '.hhh.', '.b...', 'b....']),

    // 激光红点 3 位置（带右上角射下的淡红激光束）
    laser0: L(16, 4, ['...z.', '..z..', '.z...', '.p...', 'pLp..', '.p...'], { grounded: true }),
    laser1: L(17, 4, ['....z', '...z.', '..z..', '..L..', '.LpL.'], { grounded: true }),
    laser2: L(14, 4, ['...z.', '..z..', '.z...', '.pLp.', '..L..'], { grounded: true }),

    // Steam 鎏金成就奖杯（带双耳把手、闪光星点与木底座）
    trophy1: L(14, -1, ['yYYYYy', 'yYwyYy', 'yYYYYy', '.yyyy.', '..yy..', '.yYYy.', 'nnnnnn']),
    trophy2: L(14, -1, ['YwyYYY', 'YYYYwY', 'yYYYYy', '.yyyy.', '..yy..', '.yYYy.', 'nnnnnn']),

    // 迷你双色游戏手柄（十字键 + 彩键 + 握把轮廓）
    pad1: L(13, 4, ['.ZZZZZZ.', 'ZlwZZBZg', 'ZllZZyZZ', 'ZZ....ZZ']),
    pad2: L(13, 4, ['.ZZZZZZ.', 'ZlwZZyZB', 'ZllZZgZZ', 'ZZ....ZZ']),

    // 4 帧带残影光轨的荧光棒（下移 2 格与举起的爪/钳无缝衔接）
    stickUpL: L(-1, -6, ['WW', 'gg', 'gg', 'gg', 'gg', 'gg']),
    stickLT_L: L(-5, -6, ['tt...', 'tW...', 'tgg..', '.tgg.', '..tgg', '...gg']),
    stickRT_L: L(-1, -6, ['...tt', '...Wt', '..ggt', '.ggt.', 'ggt..', 'gg...']),
    stickUpR: L(15, -6, ['WW', 'mm', 'mm', 'mm', 'mm', 'mm']),
    stickRT_R: L(15, -6, ['...uu', '...Wu', '..mmu', '.mmu.', 'mmu..', 'mm...']),
    stickLT_R: L(11, -6, ['uu...', 'uW...', 'umm..', '.umm.', '..umm', '...mm']),

    // 升降立麦（站在角色右侧前方，带高光银色麦头、斜支杆与声波）
    micLow: L(14, 8, ['.ll.', 'llll'], { frontGrounded: true }),
    micMid: L(14, 5, ['.lw.', 'lwwl', '.ll.', '..l.', 'llll'], { frontGrounded: true }),
    micFull: L(14, 2, ['.lw.', 'lwwl', '.ll.', '..l.', '..l.', '..l.', '..l.', 'llll'], { frontGrounded: true }),
    wave1: L(11, 2, ['.b', 'b.', '.b']),
    wave2: L(10, 1, ['..b', '.b.', 'b..', '.b.', '..b']),

    // 睡眠透明呼吸小泡泡
    snot1: L(11, 4, ['hb', 'bb']),
    snot2: L(11, 3, ['.h.', 'hwb', '.b.']),

    // 背后多焰舌篝火（3 帧循环 + 底部焦木柴堆）
    fire0: L(-2, -1, [
        '....Y.............Y.',
        '...fYf.....Y.....fYf',
        '..FfYfF...fYf...FfYf',
        '.FfYwYfF.FfYfF.FfYwY',
        'FFfYwYfFFFfYwYFFfYwY',
        'FFfYYYYfFFfYYYYfFFfY',
        'FFffYYffFFffYYffFFff',
        'FFFffffFFFFffffFFFFf',
        '.nNNnFFnNNnFFnNNnFF.',
        'NNNNnnnnNNNNnnnnNNNN',
    ], { back: true }),
    fire1: L(-2, -1, [
        '.....Y...........Y..',
        '....fYf...Y.....fYf.',
        '...FfYfF.fYf...FfYfF',
        '..FfYwYfFfYfF.FfYwYf',
        '.FFfYwYfFFwYfFFfYwYf',
        'FFfYYYYfFFYYYYfFFfYY',
        'FFffYYffFFfYYffFFffY',
        'FFFffffFFFFfffFFFFff',
        '.nNNnFFnNNnFFnNNnFF.',
        'NNNNnnnnNNNNnnnnNNNN',
    ], { back: true }),
    fire2: L(-2, -1, [
        '...Y.......Y......Y.',
        '..fYf.....fYf....fYf',
        '.FfYfF...FfYfF..FfYf',
        'FfYwYfF.FfYwYfFFfYwY',
        'FfYwYfFFFfYwYfFFfYwY',
        'FfYYYYfFFfYYYYfFFfYY',
        'FffYYffFFffYYffFFffY',
        'FFffffFFFFffffFFFFff',
        '.nNNnFFnNNnFFnNNnFF.',
        'NNNNnnnnNNNNnnnnNNNN',
    ], { back: true }),
};

const SYM = (ox, oy, rows) => ({ ox, oy, rows, sym: true });
const SYMS = {
    heart: SYM(5, -7, ['.r.r.', 'rrrrr', '.rrr.', '..r..']),
    spark: SYM(5, -8, ['..Y..', '..y..', 'YywyY', '..y..', '..Y..']),
    note: SYM(5, -8, ['..kk.', '..k.k', '..k..', 'kkk..', 'kk...']),
    q: SYM(5, -9, ['.kkk.', 'k...k', '...k.', '..k..', '.....', '..k..']),
    bang: SYM(6, -8, ['.r.', '.r.', '.r.', '...', '.r.']),
    vein: SYM(5, -7, ['.r.r.', 'rr.rr', '.....', 'rr.rr', '.r.r.']),
    tilde: SYM(5, -7, ['.k...', 'k.k.k', '...k.']),
};

/* ── 姿态拼装 ───────────────────────────────────────────────────────────── */

function buildLayers(actor, pose, tick, opts = {}) {
    const isCat = actor.kind === 'cat';
    const eyesSet = isCat ? EYES_CAT : EYES_CRAB;
    const f2 = Math.floor(tick / 2) % 2 === 0;
    const f3 = Math.floor(tick / 3) % 2 === 0;
    const p4 = Math.floor(tick / 2) % 4;
    const lt = Math.max(0, tick - actor.clipStartTick);

    let body = isCat ? BODY.catStand : BODY.crabStand;
    let ears = isCat ? EARS.stand : null;
    let eyes = eyesSet.open;
    let legs = LEGS.stand;
    let clawL = isCat ? null : CLAWS.stubL;
    let clawR = isCat ? null : CLAWS.stubR;
    let paws = null;
    let tail = isCat ? TAIL.up : null;
    let blush = null;
    let backProp = null;
    let prop1 = null;
    let prop2 = null;
    let extraSym = null;
    let sinkPx = 0;

    if (pose === 'idle') {
        const bAge = tick - actor.blinkTick;
        const blinking = (bAge >= 0 && bAge < 2) || (actor.blinkDouble && bAge >= 4 && bAge < 6);
        if (blinking) {
            eyes = eyesSet.blink;
        } else if (opts.lookTarget) {
            eyes = eyesSet[opts.lookTarget] || eyesSet.open;
        } else if (actor.glanceDir < 0) {
            eyes = eyesSet.left;
        } else if (actor.glanceDir > 0) {
            eyes = eyesSet.right;
        }
        if (isCat) {
            if (tick - actor.twitchTick >= 0 && tick - actor.twitchTick < 2) {
                ears = actor.twitchSide === 'L' ? EARS.twitchL : EARS.twitchR;
            }
            const tCycle = Math.floor(tick / 8) % 4;
            tail = tCycle === 1 ? TAIL.sway : tCycle === 3 ? TAIL.curl : TAIL.up;
        }
        if (tick - actor.breathTick >= 0 && tick - actor.breathTick < 3) {
            sinkPx = PX;
        }
    } else if (pose === 'walk') {
        const step = Math.floor(tick / 2) % 4;
        legs = [LEGS.walkA, LEGS.stand, LEGS.walkB, LEGS.stand][step];
        if (step % 2 === 0) sinkPx = PX;
        if (isCat) tail = step < 2 ? TAIL.up : TAIL.sway;
        else body = actor.faceDir === 'left' ? BODY.crabTurnL : BODY.crabTurnR;
    } else if (pose === 'sleep') {
        const bubbleBig = Math.floor(tick / 3) % 2 === 1;
        if (isCat) {
            body = BODY.catLoaf;
            ears = EARS.loaf;
            eyes = EYES_CAT.loafShut;
            legs = null;
            tail = TAIL.loaf;
            prop1 = bubbleBig ? L(11, 5, ['.h.', 'hwb', '.b.']) : L(11, 6, ['hb', 'bb']);
        } else {
            body = BODY.crabSquash;
            eyes = EYES_CRAB.shut;
            legs = LEGS.tuck;
            sinkPx = PX;
            prop1 = bubbleBig ? PROPS.snot2 : PROPS.snot1;
        }
    } else if (pose === 'dangle') {
        body = isCat ? BODY.catStand : f2 ? BODY.crabTurnL : BODY.crabTurnR;
        eyes = eyesSet.wide;
        legs = [LEGS.dangleA, LEGS.flailA, LEGS.dangleB, LEGS.flailB][p4];
        if (isCat) {
            ears = EARS.airplane;
            tail = TAIL.puff;
        } else {
            clawL = CLAWS.upL;
            clawR = CLAWS.upR;
        }
    } else if (pose === 'squash') {
        body = isCat ? BODY.catSquash : BODY.crabSquash;
        legs = LEGS.crouch;
        eyes = eyesSet.half;
        if (isCat) ears = EARS.squash;
    } else if (pose === 'tall') {
        body = isCat ? BODY.catTall : BODY.crabTall;
        ears = isCat ? EARS.tall : null;
        eyes = eyesSet.up;
        if (isCat) tail = TAIL.puff;
    } else if (pose === 'happy' || pose === 'pet') {
        eyes = eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (f2) {
            body = isCat ? BODY.catSquash : BODY.crabSquash;
            legs = LEGS.crouch;
        }
        if (isCat) {
            ears = f2 ? EARS.squash : EARS.stand;
            paws = PAWS.cheer;
            tail = f2 ? TAIL.puff : TAIL.up;
        } else {
            clawL = CLAWS.upL;
            clawR = CLAWS.upR;
        }
    } else if (pose === 'jiggle') {
        body = isCat ? (f2 ? BODY.catLeanL : BODY.catLeanR) : f2 ? BODY.crabLeanL : BODY.crabLeanR;
        eyes = eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        legs = [LEGS.flailA, LEGS.flailB, LEGS.flailC][tick % 3];
        if (isCat) tail = TAIL.puff;
        else {
            clawL = CLAWS.upL;
            clawR = CLAWS.upR;
        }
    } else if (pose === 'tilt') {
        body = isCat ? BODY.catTurnL : BODY.crabTurnL;
        eyes = eyesSet.half;
        if (isCat) {
            ears = EARS.nod;
            tail = TAIL.curl;
        }
    } else if (pose === 'wow') {
        eyes = eyesSet.wide;
        if (isCat) {
            body = BODY.catTall;
            ears = EARS.tall;
            paws = PAWS.up;
            tail = TAIL.puff;
        } else {
            body = BODY.crabTall;
            clawL = CLAWS.upL;
            clawR = CLAWS.upR;
        }
    } else if (pose === 'sulk') {
        body = isCat ? BODY.catTurnL : BODY.crabTurnL;
        eyes = f3 ? eyesSet.squint : eyesSet.shut;
        legs = LEGS.tuck;
        extraSym = SYMS.vein;
        if (isCat) {
            ears = EARS.airplane;
            tail = TAIL.curl;
        } else {
            clawL = CLAWS.frontL;
            clawR = CLAWS.frontR;
        }
    } else if (pose === 'stretch') {
        eyes = eyesSet.shut;
        extraSym = SYMS.tilde;
        if (isCat) {
            body = BODY.catStretch;
            ears = EARS.nod;
            tail = TAIL.puff;
        } else {
            body = BODY.crabTall;
            clawL = CLAWS.upL;
            clawR = CLAWS.upR;
        }
    } else if (pose === 'groom') {
        eyes = eyesSet.shut;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (isCat) {
            ears = EARS.nod;
            paws = f2 ? PAWS.groom1 : PAWS.groom2;
            tail = TAIL.curl;
        } else {
            clawR = f2 ? CLAWS.frontR : CLAWS.waveR;
        }
    } else if (pose === 'snack') {
        const c = lt % 30;
        const done = c > 23;
        const mid = c > 12;
        body = done ? (isCat ? BODY.catStand : BODY.crabStand) : f3 ? (isCat ? BODY.catSquash : BODY.crabSquash) : isCat ? BODY.catStand : BODY.crabStand;
        legs = body === BODY.catSquash || body === BODY.crabSquash ? LEGS.crouch : LEGS.stand;
        eyes = done ? eyesSet.happy : f3 ? eyesSet.half : eyesSet.open;
        if (done) blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (isCat) {
            ears = done ? EARS.stand : EARS.nod;
            tail = f3 ? TAIL.leftSway : TAIL.leftUp;
            prop1 = done ? PROPS.fishBone : mid ? PROPS.fishHalf : PROPS.fishFull;
        } else {
            prop1 = done ? PROPS.bowlEmpty : mid ? PROPS.bowlHalf : PROPS.bowl;
            prop2 = done ? null : [PROPS.chop1, PROPS.chop2, PROPS.chop3, PROPS.chop2][p4];
            if (!done && !mid) backProp = f2 ? PROPS.steamA : PROPS.steamB;
        }
    } else if (pose === 'donut') {
        const c = lt % 28;
        const done = c > 22;
        eyes = done ? eyesSet.happy : f2 ? eyesSet.half : eyesSet.open;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (!done) prop1 = c > 15 ? PROPS.donut2 : c > 8 ? PROPS.donut1 : PROPS.donut0;
        if (isCat) {
            ears = f2 ? EARS.nod : EARS.stand;
            tail = f2 ? TAIL.leftUp : TAIL.leftSway;
        } else {
            clawR = done ? CLAWS.upR : CLAWS.frontR;
        }
    } else if (pose === 'coffee') {
        const sipping = lt % 12 >= 7 && lt % 12 <= 10;
        eyes = sipping ? eyesSet.happy : eyesSet.half;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        prop1 = sipping ? PROPS.mugSip : f3 ? PROPS.mugRest1 : PROPS.mugRest2;
        if (sipping) sinkPx = PX;
        if (isCat) {
            ears = EARS.nod;
            tail = TAIL.leftCurl;
        } else {
            clawR = CLAWS.frontR;
        }
    } else if (pose === 'letter') {
        const c = lt % 28;
        body = isCat ? BODY.catTurnR : BODY.crabTurnR;
        eyes = c > 20 ? eyesSet.happy : c > 10 ? (f3 ? eyesSet.left : eyesSet.right) : eyesSet.open;
        prop1 = c < 6 ? PROPS.envClosed : c < 11 ? PROPS.envOpen : PROPS.letter;
        if (c > 20) blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (isCat) {
            ears = EARS.nod;
            tail = TAIL.leftCurl;
        }
    } else if (pose === 'butterfly') {
        const c = lt % 34;
        if (c < 8) {
            eyes = eyesSet.right;
            prop1 = f2 ? PROPS.bfR1 : PROPS.bfR2;
            if (!isCat) clawR = c % 4 < 2 ? CLAWS.reachR : CLAWS.stubR;
        } else if (c < 14) {
            eyes = eyesSet.up;
            prop1 = f2 ? PROPS.bfMid1 : PROPS.bfMid2;
            if (!isCat) clawR = CLAWS.upR;
        } else if (c < 20) {
            eyes = eyesSet.left;
            prop1 = f2 ? PROPS.bfL1 : PROPS.bfL2;
            if (!isCat) clawL = CLAWS.upL;
        } else if (c < 29) {
            eyes = eyesSet.happy;
            blush = isCat ? BLUSH.cat : BLUSH.crab;
            prop1 = f2 ? PROPS.bfPerch1 : PROPS.bfPerch2;
            extraSym = SYMS.spark;
            if (isCat) ears = EARS.nod;
        } else {
            eyes = eyesSet.upR;
            prop1 = f2 ? PROPS.bfR1 : PROPS.bfR2;
        }
        if (isCat) tail = f3 ? TAIL.sway : TAIL.puff;
    } else if (pose === 'flower') {
        const c = lt % 32;
        const crouch = c < 7;
        const watering = c >= 7 && c < 15;
        body = crouch ? (isCat ? BODY.catSquash : BODY.crabSquash) : isCat ? BODY.catStand : BODY.crabStand;
        legs = crouch ? LEGS.crouch : LEGS.stand;
        if (!isCat && crouch) clawR = CLAWS.lowR;
        if (c < 4) prop1 = PROPS.soil;
        else if (c < 8) prop1 = PROPS.seed;
        else if (c < 13) prop1 = PROPS.sprout1;
        else if (c < 18) prop1 = PROPS.sprout2;
        else if (c < 22) prop1 = PROPS.bud;
        else prop1 = f2 ? PROPS.bloom1 : PROPS.bloom2;
        if (watering) prop2 = f2 ? PROPS.waterCan1 : PROPS.waterCan2;
        eyes = c >= 22 ? eyesSet.happy : crouch ? eyesSet.half : eyesSet.open;
        if (c >= 22) {
            blush = isCat ? BLUSH.cat : BLUSH.crab;
            extraSym = SYMS.spark;
        }
        if (isCat) {
            ears = crouch ? EARS.squash : EARS.stand;
            tail = TAIL.leftSway;
        }
    } else if (pose === 'laser') {
        const pounce = lt % 10 >= 7;
        body = pounce ? (isCat ? BODY.catStretch : BODY.crabLeanR) : isCat ? BODY.catSquash : BODY.crabSquash;
        eyes = eyesSet.wide;
        legs = pounce ? LEGS.walkA : LEGS.crouch;
        prop1 = [PROPS.laser0, PROPS.laser1, PROPS.laser2][Math.floor(lt / 2) % 3];
        if (isCat) {
            ears = EARS.airplane;
            tail = TAIL.leftUp;
        } else {
            clawL = CLAWS.openL;
            clawR = CLAWS.openR;
        }
    } else if (pose === 'trophy') {
        eyes = eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        prop1 = f2 ? PROPS.trophy1 : PROPS.trophy2;
        if (f3) {
            body = isCat ? BODY.catTall : BODY.crabTall;
            if (isCat) ears = EARS.tall;
        }
        if (isCat) {
            paws = PAWS.upR;
            tail = TAIL.leftUp;
        } else {
            clawR = CLAWS.upR;
        }
    } else if (pose === 'gaming') {
        const c = lt % 30;
        const win = c > 23;
        body = win ? (isCat ? BODY.catTall : BODY.crabTall) : f2 ? (isCat ? BODY.catLeanL : BODY.crabLeanL) : isCat ? BODY.catLeanR : BODY.crabLeanR;
        eyes = win ? eyesSet.happy : eyesSet.squint;
        prop1 = win ? null : f2 ? PROPS.pad1 : PROPS.pad2;
        if (win) {
            blush = isCat ? BLUSH.cat : BLUSH.crab;
            extraSym = SYMS.spark;
            if (isCat) paws = PAWS.up;
            else {
                clawL = CLAWS.upL;
                clawR = CLAWS.upR;
            }
        } else if (!isCat) {
            clawR = CLAWS.frontR;
        }
        if (isCat) tail = win ? TAIL.puff : TAIL.leftSway;
    } else if (pose === 'bubbles') {
        const puff = lt % 8 < 4;
        body = puff ? (isCat ? BODY.catSquash : BODY.crabSquash) : isCat ? BODY.catStand : BODY.crabStand;
        eyes = puff ? eyesSet.half : eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (isCat) tail = TAIL.sway;
    } else if (pose === 'cheerSticks') {
        const beat = p4;
        body = beat % 2 === 0 ? (isCat ? BODY.catSquash : BODY.crabSquash) : isCat ? BODY.catStand : BODY.crabStand;
        legs = beat % 2 === 0 ? LEGS.crouch : LEGS.stand;
        eyes = eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        prop1 = [PROPS.stickLT_L, PROPS.stickUpL, PROPS.stickRT_L, PROPS.stickUpL][beat];
        prop2 = [PROPS.stickRT_R, PROPS.stickUpR, PROPS.stickLT_R, PROPS.stickUpR][beat];
        if (isCat) {
            paws = PAWS.up;
            tail = TAIL.puff;
        } else {
            clawL = CLAWS.upL;
            clawR = CLAWS.upR;
        }
    } else if (pose === 'micSing') {
        const c = lt % 32;
        body = isCat
            ? [BODY.catLeanR, BODY.catSquash, BODY.catLeanL, BODY.catStand][p4]
            : [BODY.crabLeanR, BODY.crabSquash, BODY.crabLeanL, BODY.crabStand][p4];
        eyes = f3 ? eyesSet.happy : eyesSet.open;
        prop1 = c < 3 ? PROPS.micLow : c < 6 ? PROPS.micMid : c > 29 ? PROPS.micMid : PROPS.micFull;
        if (c >= 6 && c <= 29) prop2 = f2 ? PROPS.wave1 : PROPS.wave2;
        if (isCat) {
            paws = PAWS.cheer;
            tail = TAIL.leftSway;
        } else {
            clawL = f3 ? CLAWS.upL : CLAWS.stubL;
            clawR = f3 ? CLAWS.stubR : CLAWS.upR;
        }
    } else if (pose === 'campfire') {
        eyes = eyesSet.open;
        backProp = [PROPS.fire0, PROPS.fire1, PROPS.fire2][tick % 3];
        prop1 = PROPS.mugRest1;
        if (isCat) tail = TAIL.leftCurl;
        else clawR = CLAWS.frontR;
    } else if (pose === 'holder') {
        body = isCat ? BODY.catSquash : BODY.crabSquash;
        legs = LEGS.crouch;
        eyes = eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (isCat) ears = EARS.squash;
    } else if (pose === 'wave') {
        eyes = eyesSet.happy;
        blush = isCat ? BLUSH.cat : BLUSH.crab;
        if (isCat) {
            ears = EARS.nod;
            paws = f2 ? PAWS.upR : PAWS.cheer;
            tail = TAIL.up;
        } else {
            clawR = f2 ? CLAWS.waveR : CLAWS.upR;
        }
    } else if (pose === 'spinHop') {
        body = isCat
            ? [BODY.catTurnR, BODY.catStand, BODY.catTurnL, BODY.catSquash][p4]
            : [BODY.crabTurnR, BODY.crabStand, BODY.crabTurnL, BODY.crabSquash][p4];
        eyes = p4 === 3 ? eyesSet.happy : eyesSet.open;
        legs = p4 === 3 ? LEGS.crouch : LEGS.tuck;
        if (isCat) tail = TAIL.puff;
    }

    // 身体下压（squash）时自动贴合猫耳与眼睛，绝不留缝
    const squashed = body === BODY.crabSquash || body === BODY.catSquash;
    if (squashed) {
        if (isCat && (ears === EARS.stand || ears === EARS.nod || ears === EARS.tall)) ears = EARS.squash;
        if (eyes && eyes !== EYES_CAT.loafShut && eyes !== EYES_CAT.loafHalf) {
            eyes = L(eyes.ox, eyes.oy + 1, eyes.rows);
        }
    }

    const symLayer = opts.sym && SYMS[opts.sym] ? SYMS[opts.sym] : extraSym;

    return {
        sinkPx,
        layers: [backProp, legs, tail, body, ears, eyes, blush, clawL, clawR, paws, prop1, prop2, symLayer],
    };
}

/* ── 像素粒子特效绘制器（爱心 / 鎏金星 / 彩屑 / 泡泡 / 音符 / 余烬 / ZzZ） ── */

const PARTICLE_SPRITES = {
    heart: { color: '#f25c6b', rows: ['.x.x.', 'xxxxx', '.xxx.', '..x..'] },
    pinkHeart: { color: '#ff90b3', rows: ['.x.x.', 'xxxxx', '.xxx.', '..x..'] },
    spark: { color: '#ffe074', rows: ['.x.', 'xxx', '.x.'] },
    star: { color: '#fff3b0', rows: ['..x..', '..x..', 'xxxxx', '..x..', '..x..'] },
    note: { color: '#b8c8e2', rows: ['.xx', '.x.', 'xx.'] },
    zSmall: { color: '#9fb0c8', rows: ['xxx', '.x.', 'xxx'] },
    zBig: { color: '#b9cae2', rows: ['xxxx', '..x.', '.x..', 'xxxx'] },
    bubble: { color: '#9ee8ff', hi: '#ffffff', rows: ['.xx.', 'xwx.', 'x..x', '.xx.'] },
    bubbleLav: { color: '#cbb8ff', hi: '#ffffff', rows: ['.xx.', 'xwx.', 'x..x', '.xx.'] },
    ember: { color: '#ff9642', rows: ['x'] },
};

/* ── 主舞台挂载 ─────────────────────────────────────────────────────────── */

export function mountDualMascotStage(hostEl, options = {}) {
    if (!hostEl) return null;
    const doc = hostEl.ownerDocument;
    const win = doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win) return null;

    let disposed = false;
    let parked = false;
    let blurred = false;
    let userPaused = false;
    let dozing = false;
    let vramReclaimed = false;
    let tickIdx = 0;
    let tickTimer = null;
    let theaterTimer = null;
    let demoLoopTimer = null;
    let currentInterval = 0;
    let lastActivityAt = performance.now();
    let theaterCursor = 0;
    let duetUntil = 0;
    let popoverRightWidth = Number(options.popoverRightWidth || 0);
    let reducedMotion = Boolean(options.reducedMotion);
    const alignMode = options.align === 'center' ? 'center' : 'right';
    const autoTheater = options.autoTheater !== false;
    const alwaysAnimate = Boolean(options.alwaysAnimate);
    const minStageW = Number(options.minStageWidth || 170);
    const pendingTimers = new Set();
    const cleanups = [];
    const dragCancelHooks = [];

    const readDpr = () => Math.min(win.devicePixelRatio || 1, 2);
    let dpr = readDpr();

    const rand = (a, b) => a + Math.random() * (b - a);
    const ticksIn = (minMs, maxMs) => Math.max(1, Math.round(rand(minMs, maxMs) / TICK_MS));
    const isLateNight = () => {
        const h = new Date().getHours();
        return h >= 23 || h < 5;
    };
    const isHidden = () => Boolean(doc.hidden);
    const isDetached = () => hostEl.isConnected === false;
    const shouldSleepVram = () => disposed || parked || isHidden() || isDetached();

    const later = (ms, fn) => {
        const id = setTimeout(() => {
            pendingTimers.delete(id);
            if (!disposed) fn();
        }, ms);
        pendingTimers.add(id);
        return id;
    };

    try {
        const mq = win.matchMedia?.('(prefers-reduced-motion: reduce)');
        if (mq && options.reducedMotion === undefined) reducedMotion = Boolean(mq.matches);
        const onMq = (e) => {
            reducedMotion = Boolean(e?.matches);
            syncTimer();
        };
        mq?.addEventListener?.('change', onMq);
        cleanups.push(() => mq?.removeEventListener?.('change', onMq));
    } catch {
        /* 忽略 */
    }

    const readStageWidth = () => {
        const w = hostEl.clientWidth || hostEl.getBoundingClientRect().width || 420;
        return Math.max(minStageW, Math.round(w));
    };

    const maxActorX = (w = readStageWidth()) => {
        const reserve = popoverRightWidth > 0 ? Math.min(w - 150, popoverRightWidth + 16) : 0;
        return Math.max(12, w - 88 - reserve);
    };
    const clampX = (x, w = readStageWidth()) => Math.max(4, Math.min(maxActorX(w), Math.round(x)));

    const makeActor = (id, kind, label, phase) => ({
        id,
        kind,
        label,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        rot: 0,
        mirror: false,
        faceDir: 'right',
        patrolDir: 1,
        dragging: false,
        ballistic: false,
        stackedOn: null,
        clipPose: null,
        clipUntil: 0,
        clipStartTick: 0,
        clipSym: null,
        clipRot: 0,
        seq: null,
        seqStart: 0,
        pokeCount: 0,
        lastPokeAt: 0,
        blinkTick: -99,
        blinkDouble: false,
        nextBlink: phase + ticksIn(2200, 5600),
        breathTick: -99,
        nextBreath: phase + ticksIn(2600, 4400),
        twitchTick: -99,
        twitchSide: 'R',
        nextTwitch: phase + ticksIn(5000, 9500),
        glanceDir: 0,
        glanceUntil: 0,
        nextGlanceAt: performance.now() + rand(2800, 6800),
        el: null,
        canvas: null,
        ctx: null,
        lastKey: '',
        lastTransform: '',
        lastZ: '',
    });

    const actors = {
        crab: makeActor('crab', 'crab', '小橙桌宠', 0),
        cat: makeActor('cat', 'cat', '小紫猫桌宠', 14),
    };
    const both = [actors.crab, actors.cat];

    while (hostEl.firstChild) hostEl.removeChild(hostEl.firstChild);

    for (const a of both) {
        const btn = doc.createElement('div');
        btn.className = 'ag-v2-mascot-actor';
        btn.setAttribute('data-mascot-id', a.id);
        btn.setAttribute('role', 'button');
        btn.setAttribute('tabindex', '0');
        btn.setAttribute('aria-label', a.label);

        const cv = doc.createElement('canvas');
        cv.className = 'ag-v2-mascot-canvas';
        cv.width = Math.round(CANVAS_W * dpr);
        cv.height = Math.round(CANVAS_H * dpr);
        btn.appendChild(cv);

        a.el = btn;
        a.canvas = cv;
        a.ctx = cv.getContext('2d');
        hostEl.appendChild(btn);
    }

    // 独立像素粒子画布（浮空爱心、星芒彩屑、泡泡、音符、打盹 ZzZ）
    const fxCanvas = doc.createElement('canvas');
    fxCanvas.className = 'ag-v2-chroma-fx';
    fxCanvas.style.cssText = 'position:absolute;left:0;bottom:0;pointer-events:none;z-index:42;image-rendering:pixelated;';
    hostEl.appendChild(fxCanvas);
    const fxCtx = fxCanvas.getContext('2d');
    const FX_H = 140;
    const particles = [];

    const spawnParticle = (kind, x, y, opts = {}) => {
        if (reducedMotion || particles.length > 48) return;
        particles.push({
            kind,
            x,
            y,
            vx: opts.vx ?? rand(-0.4, 0.4),
            vy: opts.vy ?? rand(-1.3, -0.7),
            gravity: opts.gravity ?? 0,
            sway: opts.sway ?? 0,
            phase: rand(0, Math.PI * 2),
            life: 0,
            maxLife: opts.maxLife ?? 16,
            color: opts.color || null,
            size: opts.size || 2,
        });
    };

    const burstConfetti = (cx, cy, count = 10) => {
        const colors = ['#ffe074', '#6ee7f5', '#9b8aff', '#ff85c8', '#76e38f'];
        for (let i = 0; i < count; i += 1) {
            const ang = -Math.PI * rand(0.15, 0.85);
            const spd = rand(1.6, 3.6);
            spawnParticle('dot', cx, cy, {
                vx: Math.cos(ang) * spd,
                vy: Math.sin(ang) * spd - 0.8,
                gravity: 0.22,
                maxLife: Math.round(rand(12, 20)),
                color: colors[i % colors.length],
                size: i % 3 === 0 ? 3 : 2,
            });
        }
    };

    const renderParticles = () => {
        if (shouldSleepVram() || !fxCtx) return;
        if (particles.length === 0) {
            if (fxCanvas.width > 0) {
                fxCanvas.width = 0;
                fxCanvas.height = 0;
            }
            return;
        }
        const stageW = readStageWidth();
        const needW = Math.round(stageW * dpr);
        const needH = Math.round(FX_H * dpr);
        if (fxCanvas.width !== needW || fxCanvas.height !== needH) {
            fxCanvas.width = needW;
            fxCanvas.height = needH;
            fxCanvas.style.width = `${stageW}px`;
            fxCanvas.style.height = `${FX_H}px`;
        }
        fxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        fxCtx.clearRect(0, 0, stageW, FX_H);
        fxCtx.imageSmoothingEnabled = false;

        for (let i = particles.length - 1; i >= 0; i -= 1) {
            const p = particles[i];
            const alpha = p.life > p.maxLife * 0.7 ? Math.max(0, 1 - (p.life - p.maxLife * 0.7) / (p.maxLife * 0.3)) : 1;
            const px = Math.round((p.x + (p.sway ? Math.sin(p.phase + p.life * 0.45) * p.sway : 0)) / 2) * 2;
            const py = Math.round((FX_H + p.y) / 2) * 2;

            fxCtx.globalAlpha = alpha;
            if (p.kind === 'dot') {
                fxCtx.fillStyle = p.color || '#ffe074';
                fxCtx.fillRect(px, py, p.size, p.size);
            } else {
                const sp = PARTICLE_SPRITES[p.kind];
                if (sp) {
                    const cell = p.size;
                    for (let ry = 0; ry < sp.rows.length; ry += 1) {
                        const row = sp.rows[ry];
                        for (let rx = 0; rx < row.length; rx += 1) {
                            const ch = row[rx];
                            if (ch === '.') continue;
                            fxCtx.fillStyle = ch === 'w' && sp.hi ? sp.hi : p.color || sp.color;
                            fxCtx.fillRect(px + rx * cell, py + ry * cell, cell, cell);
                        }
                    }
                }
            }
        }
        fxCtx.globalAlpha = 1;
    };

    const stepParticles = () => {
        for (let i = particles.length - 1; i >= 0; i -= 1) {
            const p = particles[i];
            p.life += 1;
            p.x += p.vx;
            p.y += p.vy;
            p.vy += p.gravity;
            if (p.life >= p.maxLife) {
                if ((p.kind === 'bubble' || p.kind === 'bubbleLav') && particles.length < 44) {
                    for (let k = 0; k < 4; k += 1) {
                        const ang = (k / 4) * Math.PI * 2 + 0.5;
                        particles.push({
                            kind: 'dot',
                            x: p.x + 4,
                            y: p.y + 4,
                            vx: Math.cos(ang) * 1.4,
                            vy: Math.sin(ang) * 1.4,
                            gravity: 0.08,
                            sway: 0,
                            phase: 0,
                            life: 0,
                            maxLife: 5,
                            color: '#dcf5ff',
                            size: 2,
                        });
                    }
                }
                particles.splice(i, 1);
            }
        }
    };

    const otherOf = (a) => (a.id === 'cat' ? actors.crab : actors.cat);
    const actorCenterX = (a) => a.x + CANVAS_W / 2;
    const actorHeadY = (a) => a.y - 46;

    const getRestPositions = () => {
        const w = readStageWidth();
        if (alignMode === 'center') {
            const gap = Math.min(82, Math.max(60, Math.round(w * 0.36)));
            const mid = Math.round((w - CANVAS_W) / 2);
            const crabX = clampX(mid - Math.round(gap / 2), w);
            const catX = clampX(mid + Math.round(gap / 2), w);
            return { crab: crabX, cat: catX };
        }
        const rightEdge = popoverRightWidth > 0 ? Math.max(185, w - popoverRightWidth - 18) : w - 12;
        const catX = clampX(rightEdge - 82, w);
        const crabX = clampX(catX - 66, w);
        return { crab: crabX, cat: catX };
    };

    const separateGround = () => {
        const [a, b] = both;
        if (a.dragging || b.dragging || a.stackedOn || b.stackedOn || a.y < -3 || b.y < -3) return;
        const minDist = 54;
        const dx = b.x - a.x;
        if (Math.abs(dx) >= minDist) return;
        const push = Math.ceil((minDist - Math.abs(dx)) / 2);
        const dir = dx >= 0 ? 1 : -1;
        a.x = clampX(a.x - dir * push);
        b.x = clampX(b.x + dir * push);
    };

    const resetHome = (soft = false) => {
        const pos = getRestPositions();
        for (const a of both) {
            if (a.dragging || a.stackedOn) continue;
            const target = pos[a.id];
            if (soft && !reducedMotion && Math.abs(a.x - target) > 8 && a.y === 0) {
                startClip(a, 'walk', 360, { patrolDir: target > a.x ? 1 : -1 });
            }
            a.x = target;
            if (a.y > 0) a.y = 0;
        }
        separateGround();
    };

    const syncStacked = () => {
        for (const a of both) {
            if (!a.stackedOn) continue;
            const holder = actors[a.stackedOn];
            if (!holder || holder === a) {
                a.stackedOn = null;
                continue;
            }
            a.x = holder.x;
            a.y = holder.y - 30;
            a.rot = holder.rot * 0.5;
        }
    };

    const dismountIfStackedOn = (holder) => {
        const rider = otherOf(holder);
        if (rider.stackedOn !== holder.id) return;
        rider.stackedOn = null;
        const side = rider.x > readStageWidth() * 0.5 ? -1 : 1;
        startBallistic(rider, side * 3.4, -5.2);
    };

    /** 多拍弹性姿态序列：[[pose, ticks], ...] */
    const playSeq = (actor, steps) => {
        actor.seq = steps.map(([pose, ticks]) => ({ pose, ticks }));
        actor.seqStart = tickIdx;
    };

    const readSeqPose = (actor) => {
        if (!actor.seq) return null;
        let k = Math.max(0, tickIdx - actor.seqStart);
        for (const st of actor.seq) {
            if (k < st.ticks) return st.pose;
            k -= st.ticks;
        }
        actor.seq = null;
        return null;
    };

    const startClip = (actor, pose, durMs, opts = {}) => {
        const now = performance.now();
        actor.clipPose = pose;
        actor.clipUntil = now + durMs;
        actor.clipStartTick = tickIdx;
        actor.clipSym = opts.sym || null;
        actor.clipRot = Number(opts.rot || 0);
        if (opts.mirror !== undefined) actor.mirror = Boolean(opts.mirror);
        if (opts.patrolDir !== undefined) {
            actor.patrolDir = opts.patrolDir >= 0 ? 1 : -1;
            actor.faceDir = actor.patrolDir > 0 ? 'right' : 'left';
            actor.mirror = actor.patrolDir < 0;
        } else if (opts.face) {
            actor.faceDir = opts.face;
            actor.mirror = opts.face === 'left';
        }
    };

    const startBallistic = (actor, vx, vy) => {
        if (reducedMotion) {
            actor.y = 0;
            actor.vx = 0;
            actor.vy = 0;
            actor.rot = 0;
            actor.ballistic = false;
            separateGround();
            renderAll();
            return;
        }
        actor.ballistic = true;
        actor.vx = Math.max(-14, Math.min(14, vx));
        actor.vy = Math.max(-14, Math.min(8, vy));
        actor.el?.setAttribute('data-direct', '1');
        syncTimer();
    };

    const resolvePose = (actor, now) => {
        if (actor.dragging) return 'dangle';
        if (actor.ballistic && actor.y < -3) return actor.clipPose === 'spinHop' ? 'spinHop' : 'dangle';
        const seqPose = readSeqPose(actor);
        if (seqPose) return seqPose;
        if (actor.clipPose && now < actor.clipUntil) return actor.clipPose;
        if (otherOf(actor).stackedOn === actor.id) return 'holder';
        if (dozing) return 'sleep';
        return 'idle';
    };

    /* ── 渲染与显存回收 ─────────────────────────────────────────────────── */

    const reclaimVram = () => {
        if (vramReclaimed) return;
        vramReclaimed = true;
        particles.length = 0;
        fxCanvas.width = 0;
        fxCanvas.height = 0;
        for (const a of both) {
            if (a.canvas) {
                a.canvas.width = 0;
                a.canvas.height = 0;
                a.lastKey = '';
            }
        }
    };

    const renderActor = (actor, now) => {
        if (shouldSleepVram()) return;
        vramReclaimed = false;
        const needW = Math.round(CANVAS_W * dpr);
        const needH = Math.round(CANVAS_H * dpr);
        if (actor.canvas.width !== needW || actor.canvas.height !== needH) {
            actor.canvas.width = needW;
            actor.canvas.height = needH;
            actor.lastKey = '';
        }

        const pose = resolvePose(actor, now);
        const sym = actor.clipPose && now < actor.clipUntil ? actor.clipSym : null;
        const rot = actor.dragging || actor.ballistic ? actor.rot : actor.clipPose && now < actor.clipUntil ? actor.clipRot : 0;

        // 另一只被拎在空中时，地上的伙伴眼神实时追随它
        const other = otherOf(actor);
        let lookTarget = null;
        if (pose === 'idle' && (other.dragging || other.ballistic)) {
            const dx = other.x - actor.x;
            const high = other.y < -28;
            lookTarget = high ? (dx < -16 ? 'upL' : dx > 16 ? 'upR' : 'up') : dx < 0 ? 'left' : 'right';
        }

        const { sinkPx, layers } = buildLayers(actor, pose, tickIdx, { sym, lookTarget });

        const tx = Math.round(actor.x);
        const ty = Math.round(actor.y);
        const tr = `translate3d(${tx}px, ${ty}px, 0)`;
        if (tr !== actor.lastTransform) {
            actor.lastTransform = tr;
            actor.el.style.transform = tr;
        }
        const z = actor.dragging ? '38' : actor.stackedOn ? '28' : actor.id === 'cat' ? '22' : '21';
        if (z !== actor.lastZ) {
            actor.lastZ = z;
            actor.el.style.zIndex = z;
        }
        const inAir = Boolean(actor.dragging || actor.stackedOn || actor.y < -4);
        if (inAir) actor.el.setAttribute('data-air', '1');
        else actor.el.removeAttribute('data-air');

        const frameKey = `${pose}|${tickIdx}|${actor.mirror ? 1 : 0}|${sinkPx}|${Math.round(rot)}|${sym || ''}|${lookTarget || ''}|${dpr}`;
        if (frameKey === actor.lastKey) return;
        actor.lastKey = frameKey;

        const ctx = actor.ctx;
        if (!ctx) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        ctx.imageSmoothingEnabled = false;
        drawLayers(ctx, layers, PALETTES[actor.kind], {
            mirror: actor.mirror,
            tyPx: sinkPx,
            rotDeg: rot,
        });
    };

    const renderAll = (now = performance.now()) => {
        if (shouldSleepVram()) {
            reclaimVram();
            return;
        }
        syncStacked();
        for (const a of both) renderActor(a, now);
        renderParticles();
    };

    /* ── 物理步进（重力弹跳 + 弹性落地序列） ────────────────────────────── */

    let physRaf = 0;
    const stepPhysics = () => {
        physRaf = 0;
        if (disposed || shouldSleepVram()) return;
        const now = performance.now();
        let anyMoving = false;
        const maxX = maxActorX();

        for (const a of both) {
            if (!a.ballistic) continue;
            anyMoving = true;
            a.vy += 0.62;
            a.x += a.vx;
            a.y += a.vy;
            a.vx *= 0.985;
            a.rot = Math.max(-16, Math.min(16, -a.vx * 1.1));

            if (a.x <= 4) {
                a.x = 4;
                a.vx = Math.abs(a.vx) * 0.58;
            } else if (a.x >= maxX) {
                a.x = maxX;
                a.vx = -Math.abs(a.vx) * 0.58;
            }

            if (a.y >= 0) {
                a.y = 0;
                if (Math.abs(a.vy) > 3.6) {
                    a.vy = -a.vy * 0.36;
                    a.vx *= 0.68;
                } else {
                    a.vy = 0;
                    a.vx = 0;
                    a.rot = 0;
                    a.ballistic = false;
                    a.el?.removeAttribute('data-direct');
                    // 三拍弹性缓冲落地（下压 → 轻回弹 → 回正）
                    playSeq(a, [['squash', 2], ['tall', 1], ['squash', 1]]);
                    separateGround();
                }
            }
        }

        renderAll(now);
        if (anyMoving) physRaf = win.requestAnimationFrame(stepPhysics);
        else syncTimer();
    };

    const ensurePhysicsLoop = () => {
        if (!physRaf && !disposed) physRaf = win.requestAnimationFrame(stepPhysics);
    };

    /* ── 自主日常剧场与双宠互动剧情 ─────────────────────────────────────── */

    const DAILY_CRAB = ['walk', 'snack', 'coffee', 'letter', 'butterfly', 'flower', 'trophy', 'gaming', 'bubbles', 'stretch', 'spinHop', 'wave'];
    const DAILY_CAT = ['walk', 'groom', 'snack', 'laser', 'coffee', 'butterfly', 'flower', 'letter', 'bubbles', 'gaming', 'stretch', 'spinHop'];
    const RARE_CLIPS = ['cheerSticks', 'micSing', 'campfire'];

    const isStageBusy = () => both.some((a) => a.dragging || a.ballistic || a.stackedOn);

    const runLeapfrog = (jumper) => {
        const other = otherOf(jumper);
        const dir = other.x >= jumper.x ? 1 : -1;
        playSeq(jumper, [['squash', 2]]);
        later(190, () => {
            if (isStageBusy() || dozing) return;
            startClip(jumper, 'spinHop', 850, { face: dir > 0 ? 'right' : 'left' });
            startBallistic(jumper, dir * 5.2, -7.8);
            ensurePhysicsLoop();
            startClip(other, 'wow', 850, { sym: 'bang', face: dir > 0 ? 'left' : 'right' });
            spawnParticle('spark', actorCenterX(jumper) - 4, actorHeadY(jumper), { vy: -1.4, maxLife: 12 });
            renderAll();
        });
    };

    const runDuet = (forced = null) => {
        const now = performance.now();
        duetUntil = now + 2800;
        const pick = forced || (Math.random() < 0.34 ? 'greet' : Math.random() < 0.65 ? 'nuzzle' : Math.random() < 0.85 ? 'leapfrog' : 'twinCheer');
        const crabLeft = actors.cat.x >= actors.crab.x;

        if (pick === 'greet') {
            startClip(actors.crab, 'wave', 2100, { face: crabLeft ? 'right' : 'left' });
            startClip(actors.cat, 'happy', 2100, { face: crabLeft ? 'left' : 'right' });
            spawnParticle('heart', actorCenterX(actors.crab) - 6, actorHeadY(actors.crab), { sway: 4, vy: -1.0, maxLife: 18 });
            spawnParticle('note', actorCenterX(actors.cat) - 4, actorHeadY(actors.cat), { sway: 3, vy: -1.1, maxLife: 18 });
        } else if (pick === 'nuzzle') {
            const dir = actors.crab.x < actors.cat.x ? -1 : 1;
            const dist = Math.max(0, Math.abs(actors.crab.x - actors.cat.x) - 56);
            const walkMs = Math.min(1300, Math.round(dist * 11));
            if (walkMs >= 200) startClip(actors.cat, 'walk', walkMs, { patrolDir: dir });
            later(walkMs, () => {
                if (isStageBusy() || dozing) return;
                startClip(actors.cat, 'groom', 1600, { face: dir < 0 ? 'left' : 'right' });
                startClip(actors.crab, 'pet', 1600, { face: dir < 0 ? 'right' : 'left' });
                const midX = (actorCenterX(actors.crab) + actorCenterX(actors.cat)) / 2;
                spawnParticle('pinkHeart', midX - 6, -46, { sway: 4, vy: -1.0, maxLife: 18 });
                later(420, () => spawnParticle('heart', midX - 4, -50, { sway: 5, vy: -1.1, maxLife: 18 }));
                renderAll();
            });
        } else if (pick === 'leapfrog') {
            const jumper = Math.random() < 0.5 ? actors.cat : actors.crab;
            const other = otherOf(jumper);
            const dist = Math.abs(other.x - jumper.x);
            if (dist > 82) {
                const dir = other.x > jumper.x ? 1 : -1;
                const walkMs = Math.min(1000, Math.round((dist - 62) * 10));
                startClip(jumper, 'walk', walkMs, { patrolDir: dir });
                later(walkMs, () => { if (!isStageBusy() && !dozing) runLeapfrog(jumper); });
            } else {
                runLeapfrog(jumper);
            }
        } else {
            startClip(actors.crab, 'trophy', 2400);
            startClip(actors.cat, 'trophy', 2400);
            startBallistic(actors.crab, 0, -4.4);
            startBallistic(actors.cat, 0, -4.8);
            ensurePhysicsLoop();
            burstConfetti(actorCenterX(actors.crab), -44, 9);
            burstConfetti(actorCenterX(actors.cat), -44, 9);
        }
        renderAll(now);
    };

    const scheduleTheater = (delayMs) => {
        clearTimeout(theaterTimer);
        theaterTimer = null;
        if (!autoTheater || disposed || dozing || parked || (!alwaysAnimate && blurred) || isHidden() || isDetached() || reducedMotion) return;
        theaterTimer = setTimeout(() => {
            theaterTimer = null;
            if (!autoTheater || disposed || dozing || parked || (!alwaysAnimate && blurred) || isHidden() || isDetached() || reducedMotion) return;
            const now = performance.now();
            if (!isStageBusy() && now >= duetUntil) {
                const cFree = !actors.crab.clipPose || now >= actors.crab.clipUntil;
                const kFree = !actors.cat.clipPose || now >= actors.cat.clipUntil;
                if (cFree && kFree && Math.random() < 0.3) {
                    runDuet();
                } else {
                    const target = theaterCursor % 2 === 0 ? actors.cat : actors.crab;
                    theaterCursor += 1;
                    if (!target.clipPose || now >= target.clipUntil) {
                        if (Math.random() < 0.1) {
                            const clip = RARE_CLIPS[Math.floor(Math.random() * RARE_CLIPS.length)];
                            startClip(target, clip, 3600);
                        } else {
                            const pool = target.id === 'cat' ? DAILY_CAT : DAILY_CRAB;
                            const night = isLateNight();
                            const clip = night && Math.random() < 0.3
                                ? Math.random() < 0.5 ? 'coffee' : 'stretch'
                                : pool[Math.floor(Math.random() * pool.length)];
                            if (clip === 'walk') {
                                const w = readStageWidth();
                                const dir = target.x > w * 0.65 ? -1 : target.x < w * 0.25 ? 1 : Math.random() < 0.5 ? -1 : 1;
                                startClip(target, 'walk', 2900, { patrolDir: dir });
                            } else if (clip === 'spinHop') {
                                startClip(target, 'spinHop', 1200);
                                startBallistic(target, 0, -5.0);
                                ensurePhysicsLoop();
                                burstConfetti(actorCenterX(target), -42, 6);
                            } else if (clip === 'trophy') {
                                startClip(target, 'trophy', 3000);
                                burstConfetti(actorCenterX(target), -44, 8);
                            } else {
                                startClip(target, clip, 3400);
                            }
                        }
                        renderAll(now);
                    }
                }
            }
            scheduleTheater();
        }, delayMs ?? Math.round(rand(4200, 6800)));
    };

    /* ── 唤醒、打盹与心跳节拍 ───────────────────────────────────────────── */

    const wakeUp = () => {
        if (!dozing) return;
        dozing = false;
        lastActivityAt = performance.now();
        startClip(actors.cat, 'stretch', 950);
        startClip(actors.crab, 'wave', 850);
        syncTimer();
        scheduleTheater(3000);
        renderAll();
    };

    const markActivity = () => {
        lastActivityAt = performance.now();
        if (dozing && !parked && !isHidden() && !blurred) wakeUp();
    };

    const onHeartbeat = () => {
        if (disposed || shouldSleepVram() || ((!alwaysAnimate && blurred) && !both.some((a) => a.ballistic))) {
            if (shouldSleepVram()) reclaimVram();
            syncTimer();
            return;
        }
        const now = performance.now();
        tickIdx += 1;

        stepParticles();

        // 巡逻走路 + 偶遇自动跳马越顶
        if (!reducedMotion && !dozing) {
            const maxX = maxActorX();
            for (const a of both) {
                if (a.dragging || a.ballistic || a.stackedOn) continue;
                if (a.clipPose === 'walk' && now < a.clipUntil) {
                    const nextX = a.x + a.patrolDir * 2.5;
                    const other = otherOf(a);
                    const hitOther =
                        !other.dragging &&
                        !other.ballistic &&
                        !other.stackedOn &&
                        Math.abs(nextX - other.x) < 52 &&
                        (other.x - a.x) * a.patrolDir > 0;
                    if (hitOther && autoTheater && Math.random() < 0.35 && now >= duetUntil) {
                        duetUntil = now + 1800;
                        a.clipUntil = 0;
                        runLeapfrog(a);
                    } else if (nextX <= 8 || nextX >= maxX - 4 || (hitOther && !autoTheater)) {
                        a.patrolDir = -a.patrolDir;
                        a.faceDir = a.patrolDir > 0 ? 'right' : 'left';
                        a.mirror = a.patrolDir < 0;
                    } else {
                        a.x = nextX;
                    }
                    separateGround();
                }
            }
        }

        // 按当前姿态周期性发射氛围像素粒子（泡泡、音符、爱心、星芒、余烬、ZzZ）
        for (const a of both) {
            const pose = resolvePose(a, now);
            const cx = actorCenterX(a);
            const lt = tickIdx - a.clipStartTick;
            if (pose === 'bubbles' && lt % 5 === 2) {
                spawnParticle(Math.random() < 0.5 ? 'bubble' : 'bubbleLav', cx + (a.mirror ? -22 : 14), -26, {
                    vx: (a.mirror ? -1 : 1) * rand(0.4, 0.9),
                    vy: rand(-1.3, -0.8),
                    sway: 4,
                    maxLife: 20,
                    size: 2,
                });
            } else if ((pose === 'cheerSticks' || pose === 'micSing') && lt % 6 === 1) {
                spawnParticle('note', cx + rand(-14, 10), -54, { sway: 4, vy: -1.0, maxLife: 16, size: 2 });
            } else if (pose === 'pet' && lt % 5 === 1) {
                spawnParticle('pinkHeart', cx + rand(-10, 4), -48, { sway: 4, vy: -1.0, maxLife: 16, size: 2 });
            } else if (pose === 'campfire' && tickIdx % 3 === 0) {
                spawnParticle('ember', cx + rand(-24, 20), -26, { vx: rand(-0.3, 0.3), vy: rand(-1.5, -0.8), maxLife: 12, size: 2 });
            } else if (pose === 'flower' && (lt % 32) === 22) {
                burstConfetti(cx + (a.mirror ? -18 : 18), -32, 7);
            } else if ((pose === 'snack' && (lt % 30) === 22) || (pose === 'donut' && (lt % 26) === 19)) {
                spawnParticle('heart', cx - 6, -48, { sway: 3, vy: -1.0, maxLife: 18, size: 2 });
            } else if (pose === 'gaming' && (lt % 30) === 22) {
                spawnParticle('star', cx - 5, -52, { vy: -1.0, maxLife: 14, size: 2 });
            } else if (pose === 'letter' && (lt % 28) === 21) {
                spawnParticle('pinkHeart', cx - 5, -48, { sway: 3, vy: -1.0, maxLife: 16, size: 2 });
            } else if (pose === 'trophy' && lt % 10 === 2) {
                spawnParticle('star', cx + rand(-16, 12), -54, { vy: -0.9, maxLife: 13, size: 2 });
            } else if (pose === 'sleep' && tickIdx % 4 === (a.id === 'cat' ? 2 : 0)) {
                spawnParticle(Math.random() < 0.5 ? 'zSmall' : 'zBig', cx + 8, -32, { vx: 0.4, vy: -0.9, sway: 2, maxLife: 14, size: 2 });
            }
        }

        // 独立待机微动作
        for (const a of both) {
            if (tickIdx >= a.nextBlink) {
                a.blinkTick = tickIdx;
                a.blinkDouble = Math.random() < 0.25;
                a.nextBlink = tickIdx + ticksIn(2400, 6200);
            }
            if (tickIdx >= a.nextBreath) {
                a.breathTick = tickIdx;
                a.nextBreath = tickIdx + ticksIn(2800, 4600);
            }
            if (a.kind === 'cat' && tickIdx >= a.nextTwitch) {
                a.twitchTick = tickIdx;
                a.twitchSide = Math.random() < 0.5 ? 'L' : 'R';
                a.nextTwitch = tickIdx + ticksIn(5200, 9600);
            }
            if (now >= a.glanceUntil) a.glanceDir = 0;
            if (now >= a.nextGlanceAt && (!a.clipPose || now >= a.clipUntil)) {
                a.glanceDir = Math.random() < 0.5 ? -1 : 1;
                a.glanceUntil = now + rand(700, 1400);
                a.nextGlanceAt = now + rand(3200, 7600);
            }
        }

        // 自动打盹
        const dozeLimit = isLateNight() ? DOZE_AFTER_NIGHT_MS : DOZE_AFTER_MS;
        if (autoTheater && !dozing && !isStageBusy() && now - lastActivityAt > dozeLimit) {
            dozing = true;
            clearTimeout(theaterTimer);
            theaterTimer = null;
            syncTimer();
        }

        renderAll(now);
    };

    const syncTimer = () => {
        const paused =
            disposed ||
            parked ||
            userPaused ||
            isHidden() ||
            isDetached() ||
            (!alwaysAnimate && blurred && !both.some((a) => a.ballistic)) ||
            (reducedMotion && !both.some((a) => a.ballistic));
        const target = paused ? 0 : dozing ? DOZE_TICK_MS : TICK_MS;
        if (target === currentInterval) return;
        if (tickTimer !== null) {
            clearInterval(tickTimer);
            tickTimer = null;
        }
        currentInterval = target;
        if (target > 0) tickTimer = setInterval(onHeartbeat, target);
    };

    /* ── 鼠标交互：5 段戳、长按抚摸、右键投喂、拖拽与叠叠乐 ──────────────── */

    const triggerPoke = (actor) => {
        const now = performance.now();
        markActivity();
        if (actor.stackedOn) {
            actor.stackedOn = null;
            startBallistic(actor, actor.x > readStageWidth() * 0.5 ? -3.2 : 3.2, -5.0);
            ensurePhysicsLoop();
        }
        if (now - actor.lastPokeAt > 4500) actor.pokeCount = 0;
        actor.pokeCount += 1;
        actor.lastPokeAt = now;

        const cx = actorCenterX(actor);
        if (actor.pokeCount === 1) {
            startClip(actor, actor.kind === 'cat' && Math.random() < 0.45 ? 'groom' : 'happy', 850);
            startBallistic(actor, 0, -4.6);
            ensurePhysicsLoop();
            spawnParticle('star', cx - 5, -48, { vy: -1.1, maxLife: 14, size: 2 });
        } else if (actor.pokeCount === 2) {
            startClip(actor, 'jiggle', 950);
            spawnParticle('note', cx - 4, -50, { sway: 3, vy: -1.1, maxLife: 16, size: 2 });
        } else if (actor.pokeCount === 3) {
            startClip(actor, 'tilt', 1100, { rot: -9, sym: 'q' });
        } else if (actor.pokeCount === 4) {
            startClip(actor, 'wow', 950, { sym: 'bang' });
            startBallistic(actor, 0, -3.6);
            ensurePhysicsLoop();
        } else {
            actor.pokeCount = 0;
            startClip(actor, 'sulk', 3000, { mirror: true, sym: 'vein' });
        }
        renderAll(now);
    };

    const bindPointer = (actor) => {
        let downX = 0;
        let downY = 0;
        let startX = 0;
        let startY = 0;
        let lastX = 0;
        let lastY = 0;
        let lastT = 0;
        let moved = false;
        let petTimer = 0;
        let petFired = false;

        const onDown = (e) => {
            if (e.button !== 0 || disposed) return;
            e.preventDefault();
            e.stopPropagation();
            markActivity();
            actor.el.setPointerCapture?.(e.pointerId);
            downX = lastX = e.clientX;
            downY = lastY = e.clientY;
            startX = actor.x;
            startY = actor.y;
            lastT = performance.now();
            moved = false;
            petFired = false;

            clearTimeout(petTimer);
            petTimer = setTimeout(() => {
                if (!moved && lastT > 0 && !disposed) {
                    petFired = true;
                    startClip(actor, 'pet', 1600);
                    spawnParticle('pinkHeart', actorCenterX(actor) - 6, -48, { sway: 4, vy: -1.0, maxLife: 18, size: 2 });
                    renderAll();
                }
            }, 340);
        };

        const onMove = (e) => {
            if (lastT === 0 || disposed) return;
            const dx = e.clientX - downX;
            const dy = e.clientY - downY;
            if (!moved && Math.hypot(dx, dy) < 5) return;

            if (!moved) {
                moved = true;
                clearTimeout(petTimer);
                dismountIfStackedOn(actor);
                actor.stackedOn = null;
                actor.ballistic = false;
                actor.dragging = true;
                actor.el.setAttribute('data-dragging', '1');
                actor.el.setAttribute('data-direct', '1');
            }

            const now = performance.now();
            const dt = Math.max(6, now - lastT);
            actor.vx = actor.vx * 0.45 + (((e.clientX - lastX) / dt) * 16) * 0.55;
            actor.vy = actor.vy * 0.45 + (((e.clientY - lastY) / dt) * 16) * 0.55;
            actor.rot = Math.max(-15, Math.min(15, -actor.vx * 0.85));
            lastX = e.clientX;
            lastY = e.clientY;
            lastT = now;

            actor.x = clampX(startX + dx);
            actor.y = Math.max(-175, Math.min(0, startY + dy));

            const other = otherOf(actor);
            if (!other.dragging && !other.stackedOn && actor.y > -24 && Math.abs(actor.x - other.x) < 38) {
                if (Math.abs(actor.vx) > 2.3 && !other.ballistic) {
                    const pushDir = actor.vx >= 0 ? 1 : -1;
                    startClip(other, 'wow', 750, { sym: 'bang', face: pushDir > 0 ? 'left' : 'right' });
                    startBallistic(other, pushDir * Math.min(5.2, Math.abs(actor.vx) * 0.55), -3.0);
                    ensurePhysicsLoop();
                }
            }

            renderAll(now);
        };

        const finishDrag = (e, cancelled = false) => {
            if (lastT === 0) return;
            clearTimeout(petTimer);
            const prevT = lastT;
            lastT = 0;
            try {
                if (e) actor.el.releasePointerCapture?.(e.pointerId);
            } catch {
                /* 忽略 */
            }

            if (moved) {
                moved = false;
                actor.dragging = false;
                actor.el.removeAttribute('data-dragging');
                const now = performance.now();
                if (cancelled || now - prevT > 40) {
                    actor.vx = 0;
                    actor.vy = 0;
                }
                const other = otherOf(actor);
                const gentle = Math.hypot(actor.vx, actor.vy) < 4.6;
                if (
                    !cancelled &&
                    gentle &&
                    !other.dragging &&
                    !other.ballistic &&
                    !other.stackedOn &&
                    Math.abs(actor.x - other.x) <= 32 &&
                    actor.y <= -10 &&
                    actor.y >= -68
                ) {
                    actor.stackedOn = other.id;
                    actor.vx = 0;
                    actor.vy = 0;
                    actor.rot = 0;
                    actor.el.removeAttribute('data-direct');
                    startClip(actor, 'happy', 1100);
                    playSeq(other, [['squash', 2]]);
                    spawnParticle('heart', actorCenterX(actor) - 5, -76, { sway: 4, vy: -1.0, maxLife: 18, size: 2 });
                    burstConfetti(actorCenterX(actor), -70, 6);
                    renderAll(now);
                    return;
                }

                startBallistic(actor, actor.vx * 0.82, actor.vy * 0.82);
                ensurePhysicsLoop();
                return;
            }

            if (!cancelled && !petFired) triggerPoke(actor);
        };

        const onUp = (e) => finishDrag(e, false);
        const onCancel = (e) => finishDrag(e, true);
        const onContext = (e) => {
            e.preventDefault();
            e.stopPropagation();
            markActivity();
            startClip(actor, actor.kind === 'cat' && Math.random() < 0.45 ? 'snack' : 'donut', 2600);
            renderAll();
        };
        const onKey = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                triggerPoke(actor);
            }
        };

        actor.el.addEventListener('pointerdown', onDown);
        actor.el.addEventListener('pointermove', onMove);
        actor.el.addEventListener('pointerup', onUp);
        actor.el.addEventListener('pointercancel', onCancel);
        actor.el.addEventListener('contextmenu', onContext);
        actor.el.addEventListener('keydown', onKey);
        dragCancelHooks.push(() => finishDrag(null, true));

        cleanups.push(() => {
            clearTimeout(petTimer);
            actor.el.removeEventListener('pointerdown', onDown);
            actor.el.removeEventListener('pointermove', onMove);
            actor.el.removeEventListener('pointerup', onUp);
            actor.el.removeEventListener('pointercancel', onCancel);
            actor.el.removeEventListener('contextmenu', onContext);
            actor.el.removeEventListener('keydown', onKey);
        });
    };

    for (const a of both) bindPointer(a);

    /* ── 窗口事件监听 ───────────────────────────────────────────────────── */

    const onBlur = () => {
        blurred = true;
        for (const fn of dragCancelHooks) fn();
        syncTimer();
    };
    const onFocus = () => {
        blurred = false;
        dpr = readDpr();
        syncTimer();
        scheduleTheater();
        renderAll();
    };
    const onVis = () => {
        syncTimer();
        if (shouldSleepVram()) reclaimVram();
        else renderAll();
    };
    const onResize = () => {
        dpr = readDpr();
        const w = readStageWidth();
        for (const a of both) a.x = clampX(a.x, w);
        separateGround();
        renderAll();
    };

    win.addEventListener('blur', onBlur);
    win.addEventListener('focus', onFocus);
    win.addEventListener('resize', onResize, { passive: true });
    doc.addEventListener('visibilitychange', onVis);
    cleanups.push(() => {
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('focus', onFocus);
        win.removeEventListener('resize', onResize);
        doc.removeEventListener('visibilitychange', onVis);
    });

    resetHome(false);
    renderAll();
    syncTimer();
    scheduleTheater(2800);

    return {
        setState(next = {}) {
            if (next.popoverRightWidth !== undefined) {
                const prev = popoverRightWidth;
                popoverRightWidth = Number(next.popoverRightWidth || 0);
                if (popoverRightWidth !== prev) resetHome(true);
            }
            if (next.reducedMotion !== undefined) {
                reducedMotion = Boolean(next.reducedMotion);
                syncTimer();
            }
            renderAll();
        },
        notify(event) {
            if (disposed) return;
            if (event === 'activity') {
                markActivity();
                return;
            }
            if (event === 'aura-complete') {
                markActivity();
                runDuet('twinCheer');
            }
        },
        triggerDemo(rawKind, opts = {}) {
            if (disposed) return;
            markActivity();
            if (demoLoopTimer !== null) {
                clearInterval(demoLoopTimer);
                demoLoopTimer = null;
            }
            const kind = rawKind === 'thisIsFine' ? 'campfire' : rawKind;
            const loop = Boolean(opts.loop);
            const dur = loop ? 3600000 : 3600;
            for (const a of both) {
                a.stackedOn = null;
                a.ballistic = false;
                a.y = 0;
                a.rot = 0;
                a.mirror = false;
                a.faceDir = 'right';
                a.clipSym = null;
                a.clipRot = 0;
            }
            if (kind === 'idle') {
                dozing = false;
                for (const a of both) { a.clipPose = null; a.clipUntil = 0; }
                resetHome(false);
            } else if (kind === 'greet' || kind === 'nuzzle' || kind === 'leapfrog' || kind === 'twinCheer' || kind === 'duet') {
                dozing = false;
                resetHome(false);
                if (loop && kind === 'greet') {
                    startClip(actors.crab, 'wave', dur, { face: 'right' });
                    startClip(actors.cat, 'happy', dur, { face: 'left' });
                    spawnParticle('heart', actorCenterX(actors.crab) - 6, -48, { sway: 4, vy: -1.0, maxLife: 18 });
                    spawnParticle('note', actorCenterX(actors.cat) - 4, -48, { sway: 3, vy: -1.1, maxLife: 18 });
                    demoLoopTimer = setInterval(() => {
                        if (disposed || userPaused) return;
                        spawnParticle('heart', actorCenterX(actors.crab) - 6, -48, { sway: 4, vy: -1.0, maxLife: 18 });
                        spawnParticle('note', actorCenterX(actors.cat) - 4, -48, { sway: 3, vy: -1.1, maxLife: 18 });
                    }, 1800);
                } else if (loop && kind === 'nuzzle') {
                    const mid = Math.round((readStageWidth() - CANVAS_W) / 2);
                    actors.crab.x = clampX(mid - 24);
                    actors.cat.x = clampX(mid + 24);
                    startClip(actors.crab, 'pet', dur, { face: 'right', rot: 4 });
                    startClip(actors.cat, 'groom', dur, { face: 'left', rot: -4 });
                    const cx = (actorCenterX(actors.crab) + actorCenterX(actors.cat)) / 2;
                    spawnParticle('pinkHeart', cx - 6, -46, { sway: 4, vy: -1.0, maxLife: 18 });
                    demoLoopTimer = setInterval(() => {
                        if (disposed || userPaused) return;
                        spawnParticle('pinkHeart', cx - 6, -46, { sway: 4, vy: -1.0, maxLife: 18 });
                        later(350, () => spawnParticle('heart', cx - 4, -50, { sway: 5, vy: -1.1, maxLife: 18 }));
                    }, 1700);
                } else if (loop && kind === 'twinCheer') {
                    startClip(actors.crab, 'trophy', dur);
                    startClip(actors.cat, 'trophy', dur);
                    burstConfetti(actorCenterX(actors.crab), -44, 8);
                    burstConfetti(actorCenterX(actors.cat), -44, 8);
                    demoLoopTimer = setInterval(() => {
                        if (disposed || userPaused) return;
                        startBallistic(actors.crab, 0, -4.4);
                        startBallistic(actors.cat, 0, -4.8);
                        ensurePhysicsLoop();
                        burstConfetti(actorCenterX(actors.crab), -44, 8);
                        burstConfetti(actorCenterX(actors.cat), -44, 8);
                    }, 2200);
                } else {
                    const duetKey = kind === 'duet' ? null : kind;
                    runDuet(duetKey);
                    if (loop) {
                        demoLoopTimer = setInterval(() => {
                            if (disposed || userPaused) return;
                            resetHome(false);
                            runDuet(duetKey);
                        }, kind === 'leapfrog' ? 2400 : 3200);
                    }
                }
            } else if (kind === 'doze') {
                dozing = true;
                for (const a of both) { a.clipPose = null; a.clipUntil = 0; }
                resetHome(false);
                syncTimer();
            } else if (kind === 'stack') {
                dozing = false;
                resetHome(false);
                actors.cat.stackedOn = 'crab';
                startClip(actors.cat, 'happy', dur);
                spawnParticle('heart', actorCenterX(actors.crab) - 5, -76, { sway: 4, vy: -1.0, maxLife: 18, size: 2 });
                if (loop) {
                    demoLoopTimer = setInterval(() => {
                        if (disposed || userPaused) return;
                        spawnParticle('heart', actorCenterX(actors.crab) - 5, -76, { sway: 4, vy: -1.0, maxLife: 18, size: 2 });
                    }, 2200);
                }
            } else if (kind === 'poke') {
                dozing = false;
                triggerPoke(actors.crab);
                triggerPoke(actors.cat);
                if (loop) {
                    demoLoopTimer = setInterval(() => {
                        if (disposed || userPaused) return;
                        triggerPoke(actors.crab);
                        triggerPoke(actors.cat);
                    }, 1500);
                }
            } else if (kind === 'spinHop') {
                dozing = false;
                const hop = () => {
                    startClip(actors.crab, 'spinHop', 1100);
                    startClip(actors.cat, 'spinHop', 1100);
                    startBallistic(actors.crab, 0, -4.8);
                    startBallistic(actors.cat, 0, -5.2);
                    ensurePhysicsLoop();
                    burstConfetti(actorCenterX(actors.crab), -44, 6);
                    burstConfetti(actorCenterX(actors.cat), -44, 6);
                };
                hop();
                if (loop) {
                    demoLoopTimer = setInterval(() => {
                        if (!disposed && !userPaused) hop();
                    }, 1750);
                }
            } else if (kind === 'walk') {
                dozing = false;
                resetHome(false);
                startClip(actors.crab, 'walk', dur, { patrolDir: 1 });
                startClip(actors.cat, 'walk', dur, { patrolDir: 1 });
            } else if (kind === 'dangle') {
                dozing = false;
                resetHome(false);
                actors.crab.y = -18;
                actors.cat.y = -18;
                startClip(actors.crab, 'dangle', dur, { rot: -8 });
                startClip(actors.cat, 'dangle', dur, { rot: 8 });
            } else {
                dozing = false;
                const clipOpts = kind === 'sulk' ? { mirror: true, sym: 'vein' } : kind === 'tilt' ? { rot: -9, sym: 'q' } : kind === 'wow' ? { sym: 'bang' } : {};
                startClip(actors.crab, kind, dur, clipOpts);
                startClip(actors.cat, kind, dur, clipOpts);
                if (kind === 'trophy') {
                    burstConfetti(actorCenterX(actors.crab), -44, 8);
                    burstConfetti(actorCenterX(actors.cat), -44, 8);
                    if (loop) {
                        demoLoopTimer = setInterval(() => {
                            if (disposed || userPaused) return;
                            burstConfetti(actorCenterX(actors.crab), -44, 6);
                            burstConfetti(actorCenterX(actors.cat), -44, 6);
                        }, 2400);
                    }
                }
            }
            syncTimer();
            renderAll();
        },
        setPaused(on = true) {
            userPaused = Boolean(on);
            syncTimer();
        },
        stepTick(steps = 1) {
            if (disposed) return;
            for (let i = 0; i < steps; i += 1) onHeartbeat();
        },
        park(on = true) {
            if (disposed) return;
            parked = Boolean(on);
            if (parked) {
                clearTimeout(theaterTimer);
                theaterTimer = null;
                syncTimer();
                reclaimVram();
            } else {
                syncTimer();
                scheduleTheater();
                renderAll();
            }
        },
        resume() {
            if (disposed) return;
            parked = false;
            blurred = false;
            syncTimer();
            scheduleTheater();
            renderAll();
        },
        dispose() {
            disposed = true;
            if (tickTimer !== null) clearInterval(tickTimer);
            if (theaterTimer !== null) clearTimeout(theaterTimer);
            if (demoLoopTimer !== null) clearInterval(demoLoopTimer);
            if (physRaf) win.cancelAnimationFrame?.(physRaf);
            for (const id of pendingTimers) clearTimeout(id);
            pendingTimers.clear();
            reclaimVram();
            for (const fn of cleanups) {
                try {
                    fn();
                } catch {
                    /* 忽略 */
                }
            }
            fxCanvas.remove();
            for (const a of both) a.el?.remove();
        },
    };
}

export default { mountDualMascotStage };
