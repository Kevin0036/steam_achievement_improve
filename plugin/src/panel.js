/**
 * Millennium 侧栏 / 快速访问里的插件面板：卡包设置 + 发布页入口。
 *
 * 卡包本体仍然走同一份 Page/book 代码；这个面板只负责插件独有的几件事：
 *   · 没有主题 Conditions 时，给五个卡包选项提供入口；
 *   · 打开 GitHub 发布页（版本说明与安装包）；
 *   · 手动检查 / 安装插件更新。
 */

import { ensureNodeStyles, isOurThemeActive } from '../../src/js/ac/env.js';
import { getMountStatus, openCardPack } from '../../src/js/ac/mount.js';
import { clearAllManualEntries, getDiagnostics } from '../../src/js/ac/store.js';
import { openAccountsDialog } from '../../src/js/ac/accountsui.js';
import { copyText } from '../../src/js/ac/clipboard.js';
import { ALBUM_STYLES, TREE_FEATURE } from '../../src/js/ac/reading.js';
import { OPTIONS, readOptions, writeOptions, resetOptions } from './settings.js';
import { openReleasesPage } from './release.js';
import { checkNow } from './update.js';
import { PLUGIN_VERSION as VERSION } from './mode.js';

function row(React, label, hint, control, tag = null, modifier = null) {
    return React.createElement(
        'div',
        { className: modifier ? `ac-set__row ${modifier}` : 'ac-set__row' },
        React.createElement(
            'div',
            { className: 'ac-set__text' },
            React.createElement(
                'div',
                { className: 'ac-set__label' },
                React.createElement('b', null, label),
                tag ? React.createElement('em', { className: 'ac-set__tag' }, tag) : null,
            ),
            hint ? React.createElement('p', { className: 'ac-set__hint' }, hint) : null,
        ),
        control,
    );
}

function select(React, value, options, onChange, disabled) {
    return React.createElement(
        'select',
        {
            className: 'ac-plugin-select',
            value,
            disabled,
            onChange: (event) => onChange(event.target.value),
        },
        options.map(([key, text]) => React.createElement('option', { key, value: key }, text)),
    );
}

/** 与主题设置面板同一套开关样式（readingpanel.js 的 makeSwitch），样式直接复用 .ac-set__switch */
function toggle(React, label, checked, onChange, disabled) {
    return React.createElement(
        'button',
        {
            type: 'button',
            role: 'switch',
            className: 'ac-set__switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            disabled: Boolean(disabled),
            onClick: () => onChange(!checked),
        },
        React.createElement('i', { 'aria-hidden': 'true' }),
    );
}

/** 年度目标滑块：与主题面板一致的竖排结构（读数 / 滑块 / 两端刻度） */
function rangeRow(React, label, hint, value, onChange, disabled) {
    return React.createElement(
        'div',
        { className: 'ac-set__row ac-set__row--stack' },
        React.createElement(
            'div',
            { className: 'ac-set__text' },
            React.createElement('div', { className: 'ac-set__label' }, React.createElement('b', null, label)),
            React.createElement('p', { className: 'ac-set__hint' }, hint),
        ),
        React.createElement(
            'div',
            { className: 'ac-set__slider' },
            React.createElement('output', { className: 'ac-set__value' }, `${value} 款`),
            React.createElement('input', {
                type: 'range',
                className: 'ac-set__range',
                min: 5,
                max: 50,
                step: 5,
                value: Number(value),
                disabled: Boolean(disabled),
                'aria-label': label,
                onChange: (event) => onChange(event.target.value),
            }),
            React.createElement(
                'div',
                { className: 'ac-set__ticks', 'aria-hidden': 'true' },
                React.createElement('span', null, '5 款'),
                React.createElement('span', null, '50 款'),
            ),
        ),
    );
}

