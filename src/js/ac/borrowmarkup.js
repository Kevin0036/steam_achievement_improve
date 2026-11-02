/**
 * 借阅室的静态骨架。
 *
 * 与 preview/borrow.html 的舞台一致；所有 id 都带 acBorrow 前缀，
 * 因为这份 DOM 是挂进 Steam 主窗口的，不能和 Steam 自己的 #toast / #mail 撞车。
 */

export const BORROW_ROOM_HTML = `
<div class="rm-stage">
    <div class="rm-room">
        <div class="rm-wall" aria-hidden="true"></div>
        <div class="rm-desk" aria-hidden="true"></div>

        <header class="rm-head">
            <div class="rm-eyebrow"><i></i><span>ACHIEVEMENT COLLECTION</span><b>READING ROOM</b><i></i></div>
            <h1 class="rm-title">借阅室</h1>
            <nav class="rm-seg" role="tablist" aria-label="借阅室">
                <button type="button" class="on" data-mode="out" role="tab" aria-selected="true">寄信</button>
                <button type="button" data-mode="in" role="tab" aria-selected="false">收信</button>
            </nav>
        </header>

        <!-- 收信：借阅单 -->
        <section class="rm-panel rm-panel--in" id="acBorrowPanelIn">
            <div class="rm-glass rm-req">
                <h2 class="rm-req__title">借阅单</h2>
                <div class="rm-field" id="acBorrowField">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3 8 21M16 3l-2 18M4 9h17M3 15h17"/></svg>
                    <input id="acBorrowLink" type="text" spellcheck="false" autocomplete="off"
                           placeholder="9 位借阅码" aria-label="借阅码或借阅链接">
                    <button type="button" class="rm-btn" id="acBorrowBorrow">收信</button>
                </div>
                <div class="rm-req__foot">
                    <span class="rm-hint">朋友发来的 9 位数字；旧版 ?t= 借阅链接也仍然可用。</span>
                </div>
            </div>
        </section>

        <!-- 信封 -->
        <div class="rm-mail" id="acBorrowMail" aria-hidden="true">
            <i class="rm-mail__ring" id="acBorrowRing"></i>
            <span class="rm-mail__back"></span>

            <div class="rm-letter" id="acBorrowLetter">
                <div class="rm-letter__flip">
                    <article class="rm-postcard">
                        <div class="rm-plate">
                            <span class="rm-plate__badge" aria-hidden="true"></span>
                            <span class="rm-plate__name">成就收藏册</span>
                            <span class="rm-plate__rule" aria-hidden="true"></span>
                            <span class="rm-plate__meta" id="acBorrowPlateMeta">—</span>
                        </div>
                        <div class="rm-postage" aria-hidden="true">
                            <svg viewBox="0 0 30 36">
                                <g mask="url(#acBorrowPerf)">
                                    <rect width="30" height="36" fill="#efe6cf"/>
                                    <rect x="2.6" y="2.6" width="24.8" height="30.8" fill="#202a4c"/>
                                    <rect x="3.6" y="3.6" width="22.8" height="28.8" fill="none" stroke="#d6b77a" stroke-width=".4"/>
                                </g>
                                <g transform="translate(8 11) scale(.5833)">
                                    <use href="#acBorrowSteam" fill="#d6b77a"/>
                                </g>
                            </svg>
                        </div>
                        <svg class="rm-postmark" viewBox="0 0 64 36" aria-hidden="true">
                            <g class="rm-pm-line">
                                <circle cx="17" cy="18" r="13.5"/>
                                <circle cx="17" cy="18" r="11"/>
                                <path d="M35 10q4-3 8 0t8 0 8 0M35 18q4-3 8 0t8 0 8 0M35 26q4-3 8 0t8 0 8 0"/>
                            </g>
                            <text x="17" y="17.5" text-anchor="middle" font-size="5.6" font-weight="700" id="acBorrowPmDate">—</text>
                            <text x="17" y="24.5" text-anchor="middle" font-size="4.6" id="acBorrowPmYear">—</text>
                        </svg>
                    </article>

                    <article class="rm-register">
                        <div class="rm-register__main">
                            <h3>借阅登记卡</h3>
                            <dl class="rm-kv">
                                <dt>分享者</dt>
                                <dd><img id="acBorrowRegAvatar" alt=""><b id="acBorrowRegName">—</b></dd>
                                <dt>册内</dt>
                                <dd class="rm-kv__stack">
                                    <span><b id="acBorrowRegCount">—</b> 款全成就</span>
                                    <span class="rm-kv__span" id="acBorrowRegSpan">—</span>
                                </dd>
                            </dl>
                            <div class="rm-register__barcode" aria-hidden="true"></div>
                        </div>
                        <i class="rm-register__divider"></i>
                        <div class="rm-register__side">
                            <p class="rm-register__note">只读副本 · 阅毕合上寄回</p>
                            <div class="rm-register__stampbox" id="acBorrowStampBox">
                                <span>盖章处</span>
                                <div class="rm-mark" id="acBorrowMark">已寄出</div>
                            </div>
                            <button type="button" class="rm-btn rm-btn--dark rm-btn--paper" id="acBorrowOpenBook">翻开册子</button>
                        </div>
                    </article>
                </div>
            </div>

            <span class="rm-mail__dimmer" aria-hidden="true"></span>
            <span class="rm-mail__fold"></span>
            <span class="rm-mail__flap"><i></i><b></b></span>

            <div class="rm-seal" id="acBorrowSeal" role="button" tabindex="0" aria-label="拆开封蜡">
                <i class="rm-seal__half rm-seal__half--l">
                    <i class="rm-seal__art">
                        <svg viewBox="0 0 100 100" aria-hidden="true">
                            <defs>
                                <radialGradient id="acBorrowWax" cx=".35" cy=".3" r=".9">
                                    <stop offset="0" stop-color="#c06256"/>
                                    <stop offset=".52" stop-color="#a3453d"/>
                                    <stop offset="1" stop-color="#6f241e"/>
                                </radialGradient>
                            </defs>
                            <path d="M50 4C61 2 71 8 80 13 88 18 95 26 97 37 99 47 95 56 93 64 90 75 83 83 73 89 63 95 54 97 44 96 33 94 23 88 16 80 9 71 6 61 6 50 5 39 9 30 16 21 24 12 37 6 50 4Z" fill="url(#acBorrowWax)"/>
                            <path d="M31 24C38 16 48 12 58 14" fill="none" stroke="#e08a7e" stroke-width="2.2" stroke-linecap="round" opacity=".38"/>
                            <g transform="translate(22 22) scale(2.33)">
                                <use href="#acBorrowSteam" fill="#f0b2a8" opacity=".35" transform="translate(.35 .45)"/>
                                <use href="#acBorrowSteam" fill="#5e1a14"/>
                            </g>
                            <circle cx="50" cy="50" r="36.5" fill="none" stroke="#4a1511" stroke-opacity=".4" stroke-width="1.7"/>
                        </svg>
                    </i>
                </i>
                <i class="rm-seal__half rm-seal__half--r">
                    <i class="rm-seal__art">
                        <svg viewBox="0 0 100 100" aria-hidden="true">
                            <path d="M50 4C61 2 71 8 80 13 88 18 95 26 97 37 99 47 95 56 93 64 90 75 83 83 73 89 63 95 54 97 44 96 33 94 23 88 16 80 9 71 6 61 6 50 5 39 9 30 16 21 24 12 37 6 50 4Z" fill="url(#acBorrowWax)"/>
                            <path d="M31 24C38 16 48 12 58 14" fill="none" stroke="#e08a7e" stroke-width="2.2" stroke-linecap="round" opacity=".38"/>
                            <g transform="translate(22 22) scale(2.33)">
                                <use href="#acBorrowSteam" fill="#f0b2a8" opacity=".35" transform="translate(.35 .45)"/>
                                <use href="#acBorrowSteam" fill="#5e1a14"/>
                            </g>
                            <circle cx="50" cy="50" r="36.5" fill="none" stroke="#4a1511" stroke-opacity=".4" stroke-width="1.7"/>
                        </svg>
                    </i>
                </i>
            </div>
        </div>

        <!-- 印章架 -->
        <div class="rm-rack" id="acBorrowRack">
            <i class="rm-rack__pad"></i>
            <div class="rm-stamp" id="acBorrowStamp" role="button" tabindex="0" aria-label="盖章寄出">
                <i class="rm-stamp__shadow"></i>
                <i class="rm-stamp__head"><i class="rm-stamp__badge"></i></i>
            </div>
        </div>

        <!-- 寄信结果：借阅码 + 管理动作 -->
        <section class="rm-glass rm-result" id="acBorrowResult">
            <h2 class="rm-result__title" id="acBorrowResultTitle">借阅码已生成</h2>
            <div class="rm-result__code" id="acBorrowCodeOut" role="group" tabindex="0" aria-label="借阅码">—</div>
            <p class="rm-result__hint" id="acBorrowCodeNote">把 9 位借阅码发给朋友，对方在借阅室「收信」里输入即可。</p>
            <div class="rm-result__row">
                <button type="button" class="rm-btn" id="acBorrowCopy">复制借阅码</button>
                <button type="button" class="rm-btn rm-btn--ghost" id="acBorrowCopyLink">复制短链接</button>
            </div>
            <div class="rm-result__row rm-result__row--manage">
                <button type="button" class="rm-btn rm-btn--ghost" id="acBorrowSync">同步最新</button>
                <button type="button" class="rm-btn rm-btn--ghost" id="acBorrowRenew">换新借阅码</button>
                <button type="button" class="rm-btn rm-btn--ghost rm-revoke" id="acBorrowRevoke">收回</button>
            </div>
            <p class="rm-result__note" id="acBorrowResultNote">朋友打开短链接或在借阅室输入借阅码，会看到这一版只读快照。</p>
        </section>

        <div class="rm-tip" id="acBorrowTip" aria-live="polite"></div>
    </div>
</div>

<!-- 开册覆盖层与阅读器都在舞台外面：.rm-stage 有 container-type: size，
     客户端 CEF 会把它当成 fixed 后代的包含块（浏览器虽然现在不这么算，
     但按规范它有权这么做），inside-stage 的 fixed 在客户端里命中测试会错位。
     放在 .rm-root 下面，两个引擎的包含块就一致了。 -->
    <div class="rm-veil" id="acBorrowVeil" aria-hidden="true">
        <i class="rm-veil__rays"></i>
        <div class="rm-cover" id="acBorrowCover">
            <div class="rm-cover__book">
                <i class="rm-cover__ribbon" aria-hidden="true"></i>
                <div class="rm-cover__board" aria-hidden="true"></div>
                <div class="rm-cover__inside" aria-hidden="true"></div>
                <div class="rm-cover__front">
                    <div class="rm-cover__face">
                        <i class="rm-cover__spine"></i>
                        <svg class="rm-corner rm-corner--a" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21V5a4 4 0 0 1 4-4h16"/><path d="M5 12V6.5A1.5 1.5 0 0 1 6.5 5H12"/><path d="M9 9l1.6-1.6L12.2 9l-1.6 1.6z" fill="currentColor" stroke="none"/></svg>
                        <svg class="rm-corner rm-corner--b" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21V5a4 4 0 0 1 4-4h16"/><path d="M5 12V6.5A1.5 1.5 0 0 1 6.5 5H12"/><path d="M9 9l1.6-1.6L12.2 9l-1.6 1.6z" fill="currentColor" stroke="none"/></svg>
                        <svg class="rm-corner rm-corner--c" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21V5a4 4 0 0 1 4-4h16"/><path d="M5 12V6.5A1.5 1.5 0 0 1 6.5 5H12"/><path d="M9 9l1.6-1.6L12.2 9l-1.6 1.6z" fill="currentColor" stroke="none"/></svg>
                        <svg class="rm-corner rm-corner--d" viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21V5a4 4 0 0 1 4-4h16"/><path d="M5 12V6.5A1.5 1.5 0 0 1 6.5 5H12"/><path d="M9 9l1.6-1.6L12.2 9l-1.6 1.6z" fill="currentColor" stroke="none"/></svg>
                        <span class="rm-cover__badge" aria-hidden="true"></span>
                        <span class="rm-cover__name">成就收藏册</span>
                        <span class="rm-cover__sub">ACHIEVEMENT COLLECTION</span>
                        <span class="rm-cover__rule" aria-hidden="true"><i></i></span>
                        <span class="rm-cover__span" id="acBorrowCoverSpan">—</span>
                    </div>
                    <div class="rm-cover__back" aria-hidden="true">
                        <div class="rm-cover__endpaper" id="acBorrowCoverEnd"></div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- 阅读器 -->
    <section class="rm-reader" id="acBorrowReader" aria-hidden="true" aria-label="借阅中的收藏册">
        <header class="rm-bar">
            <div class="rm-bar__id">
                <span class="rm-bar__badge" aria-hidden="true"></span>
                <b>借阅室</b>
                <span class="rm-bar__sep" aria-hidden="true"></span>
                <img id="acBorrowBarAvatar" alt="">
                <span class="rm-bar__name" id="acBorrowBarName">—</span>
                <button type="button" class="rm-friend" id="acBorrowFriend" aria-expanded="false" aria-controls="acBorrowCodePop" hidden>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                        <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/>
                        <path d="M10.5 3.5a1.6 1.6 0 0 0-1.6-1.6H4.1A1.6 1.6 0 0 0 2.5 3.5v4.8a1.6 1.6 0 0 0 1.6 1.6" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                    </svg>
                    获取好友代码
                </button>
                <div class="rm-code" id="acBorrowCodePop" role="group" aria-label="好友代码" hidden>
                    <span class="rm-code__label">好友代码</span>
                    <div class="rm-code__row">
                        <input class="rm-code__value" id="acBorrowCodeValue" readonly spellcheck="false" autocomplete="off" aria-label="好友代码">
                        <button type="button" class="rm-code__copy" id="acBorrowCodeCopy">复制</button>
                    </div>
                    <p class="rm-code__hint" id="acBorrowCodeHint">点「复制」，或全选后按 Ctrl+C。</p>
                </div>
            </div>
            <div class="rm-bar__meta">
                <span id="acBorrowBarMeta">—</span>
                <span class="rm-bar__ro">只读快照</span>
            </div>
            <div class="rm-bar__actions">
                <button type="button" class="rm-btn rm-btn--ghost" id="acBorrowSetBtn" aria-expanded="false" aria-controls="acBorrowSetPop">阅读设置</button>
                <button type="button" class="rm-btn rm-btn--ghost" id="acBorrowCloseBtn">合上并寄回</button>
            </div>
        </header>

        <div class="rm-setpop" id="acBorrowSetPop" hidden>
            <p class="rm-setpop__title">阅读设置</p>
            <div class="rm-setpop__row">
                <span class="rm-setpop__label">单页卡片数量</span>
                <div class="rm-setpop__chips" role="group" aria-label="单页卡片数量">
                    <button type="button" data-per="1">一页一卡</button>
                    <button type="button" data-per="4">一页四卡</button>
                </div>
            </div>
            <div class="rm-setpop__row">
                <span class="rm-setpop__label">年份特殊页</span>
                <button type="button" class="rm-switch" id="acBorrowYearToggle" role="switch" aria-checked="false" aria-label="年份特殊页"><i></i></button>
            </div>
            <p class="rm-setpop__note">只调整这次阅读的排版，不会改变分享快照。</p>
        </div>

        <div class="rm-reader__book">
            <div id="acBorrowBookHost" class="ac-cardpack"></div>
        </div>
    </section>

<button type="button" class="rm-exit" id="acBorrowExit" title="退出借阅室">退出借阅室</button>
<button type="button" class="rm-sound" id="acBorrowSound">
    <span class="rm-sound__bars" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="rm-sound__label">声音</span>
</button>
<div class="rm-toast" id="acBorrowToast" role="status" aria-live="polite"></div>

<!-- 贴纸 / 邮票共用定义 -->
<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    <path id="acBorrowSteam" d="M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z"/>
    <mask id="acBorrowPerf" maskUnits="userSpaceOnUse" x="0" y="0" width="30" height="36">
        <rect width="30" height="36" fill="#fff"/>
        <rect width="30" height="36" fill="none" stroke="#000" stroke-width="2.2" stroke-dasharray="0 3.1" stroke-linecap="round"/>
    </mask>
</defs></svg>
`;
