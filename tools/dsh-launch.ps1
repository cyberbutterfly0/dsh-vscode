<#
  DSH Launcher v5
  单实例 / 双实例，二选一
  用法：
    dsh-launch.bat                      交互选择
    dsh-launch.bat -Mode single         只起一个（默认 3080）
    dsh-launch.bat -Mode dual           起两个（3080 + 3081）
    dsh-launch.bat -Mode dual -Port2 3082
    dsh-launch.bat -DryRun              只看流程，不执行
  依赖：已全局安装 dsh（npm i -g @deepseek-ai/dsh），本机有 Edge 或 Chrome。
  注意：本文件必须保存为 UTF-8 带 BOM，Windows PowerShell 5.1 才认中文。
#>
param(
    [ValidateSet('ask', 'single', 'dual', 'stop')]
    [string]$Mode = 'ask',
    [int]$Port = 3080,
    [int]$Port2 = 3081,
    [string]$DshCmd = '',
    [string]$Edge = '',
    [switch]$NoRestart,
    [switch]$NoOpen,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$LogDir = Join-Path $env:USERPROFILE '.dsh\logs'

# 自动找 dsh：PATH 优先，其次 npm 全局 bin 目录
if (-not $DshCmd) {
    $found = Get-Command dsh -ErrorAction SilentlyContinue
    if ($found) { $DshCmd = $found.Source }
}
if (-not $DshCmd -or -not (Test-Path $DshCmd)) {
    try {
        $npmRoot = (& npm root -g 2>$null)
        if ($npmRoot) {
            $cand = Join-Path (Split-Path $npmRoot -Parent) 'dsh.cmd'
            if (Test-Path $cand) { $DshCmd = $cand }
        }
    } catch { }
}
if (-not $DshCmd -or -not (Test-Path $DshCmd)) {
    Write-Host 'ATONG: 找不到 dsh 命令。先 npm i -g @deepseek-ai/dsh，或用 -DshCmd 指定路径。' -ForegroundColor Red
    exit 1
}

# 自动找浏览器（Edge 优先，其次 Chrome）
if (-not $Edge) {
    $cands = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles}\Microsoft\Edge\Application\msedge.exe",
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
    )
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { $Edge = $c; break } }
}
if (-not $Edge) {
    Write-Host 'ATONG: 找不到 Edge/Chrome，加 -NoOpen 后自己打开打印出来的 URL。' -ForegroundColor Yellow
}
$UrlFile = Join-Path $LogDir 'last-launch.url'

function Select-Mode {
    $options = @('单实例', '双实例', '关闭所有')
    $idx = 0
    Write-Host ''
    $top = [Console]::CursorTop
    $width = 24
    try { $w = [Console]::WindowWidth - 2; if ($w -ge 20) { $width = $w } } catch { }
    while ($true) {
        for ($i = 0; $i -lt $options.Count; $i++) {
            try { [Console]::SetCursorPosition(0, $top + $i) } catch { }
            $mark = ' '
            if ($i -eq $idx) { $mark = '>' }
            $text = '  {0} {1}' -f $mark, $options[$i]
            if ($text.Length -lt $width) { $text = $text + (' ' * ($width - $text.Length)) }
            if ($i -eq $idx) {
                Write-Host $text -ForegroundColor Black -BackgroundColor Cyan
            } else {
                Write-Host $text -ForegroundColor Gray
            }
        }
        $key = [Console]::ReadKey($true)
        switch ([string]$key.Key) {
            'UpArrow'   { if ($idx -gt 0) { $idx-- } }
            'DownArrow' { if ($idx -lt ($options.Count - 1)) { $idx++ } }
            'Enter' {
                try { [Console]::SetCursorPosition(0, $top + $options.Count + 1) } catch { }
                if ($idx -eq 0) { return 'single' }
                if ($idx -eq 1) { return 'dual' }
                return 'stop'
            }
            'Escape' {
                try { [Console]::SetCursorPosition(0, $top + $options.Count + 1) } catch { }
                return 'single'
            }
            default {
                $ch = [string]$key.KeyChar
                if ($ch -eq '1') { $idx = 0 }
                elseif ($ch -eq '2') { $idx = 1 }
                elseif ($ch -eq '3') { $idx = 2 }
            }
        }
    }
}
function Write-Step([string]$text, [string]$color = 'Cyan') {
    Write-Host $text -ForegroundColor $color
}

