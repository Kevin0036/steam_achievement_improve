/**
 * 借阅室的声音：背景音乐 + 拆信音效。客户端借阅室和网页版共用这一份。
 *
 * 音乐走 Web Audio 处理链，而不是直接放 <audio>，因为「翻开册子后变丰满」靠的是
 * 同一段音乐在两种混音之间过渡：
 *   房间（ROOM_MIX）—— 低通 + 高通 + 收窄声像，像隔着一层门听到的
 *   册子（BOOK_MIX）—— 全频、声像展开，补一点低频和空间感，音量也略高
 * iOS 的 audio.volume 是只读的，用 GainNode 同时也解决了手机上的音量问题。
 *
 * 音频文件不随插件分发：客户端从分享服务器串流，网页版从自己的站点取（src 由
 * borrowroom.js / viewer.js 传入），这样插件包不变大，换曲目也不用发版。音乐加载失败时只是没有音乐，音效不受影响。
 *
 * 浏览器要求用户手势后才能出声：第一次被拦下时等下一次点击或按键再开始。
 */

import { renderRoomImpulse, renderRoomSfx } from './roomsfx.js';

const STORE_KEY = 'ac:v1:room-sound';

const FADE_IN_TAU = 0.9; // 约 2.7 秒淡入到位
const FADE_OUT_TAU = 0.16;
const PAUSE_AFTER_MS = 700; // 淡出走完再暂停，免得切断尾音
const BLOOM_TAU = 1.05; // 约 3 秒展开，和开册转场一起走完
const SETTLE_TAU = 0.7;
const SFX_LEVEL = 0.62;

export const ROOM_MIX = Object.freeze({
    highpass: 170,
    lowpass: 1400,
    warmth: 0,
    width: 0.3,
    wet: 0.025, // 混响本身是立体声，给多了房间里的声像就收不窄
    level: 0.34,
});

export const BOOK_MIX = Object.freeze({
    highpass: 24,
    lowpass: 17000,
    warmth: 3.5,
    width: 1.2, // 比原曲略宽：声像矩阵在这里是负串扰
    wet: 0.2,
    level: 0.46,
});

function readEnabled(win) {
    try {
        return win.localStorage.getItem(STORE_KEY) !== '0';
    } catch {
        return true;
    }
}

function writeEnabled(win, enabled) {
    try {
        win.localStorage.setItem(STORE_KEY, enabled ? '1' : '0');
    } catch {
        /* 无痕 / 存储不可用时只在这次生效 */
    }
}

function createImpulseBuffer(ctx) {
    const [left, right] = renderRoomImpulse(ctx.sampleRate);
    const buffer = ctx.createBuffer(2, left.length, ctx.sampleRate);
    buffer.copyToChannel(left, 0);
    buffer.copyToChannel(right, 1);
    return buffer;
}

const centsFrom = (base, hz) => 1200 * Math.log2(hz / base);

/**
 * input → 高通 → 低通 → 低频搁架 → 声像矩阵 → 干声 / 混响 → 音量 → output
 *
 * 滤波器的扫频走 detune（音分）而不是 frequency（赫兹）：音分是对数刻度，
 * 过渡听起来是均匀打开的；直接扫赫兹会在开头一下子冲到高频。
 */
