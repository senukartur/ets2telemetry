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

# isAlwaysOnTop() reports the HWND's actual WS_EX_TOPMOST style on Windows.
function Test-OverlayTopmost {
    param([object[]]$Windows)
    $overlay = @($Windows | Where-Object { $_.url -cmatch '/renderer/index\.html\?view=overlay$' })
    $dashboard = @($Windows | Where-Object { $_.url -cmatch '/renderer/index\.html$' })
    if ($overlay.Count -ne 1 -or $dashboard.Count -ne 1) { return $false }
    return ($overlay[0].alwaysOnTop -is [bool] -and $overlay[0].alwaysOnTop -and
        $dashboard[0].alwaysOnTop -is [bool] -and !$dashboard[0].alwaysOnTop)
}

function Test-ReceiptInteger {
    param([object]$Value, [double]$Minimum, [double]$Maximum)
    if ($Value -isnot [int] -and $Value -isnot [long] -and $Value -isnot [double] -and $Value -isnot [decimal]) { return $false }
    if ([double]::IsNaN([double]$Value) -or [double]::IsInfinity([double]$Value)) { return $false }
    return ([math]::Truncate([decimal]$Value) -eq [decimal]$Value -and [double]$Value -ge $Minimum -and [double]$Value -le $Maximum)
}

# Exactly one APP_EXIT and SERVICE_EXIT with code 0, the service's single clean stopped report and only clean shutdown steps.
function Test-OrderlyRunEvent {
    param([object[]]$MainEvents, [object[]]$ServiceEvents)
    foreach ($eventName in @('APP_EXIT','SERVICE_EXIT')) {
        $events = @($MainEvents | Where-Object { $_.event -ceq $eventName })
        if ($events.Count -ne 1 -or $null -eq $events[0].detail.code -or $events[0].detail.code -ne 0) { return $false }
    }
    $stopped = @($ServiceEvents | Where-Object { $_.event -ceq 'SERVICE_REPORT' -and $_.detail.type -ceq 'stopped' })
    if ($stopped.Count -ne 1 -or $stopped[0].detail.clean -isnot [bool] -or !$stopped[0].detail.clean) { return $false }
    $steps = @($ServiceEvents | Where-Object { $_.event -ceq 'SHUTDOWN_STEP' })
    if ($steps.Count -lt 3) { return $false }
    foreach ($step in $steps) { if ($step.facts.outcome -cne 'ok') { return $false } }
    if (@($ServiceEvents | Where-Object { $_.event -ceq 'STORAGE_VERIFIED' }).Count -lt 1) { return $false }
    foreach ($row in @($MainEvents) + @($ServiceEvents)) {
        if ($row.event -cmatch 'FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE') { return $false }
    }
    return $true
}

