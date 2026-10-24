/**
 * 成就收藏册 · 卡包主页面
 *
 * 页面按「可在任意容器内挂载」设计：入口的四个降级级别（见 mount.js）
 * 共用这一份 page.js，只是挂载点不同。
 *
 * 展示层只读 store，不认识任何 Steam API。
 * 页面本体是一本摊开的收藏册（book.js），这里只负责：
 *   · 状态页（读取中 / 等待数据 / 空 / 出错）画成一本合上的册子；
 *   · 把卡片交给 book 装订：
 *       最新优先按**完成时间倒序**（book 从 No.001 开始正序装订，最近完成的在最后）；
 *       顺序入册按**入册先后正序**（旧卡位置不变，新卡接在最后一页的空位）；
 *   · 完成日期是逐张补上来的：补的过程中只就地换那一张卡，
 *     全部补完后再重新装订一次，并把当前正在看的那张留在原处；
 *   · 新全成就的游戏先不放进册子，等它的完成日期到了，交给 book.introduce() 播入册动画，
 *     播完才记为「已入册」—— 中途离开的话，下次进来还会再播；
 *   · 翻到哪一页会记进缓存，下次进来摊开在同一页。
 */

import { getReact, getReactDom, getThemeOption, isPluginMode, ensureNodeStyles } from './env.js';
import * as store from './store.js';
import * as cache from './cache.js';
import { createBook } from './book.js';
import { yearKeyOf } from './yearpages.js';
import { tagged } from './utils.js';
import { STR } from './strings.js';

const out = tagged('page');

/* ── 订阅 store ─────────────────────────────────────────────────────────── */

function useStoreState() {
    const React = getReact();
    const [snapshot, setSnapshot] = React.useState(() => store.getState());

    React.useEffect(() => {
        const unsubscribe = store.subscribe(() => setSnapshot(store.getState()));
        return unsubscribe;
    }, []);

    return snapshot;
}

/* ── 纯 DOM 小工具 ──────────────────────────────────────────────────────── */

