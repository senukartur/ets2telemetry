# Exit observer for scripts/ci/exit-observation.mjs. Opens a handle to the process named by ETS2TELEMETRY_OBSERVED_PID,
# verifies its creation time and executable, then waits on that process object and prints one JSON line per event.
# It observes only and never terminates the observed process. It runs as a file: a hidden -EncodedCommand launch is
# what behavior-based antivirus blocks.
$ErrorActionPreference = 'Stop'
$observed = $null
try {
    $observed = [System.Diagnostics.Process]::GetProcessById([int]$env:ETS2TELEMETRY_OBSERVED_PID)
    # Reading Handle opens the process handle before the quit request, so a reused PID cannot replace it.
    $null = $observed.Handle
    $created = [DateTimeOffset]::new($observed.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
    if ($created -ne [long]$env:ETS2TELEMETRY_OBSERVED_CREATED -or
        -not [string]::Equals($observed.MainModule.FileName, $env:ETS2TELEMETRY_OBSERVED_EXE, [StringComparison]::OrdinalIgnoreCase)) {
        @{event = 'unknown'; code = 'IDENTITY_MISMATCH' } | ConvertTo-Json -Compress
    } else {
        @{event = 'opened' } | ConvertTo-Json -Compress
        [Console]::Out.Flush()
        if ($observed.WaitForExit(8000)) { @{event = 'terminated'; code = $observed.ExitCode } | ConvertTo-Json -Compress }
        else { @{event = 'unknown'; code = 'OBSERVER_WAIT_EXPIRED' } | ConvertTo-Json -Compress }
    }
} catch { @{event = 'unknown'; code = 'PROCESS_OBSERVER_ERROR' } | ConvertTo-Json -Compress }
finally { if ($null -ne $observed) { $observed.Dispose() } }
