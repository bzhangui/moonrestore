param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '未安装 Node.js 22 或更高版本，请按 README 安装。' }
$nodeVersionText = & node --version
if ([int]($nodeVersionText.TrimStart('v').Split('.')[0]) -lt 22) { throw '需要 Node.js 22 或更高版本。' }
$builtEntry = Join-Path $projectRoot '_build\js\release\build\cmd\main\main.js'
if (-not (Test-Path -LiteralPath $builtEntry)) {
    if (-not (Get-Command moon -ErrorAction SilentlyContinue)) { throw '首次构建需要 MoonBit，请按 README 安装。' }
    & node (Join-Path $PSScriptRoot 'build.mjs')
    if ($LASTEXITCODE -ne 0) { throw '构建失败，请保留错误信息。' }
}
if ($CheckOnly) { & node (Join-Path $projectRoot 'bin\moonrestore.mjs') version; exit $LASTEXITCODE }
function Invoke-MoonRestore {
    param([string[]]$Arguments)
    & node (Join-Path $projectRoot 'bin\moonrestore.mjs') @Arguments
    if ($LASTEXITCODE -ne 0) { Write-Host '操作未成功，请根据上方信息处理。不要删除原始数据。' -ForegroundColor Yellow }
}
Write-Host 'MoonRestore：可验证的增量备份' -ForegroundColor Cyan
Write-Host '第一次使用请先创建仓库。重要备份建议放在独立磁盘；恢复目录必须不存在。'
while ($true) {
    Write-Host "`n1 创建仓库   2 备份目录   3 查看快照   4 校验全部   5 恢复快照   6 存储状态   7 中断恢复   8 安全演示   0 退出"
    $choice = Read-Host '选择'
    if ($choice -eq '0') { break }
    if ($choice -eq '8') { & node (Join-Path $projectRoot 'examples\demo.mjs'); continue }
    if ($choice -notin @('1','2','3','4','5','6','7')) { Write-Host '请选择列表中的数字。'; continue }
    $repositoryPath = (Read-Host '仓库完整路径（无需输入引号）').Trim()
    if (-not $repositoryPath) { Write-Host '路径不能为空。'; continue }
    switch ($choice) {
        '1' { Invoke-MoonRestore -Arguments @('init',$repositoryPath) }
        '2' {
            $sourcePath = (Read-Host '需要备份的文件夹完整路径').Trim()
            $snapshotLabel = Read-Host '本次备份备注（可为空）'
            Invoke-MoonRestore -Arguments @('plan',$repositoryPath,$sourcePath)
            if ($LASTEXITCODE -eq 0 -and (Read-Host '确认执行备份？输入 yes') -ceq 'yes') {
                Invoke-MoonRestore -Arguments @('backup',$repositoryPath,$sourcePath,'--label',$snapshotLabel)
            }
        }
        '3' { Invoke-MoonRestore -Arguments @('list',$repositoryPath) }
        '4' { Invoke-MoonRestore -Arguments @('verify',$repositoryPath,'all') }
        '5' {
            Invoke-MoonRestore -Arguments @('list',$repositoryPath)
            $snapshotId = (Read-Host '复制所需快照的完整 id').Trim()
            $restorePath = (Read-Host '全新恢复目录完整路径（不能已存在）').Trim()
            Invoke-MoonRestore -Arguments @('restore',$repositoryPath,$snapshotId,$restorePath)
        }
        '6' { Invoke-MoonRestore -Arguments @('status',$repositoryPath) }
        '7' {
            Write-Host '只回收已停止的本机进程锁和未提交临时文件；不删除历史快照。' -ForegroundColor Yellow
            if ((Read-Host '确认已停止其他备份进程？输入 yes') -ceq 'yes') { Invoke-MoonRestore -Arguments @('recover',$repositoryPath) }
        }
    }
}