function el(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

/** 合上的册子 + 一句说明（可带一个按钮），用来渲染各种状态页 */
function renderStatePage(host, { title, desc, action }) {
    const doc = host.ownerDocument;
    const box = el(doc, 'div', 'ac-state__cover');
    box.append(el(doc, 'div', 'ac-state__badge', null));
    box.lastChild.setAttribute('aria-hidden', 'true');
    box.append(el(doc, 'div', 'ac-state__title', title));
    if (desc) box.append(el(doc, 'div', 'ac-state__desc', desc));
    if (action) {
        const actions = el(doc, 'div', 'ac-state__actions');
        const button = el(doc, 'button', 'ac-state__btn', action.label);
        button.type = 'button';
        button.addEventListener('click', action.onClick);
        actions.append(button);
        box.append(actions);
    }
    const wrap = el(doc, 'div', 'ac-state', null);
    wrap.append(box);
    host.replaceChildren(wrap);
    out.log(`状态页：${title}`);
}

function statePageProps(phase, state, onRetry) {
    switch (phase) {
        case 'not-ready':
            return {
                title: STR.page.notReadyTitle,
                desc: STR.page.notReadyDesc,
                action: { label: STR.page.notReadyRetry, onClick: onRetry },
            };
        case 'empty':
            return { title: STR.page.emptyTitle, desc: STR.page.emptyDesc };
        case 'error':
            return {
                title: STR.page.errorTitle,
                desc: state.error ?? STR.page.errorDescFallback,
                action: { label: STR.page.errorRetry, onClick: onRetry },
            };
        case 'loading':
        default:
            return { title: STR.page.loadingTitle, desc: STR.page.loadingDesc };
    }
}

/* ── 页面 ───────────────────────────────────────────────────────────────── */

/** 卡面上会画出来的那几样数据；变了才需要重画这张卡 */
function cardSignature(card) {
    return `${card.name}|${card.completedAt ?? ''}|${card.rare ?? ''}|${card.common ?? ''}|${card.unrated ?? ''}|${card.playtimeMin ?? ''}|${card.total ?? ''}|${JSON.stringify(card.art ?? null)}`;
}

const orderOf = (cards) => cards.map((c) => c.appid).join(',');

/** 主题设置「单页卡片数量」：只认 1 / 4，其余一律按 1 处理 */
const currentPerPage = () => (String(getThemeOption('单页卡片数量', '1')) === '4' ? 4 : 1);

/** 主题设置「卡册装订方式」：默认顺序入册；兼容英文旧值 */
const currentBinding = () => {
    const value = String(getThemeOption('卡册装订方式', '顺序入册'));
    return value === '最新优先' || value === 'newest' ? 'newest' : 'sequential';
};

/** 主题设置「扉页统计」：默认开启，只有明确关闭才隐藏 */
const currentTitleStats = () => String(getThemeOption('扉页统计', '开启')) !== '关闭';

/** 主题设置「年份特殊页」：默认关闭，只有明确开启才插入年份页 */
const currentYearPages = () => String(getThemeOption('年份特殊页', '关闭')) === '开启';

/** 分组依据的指纹：完成日期补上后年份会变，需要重新装订 */
const yearSignature = (cards) => cards.map((card) => `${card.appid}:${yearKeyOf(card)}`).join(',');

/* ── 手动补完成日期 ─────────────────────────────────────────────────────── */

const pad2 = (n) => String(n).padStart(2, '0');

/** 秒级时间戳 → 本地日期 YYYY-MM-DD（<input type="date"> 的格式） */
function isoDay(seconds) {
    const date = new Date(seconds * 1000);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 本地日期 YYYY-MM-DD → 秒级时间戳；不是合法日期或晚于今天就返回 null */
function secondsFromDay(value, today) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    // 本地中午：避免夏令时 / 时区把日期挪到前一天
    const date = new Date(year, month - 1, day, 12, 0, 0);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    if (String(value) > today) return null;
    return Math.floor(date.getTime() / 1000);
}

/** 弹窗里的一行：游戏名 + 日期输入 + 清除 */
function DateRow({ card, today, onSave, onClear }) {
    const React = getReact();
    const manual = card.completedAtSource === 'manual' ? card.completedAt : null;
    const [draft, setDraft] = React.useState(() => (manual ? isoDay(manual) : ''));

    // 清除 / 外部状态变化后，把输入框同步回当前真实值
    React.useEffect(() => {
        setDraft(manual ? isoDay(manual) : '');
    }, [manual]);

    const onChange = (event) => {
        const value = event.target.value;
        setDraft(value);
        const seconds = secondsFromDay(value, today);
        if (seconds != null) onSave(card.appid, seconds);
    };

    const name = card.name ?? `App ${card.appid}`;
    return React.createElement(
        'div',
        { className: 'ac-date-row', 'data-ac-manual': manual ? '' : null },
        React.createElement(
            'div',
            { className: 'ac-date-row__game' },
            React.createElement('span', { className: 'ac-date-row__name' }, name),
            React.createElement('span', { className: 'ac-date-row__meta' }, `#${card.appid}`),
            manual ? React.createElement('span', { className: 'ac-date-row__tag' }, STR.page.manualDatesManual) : null,
        ),
        React.createElement('input', {
            type: 'date',
            className: 'ac-date-row__input',
            value: draft,
            max: today,
            'aria-label': STR.page.manualDatesInput(name),
            onChange,
        }),
        React.createElement(
            'button',
            {
                type: 'button',
                className: 'ac-date-row__clear',
                disabled: !manual,
                onClick: () => onClear(card.appid),
            },
            STR.page.manualDatesClear,
        ),
    );
}

function DateModal({ cards, running, today, onSave, onClear, onClose }) {
    const React = getReact();
    const rows = [...cards].sort((a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN'),
    );

    return React.createElement(
        'div',
        {
            className: 'ac-date-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-labelledby': 'ac-date-title',
            onClick: (event) => {
                if (event.target === event.currentTarget) onClose();
            },
        },
        React.createElement(
            'div',
            { className: 'ac-date-modal__panel' },
            React.createElement('h2', { className: 'ac-date-modal__title', id: 'ac-date-title' }, STR.page.manualDatesTitle),
            React.createElement('p', { className: 'ac-date-modal__desc' }, STR.page.manualDatesDesc),
            running ? React.createElement('p', { className: 'ac-date-modal__hint' }, STR.page.manualDatesRunning) : null,
            rows.length === 0
                ? React.createElement('p', { className: 'ac-date-modal__empty' }, STR.page.manualDatesEmpty)
                : React.createElement(
                      'div',
                      { className: 'ac-date-modal__list' },
                      rows.map((card) =>
                          React.createElement(DateRow, {
                              key: card.appid,
                              card,
                              today,
                              onSave,
                              onClear,
                          }),
                      ),
                  ),
            React.createElement(
                'div',
                { className: 'ac-date-modal__foot' },
                React.createElement(
                    'button',
                    { type: 'button', className: 'ac-date-modal__close', onClick: onClose },
                    STR.page.manualDatesClose,
                ),
            ),
        ),
    );
}

/**
 * 顺序入册的次序：按「入册先后」排（旧的在前）。
 * 只把没见过的 appid 追加到缓存次序末尾 —— 已入册卡片的编号和位置永远不动，
 * 新卡自然落在最后一页的空卡槽里，填满后再开新页。
 *
 * @param {Array} cards 最新优先排好序的卡片
 * @param {boolean} persist false 时只算不写（首屏缓存阶段，等客户端数据到了再定次序）
 */
function sequentialOrder(cards, persist) {
    const history = cache.readOrder();
    const byAppid = new Map(cards.map((c) => [c.appid, c]));
    const kept = history.filter((appid) => byAppid.has(appid));
    const known = new Set(kept);
    const fresh = cards
        .filter((c) => !known.has(c.appid))
        .sort((a, b) => {
            const da = a.completedAt ?? Infinity;
            const db = b.completedAt ?? Infinity;
            if (da === db) return a.appid - b.appid;
            return da - db;
        });
    if (persist && fresh.length > 0) cache.writeOrder([...history, ...fresh.map((c) => c.appid)]);
    return [...kept.map((appid) => byAppid.get(appid)), ...fresh];
}

export function Page({ onClose } = {}) {
    const React = getReact();
    const state = useStoreState();
    const [, reloadOptions] = React.useState(0);
    const [dateOpen, setDateOpen] = React.useState(false);
    const hostRef = React.useRef(null);
    const bookRef = React.useRef(null);
    const builtRef = React.useRef({
        order: '',
        owner: '',
        state: '',
        perPage: 0,
        binding: '',
        showStats: null,
        yearPages: null,
        yearSig: '',
        manualRevision: 0,
    });
    /** 正在播的入册动画（一个令牌，防止旧书的回调影响新书） */
    const introRef = React.useRef(null);
    /** 上次离开时翻到哪一页；首次挂载从缓存读，之后每次翻页就地更新 */
    const positionRef = React.useRef(undefined);
    if (positionRef.current === undefined) positionRef.current = cache.readPosition();

    // 插件版：把样式补进卡册实际所在的文档（模态窗口 / 主窗口都可能不是模块自己的 document）。
    // 主题版没有注册 ensurer，这里什么也不做。
    React.useEffect(() => {
        ensureNodeStyles(hostRef.current);
    }, []);

    // 模态卡包必须能退出：Esc 与右上角的返回按钮走同一个 onClose。
    // 监听挂在卡册实际所在的窗口上 —— 模块自己的 window 未必是显示它的那个。
    React.useEffect(() => {
        if (typeof onClose !== 'function' && !dateOpen) return undefined;
        const win = hostRef.current?.ownerDocument?.defaultView;
        if (!win) return undefined;
        const onKeyDown = (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            // 补日期弹窗开着时 Esc 只关弹窗，不能把整个卡包一起关掉
            if (dateOpen) {
                event.preventDefault();
                setDateOpen(false);
                return;
            }
            if (typeof onClose !== 'function') return;
            // 年份选择器开着时 Esc 只关选择器，不能把整个卡包一起关掉
            if (hostRef.current?.querySelector('.ac-year-picker')) return;
            event.preventDefault();
            onClose();
        };
        win.addEventListener('keydown', onKeyDown, true);
        return () => win.removeEventListener('keydown', onKeyDown, true);
    }, [onClose, dateOpen]);

    // 首次挂载：读数据 + 取当前账号（再挂载时走 silent，避免用缓存先铺一层造成闪烁）
    React.useEffect(() => {
        const hasCards = store.getState().cards.length > 0;
        store.load({ silent: hasCards });
        store.loadOwner();
        return () => store.pause();
    }, []);

    // 插件版的设置面板改完立即生效：主题版也复用这一页，但没有这个事件时零副作用
    React.useEffect(() => {
        const onOptions = () => reloadOptions((n) => n + 1);
        window.addEventListener('ac:settings-changed', onOptions);
        return () => window.removeEventListener('ac:settings-changed', onOptions);
    }, []);

    const onRetry = React.useCallback(() => store.refresh(), []);

    React.useEffect(() => {
        const host = hostRef.current;
        if (!host) return;

        const byCompletion = store.selectVisibleCards();
        const binding = currentBinding();
        const ordered = binding === 'sequential' ? sequentialOrder(byCompletion, !state.fromCache) : byCompletion;
        const phase = state.phase === 'ready' && ordered.length === 0 ? 'empty' : state.phase;
        const perPage = currentPerPage();

        // 新收录、还没入册的卡先不放进册子（入册动画开始后由 book 自己接手）
        const pending = introRef.current ? new Set() : new Set(state.intro.appids);
        const shown = pending.size > 0 ? ordered.filter((c) => !pending.has(c.appid)) : ordered;

        const destroyBook = () => {
            bookRef.current?.destroy();
            bookRef.current = null;
            introRef.current = null;
            builtRef.current = {
                order: '',
                owner: '',
                state: '',
                perPage: 0,
                binding: '',
                showStats: null,
                yearPages: null,
                yearSig: '',
                manualRevision: 0,
            };
        };

        if (phase !== 'ready') {
            destroyBook();
            // 同一个状态页只画一次，别让每次 store 通知都重建 DOM
            if (builtRef.current.state !== phase) {
                const props = statePageProps(phase, state, onRetry);
                renderStatePage(host, props);
                builtRef.current.state = phase;
            } else if (phase === 'error') {
                // 错误信息可能变了，重画一次
                renderStatePage(host, statePageProps(phase, state, onRetry));
            }
            return;
        }

        const orderKey = orderOf(shown);
        const ownerKey = `${state.owner?.persona ?? ''}|${state.owner?.avatar ?? ''}`;
        const showStats = currentTitleStats();
        const yearPages = currentYearPages();
        const yearSig = yearPages ? yearSignature(shown) : '';

        if (
            bookRef.current &&
            (builtRef.current.owner !== ownerKey ||
                builtRef.current.perPage !== perPage ||
                builtRef.current.binding !== binding ||
                builtRef.current.showStats !== showStats ||
                builtRef.current.yearPages !== yearPages)
        ) {
            // 昵称/头像晚到了，或单页数量 / 装订方式 / 扉页统计 / 年份页改了：整册重画一次
            destroyBook();
        }

        if (!bookRef.current) {
            host.replaceChildren();
            bookRef.current = createBook(host, {
                cards: shown,
                owner: state.owner ?? {},
                perPage,
                binding,
                showStats,
                yearPages,
                yearSelections: cache.readYearSelections(),
                onYearChange: (yearKey, selection) => {
                    const all = cache.readYearSelections();
                    all[yearKey] = selection;
                    cache.writeYearSelections(all);
                },
                initial: positionRef.current,
                onPage: (position) => {
                    positionRef.current = position;
                    cache.writePosition(position);
                },
            });
            builtRef.current = {
                order: orderKey,
                owner: ownerKey,
                state: '',
                perPage,
                binding,
                showStats,
                yearPages,
                yearSig,
                manualRevision: state.manualRevision,
            };
            out.log(
                `收藏册已装订：${shown.length} 张卡（每页 ${perPage} 张，${binding === 'sequential' ? '顺序入册' : '最新优先'}${yearPages ? '，按年份分页' : ''}）`,
            );
        } else if (
            // 日期后台补全期间通常不重排（避免看着看着书页跳走）；
            // 但用户手动补了日期，就必须立刻按新日期重新装订。
            (!state.dates.running || state.manualRevision !== builtRef.current.manualRevision) &&
            (orderKey !== builtRef.current.order || (yearPages && yearSig !== builtRef.current.yearSig))
        ) {
            // 日期补完了，重新按完成时间 / 年份装订。
            // 还停在第一页（没翻过）就留在第一页；翻过了就把正在看的那张留在原处。
            const book = bookRef.current;
            const atStart = book.page === 0;
            book.replaceCards(shown, atStart ? { atStart } : { keepAppid: book.position.appid });
            builtRef.current.order = orderKey;
            builtRef.current.yearSig = yearSig;
            out.log('完成日期已补全，收藏册重新装订');
        } else {
            // 日期 / 稀有数 / 游戏名是逐张补上来的：只换变了的那几张卡，不重排
            const book = bookRef.current;
            const current = new Map(book.cards.map((c) => [c.appid, c]));
            for (const card of ordered) {
                const before = current.get(card.appid);
                if (before && cardSignature(before) !== cardSignature(card)) book.updateCard(card.appid, card);
            }
        }

        builtRef.current.manualRevision = state.manualRevision;

        // 新收录的完成日期有结果了：播入册动画
        if (pending.size > 0 && state.intro.ready) {
            const book = bookRef.current;
            const appids = [...pending];
            const token = {};
            introRef.current = token;
            builtRef.current.order = orderOf(ordered);
            builtRef.current.yearSig = yearPages ? yearSignature(ordered) : '';
            out.log(`新卡入册：${appids.join(', ')}`);
            book.introduce(ordered, appids).then((done) => {
                if (introRef.current !== token) return;
                introRef.current = null;
                if (done) store.markIntroduced(appids);
            });
        }
    });

    React.useEffect(
        () => () => {
            bookRef.current?.destroy();
            bookRef.current = null;
        },
        [],
    );

    const pluginMode = isPluginMode();

    // 补日期入口只在「后台已经确认取不到日期、现在仍然空着」的卡存在时出现；
    // 弹窗里同时列出手动填过的卡，方便就地修改。
    const unavailable = state.dates.unavailable ?? new Set();
    const needDate = state.cards.filter((c) => c.completedAt == null && unavailable.has(c.appid));
    const manualFilled = state.cards.filter((c) => c.completedAtSource === 'manual');
    const dateCards = [...new Map([...needDate, ...manualFilled].map((c) => [c.appid, c])).values()];
    const today = isoDay(Math.floor(Date.now() / 1000));

    React.useEffect(() => {
        // 刷新 / 换数据源时回到状态页，弹窗就失去意义了
        if (state.phase !== 'ready' && dateOpen) setDateOpen(false);
    }, [state.phase, dateOpen]);

    return React.createElement(
        'div',
        { className: 'ac-cardpack', 'data-ac': 'cardpack' },
        React.createElement('div', { className: 'ac-book-host', ref: hostRef, 'data-ac': 'book-host' }),
        React.createElement(
            'div',
            { className: 'ac-page-toolbar' },
            state.phase === 'ready' && needDate.length > 0
                ? React.createElement(
                      'button',
                      {
                          type: 'button',
                          className: 'ac-date-open',
                          title: STR.page.manualDatesTitle,
                          'aria-label': STR.page.manualDatesTitle,
                          onClick: () => setDateOpen(true),
                      },
                      STR.page.manualDatesButton,
                  )
                : null,
            pluginMode
                ? React.createElement(
                      'button',
                      {
                          type: 'button',
                          className: 'ac-plugin-settings',
                          title: '成就收藏册设置',
                          'aria-label': '打开成就收藏册设置',
                          onClick: () => window.dispatchEvent(new CustomEvent('ac:open-settings')),
                      },
                      '设置',
                  )
                : null,
            typeof onClose === 'function'
                ? React.createElement(
                      'button',
                      {
                          type: 'button',
                          className: 'ac-modal-close',
                          title: '返回 Steam',
                          'aria-label': '关闭成就卡包，返回 Steam',
                          onClick: onClose,
                      },
                      '← 返回',
                  )
                : null,
        ),
        dateOpen && state.phase === 'ready'
            ? React.createElement(DateModal, {
                  cards: dateCards,
                  running: state.dates.running,
                  today,
                  onSave: (appid, seconds) => store.setManualDate(appid, seconds),
                  onClear: (appid) => store.clearManualDate(appid),
                  onClose: () => setDateOpen(false),
              })
            : null,
    );
}

/** 供 mount.js 在降级 2（模态）里复用 */
export function renderInto(container) {
    const React = getReact();
    const ReactDOM = getReactDom();
    if (!React || !ReactDOM?.createRoot) return null;
    const root = ReactDOM.createRoot(container);
    root.render(React.createElement(Page));
    return root;
}

export const __debug = { out };
