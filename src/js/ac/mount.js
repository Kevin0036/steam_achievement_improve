/**
 * 成就收藏册 · 功能 B 的入口注册（含四级降级）
 *
 * ── 为什么主选是 jsx-runtime 补丁 ────────────────────────────────────────
 * 已从 lib/millennium.dll 里核实 RouterHook 的两条硬约束：
 *   1. `addRoute` 注入的路由**永远被追加到最后**（processList 写 e[e.length]）；
 *   2. 库的内层路由表收到的 routes 参数是 `null`，
 *      所以 **`addRoute` 根本进不了库的子路由表**，只有 addPatch 生效。
 * 而 Steam 库的内层 Switch 最后一项是**无 path 的兜底 Route**
 * （react-router v5 的 Switch 不会把它当命中项，等于死代码）。
 * 所以我们不去碰路由注册表，而是直接对这一棵 JSX 树做最小追加：
 * 在库内层 Switch 的 children 里，往兜底 Route 之前插入我们的一条 Route。
 *
 * 这个手法在本机有先例：`achievement-groups` 插件就是用
 * `beforePatch(jsxRuntime, 'jsx'|'jsxs', cb)` 往游戏详情页的 tabs 数组里塞标签页的。
 *
 * 下拉菜单入口另有一层「菜单守护」：Supernav 的菜单实例在创建时就把 menuItems
 * 固定下来了，仅靠 jsx 渲染时机注入会出现「有时在、有时不在」；守护钩住
 * CreateContextMenuInstance / ShowMenu，在菜单真正创建或打开时补齐，见 installMenuGuard。
 *
 * ── 四级降级 ─────────────────────────────────────────────────────────────
 *   1  主选      jsx-runtime 追加 Route（保留侧栏与游戏列表）
 *   2  降级 1    routerHook.addPatch('/library', …) —— 会替换整个库外壳，
 *                侧栏与游戏列表都会被移除。**默认关闭**，需要在主题设置里显式打开。
 *   3  降级 2    showModal 打开模态卡包，不动路由，零侵入
 *   4  降级 3    功能 B 整体静默禁用，控制台留一条说明，Steam 库完全不受影响
 */

import { getReact, getPluginList, waitForGlobal, getThemeOption } from './env.js';
import { ROUTES, SUPERNAV_TITLE, isLibraryRouteSwitch, isLibrarySupernav, MENU } from './selectors.js';
import { Page } from './page.js';
import { banner, warn, fail, Disposables, tagged } from './utils.js';
import { STR } from './strings.js';

const out = tagged('mount');

/** 当前实际生效的降级级别，供 selftest 报告 */
const status = {
    level: 0,
    routeInjected: false,
    menuInjected: false,
    menuInjectFailed: false,
    menuGuardInstalled: false,
    gateInstalled: false,
    routeGuardInstalled: false,
    routeRepairs: 0,
    jsxReplacements: 0,
    error: null,
};

export const getMountStatus = () => ({ ...status });

/* ── jsx-runtime 探测器 ─────────────────────────────────────────────────── */

/** 检查 jsx/jsxs 是否被 Steam 换掉的间隔 */
const WATCHDOG_TICK_MS = 500;
/** 每 N 次检查重扫一次模块表，看有没有新的 jsx-runtime 出现 */
const SCAN_EVERY_TICKS = 20;
/** 路由缺失后连续多少个检查周期才动手修复，避开正常的页面切换过渡 */
const ROUTE_GUARD_MISSES = 2;
const ROUTE_GUARD_MS = 700;
/** 两次路由修复之间的冷却，避免修复失败时反复强制渲染 */
const ROUTE_REPAIR_COOLDOWN_MS = 3000;

/**
 * 判定一个模块是不是 react/jsx-runtime：必须同时提供可调用的 jsx 与 jsxs。
 * React 19 里这两个是同一个函数（`o.jsx = h, o.jsxs = h`），所以不能拿「两个函数不同」当判据。
 */
function isJsxRuntime(mod) {
    if (!mod) return false;
    try {
        return typeof mod.jsx === 'function' && typeof mod.jsxs === 'function';
    } catch {
        return false;
    }
}

