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
import { openBorrowRoom } from './borrowroom.js';
import { openExportDialog } from './export.js';
import {
    markOnboardingSeen,
    markTreeNoticeSeen,
    shouldShowOnboarding,
    shouldShowTreeNotice,
    showOnboarding,
    showTreeNotice,
} from './onboarding.js';
import { readReading, TREE_FEATURE } from './reading.js';
import { openReadingSettings } from './readingpanel.js';
import { yearKeyOf } from './yearpages.js';
import { sortCards } from './model.js';
import { createCardView, createYearSnapshot, sameYearSnapshot } from './view.js';
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

/** 分钟 → 时长输入框里的文本（保留一位小数；没有值就是空串） */
function hoursText(minutes) {
    if (!Number.isFinite(minutes) || minutes <= 0) return '';
    return String(Math.round(minutes / 6) / 10);
}

/** 时长输入框 → 分钟；空值 / 非法值 / 非正数返回 null */
function minutesFromHours(value) {
    const hours = Number(value);
    if (!Number.isFinite(hours) || hours <= 0) return null;
    return Math.max(1, Math.round(hours * 60));
}

/** 弹窗里的一行：游戏名 + 日期输入 + 时长输入 + 清除 */
function DateRow({ card, today, onSaveDate, onSaveTime, onClearTime, onClear, onRemove }) {
    const React = getReact();
    const manualDate = card.completedAtSource === 'manual' ? card.completedAt : null;
    const manualTime = card.playtimeSource === 'manual' ? card.playtimeMin : null;
    const [dateDraft, setDateDraft] = React.useState(() => (manualDate ? isoDay(manualDate) : ''));
    const [timeDraft, setTimeDraft] = React.useState(() => hoursText(manualTime));
    const [confirmRemove, setConfirmRemove] = React.useState(false);
    const [removing, setRemoving] = React.useState(false);
    const isExtra = card.source === 'manual-extra';

    // 清除 / 外部状态变化后，把输入框同步回当前真实值
    React.useEffect(() => {
        setDateDraft(manualDate ? isoDay(manualDate) : '');
    }, [manualDate]);

    React.useEffect(() => {
        setTimeDraft(hoursText(manualTime));
    }, [manualTime]);

    const onDateChange = (event) => {
        const value = event.target.value;
        setDateDraft(value);
        const seconds = secondsFromDay(value, today);
        if (seconds != null) onSaveDate(card.appid, seconds);
    };

    const onTimeChange = (event) => {
        const value = event.target.value;
        setTimeDraft(value);
        if (value.trim() === '') {
            if (manualTime != null) onClearTime(card.appid);
            return;
        }
        const minutes = minutesFromHours(value);
        if (minutes != null) onSaveTime(card.appid, minutes);
    };

    // 只输了不合法的内容就离开：退回当前的真实值
    const onTimeBlur = () => {
        if (timeDraft.trim() !== '' && minutesFromHours(timeDraft) == null) setTimeDraft(hoursText(manualTime));
    };

    // 「移除」要按两次：第一次只是把按钮换成确认文字，4 秒后自动收回
    React.useEffect(() => {
        if (!confirmRemove) return undefined;
        const timer = window.setTimeout(() => setConfirmRemove(false), 4000);
        return () => window.clearTimeout(timer);
    }, [confirmRemove]);

    const onRemoveClick = async () => {
        if (removing || !isExtra) return;
        if (!confirmRemove) {
            setConfirmRemove(true);
            return;
        }
        setRemoving(true);
        try {
            await onRemove?.(card.appid);
        } finally {
            setRemoving(false);
            setConfirmRemove(false);
        }
    };

    const name = card.name ?? `App ${card.appid}`;
    const manual = manualDate != null || manualTime != null;
    return React.createElement(
        'div',
        { className: 'ac-date-row', 'data-ac-manual': manual ? '' : null },
        React.createElement(
            'div',
            { className: 'ac-date-row__game' },
            React.createElement('span', { className: 'ac-date-row__name' }, name),
            React.createElement('span', { className: 'ac-date-row__meta' }, `#${card.appid}`),
            isExtra
                ? React.createElement('span', { className: 'ac-date-row__tag ac-date-row__tag--extra' }, STR.page.extraTag)
                : null,
            manual ? React.createElement('span', { className: 'ac-date-row__tag' }, STR.page.manualDatesManual) : null,
            isExtra
                ? React.createElement(
                      'button',
                      {
                          type: 'button',
                          className: 'ac-date-row__remove',
                          'data-ac-confirm': confirmRemove ? '' : null,
                          'aria-label': STR.page.extraRemoveFor(name),
                          title: STR.page.extraRemoveFor(name),
                          disabled: removing,
                          onClick: onRemoveClick,
                      },
                      confirmRemove ? STR.page.extraRemoveConfirm : STR.page.extraRemove,
                  )
                : null,
        ),
        React.createElement('input', {
            type: 'date',
            className: 'ac-date-row__input',
            value: dateDraft,
            max: today,
            'aria-label': STR.page.manualDatesInput(name),
            title: STR.page.manualDatesInput(name),
            onChange: onDateChange,
        }),
        React.createElement('input', {
            type: 'number',
            className: 'ac-date-row__input ac-date-row__input--hours',
            value: timeDraft,
            min: '0',
            step: '0.1',
            inputMode: 'decimal',
            placeholder: STR.page.manualTimesPlaceholder,
            'aria-label': STR.page.manualTimesInput(name),
            title: STR.page.manualTimesInput(name),
            onChange: onTimeChange,
            onBlur: onTimeBlur,
        }),
        React.createElement(
            'button',
            {
                type: 'button',
                className: 'ac-date-row__clear',
                'aria-label': STR.page.manualDatesClearFor(name),
                disabled: !manual,
                onClick: () => onClear(card.appid),
            },
            STR.page.manualDatesClear,
        ),
    );
}