# ET-011a lifecycle journey: close-to-tray, second launch, tray reopen, explicit exit and restart.
function Test-LifecycleReceipt {
    param([object]$Driver)
    $lifecycle = $Driver.lifecycle
    if ($null -eq $lifecycle) { return $false }
    foreach ($field in @('dashboardClosedServiceAlive','overlayAliveAfterClose','trayPresentAfterClose','overlayCurrentAfterClose',
        'sourceConnectionPreserved','secondInstanceRestoredDashboard','trayOpenRestoredDashboard','explicitExitOrderly','restartRecovered','shutdownClean')) {
        if ($lifecycle.$field -isnot [bool] -or $lifecycle.$field -ne $true) { return $false }
    }
    if (!(Test-ReceiptInteger -Value $lifecycle.servicePid -Minimum 1 -Maximum 4294967295) -or
        !(Test-ReceiptInteger -Value $lifecycle.restart.servicePid -Minimum 1 -Maximum 4294967295) -or
        $lifecycle.restart.servicePid -eq $lifecycle.servicePid -or $lifecycle.afterClose.servicePid -ne $lifecycle.servicePid) { return $false }
    foreach ($flag in @('dashboard','exiting')) { if ($lifecycle.afterClose.$flag -isnot [bool] -or $lifecycle.afterClose.$flag) { return $false } }
    foreach ($flag in @('overlay','tray','upstream')) { if ($lifecycle.afterClose.$flag -isnot [bool] -or !$lifecycle.afterClose.$flag) { return $false } }
    foreach ($reading in @(@{row=$lifecycle.overlayChanged; speed='72.0'; fuel='71.0'}, @{row=$lifecycle.overlayRestored; speed='90.0'; fuel='73.0'})) {
        $row = $reading.row
        if ($null -eq $row -or $row.source -cne 'ETS2' -or $row.origin -cne 'synthetic' -or $row.freshness -cne 'current' -or $row.status -cne 'connected' -or
            $row.speed -cne $reading.speed -or $row.fuel -cne $reading.fuel) { return $false }
    }
    $second = $lifecycle.secondInstance
    # Integer fields go through Test-ReceiptInteger: PowerShell 7 (the CI shell) parses JSON integers as Int64, 5.1 as Int32.
    if ($null -eq $second -or !(Test-ReceiptInteger -Value $second.exitCode -Minimum 0 -Maximum 0) -or $null -ne $second.signal -or
        $second.wroteLog -isnot [bool] -or $second.wroteLog -or
        !(Test-ReceiptInteger -Value $second.exitMilliseconds -Minimum 0 -Maximum 10000) -or
        @($second.primaryActions).Count -ne 1 -or @($second.primaryActions)[0] -cne 'created') { return $false }
    $exit = $lifecycle.explicitExit
    if ($null -eq $exit -or !(Test-ReceiptInteger -Value $exit.launcherExit -Minimum 0 -Maximum 0) -or $null -ne $exit.signal -or
        !(Test-ReceiptInteger -Value $exit.exitMilliseconds -Minimum 0 -Maximum 8000) -or
        @($exit.requests).Count -ne 1 -or @($exit.requests)[0] -cne 'renderer') { return $false }
    if (!(Test-ReceiptInteger -Value $lifecycle.restartLauncherExit -Minimum 0 -Maximum 0) -or $Driver.launcherExit -ne 0 -or
        $null -eq $Driver.probesAfterExit -or @($Driver.probesAfterExit).Count -ne 0) { return $false }
    $restartRequests = @($lifecycle.restartMainEvents | Where-Object { $_.event -ceq 'APP_EXIT_REQUESTED' })
    if ($restartRequests.Count -ne 1 -or $restartRequests[0].facts.reason -cne 'app-quit') { return $false }
    if (!(Test-OrderlyRunEvent -MainEvents @($Driver.mainEvents) -ServiceEvents @($Driver.serviceEvents)) -or
        !(Test-OrderlyRunEvent -MainEvents @($lifecycle.restartMainEvents) -ServiceEvents @($lifecycle.restartServiceEvents))) { return $false }
    $actions = @($Driver.mainEvents | Where-Object { $_.event -ceq 'SECOND_INSTANCE' })
    if ($actions.Count -ne 1 -or $actions[0].facts.action -cne 'created') { return $false }
    if (!(Test-LifecycleSettingsReceipt -Driver $Driver)) { return $false }
    return $true
}

