/**
 * 徽章翻新。用在本体早就全成就、后来出了 DLC 成就集合的游戏上：玩家把 DLC 集合也打通之后，
 * 这张卡从卡槽里再拿起来一次，一颗颗紫色光球（新拿到的 DLC 成就）从卡片四周汇进蓝徽章，
 * 每汇入一颗，底下的金杯、银杯就往上涨一格，紫色从宝珠中心向外漫开；
 * 最后一颗汇入时徽章变成左蓝右紫，在手里端详一下，再放回卡槽。
 *
 * 设计前提和入册一样（见 introfx.js）：演出只发生在这张卡附近。不闪屏、不罩彩色遮罩，
 * 书页压暗聚焦、放回去时书轻轻一沉这类柔和的反馈照旧保留。
 *
 * 舞台（替身卡、遮罩、身后的光）由 book.js 的 refit() 搭好，从 env 传进来：
 *   { doc, book, play, pose, mover, shadow, flipper, sheen, veil, burst, addExtra,
 *     size, target, slot, cx, cy, u,
 *     badge  替身卡上的徽章节点；fill  叠在徽章上的新徽章（clip-path 从宝珠中心扩开）；
 *     ghost  替身卡的 .ac-card；orb  宝珠中心相对卡槽中心的偏移 {dx, dy} 和宝珠半径 r（都是未缩放的像素）；
 *     rule / setsRule  杯数上方的细线和叠在它上面藏着的「全集合 日期」那一行（没有全集合日期时 setsRule 为 null）；
 *     timeline  upgradeTimeline() 的结果；onAbsorb(k)  第 k 颗光球汇入，返回这一下数字变了的统计格 }
 * 光球画在 canvas 上（和闪电、火焰同一块画布），位置按时间直接算出来，掉帧也不会走样。
 */

import { createFxCanvas } from './introfx.js';

/** 拿在手里时比卡槽大多少；单页四张时卡槽很小，至少放大到书高的这么多，杯数才看得清 */
const HOLD_SCALE = 1.14;
const HOLD_MIN_HEIGHT = 0.62;
/** 从卡槽拿到书中央 */
const LIFT = 900;
/** 光球最早在什么时候冒出来（卡已经拿稳了） */
const FIRST_BIRTH = 950;
/** 第一颗和最后一颗汇入的时刻：越到后面来得越密，像在蓄力 */
const FIRST_ARRIVAL = 1900;
const LAST_ARRIVAL = 3750;
/** 光球冒出来到开始被吸过去的那一小段 */
const APPEAR = 260;
const MAX_TRAVEL = 980;
/** 全部汇入后端详多久、放回去多久、落定后收尾多久 */
const ADMIRE = 1150;
const FALL = 1200;
const SETTLE = 400;
/** 「全集合 日期」：细线从中间分开时多走这么一点再停（毫秒），收得柔一些 */
const SETS_SETTLE = 260;

/** 宝珠中心在徽章图里的位置（徽章 100×118，宝珠圆心 y=47），clip-path 从这里扩开 */
const ORB_AT = '50% 39.83%';
/** 新徽章盖满整枚徽章需要的半径（按 clip-path circle() 的百分比口径算到最远的角） */
const FULL_RADIUS = 84;

const PLUM = '196, 104, 216';
const PLUM_LIGHT = '246, 211, 255';
const GOLD = '255, 214, 89';

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/**
 * 光球的颗数跟着这次新拿到的成就数走，但太少不成气候、太多就挤成一团。
 * gain 不知道（比如稀有度还没统计）时按 6 颗演。
 */
export function upgradeOrbCount(gain) {
    if (!Number.isFinite(gain) || gain <= 0) return 6;
    return Math.max(4, Math.min(16, Math.round(gain)));
}

