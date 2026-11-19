$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = Join-Path $env:ProgramFiles "nodejs\node.exe"
if (-not (Test-Path -LiteralPath $nodePath)) {
  $nodePath = (Get-Command node -ErrorAction Stop).Source
}

Set-Location -LiteralPath $projectRoot
$logDirectory = Join-Path $projectRoot "logs"
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null

while ($true) {
  & $nodePath (Join-Path $projectRoot "src\server.js")
  $exitCode = $LASTEXITCODE
  $delay = if ($exitCode -eq 0) { 5 } else { 10 }
  Add-Content -LiteralPath (Join-Path $logDirectory "service.log") -Value "$(Get-Date -Format o) Server exited with code $exitCode; restarting in $delay seconds."
  Start-Sleep -Seconds $delay
}