/**
 * 找出模块表里**所有** jsx-runtime 模块。
 *
 * 这里刻意不只用 `findModuleByExport`（它只返回第一个命中）：Steam 的模块表里同时躺着
 * React 18 与 React 19 两份运行时，落在没有补丁的那一份上的子树对我们的注入完全不可见 ——
 * 表现正是「下拉菜单里的成就卡包有时在、有时不在」。所以把候选全部收齐、逐个挂钩。
 */
function findJsxRuntimes(api) {
    const list = [];
    const push = (mod) => {
        if (isJsxRuntime(mod) && !list.includes(mod)) list.push(mod);
    };

    try {
        if (typeof api.findAllModules === 'function') {
            // findAllModules 的回调收到的是「模块对象」，与 findModuleByExport 的 (导出值, 导出名) 不同
            for (const mod of api.findAllModules(isJsxRuntime) ?? []) push(mod);
        }
    } catch (err) {
        warn('findAllModules 查找 jsx-runtime 失败', err);
    }

    if (list.length === 0) {
        try {
            push(
                api.findModuleByExport?.(
                    (value, key) => (key === 'jsx' || key === 'jsxs') && typeof value === 'function',
                ),
            );
        } catch (err) {
            warn('findModuleByExport 查找 jsx-runtime 失败', err);
        }
    }
    return list;
}

/* ── 往 JSX 树里做最小追加 ──────────────────────────────────────────────── */

function injectRoute(type, props) {
    if (!isLibraryRouteSwitch(props)) return;

    const children = props.children;
    if (!Array.isArray(children)) return;
    if (children.some((child) => child?.props?.path === ROUTES.cardPack)) return;

    const Route = children[0]?.type;
    if (!Route) return;

    const React = getReact();
    if (!React) return;

    const element = React.createElement(
        Route,
        { key: 'ac-cardpack-route', path: ROUTES.cardPack },
        React.createElement(Page, null),
    );

    // 插到第一个「没有 path」的兜底 Route 之前 —— 这是库内层 Switch 的最后一项。
    // 虽然 react-router v5 不会让兜底项命中，但插在它前面语义上更正确，
    // 万一将来 Valve 给兜底加上 path，我们也不会被它抢走。
    const fallbackIndex = children.findIndex((child) => !child?.props?.path);
    if (fallbackIndex >= 0) children.splice(fallbackIndex, 0, element);
    else children.push(element);

    if (!status.routeInjected) out.log(`已把 ${ROUTES.cardPack} 追加进库内层路由表`);
    status.routeInjected = true;
}

/**
 * 给 Library Supernav 的固定 key。
 *
 * Supernav 的下拉菜单不是每次渲染都重新生成的：组件**第一次挂载**时就用当时的
 * menuItems 建好一个菜单实例（CreateContextMenuInstance，bRetainOnHide），之后一直复用，
 * 再也不读新的 menuItems（sp.js 里 `we = Ne => { …!fe.current && (fe.current = …) }`）。
 * Steam 启动时 Supernav 比主题脚本先挂载，于是菜单里一直是没有我们这一项的旧列表。
 *
 * 这一层做的是：第一次碰到它时给一个固定 key，强制 React 卸载重挂一次，
 * 让常驻菜单实例按带着我们这一项的新列表重建。它依赖「Supernav 至少再渲染一次」，
 * 所以只作为辅助；真正兜底的是下面的菜单管理器守护（与渲染时机无关）。
 */
const SUPERNAV_KEY = 'ac-library-supernav';

function injectMenuItem(type, props) {
    if (!isLibrarySupernav(props)) return;

    // React 19 的 jsx() 会从 config 上读 key，并且不会把它当成 prop 传下去
    if (props.key === undefined) props.key = SUPERNAV_KEY;

    // menuItems 每次渲染都是新数组，所以每次都要补；日志只打第一次
    const items = props.menuItems;
    if (items.some((item) => item?.route === ROUTES.cardPack)) return;
    items.push({ name: `${MENU.icon} ${STR.page.heading}`, route: ROUTES.cardPack });

    if (!status.menuInjected) out.log('已把「成就卡包」加入 Library Supernav 下拉菜单');
    status.menuInjected = true;
}

/* ── 菜单守护：与 React 渲染时机解耦 ───────────────────────────────────── */

