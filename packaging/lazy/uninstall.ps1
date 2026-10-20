#requires -Version 5.1
<#
  成就收藏册 · Windows 懒人包卸载器
  默认只删除主题；完整卸载仅在本懒人包安装过 Millennium、且没有其它主题/插件时允许。
#>
[CmdletBinding()]
param(
    [string]$SteamPath = '',
    [ValidateSet('menu', 'theme', 'full')]
    [string]$Mode = 'menu',
    [switch]$InternalNoElevate,
    [switch]$InternalSkipProcessStop,
    [switch]$InternalYes
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $global:OutputEncoding = New-Object Text.UTF8Encoding($false)
} catch { }
$script:ThemeFolderName = 'AchievementCollection'
$script:AutoYes = [bool]$InternalYes
$script:ScriptRoot = $PSScriptRoot

function Write-Step([string]$Text) {
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Note([string]$Text) {
    Write-Host "  [!] $Text" -ForegroundColor Yellow
}

function Stop-Uninstaller([string]$Message) {
    Write-Host "`n[提示] $Message" -ForegroundColor Yellow
    if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
    exit 0
}

function Confirm-Step([string]$Question, [bool]$DefaultYes = $true) {
    if ($script:AutoYes) { return $true }
    $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    $answer = Read-Host "$Question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $DefaultYes }
    return $answer -match '^(y|yes)$'
}

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-PowerShellPath {
    try {
        $path = (Get-Process -Id $PID).Path
        if ($path -and (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
    } catch {
        # Fall through to $PSHOME.
    }
    $fallback = Join-Path $PSHOME 'powershell.exe'
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
    return 'powershell.exe'
}

function Test-Writable([string]$Directory) {
    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
    $probe = Join-Path $Directory ('.ac-write-test-' + [Guid]::NewGuid().ToString('N'))
    try {
        [IO.File]::WriteAllText($probe, 'ok')
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
        return $true
    } catch {
        return $false
    }
}

function Get-SteamPath([string]$Hint) {
    $candidates = New-Object System.Collections.Generic.List[string]
    if ($Hint) { $candidates.Add($Hint) }
    foreach ($entry in @(
        @{ Path = 'HKCU:\Software\Valve\Steam'; Name = 'SteamPath' },
        @{ Path = 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam'; Name = 'InstallPath' },
        @{ Path = 'HKLM:\SOFTWARE\Valve\Steam'; Name = 'InstallPath' }
    )) {
        try {
            $value = (Get-ItemProperty -Path $entry.Path -Name $entry.Name -ErrorAction Stop).($entry.Name)
            if ($value) { $candidates.Add([string]$value) }
        } catch {
            # Registry key may not exist.
        }
    }
    if (${env:ProgramFiles(x86)}) { $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Steam')) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Steam')) }

    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $clean = [Environment]::ExpandEnvironmentVariables($candidate).Trim().Trim('"').Replace('/', '\').TrimEnd('\')
        if (Test-Path -LiteralPath (Join-Path $clean 'steam.exe') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $clean).Path.TrimEnd('\')
        }
    }

    if ($script:AutoYes) { Stop-Uninstaller '未找到 Steam 安装目录。' }
    Write-Note '未能自动找到 Steam 安装目录。'
    for ($i = 0; $i -lt 3; $i++) {
        $entered = Read-Host '请输入 Steam 安装目录（里面应有 steam.exe），或直接回车退出'
        if ([string]::IsNullOrWhiteSpace($entered)) { break }
        $clean = [Environment]::ExpandEnvironmentVariables($entered).Trim().Trim('"').Replace('/', '\').TrimEnd('\')
        if (Test-Path -LiteralPath (Join-Path $clean 'steam.exe') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $clean).Path.TrimEnd('\')
        }
        Write-Note '这个目录里没有 steam.exe，请重新输入。'
    }
    Stop-Uninstaller '未找到有效的 Steam 安装目录。'
}

function Invoke-Elevated([string]$Root) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SteamPath `"$Root`""
    if ($Mode -ne 'menu') { $arguments += " -Mode $Mode" }
    Write-Note '需要管理员权限才能清理 Steam 目录，正在请求提权……'
    try {
        $process = Start-Process -FilePath (Get-PowerShellPath) -Verb RunAs -ArgumentList $arguments -Wait -PassThru
        exit $process.ExitCode
    } catch {
        Stop-Uninstaller '未获得管理员权限，卸载已取消。'
    }
}

function Get-Manifest([string]$Root) {
    $path = Join-Path $Root 'millennium\.ac-installer\manifest.json'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json)
    } catch {
        return $null
    }
}

