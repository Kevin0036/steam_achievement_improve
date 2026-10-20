/**
 * 成就收藏册 · 卡面底色
 *
 * 参考图 4 的卡面下半部分，是从插画里「延伸」出来的一种低饱和底色。
 * 这里从封面图取样得到它：
 *   1. 只取封面在卡片上**实际露出来**的那一块（中间一段的下半部分），
 *      这样插画渐隐到底色时是连续的；
 *   2. 按饱和度加权平均 —— 大片黑白不会把颜色吞掉；
 *   3. 压低饱和度与亮度，保证金色标题、青柠色「完美通关」在上面都清楚，
 *      也让 77 张卡放在一起时整体是统一的深色调，不会花。
 *
 * 结果按 appid 缓存在 localStorage（同一张封面，颜色不会变）。
 * 取样失败（跨域、404、解码失败）时返回 null，调用方用默认底色。
 */

const STORE_KEY = 'ac:v1:tone';

export const DEFAULT_TONE = { h: 222, s: 0.1, l: 0.24 };

let memory = null;

function readStore() {
    if (memory) return memory;
    try {
        memory = JSON.parse(globalThis.localStorage?.getItem(STORE_KEY) ?? '{}') ?? {};
    } catch {
        memory = {};
    }
    return memory;
}

function writeStore() {
    try {
        globalThis.localStorage?.setItem(STORE_KEY, JSON.stringify(memory));
    } catch {
        // 配额满 / 无痕模式：只在内存里留着
    }
}

export function toneToCss({ h, s, l }) {
    return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return { h: h * 60, s, l };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 把取样得到的颜色「收」成卡面底色 */
function mute({ h, s, l }) {
    return {
        h,
        s: clamp(s * 0.55, 0.06, 0.3),
        l: clamp(0.21 + l * 0.12, 0.21, 0.3),
    };
}

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

/**
 * @param {Document} doc
 * @param {string} url  宽幅封面（library_hero）
 * @param {number} visibleRatio  卡片上露出部分的宽高比（宽 / 高）
 */
async function sample(doc, url, visibleRatio) {
    const img = await loadImage(doc, url);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;

    // object-fit: cover 时露出来的那一段
    const cropW = Math.min(w, h * visibleRatio);
    const sx = (w - cropW) / 2;
    // 只看下半部分：插画渐隐到底色的就是这里
    const sy = h * 0.5;
    const sh = h * 0.5;

    const W = 32;
    const H = 12;
    const canvas = doc.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, sx, sy, cropW, sh, 0, 0, W, H);
    const { data } = ctx.getImageData(0, 0, W, H); // 跨域污染时这里会抛

    let r = 0;
    let g = 0;
    let b = 0;
    let weight = 0;
    for (let i = 0; i < data.length; i += 4) {
        const px = rgbToHsl(data[i], data[i + 1], data[i + 2]);
        // 饱和度越高、越不接近纯黑纯白，权重越大
        const wgt = 0.12 + px.s * (1 - Math.abs(px.l - 0.5) * 1.6);
        r += data[i] * wgt;
        g += data[i + 1] * wgt;
        b += data[i + 2] * wgt;
        weight += wgt;
    }
    if (weight <= 0) return null;
    return mute(rgbToHsl(r / weight, g / weight, b / weight));
}

/**
 * 取卡面底色。先查缓存；没有就依次尝试候选地址。
 * @returns {Promise<{h:number,s:number,l:number}|null>}
 */
export async function getTone(doc, appid, urls, visibleRatio = 1.3) {
    const store = readStore();
    const cached = store[appid];
    if (Array.isArray(cached) && cached.length === 3) {
        return { h: cached[0], s: cached[1], l: cached[2] };
    }
    for (const url of urls ?? []) {
        try {
            const tone = await sample(doc, url, visibleRatio);
            if (!tone) continue;
            store[appid] = [Math.round(tone.h), +tone.s.toFixed(3), +tone.l.toFixed(3)];
            writeStore();
            return tone;
        } catch {
            // 换下一个候选
        }
    }
    return null;
}

/** 预览 / 自检用：清空缓存 */
export function clearToneCache() {
    memory = {};
    try {
        globalThis.localStorage?.removeItem(STORE_KEY);
    } catch {
        // ignore
    }
}
