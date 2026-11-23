/**
 * 生成主题用到的全部矢量图，输出为 src/css/ac/art.css（自动生成，勿手改）。
 *
 *   --ac-badge-img     「完美通关」徽章（彩色，直接当 background-image 用）
 *   --ac-badge-img-all 同一枚徽章的蓝紫渐变版：本体和所有 DLC 成就集合都全成就
 *   --ac-badge-img-flat / --ac-badge-img-all-flat  去掉立体内线的两枚（设置「徽章立体内线」关闭时，
 *                      根节点带 data-ac-badge-line="off"，把上面两个变量换成这两枚）
 *   --ac-laurel        月桂枝（左侧；右侧用 scaleX(-1) 镜像）   ┐
 *   --ac-trophy        奖杯                                      │ 单色蒙版：
 *   --ac-stopwatch     秒表                                      │ 用 mask-image + 渐变背景上色，
 *   --ac-sparkle       四角星芒                                  │ 这样金 / 银 / 白共用一份形状
 *   --ac-grain         纸张 / 皮面纹理（feTurbulence 噪点）      ┘
 *
 * 徽章构造（参照参考图 4；配色见 PALETTES，形状所有配色共用）：
 *   · 八角星：两个正方形叠成，蓝色主体 + 内层深蓝斜面 + 奶金描边
 *   · 宝珠：奶金圆环 + 橙金宝珠 + 斜向亮带 + 高光弧与高光点
 *   · 绶带：两条燕尾，蓝色 + 金边，压在星形下面
 * 展柜里它只有 ~44px 高，所以描边都给到足够粗，外圈再压一道细暗边，
 * 保证在蓝色信息条和亮色封面上都能读出轮廓。
 *
 * 用法：node tools/make-art.mjs
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', '..', 'millennium', 'themes', 'AchievementCollection', 'src', 'css', 'ac', 'art.css');

const f = (n) => (Math.round(n * 100) / 100).toString();
const uri = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

/* ══ 徽章 ═══════════════════════════════════════════════════════════════ */

const CX = 50;
const CY = 47;

/** 两个正方形叠成的八角星：外顶点半径 R，内凹点半径 R·cos45°/cos22.5° */
function star(R) {
    const inner = (R * Math.cos(Math.PI / 4)) / Math.cos(Math.PI / 8);
    let d = '';
    for (let i = 0; i < 16; i += 1) {
        const r = i % 2 === 0 ? R : inner;
        const a = (-90 + i * 22.5) * (Math.PI / 180);
        d += `${i ? 'L' : 'M'}${f(CX + r * Math.cos(a))} ${f(CY + r * Math.sin(a))}`;
    }
    return `${d}Z`;
}

/** 左侧燕尾绶带；右侧镜像 */
const TAIL_LEFT = [
    [26, 64],
    [52, 77],
    [45.5, 112.5],
    [33.5, 102.5],
    [16.5, 107],
];
const tail = (mirror) => `M${TAIL_LEFT.map(([x, y]) => `${f(mirror ? 100 - x : x)} ${f(y)}`).join('L')}Z`;

const OUTLINE = '#4a3208';

/** 线性渐变：dir 是 [x1, y1, x2, y2]，stops 是 [offset, color, opacity?] */
function gradient(id, { dir, stops }) {
    const [x1, y1, x2, y2] = dir;
    return (
        `<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
        stops.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a == null ? '' : ` stop-opacity="${a}"`}/>`).join('') +
        '</linearGradient>'
    );
}

const DOWN = [0, 0, 0, 1];

/**
 * 徽章配色。宝珠、奶金描边、暗边三样所有配色共用，只换星形和绶带的颜色。
 *   base：本体集合全成就（也是没有成就集合的游戏），原来那枚蓝徽章，一个像素都不改
 *   all ：本体 + 所有 DLC 集合都全成就，蓝紫渐变。Steam 自己的成就页里本体是蓝、DLC 是紫，
 *         渐变就是「蓝的那份和紫的那份都拿满了」
 */