function Get-OtherContent([string]$Root) {
    $found = New-Object System.Collections.Generic.List[string]
    $themesDir = Join-Path $Root 'millennium\themes'
    if (Test-Path -LiteralPath $themesDir -PathType Container) {
        foreach ($dir in @(Get-ChildItem -LiteralPath $themesDir -Directory -Force)) {
            if ($dir.Name -eq $script:ThemeFolderName) { continue }
            if ($dir.Name -eq 'Steam') { continue }
            if ($dir.Name -like '__tmp_*') { continue }
            $found.Add("主题：$($dir.Name)")
        }
    }
    $pluginDirs = @(
        (Join-Path $Root 'millennium\plugins'),
        (Join-Path $Root 'plugins')
    )
    foreach ($pluginDir in $pluginDirs) {
        if (-not (Test-Path -LiteralPath $pluginDir -PathType Container)) { continue }
        foreach ($dir in @(Get-ChildItem -LiteralPath $pluginDir -Directory -Force)) {
            $found.Add("插件：$($dir.Name)")
        }
    }
    $skinsDir = Join-Path $Root 'steamui\skins'
    if (Test-Path -LiteralPath $skinsDir -PathType Container) {
        foreach ($item in @(Get-ChildItem -LiteralPath $skinsDir -Force)) {
            $found.Add("skins：$($item.Name)")
        }
    }
    return $found
}

function Stop-SteamIfNeeded([string]$Root) {
    if ($InternalSkipProcessStop) { return }
    if (-not (Get-Process -Name 'steam' -ErrorAction SilentlyContinue)) { return }
    Write-Note '检测到 Steam 正在运行。卸载前需要关闭 Steam。'
    if (-not (Confirm-Step '现在关闭 Steam 并继续吗？' $true)) {
        Stop-Uninstaller '已取消。请手动退出 Steam 后重试。'
    }
    try { Start-Process -FilePath (Join-Path $Root 'steam.exe') -ArgumentList '-shutdown' -WindowStyle Hidden -ErrorAction SilentlyContinue | Out-Null } catch { }
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Name 'steam' -ErrorAction SilentlyContinue)) { break }
    }
    if (Get-Process -Name 'steam' -ErrorAction SilentlyContinue) {
        Write-Note 'Steam 没有在等待时间内退出，将继续强制关闭。'
        Stop-Process -Name 'steam' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
    }
    if (Get-Process -Name 'steam' -ErrorAction SilentlyContinue) {
        Stop-Uninstaller 'Steam 仍在运行，请手动关闭后重试。'
    }
    Write-Ok 'Steam 已关闭'
}