function Get-DshProcesses {
    @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh[\\/]lib[\\/]bin\.js' })
}

function Get-PortOf($Proc) {
    if ($Proc.CommandLine -match '--port\s+(\d+)') { return [int]$Matches[1] }
    return 3080
}

function Test-DshUp([int]$p) {
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/" -f $p) -UseBasicParsing -TimeoutSec 3
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500)
    } catch {
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
        return ($code -ge 200 -and $code -lt 500)
    }
}

function Test-TokenUrl([string]$url) {
    if (-not $url) { return $false }
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -MaximumRedirection 0
        return $true
    } catch {
        $code = 0
        try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = 0 }
        return ($code -eq 301 -or $code -eq 302 -or $code -eq 303 -or $code -eq 307 -or $code -eq 308)
    }
}

function Read-LaunchFile([string]$file) {
    if (-not (Test-Path $file)) { return $null }
    foreach ($line in ([System.IO.File]::ReadAllLines($file))) {
        $m = [regex]::Match($line, 'https?://\S+')
        if ($m.Success) { return $m.Value }
    }
    return $null
}

function Write-LaunchFile([string]$file, [string]$url, [int]$p) {
    $lines = @(
        $url
        ('# port=' + $p)
        ('# written=' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
        '# 第一行必须是 dsh web 启动时打印的完整 URL（带 token）。'
        '# VS Code 扩展读这里拿 token，不要手改。'
    )
    Set-Content -Path $file -Value $lines -Encoding UTF8
}

function Write-InstancesFile {
    $list = Get-DshProcesses
    $items = @()
    foreach ($x in $list) {
        $port = Get-PortOf $x
        $items += [pscustomobject]@{
            pid          = [int]$x.ProcessId
            port         = $port
            startedAt    = ([datetime]$x.CreationDate).ToString('yyyy-MM-dd HH:mm:ss')
            workingSetMB = [int]([math]::Round($x.WorkingSetSize / 1MB))
            health       = $(if (Test-DshUp $port) { 'ok' } else { 'down' })
        }
    }
    $payload = [pscustomobject]@{
        generatedAt = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
        count       = @($items).Count
        instances   = $items
    }
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
    $payload | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $LogDir 'dsh-instances.json') -Encoding UTF8
}

function Stop-DshAll {
    $killed = 0
    $failed = 0
    foreach ($x in (Get-DshProcesses)) {
        $port = Get-PortOf $x
        try {
            Stop-Process -Id $x.ProcessId -Force -ErrorAction Stop
            $killed++
            Write-Host ('      killed PID {0} (port {1})' -f $x.ProcessId, $port) -ForegroundColor DarkGray
        } catch {
            $failed++
            Write-Host ('      失败 PID {0}: {1}' -f $x.ProcessId, $_.Exception.Message) -ForegroundColor Red
        }
    }
    return [pscustomobject]@{ killed = $killed; failed = $failed }
}

