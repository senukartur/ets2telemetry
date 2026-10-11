# Fixed harmless wrong-image leaf, solely for native custody rejection.
param([string]$Directory)
$ErrorActionPreference='Stop'
[ordered]@{pid=$PID;marker='WRONG_IMAGE_POWERSHELL_REACHED'}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $Directory 'wrong-image-marker.json') -Encoding UTF8
Start-Sleep -Milliseconds 4500
exit 0