function DateModal({
    cards,
    running,
    today,
    extraScan,
    autoScan,
    onSaveDate,
    onSaveTime,
    onClearTime,
    onClear,
    onRemoveExtra,
    onScan,
    onClose,
}) {
    const React = getReact();
    const rows = [...cards].sort((a, b) =>
        String(a.name ?? '').localeCompare(String(b.name ?? ''), 'zh-Hans-CN'),
    );
    const scan = extraScan ?? {
        running: false,
        finished: false,
        done: 0,
        total: 0,
        added: [],
        rejected: [],
        rejectedTotal: 0,
        unavailable: [],
    };
    const [extraNote, setExtraNote] = React.useState(null);

    const runScan = async () => {
        if (scan.running) return;
        setExtraNote(null);
        try {
            const result = await onScan();
            if (result?.ok === false) setExtraNote({ tone: 'error', text: STR.page.extraFailed });
        } catch (error) {
            out.log(`扫描库外游戏失败：${error?.message ?? error}`);
            setExtraNote({ tone: 'error', text: STR.page.extraFailed });
        }
    };

    // 从「收录库外」进来时自动扫一次；本册已经扫过就直接看上次结果
    const autoScanRef = React.useRef(false);
    React.useEffect(() => {
        if (!autoScan || autoScanRef.current) return;
        if (scan.running || scan.finished) return;
        autoScanRef.current = true;
        runScan();
    }, [autoScan, scan.running, scan.finished]);

    const scanResults = [];
    for (const item of scan.added) {
        scanResults.push(
            React.createElement(
                'li',
                { key: `added-${item.appid}`, 'data-tone': 'ok' },
                STR.page.extraScanAdded(item.name ?? `App ${item.appid}`),
            ),
        );
    }
    for (const item of scan.rejected) {
        scanResults.push(
            React.createElement(
                'li',
                { key: `rejected-${item.appid}`, 'data-tone': 'warn' },
                STR.page.extraScanRejected(
                    item.name ?? `App ${item.appid}`,
                    Number.isFinite(item.unlocked) ? item.unlocked : '?',
                    Number.isFinite(item.total) ? item.total : '?',
                ),
            ),
        );
    }
    for (const item of scan.unavailable) {
        scanResults.push(
            React.createElement(
                'li',
                { key: `unavailable-${item.appid}`, 'data-tone': 'warn' },
                STR.page.extraScanUnavailable(item.name ?? `App ${item.appid}`),
            ),
        );
    }

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
            React.createElement(
                'h2',
                { className: 'ac-date-modal__title', id: 'ac-date-title' },
                autoScan ? STR.page.extraTitle : STR.page.manualDatesTitle,
            ),
            React.createElement(
                'p',
                { className: 'ac-date-modal__desc' },
                autoScan ? STR.page.extraDesc : STR.page.manualDatesDesc,
            ),
            running ? React.createElement('p', { className: 'ac-date-modal__hint' }, STR.page.manualDatesRunning) : null,
            autoScan
                ? React.createElement(
                      'section',
                      { className: 'ac-extra' },
                      React.createElement(
                          'button',
                          {
                              type: 'button',
                              className: 'ac-extra__scan',
                              disabled: scan.running,
                              onClick: runScan,
                          },
                          scan.running ? STR.page.extraScanning(scan.done, scan.total) : STR.page.extraScan,
                      ),
                      extraNote
                          ? React.createElement('p', { className: 'ac-extra__note', 'data-tone': extraNote.tone }, extraNote.text)
                          : null,
                      scan.finished && scan.total === 0 && scanResults.length === 0
                          ? React.createElement('p', { className: 'ac-extra__note' }, STR.page.extraScanEmpty)
                          : null,
                      scan.finished && (scan.total > 0 || scanResults.length > 0)
                          ? React.createElement(
                                'p',
                                { className: 'ac-extra__note', 'data-tone': 'info' },
                                STR.page.extraScanDone(
                                    scan.added.length,
                                    scan.rejectedTotal ?? scan.rejected.length,
                                    scan.unavailable.length,
                                ),
                            )
                          : null,
                      scanResults.length > 0
                          ? React.createElement('ul', { className: 'ac-extra__results' }, scanResults)
                          : null,
                  )
                : null,
            rows.length === 0
                ? React.createElement('p', { className: 'ac-date-modal__empty' }, STR.page.manualDatesEmpty)
                : React.createElement(
                      React.Fragment,
                      null,
                      React.createElement(
                          'div',
                          { className: 'ac-date-modal__columns', 'aria-hidden': 'true' },
                          React.createElement('span', null, '游戏'),
                          React.createElement('span', null, '完成日期'),
                          React.createElement('span', null, STR.page.manualTimesPlaceholder),
                          React.createElement('span', null),
                      ),
                      React.createElement(
                          'div',
                          { className: 'ac-date-modal__list' },
                          rows.map((card) =>
                              React.createElement(DateRow, {
                                  key: card.appid,
                                  card,
                                  today,
                                  onSaveDate,
                                  onSaveTime,
                                  onClearTime,
                                  onClear,
                                  onRemove: onRemoveExtra,
                              }),
                          ),
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

export function Page({ onClose } = {}) {
    const React = getReact();
    const state = useStoreState();
    const [, reloadOptions] = React.useState(0);
    const [dateOpen, setDateOpen] = React.useState(false);
    const [dateAutoScan, setDateAutoScan] = React.useState(false);
    const [exportOpen, setExportOpen] = React.useState(false);
    const [guideOpen, setGuideOpen] = React.useState(false);
    const [settingsOpen, setSettingsOpen] = React.useState(false);
    const [noticeOpen, setNoticeOpen] = React.useState(false);
    const [borrowOpen, setBorrowOpen] = React.useState(false);
    /** 借阅室开着时不重装主册：只读册会临时接管全局封面取景 */
    const borrowOpenRef = React.useRef(false);
    const borrowRef = React.useRef(null);
    const borrowButtonRef = React.useRef(null);
    /** 挂载时是否还是第一次进入：新用户先看完整引导，不叠加「年度之树」尝鲜提示 */
    const newUserRef = React.useRef(null);
    if (newUserRef.current === null) newUserRef.current = shouldShowOnboarding();
    const hostRef = React.useRef(null);
    const bookRef = React.useRef(null);
    const viewRef = React.useRef(null);
    if (!viewRef.current) viewRef.current = createCardView({
        sortCards: cards => sortCards(cards, 'completed'),
        readOrder: () => cache.readOrder(),
        writeOrder: appids => cache.writeOrder(appids),
    });
    const shownRef = React.useRef(null);
    const appliedRef = React.useRef(null);
    const appliedCardsRef = React.useRef(new Map());
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const builtRef = React.useRef({
        order: null,
        owner: '',
        state: '',
        perPage: 0,
        binding: '',
        showStats: null,
        yearPages: null,
        yearTree: null,
        yearIndex: null,
        yearTarget: null,
        yearSig: null,
        yearCards: null,
        manualRevision: 0,
    });
    /** 正在播的入册动画（一个令牌，防止旧书的回调影响新书） */
    const introRef = React.useRef(null);
    /** 上次离开时翻到哪一页；首次挂载从缓存读，之后每次翻页就地更新 */
    const positionRef = React.useRef(undefined);
    if (positionRef.current === undefined) {
        // 缓存键按账号隔离，读页码前必须先确定当前账号
        store.ensureAccountScope();
        positionRef.current = cache.readPosition();
    }

    // 插件版：把样式补进卡册实际所在的文档（模态窗口 / 主窗口都可能不是模块自己的 document）。
    // 主题版没有注册 ensurer，这里什么也不做。
    React.useEffect(() => {
        ensureNodeStyles(hostRef.current);
    }, []);

    // 插件版：进入卡包时通知外层做一次更新检查；主题版没有监听者，零副作用。
    React.useEffect(() => {
        try {
            window.dispatchEvent(
                new CustomEvent('ac:cardpack-opened', { detail: { host: hostRef.current } }),
            );
        } catch {
            /* 忽略 */
        }
    }, []);

    // 模态卡包必须能退出：Esc 与右上角的返回按钮走同一个 onClose。
    // 监听挂在卡册实际所在的窗口上 —— 模块自己的 window 未必是显示它的那个。
    React.useEffect(() => {
        if (typeof onClose !== 'function' && !dateOpen) return undefined;
        const win = hostRef.current?.ownerDocument?.defaultView;
        if (!win) return undefined;
        const onKeyDown = (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            // 导出弹窗自己监听 Esc（关弹窗 / 取消导出），这里不能把它连同卡包一起关掉
            if (exportOpen) return;
            // 阅读设置面板自己处理 Esc，不能把整个卡包一起关掉
            if (settingsOpen) return;
            // 补日期弹窗开着时 Esc 只关弹窗，不能把整个卡包一起关掉
            if (dateOpen) {
                event.preventDefault();
                setDateOpen(false);
                return;
            }
            if (typeof onClose !== 'function') return;
            // 插件更新弹窗自己处理 Esc，不能把它连同卡包一起关掉
            if (hostRef.current?.ownerDocument?.querySelector('.ac-update')) return;
            // 借阅室自己处理 Esc（关设置 / 关借来的册子 / 关房间）
            if (hostRef.current?.ownerDocument?.querySelector('.ac-borrow')) return;
            // 封面取景 / 新手引导开着时 Esc 只关这一层
            if (hostRef.current?.querySelector('.ac-coveredit, .ac-onboarding')) return;
            // 年份选择器开着时 Esc 只关选择器，不能把整个卡包一起关掉
            if (hostRef.current?.querySelector('.ac-year-picker')) return;
            event.preventDefault();
            onClose();
        };
        win.addEventListener('keydown', onKeyDown, true);
        return () => win.removeEventListener('keydown', onKeyDown, true);
    }, [onClose, dateOpen, exportOpen, settingsOpen]);

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
        // 借阅室开着时主册暂停重装：借来的只读册会临时接管全局封面取景
        if (borrowOpenRef.current) return;

        const binding = currentBinding();
        const orderedView = viewRef.current.select(state.cards, {
            binding,
            persist: !state.fromCache,
            freezeOrder: state.dates.running,
            manualRevision: state.manualRevision,
        });
        const ordered = orderedView.cards;
        const phase = state.phase === 'ready' && ordered.length === 0 ? 'empty' : state.phase;
        const perPage = currentPerPage();

        const destroyBook = () => {
            bookRef.current?.destroy();
            bookRef.current = null;
            introRef.current = null;
            appliedRef.current = null;
            appliedCardsRef.current = new Map();
            builtRef.current = {
                order: null,
                owner: '',
                state: '',
                perPage: 0,
                binding: '',
                showStats: null,
                yearPages: null,
                yearTree: null,
                yearIndex: null,
                yearTarget: null,
                yearSig: null,
                yearCards: null,
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

        const ownerKey = `${state.owner?.persona ?? ''}|${state.owner?.avatar ?? ''}`;
        const showStats = currentTitleStats();
        const yearPages = currentYearPages();
        const reading = readReading();
        const yearTree = TREE_FEATURE && yearPages && reading.tree;
        const yearIndex = yearPages && reading.tabs;
        const yearTarget = reading.target;
        if (
            bookRef.current &&
            (builtRef.current.owner !== ownerKey ||
                builtRef.current.perPage !== perPage ||
                builtRef.current.binding !== binding ||
                builtRef.current.showStats !== showStats ||
                builtRef.current.yearPages !== yearPages ||
                builtRef.current.yearTree !== yearTree ||
                builtRef.current.yearIndex !== yearIndex ||
                builtRef.current.yearTarget !== yearTarget)
        ) {
            // 昵称/头像晚到了，或单页数量 / 装订方式 / 扉页统计 / 年份页 / 阅读设置改了：整册重画一次
            destroyBook();
        }

        // 设置重建可能中止正在播放的入册动画；按重建后的令牌重新隐藏待入册卡。
        const pendingIds = introRef.current ? null : state.intro.appids;
        let filtered = shownRef.current;
        if (!filtered || filtered.view !== orderedView || filtered.pendingIds !== pendingIds) {
            const pending = new Set(pendingIds ?? []);
            const ids = pending.size ? orderedView.ids.filter(id => !pending.has(id)) : orderedView.ids;
            const previousIds = filtered?.ids;
            filtered = { view: orderedView, pendingIds, pending,
                cards: pending.size ? ordered.filter(card => !pending.has(card.appid)) : ordered,
                ids: previousIds && ids.length === previousIds.length && ids.every((id, i) => id === previousIds[i]) ? previousIds : ids };
            shownRef.current = filtered;
        }
        const { cards: shown, pending, ids: orderKey } = filtered;
        const manualChanged = state.manualRevision !== builtRef.current.manualRevision;
        const deferYearRegroup = state.dates.running && !manualChanged;
        const yearChanged = bookRef.current && yearPages && !deferYearRegroup
            && (manualChanged || (
                shown !== builtRef.current.yearCards
                && !sameYearSnapshot(shown, builtRef.current.yearSig ?? [], yearKeyOf)
            ));

        if (!bookRef.current) {
            host.replaceChildren();
            bookRef.current = createBook(host, {
                cards: shown,
                owner: state.owner ?? {},
                perPage,
                binding,
                showStats,
                yearPages,
                yearTree,
                yearTargets: yearTarget,
                yearIndex,
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
                yearTree,
                yearIndex,
                yearTarget,
                yearSig: yearPages ? createYearSnapshot(shown, yearKeyOf) : null,
                yearCards: shown,
                manualRevision: state.manualRevision,
            };
            appliedRef.current = ordered;
            appliedCardsRef.current = new Map(shown.map(card => [card.appid, card]));
            out.log(
                `收藏册已装订：${shown.length} 张卡（每页 ${perPage} 张，${binding === 'sequential' ? '顺序入册' : '最新优先'}${yearPages ? `，按年份分页${yearTree ? `，年度之树目标 ${yearTarget}` : ''}${yearIndex ? '，书口年份索引' : ''}` : ''}）`,
            );
        } else if (
            // 日期后台补全期间通常不重排（避免看着看着书页跳走）；
            // 但用户手动补了日期，就必须立刻按新日期重新装订。
            orderKey !== builtRef.current.order || yearChanged
        ) {
            // 日期补完了，重新按完成时间 / 年份装订。
            // 还停在第一页（没翻过）就留在第一页；翻过了就把正在看的那张留在原处。
            const book = bookRef.current;
            const atStart = book.page === 0;
            book.replaceCards(shown, atStart ? { atStart } : { keepAppid: book.position.appid });
            builtRef.current.order = orderKey;
            builtRef.current.yearSig = yearPages ? createYearSnapshot(shown, yearKeyOf) : null;
            builtRef.current.yearCards = shown;
            appliedRef.current = ordered;
            appliedCardsRef.current = new Map(shown.map(card => [card.appid, card]));
            out.log('完成日期已补全，收藏册重新装订');
        } else if (appliedRef.current !== ordered) {
            // 日期 / 稀有数 / 游戏名是逐张补上来的：只换变了的那几张卡，不重排
            const book = bookRef.current;
            const current = appliedCardsRef.current;
            for (const card of ordered) {
                const before = current.get(card.appid);
                if (before && before !== card) {
                    book.updateCard(card.appid, card, { deferYearRegroup });
                    current.set(card.appid, card);
                }
            }
            appliedRef.current = ordered;
        }

        if (!deferYearRegroup) builtRef.current.yearCards = shown;

        builtRef.current.manualRevision = state.manualRevision;

        // 新收录的完成日期有结果了：播入册动画
        if (pending.size > 0 && state.intro.ready) {
            const book = bookRef.current;
            const appids = [...pending];
            const token = {};
            introRef.current = token;
            builtRef.current.order = orderedView.ids;
            builtRef.current.yearSig = yearPages ? createYearSnapshot(ordered, yearKeyOf) : null;
            builtRef.current.yearCards = ordered;
            appliedRef.current = ordered;
            appliedCardsRef.current = new Map(ordered.map(card => [card.appid, card]));
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

    // 第一次进入：等册子摊开、新卡入册播完，再把引导盖上去
    const introPending = state.intro.appids.length > 0;
    React.useEffect(() => {
        if (state.phase !== 'ready' || state.cards.length === 0 || introPending) return undefined;
        if (!shouldShowOnboarding()) return undefined;
        const timer = window.setTimeout(() => {
            setGuideOpen(true);
            markOnboardingSeen();
        }, 1200);
        return () => window.clearTimeout(timer);
    }, [state.phase, state.cards.length, introPending]);

    // 引导是纯 DOM 浮层，挂在册子的宿主上（和预览页共用同一份 onboarding.js）
    React.useEffect(() => {
        if (!guideOpen || state.phase !== 'ready') return undefined;
        const host = hostRef.current;
        if (!host) return undefined;
        const guide = showOnboarding(host, { yearPages: currentYearPages() }, { onClose: () => setGuideOpen(false) });
        return () => guide.destroy();
    }, [guideOpen, state.phase]);

    React.useEffect(() => {
        if (state.phase !== 'ready' && guideOpen) setGuideOpen(false);
    }, [state.phase, guideOpen]);

    // 1.1.6 年度之树尝鲜提示：只对升级上来的老用户弹一次；新用户先看完完整引导。
    // 已经自己打开过年度之树的用户也不用再提示。
    React.useEffect(() => {
        if (!TREE_FEATURE || newUserRef.current) return undefined;
        if (state.phase !== 'ready' || state.cards.length === 0 || introPending || guideOpen || noticeOpen) {
            return undefined;
        }
        if (!shouldShowTreeNotice()) return undefined;
        if (readReading().tree) {
            markTreeNoticeSeen();
            return undefined;
        }
        const timer = window.setTimeout(() => {
            markTreeNoticeSeen();
            setNoticeOpen(true);
        }, 900);
        return () => window.clearTimeout(timer);
    }, [state.phase, state.cards.length, introPending, guideOpen, noticeOpen]);

    // 尝鲜提示是纯 DOM 浮层；「去设置开启」关掉提示后打开阅读设置
    React.useEffect(() => {
        if (!noticeOpen || state.phase !== 'ready') return undefined;
        const host = hostRef.current;
        if (!host) return undefined;
        const notice = showTreeNotice(host, {
            onOpenSettings: () => {
                // 插件版的三项设置在插件面板里，主题版才用卡包自己的阅读设置
                if (isPluginMode()) window.dispatchEvent(new CustomEvent('ac:open-settings'));
                else setSettingsOpen(true);
            },
            onClose: () => setNoticeOpen(false),
        });
        return () => notice.destroy();
    }, [noticeOpen, state.phase]);

    React.useEffect(() => {
        if (state.phase !== 'ready' && noticeOpen) setNoticeOpen(false);
    }, [state.phase, noticeOpen]);

    // 阅读设置面板改一项就会重建册子（宿主会被清空），所以挂在册子宿主的父节点上
    React.useEffect(() => {
        if (!settingsOpen || state.phase !== 'ready') return undefined;
        const host = hostRef.current?.parentElement ?? hostRef.current;
        if (!host) return undefined;
        const panel = openReadingSettings(host, {
            onClose: () => setSettingsOpen(false),
            diagnostics: store.getDiagnostics,
            onExtraScan: () => {
                setDateAutoScan(true);
                setDateOpen(true);
            },
        });
        return () => panel.destroy();
    }, [settingsOpen, state.phase]);

    React.useEffect(() => {
        if (state.phase !== 'ready' && settingsOpen) setSettingsOpen(false);
    }, [state.phase, settingsOpen]);

    const pluginMode = isPluginMode();

    // 补日期入口只在「取不到日期 / 时长、现在仍然空着」的卡存在时出现；
    // 弹窗里同时列出手动填过的卡，方便就地修改。
    // 库外收录的卡始终列出：日期和时长都填好后还能在这里移除。
    const unavailable = state.dates.unavailable ?? new Set();
    const { needInfo, infoCards } = React.useMemo(() => {
        const needInfo = [], infoCards = [];
        for (const card of state.cards) {
            // 别的账号的卡是只读快照，补日期 / 时长只针对当前账号自己的卡
            if (card.source === 'external') continue;
            const missingDate = card.completedAt == null && unavailable.has(card.appid);
            const missingTime = card.playtimeMin == null;
            if (missingDate || missingTime) needInfo.push(card);
            if (
                missingDate
                || missingTime
                || card.completedAtSource === 'manual'
                || card.playtimeSource === 'manual'
                || card.source === 'manual-extra'
            ) {
                infoCards.push(card);
            }
        }
        return { needInfo, infoCards };
    }, [state.cards, unavailable]);
    const today = isoDay(Math.floor(Date.now() / 1000));

    React.useEffect(() => {
        // 刷新 / 换数据源时回到状态页，弹窗就失去意义了
        if (state.phase !== 'ready' && dateOpen) setDateOpen(false);
    }, [state.phase, dateOpen]);

    // 设置面板里的「导出印刷素材」：卡册页在册时由这里接手打开导出弹窗
    React.useEffect(() => {
        const onExport = (event) => {
            if (stateRef.current.phase !== 'ready') return;
            event.detail?.onOpen?.();
            setExportOpen(true);
        };
        window.addEventListener('ac:export-open', onExport);
        return () => window.removeEventListener('ac:export-open', onExport);
    }, []);

    // 设置面板里的「新手引导」：卡册页在册时由这里接手打开引导浮层
    React.useEffect(() => {
        const onGuide = (event) => {
            if (stateRef.current.phase !== 'ready' || stateRef.current.cards.length === 0) return;
            event.detail?.onOpen?.();
            setGuideOpen(true);
        };
        window.addEventListener('ac:onboarding-open', onGuide);
        return () => window.removeEventListener('ac:onboarding-open', onGuide);
    }, []);

    // 设置面板里的「收录库外游戏」：打开补日期弹窗并自动扫一次
    React.useEffect(() => {
        const onExtra = (event) => {
            if (stateRef.current.phase !== 'ready') return;
            event.detail?.onOpen?.();
            setDateAutoScan(true);
            setDateOpen(true);
        };
        window.addEventListener('ac:extra-open', onExtra);
        return () => window.removeEventListener('ac:extra-open', onExtra);
    }, []);

    // 导出弹窗挂到窗口顶层：设置面板可能是模态或快速访问，挂在卡册内部会被它挡住
    React.useEffect(() => {
        if (!exportOpen) return undefined;
        const doc = hostRef.current?.ownerDocument ?? document;
        const host = doc.createElement('div');
        host.className = 'ac-export-slot ac-export-slot--overlay';
        doc.body.append(host);
        const dialog = openExportDialog({
            host,
            cards: bookRef.current?.cards ?? [],
            owner: stateRef.current.owner ?? {},
            yearSelections: cache.readYearSelections(),
            binding: currentBinding(),
            yearPages: currentYearPages(),
            onClose: () => {
                setExportOpen(false);
            },
        });
        return () => {
            dialog?.close();
            host.remove();
        };
    }, [exportOpen]);

    React.useEffect(() => {
        if (state.phase !== 'ready' && exportOpen) setExportOpen(false);
    }, [state.phase, exportOpen]);

    // 借阅室：整窗覆盖（挂到窗口顶层，和导出弹窗同一套做法）。
    // 翻过借来的册子后，只读册留下的封面取景已经被清掉；
    // 主册在借阅室开着的这段时间暂停重装，关掉后重装一次，确保用的是自己的封面。
    React.useEffect(() => {
        if (!borrowOpen) return undefined;
        const doc = hostRef.current?.ownerDocument ?? document;
        try {
            borrowRef.current = openBorrowRoom({
                doc,
                trigger: borrowButtonRef.current,
                onClosed: ({ borrowed } = {}) => {
                    borrowOpenRef.current = false;
                    if (borrowed) {
                        bookRef.current?.destroy();
                        bookRef.current = null;
                    }
                    // 等借阅室自己淡出并销毁（约 200ms）再放开 React 这一侧，
                    // 否则 effect 清理会立刻把它删掉，淡出动画看不见。
                    window.setTimeout(() => setBorrowOpen(false), 240);
                },
            });
        } catch (error) {
            out.log(`借阅室打开失败：${error?.message ?? error}`);
            borrowOpenRef.current = false;
            setBorrowOpen(false);
        }
        return () => {
            borrowRef.current?.destroy();
            borrowRef.current = null;
            borrowOpenRef.current = false;
        };
    }, [borrowOpen]);

    React.useEffect(() => {
        if (state.phase === 'ready' || !borrowOpen) return;
        borrowOpenRef.current = false;
        setBorrowOpen(false);
    }, [state.phase, borrowOpen]);

    const openBorrow = React.useCallback(() => {
        if (borrowRef.current) return;
        borrowOpenRef.current = true;
        setBorrowOpen(true);
    }, []);

    // 册子风格挂在 .ac-cardpack 上：设置一改就重新渲染到这里，换款不用重建册子
    const { album } = readReading();

    return React.createElement(
        'div',
        { className: 'ac-cardpack', 'data-ac': 'cardpack', 'data-album': album && album !== 'grid' ? album : undefined },
        React.createElement('div', { className: 'ac-book-host', ref: hostRef, 'data-ac': 'book-host' }),
        React.createElement(
            'div',
            { className: 'ac-page-toolbar ac-page-toolbar--left' },
            state.phase === 'ready'
                ? React.createElement(
                      'button',
                      {
                          type: 'button',
                          className: 'ac-borrow-open',
                          title: '打开借阅室',
                          'aria-label': '打开借阅室',
                          ref: borrowButtonRef,
                          onClick: openBorrow,
                      },
                      '借阅室',
                  )
                : null,
        ),
        React.createElement(
            'div',
            { className: 'ac-page-toolbar' },
            state.phase === 'ready' && needInfo.length > 0
                ? React.createElement(
                      'button',
                      {
                          type: 'button',
                          className: 'ac-date-open',
                          title: STR.page.manualDatesTitle,
                          'aria-label': STR.page.manualDatesTitle,
                          onClick: () => {
                              setDateAutoScan(false);
                              setDateOpen(true);
                          },
                      },
                      STR.page.manualDatesButton,
                  )
                : null,
            React.createElement(
                'button',
                {
                    type: 'button',
                    className: 'ac-plugin-settings',
                    title: pluginMode ? '成就收藏册设置' : '阅读设置',
                    'aria-label': pluginMode ? '打开成就收藏册设置' : '打开阅读设置',
                    onClick: () => {
                        if (pluginMode) window.dispatchEvent(new CustomEvent('ac:open-settings'));
                        else setSettingsOpen(true);
                    },
                },
                '设置',
            ),
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
                  cards: infoCards,
                  running: state.dates.running,
                  today,
                  extraScan: state.extraScan,
                  autoScan: dateAutoScan,
                  onSaveDate: (appid, seconds) => store.setManualDate(appid, seconds),
                  onSaveTime: (appid, minutes) => store.setManualTime(appid, minutes),
                  onClearTime: (appid) => store.clearManualTime(appid),
                  onClear: (appid) => store.clearManualEntry(appid),
                  onRemoveExtra: (appid) => store.removeExtraGame(appid),
                  onScan: () => store.scanOutsideGames(),
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
