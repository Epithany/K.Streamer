param(
  [string]$TaskName = "K Streamer Server"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$runner = Join-Path $PSScriptRoot "run-server.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$runner`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started $TaskName for $projectRoot"
