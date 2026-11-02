/**
 * 成就收藏册 · 封面取景
 *
 * 用户对「封面里露出哪一块」有最终解释权：正面允许 100%–120% 缩放 + 拖动；
 * 背面在「默认（铺满卡片，上下各裁约 3%）」和「拉伸（横向拉伸铺满）」之间二选一。
 *
 * 调整结果按 appid 存在 localStorage，卡片每次重建（翻页回收、补数据重画、导出）
 * 都会重新套用。这里只管理显示参数，不碰交互；长按右键的编辑器在 book.js。
 */

const KEY = 'ac:v1:cover';

export const FRONT_MIN = 1;
export const FRONT_MAX = 1.2;

const DEFAULT_FRONT = { s: 1, x: 0, y: 0 };
const DEFAULT_BACK = { mode: 'fit' };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value) => Math.round(value * 100) / 100;

/** @type {Map<number, {front?: object, back?: object}> | null} */
let records = null;
/** 只读场景（借阅室）的取景：整份来自快照，不读写访客本机记录 */
let overrides = null;

function load() {
    if (records) return records;
    records = new Map();
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) || 'null');
        if (parsed && typeof parsed === 'object') {
            for (const [key, value] of Object.entries(parsed)) {
                const appid = Number(key);
                if (!Number.isFinite(appid) || !value) continue;
                const front = sanitizeFront(value.front);
                const back = sanitizeBack(value.back);
                if (!front && !back) continue;
                records.set(appid, { ...(front ? { front } : {}), ...(back ? { back } : {}) });
            }
        }
    } catch {
        // 本地存储损坏时按「没有调整过」处理，不影响卡片显示
    }
    return records;
}

/** 正面取景框（插画区）的宽高比：卡片 5:7，插画占上方 60% 高 → 1 / 0.84 */
const FRAME_RATIO = 0.84;
/** 主视觉是 3:1 横图，取景框只露出中间约 38% 宽 */
const HERO_RATIO = 3.1;

/** 横向可移动余量（百分比相对图片自身宽度）。
    图片宽度相对取景框 = max(1, 原图宽高比 × 0.84) × 缩放，
    3:1 主视觉在 100% 时左右各能走约 31%，放大到 120% 约 34%。
    竖版兜底封面比例更窄，编辑器会按实际图片尺寸再收紧到 0。 */
function panLimitX(scale) {
    const over = Math.max(1, HERO_RATIO * FRAME_RATIO) * scale;
    return ((over - 1) / (2 * over)) * 100;
}

/** 纵向只有放大才有余量；(s-1)/(2s) 是刚好不露边界的位移 */
function panLimitY(scale) {
    if (scale <= 1) return 0;
    return ((scale - 1) / (2 * scale)) * 100;
}

function sanitizeFront(value) {
    if (!value) return null;
    const raw = Number(value.s);
    if (!Number.isFinite(raw)) return null;
    const s = round(clamp(raw, FRONT_MIN, FRONT_MAX));
    const limitX = panLimitX(s);
    const limitY = panLimitY(s);
    const x = round(clamp(Number(value.x) || 0, -limitX, limitX));
    const y = round(clamp(Number(value.y) || 0, -limitY, limitY));
    if (s === DEFAULT_FRONT.s && x === 0 && y === 0) return null;
    return { s, x, y };
}

/** 背面只有两种显示方式；旧版本存的缩放值读到这里会被丢弃，回落成默认 */
function sanitizeBack(value) {
    return value?.mode === 'stretch' ? { mode: 'stretch' } : null;
}

let persistTimer = 0;

function persist() {
    persistTimer = 0;
    try {
        const out = {};
        for (const [appid, value] of load()) out[appid] = value;
        if (Object.keys(out).length === 0) localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, JSON.stringify(out));
    } catch {
        // 不能写 localStorage 时调整只在本次运行内有效
    }
}

/** 拖动时每一帧都写 localStorage 会卡；攒一小会儿再落盘，退出编辑器时强制写 */
function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(persist, 260);
}

function writeSide(appid, side, value) {
    const map = load();
    const record = { ...(map.get(appid) ?? {}) };
    if (value) record[side] = value;
    else delete record[side];
    if (record.front || record.back) map.set(appid, record);
    else map.delete(appid);
    persistSoon();
}

/** 借阅室等只读场景：用快照里的取景覆盖本机记录；传 null 恢复本机记录 */
export function setCoverOverrides(map) {
    if (!map || typeof map !== 'object') {
        overrides = null;
        return;
    }
    const next = new Map();
    for (const [key, value] of Object.entries(map)) {
        const appid = Number(key);
        if (!Number.isFinite(appid) || !value) continue;
        const front = sanitizeFront(value.front);
        const back = sanitizeBack(value.back);
        if (!front && !back) continue;
        next.set(appid, { ...(front ? { front } : {}), ...(back ? { back } : {}) });
    }
    overrides = next;
}

function recordOf(appid) {
    const id = Number(appid);
    if (overrides) return overrides.get(id) ?? null;
    return load().get(id) ?? null;
}

/** @returns {{s:number,x:number,y:number}} 当前正面取景（永远返回可用的副本） */
export function getFront(appid) {
    return { ...DEFAULT_FRONT, ...(recordOf(appid)?.front ?? {}) };
}

/** @returns {{mode: string}} 当前背面显示方式（'fit' | 'stretch'） */
export function getBack(appid) {
    return { ...DEFAULT_BACK, ...(recordOf(appid)?.back ?? {}) };
}

/** 合并并夹紧正面参数，返回实际写入的值 */
export function setFront(appid, patch) {
    const next = sanitizeFront({ ...getFront(appid), ...patch }) ?? { ...DEFAULT_FRONT };
    writeSide(Number(appid), 'front', next.s === 1 && next.x === 0 && next.y === 0 ? null : next);
    return next;
}

/** 设置背面显示方式（'stretch' / 'fit'），返回实际写入的值 */
export function setBack(appid, mode) {
    const next = sanitizeBack({ mode }) ?? { ...DEFAULT_BACK };
    writeSide(Number(appid), 'back', next.mode === 'stretch' ? next : null);
    return next;
}

/** 重置某一面；返回重置后的值 */
export function resetCover(appid, side) {
    writeSide(Number(appid), side, null);
    return side === 'front' ? { ...DEFAULT_FRONT } : { ...DEFAULT_BACK };
}

/** 把已保存的取景套到一张卡上（cardNode 可以是整张 .ac-card，也可以是 .ac-cf / .ac-cb） */
export function applyCoverEdit(cardNode, appid) {
    const id = Number(appid);
    if (!Number.isFinite(id) || !cardNode?.querySelector) return;
    const front = cardNode.matches?.('.ac-cf') ? cardNode : cardNode.querySelector('.ac-cf');
    if (front) {
        const edit = getFront(id);
        front.style.setProperty('--ac-cover-s', String(edit.s));
        front.style.setProperty('--ac-cover-x', `${edit.x}%`);
        front.style.setProperty('--ac-cover-y', `${edit.y}%`);
        front.toggleAttribute('data-cover-adjusted', edit.s !== 1 || edit.x !== 0 || edit.y !== 0);
        return;
    }
    const back = cardNode.matches?.('.ac-cb') ? cardNode : cardNode.querySelector('.ac-cb');
    if (back) {
        const edit = getBack(id);
        back.toggleAttribute('data-cover-stretch', edit.mode === 'stretch');
    }
}

/** 离开编辑器时统一写一次（交互过程中已经写过，这里只兜底） */
export function flushCoverEdits() {
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = 0;
    }
    persist();
}
