param([string]$Url = 'https://share.detrouse.com')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:SCREEN_SHARE_URL = $Url
& cargo build --locked --release --no-default-features --bin screen-share-launcher
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Install Rust and Visual Studio Desktop development with C++ build tools.' }
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'target' }
New-Item -ItemType Directory -Force dist | Out-Null
Copy-Item "$target/release/screen-share-launcher.exe" dist/ScreenShare.exe
Write-Host 'Built dist/ScreenShare.exe. It opens Edge/Chrome in app mode.'