/** 整段演出的时间点（毫秒）。音效也照这张表排，所以声音和画面上的每一颗光球对得上 */
export function upgradeTimeline(count) {
    const n = Math.max(1, Math.round(count) || 1);
    const arrivals = [];
    for (let k = 0; k < n; k += 1) {
        const x = n === 1 ? 1 : k / (n - 1);
        arrivals.push(Math.round(FIRST_ARRIVAL + (LAST_ARRIVAL - FIRST_ARRIVAL) * x ** 0.72));
    }
    const completeAt = arrivals[n - 1];
    const fallAt = completeAt + ADMIRE;
    const landAt = fallAt + FALL;
    return Object.freeze({ count: n, lift: LIFT, arrivals: Object.freeze(arrivals), completeAt, fallAt, landAt, end: landAt + SETTLE });
}

/**
 * 每颗光球汇入后统计栏该显示的数字。新拿到的成就均匀分给每一颗，
 * 稀有和普通按比例穿插着涨；最后一颗一定落在新的数字上。
 * @param {{rare?:number, common?:number, playtimeMin?:number}} from 只算本体时的数字
 * @param {{rare?:number, common?:number, playtimeMin?:number}} to   算上 DLC 之后的数字
 */
export function upgradeSteps(from, to, count) {
    const num = (value) => (Number.isFinite(value) ? value : null);
    const fromRare = num(from?.rare) ?? 0;
    const fromCommon = num(from?.common) ?? 0;
    const gainRare = Math.max(0, (num(to?.rare) ?? fromRare) - fromRare);
    const gainCommon = Math.max(0, (num(to?.common) ?? fromCommon) - fromCommon);
    const gain = gainRare + gainCommon;
    const fromTime = num(from?.playtimeMin);
    const toTime = num(to?.playtimeMin);
    const steps = [];
    for (let k = 1; k <= count; k += 1) {
        if (k === count) {
            steps.push({ rare: num(to?.rare) ?? fromRare, common: num(to?.common) ?? fromCommon, playtimeMin: toTime ?? fromTime });
            break;
        }
        const done = Math.round((gain * k) / count);
        const rare = gain > 0 ? Math.round((gainRare * done) / gain) : 0;
        steps.push({
            rare: fromRare + rare,
            common: fromCommon + done - rare,
            playtimeMin: fromTime != null && toTime != null ? fromTime + ((toTime - fromTime) * k) / count : fromTime,
        });
    }
    return steps;
}