/**
 * 为什么不能只靠 jsx 补丁：
 * Supernav 的菜单实例由 `CreateContextMenuInstance` 在**第一次挂载或第一次打开**时
 * 用当时的 menuItems 建好。保留模式（bRetainOnHide，小模式/无菜单管理器时）下实例常驻，
 * 永远不再读 menuItems；非保留模式下，点击处理器闭包里的也是**最近一次渲染**的列表。
 * 只要 Supernav 在补丁装好后没有重新渲染过，它手里的列表就没有我们这一项 ——
 * 表现正是「下拉菜单里的成就卡包有时在、有时不在」。
 *
 * 所以直接钩住上下文菜单管理器的两个方法（sp.js 模块 13240 / 3258 已核对）：
 *   CreateContextMenuInstance —— 菜单创建时补齐；
 *   ShowMenu                 —— 已存在的常驻实例在打开前就地替换它的 React 元素。
 * 这两个时机与 React 的渲染计划无关，菜单每次创建/打开都会经过。
 */
const MENU_GUARD = Symbol.for('ac.cardpack.menuGuard');

/** 菜单元素是不是 Library Supernav 的（看 items 里的 Home 路由，title 作为补充判据） */
function withCardPackItem(element, title) {
    const props = element?.props;
    if (!props || !Array.isArray(props.menuItems)) return element;

    const isLibrary =
        title === SUPERNAV_TITLE || props.menuItems.some((item) => item?.route === ROUTES.libraryHome);
    if (!isLibrary) return element;
    if (props.menuItems.some((item) => item?.route === ROUTES.cardPack)) return element;

    const React = getReact();
    if (!React?.cloneElement) return element;

    return React.cloneElement(element, {
        menuItems: [
            ...props.menuItems,
            { name: `${MENU.icon} ${STR.page.heading}`, route: ROUTES.cardPack },
        ],
    });
}

/** findModuleByExport 返回的是「模块的导出表」，从里面把目标导出值挑出来 */
function pickExport(mod, predicate) {
    if (!mod || typeof mod !== 'object') {
        return predicate(mod) ? mod : null;
    }
    for (const value of Object.values(mod)) {
        try {
            if (predicate(value)) return value;
        } catch {
            /* 忽略取属性时的异常 */
        }
    }
    return null;
}

