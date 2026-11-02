/**
 * 成就收藏册 · 年度之树
 *
 * 年份页的另一面：一棵随当年全成就款数生长的树。
 *   · 0 款也是一棵完整的小树（新芽）；每点亮一款，一个枝梢开花 / 染色；
 *   · 生长的分母是用户给这一年定的目标（设置里按年配置），不是固定的 32；
 *   · 树形按年份次序轮转 12 种（首年樱花，依次轮转），同一棵树每年长得一样；
 *   · 超过目标的款数不再长高，用「盈枝 +N」标在页眉下面。
 *
 * 只负责画页面，不知道翻页结构（树页放在哪一面由 book.js 决定）。
 */

import STR from './strings.js';
import { formatCardDate, formatHours } from './cardview.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** 十二种树：类型、色相、饱和度、亮度。名字在 STR.tree.types 里同序。 */
const TYPES = [
    { kind: 'flower', hue: 340, sat: 72, light: 84 },
    { kind: 'leaf', hue: 95, sat: 60, light: 58 },
    { kind: 'leaf', hue: 130, sat: 50, light: 50 },
    { kind: 'leaf', hue: 165, sat: 50, light: 52 },
    { kind: 'leaf', hue: 48, sat: 85, light: 58 },
    { kind: 'leaf', hue: 22, sat: 85, light: 55 },
    { kind: 'leaf', hue: 6, sat: 75, light: 48 },
    { kind: 'flower', hue: 275, sat: 55, light: 76 },
    { kind: 'flower', hue: 235, sat: 60, light: 76 },
    { kind: 'flower', hue: 200, sat: 20, light: 92 },
    { kind: 'flower', hue: 322, sat: 65, light: 78 },
    { kind: 'leaf', hue: 38, sat: 80, light: 55 },
];

const PETAL = {
    flower: 'M0 -1.7Q1.4 -.5 .8 1.3L0 .8L-.8 1.3Q-1.4 -.5 0 -1.7Z',
    leaf: 'M0 -2Q1.4 0 0 2Q-1.4 0 0 -2Z',
};

/** 参与取色的确定性伪随机（同一棵树每年一致） */
const noise = (i) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
};

let glowSeq = 0;

function el(doc, tag, className, attrs) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
        for (const [key, value] of Object.entries(attrs)) {
            if (value == null || value === false) continue;
            if (key === 'text') node.textContent = value;
            else node.setAttribute(key, value === true ? '' : String(value));
        }
    }
    return node;
}

function svgEl(doc, tag, attrs = {}) {
    const node = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    return node;
}

const fixed = (n) => (Math.round(n * 10) / 10).toFixed(1);

export function treeTypeName(index) {
    return STR.tree.types[((index % TYPES.length) + TYPES.length) % TYPES.length];
}