const PALETTES = {
    base: {
        star: { dir: DOWN, stops: [['0', '#5b9bff'], ['1', '#2b63dc']] },
        bevel: { dir: DOWN, stops: [['0', '#2f6fe8'], ['1', '#1d4cc0']] },
        tail: { dir: DOWN, stops: [['0', '#2459cf'], ['.55', '#3a7cf2'], ['1', '#2a62de']] },
        bevelEdge: '#1a43ad',
        bevelHighlight: '#7fb2ff',
    },
    // 全部集合：左蓝右紫，像 Steam 成就页那条蓝紫分段的进度条；左绶带蓝、右绶带紫。
    // 紫色取自 Steam 客户端自己的 DLC 集合奖章（steamui 里 dlc 奖章 #B658C4 → #8A3F97，
    // 本体奖章 #1A9FFF → #1465CF）。过渡收在中间一小段，蓝紫两半分得开；
    // 横向渐变没有了上亮下暗，用 shade 再叠一层竖向明暗，保住原来的立体感。
    horizontal: {
        star: { dir: [0, 0, 1, 0], stops: [['0', '#4f8fff'], ['.36', '#4a7ef6'], ['.64', '#a856c2'], ['1', '#b658c4']] },
        bevel: { dir: [0, 0, 1, 0], stops: [['0', '#2a66e2'], ['.36', '#2558d4'], ['.64', '#7e3a9a'], ['1', '#8a3f97']] },
        tail: { dir: DOWN, stops: [['0', '#2459cf'], ['.55', '#3a7cf2'], ['1', '#2a62de']] },
        tailRight: { dir: DOWN, stops: [['0', '#7a3689'], ['.55', '#b658c4'], ['1', '#8a3f97']] },
        bevelEdge: '#3a2c8c',
        // 贴合画法（A）的斜面线：左半深蓝、右半深紫，过渡和星形本身的蓝紫过渡对齐
        bevelEdgeSplit: { dir: [0, 0, 1, 0], stops: [['0', '#1a43ad'], ['.36', '#1d45b2'], ['.64', '#5a2670'], ['1', '#5e2875']] },
        bevelHighlight: '#7fb2ff',
        shade: true,
    },
    // 独立 DLC 集合奖章（Steam 客户端游戏页 / 详情页中与本体分开显示的紫色 DLC 奖章）
    dlc: {
        star: { dir: DOWN, stops: [['0', '#cf72e0'], ['1', '#8a3f97']] },
        bevel: { dir: DOWN, stops: [['0', '#c468d4'], ['1', '#843892']] },
        tail: { dir: DOWN, stops: [['0', '#7a3689'], ['.55', '#b658c4'], ['1', '#8a3f97']] },
        bevelEdge: '#58236e',
        bevelHighlight: '#e6a6f5',
    },
    // 上一稿（2026-11-04 用户选了左右走向，但嫌紫色太浅、渐变不明显），只给预览页对比用
    horizontalDraft: {
        star: { dir: [0, 0, 1, 0], stops: [['0', '#4f8fff'], ['.5', '#7474fb'], ['1', '#9a4ff0']] },
        bevel: { dir: [0, 0, 1, 0], stops: [['0', '#2a66e2'], ['.5', '#4c44d6'], ['1', '#6a2fc8']] },
        tail: { dir: DOWN, stops: [['0', '#2459cf'], ['.55', '#3a7cf2'], ['1', '#2a62de']] },
        tailRight: { dir: DOWN, stops: [['0', '#5a2fc6'], ['.55', '#8458f0'], ['1', '#6a3ad8']] },
        bevelEdge: '#33309f',
        bevelHighlight: '#9fb4ff',
    },
};

/** 正式使用的「全部集合」配色；用户在预览页挑定后改这里 */
const ALL_SETS = 'horizontal';

/**
 * 星形里面的彩色区域怎么画（金边、暗边、宝珠、绶带各版都一样）：
 *   legacy：原来的画法。深色斜面是把外框缩小成 star(32.5) 画的，凹角是尖的；金边内侧在凹角却是圆的，
 *           两者之间露出一小块浅色三角。蓝紫版的明暗层还盖亮了金边内侧那道暗线
 *   A / B：彩色区域直接用金边那条轮廓 star(40) 填色，斜面线从这条轮廓等距往里收（同一路径、圆角描边、
 *           裁在星形里面），所以凹角、尖角处的宽度处处一样；明暗层压在暗线下面，不碰它
 *     A：保留原来那道细斜面线（左上亮、其余深）；蓝紫版的深色线左蓝右紫，跟着星形的渐变走
 *     B：去掉斜面线，彩色直接贴着暗线，和绶带同一种画法
 *   （两段斜面的 C 版用户 2026-11-05 否了）
 */
