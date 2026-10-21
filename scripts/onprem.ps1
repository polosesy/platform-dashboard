# PowerShell entry for scripts/onprem.sh (PowerShell cannot run a .sh file itself). Runs it with Git for Windows'
# bash - never C:\Windows\System32\bash.exe (that is WSL: another filesystem, no Windows ssh / keys).
#   scripts\onprem.ps1 deploy | env [--test] | up | tunnel | status | logs [service] [lines] | down
# Guide: docs/deployment/container.md section 5
$ErrorActionPreference = 'Stop'
$candidates = @(
  (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
)
$bash = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bash) {
  Write-Error 'Git for Windows (bash.exe) not found - install it from https://git-scm.com/download/win, or run the .sh from Git Bash'
  exit 1
}
$script = Join-Path $PSScriptRoot 'onprem.sh'
# Windows PowerShell 5.1 turns a native command's stderr into errors when output is redirected - with 'Stop' a
# harmless warning would end the run. The script's own exit code is the result.
$ErrorActionPreference = 'Continue'
& $bash $script @args
exit $LASTEXITCODE
