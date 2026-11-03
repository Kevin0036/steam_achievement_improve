/**
 * 更新检查里不碰环境的部分：版本比较、这次该怎么提醒、更新说明怎么显示。
 * 不依赖 window 和 Millennium，测试可以直接跑。
 */

function versionParts(value) {
    const [core, ...suffix] = String(value ?? '').trim().replace(/^v/i, '').split('-');
    if (!/^\d+(\.\d+)*$/.test(core)) return null;
    return { numbers: core.split('.').map((part) => Number.parseInt(part, 10)), prerelease: suffix.length > 0 };
}

export function isNewerVersion(candidate, current) {
    const a = versionParts(candidate);
    const b = versionParts(current);
    if (!a || !b) return false;
    for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i += 1) {
        const left = a.numbers[i] ?? 0;
        const right = b.numbers[i] ?? 0;
        if (left !== right) return left > right;
    }
    // 数字相同时正式版比内测版新，否则 1.2.0-beta 永远收不到 1.2.0
    return b.prerelease && !a.prerelease;
}

/**
 * 这次检查的结论：
 *   latest  —— 已经是最新；
 *   restart —— 新版文件已经装好，只是这次 Steam 还在跑旧代码；
 *   skipped —— 用户选过「暂不更新」这一版，不弹窗，只留工具条上的提醒；
 *   update  —— 有新版可以装。
 *
 * onDisk 是后端读到的 plugin.json 版本，比本机记录可靠：
 * 重新装回旧版、或者安装没生效时，它都会跟着变，不会一直误报「等待重启」。
 */
export function decideUpdate({ latest, running, onDisk = null, installed = null, skipped = null, manual = false }) {
    if (!isNewerVersion(latest, running)) return 'latest';
    if (installed === latest) return 'restart';
    if (onDisk && isNewerVersion(onDisk, running) && !isNewerVersion(latest, onDisk)) return 'restart';
    return !manual && skipped === latest ? 'skipped' : 'update';
}

/**
 * GitHub Release 的正文开头是懒人包的安装说明，弹窗里只放这一版改了什么：
 * 取「更新内容」这一节，去掉 Markdown 记号。没有这一节时退回整篇。
 */
export function releaseNotesText(body) {
    let text = String(body ?? '').replace(/\r\n/g, '\n');
    const heading = /^##\s.*更新内容.*$/m.exec(text);
    if (heading) {
        text = text.slice(heading.index + heading[0].length);
        const end = text.search(/^##\s/m);
        if (end >= 0) text = text.slice(0, end);
    }
    return text
        .replace(/^#{2,}\s*/gm, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/(\*\*|__|`)/g, '')
        .replace(/^[ \t]*-\s+/gm, '· ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