function Wait-PortListen([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Wait-PortFree([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return $false
}

function Find-TokenUrl([string]$file, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path $file) {
            try {
                $fs = [System.IO.File]::Open($file, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $sr = New-Object System.IO.StreamReader($fs)
                $raw = $sr.ReadToEnd()
                $sr.Close(); $fs.Close()
                $m = [regex]::Match($raw, 'dsh web:\s*(http://127\.0\.0\.1:\d+/\S+)')
                if ($m.Success) { return $m.Groups[1].Value }
            } catch { }
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Start-One([int]$p) {
    $out = Join-Path $env:TEMP ('dsh-web-url-{0}.out' -f $p)
    if (Test-Path $out) { Remove-Item $out -Force -ErrorAction SilentlyContinue }
    # 显式带 --port，这样进程命令行里能看出来是哪个实例
    Start-Process -FilePath $DshCmd -ArgumentList @('web', '--port', "$p", '--no-open') `
        -WindowStyle Hidden -RedirectStandardOutput $out | Out-Null
    if (-not (Wait-PortListen $p 90)) {
        Write-Host ('      错误：端口 {0} 没起来。看 {1}' -f $p, $out) -ForegroundColor Red
        return $null
    }
    $url = Find-TokenUrl -File $out -Seconds 25
    if (-not $url) {
        Write-Host ('      错误：端口 {0} 起来了但没抓到 token URL' -f $p) -ForegroundColor Red
        return $null
    }
    return $url
}

# ---------------- 主流程 ----------------
$mutex = New-Object System.Threading.Mutex($false, 'Local\dsh-launch-lock')
$gotLock = $false
try {
    try { $gotLock = $mutex.WaitOne(0) } catch { $gotLock = $false }
    if (-not $gotLock) {
        Write-Host '另一个启动器正在运行，本次退出。' -ForegroundColor Yellow
        exit 0
    }

    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }

    # 模式选择：上下键选，回车确认
    if ($Mode -eq 'ask' -and -not $DryRun) {
        $choice = 'single'
        try {
            $choice = Select-Mode
        } catch {
            $choice = 'single'
            Write-Host '（当前不是交互式终端，按单实例处理）' -ForegroundColor DarkGray
        }
        if ($choice -eq 'stop') {
            Write-Host ''
            $allStop = Get-DshProcesses
            Write-Host ('正在停止 {0} 个 DSH 实例 ...' -f @($allStop).Count) -ForegroundColor Yellow
            $rStop = Stop-DshAll
            Write-Host ('已停止 {0} 个，失败 {1} 个。' -f $rStop.killed, $rStop.failed) -ForegroundColor Green
            Write-InstancesFile
            Write-Host '现在没有 dsh 在跑了。' -ForegroundColor Green
            exit 0
        }
        $Mode = $choice
    }
    if ($Mode -eq 'ask') { $Mode = 'single' }
    # 命令行直接 -Mode stop 时，跳过菜单直接全停
    if ($Mode -eq 'stop') {
        $allStop0 = Get-DshProcesses
        if ($DryRun) {
            Write-Host ('[stop] (DryRun) 将停止 {0} 个 DSH 进程' -f @($allStop0).Count) -ForegroundColor DarkGray
            exit 0
        }
        Write-Host ''
        Write-Host ('正在停止 {0} 个 DSH 实例 ...' -f @($allStop0).Count) -ForegroundColor Yellow
        $rStop0 = Stop-DshAll
        Write-Host ('已停止 {0} 个，失败 {1} 个。' -f $rStop0.killed, $rStop0.failed) -ForegroundColor Green
        Write-InstancesFile
        Write-Host '现在没有 dsh 在跑了。' -ForegroundColor Green
        exit 0
    }    $wantDual = ($Mode -eq 'dual')

    Write-Host ''
    Write-Host '============================================' -ForegroundColor Cyan
    Write-Host (' DSH Launcher v5   Mode={0}  DryRun={1}' -f $Mode, $DryRun) -ForegroundColor Yellow
    Write-Host '============================================' -ForegroundColor Cyan

    $urls = @{}

    # 1/6 盘点
    $all = Get-DshProcesses
    Write-Step ('[1/6] 当前 DSH 实例：{0} 个' -f @($all).Count)
    foreach ($x in $all) {
        Write-Host ('      PID {0}  端口 {1}' -f $x.ProcessId, (Get-PortOf $x)) -ForegroundColor DarkGray
    }

    # 2/6 决定复用还是重启（只有单实例模式允许复用）
    $reuse = $false
    if (-not $wantDual -and @($all).Count -eq 1 -and (Test-DshUp $Port)) {
        $existing = Read-LaunchFile $UrlFile
        if ($existing -and (Test-TokenUrl $existing)) {
            $reuse = $true
            $urls[$Port] = $existing
            Write-Step '[2/6] 复用现有实例（token 有效，不重启）' 'Green'
        } elseif ($NoRestart) {
            Write-Step '[2/6] 指定了 -NoRestart，但 token 已失效，不会杀任何进程。' 'Yellow'
            Write-Step '      要去掉 -NoRestart 再点一次才能换新 token。' 'Yellow'
            exit 0
        } else {
            Write-Step '[2/6] token 已失效，需要重启' 'Yellow'
        }
    } elseif ($wantDual) {
        Write-Step '[2/6] 双实例模式：总是重启，保证两个端口都干净' 'Cyan'
    } else {
        Write-Step '[2/6] 需要重启' 'Cyan'
    }

    if (-not $reuse) {
        # 3/6 清理
        if ($DryRun) {
            Write-Host ('[3/6] (DryRun) 将杀掉 {0} 个 DSH 进程' -f @($all).Count) -ForegroundColor DarkGray
        } else {
            Write-Step '[3/6] 清理全部 DSH 进程'
            $r = Stop-DshAll
            Write-Host ('      杀掉 {0} 个，失败 {1} 个' -f $r.killed, $r.failed) -ForegroundColor Green
            if (-not (Wait-PortFree $Port 20)) { Write-Host ('      警告：端口 {0} 仍被占用' -f $Port) -ForegroundColor Yellow }
            if ($wantDual -and -not (Wait-PortFree $Port2 20)) { Write-Host ('      警告：端口 {0} 仍被占用' -f $Port2) -ForegroundColor Yellow }
        }

        # 4/6 启动
        $ports = @($Port)
        if ($wantDual) { $ports = @($Port, $Port2) }
        foreach ($p in $ports) {
            if ($DryRun) {
                Write-Host ('[4/6] (DryRun) 将执行：{0} web --port {1} --no-open' -f $DshCmd, $p) -ForegroundColor DarkGray
            } else {
                Write-Step ('[4/6] 启动 {0} ...' -f $p)
                $u = Start-One -p $p
                if (-not $u) {
                    Write-Step ('      端口 {0} 启动失败，放弃' -f $p) 'Red'
                    exit 1
                }
                $urls[$p] = $u
                Write-Host ('      OK  http://127.0.0.1:{0}/' -f $p) -ForegroundColor Green
            }
        }
    }

    # 5/6 自检 + 落账
    $after = Get-DshProcesses
    $expect = 1
    if ($wantDual) { $expect = 2 }
    $ok = (@($after).Count -eq $expect)
    $color = 'Green'
    if (-not $ok) { $color = 'Red' }
    Write-Host ('[5/6] 自检：运行中的 DSH 实例 {0} 个（应为 {1}）' -f @($after).Count, $expect) -ForegroundColor $color

    if (-not $DryRun) {
        Write-InstancesFile
        if ($urls.ContainsKey($Port)) { Write-LaunchFile $UrlFile $urls[$Port] $Port }
        if ($wantDual -and $urls.ContainsKey($Port2)) {
            Write-LaunchFile (Join-Path $LogDir ('last-launch-{0}.url' -f $Port2)) $urls[$Port2] $Port2
        }
    }

    # 6/6 打开 + 输出
    if ($urls.ContainsKey($Port)) {
        if ($DryRun) {
            Write-Host ('[6/6] (DryRun) 将用 Edge app 窗口打开：{0}' -f $urls[$Port]) -ForegroundColor DarkGray
        } elseif (-not $NoOpen) {
            Write-Step '[6/6] 用 Edge app 窗口打开'
            & $Edge ('--app=' + $urls[$Port]) '--profile-directory=Default' | Out-Null
        }
    }

    Write-Host ''
    Write-Host '--------------------------------------------' -ForegroundColor DarkGray
    foreach ($p in ($urls.Keys | Sort-Object)) {
        $label = '实例'
        if ($wantDual) { if ($p -eq $Port) { $label = 'A 实例' } else { $label = 'B 实例' } }
        Write-Host (' {0}  {1}  {2}' -f $label, $p, $urls[$p]) -ForegroundColor White
    }
    Write-Host (' token 文件：{0}' -f $UrlFile) -ForegroundColor DarkGray
    if ($wantDual) {
        Write-Host (' B 实例的 URL 也写到了：{0}' -f (Join-Path $LogDir ('last-launch-{0}.url' -f $Port2))) -ForegroundColor DarkGray
        Write-Host ''
        Write-Host ' 让某个项目固定连 B 实例：在那个项目的 .vscode/settings.json 里加' -ForegroundColor Cyan
        Write-Host ('   "dsh.attachUrl": "' + $urls[$Port2] + '"') -ForegroundColor Gray
    }
    Write-Host '--------------------------------------------' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '完成。' -ForegroundColor Green
}
finally {
    if ($gotLock) {
        try { $mutex.ReleaseMutex() } catch { }
    }
    $mutex.Dispose()
}