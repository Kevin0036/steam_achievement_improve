/**
 * 新卡入册的三档演出。按这款游戏玩了多久来分：
 *   fast     —— 15 小时以内：卡片垂直落下，插入只要 0.3 秒，重头戏在落槽之后。
 *               闪电（电流沿卡片边框游走）和火焰（火路先烧到位，卡片再插入）轮流播放；
 *   standard —— 15～50 小时（以及时长未知）：book.js 里原来那条时间轴；
 *   heavy    —— 超过 50 小时：灯光压暗，卡片慢慢托起、在手里端详一会儿，
 *               舍不得似地缓缓放下，稳稳落定。
 *
 * 设计前提：演出只发生在这张卡附近，不能干扰其他区域。不闪屏、不罩彩色遮罩；
 * 书页暗下去做聚焦、落槽时整本书轻轻一震，这些柔和的反馈可以保留。
 *
 * 这里只放 fast 和 heavy 的时间轴。替身卡、遮罩这些舞台由 book.js 的 fly() 搭好，
 * 通过 env 传进来，所以几档落槽的位置和收尾完全一致。
 * 闪电和火焰的效果画在 canvas 上：闪电的折线每帧重新生成，火焰是老动画风格的手绘火舌。
 *
 * env：{ doc, book, play, pose, stage, mover, shadow, flipper, sheen, veil, burst,
 *        addExtra, size, target, slot, cx, cy, u }
 *   size   书的宽高，target 卡槽中心（书内坐标），slot 卡槽宽高；
 *   cx/cy  从卡槽推到书正中的位移，u 是 1cqh 对应的像素（单页四张时等比缩小）。
 */

const FAST_MINUTES = 15 * 60;
const HEAVY_MINUTES = 50 * 60;

const FAST_ACT_KEY = 'ac:v1:intro-fast';
let lastFastAct = null; // 存储不可用时的内存兜底

/**
 * 快速通关的演出轮流来：这类游戏可能几天就打完好几款，闪电和火焰换着看不腻。
 * 上一次是什么存在本机，重开 Steam 也接着轮。
 */
export function nextFastAct(win) {
    let last = lastFastAct;
    try {
        last = win.localStorage.getItem(FAST_ACT_KEY) ?? last;
    } catch {
        // 存储不可用，这一次用内存里的记录
    }
    const next = last === 'lightning' ? 'fire' : 'lightning';
    lastFastAct = next;
    try {
        win.localStorage.setItem(FAST_ACT_KEY, next);
    } catch {
        // 同上
    }
    return next;
}

/** 时长未知时走标准档：宁可普通一点，也不要给它一个不属于它的演出 */
export function introTierOf(card) {
    const minutes = Number(card?.playtimeMin);
    if (!Number.isFinite(minutes) || minutes <= 0) return 'standard';
    if (minutes < FAST_MINUTES) return 'fast';
    return minutes > HEAVY_MINUTES ? 'heavy' : 'standard';
}

export const LIGHTNING = Object.freeze({ strike: 70, land: 300, end: 1750 });
export const FIRE = Object.freeze({ race: 340, start: 380, land: 640, burn: 2300, end: 2950 });

const HEAVY = Object.freeze({ appear: 950, flip: 1250, admire: 1150, fall: 1500, settle: 420 });
const HEAVY_FLY_AT = HEAVY.appear + HEAVY.flip + HEAVY.admire;
export const HEAVY_LAND_AT = HEAVY_FLY_AT + HEAVY.fall;
export const HEAVY_END = HEAVY_LAND_AT + HEAVY.settle;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** 铺在书上的一块画布，坐标系就是书内坐标；四周留白给飞出书外的火星和电弧 */
function createFxCanvas({ doc, book, size, addExtra }) {
    const win = doc.defaultView;
    const padX = size.width * 0.12;
    const padTop = size.height * 0.28;
    const padBottom = size.height * 0.08;
    const width = size.width + padX * 2;
    const height = size.height + padTop + padBottom;
    const ratio = Math.min(win.devicePixelRatio || 1, 1.5); // 比书还大的一块画布，高分屏不值得按 2 倍画

    const canvas = doc.createElement('canvas');
    canvas.className = 'ac-intro-fx';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.cssText = `left:${-padX}px;top:${-padTop}px;width:${width}px;height:${height}px`;
    book.append(canvas);
    addExtra(canvas);

    const ctx = canvas.getContext('2d');
    const clear = () => {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(ratio, 0, 0, ratio, padX * ratio, padTop * ratio);
    };

    return {
        ctx,
        /** 逐帧画到 duration 毫秒；书被销毁时 canvas 脱离文档，循环自己停 */
        run(duration, draw, stepMs = 0) {
            const startedAt = win.performance.now();
            let last = startedAt;
            let shown = -Infinity;
            const frame = (now) => {
                if (!canvas.isConnected) return;
                const t = Math.max(0, now - startedAt);
                if (t >= duration) {
                    clear();
                    return;
                }
                // stepMs：老动画每秒只画 24 张，不到点连画布都不动
                if (t - shown >= stepMs - 2) {
                    const dt = Math.min(Math.max(0, now - last), Math.max(40, stepMs * 2));
                    last = now;
                    shown = t;
                    clear();
                    draw(ctx, t, dt);
                }
                win.requestAnimationFrame(frame);
            };
            win.requestAnimationFrame(frame);
        },
    };
}

