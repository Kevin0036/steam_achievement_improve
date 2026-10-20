/**
 * 成就收藏册 · 竖版封面体检
 *
 * 卡片背面用的是游戏的竖版胶囊封面（library_600x900）。有两类封面放到卡上不对劲：
 *
 *   1. **Steam 代生成的占位竖图。** 游戏没有官方竖版封面时，客户端会退到商店的
 *      portrait.png —— 那是把横版 header 贴在一张模糊背景上拼出来的（例如合金装备 5：原爆点），
 *      并且以 library_600x900.jpg 的名字存进本地图片缓存：**文件名是 .jpg，内容其实是 PNG**。
 *      官方竖版封面一律是 JPEG，所以「同源、名字是 .jpg、开头是 PNG 签名」就是它的指纹。
 *      → 改用宽幅主视觉（library_hero）居中裁成竖版。
 *
 *   2. **自带一圈纯色边框的封面**（例如神之天平四周的黑框）。
 *      → 用 CSS `object-view-box` 把边框裁掉。只认「上下成对」或「左右成对」、
 *        同一种颜色、足够均匀、内沿是一条贯穿整边的直线的边；
 *        纯色背景一直铺到边上的封面（Papers, Please、VA-11 Hall-A 等）不算边框，不动。
 *
 * 结论按图片地址缓存（内存 + localStorage）。地址里带着客户端的缓存版本号，
 * 封面一更新地址就变，旧结论自然作废。
 */

const STORE_KEY = 'ac:v2:capsule';
const MAX_ENTRIES = 400;

/** 采样宽度：200px 下 1px ≈ 封面宽度的 0.5% */
const SAMPLE_W = 200;
/** 一行/一列像素与其均值的平均偏差低于它，才算「纯色」 */
const UNIFORM = 9;
/** 两条线的颜色差（取 RGB 三通道里最大的那个）低于它，才算同一种颜色 */
const SAME = 22;
/** 边框至少要有这么多采样像素（≈1%）才处理 */
const MIN_DEPTH = 2;
/** 最多往里找 12%；整段都是纯色说明是画面本身的大色块，不是边框 */
const MAX_DEPTH_RATIO = 0.12;
/** 边框内沿那条线上，和边框颜色差这么多才算「画面开始了」 */
const EDGE_DELTA = 40;
/** 内沿上至少这么大比例的像素是画面，才算一条贯穿整边的真边框 */
const EDGE_SHARE = 0.5;

export const PLACEHOLDER = 'placeholder';

/* ── 缓存 ──────────────────────────────────────────────────────────────── */

let memory = null;
const pending = new Map();

function readStore() {
    if (memory) return memory;
    try {
        memory = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') ?? {};
    } catch {
        memory = {};
    }
    if (typeof memory !== 'object' || Array.isArray(memory)) memory = {};
    return memory;
}

function remember(url, verdict) {
    const store = readStore();
    if (Object.keys(store).length >= MAX_ENTRIES) {
        memory = {};
    }
    memory[url] = verdict === PLACEHOLDER ? 'p' : Array.isArray(verdict) ? verdict : 0;
    try {
        globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(memory));
    } catch {
        // 配额满 / 无痕模式：只在内存里留着
    }
}

function decode(value) {
    if (value === 'p') return PLACEHOLDER;
    if (Array.isArray(value) && value.length === 4) return value;
    return null;
}

export function absoluteUrl(doc, url) {
    try {
        return new URL(url, doc.baseURI).href;
    } catch {
        return String(url);
    }
}

/**
 * 同步查缓存。
 * @returns {undefined | null | 'placeholder' | number[]}  undefined = 还没体检过；null = 正常封面；
 *          数组 = 要裁掉的边框 [上, 右, 下, 左]（百分比）
 */
export function peekCapsule(doc, url) {
    const store = readStore();
    const key = absoluteUrl(doc, url);
    return Object.prototype.hasOwnProperty.call(store, key) ? decode(store[key]) : undefined;
}

/** 体检一张已经加载成功的封面；同一个地址只体检一次 */
export function inspectCapsule(doc, url) {
    const key = absoluteUrl(doc, url);
    const known = peekCapsule(doc, key);
    if (known !== undefined) return Promise.resolve(known);
    if (pending.has(key)) return pending.get(key);

    const task = (async () => {
        let verdict = null;
        try {
            if (await isDisguisedPng(doc, key)) verdict = PLACEHOLDER;
            else verdict = await detectFrame(doc, key);
        } catch {
            verdict = null;
        }
        remember(key, verdict);
        return verdict;
    })().finally(() => pending.delete(key));

    pending.set(key, task);
    return task;
}

/** 把体检结论里的「裁边框」落到 <img> 上 */
export function trimFrame(img, inset) {
    const win = img.ownerDocument?.defaultView;
    if (!Array.isArray(inset) || !win?.CSS?.supports?.('object-view-box', 'inset(1%)')) return;
    const [t, r, b, l] = inset;
    img.style.setProperty('object-view-box', `inset(${t}% ${r}% ${b}% ${l}%)`);
}

