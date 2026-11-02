/**
 * 借阅室的拆信音效与混响：全部用代码合成，不带任何音频文件。
 *
 * 四段音效分别对应拆信动画的四个节点，由调用方在动画开始的那一帧触发，
 * 所以「减弱动态效果」把动画压缩时声音也不会错位：
 *   crack —— 封蜡受力（.rm-seal.crack，0.24 秒抖动）：几下细碎的蜡裂声
 *   break —— 封蜡碎开（.rm-seal.brk）：一声脆响，带碎屑落下
 *   flap  —— 封舌翻开（.rm-mail.open，0.55 秒）：纸张掀起的沙沙声
 *   slide —— 信纸抽出（.rm-mail.hv，0.95 秒）：纸面摩擦滑出
 *
 * 随机数用固定种子，同样的采样率每次渲染结果完全一致。
 */

function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 可以逐采样改中心频率的带通（TPT 状态变量滤波器），峰值增益归一到 1 */
function createBandpass(rate, q) {
    const k = 1 / q;
    let ic1 = 0;
    let ic2 = 0;
    return (input, freq) => {
        const g = Math.tan((Math.PI * Math.min(freq, rate * 0.45)) / rate);
        const a1 = 1 / (1 + g * (g + k));
        const a2 = g * a1;
        const a3 = g * a2;
        const v3 = input - ic2;
        const v1 = a1 * ic1 + a2 * v3;
        const v2 = ic2 + a2 * ic1 + a3 * v3;
        ic1 = 2 * v1 - ic1;
        ic2 = 2 * v2 - ic2;
        return k * v1;
    };
}

/** 一小段指数衰减的带通噪声：蜡裂、碎屑、纸张落定都是它 */
function addBurst(out, rate, random, { at, freq, q, gain, decay }) {
    const start = Math.round(at * rate);
    const length = Math.min(out.length - start, Math.ceil(decay * rate * 8));
    const band = createBandpass(rate, q);
    for (let i = 0; i < length; i += 1) {
        const envelope = Math.exp(-i / (decay * rate));
        out[start + i] += band(random() * 2 - 1, freq) * envelope * gain;
    }
}

/** 音高下滑的低频：蜡块本身的重量感 */
function addThump(out, rate, { at, from, to, gain, decay }) {
    const start = Math.round(at * rate);
    const length = Math.min(out.length - start, Math.ceil(decay * rate * 7));
    let phase = 0;
    for (let i = 0; i < length; i += 1) {
        const t = i / rate;
        const freq = to + (from - to) * Math.exp(-t / (decay * 0.5));
        phase += (2 * Math.PI * freq) / rate;
        out[start + i] += Math.sin(phase) * Math.exp(-t / decay) * gain;
    }
}

/**
 * 纸张摩擦：带通噪声 + 不规则的起伏。flutter 越大起伏越明显，
 * 只有平滑噪声听起来是风声，起伏才让它像纸。
 */
function addRustle(out, rate, random, { at, dur, attack, release, from, to, q, gain, flutter }) {
    const start = Math.round(at * rate);
    const length = Math.min(out.length - start, Math.round(dur * rate));
    const band = createBandpass(rate, q);
    const smoothing = 1 - Math.exp((-2 * Math.PI * 90) / rate);
    let grain = 0.5;
    for (let i = 0; i < length; i += 1) {
        const t = i / rate;
        const progress = t / dur;
        const rise = Math.min(1, t / attack);
        const fall = Math.min(1, (dur - t) / release);
        grain += (random() - grain) * smoothing;
        const texture = 1 - flutter + flutter * Math.min(1, grain * 2);
        const freq = from * (to / from) ** progress;
        out[start + i] += band(random() * 2 - 1, freq) * rise * rise * fall * fall * texture * gain;
    }
}

/** 收尾：叠一点桌面的早期反射，归一到目标峰值，末端淡出防爆音 */
function finish(out, rate, peak) {
    for (const [delay, gain] of [[0.019, 0.24], [0.033, 0.15], [0.051, 0.09]]) {
        const offset = Math.round(delay * rate);
        for (let i = out.length - 1; i >= offset; i -= 1) out[i] += out[i - offset] * gain;
    }
    let max = 0;
    for (const value of out) max = Math.max(max, Math.abs(value));
    const scale = max > 0 ? peak / max : 0;
    const tail = Math.round(0.008 * rate);
    for (let i = 0; i < out.length; i += 1) {
        const left = out.length - 1 - i;
        out[i] *= scale * (left < tail ? left / tail : 1);
    }
    return out;
}