const FITS = ['legacy', 'A', 'B'];

/** 金边内侧往里收 inset 的一圈（圆角，裁在星形里面）：stroke 宽 2·inset，外半边被裁掉 */
const insetRing = (inset, attrs) =>
    `<path d="${star(40)}" fill="none" stroke-width="${f(inset * 2)}" stroke-linejoin="round" clip-path="url(#inside)" ${attrs}/>`;

/** 暗边在金边里面露出的那道线：暗边 9.5 宽、金边 7 宽，各取一半 → 从 3.5 到 4.75 */
const DARK_INNER = 9.5 / 2;

function fittedStar(p, fit) {
    const parts = [`<path d="${star(40)}" fill="url(#blueIn)"/>`];
    if (fit === 'A') {
        // 原来那道斜面线大约 1 个单位宽：深色描一圈（蓝紫版左蓝右紫），左上再叠一道浅色高光
        const edge = p.bevelEdgeSplit ? 'url(#edge)' : p.bevelEdge;
        parts.push(insetRing(DARK_INNER + 1.05, `stroke="${edge}" opacity=".95"`));
        parts.push(`<g clip-path="url(#tl)">${insetRing(DARK_INNER + 1, `stroke="${p.bevelHighlight}" opacity=".45"`)}</g>`);
    }
    if (p.shade) parts.push(`<path d="${star(40)}" fill="url(#shade)"/>`);
    parts.push(`<path d="${star(40)}" fill="none" stroke="${OUTLINE}" stroke-width="9.5" stroke-linejoin="round"/>`);
    parts.push(`<path d="${star(40)}" fill="none" stroke="url(#rim)" stroke-width="7" stroke-linejoin="round"/>`);
    return parts;
}

function legacyStar(p) {
    return [
        `<path d="${star(40)}" fill="url(#blue)" stroke="${OUTLINE}" stroke-width="9.5" stroke-linejoin="round"/>`,
        p.shade ? `<path d="${star(40)}" fill="url(#shade)"/>` : '',
        `<path d="${star(40)}" fill="none" stroke="url(#rim)" stroke-width="7" stroke-linejoin="round"/>`,
        `<path d="${star(32.5)}" fill="url(#blueIn)" stroke="${p.bevelEdge}" stroke-width="1" stroke-linejoin="round" opacity=".95"/>`,
        p.shade ? `<path d="${star(32.5)}" fill="url(#shade)"/>` : '',
        `<path d="${star(32.5)}" fill="none" stroke="${p.bevelHighlight}" stroke-width=".9" stroke-linejoin="round" opacity=".45" clip-path="url(#tl)"/>`,
    ];
}