/** 三次贝塞尔上的一点 */
function bezier(p0, p1, p2, p3, t) {
    const s = 1 - t;
    const a = s * s * s;
    const b = 3 * s * s * t;
    const c = 3 * s * t * t;
    const d = t * t * t;
    return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** 四角星芒（和卡面上的星芒同一种形状：四条边向里收的菱形） */
function starPath(ctx, x, y, size, angle) {
    const pinch = size * 0.16;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.quadraticCurveTo(pinch, -pinch, size, 0);
    ctx.quadraticCurveTo(pinch, pinch, 0, size);
    ctx.quadraticCurveTo(-pinch, pinch, -size, 0);
    ctx.quadraticCurveTo(-pinch, -pinch, 0, -size);
    ctx.closePath();
    ctx.restore();
}

/** 一团柔光：中心亮、向外散开 */
function glow(ctx, x, y, radius, color, alpha) {
    if (alpha <= 0.002 || radius <= 0) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
    g.addColorStop(0, `rgba(${color}, ${alpha})`);
    g.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
}

/** 光球本体：白色的芯，外面裹一层淡紫 */
function orbCore(ctx, x, y, radius, alpha) {
    if (alpha <= 0.002 || radius <= 0) return;
    const g = ctx.createRadialGradient(x - radius * 0.25, y - radius * 0.3, 0, x, y, radius);
    g.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
    g.addColorStop(0.45, `rgba(${PLUM_LIGHT}, ${alpha})`);
    g.addColorStop(1, `rgba(${PLUM}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
}

/**
 * 光球从卡片四周冒出来的位置：均匀撒在卡片外面一圈椭圆上（黄金角错开，不会扎堆），
 * 再往外随机推一点。椭圆比卡片大，所以不会从卡面中间凭空冒出来。
 */
function createOrbs(timeline, { center, target, width, height, size, u }) {
    const start = Math.random() * Math.PI * 2;
    return timeline.arrivals.map((arrive, k) => {
        const angle = start + k * 2.39996 + (Math.random() - 0.5) * 0.5;
        const reach = 0.92 + Math.random() * 0.26;
        const x = Math.min(size.width * 1.08, Math.max(-size.width * 0.08, center.x + Math.cos(angle) * width * 0.92 * reach));
        const y = Math.min(size.height * 1.04, Math.max(-size.height * 0.22, center.y + Math.sin(angle) * height * 0.6 * reach));
        const travel = Math.max(520, Math.min(MAX_TRAVEL, arrive - APPEAR - FIRST_BIRTH));
        const depart = arrive - travel;
        // 都朝同一个方向打旋，汇进去时像一个小漩涡
        const dx = target.x - x;
        const dy = target.y - y;
        const dist = Math.hypot(dx, dy) || 1;
        const ux = dx / dist;
        const uy = dy / dist;
        const px = -uy;
        const py = ux;
        return {
            birth: depart - APPEAR,
            depart,
            arrive,
            travel,
            radius: (1.9 + Math.random() * 0.8) * u,
            drift: { x: (Math.random() - 0.5) * 1.6 * u, y: -(0.6 + Math.random()) * u },
            p0: { x, y },
            p1: { x: x + px * dist * 0.5 + ux * dist * 0.05, y: y + py * dist * 0.5 + uy * dist * 0.05 },
            p2: { x: target.x - ux * dist * 0.3 + px * dist * 0.22, y: target.y - uy * dist * 0.3 + py * dist * 0.22 },
            p3: target,
            // 飞的路上落下两颗一闪即逝的小星芒
            twinkles: [0.32 + Math.random() * 0.12, 0.6 + Math.random() * 0.12].map((f) => ({
                at: depart + travel * f,
                size: (0.9 + Math.random() * 0.7) * u,
                spin: Math.random() * Math.PI,
                offset: { x: (Math.random() - 0.5) * 2.4 * u, y: (Math.random() - 0.5) * 2.4 * u },
            })),
        };
    });
}

/** 某一刻光球在哪、多大：冒出来时原地轻轻浮起，被吸过去时越来越快、越来越小 */
function orbAt(orb, t) {
    if (t < orb.depart) {
        const s = clamp01((t - orb.birth) / APPEAR);
        const pop = s < 1 ? 1 - (1 - s) ** 3 * (1 - 2.2 * s) : 1; // 轻微回弹地长出来
        return {
            x: orb.p0.x + orb.drift.x * s,
            y: orb.p0.y + orb.drift.y * s,
            scale: Math.max(0, pop),
            alpha: clamp01(s * 1.6),
            pull: 0,
        };
    }
    const s = clamp01((t - orb.depart) / orb.travel);
    const e = s ** 2.1;
    const start = { x: orb.p0.x + orb.drift.x, y: orb.p0.y + orb.drift.y };
    const p = bezier(start, orb.p1, orb.p2, orb.p3, e);
    return { x: p.x, y: p.y, scale: 1 - 0.55 * e, alpha: 1, pull: e };
}

/** 最后一颗汇入时从徽章上迸开的一小圈星芒（只在卡片附近，不炸满屏） */
function createFinale({ u }) {
    const stars = [];
    const count = 14;
    for (let i = 0; i < count; i += 1) {
        const angle = ((i + Math.random() * 0.7) / count) * Math.PI * 2;
        stars.push({
            angle,
            reach: (11 + Math.random() * 12) * u,
            size: (1.3 + Math.random() * 1.5) * u,
            delay: Math.random() * 90,
            life: 820 + Math.random() * 420,
            spin: (Math.random() - 0.5) * 3,
            gold: i % 2 === 0,
        });
    }
    return stars;
}

/** 翻新：拿起 → 光球汇入、数字上涨 → 变成蓝紫徽章、端详 → 放回卡槽 */
/**
 * 细线分开、露出「全集合 日期」。setsRule 叠在细线上（同一条中线），开演前量好位置：
 *   · 旧细线：左右两段遮罩，各从自己那头盖过来，接头是一段柔和的渐隐。一开始两段在正中会合，是一整条线；
 *     随后同时往两边退，退到正好让出字的位置。线本身也慢慢淡掉；
 *   · 两侧的蓝紫线：就在旧细线退到的位置上，慢慢浮现，接替旧细线；
 *   · 字：遮罩从正中撑开、两头柔边，宽度跟着细线让出来的空当走，同时淡入。
 * 所有元素共用一条缓动曲线、同一段时间（第一颗光球汇入 → 最后一颗汇入之后一点），所以一起走、不会一顿一顿。
 * 只动遮罩尺寸和透明度，不碰位置，卡面上什么都不会跳。
 */
function revealSetsRule({ play, rule, setsRule, from, to }) {
    if (!rule || !setsRule) return;
    const text = setsRule.querySelector('.ac-cf__sets-text');
    const lines = setsRule.querySelectorAll('.ac-cf__sets-line');
    const row = setsRule.getBoundingClientRect();
    const width = setsRule.offsetWidth;
    if (!text || lines.length !== 2 || !row.width || !width) return;
    // 量出来的是屏幕像素；遮罩用元素自己的像素（替身之后会被放大，按比例跟着放大）
    const k = width / row.width;
    const leftEnd = (lines[0].getBoundingClientRect().right - row.left) * k;
    const rightStart = (lines[1].getBoundingClientRect().left - row.left) * k;
    const textWidth = text.offsetWidth;
    const soft = Math.max(3, (rightStart - leftEnd - textWidth) / 2 + parseFloat(setsRule.ownerDocument.defaultView.getComputedStyle(setsRule).fontSize) * 0.4);
    const px = (value) => `${Math.max(0, value).toFixed(2)}px`;

    const timing = { duration: Math.max(1, to - from), delay: Math.max(0, from), easing: 'cubic-bezier(.45,.05,.55,.95)' };
    const maskOn = (node, image, position) => {
        node.style.setProperty('-webkit-mask-image', image);
        node.style.setProperty('mask-image', image);
        node.style.setProperty('-webkit-mask-repeat', 'no-repeat');
        node.style.setProperty('mask-repeat', 'no-repeat');
        node.style.setProperty('-webkit-mask-position', position);
        node.style.setProperty('mask-position', position);
    };
    const sizes = (left, right) => `${px(left)} 100%, ${px(right)} 100%`;

    // 旧细线：左段从左边盖过来、右段从右边盖过来，接头处 soft 像素渐隐
    maskOn(
        rule,
        `linear-gradient(90deg, #000 calc(100% - ${px(soft)}), transparent), linear-gradient(270deg, #000 calc(100% - ${px(soft)}), transparent)`,
        'left center, right center',
    );
    const closed = sizes(width / 2 + soft, width / 2 + soft);
    const open = sizes(leftEnd + soft / 2, width - rightStart + soft / 2);
    play(
        rule,
        [
            { maskSize: closed, webkitMaskSize: closed, opacity: 1 },
            { maskSize: open, webkitMaskSize: open, opacity: 0.75, offset: 0.8 },
            { maskSize: open, webkitMaskSize: open, opacity: 0 },
        ],
        // 光球越到后面来得越密，这里跟着它走：前 80% 的时间退开，最后一颗汇入前后交给蓝紫线
        timing,
    );
    // 蓝紫线在旧细线退到的位置上浮现
    for (const line of lines) {
        play(line, [{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], timing);
    }
    // 字：从正中撑开到字宽，两头柔边；比细线晚一点点起步，空当先让出来字再显
    maskOn(text, `linear-gradient(90deg, transparent, #000 ${px(soft)}, #000 calc(100% - ${px(soft)}), transparent)`, 'center center');
    const shut = `0px 100%`;
    const shown = `${px(textWidth + soft * 2)} 100%`;
    play(
        text,
        [
            { maskSize: shut, webkitMaskSize: shut, opacity: 0 },
            { maskSize: shut, webkitMaskSize: shut, opacity: 0, offset: 0.06 },
            { maskSize: shown, webkitMaskSize: shown, opacity: 1, offset: 0.94 },
            { maskSize: shown, webkitMaskSize: shown, opacity: 1 },
        ],
        timing,
    );
}

export function playUpgrade(env) {
    const { doc, book, play, pose, mover, shadow, flipper, sheen, veil, burst, addExtra, size, target, slot, cx, cy, u } = env;
    const { badge, fill, ghost, orb, rule, setsRule, timeline, onAbsorb } = env;
    const { lift, arrivals, completeAt, fallAt, landAt, end } = timeline;
    const n = arrivals.length;
    const at = (ms) => ms / end;
    const S = Math.max(HOLD_SCALE, (size.height * HOLD_MIN_HEIGHT) / slot.height);
    // 拿在手里时的尺寸单位：光球、光圈、阴影都按拿起来之后那张卡的大小来
    const v = u * (S / HOLD_SCALE);

    veil.dataset.tier = 'upgrade';
    burst.dataset.tier = 'upgrade';
    burst.style.width = `${128 * v}px`;

    // 拿在手里时卡片正好在书的正中；宝珠中心跟着放大
    const center = { x: target.x + cx, y: target.y + cy };
    const orbCenter = { x: center.x + orb.dx * S, y: center.y + orb.dy * S };
    const orbRadius = orb.r * S;

    play(veil, [{ opacity: 0 }, { opacity: 1, offset: at(lift) }, { opacity: 1, offset: at(fallAt + FALL * 0.6) }, { opacity: 0 }], {
        duration: end,
        easing: 'ease-in-out',
    });
    play(
        burst,
        [
            { opacity: 0, transform: 'translate(-50%, -50%) rotate(0deg) scale(0.6)' },
            { opacity: 0.4, transform: 'translate(-50%, -50%) rotate(4deg) scale(0.85)', offset: at(lift) },
            { opacity: 0.62, transform: 'translate(-50%, -50%) rotate(12deg) scale(0.95)', offset: at(completeAt - 80) },
            { opacity: 1, transform: 'translate(-50%, -50%) rotate(15deg) scale(1.1)', offset: at(completeAt + 260) },
            { opacity: 0.8, transform: 'translate(-50%, -50%) rotate(20deg) scale(1)', offset: at(fallAt) },
            { opacity: 0, transform: 'translate(-50%, -50%) rotate(28deg) scale(1.1)', offset: at(landAt) },
            { opacity: 0, transform: 'translate(-50%, -50%) rotate(28deg) scale(1.1)' },
        ],
        { duration: end, easing: 'linear' },
    );
    play(
        shadow,
        [
            { opacity: 0.2, transform: `translateY(${0.5 * u}px) scaleX(0.98)` },
            { opacity: 0.85, transform: `translateY(${8 * u}px) scaleX(1)`, offset: at(lift), easing: 'ease-in-out' },
            { opacity: 0.85, transform: `translateY(${8 * u}px) scaleX(1)`, offset: at(fallAt), easing: 'cubic-bezier(.45,0,.2,1)' },
            { opacity: 0.75, transform: `translateY(${2 * u}px) scaleX(0.98)`, offset: at(landAt), easing: 'ease-out' },
            { opacity: 0.2, transform: `translateY(${0.5 * u}px) scaleX(0.98)` },
        ],
        { duration: end },
    );
    // 变好之后在手里左右转一转，看看新徽章
    play(
        flipper,
        [
            { transform: 'rotateY(0deg)' },
            { transform: 'rotateY(0deg)', offset: at(completeAt + 180), easing: 'ease-in-out' },
            { transform: 'rotateY(7deg)', offset: at(completeAt + 560), easing: 'ease-in-out' },
            { transform: 'rotateY(-4deg)', offset: at(completeAt + 920), easing: 'ease-in-out' },
            { transform: 'rotateY(0deg)', offset: at(fallAt) },
            { transform: 'rotateY(0deg)' },
        ],
        { duration: end },
    );

    /* ── 「全集合 日期」：和光球汇入同一段时间，细线从中间分开退向两边，字在让出来的空当里显出来 ── */

    revealSetsRule({ play, rule, setsRule, from: arrivals[0], to: completeAt + SETS_SETTLE });

    /* ── 每一颗汇入：徽章轻轻一胀，紫色往外漫一圈，数字跳一格 ─────────────── */

    const shadowRest = 'drop-shadow(0 1.4cqw 1.8cqw rgba(0, 0, 0, 0.35)) drop-shadow(0 0 0 rgba(214, 140, 230, 0))';
    const shadowLit = (spread, alpha) => `drop-shadow(0 1.4cqw 1.8cqw rgba(0, 0, 0, 0.35)) drop-shadow(0 0 ${spread}cqw rgba(214, 140, 230, ${alpha}))`;
    const radiusAfter = (k) => (k >= n ? FULL_RADIUS : 22 + (FULL_RADIUS - 26) * (k / n) ** 0.85);
    let fired = 0;
    let finished = false;

    const absorb = (k) => {
        const from = k === 0 ? 0 : radiusAfter(k);
        play(fill, [{ clipPath: `circle(${from}% at ${ORB_AT})` }, { clipPath: `circle(${radiusAfter(k + 1)}% at ${ORB_AT})` }], {
            duration: k === n - 1 ? 620 : 460,
            easing: 'cubic-bezier(.2,.7,.3,1)',
        });
        if (k < n - 1) {
            play(
                badge,
                [
                    { transform: 'translateX(-50%) scale(1)', filter: shadowRest },
                    { transform: 'translateX(-50%) scale(1.06)', filter: shadowLit(2, 0.75), offset: 0.3 },
                    { transform: 'translateX(-50%) scale(1)', filter: shadowRest },
                ],
                { duration: 380, easing: 'ease-out', fill: 'none' },
            );
        }
        const changed = onAbsorb?.(k) ?? [];
        for (const node of changed) {
            const num = node.querySelector('.ac-cf__num');
            if (!num) continue;
            play(
                num,
                [
                    { transform: 'scale(1)', textShadow: '0 0 0 rgba(214, 140, 230, 0)' },
                    { transform: 'scale(1.24)', textShadow: `0 0 ${1.2 * u}px rgba(214, 140, 230, 0.95)`, offset: 0.28 },
                    { transform: 'scale(1)', textShadow: '0 0 0 rgba(214, 140, 230, 0)' },
                ],
                { duration: 440, easing: 'ease-out', fill: 'none' },
            );
        }
    };

    /** 最后一颗进去了：徽章一胀定型，星芒迸开，宝珠和卡面各掠过一道光 */
    const complete = () => {
        play(
            badge,
            [
                { transform: 'translateX(-50%) scale(1)', filter: shadowRest },
                { transform: 'translateX(-50%) scale(1.17)', filter: shadowLit(4, 0.95), offset: 0.26 },
                { transform: 'translateX(-50%) scale(0.97)', filter: shadowLit(2.4, 0.5), offset: 0.6 },
                { transform: 'translateX(-50%) scale(1)', filter: shadowRest },
            ],
            { duration: 760, easing: 'ease-out', fill: 'none' },
        );
        ghost?.setAttribute('data-shine', '');
        const glint = [{ transform: 'translateX(-160%) skewX(-18deg)' }, { transform: 'translateX(330%) skewX(-18deg)' }];
        play(sheen.firstChild, glint, { duration: 1050, delay: 160, easing: 'cubic-bezier(.3,.1,.3,1)' });
    };

    const fireUntil = (t) => {
        while (fired < n && t >= arrivals[fired]) {
            absorb(fired);
            fired += 1;
            if (fired === n && !finished) {
                finished = true;
                complete();
            }
        }
    };

    /* ── canvas：光球、拖尾、汇入时的光圈、最后的星芒 ─────────────────────── */

    const orbs = createOrbs(timeline, { center, target: orbCenter, width: slot.width * S, height: slot.height * S, size, u: v });
    const finale = createFinale({ u: v });
    const fx = createFxCanvas({ doc, book, size, addExtra });
    const TRAIL = 10;
    const TRAIL_GAP = 20;

    fx.run(landAt, (ctx, t) => {
        fireUntil(t);
        ctx.globalCompositeOperation = 'lighter';

        // 宝珠周围慢慢聚起来的一团紫光：汇进去的越多越亮，定型那一下最亮，然后退掉
        const progress = fired / n;
        let halo = t < FIRST_BIRTH ? 0 : 0.06 + 0.16 * progress;
        if (t >= completeAt) halo = Math.max(0, 0.34 * (1 - (t - completeAt) / 900));
        glow(ctx, orbCenter.x, orbCenter.y, orbRadius * (3.2 + progress * 1.2), PLUM, halo);

        for (const item of orbs) {
            if (t < item.birth || t > item.arrive) continue;
            const now = orbAt(item, t);
            // 拖尾：同一条轨迹上往前倒推几个时刻，越早越淡越细
            if (t > item.depart) {
                for (let j = TRAIL; j >= 1; j -= 1) {
                    const tj = t - j * TRAIL_GAP;
                    if (tj < item.depart) continue;
                    const past = orbAt(item, tj);
                    const fade = 1 - j / (TRAIL + 1);
                    glow(ctx, past.x, past.y, item.radius * 1.7 * past.scale * fade, PLUM, 0.42 * fade);
                }
            }
            glow(ctx, now.x, now.y, item.radius * 3.6 * now.scale, PLUM, 0.4 * now.alpha);
            glow(ctx, now.x, now.y, item.radius * 1.9 * now.scale, PLUM_LIGHT, 0.3 * now.alpha);
            orbCore(ctx, now.x, now.y, item.radius * 1.1 * now.scale, now.alpha);

            for (const tw of item.twinkles) {
                const age = (t - tw.at) / 460;
                if (age < 0 || age > 1) continue;
                const p = orbAt(item, tw.at);
                const s = Math.sin(age * Math.PI);
                ctx.fillStyle = `rgba(${PLUM_LIGHT}, ${0.85 * s})`;
                starPath(ctx, p.x + tw.offset.x, p.y + tw.offset.y, tw.size * s, tw.spin + age);
                ctx.fill();
            }
        }

        // 每颗汇入的那一下：宝珠上泛开一圈细光
        for (let k = 0; k < fired; k += 1) {
            const age = (t - arrivals[k]) / 420;
            if (age < 0 || age > 1) continue;
            const radius = orbRadius * (1.05 + age * 1.1);
            ctx.strokeStyle = `rgba(${PLUM_LIGHT}, ${0.7 * (1 - age)})`;
            ctx.lineWidth = Math.max(0.5, 0.55 * v * (1 - age));
            ctx.beginPath();
            ctx.arc(orbCenter.x, orbCenter.y, radius, 0, Math.PI * 2);
            ctx.stroke();
            glow(ctx, orbCenter.x, orbCenter.y, orbRadius * 1.3, PLUM_LIGHT, 0.28 * (1 - age));
        }

        // 定型：一圈金紫的光环往外散，十几颗星芒迸开
        if (t >= completeAt) {
            const age = (t - completeAt) / 700;
            if (age <= 1) {
                const e = 1 - (1 - age) ** 3;
                ctx.lineWidth = Math.max(0.5, 0.9 * v * (1 - age));
                ctx.strokeStyle = `rgba(${GOLD}, ${0.75 * (1 - age)})`;
                ctx.beginPath();
                ctx.arc(orbCenter.x, orbCenter.y, orbRadius * (1.2 + e * 3.6), 0, Math.PI * 2);
                ctx.stroke();
                ctx.strokeStyle = `rgba(${PLUM_LIGHT}, ${0.55 * (1 - age)})`;
                ctx.beginPath();
                ctx.arc(orbCenter.x, orbCenter.y, orbRadius * (1 + e * 2.7), 0, Math.PI * 2);
                ctx.stroke();
            }
            for (const star of finale) {
                const s = (t - completeAt - star.delay) / star.life;
                if (s < 0 || s > 1) continue;
                const e = 1 - (1 - s) ** 3;
                const x = orbCenter.x + Math.cos(star.angle) * (orbRadius * 1.1 + star.reach * e);
                const y = orbCenter.y + Math.sin(star.angle) * (orbRadius * 1.1 + star.reach * e) * 0.9;
                const fade = s < 0.2 ? s / 0.2 : 1 - (s - 0.2) / 0.8;
                const color = star.gold ? GOLD : PLUM_LIGHT;
                glow(ctx, x, y, star.size * 2.2, color, 0.3 * fade);
                ctx.fillStyle = `rgba(${color}, ${0.95 * fade})`;
                starPath(ctx, x, y, star.size * (1 - 0.4 * s), star.spin * s);
                ctx.fill();
            }
        }
        ctx.globalCompositeOperation = 'source-over';
    });

    // 放回去：书被压得轻轻一沉再回来
    const press = (y, scale) => `translateY(${y * u}px) scale(${scale})`;
    play(book, [{ transform: press(0, 1) }, { transform: press(0.3, 0.998), offset: 0.3 }, { transform: press(0, 1) }], {
        delay: landAt - 30,
        duration: 460,
        easing: 'cubic-bezier(.3,0,.3,1)',
        fill: 'none',
    });

    const hold = (dy, scale = S) => pose(cx, cy + dy * v, scale, 0);
    return play(
        mover,
        [
            { transform: pose(0, 0, 1, 0), opacity: 1, easing: 'ease-out' },
            // 先从卡槽里「拔」出来一点，再拿到书中央
            { transform: pose(0, -0.8 * u, 1.02, 0), opacity: 1, offset: at(170), easing: 'cubic-bezier(.45,0,.2,1)' },
            { transform: pose(cx, cy, S, -0.8), opacity: 1, offset: at(lift), easing: 'ease-in-out' },
            { transform: hold(-0.6), opacity: 1, offset: at((lift + completeAt) / 2), easing: 'ease-in-out' },
            { transform: hold(0), opacity: 1, offset: at(completeAt - 60), easing: 'cubic-bezier(.3,0,.2,1)' },
            { transform: hold(-1.4, S * 1.035), opacity: 1, offset: at(completeAt + 200), easing: 'ease-in-out' },
            { transform: hold(0, S * 1.018), opacity: 1, offset: at(completeAt + 600), easing: 'ease-in-out' },
            { transform: hold(0, S * 1.018), opacity: 1, offset: at(fallAt), easing: 'cubic-bezier(.45,0,.2,1)' },
            { transform: pose(0, -1.6 * u, 1.03, 0), opacity: 1, offset: at(fallAt + FALL * 0.84), easing: 'cubic-bezier(.5,0,.8,.5)' },
            { transform: pose(0, 0, 0.99, 0), opacity: 1, offset: at(landAt), easing: 'ease-out' },
            { transform: pose(0, 0, 1, 0), opacity: 1 },
        ],
        { duration: end },
    ).then((done) => {
        // 掉帧或者页面在后台时，canvas 可能没来得及把每一颗都算进去：落定之前补齐
        fireUntil(Infinity);
        return done;
    });
}
