<#
  Installs the Start-menu entry behind Windows key -> "CMG" -> Enter.

      powershell -ExecutionPolicy Bypass -File scripts\install-cmg-shortcut.ps1
      powershell -ExecutionPolicy Bypass -File scripts\install-cmg-shortcut.ps1 -Remove

  Writes one file into the current user's Start menu and touches nothing else,
  so it needs no elevation and is safe to re-run after moving the project.
#>

param([switch]$Remove)

$ErrorActionPreference = 'Stop'

$Root      = Split-Path -Parent $PSScriptRoot
$Launcher  = Join-Path $Root 'scripts\cmg.ps1'
$Icon      = Join-Path $Root 'scripts\cmg.ico'
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
# The file name is what Start search matches, so it leads with the three
# letters that are actually typed; the rest is there to read as a program name
# once it is on screen.
$Link      = Join-Path $StartMenu 'CMG - Course Manager.lnk'

if ($Remove) {
  if (Test-Path $Link) { Remove-Item $Link -Force; Write-Host "Removed: $Link" }
  else { Write-Host "Nothing to remove at: $Link" }
  return
}

if (-not (Test-Path $Launcher)) { throw "Launcher not found: $Launcher" }

$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($Link)
$sc.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$sc.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
$sc.WorkingDirectory = $Root
$sc.Description = 'Open the Course Manager dashboard'
if (Test-Path $Icon) { $sc.IconLocation = "$Icon,0" }
$sc.WindowStyle = 7   # minimised: the launcher must not take focus from the browser
$sc.Save()

Write-Host "Installed: $Link"
Write-Host "  target : $($sc.TargetPath)"
Write-Host "  runs   : $Launcher"
Write-Host ""
Write-Host "Press the Windows key, type CMG, press Enter."
