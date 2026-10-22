[CmdletBinding()]
param(
    # 公网 IP 或域名：浏览器最终访问的地址，例如 1.2.3.4 或 photos.example.com
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Target,

    # 输出目录，默认项目根目录下的 certs/
    [string]$OutDir = (Join-Path $PSScriptRoot '..\certs'),

    # 有效期（天）。自签证书不受公开 CA 的 398 天限制
    [int]$Days = 825
)

$ErrorActionPreference = 'Stop'

function Find-OpenSsl {
    $candidates = @()

    $cmd = Get-Command openssl -ErrorAction SilentlyContinue
    if ($cmd) { $candidates += $cmd.Source }

    # Git for Windows 自带 openssl。优先 mingw64 版本：
    # usr/bin 下的是 MSYS 程序，在部分受限终端里会因信号管道权限启动失败。
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe'
        $candidates += Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Git\mingw64\bin\openssl.exe'
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Git\usr\bin\openssl.exe'
    }
    if ($env:LOCALAPPDATA) {
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Git\mingw64\bin\openssl.exe'
        $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Git\usr\bin\openssl.exe'
    }

    foreach ($path in ($candidates | Select-Object -Unique)) {
        if (-not $path -or -not (Test-Path $path)) { continue }
        $version = & $path version 2>$null
        if ($version -match 'OpenSSL') { return $path }
    }
    return $null
}

$openssl = Find-OpenSsl
if (-not $openssl) {
    Write-Host '未找到 openssl，无法生成自签证书。' -ForegroundColor Yellow
    Write-Host ''
    Write-Host '任选一种方式：'
    Write-Host '  1. 安装 Git for Windows（自带 openssl）：https://git-scm.com/download/win'
    Write-Host '  2. 安装 mkcert：https://github.com/FiloSottile/mkcert/releases'
    Write-Host '     然后执行：'
    Write-Host '       mkcert -install'
    Write-Host '       mkcert -cert-file certs\cert.pem -key-file certs\key.pem <IP或域名> localhost 127.0.0.1'
    Write-Host '  3. 在 WSL / Linux 里执行 README 中的 openssl 命令'
    exit 1
}

# IPv4 或 IPv6 用 IP:，域名用 DNS:
$isIp = $Target -match '^\d{1,3}(\.\d{1,3}){3}$' -or $Target.Contains(':')
$sanParts = @('DNS:localhost', 'IP:127.0.0.1')
$targetPart = if ($isIp) { "IP:$Target" } else { "DNS:$Target" }
if ($sanParts -notcontains $targetPart) { $sanParts += $targetPart }
$san = $sanParts -join ','

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$resolvedDir = (Resolve-Path $OutDir).Path
$certPath = Join-Path $resolvedDir 'cert.pem'
$keyPath = Join-Path $resolvedDir 'key.pem'

if ((Test-Path $certPath) -or (Test-Path $keyPath)) {
    Write-Host 'certs/ 下已有证书，本次会覆盖。' -ForegroundColor Yellow
}

& $openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days $Days `
    -keyout $keyPath `
    -out $certPath `
    -subj "/CN=$Target" `
    -addext "subjectAltName=$san"

if ($LASTEXITCODE -ne 0 -or -not (Test-Path $certPath) -or -not (Test-Path $keyPath)) {
    throw "openssl 生成证书失败（exit $LASTEXITCODE）"
}

Write-Host ''
Write-Host '自签证书已生成：' -ForegroundColor Green
Write-Host "  证书  $certPath"
Write-Host "  私钥  $keyPath"
Write-Host "  SAN   $san"
Write-Host "  有效  $Days 天"
Write-Host ''
Write-Host '下一步：在 .env 中取消这两行的注释（路径相对项目根目录）：'
Write-Host '  TLS_CERT=./certs/cert.pem'
Write-Host '  TLS_KEY=./certs/key.pem'
Write-Host ''
Write-Host '然后重启服务，并用 https:// 访问：'
Write-Host '  本机：https://localhost:3000'
Write-Host '  公网：https://<你的 frp 公网 IP 或域名>'
Write-Host ''
Write-Host '浏览器提示证书不受信任是自签证书的正常现象，核对后选择继续即可。' -ForegroundColor DarkGray
