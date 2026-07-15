param([Parameter(Mandatory = $true)][string]$Root)

$pidPath = Join-Path $Root "data\server.pid"
if (-not (Test-Path $pidPath)) {
  Write-Host "No background service process was found."
  exit 0
}

$servicePid = Get-Content -Raw $pidPath | ForEach-Object { $_.Trim() }
if ($servicePid -match "^\d+$") {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
  if ($process -and $process.Name -eq "node.exe" -and $process.CommandLine -like "*dist-server*server*index.js*") {
    Stop-Process -Id $servicePid -Force
    Write-Host "LAN chat stopped."
  } else {
    Write-Host "The recorded background process is no longer running."
  }
}
Remove-Item -Force -ErrorAction SilentlyContinue $pidPath
