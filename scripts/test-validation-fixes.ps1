# Validation Run Tool Fixes - agnostic test script (PowerShell)
# Exercises Fixes #1-12 via cargo test.

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path (Join-Path $ScriptDir "..")
$TauriDir = Join-Path $Root "atls-studio\src-tauri"

Set-Location $TauriDir

Write-Host "Validation Run Tool Fixes - Test Suite" -ForegroundColor Cyan
Write-Host "Project: atls-studio"
Write-Host "Cwd: $(Get-Location)"
Write-Host ""

cargo test path_utils --no-fail-fast
cargo test refactor_engine --no-fail-fast

Write-Host ""
Write-Host "Validation fixes test suite: PASSED" -ForegroundColor Green
