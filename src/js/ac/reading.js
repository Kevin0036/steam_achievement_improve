/**
 * 卡包的「阅读设置」：书口年份索引 / 册子风格 / 年度之树 / 年度目标款数。
 *
 * 主题的 Millennium 设置只有下拉框，放不下 5～50、步长 5 的滑块，所以这三项
 * 放在卡包自己的设置面板里（readingpanel.js），存本机 localStorage。
 * 插件版没有这个面板时回落到插件设置（getThemeOption），缺省再用默认值。
 */

import { getThemeOption } from './env.js';

const KEY = 'ac:v1:reading';

export const TARGET_MIN = 5;
export const TARGET_MAX = 50;
export const TARGET_STEP = 5;
export const TARGET_DEFAULT = 15;

/**
 * 年度之树暂时收起：年份跨页前后两页已经换成月份足迹 / 本年目录（yearfill.js）。
 * treepage.js、设置项和提示都保留着，改成 true 就能恢复开关；
 * 收起期间 page.js 不再读 reading.tree，开过树的老用户也会直接换到新页面。
 */
export const TREE_FEATURE = false;

/** 册子风格：id 对应 albumstyles.css 的 data-album；grid 是不写属性的原版方格黑卡 */
export const ALBUM_DEFAULT = 'grid';
export const ALBUM_STYLES = Object.freeze([
    { id: 'grid', name: '方格黑卡' },
    { id: 'dots', name: '墨点手账' },
    { id: 'astral', name: '月相星图' },
    { id: 'velvet', name: '绿绒牌桌' },
]);

const normalizeAlbum = (value) => (ALBUM_STYLES.some((item) => item.id === value) ? value : ALBUM_DEFAULT);

const asBool = (value) => {
    if (typeof value === 'boolean') return value;
    const text = String(value ?? '').trim();
    if (text === '开启' || text === 'yes' || text === 'true' || text === '1') return true;
    if (text === '关闭' || text === 'no' || text === 'false' || text === '0') return false;
    return null;
};

/** 目标款数：夹到 5～50，再落到步长 5 的刻度上 */
export function normalizeTarget(value, fallback = TARGET_DEFAULT) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const clamped = Math.min(TARGET_MAX, Math.max(TARGET_MIN, number));
    return Math.min(TARGET_MAX, Math.round(clamped / TARGET_STEP) * TARGET_STEP);
}

function readSaved() {
    try {
        const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
        return saved && typeof saved === 'object' ? saved : {};
    } catch {
        return {};
    }
}

/** 当前生效的设置：本机面板 > 插件设置 > 默认（索引开、树关、目标 15、原版册子） */
export function readReading() {
    const saved = readSaved();
    const tabs = asBool(saved.tabs) ?? asBool(getThemeOption('书口年份索引', '开启')) ?? true;
    const tree = asBool(saved.tree) ?? asBool(getThemeOption('年度之树', '关闭')) ?? false;
    const target = normalizeTarget(saved.target ?? getThemeOption('年度目标款数', TARGET_DEFAULT));
    const album = normalizeAlbum(saved.album ?? getThemeOption('册子风格', ALBUM_DEFAULT));
    const introSound = asBool(saved.introSound) ?? asBool(getThemeOption('入册音效', '开启')) ?? true;
    return { tabs, tree, target, album, introSound };
}

/** 只写用户明确改的项；写完通知 page.js 重建册子 */
export function writeReading(patch) {
    const current = readReading();
    const next = {
        tabs: asBool(patch.tabs) ?? current.tabs,
        tree: asBool(patch.tree) ?? current.tree,
        target: patch.target === undefined ? current.target : normalizeTarget(patch.target, current.target),
        album: patch.album === undefined ? current.album : normalizeAlbum(patch.album),
        introSound: asBool(patch.introSound) ?? current.introSound,
    };
    try {
        localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        /* 无痕 / 存储不可用时只在本次会话生效 */
    }
    try {
        window.dispatchEvent(new CustomEvent('ac:settings-changed', { detail: next }));
    } catch {
        /* 忽略 */
    }
    return next;
}
