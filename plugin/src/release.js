/**
 * 发布页入口。
 *
 * 更新检查与自动安装见 update.js；这里只负责把用户送到 GitHub Releases
 * 看版本说明或手动下载安装包。
 */

export const RELEASES_PAGE = 'https://github.com/Kevin0036/steam_achievement_improve/releases';

export function openReleasesPage() {
    const system = window.SteamClient?.System;
    if (typeof system?.OpenInSystemBrowser === 'function') {
        try {
            system.OpenInSystemBrowser(RELEASES_PAGE);
            return;
        } catch {
            /* 退回浏览器 */
        }
    }
    try {
        window.open(RELEASES_PAGE, '_blank', 'noopener');
    } catch {
        /* 忽略 */
    }
}
