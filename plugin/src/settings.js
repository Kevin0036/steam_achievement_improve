/**
 * 插件版的设置存取。
 *
 * 主题版把选项放在 skin.json 的 Conditions 里，插件版没有那套配置，
 * 所以复用同一批选项名，存进 SharedJSContext 的 localStorage。
 * mode.js 在导入任何 ac 模块之前把它接成 getThemeOption 的 provider。
 */

export const OPTIONS = {
    perPage: '单页卡片数量',
    binding: '卡册装订方式',
    stats: '扉页统计',
    album: '册子风格',
    yearPages: '年份特殊页',
    yearIndex: '书口年份索引',
    yearTree: '年度之树',
    yearTarget: '年度目标款数',
    dates: '成就卡包：读取完成日期',
};

const BINDING_DEFAULT = '顺序入册';
/** 这里不能 import reading.js：mode.js 要在任何 ac 模块加载前接好 provider。款式表以 reading.js 为准 */
const ALBUM_IDS = ['grid', 'dots', 'astral', 'velvet'];

export const DEFAULTS = {
    [OPTIONS.perPage]: '1',
    [OPTIONS.binding]: BINDING_DEFAULT,
    [OPTIONS.stats]: '开启',
    [OPTIONS.album]: 'grid',
    [OPTIONS.yearPages]: '开启',
    [OPTIONS.yearIndex]: '开启',
    [OPTIONS.yearTree]: '关闭',
    [OPTIONS.yearTarget]: '15',
    [OPTIONS.dates]: 'yes',
};

/** 年度目标：5～50、步长 5 */
export function normalizeTarget(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '15';
    const clamped = Math.min(50, Math.max(5, number));
    return String(Math.min(50, Math.round(clamped / 5) * 5));
}

const STORAGE_KEY = 'ac:plugin:options:v1';
/** 旧版每次保存都会把当时的默认值一起写进去；这个标记表示存档已经按新默认迁移过 */
const BINDING_DEFAULT_KEY = 'ac:plugin:options:binding-default-v2';
const EVENT = 'ac:settings-changed';

function storage() {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function readOptions() {
    const store = storage();
    let saved = {};
    try {
        saved = JSON.parse(store?.getItem(STORAGE_KEY) || '{}') || {};
    } catch {
        saved = {};
    }
    const merged = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
        if (saved[key] !== undefined && saved[key] !== null) merged[key] = String(saved[key]);
    }
    if (merged[OPTIONS.perPage] !== '4') merged[OPTIONS.perPage] = '1';
    if (![ '最新优先', '顺序入册' ].includes(merged[OPTIONS.binding])) merged[OPTIONS.binding] = BINDING_DEFAULT;
    if (![ '开启', '关闭' ].includes(merged[OPTIONS.stats])) merged[OPTIONS.stats] = '开启';
    if (!ALBUM_IDS.includes(merged[OPTIONS.album])) merged[OPTIONS.album] = 'grid';
    if (![ '开启', '关闭' ].includes(merged[OPTIONS.yearPages])) merged[OPTIONS.yearPages] = '开启';
    if (![ '开启', '关闭' ].includes(merged[OPTIONS.yearIndex])) merged[OPTIONS.yearIndex] = '开启';
    if (![ '开启', '关闭' ].includes(merged[OPTIONS.yearTree])) merged[OPTIONS.yearTree] = '关闭';
    merged[OPTIONS.yearTarget] = normalizeTarget(merged[OPTIONS.yearTarget]);
    if (![ 'yes', 'no' ].includes(merged[OPTIONS.dates])) merged[OPTIONS.dates] = 'yes';

    // 1.1.1 起默认改为「顺序入册」。旧存档分不清「用户真的选过最新优先」还是
    // 只是被默认值顺带写进去的，所以第一次升级读取时统一按新默认，之后照常保存用户选择。
    let migrated = false;
    try {
        migrated = storage()?.getItem(BINDING_DEFAULT_KEY) === '2';
    } catch {
        migrated = false;
    }
    if (!migrated) merged[OPTIONS.binding] = BINDING_DEFAULT;
    return merged;
}

export function writeOptions(patch) {
    const next = { ...readOptions(), ...patch };
    try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify(next));
        storage()?.setItem(BINDING_DEFAULT_KEY, '2');
    } catch {
        /* 隐私模式 / 存储不可用时只在本次会话生效 */
    }
    try {
        window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
    } catch {
        /* 忽略 */
    }
    return next;
}

export function resetOptions() {
    try {
        storage()?.removeItem(STORAGE_KEY);
        storage()?.removeItem(BINDING_DEFAULT_KEY);
    } catch {
        /* 忽略 */
    }
    try {
        window.dispatchEvent(new CustomEvent(EVENT, { detail: readOptions() }));
    } catch {
        /* 忽略 */
    }
    return readOptions();
}
