#requires -Version 5.1
<#
  成就收藏册 · Windows 懒人包安装器
  内置官方 Millennium v3.6.2 原版发布包（未修改），只负责解压、复制主题和写入安装记录。
  本脚本不会修改 Steam 的登录信息或游戏文件。
#>
[CmdletBinding()]
param(
    [string]$SteamPath = '',
    [switch]$NoLaunch,
    [switch]$InternalNoElevate,
    [switch]$InternalSkipProcessStop,
    [switch]$InternalThemeOnly,
    [switch]$InternalYes
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $global:OutputEncoding = New-Object Text.UTF8Encoding($false)
} catch { }
$script:ThemeVersion = '1.1.0'
$script:MillenniumVersion = '3.6.2'
$script:ThemeFolderName = 'AchievementCollection'
$script:PackageDir = $PSScriptRoot
$script:AutoYes = [bool]$InternalYes

function Write-Step([string]$Text) {
    Write-Host "`n==> $Text" -ForegroundColor Cyan
}

function Write-Ok([string]$Text) {
    Write-Host "  [OK] $Text" -ForegroundColor Green
}

function Write-Note([string]$Text) {
    Write-Host "  [!] $Text" -ForegroundColor Yellow
}

function Stop-Installer([string]$Message) {
    Write-Host "`n[错误] $Message" -ForegroundColor Red
    if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
    exit 1
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
        $clean = [Environment]::ExpandEnvironmentVariables($candidate).Trim().Trim('"').Replace('/', '\')
        $clean = $clean.TrimEnd('\')
        if (Test-Path -LiteralPath (Join-Path $clean 'steam.exe') -PathType Leaf) {
            return (Resolve-Path -LiteralPath $clean).Path.TrimEnd('\')
        }
    }

    if ($script:AutoYes) { Stop-Installer '未找到 Steam 安装目录。' }
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
    Stop-Installer '未找到有效的 Steam 安装目录。'
}

function Invoke-Elevated([string]$Root) {
    $arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -SteamPath `"$Root`""
    if ($NoLaunch) { $arguments += ' -NoLaunch' }
    Write-Note '需要管理员权限才能写入 Steam 目录，正在请求提权……'
    try {
        $process = Start-Process -FilePath (Get-PowerShellPath) -Verb RunAs -ArgumentList $arguments -Wait -PassThru
        exit $process.ExitCode
    } catch {
        Stop-Installer '未获得管理员权限，安装已取消。'
    }
}

function Assert-Package {
    Write-Step '检查安装包'
    $themeSkin = Join-Path $script:PackageDir 'theme\skin.json'
    $zip = Join-Path $script:PackageDir ("millennium-v{0}-windows-x86_64.zip" -f $script:MillenniumVersion)
    $shaFile = Join-Path $script:PackageDir ("millennium-v{0}-windows-x86_64.sha256" -f $script:MillenniumVersion)
    if (-not (Test-Path -LiteralPath $themeSkin -PathType Leaf)) {
        Stop-Installer '安装包不完整：缺少 theme\skin.json。请先把整个压缩包解压到文件夹，再运行 Install.bat。'
    }
    if (-not (Test-Path -LiteralPath $zip -PathType Leaf) -or -not (Test-Path -LiteralPath $shaFile -PathType Leaf)) {
        Stop-Installer '安装包不完整：缺少内置的 Millennium 压缩包或校验文件。请重新下载并完整解压。'
    }
    $expected = ([IO.File]::ReadAllText($shaFile)).Trim().Split()[0].ToLowerInvariant()
    if ($expected -notmatch '^[0-9a-f]{64}$') {
        Stop-Installer 'Millennium 校验文件格式不正确。'
    }
    $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Stop-Installer "内置 Millennium 压缩包校验失败，文件可能损坏或被修改。`n  期望：$expected`n  实际：$actual"
    }
    Write-Ok "主题 v$script:ThemeVersion"
    Write-Ok "Millennium v$script:MillenniumVersion（SHA256 校验通过）"
    return $zip
}

function Get-InstallerDir([string]$Root) {
    $dir = Join-Path $Root 'millennium\.ac-installer'
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
    return $dir
}

function Install-ThemeFiles([string]$Root) {
    Write-Step '安装主题'
    $source = Join-Path $script:PackageDir 'theme'
    $themesDir = Join-Path $Root 'millennium\themes'
    $destination = Join-Path $themesDir $script:ThemeFolderName
    New-Item -ItemType Directory -Path $themesDir -Force | Out-Null

    $backup = $null
    if (Test-Path -LiteralPath $destination) {
        $backupRoot = Join-Path (Get-InstallerDir $Root) 'backup'
        New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
        $backup = Join-Path $backupRoot ('theme-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
        Copy-Item -LiteralPath $destination -Destination $backup -Recurse -Force
        Remove-Item -LiteralPath $destination -Recurse -Force
        Write-Note "已备份旧主题到 $backup"
    }

    Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    if (-not (Test-Path -LiteralPath (Join-Path $destination 'skin.json') -PathType Leaf)) {
        Stop-Installer "主题复制失败，请检查目标目录：$destination"
    }
    Write-Ok "主题已放到 $destination"
    return $backup
}

function Install-MillenniumCore([string]$Root, [string]$Zip) {
    Write-Step '安装 Millennium 核心'
    if (Test-Path -LiteralPath (Join-Path $Root 'wsock32.dll')) {
        Stop-Installer 'Steam 目录下突然出现 wsock32.dll，为避免覆盖，安装已停止。请重试。'
    }

    $installerDir = Get-InstallerDir $Root
    $staging = Join-Path $installerDir 'staging'
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    try {
        Expand-Archive -LiteralPath $Zip -DestinationPath $staging -Force
        $checks = @(
            'millennium\lib\millennium.dll',
            'millennium\bin\millennium.luavm64.exe',
            'wsock32.dll'
        )
        foreach ($relative in $checks) {
            if (-not (Test-Path -LiteralPath (Join-Path $staging $relative) -PathType Leaf)) {
                Stop-Installer "Millennium 压缩包结构异常：缺少 $relative"
            }
        }

        foreach ($item in @(Get-ChildItem -LiteralPath $staging -Force)) {
            $target = Join-Path $Root $item.Name
            if ($item.PSIsContainer) {
                if (Test-Path -LiteralPath $target -PathType Container) {
                    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
                        Copy-Item -LiteralPath $child.FullName -Destination $target -Recurse -Force
                    }
                } else {
                    Copy-Item -LiteralPath $item.FullName -Destination $target -Recurse -Force
                }
            } else {
                Copy-Item -LiteralPath $item.FullName -Destination $target -Force
            }
        }
    } finally {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }

    if (-not (Test-Path -LiteralPath (Join-Path $Root 'millennium\lib\millennium.dll') -PathType Leaf)) {
        Stop-Installer 'Millennium 核心安装失败，millennium.dll 不存在。'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Root 'wsock32.dll') -PathType Leaf)) {
        Stop-Installer 'Millennium 核心安装失败，wsock32.dll 不存在。'
    }
    Write-Ok 'Millennium v3.6.2 核心文件已就位'
}

