# FRP-ALL-IN-ONE Windows 容器客户端移除；使用部署时的账号和容器上下文。
param(
    [switch]$Purge,
    [switch]$Force,
    [string]$InstallDir = "C:\frp",
    [ValidateSet("auto", "docker")]
    [string]$Runtime = "auto"
)
$ErrorActionPreference = "Stop"
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$rootDir = [System.IO.Path]::GetPathRoot($InstallDir).TrimEnd('\')
if ($InstallDir -eq $rootDir -or $InstallDir -eq $env:USERPROFILE) {
    throw "不能清理磁盘根目录或用户主目录。"
}
if ((Test-Path -LiteralPath $InstallDir) -and
    ((Get-Item -LiteralPath $InstallDir).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "不能通过符号链接或目录联接清理数据目录。"
}
Write-Host "[INFO] 只移除 frp-agent 项目容器，不卸载 Docker，不终止其他 FRP 进程。"
if ($Purge) {
    Write-Warning "将额外删除已确认归属的配置和日志: $InstallDir，此操作不可恢复。"
} else {
    Write-Host "[INFO] 默认保留配置与日志；彻底清理需指定 -Purge。"
}
if (-not $Force -and (Read-Host "输入 REMOVE 确认") -cne "REMOVE") {
    Write-Host "[INFO] 已取消"
    return
}
$available = $false
$owned = Test-Path -LiteralPath (Join-Path $InstallDir '.frp-all-in-one-client') -PathType Leaf
$engines = @('docker')
foreach ($cli in $engines) {
    if (-not (Get-Command $cli -ErrorAction SilentlyContinue)) { continue }
    # Windows PowerShell 将原生命令 stderr 作为错误流，检测失败时只跳过该引擎。
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $cli info *> $null
        $engineOk = $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    if (-not $engineOk) { continue }
    $available = $true
    $ErrorActionPreference = 'Continue'
    try {
        $image = & $cli inspect --format '{{.Config.Image}}' frp-agent 2>$null
        $exists = $LASTEXITCODE -eq 0
    } finally {
        $ErrorActionPreference = $oldPreference
    }
    if (-not $exists) { continue }
    if ($image -match '^sha256:[a-f0-9]{64}$') {
        $refs = & $cli image inspect --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' $image
        if ($LASTEXITCODE -ne 0) { throw "无法核实客户端镜像归属，已保留容器及数据。" }
        $matched = @($refs | Where-Object { $_ -match '^sgccr\.ccs\.tencentyun\.com/frp-all-in-one/frp-agent(?::[^\s]+|@[^\s]+)$' })
        if ($matched.Count -gt 0) { $image = $matched[0] }
    }
    if ($image -notmatch '^sgccr\.ccs\.tencentyun\.com/frp-all-in-one/frp-agent(?::[^\s]+|@[^\s]+)?$') {
        throw "$cli 中的 frp-agent 不使用本项目镜像，已中止并保留数据以免误删。"
    }
    $sources = @(
        (& $cli inspect --format '{{range .Mounts}}{{if eq .Destination "/opt/frp"}}{{.Source}}{{end}}{{end}}' frp-agent),
        (& $cli inspect --format '{{range .Mounts}}{{if eq .Destination "/opt/frp/logs"}}{{.Source}}{{end}}{{end}}' frp-agent)
    )
    foreach ($source in $sources) {
        if ($source -and ($source.TrimEnd('\', '/') -ieq $InstallDir -or
            $source.TrimEnd('\', '/') -ieq (Join-Path $InstallDir 'logs'))) {
            $owned = $true
        }
    }
    $removeArgs = @('rm', '-f')
    if ($Purge) { $removeArgs += '-v' }
    $removeArgs += 'frp-agent'
    & $cli @removeArgs
    if ($LASTEXITCODE -ne 0) { throw "客户端移除失败，配置和日志已保留。" }
}
if (-not $available) {
    throw "当前账号没有可用的容器引擎。请启动 Docker Desktop，并使用部署时的账号重试。"
}
if ($Purge -and (Test-Path -LiteralPath $InstallDir)) {
    if ($owned) {
        foreach ($item in @('frpc.toml', 'logs', '.frp-all-in-one-client')) {
            $path = Join-Path $InstallDir $item
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Recurse -Force
            }
        }
        if (-not (Get-ChildItem -LiteralPath $InstallDir -Force)) {
            Remove-Item -LiteralPath $InstallDir -Force
        }
    } else {
        Write-Warning "无法确认数据目录归属，已保留文件。旧安装请指定实际的 -InstallDir。"
    }
}
Write-Host "[OK] 移除流程完成。请回管理控制台注销设备及隧道。镜像、运行时和无关容器均保留。"
