$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root 'dist'
$app = Join-Path $dist 'valemarket-desktop'
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$name = "ValeMarket-Desktop-v$version-windows-x64"
$stage = Join-Path $dist $name
$archive = Join-Path $dist "$name.zip"

if (-not (Test-Path $app)) {
    throw "Neutralino release directory not found: $app"
}

Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $archive -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $dist 'valemarket-desktop-release.zip') -Force -ErrorAction SilentlyContinue
New-Item $stage -ItemType Directory | Out-Null

Copy-Item (Join-Path $app 'valemarket-desktop-win_x64.exe') $stage
Copy-Item (Join-Path $app 'resources.neu') $stage
Copy-Item (Join-Path $app 'neutralino.config.json') $stage
Copy-Item (Join-Path $app '.valemarket-portable') $stage
Copy-Item (Join-Path $app 'extensions') $stage -Recurse

Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

Write-Host "Windows release archive: $archive"
