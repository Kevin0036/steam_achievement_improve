/**
 * 新卡入册的音效：全部用代码合成，不带音频文件。
 *
 * 每种演出一段音效（档位划分见 introfx.js）：
 *   lightning —— 一声细小的电流掠过，接清脆的落卡声，尾巴是逐渐稀疏的噼啪
 *   fire     —— 火苗呼地窜起，落卡声偏闷，接一段轻轻的噼啪燃烧声
 *   standard —— 纸面滑过，接「嗒」的一声插入和一点清亮的余音
 *   heavy    —— 慢慢涌起的气息，接一声闷而稳的落定，再泛起三个温暖的音
 *
 * 徽章翻新（upgradefx.js）另有一段：拿起时一缕气流，每颗光球汇入一声铃音、音高一路往上走，
 * 最后一颗进去时一个明亮的和弦带一把细碎的闪光，放回卡槽时一声闷而稳的落定。
 * 它的时间点跟着光球的颗数变，所以按需渲染，不和上面四段一起预先生成。
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

/** 光球汇入时一颗比一颗高的音：E 大调五声音阶，从 B5 往上走一个半八度 */
const UPGRADE_NOTES = [987.77, 1108.73, 1244.51, 1479.98, 1661.22, 1975.53, 2217.46, 2489.02, 2959.96];

/**
 * 徽章翻新的音效。timeline 是 upgradeTimeline() 的结果，整段从演出开始的那一刻起算。
 * @returns {Float32Array}
 */
export function renderUpgradeSfx(rate, timeline) {
    const random = seededRandom(131);
    const sec = (ms) => ms / 1000;
    const out = new Float32Array(Math.round(rate * (sec(timeline.end) + 1.2)));
    const { arrivals, completeAt, landAt } = timeline;
    // 拿起来：一缕轻轻的气流
    addRustle(out, rate, random, { at: 0.02, dur: 0.75, attack: 0.3, release: 0.35, from: 700, to: 1600, q: 0.6, gain: 0.32, flutter: 0.2 });
    // 每颗汇入：一声短而亮的铃音，越往后越高
    arrivals.forEach((arrive, k) => {
        if (k === arrivals.length - 1) return;
        const step = arrivals.length <= 1 ? 0 : k / (arrivals.length - 1);
        const freq = UPGRADE_NOTES[Math.min(UPGRADE_NOTES.length - 1, Math.round(step * (UPGRADE_NOTES.length - 2)))];
        addBell(out, rate, { at: sec(arrive), freq, gain: 0.13 + 0.05 * step, decay: 0.16, rise: 0.004 });
        addBurst(out, rate, random, { at: sec(arrive), freq: 6500, q: 2, gain: 0.05, decay: 0.004, rise: 0.001 });
    });
    // 定型：E 大三和弦一个个泛起来，上面撒一把细碎的闪光
    const done = sec(completeAt);
    addBell(out, rate, { at: done, freq: 659.25, gain: 0.26, decay: 0.75, rise: 0.008 });
    addBell(out, rate, { at: done + 0.06, freq: 830.61, gain: 0.2, decay: 0.8, rise: 0.008 });
    addBell(out, rate, { at: done + 0.12, freq: 987.77, gain: 0.18, decay: 0.85, rise: 0.008 });
    addBell(out, rate, { at: done + 0.2, freq: 1318.51, gain: 0.14, decay: 0.9, rise: 0.008 });
    for (let i = 0; i < 16; i += 1) {
        const k = random() ** 1.4;
        addBell(out, rate, { at: done + 0.05 + k * 0.7, freq: 3000 + random() * 2600, gain: 0.04 * (1 - k * 0.7), decay: 0.05, rise: 0.002 });
    }
    // 放回卡槽：和厚重档同一种落定，轻一点
    const land = sec(landAt);
    addRustle(out, rate, random, { at: land - 0.5, dur: 0.5, attack: 0.36, release: 0.05, from: 500, to: 900, q: 0.6, gain: 0.3, flutter: 0.2 });
    addThump(out, rate, { at: land, from: 130, to: 64, gain: 0.7, decay: 0.11 });
    addBurst(out, rate, random, { at: land, freq: 460, q: 0.8, gain: 0.36, decay: 0.025, rise: 0.003 });
    return finish(out, rate, 0.36);
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

    /** 解锁音频上下文；解锁不了返回 false */
    async function ready() {
        if (closed || !ensure()) return false;
        if (ctx.state !== 'running') {
            await Promise.race([
                ctx.resume?.().catch?.(() => {}),
                new Promise((resolve) => win.setTimeout(resolve, UNLOCK_WAIT_MS)),
            ]);
        }
        return !closed && ctx.state === 'running';
    }

    return {
        /**
         * 徽章翻新的音效：从调用这一刻起按 timeline 播。解锁花掉的时间从开头跳过去，后面的点照样对得上。
         * 渲染要几十到上百毫秒，所以在第一个 await 之前同步做完：调用方趁卡片还没动的时候调，
         * 卡顿落在静止的画面上看不出来；放到动画开始以后再渲染，开头几帧就会卡一下。
         */
        async playUpgrade(timeline) {
            if (closed || !ensure()) return false;
            const samples = renderUpgradeSfx(ctx.sampleRate, timeline);
            const askedAt = win.performance.now();
            if (!(await ready())) return false;
            const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
            buffer.copyToChannel(samples, 0);
            const node = ctx.createBufferSource();
            node.buffer = buffer;
            node.connect(bus);
            node.start(ctx.currentTime, (win.performance.now() - askedAt) / 1000);
            return true;
        },

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