function makeBadge(p, fit = 'legacy') {
    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 118">',
        '<defs>',
        // 奶金描边：左上亮、右下深，模拟顶光
        '<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">',
        '<stop offset="0" stop-color="#fff6d6"/><stop offset=".45" stop-color="#f7d77e"/><stop offset="1" stop-color="#d49b2c"/>',
        '</linearGradient>',
        gradient('blue', p.star),
        gradient('blueIn', p.bevel),
        gradient('tail', p.tail),
        p.tailRight ? gradient('tail2', p.tailRight) : '',
        p.shade ? gradient('shade', { dir: DOWN, stops: [['0', '#fff', '.14'], ['.5', '#fff', '0'], ['1', '#000', '.2']] }) : '',
        '<radialGradient id="orb" cx=".38" cy=".32" r=".75">',
        '<stop offset="0" stop-color="#ffe17a"/><stop offset=".5" stop-color="#fbb52a"/><stop offset="1" stop-color="#e08a0e"/>',
        '</radialGradient>',
        '<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">',
        '<stop offset="0" stop-color="#fffaf0"/><stop offset=".6" stop-color="#f6dc9c"/><stop offset="1" stop-color="#dcae55"/>',
        '</linearGradient>',
        `<clipPath id="orbClip"><circle cx="${CX}" cy="${CY}" r="15.2"/></clipPath>`,
        `<clipPath id="tl"><rect width="${CX}" height="${CY}"/></clipPath>`,
        fit === 'legacy' ? '' : `<clipPath id="inside"><path d="${star(40)}"/></clipPath>`,
        fit === 'A' && p.bevelEdgeSplit ? gradient('edge', p.bevelEdgeSplit) : '',
        '</defs>',

        // 绶带（先画，压在星形下面）：暗边 → 金边 → 蓝
        ...[false, true].map((mirror) => {
            const d = tail(mirror);
            const fill = mirror && p.tailRight ? 'tail2' : 'tail';
            return (
                `<path d="${d}" fill="url(#${fill})" stroke="${OUTLINE}" stroke-width="7" stroke-linejoin="round"/>` +
                `<path d="${d}" fill="none" stroke="url(#rim)" stroke-width="4.6" stroke-linejoin="round"/>`
            );
        }),

        // 八角星：彩色区域、暗边、奶金描边（画法见 FITS）
        ...(fit === 'legacy' ? legacyStar(p) : fittedStar(p, fit)),

        // 宝珠
        `<circle cx="${CX}" cy="${CY}" r="19.6" fill="${OUTLINE}" opacity=".55"/>`,
        `<circle cx="${CX}" cy="${CY}" r="19" fill="url(#ring)"/>`,
        `<circle cx="${CX}" cy="${CY}" r="15.6" fill="#b86d06" opacity=".55"/>`,
        `<circle cx="${CX}" cy="${CY}" r="15.2" fill="url(#orb)"/>`,
        `<path d="M${CX + 3} ${CY - 18}L${CX + 18} ${CY - 3}L${CX - 3} ${CY + 18}L${CX - 18} ${CY + 3}Z" fill="#ffd257" opacity=".42" clip-path="url(#orbClip)"/>`,
        `<path d="M${CX + 0.5} ${CY - 11.2}A11.2 11.2 0 0 1 ${CX + 10.4} ${CY - 3.6}" fill="none" stroke="#fff" stroke-width="2.8" stroke-linecap="round" opacity=".95"/>`,
        `<circle cx="${CX + 10.6}" cy="${CY + 1.4}" r="1.7" fill="#fff" opacity=".95"/>`,
        '</svg>',
    ].join('');
}

/**
 * 未达成 / 进行中灰态徽章（精铸暗银胚 · 空宝珠槽）：
 * 沿用 badge.svg 完全一致的八角星、双燕尾与宝珠环几何，换用冷暗银灰与深凹空宝珠槽，
 * 用于游戏页顶部概览条（MiniBar）、个人资料最近游玩及未完成成就集合；达成 100% 时在原地无缝点亮。
 */
