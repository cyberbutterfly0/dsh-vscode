# ============================================================
#  DSH 实例盘点（只读，绝不杀任何进程）
#
#  用来回答三个问题：
#   1) 我现在到底开了几个 dsh？
#   2) 那个被"占用"的会话，锁在哪个进程手里？
#   3) 扩展该连哪个地址？现在的 token 还有效吗？
#
#  用法：
#    dsh-status.bat              看当前状态
#    dsh-status.bat -Watch 5     每 5 秒刷新一次（Ctrl+C 退出）
#
#  编码：UTF-8 带 BOM。Windows PowerShell 5.1 读无 BOM 文件会把
#  中文当 ANSI，导致乱码或解析失败。
# ============================================================

[CmdletBinding()]
param(
    [int]$Watch = 0
)

$ErrorActionPreference = 'SilentlyContinue'

$DshHome       = Join-Path $env:USERPROFILE '.dsh'
$LogDir        = Join-Path $DshHome 'logs'
$LaunchFile    = Join-Path $LogDir 'last-launch.url'
$InstancesFile = Join-Path $LogDir 'dsh-instances.json'

function Get-DshProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' })
}

function Get-PortOf {
    param($Proc)
    if ($Proc.CommandLine -match '--port\s+(\d+)') { return [int]$Matches[1] }
    return 3080
}

function Test-DshUp {
    param([int]$p)
    try {
        Invoke-WebRequest -Uri ('http://127.0.0.1:' + $p + '/') -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
        return $true
    } catch {
        $st = 0
        if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
        return ($st -ge 200 -and $st -lt 500)
    }
}

function Test-TokenUrl {
    param([string]$u)
    if (-not $u) { return $false }
    try {
        Invoke-WebRequest -Uri $u -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop | Out-Null
        return $true
    } catch {
        $st = 0
        if ($_.Exception.Response) { $st = [int]$_.Exception.Response.StatusCode }
        return ($st -eq 303 -or $st -eq 302)
    }
}

function Read-LaunchUrl {
    if (-not (Test-Path -LiteralPath $LaunchFile)) { return $null }
    foreach ($line in (Get-Content -LiteralPath $LaunchFile -ErrorAction SilentlyContinue)) {
        if ($line -match 'https?://\S+') { return $Matches[0] }
    }
    return $null
}

function Show-Once {
    $procs = Get-DshProcesses

    Write-Host ''
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host (' DSH 实例盘点  {0}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) -ForegroundColor Cyan
    Write-Host '============================================' -ForegroundColor Cyan

    if (@($procs).Count -eq 0) {
        Write-Host '没有任何 dsh 在跑。' -ForegroundColor Yellow
        Write-Host '点启动器即可。' -ForegroundColor DarkGray
        return
    }

    $rows = @()
    foreach ($p in $procs) {
        $gp = $null
        try { $gp = Get-Process -Id $p.ProcessId -ErrorAction Stop } catch { }
        $lp = Get-PortOf $p
        $up = Test-DshUp $lp
        $par = $p.ParentProcessId
        $parName = $null
        try { $parName = (Get-Process -Id $par -ErrorAction Stop).ProcessName } catch { $parName = '<已退出>' }
        $rows += [pscustomobject]@{
            PID     = [int]$p.ProcessId
            '端口'  = $lp
            '启动'  = $($(if ($gp) { $gp.StartTime.ToString('MM-dd HH:mm') } else { '?' }))
            '内存MB' = $($(if ($gp) { [int][math]::Round($gp.WorkingSet64 / 1MB, 0) } else { -1 }))
            '健康'  = $(if ($up) { '正常' } else { '无响应' })
            '父进程' = $(if ($parName) { "$parName($par)" } else { "?($par)" })
        }
    }
    $rows | Format-Table -AutoSize | Out-String | Write-Host

    # 结论
    Write-Host '--------------------------------------------' -ForegroundColor DarkGray
    if (@($procs).Count -eq 1) {
        Write-Host '只有一个实例 —— 这是正常状态。' -ForegroundColor Green
    } else {
        Write-Host ('发现 {0} 个实例！浏览器和 VS Code 会互相抢同一批会话的写锁，' -f @($procs).Count) -ForegroundColor Red
        Write-Host '在 dsh 里打开别的窗口聊过的会话就会报"当前会话已被占用"。' -ForegroundColor Red
        Write-Host '处理办法：关掉多余的那些，或者直接点一次启动器（它会全清理后只起一个）。' -ForegroundColor Yellow
    }

    # token
    Write-Host ''
    $u = Read-LaunchUrl
    if (-not $u) {
        Write-Host 'token 文件：不存在 —— 扩展连不上，请点一次启动器。' -ForegroundColor Yellow
        Write-Host ('            （期望位置：{0}）' -f $LaunchFile) -ForegroundColor DarkGray
    } elseif (Test-TokenUrl $u) {
        $noTok = $u -replace '\?token=[^&]*', '?token=***'
        Write-Host 'token 文件：有效' -ForegroundColor Green
        Write-Host ('            {0}' -f $noTok) -ForegroundColor DarkGray
    } else {
        Write-Host 'token 文件：已失效（那个 dsh 进程已经退出了）' -ForegroundColor Yellow
        Write-Host '            点一次启动器会重新生成。' -ForegroundColor DarkGray
    }

    # 扩展凭据（结构：{ version, instances: { "127.0.0.1:60291": {...} } }）
    $instJson = Join-Path $DshHome 'dsh-vscode\instances.json'
    if (Test-Path -LiteralPath $instJson) {
        try {
            $v = Get-Content -LiteralPath $instJson -Raw | ConvertFrom-Json
            $entries = @()
            if ($v.instances) {
                foreach ($k in @($v.instances.PSObject.Properties.Name)) {
                    $entries += [pscustomobject]@{ key = $k }
                }
            }
            Write-Host ''
            Write-Host ('VS Code 扩展记录的实例：{0} 个' -f @($entries).Count) -ForegroundColor DarkGray
            foreach ($e in $entries) {
                $alive = $false
                if ($e.key -match ':(\d+)$') { $alive = Test-DshUp ([int]$Matches[1]) }
                $mark = if ($alive) { '活着 —— 扩展正连这个' } else { '已死（残留记录，扩展下次连接会覆盖）' }
                Write-Host ('            {0}  ->  {1}' -f $e.key, $mark) -ForegroundColor DarkGray
            }
        } catch { }
    }

    if (Test-Path -LiteralPath $InstancesFile) {
        Write-Host ''
        Write-Host ('最近一次启动清单：{0}' -f $InstancesFile) -ForegroundColor DarkGray
    }
    Write-Host ''
}

if ($Watch -gt 0) {
    while ($true) {
        Clear-Host
        Show-Once
        Write-Host ('（{0} 秒后刷新，Ctrl+C 退出）' -f $Watch) -ForegroundColor DarkGray
        Start-Sleep -Seconds $Watch
    }
} else {
    Show-Once
}
