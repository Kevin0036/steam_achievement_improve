/**
 * 生成卡片外面的整页边框：src/css/ac/albumframes.css
 *
 * 用法：node tools/make-album-frames.mjs
 *
 * 单卡和四卡共用同一张图：四张卡整组和单卡的大小几乎一样。框画在
 * .ac-page__paper::before 上（规则见 book.css），不是每张卡各画一圈，所以不会互相压住。
 * 边框是内联 SVG：插件把 CSS 拼成一个文件，放不了独立的图片。
 *
 * 画布 610 × 820，1cqh = 10 单位，对应 book.css 的 61cqh × 82cqh。
 * 卡片占 (41, 41) 到 (569, 779)，单卡的深色内衬再往外 9 单位，
 * 所以装饰都画在外圈 31 单位以内，不会压到卡片。
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 610;
const H = 820;
const CX = W / 2;

const round = (value) => Math.round(value * 100) / 100;

function seeded(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/** 四角星 */
function sparkle(x, y, r, attrs = '') {
    const k = r * 0.16;
    const p = [
        [x, y - r], [x + k, y - k], [x + r, y], [x + k, y + k],
        [x, y + r], [x - k, y + k], [x - r, y], [x - k, y - k],
    ];
    return `<path d='M${p.map(([a, b]) => `${round(a)} ${round(b)}`).join('L')}Z' ${attrs}/>`;
}

/* ── 原版：集邮册的印刷框 ─────────────────────────────────────────────── */

function notched(inset, r) {
    const [x0, y0, x1, y1] = [inset, inset, W - inset, H - inset];
    return `M${x0 + r} ${y0}H${x1 - r}A${r} ${r} 0 0 0 ${x1} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 0 ${x1 - r} ${y1}H${x0 + r}A${r} ${r} 0 0 0 ${x0} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 0 ${x0 + r} ${y0}Z`;
}

function gridFrame() {
    const diamond = (x, y, r) => `<path d='M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z'/>`;
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>
<g fill='none' stroke='#fff'>
<path d='${notched(10, 16)}' stroke-opacity='.18' stroke-width='1.4'/>
<path d='${notched(19, 12)}' stroke-opacity='.09' stroke-width='1'/>
</g>
<g fill='#fff' fill-opacity='.28'>
${diamond(CX, 10, 6)}${diamond(CX, H - 10, 6)}${diamond(10, H / 2, 6)}${diamond(W - 10, H / 2, 6)}
</g>
<g fill='#fff' fill-opacity='.16'>
<circle cx='31' cy='31' r='2.4'/><circle cx='${W - 31}' cy='31' r='2.4'/><circle cx='31' cy='${H - 31}' r='2.4'/><circle cx='${W - 31}' cy='${H - 31}' r='2.4'/>
</g>
</svg>`;
}

/* ── 墨点手账：手绘墨线 + 点线 + 纸胶带 ───────────────────────────────── */

/** 手画的直线：每隔一段轻轻偏一点，别太规整 */
function inkLine(x1, y1, x2, y2, seed) {
    const random = seeded(seed);
    const length = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(2, Math.round(length / 90));
    const [nx, ny] = [-(y2 - y1) / length, (x2 - x1) / length];
    let d = `M${x1} ${y1}`;
    for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        const mid = (i - 0.5) / steps;
        const wobble = (random() - 0.5) * 2.6;
        const qx = x1 + (x2 - x1) * mid + nx * wobble;
        const qy = y1 + (y2 - y1) * mid + ny * wobble;
        d += `Q${round(qx)} ${round(qy)} ${round(x1 + (x2 - x1) * t)} ${round(y1 + (y2 - y1) * t)}`;
    }
    return d;
}

function washiTape(x, y, width, height, seed) {
    const random = seeded(seed);
    const tooth = height / 5;
    const left = [];
    const right = [];
    for (let i = 0; i <= 5; i += 1) {
        const offset = i % 2 ? 2.4 + random() : 0;
        left.push(`${round(x + offset)} ${round(y + i * tooth)}`);
        right.push(`${round(x + width - offset)} ${round(y + i * tooth)}`);
    }
    return `M${right.join('L')}L${left.reverse().join('L')}Z`;
}

function dotsFrame() {
    const ink = '#ffeed0';
    const lines = [
        inkLine(2, 16, W - 2, 15, 11),
        inkLine(3, H - 16, CX - 46, H - 15, 23),
        inkLine(CX + 46, H - 16, W - 3, H - 15, 29),
        inkLine(16, 2, 15, H - 2, 37),
        inkLine(W - 16, 3, W - 15, H - 3, 53),
    ].join('');
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>
<defs><pattern id='s' width='7' height='7' patternUnits='userSpaceOnUse' patternTransform='rotate(38)'><rect width='7' height='7' fill='#c9a25e'/><rect width='3' height='7' fill='#e2c48a'/></pattern></defs>
<path d='${lines}' fill='none' stroke='${ink}' stroke-opacity='.5' stroke-width='1.5' stroke-linecap='round'/>
<rect x='28' y='28' width='${W - 56}' height='${H - 56}' fill='none' stroke='${ink}' stroke-opacity='.42' stroke-width='2.6' stroke-linecap='round' stroke-dasharray='0 10'/>
<path d='${washiTape(CX - 74, 4, 148, 25, 7)}' fill='url(#s)' fill-opacity='.62' transform='rotate(-1.6 ${CX} 16)'/>
<g fill='${ink}' fill-opacity='.72'>
${sparkle(CX, H - 15, 12)}${sparkle(CX - 27, H - 15, 6.5)}${sparkle(CX + 27, H - 15, 6.5)}
</g>
</svg>`;
}

