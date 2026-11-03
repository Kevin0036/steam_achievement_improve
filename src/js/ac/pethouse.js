/**
 * 成就小屋（桌宠联动，实验中）
 *
 * 装了桌宠插件时，收藏册最后一页「未完待续」换成桌宠住的小屋 ——
 * 一间「挖进书页里」的小房间：外圈露出一层层纸页的切口，里面是有透视的房间。
 *   · 后墙挂 Q 版相框：中间的大金框是最近打满的一款，旁边几张是更早的，最后留一个空框给下一款；
 *   · 相框下的搁板上摆三座奖杯：白金（完美通关款数）居中，金杯 / 银杯是全部卡片的稀有 / 普通成就合计；
 *   · 左墙一扇夜窗，月光斜照到地板上；天花板吊一盏暖灯；
 *   · 地毯上站着桌宠，点它会打招呼，偶尔自己整理一下小屋。
 *
 * 没装桌宠（book.js 没收到 petHouse 选项）时这一页保持「未完待续」原样。
 *
 * 形象素材不在收藏册里：由桌宠插件提供 sprites 地址（透明 webm）。
 * 预览里用 dsh-pet 的大肥鱼（CC BY-NC-SA 4.0），出处写进 README，不在页面上显示。
 *
 * 性能：房间外壳是一张静态 SVG；视频和白金杯的反光只在小屋这一页摊开时播放，翻走、窗口隐藏时停下。
 */

import { STR } from './strings.js';
import { artImage } from './cardview.js';

const SIDE_FRAMES = 4; // 大相框两边的小相框（含最后那个空框）
const TIDY_EVERY_MS = 28000; // 摊开着没人理时，隔一会儿自己整理一次小屋
const BUBBLE_MS = 3600;
const FRESH_MS = 2400;
const SVG_NS = 'http://www.w3.org/2000/svg';

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

function gradient(doc, id, stops, { x2 = 0, y2 = 1, x1 = 0, y1 = 0 } = {}) {
    const g = svgEl(doc, 'linearGradient', { id, x1, y1, x2, y2 });
    for (const [offset, color, opacity = 1] of stops) g.append(svgEl(doc, 'stop', { offset, 'stop-color': color, 'stop-opacity': opacity }));
    return g;
}

/** 卡片按完成时间从新到旧（没有日期的排最后），装订方式不影响小屋 */
function newestFirst(cards) {
    return [...cards].sort((a, b) => (Number(b.completedAt) || 0) - (Number(a.completedAt) || 0));
}

/* ── 房间外壳：viewBox 0..100 拉伸铺满，后墙是 x 11–89、y 8–60 的矩形 ───────── */

const BACK = { left: 11, right: 89, top: 8, bottom: 60 };