function installMenuGuard(api, disposables) {
    let proto = null;

    try {
        const mod = api.findModuleByExport?.(
            (value) =>
                typeof value === 'function' &&
                value.prototype &&
                typeof value.prototype.CreateContextMenuInstance === 'function' &&
                typeof value.prototype.ShowMenu === 'function' &&
                typeof value.prototype.GetAllMenus === 'function',
        );
        const ctor = pickExport(
            mod,
            (value) =>
                typeof value === 'function' &&
                value.prototype &&
                typeof value.prototype.CreateContextMenuInstance === 'function' &&
                typeof value.prototype.ShowMenu === 'function' &&
                typeof value.prototype.GetAllMenus === 'function',
        );
        if (ctor?.prototype) proto = ctor.prototype;
    } catch (err) {
        warn('查找上下文菜单管理器类失败', err);
    }

    if (!proto) {
        // 退路：从窗口 → 管理器注册表取一个实例，再拿它的原型（同一个类）
        try {
            const mod = api.findModuleByExport?.(
                (value) =>
                    value &&
                    typeof value === 'object' &&
                    typeof value.GetContextMenuManagerFromWindow === 'function',
            );
            const registry = pickExport(
                mod,
                (value) =>
                    value &&
                    typeof value === 'object' &&
                    typeof value.GetContextMenuManagerFromWindow === 'function',
            );
            const manager = registry?.GetContextMenuManagerFromWindow?.(window);
            if (manager) proto = Object.getPrototypeOf(manager);
        } catch (err) {
            warn('从注册表获取菜单管理器失败', err);
        }
    }

    if (!proto) {
        warn('未找到上下文菜单管理器，菜单守护未安装（入口可能仍随渲染时机出现/消失）');
        return false;
    }

    if (proto[MENU_GUARD]) {
        status.menuGuardInstalled = true;
        return true;
    }

    const originalCreate = proto.CreateContextMenuInstance;
    const originalShow = proto.ShowMenu;
    if (typeof originalCreate !== 'function' || typeof originalShow !== 'function') {
        warn('菜单管理器原型缺少预期方法，菜单守护未安装');
        return false;
    }

    const token = {};

    proto.CreateContextMenuInstance = function (element, ...rest) {
        try {
            // 参数顺序：element, elementContext, clientX, clientY, options
            element = withCardPackItem(element, rest[3]?.title);
        } catch (err) {
            warn('菜单创建守护抛错（已吞下）', err);
        }
        return originalCreate.call(this, element, ...rest);
    };

    proto.ShowMenu = function (instance) {
        let repaired = false;

        try {
            const element = instance?.ReactElement;
            const next = withCardPackItem(element, instance?.options?.title);
            if (next !== element) {
                // 常驻实例的 ReactElement 只有 getter，直接换底层字段；
                // ShowMenu 随后会 Dispatch menus-changed，让弹层按新元素重渲染。
                instance.m_rctElement = next;
                repaired = true;
            }
        } catch (err) {
            warn('菜单打开守护抛错（已吞下）', err);
        }

        let wasActive = false;
        try {
            wasActive = this.ActiveMenu === instance;
        } catch {
            /* 忽略 */
        }

        const result = originalShow.call(this, instance);

        if (repaired && wasActive) {
            try {
                this.m_callbacksMenusChanged?.Dispatch?.();
            } catch {
                /* 忽略 */
            }
        }
        return result;
    };

    try {
        Object.defineProperty(proto, MENU_GUARD, { value: token, configurable: true });
    } catch {
        /* 标记失败不影响功能 */
    }

    disposables?.add?.(() => {
        if (proto[MENU_GUARD] !== token) return;
        proto.CreateContextMenuInstance = originalCreate;
        proto.ShowMenu = originalShow;
        try {
            delete proto[MENU_GUARD];
        } catch {
            /* 忽略 */
        }
    });

    status.menuGuardInstalled = true;
    out.log('已安装上下文菜单守护：「成就卡包」在菜单创建/打开时补齐');
    return true;
}

/* ── 降级 2：替换库外壳（默认关闭） ─────────────────────────────────────── */

function installLibraryGate(api) {
    const React = getReact();
    if (!React) return false;

    const enabled = String(getThemeOption('成就卡包：允许全屏式入口', 'no')) === 'yes';
    if (!enabled) {
        out.log('降级 1（替换库外壳）未启用；如主选方案失效，可在主题设置里打开它');
        return false;
    }

    try {
        api.routerHook.addPatch(
            ROUTES.libraryRoot,
            (props) => {
                const original = props.children;
                return {
                    children: React.createElement(Gate, { original }),
                };
            },
            api.EUIMode?.Desktop ?? 7,
        );
        status.gateInstalled = true;
        out.log("降级 1 已安装：/library 外壳被 Gate 包裹，进入卡包时会暂时移除库侧栏");
        return true;
    } catch (err) {
        warn('安装降级 1 失败', err);
        return false;
    }
}

/**
 * Gate：只在路径命中我们的页面时接管渲染。
 * 路径通过一个很短的有界轮询跟踪 —— Steam 的 pushState 不会触发 popstate。
 */
function Gate({ original }) {
    const React = getReact();
    const [mine, setMine] = React.useState(isOurPath);

    React.useEffect(() => {
        const timer = window.setInterval(() => setMine(isOurPath()), 250);
        return () => clearInterval(timer);
    }, []);

    if (!mine) return original ?? null;
    return React.createElement(
        'div',
        { className: 'ac-page-host', 'data-ac': 'page-host', style: { width: '100%', height: '100%' } },
        React.createElement(Page, null),
    );
}

function isOurPath() {
    try {
        return window.location.pathname.startsWith(ROUTES.cardPack);
    } catch {
        return false;
    }
}

/* ── 路由守护：路由表缺项时就地补回 ─────────────────────────────────────── */

/** 路由缺失在 DOM 上的体现：路径是我们的，但卡册根节点不存在 */
function hasAlbum() {
    try {
        return document.querySelector('[data-ac="cardpack"]') != null;
    } catch {
        return false;
    }
}

