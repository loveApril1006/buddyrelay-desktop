$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$data = Join-Path $root 'data'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$version = (& node --version).TrimStart('v').Split('.')[0]
if ([int]$version -lt 24) { throw '请安装 Node.js 24 或更高版本' }
$manager = Join-Path $root 'bin/wb-switch-server.exe'
$tokenFile = Join-Path $data 'account-service.key'
if (!(Test-Path -LiteralPath $tokenFile)) {
    $bytes = New-Object byte[] 32
    [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
    [Convert]::ToHexString($bytes) | Set-Content -LiteralPath $tokenFile -NoNewline
}
$env:PORTAL_ACCOUNT_TOKEN = [IO.File]::ReadAllText($tokenFile).Trim()
$env:PORTAL_DATA = $data
if ((Test-Path -LiteralPath $manager) -and !(Get-NetTCPConnection -LocalPort 57890 -State Listen -ErrorAction SilentlyContinue)) {
    if (Get-Process buddyrelay -ErrorAction SilentlyContinue) {
        throw '请从 BuddyRelay 托盘退出 WorkBuddy 后台后再启动中转站，让账号管理服务负责签到和反代。'
    }
    $env:WB_SWITCH_TOKEN = $env:PORTAL_ACCOUNT_TOKEN
    Start-Process -FilePath $manager -ArgumentList 'serve','--no-open' -WindowStyle Hidden
}
Push-Location -LiteralPath $root
try { node server.mjs } finally { Pop-Location }