export function buildRoomChain(ctx, input, output, mix = ROOM_MIX) {
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = BOOK_MIX.highpass;
    highpass.Q.value = 0;

    const lowpass = ctx.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = BOOK_MIX.lowpass;
    lowpass.Q.value = 0;

    const warmth = ctx.createBiquadFilter();
    warmth.type = 'lowshelf';
    warmth.frequency.value = 220;

    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    const straight = [ctx.createGain(), ctx.createGain()];
    const crossed = [ctx.createGain(), ctx.createGain()];

    const dry = ctx.createGain();
    const send = ctx.createGain();
    const reverb = ctx.createConvolver();
    reverb.buffer = createImpulseBuffer(ctx);
    const level = ctx.createGain();

    input.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(warmth);
    warmth.connect(split);
    split.connect(straight[0], 0);
    split.connect(straight[1], 1);
    split.connect(crossed[0], 0);
    split.connect(crossed[1], 1);
    straight[0].connect(merge, 0, 0);
    straight[1].connect(merge, 0, 1);
    crossed[0].connect(merge, 0, 1);
    crossed[1].connect(merge, 0, 0);
    merge.connect(dry);
    merge.connect(send);
    send.connect(reverb);
    dry.connect(level);
    reverb.connect(level);
    level.connect(output);

    function apply(next, tau, at = ctx.currentTime) {
        const glide = (param, value) => {
            param.cancelScheduledValues(at);
            if (tau > 0) param.setTargetAtTime(value, at, tau);
            else param.setValueAtTime(value, at);
        };
        glide(highpass.detune, centsFrom(BOOK_MIX.highpass, next.highpass));
        glide(lowpass.detune, centsFrom(BOOK_MIX.lowpass, next.lowpass));
        glide(warmth.gain, next.warmth);
        const same = (1 + next.width) / 2;
        const other = (1 - next.width) / 2;
        straight.forEach((node) => glide(node.gain, same));
        crossed.forEach((node) => glide(node.gain, other));
        glide(send.gain, next.wet);
        glide(level.gain, next.level);
    }

    apply(mix, 0);
    return { apply };
}

/**
 * @param {object} options
 * @param {Document} options.doc     挂载文档（客户端是 Steam 主窗口）
 * @param {HTMLElement} [options.button] 声音开关
 * @param {string} options.src       背景音乐地址，需要允许跨域
 */