# ET-011b settings in the lifecycle journey: invalid seed kept, quarantined on save, exact content, units applied,
# and a restart that loads without writing.
function Test-LifecycleSettingsReceipt {
    param([object]$Driver)
    $lifecycle = $Driver.lifecycle
    foreach ($field in @('settingsSeededInvalidFile','settingsStartupUnchanged','settingsQuarantinePreserved','settingsSavedExact',
        'unitsApplied','settingsRestartLoaded')) {
        if ($lifecycle.$field -isnot [bool] -or $lifecycle.$field -ne $true) { return $false }
    }
    if (!(Test-ReceiptInteger -Value $lifecycle.settingsQuarantined -Minimum 1 -Maximum 1) -or $lifecycle.restart.settingsState -cne 'loaded') { return $false }
    $units = $lifecycle.overlayUnits
    if ($null -eq $units -or $units.source -cne 'ETS2' -or $units.origin -cne 'synthetic' -or $units.status -cne 'connected' -or
        $units.freshness -cne 'current' -or $units.speed -cne '55.9' -or $units.speedUnit -cne 'mph' -or
        $units.fuel -cne '19.3' -or $units.fuelUnit -cne 'US gal') { return $false }
    foreach ($row in @($lifecycle.dashboardUnits, $lifecycle.restart.dashboardUnits)) {
        if ($null -eq $row -or $row.speed -cne 'Speed: 55.9 mph' -or $row.fuel -cne 'Fuel: 19.3 US gal') { return $false }
    }
    # Diagnostics: run A falls back from the invalid file, quarantines it once and saves once; run B only loads.
    $fallback = @($Driver.mainEvents | Where-Object { $_.event -ceq 'SETTINGS_FALLBACK' })
    if ($fallback.Count -ne 1 -or $fallback[0].facts.state -cne 'invalid-file') { return $false }
    foreach ($eventName in @('SETTINGS_QUARANTINED','SETTINGS_SAVED')) {
        if (@($Driver.mainEvents | Where-Object { $_.event -ceq $eventName }).Count -ne 1) { return $false }
    }
    $loaded = @($lifecycle.restartMainEvents | Where-Object { $_.event -ceq 'SETTINGS_LOADED' })
    if ($loaded.Count -ne 1 -or $loaded[0].facts.state -cne 'loaded') { return $false }
    if (@($lifecycle.restartMainEvents | Where-Object { $_.event -cmatch '^SETTINGS_' }).Count -ne 1) { return $false }
    return $true
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
        if ($driver.runtime.rendererProcessLimit -cne '1' -or !(Test-OverlayRendererIsolation -Windows @($driver.runtime.windows)) -or
            !(Test-OverlayTopmost -Windows @($driver.runtime.windows))) { $valid = $false }
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
            # A debugger pause stalls the renderer without consuming the Job's CPU budget, and only the
            # observer resumes it; a CPU-spinning stall starved the observer on a hosted runner.
            if ($proof.stallMethod -cne 'debugger-pause' -or $proof.pauseReason -cne 'other') { $valid = $false }
            foreach ($flag in @('started','completed','pendingAtObservation')) {
                if ($proof.$flag -isnot [bool] -or !$proof.$flag) { $valid = $false }
            }
            $timesValid = $true
            foreach ($time in @('rendererStartBarrierMonotonicMs','rendererStartedMonotonicMs','rendererCompletedMonotonicMs',
                'startedObserverMonotonicMs','readingChangedObserverMonotonicMs','observedObserverMonotonicMs','resumeRequestedObserverMonotonicMs',
                'completedObserverMonotonicMs')) {
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
                $proof.observedObserverMonotonicMs -ge $proof.resumeRequestedObserverMonotonicMs -or
                ([double]$proof.resumeRequestedObserverMonotonicMs - [double]$proof.startedObserverMonotonicMs) -lt 6000 -or
                $proof.resumeRequestedObserverMonotonicMs -gt $proof.completedObserverMonotonicMs)) { $valid = $false }
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
            if (!(Test-OverlayRendererIsolation -Windows $duringWindows) -or !(Test-OverlayTopmost -Windows $duringWindows)) { $valid = $false }
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
            if (!(Test-OverlayRendererIsolation -Windows @($windowRows[0].windows)) -or !(Test-OverlayTopmost -Windows @($windowRows[0].windows))) { $valid = $false }
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
    # Lifecycle is additive as well; earlier scenario rules are unchanged.
    if ($ExpectedScenario -ceq 'lifecycle' -and !(Test-LifecycleReceipt -Driver $driver)) {
        $validation.reason = 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID'; return $validation
    }
    $validation.passed = $true
    return $validation
}
