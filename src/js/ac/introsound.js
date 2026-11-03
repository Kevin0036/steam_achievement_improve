/**
 * 新卡入册的音效：全部用代码合成，不带音频文件。
 *
 * 每种演出一段音效（档位划分见 introfx.js）：
 *   lightning —— 一声细小的电流掠过，接清脆的落卡声，尾巴是逐渐稀疏的噼啪
 *   fire     —— 火苗呼地窜起，落卡声偏闷，接一段轻轻的噼啪燃烧声
 *   standard —— 纸面滑过，接「嗒」的一声插入和一点清亮的余音
 *   heavy    —— 慢慢涌起的气息，接一声闷而稳的落定，再泛起三个温暖的音
 *
 * 音效的目标是清脆但不吓人，所以：
 *   · 落点之前都有一小段预告（lead），声音不是凭空冒出来的；
 *   · 瞬态都带 1～2ms 的起音，避开「啪」的硬边；
 *   · 峰值压到 -12 dB 左右，比借阅室的拆信音效还轻一点；
 *   · 播不了就不播：上下文解锁不了时直接跳过，绝不留到之后才突然响。
 */

import { addBell, addBurst, addRustle, addThump, finish, seededRandom } from './roomsfx.js';

/** 每段音效里，落槽那一下距离开头多少毫秒 */
export const INTRO_LEAD = Object.freeze({ lightning: 120, fire: 600, standard: 300, heavy: 620 });

const OUTPUT_LEVEL = 0.68;
const UNLOCK_WAIT_MS = 80;

function renderLightning(rate) {
    const random = seededRandom(71);
    const out = new Float32Array(Math.round(rate * 1.6));
    const land = INTRO_LEAD.lightning / 1000;
    addRustle(out, rate, random, { at: 0, dur: 0.14, attack: 0.07, release: 0.05, from: 1800, to: 7000, q: 0.8, gain: 0.55, flutter: 0.3 });
    addBurst(out, rate, random, { at: land, freq: 4200, q: 1.4, gain: 0.9, decay: 0.006, rise: 0.0012 });
    addBell(out, rate, { at: land, freq: 2637, gain: 0.26, decay: 0.05 });
    // 电流游走：噼啪声越来越稀、越来越轻，和画面上的电弧一起散掉
    for (let i = 0; i < 34; i += 1) {
        const k = random() ** 1.7;
        addBurst(out, rate, random, {
            at: land + 0.02 + k * 1.3,
            freq: 5000 + random() * 4000,
            q: 2,
            gain: 0.17 * (1 - k * 0.8),
            decay: 0.0016,
            rise: 0.0004,
        });
    }
    return finish(out, rate, 0.34);
}

function renderFire(rate) {
    const random = seededRandom(61);
    const out = new Float32Array(Math.round(rate * 3));
    const land = INTRO_LEAD.fire / 1000;
    addRustle(out, rate, random, { at: 0, dur: 0.62, attack: 0.16, release: 0.28, from: 260, to: 1300, q: 0.55, gain: 0.8, flutter: 0.35 });
    addThump(out, rate, { at: land, from: 170, to: 80, gain: 0.5, decay: 0.07 });
    addBurst(out, rate, random, { at: land, freq: 2400, q: 1, gain: 0.55, decay: 0.009, rise: 0.0015 });
    // 燃烧：低沉的呼呼声打底，上面是木柴一样的噼啪，后半段慢慢熄灭
    addRustle(out, rate, random, { at: land, dur: 1.9, attack: 0.14, release: 1.2, from: 420, to: 240, q: 0.5, gain: 0.34, flutter: 0.6 });
    for (let i = 0; i < 46; i += 1) {
        const k = random() ** 1.3;
        addBurst(out, rate, random, {
            at: land + 0.04 + k * 1.9,
            freq: 1800 + random() * 3600,
            q: 1.6,
            gain: 0.2 * (1 - k * 0.85) * (0.4 + random() * 0.6),
            decay: 0.0024 + random() * 0.003,
            rise: 0.0005,
        });
    }
    return finish(out, rate, 0.34);
}

