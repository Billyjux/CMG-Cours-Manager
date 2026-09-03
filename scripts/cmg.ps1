<#
  CMG — open Course Manager.

  Runs behind the "CMG" Start-menu entry: Windows key, type CMG, Enter.

  It reuses a server that is already answering rather than starting a second
  one. That is the whole point of the health check: two node processes on the
  same SQLite file is not a state worth being one keystroke away from, and the
  common case is that `npm start` is already running in a terminal somewhere.
  This script never stops a server it did not start.
#>

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Port = if ($env:CMG_PORT) { $env:CMG_PORT } else { 3000 }
$Url  = "http://localhost:$Port/"

# An answering port is not enough — it has to be this app. /health tells the
# difference between "already running" and "something else owns 3000", which
# are opposite situations: one means open the browser, the other means say so.
function Test-Health {
  try {
    $r = Invoke-WebRequest "${Url}health" -UseBasicParsing -TimeoutSec 2
    return ($r.Content -match '"status"\s*:\s*"ok"')
  } catch {
    return $false
  }
}

# The shortcut runs hidden, so a written error would go nowhere. Anything that
# stops the app from opening has to arrive as a dialog or not at all.
function Stop-WithMessage($message) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    $message, 'Course Manager', 'OK', 'Error') | Out-Null
  exit 1
}

if (-not (Test-Health)) {
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) {
    Stop-WithMessage "Node.js is not on PATH, so the server cannot be started.`n`nOpen a terminal in $Root and run 'npm start' to see the error."
  }

  # Start-Process hands the child this process's environment, so the port the
  # health check just probed is the port the server will actually bind.
  $env:PORT = $Port
  Start-Process $node -ArgumentList 'src/server.js' `
    -WorkingDirectory $Root -WindowStyle Hidden

  # better-sqlite3 opens the database and applies the schema at require time,
  # so first boot after a schema change is the slow one. Wait for the port
  # rather than guessing at a sleep.
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline -and -not (Test-Health)) {
    Start-Sleep -Milliseconds 250
  }

  if (-not (Test-Health)) {
    Stop-WithMessage "The server did not come up on port $Port within 20 seconds.`n`nAnother program may be using that port. Open a terminal in $Root and run 'npm start' to see the error."
  }
}

Start-Process $Url