function makeEmptyBadge(fit = 'A') {
    const s40 = star(40);
    const emptyOutline = '#181c24';
    const starParts = [`<path d="${s40}" fill="url(#body)"/>`];
    if (fit === 'A') {
        starParts.push(insetRing(DARK_INNER + 1.05, 'stroke="#232936" opacity=".95"'));
        starParts.push(`<g clip-path="url(#tl)">${insetRing(DARK_INNER + 1, 'stroke="#96a3ba" opacity=".38"')}</g>`);
    }
    starParts.push(`<path d="${s40}" fill="none" stroke="${emptyOutline}" stroke-width="9.5" stroke-linejoin="round" stroke-opacity=".85"/>`);
    starParts.push(`<path d="${s40}" fill="none" stroke="url(#rim)" stroke-width="6.8" stroke-linejoin="round"/>`);

    return [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 118">',
        '<defs>',
        '<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1">',
        '<stop offset="0" stop-color="#a8b4c8"/><stop offset=".5" stop-color="#7c879b"/><stop offset="1" stop-color="#535c6e"/>',
        '</linearGradient>',
        '<linearGradient id="body" x1="0" y1="0" x2="0" y2="1">',
        '<stop offset="0" stop-color="#4d5769"/><stop offset="1" stop-color="#313846"/>',
        '</linearGradient>',
        '<linearGradient id="tail" x1="0" y1="0" x2="0" y2="1">',
        '<stop offset="0" stop-color="#333b4a"/><stop offset=".55" stop-color="#495365"/><stop offset="1" stop-color="#2e3542"/>',
        '</linearGradient>',
        '<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">',
        '<stop offset="0" stop-color="#9ca8bc"/><stop offset=".6" stop-color="#6e798d"/><stop offset="1" stop-color="#4a5364"/>',
        '</linearGradient>',
        '<radialGradient id="socket" cx=".5" cy=".58" r=".62">',
        '<stop offset="0" stop-color="#171b24"/><stop offset=".68" stop-color="#202633"/><stop offset="1" stop-color="#303849"/>',
        '</radialGradient>',
        `<clipPath id="tl"><rect width="${CX}" height="${CY}"/></clipPath>`,
        `<clipPath id="inside"><path d="${s40}"/></clipPath>`,
        '</defs>',
        ...[false, true].map((mirror) => {
            const d = tail(mirror);
            return (
                `<path d="${d}" fill="url(#tail)" stroke="${emptyOutline}" stroke-width="7" stroke-linejoin="round" stroke-opacity=".85"/>` +
                `<path d="${d}" fill="none" stroke="url(#rim)" stroke-width="4.4" stroke-linejoin="round"/>`
            );
        }),
        ...starParts,
        `<circle cx="${CX}" cy="${CY}" r="19.5" fill="${emptyOutline}" opacity=".6"/>`,
        `<circle cx="${CX}" cy="${CY}" r="18.8" fill="url(#ring)"/>`,
        `<circle cx="${CX}" cy="${CY}" r="15.2" fill="url(#socket)"/>`,
        `<path d="M${CX - 10.5} ${CY + 8.5}A13.5 13.5 0 0 0 ${CX + 10.5} ${CY + 8.5}" fill="none" stroke="#8592a8" stroke-width="1.4" stroke-linecap="round" opacity=".32"/>`,
        '</svg>',
    ].join('');
}

/** 正式徽章的画法：A 带立体内线（默认），B 去掉内线（2026-11-05 用户定的，设置里可切换） */
const badge = makeBadge(PALETTES.base, 'A');
const badgeDlc = makeBadge(PALETTES.dlc, 'A');
const badgeAll = makeBadge(PALETTES[ALL_SETS], 'A');
const badgeEmpty = makeEmptyBadge('A');
const badgeFlat = makeBadge(PALETTES.base, 'B');
const badgeDlcFlat = makeBadge(PALETTES.dlc, 'B');
const badgeAllFlat = makeBadge(PALETTES[ALL_SETS], 'B');
const badgeEmptyFlat = makeEmptyBadge('B');

/* ══ 月桂枝（左侧，开口朝右，像一只「（」） ═══════════════════════════ */

function laurel() {
    // 主茎：二次贝塞尔，从下往上弯
    const P0 = [31, 97];
    const P1 = [-7, 50];
    const P2 = [31, 3];
    const at = (t) => [
        (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t ** 2 * P2[0],
        (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t ** 2 * P2[1],
    ];
    const tangent = (t) => [
        2 * (1 - t) * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]),
        2 * (1 - t) * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1]),
    ];

    /** 一片尖头叶子：从 (x,y) 出发，朝 angle 方向长 len */
    const leaf = ([x, y], angle, len, width) => {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const tip = [x + c * len, y + s * len];
        const mid = [x + c * len * 0.5, y + s * len * 0.5];
        const n = [-s * width, c * width];
        return (
            `M${f(x)} ${f(y)}` +
            `Q${f(mid[0] + n[0])} ${f(mid[1] + n[1])} ${f(tip[0])} ${f(tip[1])}` +
            `Q${f(mid[0] - n[0])} ${f(mid[1] - n[1])} ${f(x)} ${f(y)}Z`
        );
    };

    let leaves = '';
    const COUNT = 8;
    for (let i = 0; i < COUNT; i += 1) {
        const t = 0.06 + (i / (COUNT - 1)) * 0.84;
        const p = at(t);
        const [tx, ty] = tangent(t);
        const dir = Math.atan2(ty, tx); // 沿茎向上的方向
        const size = 1 - t * 0.3; // 越往上叶子越小
        // 外侧（左）与内侧（右）各一片，向上斜出
        leaves += leaf(p, dir - 0.7, 17 * size, 4.6 * size);
        leaves += leaf(p, dir + 0.5, 11 * size, 3.4 * size);
    }
    // 顶端一片
    const top = at(0.97);
    const [ttx, tty] = tangent(0.97);
    leaves += leaf(top, Math.atan2(tty, ttx), 11, 3);

    const stem = `M${P0.join(' ')}Q${P1.join(' ')} ${P2.join(' ')}`;
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 100">' +
        `<path d="${stem}" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>` +
        `<path d="${leaves}" fill="#fff"/>` +
        '</svg>'
    );
}

