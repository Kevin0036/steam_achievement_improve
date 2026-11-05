/**
 * 生成主题用到的全部矢量图，输出为 src/css/ac/art.css（自动生成，勿手改）。
 *
 *   --ac-badge-img     「完美通关」徽章（彩色，直接当 background-image 用）
 *   --ac-badge-img-all 同一枚徽章的蓝紫渐变版：本体和所有 DLC 成就集合都全成就
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
        bevelHighlight: '#7fb2ff',
        shade: true,
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

function makeBadge(p) {
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

        // 八角星：暗边 → 奶金描边 → 蓝主体 → 内斜面
        `<path d="${star(40)}" fill="url(#blue)" stroke="${OUTLINE}" stroke-width="9.5" stroke-linejoin="round"/>`,
        p.shade ? `<path d="${star(40)}" fill="url(#shade)"/>` : '',
        `<path d="${star(40)}" fill="none" stroke="url(#rim)" stroke-width="7" stroke-linejoin="round"/>`,
        `<path d="${star(32.5)}" fill="url(#blueIn)" stroke="${p.bevelEdge}" stroke-width="1" stroke-linejoin="round" opacity=".95"/>`,
        p.shade ? `<path d="${star(32.5)}" fill="url(#shade)"/>` : '',
        `<path d="${star(32.5)}" fill="none" stroke="${p.bevelHighlight}" stroke-width=".9" stroke-linejoin="round" opacity=".45" clip-path="url(#tl)"/>`,

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

const badge = makeBadge(PALETTES.base);
const badgeAll = makeBadge(PALETTES[ALL_SETS]);

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
    `    --ac-badge-img-all: ${uri(badgeAll)};`,
    `    --ac-laurel: ${uri(laurel())};`,
    `    --ac-trophy: ${uri(trophy)};`,
    `    --ac-stopwatch: ${uri(stopwatch)};`,
    `    --ac-sparkle: ${uri(sparkle)};`,
    `    --ac-grain: ${uri(grain)};`,
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
        '}',
        '',
    ].join('\n'),
    'utf8',
);

console.log(`art.css ${css.length} B（徽章 ${badge.length} B）→ ${OUT}`);