function Write-InstallManifest([string]$Root, [bool]$InstalledCore, [string]$ThemeBackup) {
    $installerDir = Get-InstallerDir $Root
    $path = Join-Path $installerDir 'manifest.json'
    $existing = $null
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        try { $existing = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
    }
    $coreFlag = $InstalledCore
    if (-not $coreFlag -and $existing -and $existing.installedCore -eq $true) {
        $coreFlag = $true
    }
    $manifest = [ordered]@{
        schema               = 1
        theme                = '成就收藏册'
        themeFolder          = $script:ThemeFolderName
        themeVersion         = $script:ThemeVersion
        millenniumVersion    = $script:MillenniumVersion
        installedAt          = (Get-Date).ToString('o')
        installedCore        = $coreFlag
        themeBackup          = $ThemeBackup
    }
    $json = $manifest | ConvertTo-Json -Depth 4
    [IO.File]::WriteAllText($path, $json, (New-Object Text.UTF8Encoding($false)))
    Write-Ok "安装记录：$path"
}

function Stop-SteamIfNeeded([string]$Root) {
    if ($InternalSkipProcessStop) { return }
    $running = @(Get-Process -Name 'steam' -ErrorAction SilentlyContinue)
    if ($running.Count -eq 0) { return }

    Write-Note '检测到 Steam 正在运行。安装/卸载需要先关闭 Steam。'
    if (-not (Confirm-Step '现在关闭 Steam 并继续吗？' $true)) {
        Stop-Installer '已取消。请手动退出 Steam 后重试。'
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
        Stop-Installer 'Steam 仍在运行，请手动关闭后重试。'
    }
    Write-Ok 'Steam 已关闭'
}

