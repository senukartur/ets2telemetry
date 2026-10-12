# Pure receipt validation; this file never launches a process.
function Test-OverlayRendererIsolation {
    param([object[]]$Windows)
    if ($Windows.Count -ne 2) { return $false }
    $overlay = @($Windows | Where-Object { $_.url -cmatch '/renderer/index\.html\?view=overlay$' })
    $dashboard = @($Windows | Where-Object { $_.url -cmatch '/renderer/index\.html$' })
    if ($overlay.Count -ne 1 -or $dashboard.Count -ne 1) { return $false }
    foreach ($window in $Windows) {
        $rendererId = $window.rendererPid
        if (($rendererId -isnot [int] -and $rendererId -isnot [long] -and $rendererId -isnot [double] -and $rendererId -isnot [decimal]) -or
            [double]::IsNaN([double]$rendererId) -or [double]::IsInfinity([double]$rendererId) -or
            $rendererId -le 0 -or $rendererId -gt 4294967295 -or
            [math]::Truncate([double]$rendererId) -ne [double]$rendererId -or
            [math]::Truncate([decimal]$rendererId) -ne [decimal]$rendererId) { return $false }
        foreach ($flag in @('isDefaultSession','isOverlaySession','sessionPersistent')) {
            if ($window.$flag -isnot [bool]) { return $false }
        }
    }
    return ($overlay[0].rendererPid -ne $dashboard[0].rendererPid -and
        !$overlay[0].isDefaultSession -and $overlay[0].isOverlaySession -and !$overlay[0].sessionPersistent -and
        $dashboard[0].isDefaultSession -and !$dashboard[0].isOverlaySession -and $dashboard[0].sessionPersistent)
}

