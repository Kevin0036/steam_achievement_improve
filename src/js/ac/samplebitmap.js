/**
 * 取样用的小图：读成 Blob，交给 createImageBitmap 在后台线程解码并缩到取样尺寸。
 *
 * 用 <img> + canvas.drawImage 取样时，Chromium 会在主线程同步解码整张原图（一张 5～9ms）。
 * 卡面底色（tone.js）和竖版封面体检（capsule.js）都要取样，结果会缓存，平时只在卡片第一次出现时发生；
 * 但书签翻阅一次掠过十几叶，碰到的多半是没翻过的卡，取样全挤在起步那几百毫秒，就会连续掉帧。
 *
 * 不支持、跨域被拒或读取失败时返回 null，调用方退回原来的 <img> 做法，结果不变。
 */
export async function sampleBitmap(doc, url, width) {
    const win = doc?.defaultView;
    if (typeof win?.createImageBitmap !== 'function' || typeof win.fetch !== 'function') return null;
    try {
        const response = await win.fetch(url, { mode: 'cors', credentials: 'omit' });
        if (!response.ok) return null;
        const blob = await response.blob();
        return await win.createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'medium' });
    } catch {
        return null;
    }
}