function roomShell(doc) {
    const svg = svgEl(doc, 'svg', { class: 'ac-house__shell', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const defs = svgEl(doc, 'defs');
    defs.append(
        gradient(doc, 'ac-house-ceil', [[0, '#3a2c24'], [1, '#5a4535']]),
        gradient(doc, 'ac-house-lwall', [[0, '#7d6650'], [1, '#a88d6e']], { x2: 1, y2: 0 }),
        gradient(doc, 'ac-house-rwall', [[0, '#a88d6e'], [1, '#7a634d']], { x2: 1, y2: 0 }),
        gradient(doc, 'ac-house-bwall', [[0, '#b99c79'], [1, '#d4bc98']]),
        gradient(doc, 'ac-house-floor', [[0, '#5e3f28'], [1, '#93643f']]),
        gradient(doc, 'ac-house-night', [[0, '#16213d'], [1, '#2d4372']]),
        gradient(doc, 'ac-house-beam', [[0, '#cfe0ff', 0.32], [1, '#cfe0ff', 0]], { x2: 1, y2: 1 }),
    );
    svg.append(defs);
    const { left: L, right: R, top: T, bottom: B } = BACK;
    const poly = (points, attrs) => svgEl(doc, 'polygon', { points, ...attrs });
    const line = (x1, y1, x2, y2, attrs) => svgEl(doc, 'line', { x1, y1, x2, y2, 'vector-effect': 'non-scaling-stroke', ...attrs });

    svg.append(
        poly(`0,0 100,0 ${R},${T} ${L},${T}`, { fill: 'url(#ac-house-ceil)' }),
        poly(`0,0 ${L},${T} ${L},${B} 0,100`, { fill: 'url(#ac-house-lwall)' }),
        poly(`100,0 ${R},${T} ${R},${B} 100,100`, { fill: 'url(#ac-house-rwall)' }),
        svgEl(doc, 'rect', { x: L, y: T, width: R - L, height: B - T, fill: 'url(#ac-house-bwall)' }),
        poly(`${L},${B} ${R},${B} 100,100 0,100`, { fill: 'url(#ac-house-floor)' }),
    );
    // 地板：木条往后墙收拢，横向接缝越往前越疏
    const planks = svgEl(doc, 'g', { stroke: 'rgba(40, 22, 10, 0.35)', 'stroke-width': 1 });
    for (let i = 1; i < 9; i += 1) planks.append(line(L + ((R - L) * i) / 9, B, (100 * i) / 9, 100));
    for (const y of [64.5, 71, 80.5]) {
        const t = (y - B) / (100 - B);
        planks.append(line(L * (1 - t), y, R + (100 - R) * t, y, { stroke: 'rgba(40, 22, 10, 0.18)' }));
    }
    svg.append(planks);
    // 踢脚线 + 墙角的暗缝
    svg.append(
        svgEl(doc, 'rect', { x: L, y: B - 2.2, width: R - L, height: 2.2, fill: '#6a4a33' }),
        poly(`0,95 ${L},${B - 2.2} ${L},${B} 0,100`, { fill: '#5a3e2a' }),
        poly(`100,95 ${R},${B - 2.2} ${R},${B} 100,100`, { fill: '#5a3e2a' }),
    );
    const seams = svgEl(doc, 'g', { stroke: 'rgba(30, 18, 10, 0.45)', 'stroke-width': 1.2 });
    seams.append(line(L, T, L, B), line(R, T, R, B), line(0, 0, L, T), line(100, 0, R, T), line(L, B, 0, 100), line(R, B, 100, 100));
    svg.append(seams);
    // 左墙的夜窗：透视里的梯形，窗框 + 十字窗棂 + 一钩月亮
    const win = svgEl(doc, 'g');
    win.append(
        poly('2.6,21 8.6,24.6 8.6,45 2.6,50', { fill: 'url(#ac-house-night)', stroke: '#5a3e2a', 'stroke-width': 3, 'vector-effect': 'non-scaling-stroke', 'stroke-linejoin': 'round' }),
        line(5.6, 22.8, 5.6, 47.5, { stroke: '#5a3e2a', 'stroke-width': 2 }),
        line(2.6, 36, 8.6, 35.6, { stroke: '#5a3e2a', 'stroke-width': 2 }),
        svgEl(doc, 'ellipse', { cx: 4.2, cy: 28, rx: 0.9, ry: 1.2, fill: '#f6e7b4' }),
        svgEl(doc, 'ellipse', { cx: 7.2, cy: 41, rx: 0.25, ry: 0.35, fill: '#fff', opacity: 0.8 }),
        svgEl(doc, 'ellipse', { cx: 3.8, cy: 43, rx: 0.2, ry: 0.3, fill: '#fff', opacity: 0.6 }),
    );
    svg.append(win);
    // 月光：从窗口斜照到地板上
    svg.append(poly('8.6,24.6 8.6,45 34,94 46,72', { fill: 'url(#ac-house-beam)' }));
    return svg;
}

/* ── Q 版奖杯：圆滚滚的杯身、短杯脚、胖把手 ──────────────────────────────── */

const CUP_METAL = {
    platinum: [[0, '#8e9fc4'], [0.32, '#f6f9ff'], [0.55, '#d3def4'], [1, '#7486b0']],
    gold: [[0, '#a8690f'], [0.32, '#ffe68f'], [0.55, '#f2b93c'], [1, '#93590c']],
    silver: [[0, '#7c848f'], [0.32, '#ffffff'], [0.55, '#cbd2da'], [1, '#6c747f']],
};

function trophy(doc, kind) {
    const id = `ac-house-cup-${kind}`;
    const svg = svgEl(doc, 'svg', { class: 'ac-house__cup-art', viewBox: '0 0 60 72', 'aria-hidden': 'true' });
    const defs = svgEl(doc, 'defs');
    defs.append(gradient(doc, id, CUP_METAL[kind], { x2: 1, y2: 0 }));
    const bowl = 'M11 12 H49 V21 C49 34 41 42 30 42 C19 42 11 34 11 21 Z';
    if (kind === 'platinum') {
        const clip = svgEl(doc, 'clipPath', { id: `${id}-clip` });
        clip.append(svgEl(doc, 'path', { d: bowl }));
        defs.append(clip);
    }
    svg.append(defs);
    const metal = `url(#${id})`;
    svg.append(
        svgEl(doc, 'path', { d: 'M13 16 C2 15 3 33 17 35', fill: 'none', stroke: metal, 'stroke-width': 5, 'stroke-linecap': 'round' }),
        svgEl(doc, 'path', { d: 'M47 16 C58 15 57 33 43 35', fill: 'none', stroke: metal, 'stroke-width': 5, 'stroke-linecap': 'round' }),
        svgEl(doc, 'path', { d: 'M26.5 41 H33.5 L35 50 H25 Z', fill: metal }),
        svgEl(doc, 'ellipse', { cx: 30, cy: 50, rx: 7.5, ry: 2.4, fill: metal }),
        svgEl(doc, 'path', { d: bowl, fill: metal }),
        svgEl(doc, 'ellipse', { cx: 30, cy: 12, rx: 19, ry: 3.4, fill: metal, stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 0.8 }),
        svgEl(doc, 'ellipse', { cx: 30, cy: 12.3, rx: 15.5, ry: 2.1, fill: 'rgba(0,0,0,0.22)' }),
        svgEl(doc, 'path', { d: 'M16 17 C16 27 19 34 24 38', fill: 'none', stroke: '#fff', 'stroke-opacity': 0.6, 'stroke-width': 2.2, 'stroke-linecap': 'round' }),
        svgEl(doc, 'rect', { x: 15, y: 52, width: 30, height: 12, rx: 3.5, fill: '#3b2a20' }),
        svgEl(doc, 'rect', { x: 15, y: 52, width: 30, height: 3, rx: 1.5, fill: '#5a4232' }),
        svgEl(doc, 'rect', { x: 21, y: 56.5, width: 18, height: 4.5, rx: 1.2, fill: metal }),
    );
    // 杯身上的徽记：白金是一颗星，金银是一个圆章
    if (kind === 'platinum') {
        svg.append(svgEl(doc, 'polygon', { points: '30,19 32.6,25 39,25.4 34,29.4 35.8,35.6 30,32 24.2,35.6 26,29.4 21,25.4 27.4,25', fill: '#ffffff', 'fill-opacity': 0.85, stroke: '#9fb0d6', 'stroke-width': 0.8 }));
        // 一道斜着扫过杯身的反光（CSS 只在小屋摊开时让它动）
        const shine = svgEl(doc, 'g', { 'clip-path': `url(#${id}-clip)` });
        shine.append(svgEl(doc, 'rect', { class: 'ac-house__shine', x: -14, y: 0, width: 9, height: 50, fill: '#fff', 'fill-opacity': 0.75, transform: 'skewX(-18)' }));
        svg.append(shine);
    } else {
        svg.append(
            svgEl(doc, 'circle', { cx: 30, cy: 26, r: 6, fill: 'none', stroke: '#fff', 'stroke-opacity': 0.7, 'stroke-width': 1.4 }),
            svgEl(doc, 'circle', { cx: 30, cy: 26, r: 2.4, fill: '#fff', 'fill-opacity': 0.7 }),
        );
    }
    return svg;
}

/* ── 小摆件：盆栽、一摞书 ───────────────────────────────────────────────── */

function plant(doc) {
    const svg = svgEl(doc, 'svg', { class: 'ac-house__plant', viewBox: '0 0 40 56', 'aria-hidden': 'true' });
    svg.append(
        svgEl(doc, 'ellipse', { cx: 13, cy: 20, rx: 7, ry: 13, fill: '#4f9a5b', transform: 'rotate(-28 13 20)' }),
        svgEl(doc, 'ellipse', { cx: 27, cy: 18, rx: 7, ry: 14, fill: '#5cad66', transform: 'rotate(24 27 18)' }),
        svgEl(doc, 'ellipse', { cx: 20, cy: 13, rx: 6.5, ry: 13, fill: '#6cc177' }),
        svgEl(doc, 'path', { d: 'M20 6 V30', stroke: '#3f7f49', 'stroke-width': 1.2 }),
        svgEl(doc, 'path', { d: 'M7 32 H33 L30 53 Q20 56 10 53 Z', fill: '#d9825b' }),
        svgEl(doc, 'rect', { x: 5, y: 29, width: 30, height: 6, rx: 3, fill: '#e99a72' }),
    );
    return svg;
}

function bookStack(doc) {
    const svg = svgEl(doc, 'svg', { class: 'ac-house__books', viewBox: '0 0 44 30', 'aria-hidden': 'true' });
    const books = [
        [4, 22, 36, 7, '#c4574f'],
        [7, 15, 30, 7, '#4d7fae'],
        [3, 8, 34, 7, '#e2b54f'],
    ];
    for (const [x, y, w, h, c] of books) {
        svg.append(
            svgEl(doc, 'rect', { x, y, width: w, height: h, rx: 1.6, fill: c }),
            svgEl(doc, 'rect', { x: x + w - 4, y: y + 1, width: 3, height: h - 2, rx: 0.6, fill: '#f4ead6' }),
        );
    }
    return svg;
}

/**
 * @param {Document} doc
 * @param {object} options
 * @param {Array} options.cards 收藏册里的卡片
 * @param {{ name?: string, sprites: Record<string, string>, lines?: string[] }} options.pet
 *        sprites 至少要有 idle；可选 wave / cheer / tidy / sleep
 * @returns {{ node: HTMLElement, setActive(on: boolean): void, refresh(cards: Array): void, celebrate(card: object): void, destroy(): void }}
 */
export function createPetHouse(doc, { cards, pet }) {
    const win = doc.defaultView;
    const name = pet.name || '桌宠';
    const sprites = pet.sprites || {};
    const lines = Array.isArray(pet.lines) && pet.lines.length ? pet.lines : STR.house.greet;

    // 外圈是纸页切口，room 是挖进去的房间
    const root = el(doc, 'div', 'ac-house', { role: 'group', 'aria-label': STR.house.pageAria });
    const room = el(doc, 'div', 'ac-house__room');
    room.append(roomShell(doc));

    const glow = el(doc, 'div', 'ac-house__glow', { 'aria-hidden': 'true' });
    const lamp = el(doc, 'div', 'ac-house__lamp', { 'aria-hidden': 'true' });
    lamp.append(el(doc, 'span', 'ac-house__lamp-cord'), el(doc, 'span', 'ac-house__lamp-shade'));

    const back = el(doc, 'div', 'ac-house__back');
    const gallery = el(doc, 'div', 'ac-house__gallery');
    const shelf = el(doc, 'div', 'ac-house__shelf');
    const cups = {};
    for (const kind of ['silver', 'platinum', 'gold']) {
        const cup = el(doc, 'div', `ac-house__cup ac-house__cup--${kind}`);
        const count = el(doc, 'span', 'ac-house__cup-count');
        cup.append(trophy(doc, kind), count);
        cups[kind] = { node: cup, count };
        shelf.append(cup);
    }
    shelf.append(el(doc, 'span', 'ac-house__plank', { 'aria-hidden': 'true' }));
    back.append(gallery, shelf);

    const rug = el(doc, 'div', 'ac-house__rug', { 'aria-hidden': 'true' });
    const shadow = el(doc, 'div', 'ac-house__shadow', { 'aria-hidden': 'true' });
    const books = bookStack(doc);
    const pot = plant(doc);

    const petBtn = el(doc, 'button', 'ac-house__pet', { type: 'button', 'aria-label': STR.house.petLabel(name) });
    const video = el(doc, 'video', 'ac-house__sprite', { muted: true, playsinline: true, preload: 'none', 'aria-hidden': 'true' });
    video.muted = true;
    petBtn.append(video);
    const bubble = el(doc, 'div', 'ac-house__bubble', { 'aria-live': 'polite' });

    room.append(glow, back, lamp, books, rug, shadow, pot, petBtn, bubble);

    // 门牌钉在纸页切口上
    const sign = el(doc, 'div', 'ac-house__sign');
    sign.append(el(doc, 'span', 'ac-house__sign-title', { text: STR.house.title }), el(doc, 'span', 'ac-house__sign-sub', { text: STR.house.signSub(name) }));

    root.append(room, sign);

    // ── 相框与奖杯 ──────────────────────────────────────────────────────────
    let featured = null;

    function frame(card, { big = false, tone = 0, tilt = 0 } = {}) {
        const node = el(doc, 'div', `ac-house__frame${big ? ' ac-house__frame--big' : ''}`, {
            'data-tone': String(tone),
            'data-empty': card ? null : true,
            title: card ? card.name : STR.house.nextSlot,
        });
        node.style.setProperty('--tilt', `${tilt}deg`);
        node.append(el(doc, 'span', 'ac-house__nail', { 'aria-hidden': 'true' }));
        const border = el(doc, 'span', 'ac-house__frame-border');
        const mat = el(doc, 'span', 'ac-house__frame-mat');
        if (card) mat.append(artImage(doc, [...(card.art?.capsule ?? []), ...(card.art?.hero ?? [])], 'ac-house__frame-img', card.name));
        else mat.append(el(doc, 'span', 'ac-house__frame-plus', { text: '+' }));
        border.append(mat);
        node.append(border);
        if (big && card) node.append(el(doc, 'span', 'ac-house__frame-star', { 'aria-hidden': 'true', text: '★' }));
        return node;
    }

    function refresh(nextCards) {
        const sorted = newestFirst(nextCards || []);
        gallery.replaceChildren();
        const side = sorted.slice(1, SIDE_FRAMES);
        const items = [...side, null]; // 最后一个空框留给下一款
        const tilts = [-3, 2.5, 3.2, -2.4];
        const left = el(doc, 'div', 'ac-house__col');
        const right = el(doc, 'div', 'ac-house__col');
        items.forEach((card, i) => (i % 2 === 0 ? left : right).append(frame(card, { tone: (i % 4) + 1, tilt: tilts[i % 4] })));
        featured = frame(sorted[0] ?? null, { big: true, tone: 0, tilt: 0 });
        gallery.append(left, featured, right);

        let gold = 0;
        let silver = 0;
        let goldKnown = false;
        let silverKnown = false;
        for (const card of sorted) {
            if (Number.isFinite(card.rare)) {
                gold += card.rare;
                goldKnown = true;
            }
            if (Number.isFinite(card.common)) {
                silver += card.common;
                silverKnown = true;
            }
        }
        const counts = { platinum: sorted.length, gold: goldKnown ? gold : null, silver: silverKnown ? silver : null };
        for (const [kind, value] of Object.entries(counts)) {
            cups[kind].count.textContent = value == null ? '—' : String(value);
            cups[kind].node.title = STR.house.cup[kind](value);
        }
    }
    refresh(cards);

    // ── 桌宠 ────────────────────────────────────────────────────────────────
    let active = false;
    let current = null; // 正在播的动作名
    let tidyTimer = 0;
    let bubbleTimer = 0;
    let freshTimer = 0;
    let lineIndex = 0;

    function play(action, { loop = false } = {}) {
        const src = sprites[action] || sprites.idle;
        if (!src) return;
        current = action;
        video.loop = loop;
        if (video.dataset.src !== src) {
            video.dataset.src = src;
            video.src = src;
        } else {
            video.currentTime = 0;
        }
        if (active) video.play().catch(() => {});
    }

    function idle() {
        play('idle', { loop: true });
    }

    video.addEventListener('ended', () => {
        if (current !== 'idle') idle();
    });

    function say(text) {
        if (!text) return;
        bubble.textContent = text;
        bubble.dataset.show = '';
        win.clearTimeout(bubbleTimer);
        bubbleTimer = win.setTimeout(() => delete bubble.dataset.show, BUBBLE_MS);
    }

    function scheduleTidy() {
        win.clearTimeout(tidyTimer);
        if (!active || !sprites.tidy) return;
        tidyTimer = win.setTimeout(() => {
            if (active && current === 'idle') play('tidy');
            scheduleTidy();
        }, TIDY_EVERY_MS);
    }

    petBtn.addEventListener('click', (event) => {
        event.stopPropagation(); // 别让书顺带翻页
        play(sprites.wave ? 'wave' : 'idle', { loop: !sprites.wave });
        say(lines[lineIndex % lines.length]);
        lineIndex += 1;
        scheduleTidy();
    });

    function onVisibility() {
        if (doc.hidden) video.pause();
        else if (active) video.play().catch(() => {});
    }
    doc.addEventListener('visibilitychange', onVisibility);

    function setActive(on) {
        on = !!on;
        if (on === active) return;
        active = on;
        root.toggleAttribute('data-active', on);
        if (on) {
            if (!current) idle();
            else video.play().catch(() => {});
            scheduleTidy();
        } else {
            video.pause();
            win.clearTimeout(tidyTimer);
        }
    }

    /** 新卡入册后：大相框换上新游戏、弹一下，桌宠庆祝 */
    function celebrate(card) {
        if (card) say(STR.house.cheer(card.name));
        if (sprites.cheer) play('cheer');
        if (featured) {
            featured.dataset.fresh = '';
            const node = featured;
            win.clearTimeout(freshTimer);
            freshTimer = win.setTimeout(() => delete node.dataset.fresh, FRESH_MS);
        }
    }

    function destroy() {
        win.clearTimeout(tidyTimer);
        win.clearTimeout(bubbleTimer);
        win.clearTimeout(freshTimer);
        doc.removeEventListener('visibilitychange', onVisibility);
        video.pause();
        video.removeAttribute('src');
        video.load();
    }

    return { node: root, setActive, refresh, celebrate, destroy };
}