/* ══ 图标（单色蒙版） ═══════════════════════════════════════════════════ */

const trophy =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    // 杯身
    '<path d="M6.2 2.6h11.6v5.2a5.8 5.8 0 0 1-11.6 0z" fill="#fff"/>' +
    // 两侧把手
    '<path d="M6.4 4.4H3.9a2.6 2.6 0 0 0 0 5.2h2.9M17.6 4.4h2.5a2.6 2.6 0 0 1 0 5.2h-2.9" fill="none" stroke="#fff" stroke-width="1.7"/>' +
    // 杯柄 + 底座
    '<path d="M10.6 13.4h2.8v3.2h-2.8zM7.6 17.4h8.8a1 1 0 0 1 1 1v1.6H6.6v-1.6a1 1 0 0 1 1-1zM5.8 20.4h12.4v1.8H5.8z" fill="#fff"/>' +
    '</svg>';

const stopwatch =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">' +
    '<path d="M9.4 1.6h5.2v2.2H9.4z" fill="#fff"/>' +
    '<path d="M18.2 5.2l1.6-1.6 1.5 1.5-1.6 1.6z" fill="#fff"/>' +
    // 表盘（实心）+ 指针（镂空，evenodd）
    '<path fill="#fff" fill-rule="evenodd" d="M12 4.6a8.6 8.6 0 1 1 0 17.2a8.6 8.6 0 0 1 0-17.2zM11 8.2h2v6.2h-2z"/>' +
    '</svg>';

const sparkle =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20">' +
    '<path d="M10 0C10.9 6.2 13.8 9.1 20 10C13.8 10.9 10.9 13.8 10 20C9.1 13.8 6.2 10.9 0 10C6.2 9.1 9.1 6.2 10 0Z" fill="#fff"/>' +
    '</svg>';

/* ══ 库内卡片：穹光地平线星仪菱钻徽印（本体 / 全集合） ═══════════════ */

const hzCrestBase =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none">' +
    '<defs><linearGradient id="g" x1="4" y1="3" x2="32" y2="33" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#fff8d6"/><stop offset="0.52" stop-color="#f5ca64"/><stop offset="1" stop-color="#c98e26"/>' +
    '</linearGradient></defs>' +
    '<circle cx="18" cy="18" r="13.5" stroke="url(#g)" stroke-width="1" stroke-dasharray="16 6" opacity="0.78"/>' +
    '<path d="M18 2.2V5.4M18 30.6V33.8M2.2 18H5.4M30.6 18H33.8" stroke="#f7d582" stroke-width="1.1" stroke-linecap="round" opacity="0.85"/>' +
    '<path d="M18 7.5L20.5 15.5L28.5 18L20.5 20.5L18 28.5L15.5 20.5L7.5 18L15.5 15.5Z" fill="url(#g)"/>' +
    '<circle cx="18" cy="18" r="2.3" fill="#fffdf2"/>' +
    '</svg>';

const hzCrestAll =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" fill="none">' +
    '<defs>' +
    '<linearGradient id="g" x1="2" y1="2" x2="34" y2="34" gradientUnits="userSpaceOnUse">' +
    '<stop offset="0" stop-color="#ffe784"/><stop offset="0.45" stop-color="#74f2ca"/>' +
    '<stop offset="0.75" stop-color="#7eb8ff"/><stop offset="1" stop-color="#d886ff"/>' +
    '</linearGradient>' +
    '<radialGradient id="r" cx="50%" cy="50%" r="50%">' +
    '<stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#b4e8ff"/>' +
    '<stop offset="1" stop-color="#c884ff" stop-opacity="0"/>' +
    '</radialGradient>' +
    '</defs>' +
    '<circle cx="18" cy="18" r="14.5" stroke="url(#g)" stroke-width="1" stroke-dasharray="17 5 11 5" opacity="0.82"/>' +
    '<circle cx="18" cy="18" r="10.2" stroke="url(#g)" stroke-width="0.9" opacity="0.58"/>' +
    '<path d="M18 1.5V5M18 31V34.5M1.5 18H5M31 18H34.5" stroke="url(#g)" stroke-width="1.2" stroke-linecap="round"/>' +
    '<circle cx="18" cy="18" r="7.5" fill="url(#r)" opacity="0.5"/>' +
    '<path d="M18 6.8L20.4 15.6L29.2 18L20.4 20.4L18 29.2L15.6 20.4L6.8 18L15.6 15.6Z" fill="url(#g)"/>' +
    '<path d="M18 12.2L19.4 16.6L23.8 18L19.4 19.4L18 23.8L16.6 19.4L12.2 18L16.6 16.6Z" fill="#ffffff"/>' +
    '</svg>';