function Remove-ThemeOnly([string]$Root) {
    $themeDir = Join-Path $Root "millennium\themes\$script:ThemeFolderName"
    if (Test-Path -LiteralPath $themeDir -PathType Container) {
        Remove-Item -LiteralPath $themeDir -Recurse -Force
        Write-Ok "已删除主题：$themeDir"
    } else {
        Write-Note '没有找到主题目录，可能已经删除。'
    }

    $manifest = Get-Manifest $Root
    $installerDir = Join-Path $Root 'millennium\.ac-installer'
    if ($manifest -and $manifest.installedCore -eq $true) {
        $path = Join-Path $installerDir 'manifest.json'
        try {
            $manifest | Add-Member -NotePropertyName themeRemoved -NotePropertyValue $true -Force
            $json = $manifest | ConvertTo-Json -Depth 5
            [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
        } catch {
            Write-Note '更新安装记录失败，但不影响主题卸载。'
        }
    } elseif (Test-Path -LiteralPath $installerDir -PathType Container) {
        Remove-Item -LiteralPath $installerDir -Recurse -Force
    }
    Write-Note 'Millennium 核心、设置和其它主题都没有改动。'
}

function Remove-Full([string]$Root, $Manifest) {
    if (-not $Manifest) {
        Stop-Uninstaller '没有找到本懒人包的安装记录。为避免误删，完整卸载已停止。'
    }
    if ($Manifest.installedCore -ne $true) {
        Stop-Uninstaller '本懒人包只安装过主题，没有安装 Millennium 核心。请选择“仅卸载主题”。'
    }

    $others = @(Get-OtherContent $Root)
    if ($others.Count -gt 0) {
        Write-Note '检测到其它主题或插件，完整卸载已停止，避免误删：'
        foreach ($item in $others) { Write-Host "    - $item" -ForegroundColor Yellow }
        Write-Note '你可以先删除它们，或使用 Millennium 官方 Installer 卸载核心。'
        Write-Note '如果只想移除本主题，请选择“仅卸载主题”。'
        if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
        exit 0
    }

    Write-Host ''
    Write-Host '将要删除：' -ForegroundColor Yellow
    Write-Host '  - 成就收藏册主题'
    Write-Host '  - Millennium 核心（lib、bin、wsock32.dll）'
    Write-Host '  - millennium 目录中的配置和缓存'
    Write-Host '  - 本安装器的安装记录'
    Write-Host '不会删除：Steam、游戏、用户存档、Steam/ext 共享依赖。'
    Write-Host ''
    if (-not $script:AutoYes) {
        $answer = Read-Host '确认完整卸载请输入 DELETE（其他任意内容取消）'
        if ($answer -cne 'DELETE') { Stop-Uninstaller '已取消。' }
    }

    Stop-SteamIfNeeded $Root

    $themeDir = Join-Path $Root "millennium\themes\$script:ThemeFolderName"
    if (Test-Path -LiteralPath $themeDir) { Remove-Item -LiteralPath $themeDir -Recurse -Force }

    $millenniumDir = Join-Path $Root 'millennium'
    if (Test-Path -LiteralPath $millenniumDir -PathType Container) {
        Remove-Item -LiteralPath $millenniumDir -Recurse -Force
        Write-Ok '已删除 millennium 目录'
    }
    $wsock = Join-Path $Root 'wsock32.dll'
    if (Test-Path -LiteralPath $wsock -PathType Leaf) {
        Remove-Item -LiteralPath $wsock -Force
        Write-Ok '已删除 wsock32.dll'
    }

    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host ' 完整卸载完成' -ForegroundColor Green
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host ''
    Write-Host 'Steam 本体、游戏和存档未被修改。'
    Write-Host '如果之后还想使用本主题，重新运行安装包即可。'
    Write-Host ''
    if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
}

function Main {
    Write-Host ''
    Write-Host '  成就收藏册 · 懒人包卸载器' -ForegroundColor White
    Write-Host ''

    $root = Get-SteamPath $SteamPath
    Write-Ok "Steam 目录：$root"

    if (-not (Test-Writable $root)) {
        if (Test-Admin) { Stop-Uninstaller 'Steam 目录不可写，请检查权限。' }
        if ($InternalNoElevate) { Stop-Uninstaller '没有写入 Steam 目录的权限。' }
        Invoke-Elevated $root
        return
    }

    $themeDir = Join-Path $root "millennium\themes\$script:ThemeFolderName"
    $manifest = Get-Manifest $root
    $core = Test-Path -LiteralPath (Join-Path $root 'millennium\lib\millennium.dll') -PathType Leaf

    if (-not (Test-Path -LiteralPath $themeDir) -and -not $core -and -not $manifest) {
        Stop-Uninstaller '没有找到成就收藏册或本懒人包的安装记录。'
    }

    if ($Mode -eq 'theme') {
        Stop-SteamIfNeeded $root
        Remove-ThemeOnly $root
        if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
        return
    }
    if ($Mode -eq 'full') {
        Remove-Full $root $manifest
        return
    }

    Write-Host ''
    Write-Host '请选择卸载方式：'
    Write-Host '  [1] 仅卸载「成就收藏册」主题（推荐，保留 Millennium 和其它主题/插件）'
    Write-Host '  [2] 卸载主题 + 本懒人包安装的 Millennium（仅限没有其它主题/插件）'
    Write-Host '  [0] 取消'
    Write-Host ''
    $choice = Read-Host '输入数字后回车'
    switch ($choice) {
        '1' {
            Stop-SteamIfNeeded $root
            Remove-ThemeOnly $root
            if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
        }
        '2' {
            Remove-Full $root $manifest
        }
        default {
            Stop-Uninstaller '已取消。'
        }
    }
}

try {
    Main
} catch {
    Write-Host "`n[错误] $($_.Exception.Message)" -ForegroundColor Red
    if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
    exit 1
}