function buildPanelComponent(React) {
    const h = React.createElement;

    return function AchievementCollectionPanel() {
        const [options, setOptions] = React.useState(() => readOptions());
        const [mount, setMount] = React.useState(() => getMountStatus());
        const [openMessage, setOpenMessage] = React.useState('');
        const [dateMessage, setDateMessage] = React.useState('');
        const [extraMessage, setExtraMessage] = React.useState('');
        const [guideMessage, setGuideMessage] = React.useState('');
        const [exportMessage, setExportMessage] = React.useState('');
        const [updateMessage, setUpdateMessage] = React.useState('');
        const [diagMessage, setDiagMessage] = React.useState('');
        const rootRef = React.useRef(null);
        const themeActive = isOurThemeActive();

        // 面板可能渲染在 Millennium 侧栏、也可能是 showModal 的独立窗口，按实际文档补样式
        React.useEffect(() => {
            ensureNodeStyles(rootRef.current);
        }, []);

        React.useEffect(() => {
            const timer = setInterval(() => setMount(getMountStatus()), 1500);
            return () => clearInterval(timer);
        }, []);

        const patch = (key, value) => {
            setOptions(writeOptions({ [key]: value }));
        };

        const requestExport = () => {
            let handled = false;
            window.dispatchEvent(
                new CustomEvent('ac:export-open', {
                    detail: {
                        onOpen: () => {
                            handled = true;
                        },
                    },
                }),
            );
            setExportMessage(handled ? '' : '请先打开成就卡包，再从这里导出印刷素材。');
        };

        const requestOnboarding = () => {
            let handled = false;
            window.dispatchEvent(
                new CustomEvent('ac:onboarding-open', {
                    detail: {
                        onOpen: () => {
                            handled = true;
                        },
                    },
                }),
            );
            setGuideMessage(handled ? '' : '请先打开成就卡包，再从这里查看新手引导。');
        };

        const requestExtraScan = () => {
            let handled = false;
            window.dispatchEvent(
                new CustomEvent('ac:extra-open', {
                    detail: {
                        onOpen: () => {
                            handled = true;
                        },
                    },
                }),
            );
            setExtraMessage(handled ? '' : '请先打开成就卡包，再扫描库外游戏。');
        };

        const requestDiagnostics = async (event) => {
            const doc = event?.currentTarget?.ownerDocument ?? document;
            let line = '';
            try {
                line = String(getDiagnostics() ?? '').trim();
            } catch {
                line = '';
            }
            if (!line) {
                setDiagMessage('当前环境读不到 Steam 数据，请先打开成就卡包再试。');
                return;
            }
            const ok = await copyText(doc, line);
            setDiagMessage(ok ? `已复制：${line}` : `复制失败，请手动复制：${line}`);
        };

        const mountText = (() => {
            if (themeActive) return '检测到主题版：库内入口和设置由主题接管，插件不重复注入。';
            if (mount.level === 1) return '库内入口已就绪：Steam 库顶部菜单 →「★ 成就卡包」。';
            if (mount.level === 2) return '当前用模态模式打开卡包（兼容性降级）。';
            if (mount.level === 3) return '库内入口不可用；可以从本面板打开卡包。';
            if (mount.level === 4) return 'Steam 界面尚未就绪，稍后会自动重试。';
            return '正在等待 Steam 库加载…';
        })();

        return h(
            'div',
            { className: 'ac-plugin-panel', 'data-ac': 'plugin-panel', ref: rootRef },
            h(
                'header',
                { className: 'ac-plugin-head' },
                h('p', { className: 'ac-set__eyebrow' }, `插件版 · v${VERSION}`),
                h('h2', { className: 'ac-set__title' }, '插件设置'),
                h(
                    'p',
                    { className: 'ac-set__desc' },
                    '卡包选项、印刷素材与版本更新都在这里；改动立即生效，并保存在本机。',
                ),
            ),
            h(
                'div',
                { className: `ac-plugin-status${themeActive ? ' is-theme' : ''}` },
                h('span', { className: 'ac-plugin-status__dot', 'aria-hidden': 'true' }),
                mountText,
            ),
            h(
                'div',
                { className: 'ac-plugin-section' },
                h('h3', { className: 'ac-plugin-section__title' }, '卡包设置'),
                themeActive
                    ? h(
                          'div',
                          { className: 'ac-plugin-note' },
                          '当前由主题版的设置页接管。想在这里调整，请先在 Millennium 设置里换用其他主题。',
                      )
                    : null,
                row(
                    React,
                    '单页卡片数量',
                    '四张一页会等比缩小卡片，不改变卡片样式。',
                    select(
                        React,
                        options[OPTIONS.perPage],
                        [
                            ['1', '1 张'],
                            ['4', '4 张'],
                        ],
                        (value) => patch(OPTIONS.perPage, value),
                        themeActive,
                    ),
                    null,
                    'ac-plugin-row--select',
                ),
                row(
                    React,
                    '装订方式',
                    '顺序入册会保留旧卡的位置，新卡接在最后。',
                    select(
                        React,
                        options[OPTIONS.binding],
                        [
                            ['最新优先', '最新优先'],
                            ['顺序入册', '顺序入册'],
                        ],
                        (value) => patch(OPTIONS.binding, value),
                        themeActive,
                    ),
                    null,
                    'ac-plugin-row--select',
                ),
                row(
                    React,
                    '扉页统计',
                    '扉页头像下方的收藏卡 / 金杯 / 银杯合计。',
                    toggle(
                        React,
                        '扉页统计',
                        options[OPTIONS.stats] === '开启',
                        (checked) => patch(OPTIONS.stats, checked ? '开启' : '关闭'),
                        themeActive,
                    ),
                ),
                row(
                    React,
                    '册子风格',
                    '换一本册子的纸张、书皮和边框，立即生效。借阅给朋友时仍显示原版。',
                    select(
                        React,
                        options[OPTIONS.album],
                        ALBUM_STYLES.map((item) => [item.id, item.name]),
                        (value) => patch(OPTIONS.album, value),
                        themeActive,
                    ),
                    null,
                    'ac-plugin-row--select',
                ),
                row(
                    React,
                    '年份特殊页',
                    '按完成年份分组，每年开头插入四页：月份足迹、年份页、年度最爱和本年目录。',
                    toggle(
                        React,
                        '年份特殊页',
                        options[OPTIONS.yearPages] === '开启',
                        (checked) => patch(OPTIONS.yearPages, checked ? '开启' : '关闭'),
                        themeActive,
                    ),
                ),
                row(
                    React,
                    '书口年份索引',
                    '书口露出一列年份标签，点一下直接翻到那一年的年份页。需先开启年份特殊页。',
                    toggle(
                        React,
                        '书口年份索引',
                        options[OPTIONS.yearIndex] === '开启',
                        (checked) => patch(OPTIONS.yearIndex, checked ? '开启' : '关闭'),
                        themeActive || options[OPTIONS.yearPages] !== '开启',
                    ),
                ),
                TREE_FEATURE && row(
                    React,
                    '年度之树',
                    '用一棵随全成就款数生长的树代替月份足迹。需先开启年份特殊页。',
                    toggle(
                        React,
                        '年度之树',
                        options[OPTIONS.yearTree] === '开启',
                        (checked) => patch(OPTIONS.yearTree, checked ? '开启' : '关闭'),
                        themeActive || options[OPTIONS.yearPages] !== '开启',
                    ),
                    '实验',
                ),
                TREE_FEATURE && rangeRow(
                    React,
                    '年度目标',
                    '树的生长以这个款数为目标；达到后不再长高，超出部分只标「盈枝」。',
                    options[OPTIONS.yearTarget],
                    (value) => patch(OPTIONS.yearTarget, value),
                    themeActive || options[OPTIONS.yearTree] !== '开启',
                ),
                row(
                    React,
                    '入册音效',
                    '新卡落进卡槽时的轻声提示。',
                    toggle(
                        React,
                        '入册音效',
                        options[OPTIONS.introSound] === '开启',
                        (checked) => patch(OPTIONS.introSound, checked ? '开启' : '关闭'),
                        themeActive,
                    ),
                ),
                row(
                    React,
                    '读取完成日期',
                    '关闭后不补全每张卡的完成日期，打开卡包更快。',
                    toggle(
                        React,
                        '读取完成日期',
                        options[OPTIONS.dates] === 'yes',
                        (checked) => patch(OPTIONS.dates, checked ? 'yes' : 'no'),
                        themeActive,
                    ),
                ),
                row(
                    React,
                    '手动填写',
                    '手动补的完成日期与时长。清除后，能取到接口数据的游戏会恢复成接口值。',
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'ac-plugin-btn is-ghost',
                            disabled: themeActive,
                            onClick: () => {
                                const count = clearAllManualEntries();
                                setDateMessage(
                                    count > 0 ? `已清除 ${count} 张卡的手动填写。` : '当前没有手动填写的内容。',
                                );
                            },
                        },
                        '清除全部手动填写',
                    ),
                    null,
                    'ac-plugin-row--action',
                ),
                dateMessage ? h('div', { className: 'ac-plugin-note' }, dateMessage) : null,
                row(
                    React,
                    '收录库外游戏',
                    '已经不在库里的游戏（比如被移出家庭共享）不会出现在册子里。扫描玩过的游戏，Steam 确认成就全部解锁后才会自动收录。',
                    h(
                        'button',
                        { type: 'button', className: 'ac-plugin-btn is-ghost', onClick: requestExtraScan },
                        '扫描库外游戏',
                    ),
                    null,
                    'ac-plugin-row--action',
                ),
                extraMessage ? h('div', { className: 'ac-plugin-note' }, extraMessage) : null,
                row(
                    React,
                    '多账号管理',
                    '把小号等其它账号已经寄出的只读快照并进当前账号；同一款游戏以当前账号的卡为准，外部卡只在本机显示。',
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'ac-plugin-btn is-ghost',
                            onClick: () => {
                                const doc = rootRef.current?.ownerDocument ?? document;
                                openAccountsDialog(rootRef.current ?? doc.body, { mount: doc.body });
                            },
                        },
                        '管理',
                    ),
                    null,
                    'ac-plugin-row--action',
                ),
                row(
                    React,
                    '新手引导',
                    '跟着聚光灯重新认一遍翻页、书签、封面取景、月份足迹这些操作。',
                    h(
                        'button',
                        { type: 'button', className: 'ac-plugin-btn is-ghost', onClick: requestOnboarding },
                        '查看引导',
                    ),
                    null,
                    'ac-plugin-row--action',
                ),
                guideMessage ? h('div', { className: 'ac-plugin-note' }, guideMessage) : null,
                themeActive
                    ? null
                    : h(
                          'div',
                          { className: 'ac-plugin-actions' },
                          h(
                              'button',
                              {
                                  type: 'button',
                                  className: 'ac-plugin-btn is-primary',
                                  onClick: async () => {
                                      const ok = await openCardPack();
                                      setOpenMessage(ok ? '' : '打开失败：Steam 的模态接口不可用。');
                                  },
                              },
                              '打开成就卡包',
                          ),
                          h(
                              'button',
                              { type: 'button', className: 'ac-plugin-btn is-ghost', onClick: () => setOptions(resetOptions()) },
                              '恢复默认设置',
                          ),
                      ),
                openMessage ? h('div', { className: 'ac-plugin-note is-error' }, openMessage) : null,
            ),
            h(
                'div',
                { className: 'ac-plugin-section' },
                h('h3', { className: 'ac-plugin-section__title' }, '印刷素材'),
                h(
                    'div',
                    { className: 'ac-plugin-note' },
                    '导出成就卡片（正反面 + 烫金层）、年度最爱票根和年份页徽章邮票；300 DPI，四周带 3 mm 出血，可直接送印后裁剪。',
                ),
                h(
                    'div',
                    { className: 'ac-plugin-actions' },
                    h(
                        'button',
                        { type: 'button', className: 'ac-plugin-btn is-primary', onClick: requestExport },
                        '导出印刷素材',
                    ),
                ),
                exportMessage ? h('div', { className: 'ac-plugin-note is-error' }, exportMessage) : null,
            ),
            h(
                'div',
                { className: 'ac-plugin-section' },
                h('h3', { className: 'ac-plugin-section__title' }, '版本与发布'),
                row(
                    React,
                    '插件版本',
                    '每次进入卡包都会检查更新，有新版时卡册右上角会提醒；也可以在这里手动检查。',
                    h('span', { className: 'ac-plugin-version' }, `v${VERSION}`),
                ),
                h(
                    'div',
                    { className: 'ac-plugin-actions' },
                    h(
                        'button',
                        {
                            type: 'button',
                            className: 'ac-plugin-btn is-ghost',
                            onClick: async () => {
                                setUpdateMessage('正在检查更新…');
                                const result = await checkNow(rootRef.current);
                                if (result.status === 'latest') {
                                    setUpdateMessage(`已是最新版本 v${result.latest}。`);
                                } else if (result.status === 'restart') {
                                    setUpdateMessage(`v${result.latest} 已下载，重启 Steam 后生效。`);
                                } else if (result.status === 'error') {
                                    setUpdateMessage(result.error || '检查更新失败。');
                                } else {
                                    setUpdateMessage('');
                                }
                            },
                        },
                        '检查更新',
                    ),
                    h(
                        'button',
                        { type: 'button', className: 'ac-plugin-btn is-ghost', onClick: () => openReleasesPage() },
                        '打开发布页',
                    ),
                ),
                updateMessage ? h('div', { className: 'ac-plugin-note' }, updateMessage) : null,
            ),
            h(
                'div',
                { className: 'ac-plugin-section' },
                h('h3', { className: 'ac-plugin-section__title' }, '问题反馈'),
                h(
                    'div',
                    { className: 'ac-plugin-note' },
                    '遇到缺卡、数字对不上等问题时，复制这行诊断数据发给开发者：库内款数 / mapCache 条目 / 服务端条目 / 全成就 / total=0 / 无缓存。',
                ),
                h(
                    'div',
                    { className: 'ac-plugin-actions' },
                    h(
                        'button',
                        { type: 'button', className: 'ac-plugin-btn is-ghost', onClick: requestDiagnostics },
                        '日志反馈',
                    ),
                ),
                diagMessage ? h('div', { className: 'ac-plugin-note ac-plugin-diag' }, diagMessage) : null,
            ),
        );
    };
}

export function buildPanelContent(React) {
    const Component = buildPanelComponent(React);
    return React.createElement(Component);
}

export function buildPanel(React) {
    return {
        title: '成就收藏册',
        icon: React.createElement('span', { className: 'ac-plugin-icon', 'aria-hidden': 'true' }, '★'),
        content: buildPanelContent(React),
    };
}