/** 从 #root 取 React 的 HostRoot fiber（Steam 的 React 挂载点） */
function getRootFiber() {
    try {
        const root = document.getElementById('root');
        if (!root) return null;
        const key = Object.keys(root).find((name) => name.startsWith('__reactContainer$'));
        const fiber = key ? root[key] : null;
        if (!fiber) return null;
        return fiber.current ?? fiber;
    } catch {
        return null;
    }
}

/**
 * 找库内层路由表（装着 /library/home 的那个 Switch）的 fiber。
 *
 * 用逐层广度优先而不是从某个 DOM 文本往上爬：「Unknown Route」是兜底 Route 的内容，
 * 本地化后未必还是这串英文；而 Switch 一定在库外壳里，几十层之内必能命中。
 * 层级上限与访问上限是为了在极端情况下不把主线程拖住。
 */
function findRouteSwitchFiber() {
    let level = [getRootFiber()];
    let visited = 0;

    for (let depth = 0; depth <= 40 && level.length > 0 && visited < 80000; depth += 1) {
        const next = [];
        for (const start of level) {
            if (!start) continue;
            for (let fiber = start; fiber; fiber = fiber.sibling) {
                visited += 1;
                try {
                    if (isLibraryRouteSwitch(fiber.memoizedProps)) return fiber;
                } catch {
                    /* 忽略取 props 时的异常 */
                }
                if (fiber.child) next.push(fiber.child);
            }
        }
        level = next;
    }
    return null;
}

/** 把缺失的 Route 直接补进 Switch 现有的 props，让下一次渲染就能命中 */
function injectRouteIntoFiber(fiber) {
    const props = fiber.memoizedProps;
    const children = props?.children;
    if (!Array.isArray(children)) return false;

    const exists = children.some((child) => child?.props?.path === ROUTES.cardPack);
    const pending = fiber.pendingProps;
    const pendingChildren = pending && pending !== props ? pending.children : null;
    const pendingExists =
        Array.isArray(pendingChildren) &&
        pendingChildren.some((child) => child?.props?.path === ROUTES.cardPack);
    if (exists && (pendingChildren === null || pendingExists)) return false;

    // Route 类型直接借自同一张路由表，保证 react-router 的 context 判定一致
    const Route = children[0]?.type;
    const React = getReact();
    if (!Route || !React?.createElement) return false;

    const element = React.createElement(
        Route,
        { key: 'ac-cardpack-route', path: ROUTES.cardPack },
        React.createElement(Page, null),
    );

    const insert = (list) => {
        if (!Array.isArray(list)) return;
        if (list.some((child) => child?.props?.path === ROUTES.cardPack)) return;
        const fallbackIndex = list.findIndex((child) => !child?.props?.path);
        if (fallbackIndex >= 0) list.splice(fallbackIndex, 0, element);
        else list.push(element);
    };

    insert(children);
    if (Array.isArray(pendingChildren)) insert(pendingChildren);
    return true;
}

/** 从一个 fiber 往上找最近的类组件，触发一次真正的重渲染 */
function forceFiberUpdate(fiber) {
    let node = fiber;
    for (let depth = 0; node && depth < 40; depth += 1) {
        const stateNode = node.stateNode;
        if (stateNode && typeof stateNode.forceUpdate === 'function') {
            try {
                stateNode.forceUpdate();
                return true;
            } catch {
                /* 换上一层再试 */
            }
        }
        node = node.return;
    }
    return false;
}

/**
 * 就地修复：Steam 若在补丁失效的窗口里建好了路由表，这个元素会一直被复用，
 * 单靠重新挂钩不会补上缺失的 Route —— 直接把 Route 插进它的 props 再强制渲染。
 */
function repairLibraryRoute() {
    const fiber = findRouteSwitchFiber();
    if (!fiber) return '未找到库内层路由表';

    const injected = injectRouteIntoFiber(fiber);
    if (!injected) {
        return forceFiberUpdate(fiber)
            ? '路由已在表中，已强制重渲染'
            : '路由已在表中，但未找到可重渲染的组件';
    }

    return forceFiberUpdate(fiber)
        ? '已补回缺失的 Route 并重渲染'
        : '已补回缺失的 Route（等待下一次渲染生效）';
}