function Test-RuntimeReceipt {
    param([string]$DriverResultPath, [string]$ExpectedCommit, [string]$ExpectedMode, [int]$JobExitCode,
        [string]$ExpectedScenario)
    $validation = [ordered]@{passed=$false; driverResultAvailable=$false; reason=$null; driverPassed=$null}
    if (!(Test-Path -LiteralPath $DriverResultPath -PathType Leaf)) {
        $validation.reason = 'DRIVER_RESULT_MISSING'; return $validation
    }
    try {
        $item = Get-Item -LiteralPath $DriverResultPath
        if ($item.Length -gt 524288 -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe receipt.' }
        $driver = Get-Content -LiteralPath $DriverResultPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if (!$driver -or $driver -is [array] -or $driver.passed -isnot [bool]) { throw 'Invalid receipt.' }
    } catch { $validation.reason = 'DRIVER_RESULT_MALFORMED'; return $validation }
    $validation.driverResultAvailable = $true
    $validation.driverPassed = $driver.passed
    if ($driver.commit -cne $ExpectedCommit -or $driver.mode -cne $ExpectedMode) {
        $validation.reason = 'DRIVER_RESULT_IDENTITY_MISMATCH'; return $validation
    }
    if ($ExpectedScenario -and $driver.scenarioKind -cne $ExpectedScenario) {
        $validation.reason = 'DRIVER_RESULT_SCENARIO_MISMATCH'; return $validation
    }
    if ($JobExitCode -ne 0) { $validation.reason = 'JOB_FAILED'; return $validation }
    if ($driver.passed -ne $true) { $validation.reason = 'DRIVER_FAILED'; return $validation }
    if ($ExpectedScenario -ceq 'overlay') {
        # Overlay is additive: do not tighten or reinterpret historical scaffold/telemetry schemas.
        $overlay = $driver.overlay
        $valid = $null -ne $overlay -and $overlay.origin -ceq 'synthetic' -and
            $overlay.recording -is [bool] -and $overlay.recording -eq $false -and
            $overlay.scope -ceq 'hidden synthetic renderer; OS visibility, focus and input unverified'
        if ($driver.runtime.rendererProcessLimit -cne '1' -or !(Test-OverlayRendererIsolation -Windows @($driver.runtime.windows))) { $valid = $false }
        foreach ($field in @('missingDistinctFromZero','silentOpenStale','resumeRecovered','overlayReloadIndependent',
            'overlayCreditRecovered','dashboardReloadIndependent','dashboardCreditIndependent','disconnectUnavailable','sourceIdentityPreserved')) {
            if ($overlay.$field -isnot [bool] -or $overlay.$field -ne $true) { $valid = $false }
        }
        if ($overlay.overlayStallMilliseconds -ne 6000 -or $overlay.dashboardStallMilliseconds -ne 6000 -or
            $overlay.changedReading.speedKmh -ne 72 -or $overlay.changedReading.fuelL -ne 71) { $valid = $false }
        foreach ($kind in @('overlay','dashboard')) {
            $proofField = $kind + 'StallProof'
            $proof = $overlay.$proofField
            if ($proof.kind -cne $kind -or $proof.marker -cnotmatch ('^ETS2TELEMETRY_' + $kind.ToUpperInvariant() + '_STALL_[0-9a-f-]{36}$') -or
                $proof.requestedMilliseconds -ne 6000) { $valid = $false }
            foreach ($flag in @('started','completed','pendingAtObservation')) {
                if ($proof.$flag -isnot [bool] -or !$proof.$flag) { $valid = $false }
            }
            $timesValid = $true
            foreach ($time in @('rendererStartBarrierMonotonicMs','rendererStartedMonotonicMs','rendererCompletedMonotonicMs',
                'startedObserverMonotonicMs','readingChangedObserverMonotonicMs','observedObserverMonotonicMs','completedObserverMonotonicMs')) {
                $value = $proof.$time
                if (($value -isnot [int] -and $value -isnot [long] -and $value -isnot [double] -and $value -isnot [decimal]) -or
                    $value -lt 0) { $valid = $false; $timesValid = $false }
                elseif ([double]::IsNaN([double]$value) -or [double]::IsInfinity([double]$value)) { $valid = $false; $timesValid = $false }
            }
            # performance.now() produces binary64 values. PS5.1 JSON parsing uses Decimal;
            # restore the producer's numeric representation before the strict elapsed check.
            if ($timesValid -and ($proof.rendererStartBarrierMonotonicMs -ne $proof.rendererStartedMonotonicMs -or
                ([double]$proof.rendererCompletedMonotonicMs - [double]$proof.rendererStartedMonotonicMs) -lt 6000 -or
                $proof.startedObserverMonotonicMs -gt $proof.readingChangedObserverMonotonicMs -or
                $proof.readingChangedObserverMonotonicMs -ge $proof.observedObserverMonotonicMs -or
                $proof.observedObserverMonotonicMs -ge $proof.completedObserverMonotonicMs)) { $valid = $false }
            $duringSource = $proof.sourceAtObservation
            if ($duringSource.connections -ne 1 -or $duringSource.activeClients -ne 1 -or $duringSource.origin -cne 'synthetic' -or
                $duringSource.history -isnot [bool] -or $duringSource.history) { $valid = $false }
            foreach ($identity in @('pluginSessionId','processInstanceId','clockId','processId')) {
                if ($duringSource.identity.$identity -cne $overlay.sourceBefore.identity.$identity) { $valid = $false }
            }
            $during = $proof.independentObservation.reading
            if ($kind -ceq 'overlay') {
                if ($during.status -cnotmatch '^connected:' -or $during.speed -cne 'Speed: 72.0 km/h' -or $during.fuel -cne 'Fuel: 71.0 L') { $valid = $false }
            } elseif ($during.phase -cne 'during-dashboard-stall' -or $during.status -cne 'connected' -or $during.source -cne 'ETS2' -or
                $during.origin -cne 'synthetic' -or $during.freshness -cne 'current' -or $during.speed -cne '72.0' -or $during.fuel -cne '71.0' -or
                $during.speedUnit -cne 'km/h' -or $during.fuelUnit -cne 'L') { $valid = $false }
            $duringWindows = @($proof.independentObservation.windows)
            if (!(Test-OverlayRendererIsolation -Windows $duringWindows)) { $valid = $false }
            if ($duringWindows.Count -ne 2) { $valid = $false }
            foreach ($window in $duringWindows) {
                if ($window.sandbox -isnot [bool] -or !$window.sandbox -or $window.isolation -isnot [bool] -or !$window.isolation -or
                    $window.node -isnot [bool] -or $window.node) { $valid = $false }
            }
            $duringOverlay = @($duringWindows | Where-Object { $_.url -cmatch '/renderer/index\.html\?view=overlay$' })
            $duringDashboard = @($duringWindows | Where-Object { $_.url -cmatch '/renderer/index\.html$' })
            if ($duringOverlay.Count -ne 1 -or $duringDashboard.Count -ne 1 -or $duringOverlay[0].visible -isnot [bool] -or $duringOverlay[0].visible -or
                $duringOverlay[0].focusable -isnot [bool] -or $duringOverlay[0].focusable) { $valid = $false }
        }
        $bridge = $overlay.bridge
        if ($bridge.require -cne 'undefined' -or $bridge.process -cne 'undefined' -or $bridge.desktop -cne 'undefined' -or
            @($bridge.keys).Count -ne 1 -or ($bridge.keys -join ',') -cne 'subscribeOverlay' -or $bridge.frozen -isnot [bool] -or !$bridge.frozen) { $valid = $false }
        $phases = @('initial','changed','missing','zero','restored','silent-open-stale','resumed','overlay-reload',
            'overlay-credit-recovery','dashboard-reload','before-dashboard-stall','during-dashboard-stall','dashboard-credit-recovery','disconnected')
        if (@($overlay.observations).Count -ne $phases.Count -or @($overlay.windows).Count -ne $phases.Count) { $valid = $false }
        foreach ($phase in $phases) {
            $rows = @($overlay.observations | Where-Object { $_.phase -ceq $phase })
            if ($rows.Count -ne 1) { $valid = $false; continue }
            $row = $rows[0]
            $speed = '90.0'; $fuel = '73.0'; $freshness = 'current'; $states = @('connected')
            if ($phase -in @('changed','overlay-credit-recovery','dashboard-reload','during-dashboard-stall','dashboard-credit-recovery')) { $speed = '72.0'; $fuel = '71.0' }
            if ($phase -in @('missing','silent-open-stale','disconnected')) { $speed = [string][char]0x2014; $fuel = $speed }
            if ($phase -ceq 'zero') { $speed = '0.0'; $fuel = '0.0' }
            if ($phase -ceq 'silent-open-stale') { $freshness = 'stale'; $states = @('stale') }
            if ($phase -ceq 'disconnected') { $freshness = 'unavailable'; $states = @('disconnected','waiting') }
            if ($row.source -cne 'ETS2' -or $row.origin -cne 'synthetic' -or $row.speedUnit -cne 'km/h' -or $row.fuelUnit -cne 'L' -or
                $row.speed -cne $speed -or $row.fuel -cne $fuel -or $row.freshness -cne $freshness -or $row.status -cnotin $states) { $valid = $false }
            $windowRows = @($overlay.windows | Where-Object { $_.phase -ceq $phase })
            if ($windowRows.Count -ne 1 -or @($windowRows[0].windows).Count -ne 2) { $valid = $false; continue }
            if (!(Test-OverlayRendererIsolation -Windows @($windowRows[0].windows))) { $valid = $false }
            foreach ($window in $windowRows[0].windows) {
                if ($window.sandbox -isnot [bool] -or !$window.sandbox -or $window.isolation -isnot [bool] -or !$window.isolation -or
                    $window.node -isnot [bool] -or $window.node) { $valid = $false }
            }
            $overlayWindows = @($windowRows[0].windows | Where-Object { $_.url -cmatch '/renderer/index\.html\?view=overlay$' })
            $dashboards = @($windowRows[0].windows | Where-Object { $_.url -cmatch '/renderer/index\.html$' })
            if ($overlayWindows.Count -ne 1 -or $dashboards.Count -ne 1 -or $overlayWindows[0].visible -isnot [bool] -or $overlayWindows[0].visible -or
                $overlayWindows[0].focusable -isnot [bool] -or $overlayWindows[0].focusable) { $valid = $false }
        }
        foreach ($source in @($overlay.sourceBefore,$overlay.silentOpenSource,$overlay.sourceAfter)) {
            if ($source.connections -ne 1 -or $source.origin -cne 'synthetic' -or $source.history -isnot [bool] -or $source.history -or
                $source.identity.origin -cne 'synthetic' -or $source.identity.game -cne 'ets2' -or $source.identity.processId -le 0) { $valid = $false }
            foreach ($identity in @('pluginSessionId','processInstanceId','clockId')) {
                if ($source.identity.$identity -cnotmatch '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' -or
                    $source.identity.$identity -cne $overlay.sourceBefore.identity.$identity) { $valid = $false }
            }
            if ($source.identity.processId -ne $overlay.sourceBefore.identity.processId) { $valid = $false }
        }
        if ($overlay.sourceBefore.activeClients -ne 1 -or $overlay.silentOpenSource.activeClients -ne 1 -or
            $overlay.silentOpenSource.held -isnot [bool] -or !$overlay.silentOpenSource.held -or
            $overlay.sourceAfter.activeClients -ne 0 -or $overlay.sourceAfter.stopped -isnot [bool] -or !$overlay.sourceAfter.stopped -or
            $driver.launcherExit -ne 0 -or $null -eq $driver.probesAfterExit -or @($driver.probesAfterExit).Count -ne 0) { $valid = $false }
        foreach ($eventName in @('APP_EXIT','SERVICE_EXIT')) {
            $events = @($driver.mainEvents | Where-Object { $_.event -ceq $eventName })
            if ($events.Count -ne 1 -or $null -eq $events[0].detail.code -or $events[0].detail.code -ne 0) { $valid = $false }
        }
        if (@($driver.serviceEvents | Where-Object { $_.event -ceq 'STORAGE_VERIFIED' }).Count -lt 1 -or
            @($driver.serviceEvents | Where-Object { $_.event -ceq 'SERVICE_REPORT' -and $_.detail.type -ceq 'stopped' }).Count -lt 1) { $valid = $false }
        if (!$valid) { $validation.reason = 'OVERLAY_RESULT_INCOMPLETE_OR_INVALID'; return $validation }
    }
    $validation.passed = $true
    return $validation
}
