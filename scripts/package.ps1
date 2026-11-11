param([Parameter(Mandatory=$true)][string]$StudentName,[Parameter(Mandatory=$true)][string]$StudentId,[Parameter(Mandatory=$true)][string]$Report,[Parameter(Mandatory=$true)][string]$Video)
$ErrorActionPreference = 'Stop'
if ($StudentName -match '[<>:"/\\|?*]' -or $StudentId -notmatch '^\d+$') { throw '姓名/学号格式不正确' }
$projectRoot = Split-Path -Parent $PSScriptRoot
$reportPath = (Resolve-Path -LiteralPath $Report).Path
$videoPath = (Resolve-Path -LiteralPath $Video).Path
$reportExtension = [IO.Path]::GetExtension($reportPath).ToLowerInvariant()
if ($reportExtension -notin @('.pdf','.docx') -or [IO.Path]::GetExtension($videoPath).ToLowerInvariant() -ne '.mp4') { throw '报告必须为 PDF/DOCX，视频必须为 MP4' }
$prefix = "${StudentName}_${StudentId}"
$staging = Join-Path $projectRoot "output/${prefix}_EX1B"
if (Test-Path -LiteralPath $staging) { throw '已有同名提交目录，请先检查，脚本不会覆盖' }
New-Item -ItemType Directory -Path $staging -Force | Out-Null
$src = Join-Path $staging "${prefix}_ex1B_src"
New-Item -ItemType Directory -Path $src | Out-Null
foreach ($name in @('apps','packages','tests','e2e','scripts','deploy','docs','assets')) {
    $item = Join-Path $projectRoot $name
    if (Test-Path -LiteralPath $item) { & robocopy $item (Join-Path $src $name) /E /XD node_modules dist .git /XF '*.pem' '*.key' '*.sqlite*' '*.log' /NFL /NDL /NJH /NJS; if ($LASTEXITCODE -ge 8) { throw '源码复制失败' } }
}
foreach ($name in @('package.json','package-lock.json','tsconfig.base.json','README.md','.gitignore','.dockerignore','LICENSE','playwright.config.ts')) {
    $item = Join-Path $projectRoot $name
    if (Test-Path -LiteralPath $item) { Copy-Item -LiteralPath $item -Destination $src }
}
Copy-Item -LiteralPath $reportPath -Destination (Join-Path $staging "${prefix}_ex1B_report${reportExtension}")
Copy-Item -LiteralPath $videoPath -Destination (Join-Path $staging "${prefix}_ex1B_play.mp4")
$zipPath = "$staging.zip"
if (Test-Path -LiteralPath $zipPath) { throw '已有同名 ZIP，请先检查' }
Compress-Archive -LiteralPath $staging -DestinationPath $zipPath
Write-Host "已生成 $zipPath，请检查报告中的真实 Git 地址后提交。"