function Show-Finish([string]$Root, [bool]$CoreInstalled) {
    Write-Host ''
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host ' 安装完成' -ForegroundColor Green
    Write-Host '==============================================' -ForegroundColor Green
    Write-Host ''
    Write-Host "主题目录：$(Join-Path $Root "millennium\themes\$script:ThemeFolderName")"
    if ($CoreInstalled) {
        Write-Host "Millennium：v$script:MillenniumVersion（内置官方原版）"
    } else {
        Write-Host 'Millennium：未改动（仅安装/更新了主题）'
    }
    Write-Host ''
    Write-Host '接下来：'
    Write-Host '  1. 启动 Steam，打开 Steam 设置 → Millennium → Themes'
    Write-Host '  2. 选择「成就收藏册」并启用'
    Write-Host '  3. 打开 Steam 库顶部菜单 → ★ 成就卡包'
    Write-Host ''
    Write-Host '卸载：运行 Uninstall.bat，可选择只删主题或连同 Millennium 一起卸载。'
    Write-Host ''

    if (-not $script:AutoYes -and -not $NoLaunch) {
        if (Confirm-Step '现在启动 Steam 吗？' $true) {
            try {
                Start-Process -FilePath (Join-Path $Root 'steam.exe') | Out-Null
            } catch {
                Write-Note '启动 Steam 失败，请手动启动。'
            }
        }
    }
    if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
}

function Main {
    Write-Host ''
    Write-Host '  成就收藏册 · 懒人包安装器' -ForegroundColor White
    Write-Host "  主题 v$script:ThemeVersion  |  Millennium v$script:MillenniumVersion" -ForegroundColor DarkGray
    Write-Host ''

    if (-not [Environment]::Is64BitOperatingSystem) {
        Stop-Installer '本安装包只支持 64 位 Windows。'
    }

    $zip = Assert-Package
    $root = Get-SteamPath $SteamPath
    Write-Ok "Steam 目录：$root"

    if (-not (Test-Writable $root)) {
        if (Test-Admin) { Stop-Installer 'Steam 目录不可写，请检查目录权限。' }
        if ($InternalNoElevate) { Stop-Installer '没有写入 Steam 目录的权限。' }
        Invoke-Elevated $root
        return
    }

    $hasMillennium = Test-Path -LiteralPath (Join-Path $root 'millennium\lib\millennium.dll') -PathType Leaf
    $hasWsock = Test-Path -LiteralPath (Join-Path $root 'wsock32.dll') -PathType Leaf
    $themeOnly = $false

    if ($hasMillennium -or $hasWsock) {
        Write-Note '检测到 Steam 目录里已经存在 Millennium 或 wsock32.dll。'
        Write-Host '  懒人包不会覆盖现有 Millennium/其它注入，只提供“仅安装/更新主题”。'
        if (-not $hasMillennium) {
            Write-Note '没有找到 millennium.dll，这个 wsock32.dll 可能来自其它模组。仅安装主题后仍需要单独的 Millennium 才能使主题生效。'
        }
        Write-Host '  如果你的 Millennium 已经能正常使用，这个选项是安全的。'
        if ($InternalThemeOnly -or (Confirm-Step '仅安装/更新主题吗？' $true)) {
            $themeOnly = $true
        } else {
            Stop-Installer '已取消。已安装 Millennium 的用户请使用主题版压缩包。'
        }
    }

    Stop-SteamIfNeeded $root

    if ($themeOnly) {
        $backup = Install-ThemeFiles $root
        Write-InstallManifest $root $false $backup
        Show-Finish $root $false
        return
    }

    Install-MillenniumCore $root $zip
    $backup = Install-ThemeFiles $root
    Write-InstallManifest $root $true $backup
    Show-Finish $root $true
}

try {
    Main
} catch {
    Write-Host "`n[错误] $($_.Exception.Message)" -ForegroundColor Red
    if (-not $script:AutoYes) { Read-Host '按 Enter 退出' | Out-Null }
    exit 1
}