/** 画一棵树；返回 svg 与这一年的进度文案数据 */
function buildTree(doc, { index, target, games }) {
    const typeIndex = ((index % TYPES.length) + TYPES.length) % TYPES.length;
    const meta = TYPES[typeIndex];
    const kind = meta.kind;
    const depth = target > 32 ? 6 : 5;

    let seed = (typeIndex * 7 + 3) % 233280;
    const rnd = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
    };

    const branches = [];
    const mids = [];
    const tips = [];
    (function grow(x, y, angle, length, level) {
        const x2 = x + length * Math.sin(angle);
        const y2 = y - length * Math.cos(angle);
        branches.push([x, y, x2, y2, level]);
        if (level === depth - 1) mids.push([x2, y2]);
        if (level === depth) {
            tips.push([x2, y2, angle]);
            return;
        }
        const spread = 0.3 + rnd() * 0.25 + (index % 4) * 0.03;
        grow(x2, y2, angle - spread * (0.8 + rnd() * 0.4), length * (0.72 + rnd() * 0.08), level + 1);
        grow(x2, y2, angle + spread * (0.8 + rnd() * 0.4), length * (0.72 + rnd() * 0.08), level + 1);
    })(50, 112, 0, 24, 0);

    const count = games.length;
    const progress = Math.min(count, target);
    const over = Math.max(0, count - target);
    const ratio = Math.min(1, progress / target);
    const lit = Math.min(progress, tips.length);
    const scale = 0.74 + 0.26 * ratio;
    const stage = STR.tree.stages[kind][
        progress === 0 ? 0 : ratio < 0.25 ? 1 : ratio < 0.5 ? 2 : ratio < 0.75 ? 3 : ratio < 1 ? 4 : 5
    ];

    const color = (v) =>
        `hsl(${Math.round(meta.hue + (noise(v) - 0.5) * 12)} ${meta.sat}% ${Math.round(
            meta.light + (noise(v + 9) - 0.5) * 8,
        )}%)`;
    const leafEllipse = (x, y, r, rot, fill) =>
        svgEl(doc, 'ellipse', {
            cx: fixed(x),
            cy: fixed(y),
            rx: fixed(r),
            ry: fixed(r * 0.62),
            fill,
            transform: `rotate(${Math.round(rot)} ${fixed(x)} ${fixed(y)})`,
        });

    const glowId = `ac-tree-glow-${(glowSeq += 1)}`;
    const svg = svgEl(doc, 'svg', { viewBox: '-6 6 112 110', 'aria-hidden': 'true', focusable: 'false' });
    const defs = svgEl(doc, 'defs');
    const gradient = svgEl(doc, 'radialGradient', { id: glowId });
    gradient.append(
        svgEl(doc, 'stop', { offset: '0', 'stop-color': '#f3e2a8', 'stop-opacity': '0.9' }),
        svgEl(doc, 'stop', { offset: '1', 'stop-color': '#f3e2a8', 'stop-opacity': '0' }),
    );
    defs.append(gradient);
    svg.append(defs);
    svg.append(
        svgEl(doc, 'circle', {
            cx: '50',
            cy: '62',
            r: '42',
            fill: `url(#${glowId})`,
            opacity: fixed(0.04 + ratio * 0.1),
        }),
        svgEl(doc, 'ellipse', { cx: '50', cy: '113', rx: '36', ry: '3.4', fill: '#000', opacity: '0.35' }),
    );

    const litOrder = tips
        .map((_, i) => i)
        .sort((a, b) => noise(a + index * 40) - noise(b + index * 40))
        .slice(0, lit);
    const litAt = new Map(litOrder.map((tip, i) => [tip, games[i]]));

    const canopy = svgEl(doc, 'g', {
        transform: `translate(50 112) scale(${scale.toFixed(3)}) translate(-50 -112)`,
    });

    for (const [x, y, x2, y2, level] of branches) {
        canopy.append(
            svgEl(doc, 'line', {
                x1: fixed(x),
                y1: fixed(y),
                x2: fixed(x2),
                y2: fixed(y2),
                stroke: '#6f6050',
                'stroke-width': ((6 - level) * 0.55 + 0.4).toFixed(2),
                'stroke-linecap': 'round',
            }),
        );
    }

    // 常驻的绿叶：没点亮的枝梢也有一树叶子，0 款不是光秃秃的枯枝
    mids.forEach(([x, y], j) => {
        for (let k = 0; k < 2; k += 1) {
            canopy.append(
                leafEllipse(
                    x + (noise(j * 5 + k) - 0.5) * 5,
                    y + (noise(j * 5 + k + 2) - 0.5) * 5,
                    2.6,
                    noise(j + k) * 180,
                    `hsl(128 30% ${Math.round(24 + noise(j + k * 3) * 10)}%)`,
                ),
            );
        }
    });
    tips.forEach(([x, y], j) => {
        for (let k = 0; k < 4; k += 1) {
            canopy.append(
                leafEllipse(
                    x + (noise(j * 9 + k) - 0.5) * 7,
                    y + (noise(j * 9 + k + 3) - 0.5) * 7,
                    2.8 + noise(j + k) * 0.8,
                    noise(j * 3 + k) * 180,
                    `hsl(${Math.round(126 + noise(j + k) * 10)} 32% ${Math.round(26 + noise(j * 2 + k) * 10)}%)`,
                ),
            );
        }
    });

    // 点亮的枝梢：樱花 / 紫藤这类开花，其余换成一簇彩叶
    for (const [tipIndex, game] of litAt) {
        const [x, y] = tips[tipIndex];
        const playHours = Number(game?.playtimeMin) > 0 ? Number(game.playtimeMin) / 60 : 0;
        const bloom = 0.85 + Math.min(1, playHours / 120) * 0.45;
        const group = svgEl(doc, 'g');
        const label = game
            ? STR.tree.game(game.name, formatCardDate(game.completedAt), formatHours(game.playtimeMin))
            : null;
        if (label) {
            const title = svgEl(doc, 'title');
            title.textContent = label;
            group.append(title);
        }
        if (kind === 'flower') {
            for (let k = 0; k < 7; k += 1) {
                const angle = noise(tipIndex * 13 + k) * 6.28;
                const dist = noise(tipIndex * 7 + k + 1) * 3.6 * bloom;
                group.append(
                    svgEl(doc, 'circle', {
                        cx: fixed(x + Math.cos(angle) * dist),
                        cy: fixed(y + Math.sin(angle) * dist),
                        r: fixed((1.3 + noise(tipIndex + k) * 0.8) * bloom),
                        fill: color(tipIndex * 7 + k),
                    }),
                );
            }
            group.append(svgEl(doc, 'circle', { cx: fixed(x), cy: fixed(y), r: '0.7', fill: '#fff6d8', opacity: '0.9' }));
        } else {
            for (let k = 0; k < 5; k += 1) {
                group.append(
                    leafEllipse(
                        x + (noise(tipIndex * 11 + k) - 0.5) * 6 * bloom,
                        y + (noise(tipIndex * 5 + k + 4) - 0.5) * 6 * bloom,
                        (2.4 + noise(tipIndex + k) * 0.8) * bloom,
                        noise(tipIndex * 7 + k) * 180,
                        color(tipIndex * 5 + k),
                    ),
                );
            }
        }
        canopy.append(group);
    }
    svg.append(canopy);

    // 树下的落叶
    for (let k = 0; k < Math.min(34, lit); k += 1) {
        svg.append(
            svgEl(doc, 'ellipse', {
                cx: fixed(28 + noise(k + 300) * 44),
                cy: fixed(110 + noise(k + 310) * 3.5),
                rx: '1.3',
                ry: '0.7',
                fill: color(k + 400),
                opacity: '0.85',
            }),
        );
    }

    // 飘落的花瓣 / 叶子：外层下落，内层摇摆
    const scaled = ([x, y]) => [50 + (x - 50) * scale, 112 + (y - 112) * scale];
    const petalCount =
        lit < 3 ? 0 : Math.min(44, Math.round(((lit - 2) / Math.max(1, Math.min(target, tips.length) - 2)) * 44));
    if (petalCount > 0) {
        const air = svgEl(doc, 'g', { class: 'ac-tree__air' });
        for (let k = 0; k < petalCount; k += 1) {
            const [tx, ty] = scaled(tips[litOrder[k % litOrder.length]]);
            const x0 = tx + (noise(k + 60) - 0.5) * 6;
            const y0 = ty + (noise(k + 70) - 0.5) * 4;
            const duration = 7 + noise(k + 80) * 7;
            const fall = svgEl(doc, 'g', { class: 'ac-tree__fall' });
            fall.setAttribute(
                'style',
                `--ac-dx:${(8 + noise(k + 100) * 26).toFixed(0)}px;` +
                    `--ac-dy:${(111 - y0 + (noise(k + 90) - 0.5) * 3).toFixed(0)}px;` +
                    `--ac-rot:${(200 + noise(k + 110) * 400).toFixed(0)}deg;` +
                    `animation-duration:${duration.toFixed(1)}s;animation-delay:-${(noise(k + 120) * duration).toFixed(1)}s`,
            );
            const sway = svgEl(doc, 'g', { class: 'ac-tree__sway' });
            sway.setAttribute(
                'style',
                `animation-duration:${(2 + noise(k + 130) * 2).toFixed(1)}s;` +
                    `animation-delay:-${(noise(k + 140) * 3).toFixed(1)}s`,
            );
            sway.append(
                svgEl(doc, 'path', {
                    d: PETAL[kind],
                    fill: color(k + 200),
                    opacity: '0.9',
                }),
            );
            fall.append(sway);
            const anchor = svgEl(doc, 'g', { transform: `translate(${fixed(x0)} ${fixed(y0)})` });
            anchor.append(fall);
            air.append(anchor);
        }
        svg.append(air);
    }

    return { svg, kind, name: treeTypeName(typeIndex), stage, lit: progress, over, target, count };
}

