成就收藏册 · Windows 懒人包 v1.0.0
====================================

这是给「从来没有安装过 Millennium」的 Steam 用户准备的完整包。
如果你已经在使用 Millennium，请下载主题版，不要运行这个安装器。

包里有什么
----------
- theme\                         成就收藏册主题
- millennium-v3.6.2-windows-x86_64.zip
                                 官方 Millennium v3.6.2 Windows 64 位发布包（原样未修改）
- install.ps1 / Install.bat      安装脚本
- uninstall.ps1 / Uninstall.bat  卸载脚本
- LICENSE                        主题许可证（SpaceTheme, MIT）
- LICENSE-Millennium.md          Millennium 许可证（Project Millennium, MIT）

安装
----
1. 把整个压缩包解压到一个普通文件夹（不要在压缩包里直接运行）。
2. 双击 Install.bat。
3. 脚本会自动寻找 Steam：
   - 需要时请求管理员权限；
   - 需要时关闭 Steam（会先询问）；
   - 校验内置 Millennium 压缩包的 SHA256；
   - 安装 Millennium 核心和成就收藏册主题。
4. 安装完成后启动 Steam：
   - 打开 Steam 设置 → Millennium → Themes；
   - 选择「成就收藏册」；
   - 打开 Steam 库顶部菜单 → ★ 成就卡包。

如果检测到你已经安装过 Millennium，或 Steam 目录里已有 wsock32.dll，
安装器不会覆盖现有环境，只会问你是否「仅安装/更新主题」。

卸载
----
双击 Uninstall.bat，然后选择：

  [1] 仅卸载「成就收藏册」主题
      保留 Millennium、其它主题、插件和设置。最安全。

  [2] 卸载主题 + 本懒人包安装的 Millennium
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
  如不放心，请改用 Millennium 官方 Installer 安装，再使用主题版。
- 主题本身不会收集或上传你的 Steam 数据。

更新
----
- 主题更新：下载新版主题版压缩包，覆盖 millennium\themes\AchievementCollection。
- Millennium 更新：在 Millennium 设置里检查更新，或使用官方 Installer。
- 懒人包内置的 Millennium 版本固定在 v3.6.2，不会自动跟随官方更新。

来源
----
- 主题：https://github.com/Kevin0036/steam_achievement_improve
- Millennium：https://github.com/SteamClientHomebrew/Millennium
- 基础主题 SpaceTheme：https://github.com/SpaceTheme/Steam
