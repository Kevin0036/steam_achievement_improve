成就收藏册 · Windows 懒人包 v1.1.8-beta
=========================================

这是给「不想折腾 GitHub、也没有安装过 Millennium」的 Steam 用户准备的完整包。
下载这一个压缩包、解压、双击 Install.bat，就会自动装好 Millennium 和成就收藏册插件。
不需要下载主题，也不需要手动找目录、改文件。

版本说明
--------
- 成就收藏册插件：v1.1.8-beta
- Millennium：v3.6.2（官方发布包，原样内置，未修改）
- 这个包只安装插件，不安装任何主题，不会覆盖你现有的主题或插件。

包里有什么
----------
- plugin\AchievementCollection\   成就收藏册插件
- millennium-v3.6.2-windows-x86_64.zip
                                  官方 Millennium v3.6.2 Windows 64 位发布包
- install.ps1 / Install.bat       安装脚本
- uninstall.ps1 / Uninstall.bat   卸载脚本
- LICENSE                          许可（SpaceTheme, MIT）
- LICENSE-Millennium.md            Millennium 许可（Project Millennium, MIT）
- THIRD-PARTY.md                   第三方组件说明

安装（3 步）
------------
1. 把整个压缩包解压到一个普通文件夹。
   不要在压缩包里直接双击，也不要只把 Install.bat 拖出来。
2. 双击 Install.bat。
   如果 Windows 弹出「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。
3. 按提示操作。脚本会自动：
   - 寻找 Steam 安装目录；
   - 需要时请求管理员权限；
   - 需要时询问并关闭 Steam；
   - 校验内置 Millennium 压缩包的 SHA256；
   - 安装 Millennium 核心（如果还没装）和成就收藏册插件。

如果检测到你已经安装过 Millennium，安装器不会改动现有 Millennium，
只会询问是否「仅安装/更新插件」。此时它也不会动其它主题和插件。

装好之后
--------
1. 启动 Steam。
2. 打开 Steam 设置 → Millennium → Plugins，确认「成就收藏册」已启用。
3. 完全退出 Steam 再打开一次（或使用 Millennium 的重启界面功能）。
4. 打开 Steam 库顶部的 Library 菜单 → ★ 成就卡包。

借阅室
------
- 卡册页左上角有「借阅室」，寄出一本册子会生成 9 位借阅码。
- 朋友打开 https://kevin0036.github.io/ ，输入借阅码就能看你的收藏册。
- 分享服务器容量有限，请不要频繁新建或同步借阅册。

更新
----
- 插件：进入卡包时会自动检查 GitHub 上的新版本，也可以在插件设置里手动检查。
  更新只替换插件文件，设置和卡册缓存不会丢。
- Millennium：在 Millennium 设置里检查更新，或使用官方 Installer。
- 懒人包内置的 Millennium 固定在 v3.6.2，不会跟随官方自动升级。
- 不要用旧版懒人包覆盖新版插件；需要重装时请下载最新懒人包。

卸载
----
双击 Uninstall.bat，然后选择：

  [1] 仅卸载「成就收藏册」插件
      保留 Millennium、其它主题、插件和设置。最安全。

  [2] 卸载插件 + 本懒人包安装的 Millennium
      仅在没有其它主题/插件时可用。会删除 millennium 目录和 wsock32.dll，
      但不会动 Steam、游戏和存档。

如果检测到其它主题或插件，脚本会拒绝完整卸载，避免误删。

安全说明
--------
- 安装器不会联网下载 Millennium，内置的就是官方 v3.6.2 发布包。
- 官方包 SHA256：
  cd78cf680563491d24f58a4fc948dcfc7cb3b38523ac80162845e52b06151cc2
- 安装前会重新计算并比对，不一致会直接停止。
- Millennium 通过 wsock32.dll 注入 Steam，部分杀毒软件可能提示；
  如不放心，请改用 Millennium 官方 Installer 安装，再手动安装插件版。
- 插件本身不会收集或上传你的 Steam 数据；只有你主动寄出借阅册时，
  才会把收藏册快照上传到分享服务器。
- 快照包含昵称、头像、好友代码（朋友可以用它加你）和册子内容，
  不包含登录信息。收回后借阅码立即失效。

来源
----
- 成就收藏册：https://github.com/Kevin0036/steam_achievement_improve
- 网页借阅室：https://kevin0036.github.io/
- Millennium：https://github.com/SteamClientHomebrew/Millennium
- 基础主题 SpaceTheme：https://github.com/SpaceTheme/Steam
