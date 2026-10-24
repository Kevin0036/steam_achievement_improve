/**
 * 展柜增强专用文案。
 *
 * 社区页面的入口脚本是一个独立的小包，只服务展柜；如果它 import 整本 STR，
 * 打包体积会多出所有卡包 / 年份页文案。这里把展柜要用的两句单独放一份，
 * strings.js 再把它挂回 STR.showcase，两边的值始终一致。
 */

export const SHOWCASE_STR = {
    // 统计行里「已完成的游戏和组」改成这句；数字不动
    perfectGames: '完美通关的游戏',
    // 锁区等原因连备用封面都取不到时的占位文字
    coverMissing: '封面暂不可用',
};

export default SHOWCASE_STR;