/** 垂直落下：卡片从书的上沿外面直直插进卡槽，插到底时微微下沉再弹回 */
function dropFrames({ pose, target, slot, u }, { start, land, end, filters }) {
    const at = (ms) => ms / end;
    const above = -(target.y + slot.height / 2 + 8 * u);
    const [launchFilter, landFilter, settleFilter, restFilter] = filters;
    return [
        { transform: pose(0, above, 1, 0), opacity: 0, filter: launchFilter },
        { transform: pose(0, above, 1, 0), opacity: 1, filter: launchFilter, offset: at(start), easing: 'cubic-bezier(.7,0,.9,.4)' },
        { transform: pose(0, 0.9 * u, 0.99, 0), opacity: 1, filter: landFilter, offset: at(land), easing: 'ease-out' },
        { transform: pose(0, -0.3 * u, 1.004, 0), opacity: 1, filter: settleFilter, offset: at(land + 90), easing: 'ease-in-out' },
        { transform: pose(0, 0, 1, 0), opacity: 1, filter: settleFilter, offset: at(land + 190) },
        { transform: pose(0, 0, 1, 0), opacity: 1, filter: restFilter },
    ];
}

/** 落槽时整本书轻轻一震 */
function bookJolt({ book, play, u }, land, strength) {
    const move = (x, y) => `translate(${x * strength * u}px, ${y * strength * u}px)`;
    play(book, [{ transform: move(0, 0) }, { transform: move(0.1, 0.55) }, { transform: move(-0.08, -0.26) }, { transform: move(0.04, 0.12) }, { transform: move(0, 0) }], {
        delay: land,
        duration: 260,
        easing: 'linear',
        fill: 'none',
    });
}

/* ── 闪电 ─────────────────────────────────────────────────────────────── */

/** 一条折线：越靠中段抖得越厉害，两端钉在起点和终点上 */
function jagged(from, to, steps, spread) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const [nx, ny] = [-dy / length, dx / length];
    const points = [from];
    for (let i = 1; i < steps; i += 1) {
        const t = i / steps;
        const swing = (Math.random() - 0.5) * 2 * spread * Math.sin(Math.PI * t);
        points.push({ x: from.x + dx * t + nx * swing, y: from.y + dy * t + ny * swing });
    }
    points.push(to);
    return points;
}

function tracePoints(ctx, points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i].x, points[i].y);
}

/** 一道电光：外面几层越来越淡的蓝，最里面一线白，叠起来才有发光的感觉 */
function strokeElectric(ctx, points, u, alpha, weight = 1) {
    const layers = [
        [9 * weight, 0.07, '96, 150, 255'],
        [4.4 * weight, 0.2, '120, 176, 255'],
        [1.9 * weight, 0.62, '190, 222, 255'],
        [0.7 * weight, 1, '255, 255, 255'],
    ];
    tracePoints(ctx, points);
    for (const [width, opacity, color] of layers) {
        ctx.lineWidth = width * u;
        ctx.strokeStyle = `rgba(${color}, ${opacity * alpha})`;
        ctx.stroke();
    }
}

/** 卡片矩形周长上的一点：s 从 0 到 1 绕一圈 */
function aroundCard(box, s) {
    const { x, y, width, height } = box;
    const perimeter = 2 * (width + height);
    let d = ((s % 1) + 1) % 1 * perimeter;
    if (d < width) return { x: x + d, y };
    d -= width;
    if (d < height) return { x: x + width, y: y + d };
    d -= height;
    if (d < width) return { x: x + width - d, y: y + height };
    d -= width;
    return { x, y: y + height - d };
}