/**
 * 路由守护：只在「已经在卡册路径上、但卡册没挂载」时动手。
 * 连续两个周期都没挂载才判定异常，避开正常页面切换的过渡帧；
 * 两次修复之间留冷却，避免修复失败时反复强制渲染。
 */
function installRouteGuard(verifyHooks, disposables) {
    let misses = 0;
    let lastRepairAt = 0;

    const tick = () => {
        if (!isOurPath() || hasAlbum()) {
            misses = 0;
            return;
        }

        misses += 1;
        if (misses < ROUTE_GUARD_MISSES) return;

        const now = Date.now();
        if (now - lastRepairAt < ROUTE_REPAIR_COOLDOWN_MS) return;
        lastRepairAt = now;
        misses = 0;

        try {
            // 先把可能被 Steam 换掉的 jsx 补丁重新挂上，再修已经建好的那棵路由表
            verifyHooks?.();
            const result = repairLibraryRoute();
            status.routeRepairs += 1;
            out.log(`[route-guard] 卡册路由缺失，已尝试修复：${result}`);
        } catch (err) {
            warn('[route-guard] 修复失败（已吞下）', err);
        }
    };

    const timer = window.setInterval(tick, ROUTE_GUARD_MS);
    disposables?.addInterval?.(timer);
    status.routeGuardInstalled = true;
    out.log('路由守护已安装：回到卡册时若路由表缺项，会就地补回');
}

/* ── 降级 3：模态 ───────────────────────────────────────────────────────── */

function openModal(api) {
    const React = getReact();
    if (!React) {
        fail('React 不可用，无法打开模态卡包');
        return false;
    }

    const owner = getPluginList()?.core?.mainWindow ?? window;
    try {
        api.showModal(React.createElement(Page, null), owner, {
            popupHeight: 820,
            popupWidth: 1280,
            bAllowFullSize: true,
        });
        out.log('降级 2：已用 showModal 打开卡包');
        return true;
    } catch (err) {
        warn('打开模态失败', err);
        return false;
    }
}

/* ── 主流程 ─────────────────────────────────────────────────────────────── */