export function createRoomSound({ doc, button = null, src }) {
    const win = doc.defaultView ?? window;

    let enabled = readEnabled(win);
    let inRoom = false;
    let bookOpen = false;
    let destroyed = false;
    let musicFailed = false;
    let gestureArmed = false;
    let pauseTimer = 0;

    let ctx = null;
    let master = null;
    let sfxBus = null;
    let chain = null;
    let audio = null;
    let cueBuffers = null;

    function ensureContext() {
        if (ctx) return true;
        const AudioContextClass = win.AudioContext ?? win.webkitAudioContext;
        if (!AudioContextClass) return false;
        try {
            ctx = new AudioContextClass();
            master = ctx.createGain();
            master.gain.value = 0;
            master.connect(ctx.destination);
            sfxBus = ctx.createGain();
            sfxBus.gain.value = SFX_LEVEL;
            sfxBus.connect(ctx.destination);
            return true;
        } catch {
            ctx = null;
            return false;
        }
    }

    function ensureMusic() {
        if (audio) return true;
        if (musicFailed || !src || !ensureContext()) return false;
        try {
            const element = doc.createElement('audio');
            // 必须先设 crossOrigin 再设 src：否则跨域音频进 Web Audio 只剩静音
            element.crossOrigin = 'anonymous';
            element.loop = true;
            element.preload = 'auto';
            element.addEventListener('error', () => {
                musicFailed = true;
                console.warn('[成就收藏册] 借阅室背景音乐加载失败', src);
            });
            element.src = src;
            chain = buildRoomChain(ctx, ctx.createMediaElementSource(element), master, bookOpen ? BOOK_MIX : ROOM_MIX);
            audio = element;
            return true;
        } catch (err) {
            musicFailed = true;
            console.warn('[成就收藏册] 借阅室背景音乐初始化失败', err);
            return false;
        }
    }

    function fade(target, tau) {
        if (!master) return;
        const now = ctx.currentTime;
        master.gain.cancelScheduledValues(now);
        master.gain.setTargetAtTime(target, now, tau);
    }

    function disarmGesture() {
        if (!gestureArmed) return;
        gestureArmed = false;
        doc.removeEventListener('pointerdown', onGesture, true);
        doc.removeEventListener('keydown', onGesture, true);
    }

    function armGesture() {
        if (gestureArmed || destroyed) return;
        gestureArmed = true;
        doc.addEventListener('pointerdown', onGesture, true);
        doc.addEventListener('keydown', onGesture, true);
    }

    function onGesture() {
        disarmGesture();
        sync();
    }

    /** 把实际播放状态对齐到「开关开着、在房间里、页面可见」 */
    function sync() {
        if (destroyed) return;
        win.clearTimeout(pauseTimer);
        if (enabled && inRoom && !doc.hidden) {
            if (!ensureMusic()) return;
            ctx.resume?.().catch?.(() => {});
            // 被拦下时淡入不会偷跑：上下文挂起期间时钟不走，等手势解锁后才开始
            audio.play()?.catch?.((err) => {
                if (err?.name === 'NotAllowedError') armGesture();
            });
            if (ctx.state !== 'running') armGesture();
            fade(1, FADE_IN_TAU);
            return;
        }
        if (!ctx) return;
        fade(0, FADE_OUT_TAU);
        const element = audio;
        pauseTimer = win.setTimeout(() => element?.pause(), PAUSE_AFTER_MS);
    }

    function paintButton() {
        if (!button) return;
        const label = enabled ? '关闭声音' : '打开声音';
        button.classList.toggle('on', enabled);
        button.setAttribute('aria-pressed', String(enabled));
        button.setAttribute('aria-label', label);
        button.title = label;
        const text = button.querySelector('.rm-sound__label');
        if (text) text.textContent = enabled ? '声音' : '静音';
    }

    function onToggle() {
        enabled = !enabled;
        writeEnabled(win, enabled);
        paintButton();
        sync();
    }

    function cueBuffer(name) {
        if (!cueBuffers) {
            cueBuffers = {};
            for (const [key, samples] of Object.entries(renderRoomSfx(ctx.sampleRate))) {
                const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
                buffer.copyToChannel(samples, 0);
                cueBuffers[key] = buffer;
            }
        }
        return cueBuffers[name] ?? null;
    }

    paintButton();
    button?.addEventListener('click', onToggle);
    doc.addEventListener('visibilitychange', sync);

    return {
        /** 进入借阅室：音乐从静音淡入 */
        enter() {
            inRoom = true;
            sync();
        },

        /** 册子翻开 / 合上时在两种混音之间过渡 */
        setBookOpen(open) {
            const next = Boolean(open);
            if (next === bookOpen) return;
            bookOpen = next;
            chain?.apply(next ? BOOK_MIX : ROOM_MIX, next ? BLOOM_TAU : SETTLE_TAU);
        },

        /** 播一段拆信音效。只在用户拆信的路径上调用，取信失败时封蜡裂开不出声 */
        cue(name) {
            if (destroyed || !enabled || doc.hidden || !ensureContext()) return;
            const buffer = cueBuffer(name);
            if (!buffer) return;
            ctx.resume?.().catch?.(() => {});
            const node = ctx.createBufferSource();
            node.buffer = buffer;
            node.connect(sfxBus);
            node.start();
        },

        destroy() {
            if (destroyed) return;
            destroyed = true;
            disarmGesture();
            win.clearTimeout(pauseTimer);
            doc.removeEventListener('visibilitychange', sync);
            button?.removeEventListener('click', onToggle);
            if (!ctx) return;
            fade(0, FADE_OUT_TAU);
            const closing = ctx;
            const element = audio;
            // 客户端的 Steam 主窗口不会随借阅室关闭，音乐必须在这里确实停下、释放连接
            win.setTimeout(() => {
                if (element) {
                    element.pause();
                    element.removeAttribute('src');
                    element.load();
                }
                closing.close?.().catch?.(() => {});
            }, PAUSE_AFTER_MS);
        },
    };
}
