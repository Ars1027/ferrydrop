param([switch]$Build)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    if ($Build) { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' }; npm run build; if ($LASTEXITCODE) { throw 'build failed' } }
    if (!(Test-Path -LiteralPath 'apps/web/dist/index.html')) { throw '请先运行 npm ci 与 npm run build' }
    if (!(Test-Path -LiteralPath 'certs/server.pem') -or !(Test-Path -LiteralPath 'certs/server-key.pem')) { throw '请先运行 npm run cert -- <电脑的局域网IP>' }
    $env:TLS_CERT = Join-Path $projectRoot 'certs/server.pem'
    $env:TLS_KEY = Join-Path $projectRoot 'certs/server-key.pem'
    if (!$env:DATA_DIR) { $env:DATA_DIR = Join-Path $projectRoot 'runtime/data' }
    if (!$env:HOST) { $env:HOST = '0.0.0.0' }
    if (!$env:PORT) { $env:PORT = '8443' }
    npm start
} finally { Pop-Location }