/** 闪电：一道电光垂直劈下，卡片顺着它插进卡槽；落槽后电流绕着卡片边框游走，火花四溅，慢慢散掉 */
export function playLightningIntro(env) {
    const { play, mover, veil, size, target, slot, u } = env;
    const { strike, land, end } = LIGHTNING;
    const at = (ms) => ms / end;

    const box = { x: target.x - slot.width / 2, y: target.y - slot.height / 2, width: slot.width, height: slot.height };
    const top = { x: target.x, y: -size.height * 0.24 };
    const impact = { x: target.x, y: box.y + box.height }; // 贯穿整个卡槽，卡片顺着它插到底
    const radius = 3 * u;

    const fx = createFxCanvas(env);
    const sparks = [];
    const arcs = [];
    let bolt = null;
    let branches = [];
    let runners = [];
    let boltAt = -Infinity;
    let runnerAt = -Infinity;
    let arcAt = 0;

    for (let i = 0; i < 46; i += 1) {
        const point = aroundCard(box, Math.random());
        const angle = Math.random() * Math.PI * 2;
        // 飞不出卡片附近：速度 × 寿命最多约 40u，不能落到别的卡和对页上
        const speed = (0.02 + Math.random() * 0.045) * u;
        sparks.push({ ...point, vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.02 * u, born: land + Math.random() * 500, life: 300 + Math.random() * 320 });
    }

    fx.run(end, (ctx, t, dt) => {
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // 主电光：每隔一小会儿重新生成，所以是在跳动的，不是一张贴图
        if (t < land + 150) {
            if (t - boltAt > 42) {
                boltAt = t;
                bolt = jagged(top, impact, 16, 8.5 * u);
                branches = [5, 8, 11].map((index) => {
                    const start = bolt[index];
                    const side = Math.random() < 0.5 ? -1 : 1;
                    return jagged(start, { x: start.x + side * (10 + Math.random() * 12) * u, y: start.y + (9 + Math.random() * 12) * u }, 5, 2.4 * u);
                });
            }
            const rise = clamp01(t / strike);
            const fade = 1 - clamp01((t - land) / 150);
            const flicker = 0.7 + Math.random() * 0.3;
            strokeElectric(ctx, bolt, u, rise * fade * flicker, 1.25);
            for (const branch of branches) strokeElectric(ctx, branch, u, rise * fade * flicker * 0.7, 0.55);
        }

        if (t < land) return;
        const after = t - land;
        const remain = 1 - clamp01(after / (end - land - 120));

        // 落槽的冲击：顺着卡片的外形往外推一圈光，很快散掉
        if (after < 300) {
            const k = after / 300;
            const grow = (1 - (1 - k) ** 2) * 6 * u;
            ctx.lineWidth = (2.6 - 2 * k) * u;
            ctx.strokeStyle = `rgba(186, 222, 255, ${(1 - k) ** 2 * 0.8})`;
            ctx.beginPath();
            ctx.roundRect(box.x - grow, box.y - grow, box.width + grow * 2, box.height + grow * 2, radius + grow);
            ctx.stroke();
        }

        // 卡片边框一圈蓝光，电流还在的时候一直亮着
        const glow = remain ** 0.7;
        for (const [width, opacity] of [[8, 0.07], [4.2, 0.15], [1.8, 0.42]]) {
            ctx.lineWidth = width * u;
            ctx.strokeStyle = `rgba(136, 190, 255, ${opacity * glow * (0.75 + Math.random() * 0.25)})`;
            ctx.beginPath();
            ctx.roundRect(box.x, box.y, box.width, box.height, radius);
            ctx.stroke();
        }

        // 电流沿边框游走：三股，方向不同，转速慢慢降下来
        if (t - runnerAt > 46) {
            runnerAt = t;
            const travel = after * 0.0006;
            runners = [0, 1, 2].map((i) => {
                const direction = i === 1 ? -1 : 1;
                const head = i / 3 + direction * travel;
                const span = 0.075 + Math.random() * 0.05;
                const points = [];
                for (let step = 0; step <= 7; step += 1) {
                    const point = aroundCard(box, head + (span * step) / 7);
                    const wobble = step === 0 || step === 7 ? 0 : 1.5 * u;
                    points.push({ x: point.x + (Math.random() - 0.5) * wobble * 2, y: point.y + (Math.random() - 0.5) * wobble * 2 });
                }
                return points;
            });
        }
        for (const runner of runners) strokeElectric(ctx, runner, u, remain, 0.62);

        // 不时从边框上跳出一道小电弧
        arcAt -= dt;
        if (arcAt <= 0 && remain > 0.08) {
            arcAt = 55 + Math.random() * 90;
            const point = aroundCard(box, Math.random());
            const away = Math.atan2(point.y - target.y, point.x - target.x) + (Math.random() - 0.5) * 0.9;
            const length = (7 + Math.random() * 11) * u * (0.5 + remain * 0.5);
            arcs.push({ points: jagged(point, { x: point.x + Math.cos(away) * length, y: point.y + Math.sin(away) * length }, 6, 2 * u), born: t, life: 95 + Math.random() * 90 });
        }
        for (let i = arcs.length - 1; i >= 0; i -= 1) {
            const arc = arcs[i];
            const k = (t - arc.born) / arc.life;
            if (k >= 1) {
                arcs.splice(i, 1);
                continue;
            }
            strokeElectric(ctx, arc.points, u, (1 - k) * 0.95, 0.5);
        }

        // 四溅的火花：拖着一小截尾巴，受重力往下掉
        ctx.lineWidth = 0.34 * u;
        for (const spark of sparks) {
            if (t < spark.born) continue;
            const age = t - spark.born;
            if (age > spark.life) continue;
            spark.vy += 0.00009 * u * dt;
            spark.x += spark.vx * dt;
            spark.y += spark.vy * dt;
            ctx.strokeStyle = `rgba(214, 232, 255, ${(1 - age / spark.life) * 0.95})`;
            ctx.beginPath();
            ctx.moveTo(spark.x, spark.y);
            ctx.lineTo(spark.x - spark.vx * 16, spark.y - spark.vy * 16);
            ctx.stroke();
        }
    });

    play(veil, [{ opacity: 0 }, { opacity: 0.9, offset: at(strike) }, { opacity: 0.7, offset: at(land + 500) }, { opacity: 0 }], { duration: end, easing: 'linear' });
    bookJolt(env, land, 1);
    return play(
        mover,
        dropFrames(env, {
            start: strike,
            land,
            end,
            filters: ['brightness(1.9)', 'brightness(1.75)', 'brightness(1.22)', 'brightness(1)'],
        }),
        { duration: end },
    );
}

/* ── 火焰 ─────────────────────────────────────────────────────────────── */

/* 火焰的画风照着 1930 年代的橡皮管动画（《茶杯头》《猫和老鼠》那一路）：
   粗黑墨线、色块平涂、圆鼓鼓带钩的火舌、烟团和拉伸压扁。
   每秒只画 24 张，火舌在几张原画之间跳着换，不做补间，手绘的顿挫感全在这里。 */