function renderCrack(rate) {
    const random = seededRandom(11);
    const out = new Float32Array(Math.round(rate * 0.34));
    for (const [at, gain] of [[0, 0.56], [0.038, 0.4], [0.094, 0.64], [0.156, 0.34]]) {
        addBurst(out, rate, random, {
            at,
            freq: 2600 + random() * 1700,
            q: 1.6,
            gain,
            decay: 0.006 + random() * 0.004,
        });
        addThump(out, rate, { at, from: 320, to: 210, gain: gain * 0.22, decay: 0.02 });
    }
    return finish(out, rate, 0.5);
}

function renderBreak(rate) {
    const random = seededRandom(23);
    const out = new Float32Array(Math.round(rate * 0.68));
    addBurst(out, rate, random, { at: 0, freq: 1500, q: 0.9, gain: 1, decay: 0.016 });
    addBurst(out, rate, random, { at: 0, freq: 5200, q: 1.2, gain: 0.7, decay: 0.004 });
    addBurst(out, rate, random, { at: 0.006, freq: 2900, q: 1, gain: 0.6, decay: 0.009 });
    addThump(out, rate, { at: 0, from: 190, to: 88, gain: 0.6, decay: 0.07 });
    // 蜡屑：越往后越轻、越稀
    for (let i = 0; i < 13; i += 1) {
        const at = 0.05 + random() ** 1.6 * 0.46;
        addBurst(out, rate, random, {
            at,
            freq: 3000 + random() * 4500,
            q: 2,
            gain: 0.2 * (1 - at / 0.6) * (0.5 + random() * 0.5),
            decay: 0.002 + random() * 0.003,
        });
    }
    return finish(out, rate, 0.8);
}

function renderFlap(rate) {
    const random = seededRandom(37);
    const out = new Float32Array(Math.round(rate * 0.6));
    addRustle(out, rate, random, {
        at: 0,
        dur: 0.5,
        attack: 0.09,
        release: 0.3,
        from: 800,
        to: 2600,
        q: 0.7,
        gain: 0.9,
        flutter: 0.55,
    });
    addBurst(out, rate, random, { at: 0.05, freq: 190, q: 0.8, gain: 0.5, decay: 0.09 }); // 掀起时带动的空气
    addBurst(out, rate, random, { at: 0.47, freq: 900, q: 1, gain: 0.25, decay: 0.02 }); // 封舌落定
    return finish(out, rate, 0.36);
}

function renderSlide(rate) {
    const random = seededRandom(53);
    const out = new Float32Array(Math.round(rate * 0.92));
    addRustle(out, rate, random, {
        at: 0,
        dur: 0.82,
        attack: 0.14,
        release: 0.42,
        from: 3600,
        to: 1900,
        q: 0.55,
        gain: 1,
        flutter: 0.35,
    });
    addRustle(out, rate, random, {
        at: 0.02,
        dur: 0.7,
        attack: 0.2,
        release: 0.4,
        from: 1200,
        to: 900,
        q: 0.8,
        gain: 0.45,
        flutter: 0.5,
    });
    return finish(out, rate, 0.28);
}

export const SFX_CUES = Object.freeze(['crack', 'break', 'flap', 'slide']);

/** 按采样率渲染四段音效，返回 { crack, break, flap, slide }，每段是单声道 Float32Array */
export function renderRoomSfx(rate) {
    return {
        crack: renderCrack(rate),
        break: renderBreak(rate),
        flap: renderFlap(rate),
        slide: renderSlide(rate),
    };
}

/** 小阅览室的脉冲响应：1.2 秒立体声衰减，高频比低频散得快。返回 [左, 右] */
export function renderRoomImpulse(rate) {
    const length = Math.round(rate * 1.2);
    const predelay = Math.round(rate * 0.014);
    return [101, 102].map((seed) => {
        const random = seededRandom(seed);
        const out = new Float32Array(length);
        let low = 0;
        for (let i = predelay; i < length; i += 1) {
            const t = (i - predelay) / rate;
            const cutoff = 1500 + 4500 * Math.exp(-t / 0.22);
            low += (random() * 2 - 1 - low) * (1 - Math.exp((-2 * Math.PI * cutoff) / rate));
            out[i] = low * Math.exp(-t / 0.34);
        }
        return out;
    });
}
