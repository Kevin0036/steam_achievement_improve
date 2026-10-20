/**
 * 成就收藏册 · 通用工具
 *
 * 这里只放与 Steam 无关的纯工具。任何触及 Steam 内部标识的代码都不许进来。
 */

export const LOG_PREFIX = '[AC]';

/** 对象 / 数组转成一行 JSON —— Steam 的 console 日志里 [object Object] 什么也看不出 */
const fmt = (value) => {
    if (value === null || typeof value !== 'object') return value;
    try {
        return JSON.stringify(value, (key, v) => (typeof v === 'function' ? `[fn ${v.name || 'anonymous'}]` : v));
    } catch {
        return String(value);
    }
};

export const log = (...args) => console.log(LOG_PREFIX, ...args.map(fmt));
export const warn = (...args) => console.warn(LOG_PREFIX, ...args.map(fmt));
export const fail = (...args) => console.error(LOG_PREFIX, ...args.map(fmt));

/** 一次性初始化日志，便于在 CEF 控制台里一眼看清加载链路 */
export function banner(themeName, version) {
    log(
        `%c 成就收藏册 ${version} %c ${themeName} `,
        'background:#fed138;color:#241c02;font-weight:700;border-radius:3px 0 0 3px',
        'background:#3964ef;color:#fff;border-radius:0 3px 3px 0',
    );
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待某个条件成立，超时返回 null。绝不无限等待。 */
export async function waitFor(predicate, { timeout = 15000, interval = 120 } = {}) {
    const deadline = Date.now() + timeout;
    for (;;) {
        try {
            const value = predicate();
            if (value) return value;
        } catch {
            /* 探测函数自己抛错不算致命 */
        }
        if (Date.now() >= deadline) return null;
        await sleep(interval);
    }
}

/** rAF 节流：同一帧内多次调用只执行最后一次。 */
export function rafThrottle(fn) {
    let scheduled = 0;
    let lastArgs = null;

    const run = () => {
        scheduled = 0;
        const args = lastArgs;
        lastArgs = null;
        fn(...args);
    };

    return (...args) => {
        lastArgs = args;
        if (!scheduled) scheduled = requestAnimationFrame(run);
    };
}

export function debounce(fn, ms) {
    let timer = 0;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    };
}

/**
 * 统一的取消令牌。
 *
 * 任何异步操作开始时捕获当前代次，回调返回时如果代次已经变了就直接丢弃结果。
 * 触发递增的时机：页面卸载、路由离开、手动刷新、数据源切换。
 */
export class Generation {
    #value = 0;

    get current() {
        return this.#value;
    }

    bump() {
        this.#value += 1;
        return this.#value;
    }

    /** 返回一个「捕获了当前代次」的守卫 */
    guard() {
        const token = this.#value;
        return () => token === this.#value;
    }
}

/**
 * 资源清理注册表。
 *
 * 需求文档要求「不遗留持续运行的定时器、监听器或无效样式」。
 * 所有 Observer / listener / 注入节点 / <style> 都在这里登记，
 * 由顶层在 dispose 时统一收掉。
 */
export class Disposables {
    #items = new Set();

    add(fn) {
        if (typeof fn === 'function') this.#items.add(fn);
        return fn;
    }

    addObserver(observer) {
        return this.add(() => observer?.disconnect?.());
    }

    addListener(target, type, handler, options) {
        target?.addEventListener?.(type, handler, options);
        return this.add(() => target?.removeEventListener?.(type, handler, options));
    }

    addTimer(id) {
        return this.add(() => clearTimeout(id));
    }

    addInterval(id) {
        return this.#items.add(() => clearInterval(id));
    }

    addNode(node) {
        return this.add(() => node?.remove?.());
    }

    addStyle(id) {
        return this.add(() => document.getElementById(id)?.remove());
    }

    disposeAll() {
        for (const fn of this.#items) {
            try {
                fn();
            } catch (err) {
                warn('dispose 时出错', err);
            }
        }
        this.#items.clear();
    }
}

/* ── 格式化 ─────────────────────────────────────────────────────────────── */

export function formatMinutes(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const hours = minutes / 60;
    if (hours < 1) return `${Math.round(minutes)} 分钟`;
    if (hours < 100) return `${hours.toFixed(1)} 小时`;
    return `${Math.round(hours)} 小时`;
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
});

export function formatDate(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    try {
        return dateFormatter.format(new Date(seconds * 1000));
    } catch {
        return null;
    }
}

export function formatRelative(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const diff = Date.now() / 1000 - seconds;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
    return formatDate(seconds);
}

/** 统一的日志前缀，便于在控制台过滤 */
export function tagged(scope) {
    return {
        log: (...a) => log(`[${scope}]`, ...a),
        warn: (...a) => warn(`[${scope}]`, ...a),
        fail: (...a) => fail(`[${scope}]`, ...a),
    };
}