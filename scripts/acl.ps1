param([Parameter(Mandatory=$true)][string]$ServiceAccount, [string]$DataDirectory = 'runtime/data')
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dataPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $DataDirectory))
if (!$dataPath.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $dataPath -eq $projectRoot) { throw '数据目录必须位于本仓库内部，且不能是仓库根目录' }
if (!(Test-Path -LiteralPath $dataPath)) { New-Item -ItemType Directory -Path $dataPath -Force | Out-Null }
$identity = New-Object System.Security.Principal.NTAccount($ServiceAccount)
$null = $identity.Translate([System.Security.Principal.SecurityIdentifier])
# 本脚本仅调整项目子目录；服务账户需预先创建为标准用户，禁止使用当前管理员。
& icacls $projectRoot /grant "${ServiceAccount}:RX"
if ($LASTEXITCODE) { throw '仓库目录访问设置失败' }
foreach ($relative in @('package.json','package-lock.json','tsconfig.base.json','.env')) {
    $file = Join-Path $projectRoot $relative
    if (Test-Path -LiteralPath $file) { & icacls $file /grant "${ServiceAccount}:R"; if ($LASTEXITCODE) { throw '运行配置只读访问设置失败' } }
}
foreach ($relative in @('apps','packages','node_modules','scripts')) {
    $directory = Join-Path $projectRoot $relative
    if (Test-Path -LiteralPath $directory) { & icacls $directory /grant "${ServiceAccount}:(OI)(CI)RX"; if ($LASTEXITCODE) { throw '只读 ACL 设置失败' } }
}
& icacls $dataPath /inheritance:r /grant:r "${ServiceAccount}:(OI)(CI)M" 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F'
if ($LASTEXITCODE) { throw '数据目录 ACL 设置失败' }
foreach ($name in @('server.pem','server-key.pem')) {
    $file = Join-Path $projectRoot "certs/$name"
    if (Test-Path -LiteralPath $file) { & icacls $file /inheritance:r /grant:r "${ServiceAccount}:R" 'SYSTEM:F' 'BUILTIN\Administrators:F'; if ($LASTEXITCODE) { throw '证书 ACL 设置失败' } }
}
$caKey = Join-Path $projectRoot 'certs/ca-key.pem'
if (Test-Path -LiteralPath $caKey) { & icacls $caKey /inheritance:r /grant:r 'SYSTEM:F' 'BUILTIN\Administrators:F'; if ($LASTEXITCODE) { throw 'CA 私钥 ACL 设置失败' } }
Write-Host '项目 ACL 已配置。请确认服务账户对项目外没有额外写权限，并以该账户实际验证允许/拒绝操作。'
