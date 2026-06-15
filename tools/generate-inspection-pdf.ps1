# Renders docs/Visual_Inspection_Form.html to docs/Visual_Inspection_Form.pdf using
# Microsoft Edge (Chromium) headless print-to-pdf — faithful to the browser layout
# (tire centered over the brake/tire grid, car diagram in Prior Body Damage).
# Re-run after editing the HTML.
$ErrorActionPreference = 'Stop'
$edge = @(
  "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
  "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) { throw 'Microsoft Edge not found.' }

$root = Split-Path $PSScriptRoot -Parent
$html = 'file:///' + ($root -replace '\\', '/') + '/docs/Visual_Inspection_Form.html'
$out = Join-Path $root 'docs\Visual_Inspection_Form.pdf'
if (Test-Path $out) { Remove-Item $out -Force }

& $edge --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=4000 "--print-to-pdf=$out" $html 2>$null
Start-Sleep -Seconds 2
if (Test-Path $out) { Write-Output ("PDF_OK $out  (" + [math]::Round((Get-Item $out).Length / 1KB, 1) + ' KB)') }
else { throw 'PDF was not created.' }