/* ── 指纹 1：伪装成 .jpg 的 PNG ─────────────────────────────────────────── */

async function isDisguisedPng(doc, url) {
    const win = doc.defaultView;
    const target = new URL(url);
    // 只看客户端本地图片缓存（同源）；CDN 上的候选从来不会指向 portrait.png
    if (target.origin !== win.location.origin) return false;
    if (!/\.jpe?g$/i.test(target.pathname)) return false;

    const res = await win.fetch(target.href);
    if (!res.ok) return false;

    let head = null;
    const reader = res.body?.getReader?.();
    if (reader) {
        const { value } = await reader.read();
        head = value ?? null;
        reader.cancel().catch(() => {});
    } else {
        head = new Uint8Array(await res.arrayBuffer());
    }
    return Boolean(head && head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47);
}

/* ── 指纹 2：一圈纯色边框 ──────────────────────────────────────────────── */

function loadImage(doc, url) {
    return new Promise((resolve, reject) => {
        const img = doc.createElement('img');
        img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`load ${url}`));
        img.src = url;
    });
}

async function detectFrame(doc, url) {
    const img = await loadImage(doc, url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;

    const W = SAMPLE_W;
    const H = Math.max(1, Math.round((W * h) / w));
    const canvas = doc.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H); // 跨域污染时这里会抛，外面按「正常封面」处理

    /** 一整行（horizontal）或一整列的平均颜色与均匀度 */
    const line = (horizontal, i) => {
        const count = horizontal ? W : H;
        const at = (j) => (horizontal ? i * W + j : j * W + i) * 4;
        let r = 0;
        let g = 0;
        let b = 0;
        for (let j = 0; j < count; j += 1) {
            const p = at(j);
            r += data[p];
            g += data[p + 1];
            b += data[p + 2];
        }
        r /= count;
        g /= count;
        b /= count;
        let dev = 0;
        for (let j = 0; j < count; j += 1) {
            const p = at(j);
            dev += Math.max(Math.abs(data[p] - r), Math.abs(data[p + 1] - g), Math.abs(data[p + 2] - b));
        }
        return { r, g, b, dev: dev / count };
    };

    const diff = (a, b) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));

    /**
     * 从某一边往里数，有多少条线和最外面那条一样、而且都是纯色；
     * 再看边框里面紧挨着的那条线（跳过一条过渡线）有多大比例的像素和边框颜色明显不同。
     * 真边框的内沿是一条贯穿整边的直线（神之天平：73%~93%），
     * 而纯色**背景**只是在画面开始的地方零星断开（Papers, Please / VA-11 Hall-A：≤ 23%）。
     */
    const depth = (horizontal, from, step, size) => {
        const limit = Math.max(MIN_DEPTH + 1, Math.floor(size * MAX_DEPTH_RATIO));
        const edge = line(horizontal, from);
        if (edge.dev > UNIFORM) return { depth: 0, color: edge, contrast: 0 };
        let d = 0;
        for (let i = 0; i < limit; i += 1) {
            const s = line(horizontal, from + step * i);
            if (s.dev > UNIFORM || diff(s, edge) > SAME) break;
            d = i + 1;
        }
        // 一直纯色到上限：那是画面本身的大色块，不是边框
        if (d >= limit) return { depth: 0, color: edge, contrast: 0 };

        const inner = from + step * (d + 1);
        const count = horizontal ? W : H;
        let differ = 0;
        for (let j = 0; j < count; j += 1) {
            const p = (horizontal ? inner * W + j : j * W + inner) * 4;
            const delta = Math.max(Math.abs(data[p] - edge.r), Math.abs(data[p + 1] - edge.g), Math.abs(data[p + 2] - edge.b));
            if (delta > EDGE_DELTA) differ += 1;
        }
        return { depth: d, color: edge, contrast: differ / count };
    };

    const top = depth(true, 0, 1, H);
    const bottom = depth(true, H - 1, -1, H);
    const left = depth(false, 0, 1, W);
    const right = depth(false, W - 1, -1, W);

    const isFrame = (side) => side.depth >= MIN_DEPTH && side.contrast >= EDGE_SHARE;
    const pair = (a, b) => isFrame(a) && isFrame(b) && diff(a.color, b.color) <= SAME;
    const vertical = pair(top, bottom);
    const horizontal = pair(left, right);
    if (!vertical && !horizontal) return null;

    // 多裁 1 个采样像素，把边框与画面之间那条过渡线也带走
    const pct = (d, size) => +Math.min(MAX_DEPTH_RATIO * 100, ((d + 1) / size) * 100).toFixed(2);
    return [
        vertical ? pct(top.depth, H) : 0,
        horizontal ? pct(right.depth, W) : 0,
        vertical ? pct(bottom.depth, H) : 0,
        horizontal ? pct(left.depth, W) : 0,
    ];
}

/** 预览 / 自检用：清空缓存 */
export function clearCapsuleCache() {
    memory = {};
    try {
        globalThis.localStorage?.removeItem(STORE_KEY);
    } catch {
        // ignore
    }
}