const INK = '#1b110b';
const INK_RIM = '#ffcf7a'; // 书页是深色的，墨线外面要有一圈亮边托住，不然黑线看不见
const FLAME_FILL = ['#e8431a', '#f9a11f', '#fff0b0']; // 外、中、内三层，比现代矢量风的颜色旧一点
const SMOKE_FILL = ['#f1e6cf', '#c9b79a'];
const INK_STEP_MS = 1000 / 24;
const DRAWING_MS = 83; // 一张原画停两拍（12 张每秒）

/**
 * 火舌的四张原画：单位坐标，根部在 (0,0)，往上为正，高度约 1。
 * 每张都是一串三次贝塞尔控制点：起点，然后每段 [控制点1, 控制点2, 终点]。
 * 肚子圆、腰收紧、尖端带钩，换画时轮廓整个跳一下。
 */
const FLAME_DRAWINGS = [
    [[-0.46, 0], [-0.72, 0.24], [-0.56, 0.46], [-0.38, 0.56], [-0.26, 0.64], [-0.2, 0.8], [0, 0.9], [0.14, 0.97], [0.3, 0.98], [0.46, 1.06], [0.3, 0.9], [0.1, 0.84], [0.14, 0.66], [0.2, 0.5], [0.56, 0.46], [0.58, 0.22], [0.6, 0.1], [0.52, 0.04], [0.46, 0], [0.2, -0.1], [-0.2, -0.1], [-0.46, 0]],
    [[-0.4, 0], [-0.62, 0.24], [-0.44, 0.46], [-0.24, 0.6], [-0.1, 0.7], [-0.12, 0.88], [-0.42, 1.14], [-0.02, 1.06], [0.2, 0.86], [0.2, 0.66], [0.22, 0.5], [0.52, 0.36], [0.48, 0.16], [0.46, 0.08], [0.44, 0.04], [0.4, 0], [0.18, -0.1], [-0.18, -0.1], [-0.4, 0]],
    [[-0.54, 0], [-0.76, 0.2], [-0.56, 0.38], [-0.44, 0.46], [-0.36, 0.5], [-0.38, 0.62], [-0.46, 0.7], [-0.26, 0.68], [-0.14, 0.6], [-0.06, 0.54], [0.02, 0.62], [0.1, 0.76], [0.06, 0.92], [0.24, 0.8], [0.36, 0.6], [0.44, 0.44], [0.56, 0.3], [0.62, 0.12], [0.54, 0], [0.24, -0.12], [-0.24, -0.12], [-0.54, 0]],
    [[-0.46, 0], [-0.6, 0.14], [-0.6, 0.32], [-0.46, 0.44], [-0.3, 0.56], [-0.04, 0.6], [-0.06, 0.76], [-0.08, 0.88], [-0.26, 0.96], [-0.44, 1], [-0.12, 1.08], [0.2, 0.96], [0.26, 0.76], [0.3, 0.6], [0.62, 0.42], [0.58, 0.2], [0.56, 0.1], [0.5, 0.04], [0.46, 0], [0.2, -0.1], [-0.2, -0.1], [-0.46, 0]],
];
/** 镜像的原画点序也要反过来，所有火舌绕向一致，叠在一起才不会抠出洞 */
const FLAME_MIRRORED = FLAME_DRAWINGS.map((points) => [...points].reverse().map(([x, y]) => [-x, y]));

function makeFlame({ x, y, width, height, born, dies, angle = 0, flip = 1, vx = 0, vy = 0, ash = false }) {
    return {
        x,
        y,
        width,
        height,
        born,
        dies,
        vx,
        vy,
        ash,
        drawings: flip < 0 ? FLAME_MIRRORED : FLAME_DRAWINGS,
        cos: Math.cos(angle),
        sin: Math.sin(angle),
        beat: Math.floor(Math.random() * 4),
    };
}

/** 蹦出来时明显冲过头，熄灭时一下缩回去：动画里的东西都不会老老实实变大 */
function flameScale(flame, t) {
    const age = t - flame.born;
    if (age <= 0) return 0;
    const grown = age < DRAWING_MS ? 0.55 : age < DRAWING_MS * 2 ? 1.28 : 1;
    const left = flame.dies - t;
    return grown * (left > DRAWING_MS * 2 ? 1 : left > DRAWING_MS ? 0.7 : 0.38);
}

function traceFlame(path, flame, width, height) {
    const { x, y, cos, sin } = flame;
    const points = flame.drawings[flame.frame];
    const mapX = (px, py) => x + px * width * cos + py * height * sin;
    const mapY = (px, py) => y + px * width * sin - py * height * cos;
    path.moveTo(mapX(points[0][0], points[0][1]), mapY(points[0][0], points[0][1]));
    for (let i = 1; i < points.length; i += 3) {
        const [a, b, c] = [points[i], points[i + 1], points[i + 2]];
        path.bezierCurveTo(mapX(a[0], a[1]), mapY(a[0], a[1]), mapX(b[0], b[1]), mapY(b[0], b[1]), mapX(c[0], c[1]), mapY(c[0], c[1]));
    }
    path.closePath();
}

/**
 * 先用粗黑线描整片火的轮廓，再整片填色盖住里面多余的线：只留外轮廓，火连成一团。
 * 填色往左上挪一点点，下方和右方的墨线就比上方粗，有毛笔描线的轻重。
 */