export async function mount({ disposables } = {}) {
    const api = await waitForGlobal('MILLENNIUM_API', { timeout: 30000 });
    if (!api) {
        status.level = 4;
        status.error = 'MILLENNIUM_API 不可用';
        fail('MILLENNIUM_API 不可用，功能 B 整体禁用（Steam 库不受任何影响）');
        return status;
    }

    const handle = (type, props) => {
        try {
            injectRoute(type, props);
            injectMenuItem(type, props);
        } catch (err) {
            // 绝不让异常冒泡到 React 的渲染流程里 —— 那会影响整个 Steam 界面
            warn('jsx 补丁回调抛错（已吞下）', err);
        }
    };

    /** runtime 模块 → 它上面 jsx / jsxs 两个补丁的登记表 */
    const hooks = new Map();
    let lastReplaceLog = 0;

    /**
     * 用访问器守住 jsx / jsxs：Steam 在导航时会把这几个导出就地换成新函数，
     * 仅靠定时重挂会留下一个「换掉后、重挂前」的窗口；这个窗口里创建的路由表
     * 会永远缺我们的 Route（表现就是回库后 Unknown Route）。访问器让替换
     * 当场被重新包住，不再依赖轮询时机。
     */
    function installRuntimeHook(runtime, name) {
        let original = runtime[name];
        if (typeof original !== 'function') return null;
        let wrapped = null;

        const rebuild = () => {
            const fn = original;
            wrapped = function (...args) {
                try {
                    handle(args?.[0], args?.[1]);
                } catch (err) {
                    warn('jsx 补丁回调抛错（已吞下）', err);
                }
                return fn.apply(this, args);
            };
            try {
                Object.assign(wrapped, fn);
                wrapped.toString = () => fn.toString();
            } catch {
                /* 函数属性复制失败不影响调用 */
            }
        };
        rebuild();

        const descriptor = Object.getOwnPropertyDescriptor(runtime, name);
        const viaAccessor = !descriptor || descriptor.configurable;

        if (viaAccessor) {
            try {
                Object.defineProperty(runtime, name, {
                    configurable: true,
                    enumerable: descriptor?.enumerable ?? true,
                    get: () => wrapped,
                    set: (next) => {
                        if (typeof next !== 'function' || next === wrapped) return;
                        original = next;
                        rebuild();
                        status.jsxReplacements += 1;
                        const now = Date.now();
                        if (now - lastReplaceLog > 5000) {
                            lastReplaceLog = now;
                            out.log('jsx 运行时被替换，已自动重新包上补丁');
                        }
                    },
                });
            } catch (err) {
                warn(`用访问器守护 ${name} 失败`, err);
                return null;
            }
        } else if (descriptor?.writable) {
            runtime[name] = wrapped;
        } else {
            return null;
        }

        return {
            get current() {
                return wrapped;
            },
            get original() {
                return original;
            },
            restore() {
                try {
                    if (viaAccessor) {
                        Object.defineProperty(runtime, name, {
                            configurable: true,
                            enumerable: descriptor?.enumerable ?? true,
                            writable: true,
                            value: original,
                        });
                    } else if (runtime[name] === wrapped) {
                        runtime[name] = original;
                    }
                } catch {
                    /* 忽略 */
                }
            },
        };
    }

    function hookRuntime(runtime) {
        if (hooks.has(runtime)) return;
        const entry = { jsx: null, jsxs: null };
        for (const name of ['jsx', 'jsxs']) {
            try {
                entry[name] = installRuntimeHook(runtime, name);
            } catch (err) {
                warn(`挂钩 ${name} 失败`, err);
            }
        }
        if (entry.jsx || entry.jsxs) hooks.set(runtime, entry);
    }

    /** 供看门狗和路由守护共用：把被 Steam 换掉的导出立刻重新包住 */
    function verifyRuntimeHooks() {
        for (const [runtime, entry] of hooks) {
            for (const name of ['jsx', 'jsxs']) {
                const slot = entry[name];
                if (!slot) continue;
                let live;
                try {
                    live = runtime[name];
                } catch {
                    continue;
                }
                if (live === slot.current) continue;
                try {
                    entry[name] = installRuntimeHook(runtime, name);
                    status.jsxReplacements += 1;
                    out.log(`检测到 ${name} 被替换，已重新挂钩`);
                } catch (err) {
                    warn(`重新挂钩 ${name} 失败`, err);
                }
            }
        }
    }

    /** 模块表里可能还有没发现（或 Steam 整个换掉）的 jsx-runtime，补挂上 */
    function rescanRuntimeHooks() {
        for (const runtime of findJsxRuntimes(api)) {
            if (hooks.has(runtime)) continue;
            out.log('发现新的 jsx-runtime 模块，补挂钩');
            hookRuntime(runtime);
        }
    }

    function ensureRuntimeHooks() {
        verifyRuntimeHooks();
        rescanRuntimeHooks();
    }

    for (const runtime of findJsxRuntimes(api)) hookRuntime(runtime);

    if (hooks.size > 0) {
        status.level = 1;
        out.log(`已挂钩 react/jsx-runtime（共 ${hooks.size} 个模块）`);

        if (!installMenuGuard(api, disposables)) {
            // sp.js 尚未注册到上下文菜单模块时，过一会儿再试；装上就停
            let tries = 0;
            const retry = window.setInterval(() => {
                tries += 1;
                if (status.menuGuardInstalled || tries > 30) {
                    clearInterval(retry);
                    return;
                }
                installMenuGuard(api, disposables);
            }, 2000);
            disposables?.addInterval?.(retry);
        }

        let tick = 0;
        const watchdog = window.setInterval(() => {
            tick += 1;

            // 一：Steam 会把模块里的 jsx / jsxs 就地换掉，必须一直守着。
            // 之前只在启动后 90 秒内检查，之后导航时补丁会悄悄丢失，
            // 菜单项还在，但库内层路由表里已经没有我们的 Route —— 回到卡册就是 Unknown Route。
            verifyRuntimeHooks();

            // 二：模块表里可能还有我们没发现的 jsx-runtime（惰性加载的 chunk），定期补挂
            if (tick % SCAN_EVERY_TICKS === 0) rescanRuntimeHooks();
        }, WATCHDOG_TICK_MS);

        disposables?.addInterval?.(watchdog);
        out.log('jsx-runtime 守护持续运行：Steam 替换导出后会自动重挂');
        installRouteGuard(ensureRuntimeHooks, disposables);
        disposables?.add?.(() => {
            for (const entry of hooks.values()) {
                for (const name of ['jsx', 'jsxs']) {
                    try {
                        entry[name]?.restore?.();
                    } catch {
                        /* 忽略 */
                    }
                }
            }
        });

        return status;
    }

    // 主选不可用
    status.menuInjectFailed = true;
    warn('主选方案（jsx-runtime 追加路由）不可用，进入降级');

    if (installLibraryGate(api)) {
        status.level = 2;
        return status;
    }

    out.log('降级 2（模态）需要在用户点击入口时才能打开，注册一个全局入口');
    registerGlobalEntry(api, disposables);
    status.level = 3;
    return status;
}

