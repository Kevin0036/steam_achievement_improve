# 成就收藏册预览维护

预览地址：http://127.0.0.1:4173/preview/

在 `C:\Users\Kevin\App\Steam\achievement_improve` 中运行：

```powershell
# 首次安装预览工具依赖
npm install --ignore-scripts

# 在 Steam 打开成就卡包，等待数量、日期和图片加载完成后，同步数据
npm run preview:sync

# 启动预览服务（已有服务时直接刷新页面）
npm run preview

# 验证数据一致性和图片路由
npm run test:preview
```

预览直接加载 `../millennium/themes/AchievementCollection` 下的正式 JS、CSS 和素材。修改正式主题代码后刷新预览即可，勿另存一套渲染逻辑。

卡片数据为显式同步的客户端快照，并非实时读取 Steam。`preview:sync` 仅在临时副本中读取 Steam 的 localStorage 数据库，用正式主题的缓存读取器校验版本，再与对应账户的完整成就进度核对。不会修改 Steam 数据库，也不会向网络请求完成率。账户、卡片集合、成就总数或奖杯统计不匹配时，会拒绝覆盖现有数据。

`client-snapshot.json` 保存客户端卡片原始字段；`fixtures.js` 供预览页面加载，金银杯、完成日期、时长和封面候选链均来自快照。不从旧 achievementmap 推算稀有数量，也不猜测缺失日期或普通成就数量。稀有规则继续由正式主题负责：全球完成率 **低于 10%** 为金杯，**大于或等于 10%** 为银杯；未知数据保持未知。

数据变化后再次运行 `npm run preview:sync` 并刷新页面。如果只需从已保存的快照重新生成夹具，可运行 `npm run preview:fixtures`；它也会校验当前本机进度，不会回退到旧的统计来源。

预览服务器将客户端 `/assets/` 图片地址映射到本机 `appcache/librarycache`，兼容带哈希子目录的新游戏封面；`/libcache/` 旧地址继续可用。服务器仅监听 `127.0.0.1`。新卡入册标签是动画演示，不会改动客户端收藏记录。
