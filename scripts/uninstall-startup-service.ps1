param(
  [string]$TaskName = "K Streamer Server"
)

schtasks.exe /Delete /TN $TaskName /F
if ($LASTEXITCODE -ne 0) { throw "Could not remove the startup task." }

Write-Host "Removed $TaskName"