/**
 * 主选与降级 1 都不可用时的兜底入口：
 * 用 routerHook.addGlobalComponent 挂一个小小的浮动按钮，
 * 点击后用 showModal 打开卡包。不动路由，零侵入。
 */
function registerGlobalEntry(api, disposables) {
    const React = getReact();
    if (!React || !api.routerHook?.addGlobalComponent) return;

    function EntryButton() {
        return React.createElement(
            'button',
            {
                type: 'button',
                className: 'ac-entry-btn',
                style: {
                    position: 'fixed',
                    right: '26px',
                    bottom: '26px',
                    zIndex: 2147483000,
                    height: '34px',
                    padding: '0 14px',
                    font: 'inherit',
                    fontWeight: 600,
                    color: '#fff',
                    cursor: 'pointer',
                    border: '1px solid rgba(255,255,255,0.14)',
                    borderRadius: '8px',
                    background: 'rgb(102,108,255)',
                    boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
                },
                onClick: () => openModal(api),
                title: '打开成就卡包',
            },
            `${MENU.icon} ${STR.page.heading}`,
        );
    }

    try {
        api.routerHook.addGlobalComponent(
            'AchievementCollectionEntry',
            EntryButton,
            api.EUIMode?.Desktop ?? 7,
        );
        disposables?.add?.(() => {
            try {
                api.routerHook.removeGlobalComponent?.('AchievementCollectionEntry', api.EUIMode?.Desktop ?? 7);
            } catch {
                /* 忽略 */
            }
        });
        out.log('降级 2：已注册全局入口按钮');
    } catch (err) {
        warn('注册全局入口失败', err);
    }
}

export const __debug = { status, isOurPath, injectRoute, injectMenuItem, openModal, repairLibraryRoute, SUPERNAV_TITLE };

/* ── 自启动 ─────────────────────────────────────────────────────────────── */

(async function bootstrap() {
    const VERSION = '1.0.2';

    try {
        banner(STR.theme, VERSION);
    } catch {
        /* 不影响功能 */
    }

    const disposables = new Disposables();

    try {
        // 主题设置：是否读取完成日期
        const datesEnabled = String(getThemeOption('成就卡包：读取完成日期', 'yes')) === 'yes';
        const storeModule = await import('./store.js');
        storeModule.setDatesEnabled(datesEnabled);
        if (!datesEnabled) out.log('完成日期读取已按主题设置关闭');

        await mount({ disposables });

        const { installSelfTest } = await import('./selftest.js');
        installSelfTest();

        // 把环境探测结果打出来 —— 初始化日志里就能看到实际命中路径
        const { snapshot } = await import('./env.js');
        out.log('环境探测', snapshot().hits);

        disposables.addListener(window, 'pagehide', () => {
            // 只暂停后台补全，**不**在这里卸载 jsx 补丁。
            // Steam 的窗口有时会触发 pagehide 而文档并没有真正卸载（放到后台又恢复），
            // 一旦 unpatched，下拉菜单里的入口就再也回不来了。
            storeModule.pause();
        });
    } catch (err) {
        // 绝不让异常冒泡到 Steam 的渲染流程里
        fail('初始化失败，功能 B 已停用（Steam 库本身不受影响）', err);
    }
})();