/* ══ 纹理：细噪点（纸张纤维 / 皮面颗粒） ═══════════════════════════════ */

const grain =
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">' +
    '<filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" stitchTiles="stitch"/>' +
    '<feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0"/></filter>' +
    '<rect width="160" height="160" filter="url(#n)"/>' +
    '</svg>';

/* ══ 输出 ═══════════════════════════════════════════════════════════════ */

const css = [
    '/* 由 achievement_improve/tools/make-art.mjs 生成，勿手改。 */',
    ':root {',
    `    --ac-badge-img: ${uri(badge)};`,
    `    --ac-badge-img-dlc: ${uri(badgeDlc)};`,
    `    --ac-badge-img-all: ${uri(badgeAll)};`,
    `    --ac-badge-img-empty: ${uri(badgeEmpty)};`,
    `    --ac-badge-img-flat: ${uri(badgeFlat)};`,
    `    --ac-badge-img-dlc-flat: ${uri(badgeDlcFlat)};`,
    `    --ac-badge-img-all-flat: ${uri(badgeAllFlat)};`,
    `    --ac-badge-img-empty-flat: ${uri(badgeEmptyFlat)};`,
    `    --ac-laurel: ${uri(laurel())};`,
    `    --ac-trophy: ${uri(trophy)};`,
    `    --ac-stopwatch: ${uri(stopwatch)};`,
    `    --ac-sparkle: ${uri(sparkle)};`,
    `    --ac-grain: ${uri(grain)};`,
    `    --ac-hz-crest-base: ${uri(hzCrestBase)};`,
    `    --ac-hz-crest-all: ${uri(hzCrestAll)};`,
    '}',
    '',
    '/* 设置「徽章立体内线」关闭：换成去掉内线的两枚（属性挂在根节点上，卡片、导出、引导里的徽章一起换） */',
    '[data-ac-badge-line="off"] {',
    "    --ac-badge-img: var(--ac-badge-img-flat);",
    "    --ac-badge-img-dlc: var(--ac-badge-img-dlc-flat);",
    "    --ac-badge-img-all: var(--ac-badge-img-all-flat);",
    "    --ac-badge-img-empty: var(--ac-badge-img-empty-flat);",
    '}',
    '',
].join('\n');

writeFileSync(OUT, css, 'utf8');
writeFileSync(path.join(HERE, 'badge.svg'), badge, 'utf8');

// 预览端的选型页（preview/badge-sets.html）要把每种配色都摆出来
const PREVIEW = path.join(HERE, '..', 'preview', 'assets', 'badge-palettes.css');
writeFileSync(
    PREVIEW,
    [
        '/* 由 tools/make-art.mjs 生成，勿手改。徽章各配色，只给预览选型页用。 */',
        ':root {',
        ...Object.keys(PALETTES).map((name) => `    --ac-badge-${name}: ${uri(makeBadge(PALETTES[name]))};`),
        // 贴合修正的几种画法，给 preview/badge-sets.html 对比用
        ...['base', 'horizontal'].flatMap((name) => FITS.filter((fit) => fit !== 'legacy').map((fit) => `    --ac-badge-${name}-${fit}: ${uri(makeBadge(PALETTES[name], fit))};`)),
        '}',
        '',
    ].join('\n'),
    'utf8',
);

console.log(`art.css ${css.length} B（徽章 ${badge.length} B）→ ${OUT}`);