/* ── 入口 ───────────────────────────────────────────────────────────────── */

/**
 * 一张年度之树页面。
 *
 * @param {Document} doc
 * @param {object} options
 * @param {string} options.yearKey
 * @param {string} options.year 页眉上显示的年份
 * @param {Array} options.games 这一年的全成就游戏
 * @param {number} options.target 这一年用户定的目标款数
 * @param {number} options.index 这一年是册子里的第几个年份（决定树的种类）
 */
export function createTreePage(doc, { yearKey, year, games = [], target = 12, index = 0 }) {
    const goal = Math.max(1, Math.round(Number(target)) || 12);
    const tree = buildTree(doc, { index, target: goal, games });
    const status = tree.over > 0 ? STR.tree.over(tree.over) : tree.stage;

    const root = el(doc, 'div', 'ac-year ac-tree', {
        'data-year': String(yearKey),
        'data-kind': tree.kind,
        role: 'img',
        'aria-label': STR.tree.aria(year, tree.name, tree.lit, goal, status),
    });
    const page = el(doc, 'div', 'ac-year__page ac-tree__page');

    const head = el(doc, 'div', 'ac-year__head');
    head.append(
        el(doc, 'span', 'ac-year__head-kicker', { text: STR.tree.eyebrow }),
        el(doc, 'i', 'ac-year__head-rule', { 'aria-hidden': 'true' }),
        el(doc, 'span', 'ac-year__head-tag', { text: String(year) }),
    );
    const title = el(doc, 'div', 'ac-tree__title', { text: STR.tree.title });
    const sub = el(doc, 'div', 'ac-tree__sub');
    sub.append(
        el(doc, 'span', 'ac-tree__name', { text: tree.name }),
        el(doc, 'i', 'ac-tree__sep', { 'aria-hidden': 'true', text: '·' }),
        el(doc, 'span', 'ac-tree__lit', { text: STR.tree.lit(tree.lit, goal) }),
        el(doc, 'i', 'ac-tree__sep', { 'aria-hidden': 'true', text: '·' }),
    );
    // 行尾的状态签：超出目标是「盈枝 +N」，正好满树 / 尚未长成时写阶段名
    sub.append(
        el(doc, 'em', tree.over > 0 ? 'ac-tree__over' : tree.lit >= goal ? 'ac-tree__done' : 'ac-tree__stage', {
            text: status,
        }),
    );

    const art = el(doc, 'div', 'ac-tree__art');
    art.append(tree.svg);
    page.append(head, title, sub, art);
    root.append(page);
    return root;
}
