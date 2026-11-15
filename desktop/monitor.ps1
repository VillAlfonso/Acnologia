param([Parameter(Mandatory=$true)][string]$LogPath, [int]$ParentProcessId)
$Host.UI.RawUI.WindowTitle = 'BrowserAuto - Live Monitor'
Write-Host 'BrowserAuto live monitor' -ForegroundColor Cyan
Write-Host 'Capture, proxy checks, browser activity, run steps, and errors.'
Write-Host 'Passwords, typed values, cookies, and request bodies are omitted.' -ForegroundColor DarkGray
Write-Host "Log: $LogPath"
Write-Host 'Closing this monitor does not stop BrowserAuto.' -ForegroundColor DarkGray
$offset = 0L
while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
  if (Test-Path -LiteralPath $LogPath) {
    try {
      $stream = [System.IO.File]::Open($LogPath, 'Open', 'Read', 'ReadWrite')
      if ($stream.Length -lt $offset) { $offset = 0L }
      [void]$stream.Seek($offset, 'Begin')
      $reader = [System.IO.StreamReader]::new($stream)
      $text = $reader.ReadToEnd()
      $offset = $stream.Position
      $reader.Dispose()
      if ($text) {
        foreach ($line in ($text -split "`n")) {
          if (!$line) { continue }
          $color = if ($line -match '\[ERROR\]') { 'Red' } elseif ($line -match '\[SUCCESS\]') { 'Green' } elseif ($line -match '\[WARN\]') { 'Yellow' } else { 'Gray' }
          Write-Host $line -ForegroundColor $color
        }
      }
    } catch { Write-Host 'Waiting for the log file…' -ForegroundColor DarkGray }
  }
  Start-Sleep -Milliseconds 250
}