function inkFlames(ctx, flames, t, u) {
    const shell = new Path2D();
    const middle = new Path2D();
    const heart = new Path2D();
    const drawing = Math.floor(t / DRAWING_MS);
    for (const flame of flames) {
        const scale = flameScale(flame, t);
        if (scale <= 0) continue;
        flame.frame = (drawing + flame.beat) % 4;
        const [width, height] = [flame.width * scale, flame.height * scale];
        traceFlame(shell, flame, width, height);
        traceFlame(middle, flame, width * 0.66, height * 0.7);
        traceFlame(heart, flame, width * 0.32, height * 0.4);
    }
    ctx.lineJoin = 'round';
    ctx.strokeStyle = INK_RIM;
    ctx.lineWidth = 2.5 * u;
    ctx.stroke(shell);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.7 * u;
    ctx.stroke(shell);
    ctx.save();
    ctx.translate(-0.12 * u, -0.12 * u);
    ctx.fillStyle = FLAME_FILL[0];
    ctx.fill(shell);
    ctx.fillStyle = FLAME_FILL[1];
    ctx.fill(middle);
    ctx.fillStyle = FLAME_FILL[2];
    ctx.fill(heart);
    ctx.restore();
}

/** 一团烟：几个圆挤在一起，描黑边，下半边压一层暗色 */
function makePuff(x, y, born, size, drift) {
    const lobes = [[0, 0, 1]];
    const count = 4 + Math.floor(Math.random() * 2);
    for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * 6.28 + Math.random() * 0.6;
        lobes.push([Math.cos(angle) * 0.72, Math.sin(angle) * 0.56, 0.5 + Math.random() * 0.3]);
    }
    return { x, y, born, dies: born + 460 + Math.random() * 260, size, drift, lobes };
}

function inkPuffs(ctx, puffs, t, u) {
    if (!puffs.length) return;
    const body = new Path2D();
    const shadow = new Path2D();
    const wobble = Math.floor(t / DRAWING_MS) % 2 ? 1.05 : 0.97; // 轮廓一胀一缩地「呼吸」，手绘线稿都这样
    for (const puff of puffs) {
        const age = t - puff.born;
        if (age <= 0) continue;
        const left = puff.dies - t;
        const scale = (age < DRAWING_MS ? 0.5 : age < DRAWING_MS * 2 ? 1.2 : 1 + (age / (puff.dies - puff.born)) * 0.35) * (left < DRAWING_MS ? 0.45 : left < DRAWING_MS * 2 ? 0.75 : 1);
        const px = puff.x + (puff.drift * age) / 1000;
        const py = puff.y - (age / 1000) * 34 * u;
        for (const [dx, dy, radius] of puff.lobes) {
            const r = radius * puff.size * scale * wobble;
            const cx = px + dx * puff.size * scale;
            const cy = py + dy * puff.size * scale;
            body.moveTo(cx + r, cy);
            body.arc(cx, cy, r, 0, Math.PI * 2);
            shadow.moveTo(cx + r * 0.78, cy + r * 0.2);
            shadow.arc(cx, cy + r * 0.2, r * 0.78, 0, Math.PI);
        }
    }
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2 * u;
    ctx.stroke(body);
    ctx.fillStyle = SMOKE_FILL[0];
    ctx.fill(body);
    ctx.fillStyle = SMOKE_FILL[1];
    ctx.fill(shadow);
}

/** 卡片下落时的速度线：奶油色的细长竖线，每拍换一批 */
function inkSpeedLines(ctx, box, top, u, seed) {
    ctx.fillStyle = '#f6e9c9';
    for (let i = 0; i < 6; i += 1) {
        const roll = Math.sin(seed * 12.9 + i * 78.2) * 43758.5;
        const fraction = roll - Math.floor(roll);
        const x = box.x + box.width * (0.08 + 0.84 * ((i + fraction) / 6));
        const length = (18 + fraction * 22) * u;
        ctx.fillRect(x, top - length - 2 * u, 0.5 * u, length);
    }
}

/** 落槽后绕着卡片边缘烧的火：底边和顶边的小火苗，两侧的火由火路留下 */
function ringCard(box, u, born, burn) {
    const flames = [];
    const bottom = box.y + box.height;
    const base = Math.round(box.width / (9 * u));
    for (let i = 0; i < base; i += 1) {
        flames.push(makeFlame({
            x: box.x + box.width * ((i + 0.5 + (Math.random() - 0.5) * 0.4) / base),
            y: bottom + 0.6 * u,
            width: (10 + Math.random() * 3) * u,
            height: (12 + Math.random() * 6) * u,
            born: born + Math.random() * 50,
            dies: burn - Math.random() * 220,
            flip: Math.random() < 0.5 ? 1 : -1,
            ash: true,
        }));
    }
    const crown = Math.round(box.width / (13 * u));
    for (let i = 0; i < crown; i += 1) {
        flames.push(makeFlame({
            x: box.x + box.width * ((i + 0.5 + (Math.random() - 0.5) * 0.4) / crown),
            y: box.y + 1 * u,
            width: (8 + Math.random() * 3) * u,
            height: (9 + Math.random() * 5) * u,
            born: born + 120 + Math.random() * 60,
            dies: burn - 800 - Math.random() * 300,
            flip: Math.random() < 0.5 ? 1 : -1,
            ash: true,
        }));
    }
    return flames;
}

/**
 * 火焰：两道火沿卡槽两侧先烧下来，卡片再从中间垂直插入，
 * 落槽时卡片压扁回弹、冒出烟团，火继续在卡片边缘烧一会儿，最后一簇簇熄灭成烟。
 */
