param([Parameter(Mandatory = $true)][string]$Root)

$ErrorActionPreference = "Stop"
$dataDir = Join-Path $Root "data"
$pidPath = Join-Path $dataDir "server.pid"
$logPath = Join-Path $dataDir "server.log"
$errorPath = Join-Path $dataDir "server-error.log"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$listener = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  $running = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
  if ($running.CommandLine -like "*$Root*server/index.*") {
    Set-Content -Path $pidPath -Value $listener.OwningProcess -Encoding ascii
    Write-Host "LAN chat is already running in the background (process $($listener.OwningProcess))."
    exit 0
  }
  Write-Error "Port 3000 is already in use by another application."
  exit 1
}

Remove-Item -Force -ErrorAction SilentlyContinue $pidPath
$node = (Get-Command node.exe -ErrorAction Stop).Source
$previousNodeEnv = $env:NODE_ENV
$env:NODE_ENV = "production"
try {
  $process = Start-Process -FilePath $node -ArgumentList "dist-server/server/index.js" -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $logPath -RedirectStandardError $errorPath
} finally {
  $env:NODE_ENV = $previousNodeEnv
}
Start-Sleep -Seconds 1
if ($process.HasExited) {
  Write-Error "Background service failed to start. Check $errorPath"
  exit 1
}
Set-Content -Path $pidPath -Value $process.Id -Encoding ascii
Write-Host "LAN chat started in the background (process $($process.Id))."