/* ── 星图：刻度环 + 星盘弧线 + 月相 ───────────────────────────────────── */

/** 月相：lit 是亮面比例，waning 时亮面在左 */
function moon(x, y, r, lit, waning) {
    const rx = round(r * Math.abs(1 - 2 * lit));
    const sweep = lit < 0.5 ? 0 : 1;
    const body = `<circle cx='${x}' cy='${y}' r='${r}' fill='none' stroke='#d6b77a' stroke-opacity='.6' stroke-width='.9'/>`;
    if (lit >= 1) return `<circle cx='${x}' cy='${y}' r='${r}' fill='#ecd6a0'/>`;
    const flip = waning ? ` transform='translate(${2 * x} 0) scale(-1 1)'` : '';
    return `${body}<path d='M${x} ${y - r}A${r} ${r} 0 0 1 ${x} ${y + r}A${rx} ${r} 0 0 ${sweep} ${x} ${y - r}Z' fill='#ecd6a0'${flip}/>`;
}

function astralFrame() {
    const gold = '#d6b77a';
    const ticks = [];
    const edge = 17;
    const span = 8;
    for (let x = 40; x <= W - 40; x += 10) {
        const long = (x - CX) % 50 === 0;
        const size = long ? span + 5 : span;
        ticks.push(`M${x} ${edge}v${size}M${x} ${H - edge}v${-size}`);
    }
    for (let y = 40; y <= H - 40; y += 10) {
        const long = (y - H / 2) % 50 === 0;
        const size = long ? span + 5 : span;
        ticks.push(`M${edge} ${y}h${size}M${W - edge} ${y}h${-size}`);
    }
    const arc = (cx, cy, r, sx, sy) => `M${cx + r * sx} ${cy}A${r} ${r} 0 0 ${sx * sy > 0 ? 1 : 0} ${cx} ${cy + r * sy}`;
    const corners = [[8, 8, 1, 1], [W - 8, 8, -1, 1], [8, H - 8, 1, -1], [W - 8, H - 8, -1, -1]];
    const arcs = corners.flatMap(([x, y, sx, sy]) => [14, 22, 30].map((r) => arc(x, y, r, sx, sy))).join('');
    const phases = [
        [-66, 0.14, false], [-44, 0.5, false], [-22, 0.84, false], [0, 1, false],
        [22, 0.84, true], [44, 0.5, true], [66, 0.14, true],
    ];
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>
<defs><mask id='m'><rect width='${W}' height='${H}' fill='#fff'/><rect x='${CX - 86}' width='172' height='36' fill='#000'/><rect x='${CX - 34}' y='${H - 36}' width='68' height='36' fill='#000'/></mask></defs>
<g fill='none' stroke='${gold}' mask='url(#m)'>
<rect x='8' y='8' width='${W - 16}' height='${H - 16}' stroke-opacity='.62' stroke-width='1.3'/>
<rect x='17' y='17' width='${W - 34}' height='${H - 34}' stroke-opacity='.3' stroke-width='.8'/>
<path d='${ticks.join('')}' stroke-opacity='.34' stroke-width='.8'/>
</g>
<path d='${arcs}' fill='none' stroke='${gold}' stroke-opacity='.5' stroke-width='.9'/>
<g fill='#f3e3b8'>${corners.map(([x, y, sx, sy]) => sparkle(x + 7 * sx, y + 7 * sy, 8)).join('')}</g>
${phases.map(([dx, lit, waning]) => moon(CX + dx, 19, dx === 0 ? 8 : 6.4, lit, waning)).join('')}
<circle cx='${CX}' cy='${H - 19}' r='11' fill='none' stroke='${gold}' stroke-opacity='.5' stroke-width='.9'/>
<g fill='#f3e3b8'>${sparkle(CX, H - 19, 15)}</g>
<g fill='${gold}' fill-opacity='.7'>${sparkle(CX, H - 19, 9, `transform='rotate(45 ${CX} ${H - 19})'`)}</g>
</svg>`;
}

/* ── 丝绒展柜：黄铜展盘 ───────────────────────────────────────────────── */

function bracket(x, y, sx, sy) {
    const a = 58;
    const b = 15;
    const path = `M${x} ${y}h${a * sx}v${b * sy}h${(b - a) * sx}v${(a - b) * sy}h${-b * sx}Z`;
    const rivet = (rx, ry) => `<circle cx='${rx}' cy='${ry}' r='3.4' fill='url(#r)' stroke='#4a3a1a' stroke-width='.7'/>`;
    return `<path d='${path}' fill='url(#b)' stroke='#5d4a22' stroke-width='.9'/>${rivet(x + 8 * sx, y + 8 * sy)}${rivet(x + (a - 8) * sx, y + 7.5 * sy)}${rivet(x + 7.5 * sx, y + (a - 8) * sy)}`;
}

function velvetFrame() {
    const m = 5;
    const plate = 244;
    const px = CX - plate / 2;
    const py = H - 33;
    return `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${W} ${H}' preserveAspectRatio='none'>
<defs>
<linearGradient id='b' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='#f1dca6'/><stop offset='.32' stop-color='#c5a163'/><stop offset='.6' stop-color='#8d7038'/><stop offset='1' stop-color='#d9bb74'/></linearGradient>
<radialGradient id='t' cx='.42' cy='.36' r='.8'><stop offset='0' stop-color='#0d3a30'/><stop offset='1' stop-color='#061e19'/></radialGradient>
<radialGradient id='r' cx='.35' cy='.3' r='.8'><stop offset='0' stop-color='#fff1c8'/><stop offset='.55' stop-color='#b4935a'/><stop offset='1' stop-color='#5d4a22'/></radialGradient>
</defs>
<rect x='${m}' y='${m}' width='${W - 2 * m}' height='${H - 2 * m}' rx='13' fill='url(#t)' stroke='url(#b)' stroke-width='5'/>
<rect x='${m + 7}' y='${m + 7}' width='${W - 2 * m - 14}' height='${H - 2 * m - 14}' rx='8' fill='none' stroke='#000' stroke-opacity='.45' stroke-width='3'/>
<rect x='${m + 10}' y='${m + 10}' width='${W - 2 * m - 20}' height='${H - 2 * m - 20}' rx='6' fill='none' stroke='#c5a163' stroke-opacity='.45' stroke-width='.9'/>
${bracket(3, 3, 1, 1)}${bracket(W - 3, 3, -1, 1)}${bracket(3, H - 3, 1, -1)}${bracket(W - 3, H - 3, -1, -1)}
<rect x='${px}' y='${py}' width='${plate}' height='24' rx='3' fill='url(#b)' stroke='#5d4a22' stroke-width='.9'/>
<rect x='${px + 4}' y='${py + 4}' width='${plate - 8}' height='16' rx='1.5' fill='none' stroke='#5d4a22' stroke-opacity='.55' stroke-width='.7'/>
<text x='${CX}' y='${py + 16}' text-anchor='middle' font-family='Georgia,serif' font-size='10' font-weight='700' letter-spacing='2.2' fill='#3b2d12'>ACHIEVEMENT COLLECTION</text>
</svg>`;
}

/* ── 输出 ─────────────────────────────────────────────────────────────── */

function dataUri(svg) {
    const body = svg
        .replace(/\n/g, '')
        .replace(/%/g, '%25')
        .replace(/#/g, '%23')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E');
    return `url("data:image/svg+xml,${body}")`;
}

const css = `/* ============================================================================
 * 成就收藏册 · 卡片外面的整页边框
 * ----------------------------------------------------------------------------
 * 这个文件由 tools/make-album-frames.mjs 生成，不要手改。
 * ==========================================================================*/

/* .rm-root：开册转场里克隆的书页在册子外面，也要拿到边框 */
.ac-cardpack,
.rm-root {
    --ac-frame: ${dataUri(gridFrame())};
}

.ac-cardpack[data-album="dots"] {
    --ac-frame: ${dataUri(dotsFrame())};
}

.ac-cardpack[data-album="astral"] {
    --ac-frame: ${dataUri(astralFrame())};
}

.ac-cardpack[data-album="velvet"] {
    --ac-frame: ${dataUri(velvetFrame())};
}
`;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(root, '..', 'millennium', 'themes', 'AchievementCollection', 'src', 'css', 'ac', 'albumframes.css');
writeFileSync(output, css, 'utf8');
console.log(`[album-frames] ${output}  ${(Buffer.byteLength(css) / 1024).toFixed(1)} KB`);