function renderStandard(rate) {
    const random = seededRandom(83);
    const out = new Float32Array(Math.round(rate * 0.86));
    const land = INTRO_LEAD.standard / 1000;
    addRustle(out, rate, random, { at: 0, dur: 0.32, attack: 0.18, release: 0.07, from: 1400, to: 3200, q: 0.7, gain: 0.5, flutter: 0.3 });
    addBurst(out, rate, random, { at: land, freq: 3200, q: 1.2, gain: 1, decay: 0.008, rise: 0.0015 });
    addThump(out, rate, { at: land, from: 240, to: 150, gain: 0.3, decay: 0.03 });
    addBell(out, rate, { at: land + 0.008, freq: 1760, gain: 0.24, decay: 0.12 });
    addBell(out, rate, { at: land + 0.012, freq: 2637, gain: 0.12, decay: 0.08 });
    return finish(out, rate, 0.36);
}

function renderHeavy(rate) {
    const random = seededRandom(97);
    const out = new Float32Array(Math.round(rate * 2.5));
    const land = INTRO_LEAD.heavy / 1000;
    addRustle(out, rate, random, { at: 0, dur: 0.64, attack: 0.44, release: 0.05, from: 500, to: 900, q: 0.6, gain: 0.5, flutter: 0.2 });
    addThump(out, rate, { at: land, from: 120, to: 58, gain: 1, decay: 0.13 });
    addBurst(out, rate, random, { at: land, freq: 420, q: 0.8, gain: 0.5, decay: 0.03, rise: 0.003 });
    addBell(out, rate, { at: land + 0.08, freq: 523.25, gain: 0.3, decay: 0.7, rise: 0.012 });
    addBell(out, rate, { at: land + 0.18, freq: 783.99, gain: 0.22, decay: 0.8, rise: 0.012 });
    addBell(out, rate, { at: land + 0.3, freq: 1046.5, gain: 0.13, decay: 0.9, rise: 0.012 });
    return finish(out, rate, 0.38);
}

/** 按采样率渲染全部音效，返回 { lightning, fire, standard, heavy }，每段是单声道 Float32Array */
export function renderIntroSfx(rate) {
    return { lightning: renderLightning(rate), fire: renderFire(rate), standard: renderStandard(rate), heavy: renderHeavy(rate) };
}

/** 一本册子一个实例：第一次入册时才创建音频上下文，平时不占资源 */
export function createIntroSound(win) {
    let ctx = null;
    let bus = null;
    let buffers = null;
    let closed = false;

    function ensure() {
        if (ctx) return true;
        const AudioContextClass = win.AudioContext ?? win.webkitAudioContext;
        if (!AudioContextClass) return false;
        try {
            ctx = new AudioContextClass();
            bus = ctx.createGain();
            bus.gain.value = OUTPUT_LEVEL;
            bus.connect(ctx.destination);
            return true;
        } catch {
            ctx = null;
            return false;
        }
    }

    function bufferFor(act) {
        if (!buffers) {
            buffers = {};
            for (const [key, samples] of Object.entries(renderIntroSfx(ctx.sampleRate))) {
                const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
                buffer.copyToChannel(samples, 0);
                buffers[key] = buffer;
            }
        }
        return buffers[act] ?? null;
    }

    return {
        /**
         * 排好一段音效，让落点对上 landInMs 之后的落槽。
         * 上下文解锁不了就放弃：这时候排上去，声音会等到下次解锁才突然响。
         */
        async play(act, landInMs) {
            if (closed || !ensure()) return false;
            const askedAt = win.performance.now();
            if (ctx.state !== 'running') {
                await Promise.race([
                    ctx.resume?.().catch?.(() => {}),
                    new Promise((resolve) => win.setTimeout(resolve, UNLOCK_WAIT_MS)),
                ]);
            }
            if (closed || ctx.state !== 'running') return false;
            const buffer = bufferFor(act);
            if (!buffer) return false;
            const node = ctx.createBufferSource();
            node.buffer = buffer;
            node.connect(bus);
            const elapsed = win.performance.now() - askedAt;
            const startIn = (landInMs - elapsed - INTRO_LEAD[act]) / 1000;
            if (startIn >= 0) node.start(ctx.currentTime + startIn);
            else node.start(ctx.currentTime, -startIn);
            return true;
        },

        destroy() {
            closed = true;
            ctx?.close?.().catch?.(() => {});
            ctx = null;
        },
    };
}