export function playFireIntro(env) {
    const { doc, book, play, stage, mover, veil, size, target, slot, u } = env;
    const { race, start, land, burn, end } = FIRE;
    const at = (ms) => ms / end;

    const box = { x: target.x - slot.width / 2, y: target.y - slot.height / 2, width: slot.width, height: slot.height };
    const right = box.x + box.width;
    const bottom = box.y + box.height;
    const reachTop = -size.height * 0.24;
    const fx = createFxCanvas(env);
    const flames = [];
    const puffs = [];
    const cinders = [];
    let ignited = false;
    let pathAt = reachTop;
    let pathStep = 0;

    const addCinder = (x, y) => {
        cinders.push({
            x,
            y,
            vx: (Math.random() - 0.5) * 0.05 * u,
            vy: (-0.03 - Math.random() * 0.04) * u,
            age: 0,
            life: 500 + Math.random() * 500,
            size: (0.5 + Math.random() * 0.5) * u,
        });
    };

    fx.run(end, (ctx, t, dt) => {
        // 两道火沿卡槽两侧烧下来：火路在卡片到来之前就铺好了
        if (t < race + INK_STEP_MS) {
            const head = reachTop + (bottom - reachTop) * clamp01(t / race) ** 1.5;
            while (pathAt < head) {
                pathAt += 11 * u;
                pathStep += 1;
                const inSlot = pathAt > box.y;
                for (const [x, outward] of [[box.x, -1], [right, 1]]) {
                    const rise = clamp01((bottom - pathAt) / box.height);
                    const big = (pathStep + (outward > 0 ? 1 : 0)) % 2 === 0;
                    flames.push(makeFlame({
                        x: x + outward * (Math.random() * 1.2 * u),
                        y: pathAt,
                        width: (big ? 13 + Math.random() * 3 : 9 + Math.random() * 2) * u,
                        height: (big ? 24 + Math.random() * 7 : 13 + Math.random() * 4) * u,
                        born: t,
                        // 卡槽以上的火在卡片落下后就灭；卡槽两侧的留下来继续烧，上面的先灭
                        dies: inSlot ? burn - 150 - rise * 700 - Math.random() * 200 : land + 40 + Math.random() * 200,
                        angle: outward * (big ? 0.22 + Math.random() * 0.2 : 0.5 + Math.random() * 0.3),
                        flip: outward,
                        ash: inSlot,
                    }));
                }
            }
        }
        if (t >= start && t < land) {
            const top = mover.getBoundingClientRect().top - book.getBoundingClientRect().top;
            inkSpeedLines(ctx, box, top, u, Math.floor(t / DRAWING_MS));
        }
        if (t >= land && !ignited) {
            // 落槽：烟团从卡片下角冒出来，火在底边和顶边接上
            ignited = true;
            flames.push(...ringCard(box, u, t, burn));
            for (const [x, drift] of [[box.x, -1], [right, 1]]) {
                for (let i = 0; i < 3; i += 1) {
                    puffs.push(makePuff(x + drift * (i * 3.5 + 2) * u, bottom - i * 2 * u, t + i * 24, (4.2 - i * 0.6) * u, drift * (12 + i * 8) * u));
                }
            }
        }

        // 脱离火舌、自己往上飘的小火苗
        if (t > land + 120 && t < burn - 300 && Math.random() < 0.28) {
            const point = aroundCard(box, Math.random());
            const height = (6 + Math.random() * 3) * u;
            flames.push(makeFlame({
                x: point.x,
                y: point.y - 4 * u,
                width: height * 0.72,
                height,
                born: t,
                dies: t + 280 + Math.random() * 200,
                flip: Math.random() < 0.5 ? 1 : -1,
                vy: (-0.11 - Math.random() * 0.06) * u,
            }));
        }

        for (let i = flames.length - 1; i >= 0; i -= 1) {
            const flame = flames[i];
            flame.x += flame.vx * dt;
            flame.y += flame.vy * dt;
            if (t < flame.dies) continue;
            // 熄灭的火舌「噗」地变成一小团烟，溅出几粒火星
            if (flame.ash) {
                if (Math.random() < 0.6) puffs.push(makePuff(flame.x, flame.y - flame.height * 0.35, t, (2.2 + Math.random() * 1.4) * u, (Math.random() - 0.5) * 22 * u));
                for (let n = 0; n < 3; n += 1) addCinder(flame.x, flame.y - flame.height * 0.3);
            }
            flames.splice(i, 1);
        }
        for (let i = puffs.length - 1; i >= 0; i -= 1) {
            if (t >= puffs[i].dies) puffs.splice(i, 1);
        }

        // 胶片抖动：整张画微微错位，像放映机的片门
        ctx.save();
        ctx.translate((Math.random() - 0.5) * 0.3 * u, (Math.random() - 0.5) * 0.3 * u);
        inkFlames(ctx, flames, t, u);
        inkPuffs(ctx, puffs, t, u);
        for (let i = cinders.length - 1; i >= 0; i -= 1) {
            const cinder = cinders[i];
            cinder.age += dt;
            if (cinder.age >= cinder.life) {
                cinders.splice(i, 1);
                continue;
            }
            cinder.x += cinder.vx * dt;
            cinder.y += cinder.vy * dt;
            const radius = cinder.size * (1 - (cinder.age / cinder.life) * 0.5);
            ctx.fillStyle = INK;
            ctx.beginPath();
            ctx.arc(cinder.x, cinder.y, radius + 0.3 * u, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = FLAME_FILL[1];
            ctx.beginPath();
            ctx.arc(cinder.x, cinder.y, radius, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();
    }, INK_STEP_MS);

    // 烧焦的卡片边：一圈炭黑慢慢褪掉
    const scorch = doc.createElement('i');
    scorch.className = 'ac-intro-scorch';
    scorch.style.borderRadius = `${3 * u}px`;
    scorch.style.boxShadow = `inset 0 0 ${3 * u}px ${1.4 * u}px rgba(27, 17, 11, 0.9), inset 0 0 ${7 * u}px ${2 * u}px rgba(232, 67, 26, 0.5)`;
    stage.append(scorch);
    play(scorch, [{ opacity: 0 }, { opacity: 1, offset: 0.1 }, { opacity: 0.85, offset: 0.7 }, { opacity: 0 }], { delay: land - 30, duration: end - land - 80 });

    play(veil, [{ opacity: 0 }, { opacity: 0.9, offset: at(200) }, { opacity: 0.75, offset: at(burn) }, { opacity: 0 }], { duration: end, easing: 'linear' });
    bookJolt(env, land, 1.2);
    return play(mover, inkDropFrames(env, { start, land, end }), { duration: end });
}

/** 卡片的落法也要卡通：下落时被拉长，砸到底压扁，再弹两下回原形。缩放绕卡片底边 */
function inkDropFrames({ pose, target, slot, u }, { start, land, end }) {
    const at = (ms) => ms / end;
    const above = -(target.y + slot.height / 2 + 8 * u);
    const shape = (dy, sx, sy) => `${pose(0, dy + (slot.height * (1 - sy)) / 2, 1, 0)} scale(${sx}, ${sy})`;
    return [
        { transform: shape(above, 1, 1), opacity: 0 },
        { transform: shape(above, 1, 1), opacity: 0, offset: at(start - 1) },
        { transform: shape(above, 0.96, 1.08), opacity: 1, offset: at(start), easing: 'cubic-bezier(.6,0,.9,.5)' },
        { transform: shape(0, 0.9, 1.16), opacity: 1, offset: at(land - 16), easing: 'linear' },
        { transform: shape(0, 1.12, 0.82), opacity: 1, offset: at(land + 60), easing: 'ease-out' },
        { transform: shape(0, 0.95, 1.07), opacity: 1, offset: at(land + 165), easing: 'ease-in-out' },
        { transform: shape(0, 1.03, 0.97), opacity: 1, offset: at(land + 265), easing: 'ease-in-out' },
        { transform: shape(0, 1, 1), opacity: 1, offset: at(land + 350) },
        { transform: shape(0, 1, 1), opacity: 1 },
    ];
}

/** 端详时从卡片边缘慢慢升起的金色微尘 */
function createMotes(doc, play, u, { count, delay, spreadX, startY, rise, duration }) {
    const box = doc.createElement('div');
    box.className = 'ac-intro-sparks';
    box.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < count; i += 1) {
        const mote = doc.createElement('i');
        mote.className = 'ac-intro__mote';
        const size = (0.5 + Math.random() * 0.9) * u;
        mote.style.width = `${size}px`;
        mote.style.height = `${size}px`;
        box.append(mote);
        const x = (Math.random() - 0.5) * 2 * spreadX;
        const y = startY + (Math.random() - 0.5) * 6 * u;
        const drift = (Math.random() - 0.5) * 7 * u;
        play(
            mote,
            [
                { transform: `translate(${x}px, ${y}px)`, opacity: 0 },
                { transform: `translate(${x + drift * 0.4}px, ${y - rise * 0.35}px)`, opacity: 0.9, offset: 0.3 },
                { transform: `translate(${x + drift}px, ${y - rise}px)`, opacity: 0 },
            ],
            { delay: delay + Math.random() * 700, duration: duration + Math.random() * 500, easing: 'ease-out' },
        );
    }
    return box;
}

/** 厚重：灯光压暗，卡片慢慢托起、翻面、端详，再舍不得似地缓缓放下，稳稳落定 */
export function playHeavyIntro(env) {
    const { doc, book, play, pose, mover, shadow, flipper, sheen, veil, burst, addExtra, slot, target, size, cx, cy, u } = env;
    const { appear, flip, admire, fall } = HEAVY;
    const flipAt = appear;
    const revealAt = flipAt + flip * 0.5;
    const shownAt = flipAt + flip;
    const flyAt = HEAVY_FLY_AT;
    const landAt = HEAVY_LAND_AT;
    const end = HEAVY_END;
    const at = (ms) => ms / end;

    veil.dataset.tier = 'heavy';
    burst.dataset.tier = 'heavy';

    const motes = createMotes(doc, play, u, {
        count: 26,
        delay: revealAt,
        spreadX: slot.width * 0.72,
        startY: slot.height * 0.42,
        rise: 46 * u,
        duration: 2300,
    });
    book.append(motes);
    addExtra(motes);

    play(veil, [{ opacity: 0 }, { opacity: 1, offset: at(appear) }, { opacity: 1, offset: at(flyAt + fall * 0.6) }, { opacity: 0 }], {
        duration: end,
        easing: 'ease-in-out',
    });
    play(
        burst,
        [
            { opacity: 0, transform: 'translate(-50%, -50%) rotate(0deg) scale(0.6)' },
            { opacity: 0.6, transform: 'translate(-50%, -50%) rotate(4deg) scale(0.85)', offset: at(appear) },
            { opacity: 1, transform: 'translate(-50%, -50%) rotate(10deg) scale(1.05)', offset: at(shownAt) },
            { opacity: 0.85, transform: 'translate(-50%, -50%) rotate(18deg) scale(1)', offset: at(flyAt) },
            { opacity: 0, transform: 'translate(-50%, -50%) rotate(26deg) scale(1.1)', offset: at(landAt) },
            { opacity: 0, transform: 'translate(-50%, -50%) rotate(26deg) scale(1.1)' },
        ],
        { duration: end, easing: 'linear' },
    );
    play(
        shadow,
        [
            { opacity: 0, transform: `translateY(${9 * u}px) scaleX(1)` },
            { opacity: 0.85, transform: `translateY(${8 * u}px) scaleX(1)`, offset: at(flipAt), easing: 'cubic-bezier(.6,0,.4,1)' },
            { opacity: 0.85, transform: `translateY(${8 * u}px) scaleX(0.1)`, offset: at(revealAt), easing: 'cubic-bezier(.6,0,.4,1)' },
            { opacity: 0.85, transform: `translateY(${8 * u}px) scaleX(1)`, offset: at(shownAt) },
            { opacity: 0.85, transform: `translateY(${8 * u}px) scaleX(1)`, offset: at(flyAt), easing: 'cubic-bezier(.45,0,.2,1)' },
            { opacity: 0.75, transform: `translateY(${2 * u}px) scaleX(0.98)`, offset: at(landAt), easing: 'ease-out' },
            { opacity: 0.2, transform: `translateY(${0.5 * u}px) scaleX(0.98)` },
        ],
        { duration: end },
    );
    // 翻到正面后在手里左右转一转：这款玩了太久，舍不得马上放下
    play(
        flipper,
        [
            { transform: 'rotateY(180deg)' },
            { transform: 'rotateY(180deg)', offset: at(flipAt), easing: 'cubic-bezier(.55,0,.3,1)' },
            { transform: 'rotateY(-6deg)', offset: at(flipAt + flip * 0.84), easing: 'ease-out' },
            { transform: 'rotateY(0deg)', offset: at(shownAt), easing: 'ease-in-out' },
            { transform: 'rotateY(8deg)', offset: at(shownAt + admire * 0.4), easing: 'ease-in-out' },
            { transform: 'rotateY(-6deg)', offset: at(shownAt + admire * 0.76), easing: 'ease-in-out' },
            { transform: 'rotateY(0deg)', offset: at(flyAt) },
            { transform: 'rotateY(0deg)' },
        ],
        { duration: end },
    );
    const glint = [{ transform: 'translateX(-160%) skewX(-18deg)' }, { transform: 'translateX(330%) skewX(-18deg)' }];
    play(sheen.firstChild, glint, { duration: 1050, delay: flipAt + flip * 0.72, easing: 'cubic-bezier(.3,.1,.3,1)' });
    play(sheen.firstChild, glint, { duration: 1100, delay: shownAt + admire * 0.42, easing: 'cubic-bezier(.3,.1,.3,1)', fill: 'none' });

    // 落定：书被压得轻轻一沉再回来，书页上扬起一点微尘
    const press = (y, scale) => `translateY(${y * u}px) scale(${scale})`;
    play(book, [{ transform: press(0, 1) }, { transform: press(0.42, 0.9975), offset: 0.3 }, { transform: press(0, 1) }], {
        delay: landAt - 30,
        duration: 520,
        easing: 'cubic-bezier(.3,0,.3,1)',
        fill: 'none',
    });
    const dust = createMotes(doc, play, u, {
        count: 14,
        delay: landAt - 40,
        spreadX: slot.width * 0.6,
        startY: 0,
        rise: 9 * u,
        duration: 900,
    });
    dust.style.left = `${target.x}px`;
    dust.style.top = `${target.y + slot.height * 0.5}px`;
    book.append(dust);
    addExtra(dust);

    return play(
        mover,
        [
            { transform: pose(cx, cy + 16 * u, 0.74, -3), opacity: 0, easing: 'cubic-bezier(.25,.6,.25,1)' },
            { transform: pose(cx, cy, 1.1, -1.2), opacity: 1, offset: at(appear), easing: 'ease-in-out' },
            { transform: pose(cx, cy - 1.5 * u, 1.2, 0), opacity: 1, offset: at(revealAt), easing: 'ease-in-out' },
            { transform: pose(cx, cy, 1.16, 0), opacity: 1, offset: at(shownAt), easing: 'ease-in-out' },
            { transform: pose(cx, cy - 1.2 * u, 1.18, 0.9), opacity: 1, offset: at(shownAt + admire * 0.5), easing: 'ease-in-out' },
            { transform: pose(cx, cy, 1.16, 0), opacity: 1, offset: at(flyAt), easing: 'cubic-bezier(.45,0,.2,1)' },
            { transform: pose(0, -2 * u, 1.03, 0), opacity: 1, offset: at(flyAt + fall * 0.84), easing: 'cubic-bezier(.5,0,.8,.5)' },
            { transform: pose(0, 0, 0.99, 0), opacity: 1, offset: at(landAt), easing: 'ease-out' },
            { transform: pose(0, 0, 1, 0), opacity: 1 },
        ],
        { duration: end },
    );
}
