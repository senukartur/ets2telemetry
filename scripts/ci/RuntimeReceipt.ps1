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
    if (!(Test-LifecyclePluginReceipt -Driver $Driver)) { return $false }
    return $true
}

# ET-017 PR-5 plugin journey in the lifecycle smoke: both runs in the test-root mode, the Steam folders installed with the
# bundled plugin, unrelated and unrecognized files unchanged, the card shown without a path, the exclusion removing the
# plugin, and a restart that writes nothing.
function Test-LifecyclePluginReceipt {
    param([object]$Driver)
    $plugin = $Driver.lifecycle.plugin
    if ($null -eq $plugin) { return $false }
    foreach ($field in @('pluginSteamInstalled','pluginUnrelatedUnchanged','pluginUnrecognizedUnchanged','pluginCardShown','pluginNoPathShown',
        'pluginExclusionRemoved','pluginRestartStates','pluginRestartUnchanged','pluginEventsVerified')) {
        if ($plugin.$field -isnot [bool] -or $plugin.$field -ne $true) { return $false }
    }
    foreach ($rows in @(@($Driver.mainEvents), @($Driver.lifecycle.restartMainEvents))) {
        $modes = @($rows | Where-Object { $_.event -ceq 'PLUGIN_SETUP_MODE' })
        if ($modes.Count -ne 1 -or $modes[0].facts.mode -cne 'test-root') { return $false }
        if (@($rows | Where-Object { $_.event -ceq 'PLUGIN_TEST_ROOT_ESCAPE' }).Count -ne 0) { return $false }
    }
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
    # A read past the 1000 ms load budget adds one SETTINGS_LOAD_PENDING row before any other settings row of that run.
    foreach ($rows in @(@($Driver.mainEvents), @($lifecycle.restartMainEvents))) {
        $settingsRows = @($rows | Where-Object { $_.event -cmatch '^SETTINGS_' })
        $pendingRows = @($settingsRows | Where-Object { $_.event -ceq 'SETTINGS_LOAD_PENDING' })
        if ($pendingRows.Count -gt 1) { return $false }
        if ($pendingRows.Count -eq 1 -and ($settingsRows[0].event -cne 'SETTINGS_LOAD_PENDING' -or
            $settingsRows[0].facts.state -cne 'loading' -or $settingsRows[0].facts.reason -cne 'load-budget' -or
            ((@($settingsRows[0].facts.PSObject.Properties.Name) | Sort-Object) -join ',') -cne 'reason,state')) { return $false }
    }
    $fallback = @($Driver.mainEvents | Where-Object { $_.event -ceq 'SETTINGS_FALLBACK' })
    if ($fallback.Count -ne 1 -or $fallback[0].facts.state -cne 'invalid-file') { return $false }
    foreach ($eventName in @('SETTINGS_QUARANTINED','SETTINGS_SAVED')) {
        if (@($Driver.mainEvents | Where-Object { $_.event -ceq $eventName }).Count -ne 1) { return $false }
    }
    $loaded = @($lifecycle.restartMainEvents | Where-Object { $_.event -ceq 'SETTINGS_LOADED' })
    if ($loaded.Count -ne 1 -or $loaded[0].facts.state -cne 'loaded') { return $false }
    if (@($lifecycle.restartMainEvents | Where-Object { $_.event -cmatch '^SETTINGS_' -and $_.event -cne 'SETTINGS_LOAD_PENDING' }).Count -ne 1) { return $false }
    return $true
}

# ET-015a PR-4 recording journey: one service run's recording diagnostics. RECORDING_TARGET and HISTORY_STORAGE_OPENED
# once per service process, one ok recording-flush and history-storage step and no durable or target failure. ET-015b
# PR-4: no sample write retried, dropped, discarded or skipped either.
function Test-RecordingServiceEvent {
    param([object[]]$ServiceEvents, [bool[]]$Created)
    $targets = @($ServiceEvents | Where-Object { $_.event -ceq 'RECORDING_TARGET' })
    if ($targets.Count -ne $Created.Count) { return $false }
    foreach ($target in $targets) { if ($target.facts.purpose -cne 'synthetic') { return $false } }
    $opened = @($ServiceEvents | Where-Object { $_.event -ceq 'HISTORY_STORAGE_OPENED' })
    if ($opened.Count -ne $Created.Count) { return $false }
    for ($index = 0; $index -lt $Created.Count; $index++) {
        if ($opened[$index].facts.created -isnot [bool] -or $opened[$index].facts.created -ne $Created[$index]) { return $false }
    }
    foreach ($stepName in @('recording-flush','history-storage')) {
        $steps = @($ServiceEvents | Where-Object { $_.event -ceq 'SHUTDOWN_STEP' -and $_.facts.name -ceq $stepName })
        if ($steps.Count -ne 1 -or $steps[0].facts.outcome -cne 'ok') { return $false }
    }
    if (@($ServiceEvents | Where-Object { $_.event -ceq 'HISTORY_STORAGE_CLOSED' }).Count -ne 1) { return $false }
    foreach ($row in $ServiceEvents) {
        if ($row.event -cmatch '^(V1_DURABLE_(RETRY|UNAVAILABLE|ACK_AHEAD|RESTORE_LOSS)|V1_EVENT_CONFLICT|RECORDING_TARGET_REJECTED|HISTORY_STORAGE_UNAVAILABLE|V1_SAMPLES_(RETRY|DROPPED|DISCARDED|SKIPPED))$') { return $false }
    }
    return $true
}

# ET-015c PR-4 recording status facts of the journey: waiting before each admission with no losses, recording shown with
# the synthetic target note during connection 1, interrupted with the partial trip after it, unknown between the
# terminated and the restarted service, the status kept across a dashboard reload, recording while the dashboard was
# closed with no lost event after the redelivery (one not-connected interval), the totals shown by the reopened
# dashboard, which is closed again before the tray exit, an entry of each dashboard text log the driver records, and
# run B recording again with fresh totals.
function Test-RecordingStatusReceipt {
    param([object]$Recording)
    foreach ($field in @('statusWaitingShown','statusRecordingShown','statusUnknownAfterServiceExit','statusReloadKept','statusRecordedWhileClosed',
        'statusNoEventLoss','statusReopenedLosses','statusRunBFresh','dashboardClosedBeforeTrayExit')) {
        if ($Recording.$field -isnot [bool] -or $Recording.$field -ne $true) { return $false }
    }
    $status = $Recording.status
    if ($null -eq $status -or $null -eq $Recording.restart.status) { return $false }
    $note = 'Synthetic test database (never game history)'
    $lossNames = @('lostEvents','eventLoss','notConnected','sampleLoss','restoreLoss','droppedSamples')
    foreach ($waiting in @($status.beforeAdmission, $status.afterRestart, $Recording.restart.status.beforeAdmission)) {
        $health = $waiting.health
        if ($null -eq $health -or $health.state -cne 'waiting' -or $health.target -cne 'synthetic' -or $null -ne $health.code -or $null -ne $health.trip -or
            $waiting.dashboard.headline -cne 'Waiting for the recorded source to connect' -or (@($waiting.dashboard.detail) -join '|') -cne $note) { return $false }
        foreach ($name in $lossNames) { if (!(Test-ReceiptInteger -Value $health.losses.$name -Minimum 0 -Maximum 0)) { return $false } }
    }
    $interrupted = $status.afterFirstConnection
    if ($interrupted.health.state -cne 'interrupted' -or $interrupted.health.trip.completeness -cne 'partial' -or
        (@($interrupted.dashboard.detail) -join '|') -cne ($note + '|Current trip is partial')) { return $false }
    if (@($status.firstConnectionRows | Where-Object { $_.state -ceq 'recording' -and $_.target -ceq 'synthetic' }).Count -lt 1 -or
        @($status.serviceRestartRows | Where-Object { $_.state -ceq 'unknown' }).Count -lt 1 -or
        @($status.whileClosedRows | Where-Object { $_.state -ceq 'recording' -and $_.target -ceq 'synthetic' }).Count -lt 1) { return $false }
    if ($status.afterReload.headline -cne $status.afterRestart.dashboard.headline -or
        (@($status.afterReload.detail) -join '|') -cne (@($status.afterRestart.dashboard.detail) -join '|')) { return $false }
    $closed = $status.whileClosed
    if ($null -eq $closed -or $closed.target -cne 'synthetic' -or $null -ne $closed.code -or $closed.state -cnotin @('recording','paused','interrupted') -or
        !(Test-ReceiptInteger -Value $closed.losses.lostEvents -Minimum 0 -Maximum 0) -or
        !(Test-ReceiptInteger -Value $closed.losses.notConnected -Minimum 1 -Maximum 1)) { return $false }
    if ((@($status.reopened.losses) -join '|') -cne 'Gaps recorded since ETS2Telemetry started|Intervals without a connection: 1') { return $false }
    # The reopened dashboard is closed again, so the tray exit runs with the main window closed.
    if ($status.closedAgain.dashboard -isnot [bool] -or $status.closedAgain.dashboard) { return $false }
    # Each dashboard text log the driver records holds the text it was waited for.
    if (@($status.firstConnectionTexts | Where-Object { $_.headline -ceq 'Recording' -and @($_.detail)[0] -ceq $note }).Count -lt 1 -or
        @($status.serviceRestartTexts | Where-Object { $_.headline -ceq 'Not known: the telemetry service is not running or has not reported a valid status' -and
            $null -eq $_.detail }).Count -lt 1 -or
        @($Recording.restart.status.texts | Where-Object { $_.headline -cin @('Recording','Game paused; recording continues when it resumes') -and
            @($_.detail)[0] -ceq $note }).Count -lt 1) { return $false }
    foreach ($row in @($Recording.restart.status.rows)) {
        foreach ($name in $lossNames) { if ($null -ne $row.$name -and !(Test-ReceiptInteger -Value $row.$name -Minimum 0 -Maximum 0)) { return $false } }
    }
    if (@($Recording.restart.status.rows | Where-Object { $_.state -cin @('recording','paused') }).Count -lt 1) { return $false }
    return $true
}

# ET-016 PR-8 journal and export of the recording journey: run B's Journal tab showed the one recorded trip with its
# hand-written list row, detail, two completeness intervals, timeline 3-8 and samples; the export was saved once and a
# cancelled export wrote nothing; after the exit the export passed the shared validator and reconciled with the stored
# rows: the same trip, plugin session and database UUIDs, each eventSeq of the window once despite the redelivery, and
# the trip's stored interval and sample ids. The schema version 2 trip columns say that the trip opened at its job event.
function Test-RecordingJournalReceipt {
    param([object]$Recording)
    $journal = $Recording.journal
    if ($null -eq $journal) { return $false }
    foreach ($field in @('listMatch','detailMatch','intervalsMatch','timelineMatch','samplesMatch','exportSaved','exportCancelledWritesNothing',
        'exportUnchangedByCancel','sampleCountMatch','exportValidated','exportReconciled')) {
        if ($journal.$field -isnot [bool] -or $journal.$field -ne $true) { return $false }
    }
    $uuid = '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
    $trip = $journal.tripUuid
    if ($trip -isnot [string] -or $trip -cnotmatch $uuid) { return $false }
    $rows = @($journal.list.rows)
    if ($rows.Count -ne 1 -or $rows[0].trip -cne $trip -or $rows[0].outcome -cne 'Delivered' -or $rows[0].completeness -cne 'Partial' -or
        $journal.list.banner -cne "Synthetic test database $([char]0x2014) never game history") { return $false }
    $detail = $journal.detail
    if ($null -eq $detail -or $detail.outcome -cne 'Delivered' -or $detail.completeness -cne 'Partial' -or $detail.fields.'trip-tripId' -cne $trip -or
        $detail.fields.'trip-openedBy' -cne 'job event 3') { return $false }
    if (@($journal.intervals.rows).Count -ne 2 -or (@($journal.timeline.eventSeqs) -join ',') -cne '3,4,5,6,7,8') { return $false }
    # The journal's sample count is the trip's stored count: the optional second-1000 row or none.
    $sampleCount = $journal.sampleCount
    $storedTripSamples = @($Recording.database.rows.sampleRows | Where-Object { $_.trip -ceq 'trip@3' }).Count
    if (!(Test-ReceiptInteger -Value $sampleCount -Minimum 0 -Maximum 1) -or $sampleCount -ne $storedTripSamples) { return $false }
    # One saved file; the cancelled export left nothing; main logged one saved and one cancelled export.
    if ((@($journal.exportFolder) -join ',') -cne 'trip.json') { return $false }
    $exportEvents = @($journal.exportEvents)
    if ((@($exportEvents | ForEach-Object { $_.event }) -join ',') -cne 'JOURNAL_EXPORT_SAVED,JOURNAL_EXPORT_CANCELLED' -or
        !(Test-ReceiptInteger -Value $exportEvents[0].facts.events -Minimum 6 -Maximum 6) -or
        !(Test-ReceiptInteger -Value $exportEvents[0].facts.samples -Minimum $sampleCount -Maximum $sampleCount)) { return $false }
    if ($null -eq $journal.exportProblems -or @($journal.exportProblems).Count -ne 0) { return $false }
    # Reconciliation: the export's rows and identifiers against the stored rows.
    $exported = $journal.exportRows; $stored = $journal.storedRows; $ids = $journal.exportIds
    if ($null -eq $exported -or $null -eq $stored -or $null -eq $ids -or $null -eq $exported.bounds) { return $false }
    if ((@($exported.eventSeqs) -join ',') -cne '3,4,5,6,7,8' -or (@($stored.eventSeqs) -join ',') -cne '3,4,5,6,7,8') { return $false }
    # Every identifier must be a string: a null or other element fails the receipt instead of being filtered away.
    foreach ($list in @($exported.intervalIds, $stored.intervalIds, $exported.sampleIds, $stored.sampleIds)) {
        if (@(@($list) | Where-Object { $_ -isnot [string] }).Count -ne 0) { return $false }
    }
    $intervalIds = @($exported.intervalIds | Where-Object { $null -ne $_ }); $storedIntervalIds = @($stored.intervalIds | Where-Object { $null -ne $_ })
    $sampleIds = @($exported.sampleIds | Where-Object { $null -ne $_ }); $storedSampleIds = @($stored.sampleIds | Where-Object { $null -ne $_ })
    if ($intervalIds.Count -ne 2 -or ($intervalIds -join ',') -cne ($storedIntervalIds -join ',') -or $storedIntervalIds.Count -ne 2 -or
        $sampleIds.Count -ne $sampleCount -or ($sampleIds -join ',') -cne ($storedSampleIds -join ',') -or $storedSampleIds.Count -ne $sampleCount) { return $false }
    $bounds = $exported.bounds
    if ($bounds.committedThroughEventSeq -cne '13' -or $bounds.snapshot -isnot [bool] -or $bounds.snapshot -or
        $bounds.lastIntervalId -cne $storedIntervalIds[-1]) { return $false }
    if (($sampleCount -eq 0 -and $null -ne $bounds.lastSampleId) -or ($sampleCount -eq 1 -and $bounds.lastSampleId -cne $storedSampleIds[-1])) { return $false }
    foreach ($name in @('tripUuid','pluginSessionId','databaseUuid')) {
        if ($ids.$name -isnot [string] -or $ids.$name -cnotmatch $uuid -or $ids.$name -cne $stored.$name) { return $false }
    }
    if ($ids.tripUuid -cne $trip -or $detail.fields.'trip-session' -cne $ids.pluginSessionId) { return $false }
    # Schema version 2 trip columns: opened at its job event, with no checkpoint (the journey has no late-attach trip).
    $storedTrip = @($Recording.database.rows.trips)[0]
    if ($storedTrip.jobSource -cne 'event' -or $storedTrip.openedBy -cne 'event' -or $null -ne $storedTrip.checkpointNextEventSeq) { return $false }
    return $true
}

# ET-015a PR-4 recording journey: commits through a killed and restarted service, close-to-tray, a tray exit and an
# application restart into one synthetic database, which holds the hand-written rows; no history database exists.
function Test-RecordingReceipt {
    param([object]$Driver)
    $recording = $Driver.recording
    if ($null -eq $recording) { return $false }
    foreach ($field in @('commitsActive','serviceRestartRecovered','dashboardClosedRecordingContinued','trayExitOrderly','restartRecovered',
        'shutdownClean','simulatorMatchesReplay','historyDatabaseAbsent','sidecarsAbsent','databaseRowsMatch','samplesRecorded')) {
        if ($recording.$field -isnot [bool] -or $recording.$field -ne $true) { return $false }
    }
    # Three distinct service processes: the first, its supervised replacement (unchanged while the dashboard is closed) and run B's.
    foreach ($servicePid in @($recording.servicePid, $recording.restartedServicePid, $recording.restart.servicePid)) {
        if (!(Test-ReceiptInteger -Value $servicePid -Minimum 1 -Maximum 4294967295)) { return $false }
    }
    if ($recording.restartedServicePid -eq $recording.servicePid -or $recording.restart.servicePid -eq $recording.servicePid -or
        $recording.restart.servicePid -eq $recording.restartedServicePid -or $recording.afterClose.servicePid -ne $recording.restartedServicePid -or
        $recording.whileClosed.servicePid -ne $recording.restartedServicePid) { return $false }
    foreach ($state in @($recording.afterClose, $recording.whileClosed)) {
        foreach ($flag in @('dashboard','exiting')) { if ($state.$flag -isnot [bool] -or $state.$flag) { return $false } }
        foreach ($flag in @('tray','overlay')) { if ($state.$flag -isnot [bool] -or !$state.$flag) { return $false } }
    }
    # Commits: ACKs reach the proxy only after their storage commits; the fifth ACK of connection 1 is lost on purpose, so
    # the restarted service receives eventSeq 5 again and acknowledges it once more. ET-015b PR-4 appends eventSeq 10 to
    # connection 2 and 11-13 to connection 3.
    $first = $recording.firstConnection; $second = $recording.secondConnection; $third = $recording.thirdConnection
    if ($null -eq $first -or $null -eq $second -or $null -eq $third) { return $false }
    if ((@($first.forwardedAcks) -join ',') -cne '1,2,3,4' -or (@($first.withheldAcks) -join ',') -cne '5' -or $first.closedBy -cne 'server' -or
        $second.checkpointAckedThrough -cne '4' -or (@($second.forwardedAcks) -join ',') -cne '5,6,7,8,9,10' -or (@($second.withheldAcks)).Count -ne 0 -or
        $third.checkpointAckedThrough -cne '10' -or (@($third.forwardedAcks) -join ',') -cne '11,12,13') { return $false }
    $redelivered = @($second.events)
    if ($redelivered.Count -ne 6 -or $redelivered[0].eventSeq -cne '5' -or $redelivered[0].redelivered -isnot [bool] -or !$redelivered[0].redelivered) { return $false }
    foreach ($row in @($recording.firstServiceDurable, $recording.restartedServiceDurable, $recording.restart.durable)) {
        if ($null -eq $row -or $row.durable -cne 'active' -or $row.selection -cne 'synthetic') { return $false }
    }
    $exit = $recording.trayExit
    if ($null -eq $exit -or !(Test-ReceiptInteger -Value $exit.launcherExit -Minimum 0 -Maximum 0) -or $null -ne $exit.signal -or
        !(Test-ReceiptInteger -Value $exit.exitMilliseconds -Minimum 0 -Maximum 8000) -or
        @($exit.requests).Count -ne 1 -or @($exit.requests)[0] -cne 'tray') { return $false }
    if (!(Test-ReceiptInteger -Value $recording.restartLauncherExit -Minimum 0 -Maximum 0) -or $Driver.launcherExit -ne 0) { return $false }
    # The simulator served three durable connections and matched its deterministic replay.
    $simulator = $recording.simulator
    if ($null -eq $simulator -or !(Test-ReceiptInteger -Value $simulator.exit.code -Minimum 0 -Maximum 0) -or $simulator.report.matchesReplay -isnot [bool] -or
        !$simulator.report.matchesReplay -or $simulator.report.cancelled -isnot [bool] -or $simulator.report.cancelled -or @($simulator.report.connections).Count -ne 3) { return $false }
    foreach ($connection in @($simulator.report.connections)) { if ($connection.durable -isnot [bool] -or !$connection.durable) { return $false } }
    # Files and rows: the closed synthetic database without sidecars, no history database, and the expected rows.
    $files = $recording.files
    if ($null -eq $files -or @($files.sidecars).Count -ne 0 -or $files.historyDatabase -isnot [bool] -or $files.historyDatabase -or
        $files.syntheticBackups -isnot [bool] -or $files.syntheticBackups -or !(Test-ReceiptInteger -Value $files.userVersion -Minimum 2 -Maximum 2)) { return $false }
    $database = $recording.database
    if ($null -eq $database -or (@($database.integrity) -join ',') -cne 'ok' -or !(Test-ReceiptInteger -Value $database.foreignKeyViolations -Minimum 0 -Maximum 0) -or
        $database.purpose -cne 'synthetic' -or @($database.sessions).Count -ne 1 -or $database.sessions[0].origin -cne 'synthetic' -or
        $database.sessions[0].committedThrough -cne '13' -or $database.acknowledgedThrough -cne '13') { return $false }
    $rows = $database.rows
    if ($null -eq $rows -or @($rows.events).Count -ne 13 -or @($rows.trips).Count -ne 1 -or $rows.trips[0].outcome -cne 'delivered' -or
        $rows.trips[0].recordingCompleteness -cne 'partial' -or @($rows.attributions).Count -ne 1 -or @($rows.intervals).Count -ne 2 -or
        $rows.intervals[1].kind -cne 'not-connected' -or $rows.intervals[1].detail.cause -cne 'consumer-restart') { return $false }
    $eventSeqs = @($rows.events | ForEach-Object { $_.eventSeq })
    if (($eventSeqs -join ',') -cne '1,2,3,4,5,6,7,8,9,10,11,12,13') { return $false }
    # ET-015b PR-4 samples: the optional second 1000 of the terminated service at most, then seconds 1001 and 1002 without
    # a trip, written by the replacement service and by run B.
    $samples = @($rows.sampleRows)
    $seconds = @($samples | ForEach-Object { $_.second })
    if ((($seconds -join ',') -cne '1001,1002' -and ($seconds -join ',') -cne '1000,1001,1002') -or
        $null -ne $samples[-1].trip -or $null -ne $samples[-2].trip) { return $false }
    # Run A: the terminated service and its replacement; one tray exit and one final clean stop.
    $mainEvents = @($Driver.mainEvents); $serviceEvents = @($Driver.serviceEvents)
    $appExits = @($mainEvents | Where-Object { $_.event -ceq 'APP_EXIT' }); $serviceExits = @($mainEvents | Where-Object { $_.event -ceq 'SERVICE_EXIT' })
    if ($appExits.Count -ne 1 -or $null -eq $appExits[0].detail.code -or $appExits[0].detail.code -ne 0 -or $serviceExits.Count -ne 2 -or
        $null -eq $serviceExits[1].detail.code -or $serviceExits[1].detail.code -ne 0) { return $false }
    if (@($mainEvents | Where-Object { $_.event -ceq 'DIAGNOSTIC_SERVICE_EXIT_REQUEST' }).Count -ne 1) { return $false }
    $requests = @($mainEvents | Where-Object { $_.event -ceq 'APP_EXIT_REQUESTED' })
    if ($requests.Count -ne 1 -or $requests[0].facts.reason -cne 'tray') { return $false }
    $stopped = @($serviceEvents | Where-Object { $_.event -ceq 'SERVICE_REPORT' -and $_.detail.type -ceq 'stopped' })
    if ($stopped.Count -ne 1 -or $stopped[0].detail.clean -isnot [bool] -or !$stopped[0].detail.clean) { return $false }
    foreach ($step in @($serviceEvents | Where-Object { $_.event -ceq 'SHUTDOWN_STEP' })) { if ($step.facts.outcome -cne 'ok') { return $false } }
    foreach ($row in $mainEvents + $serviceEvents) {
        if ($row.event -cmatch 'FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE') { return $false }
    }
    if (!(Test-RecordingServiceEvent -ServiceEvents $serviceEvents -Created @($true, $false))) { return $false }
    # Run B: one orderly run that reopened the same database.
    $restartMain = @($recording.restartMainEvents); $restartService = @($recording.restartServiceEvents)
    if (!(Test-OrderlyRunEvent -MainEvents $restartMain -ServiceEvents $restartService) -or
        !(Test-RecordingServiceEvent -ServiceEvents $restartService -Created @($false))) { return $false }
    $restartRequests = @($restartMain | Where-Object { $_.event -ceq 'APP_EXIT_REQUESTED' })
    if ($restartRequests.Count -ne 1 -or $restartRequests[0].facts.reason -cne 'app-quit') { return $false }
    # Only the terminated service's probe remains, as crash evidence.
    if (@($Driver.probesAfterExit).Count -ne 1 -or (@($Driver.probesAfterExit) -join ',') -cne (@($recording.retainedCrashProbe) -join ',')) { return $false }
    if (!(Test-RecordingStatusReceipt -Recording $recording)) { return $false }
    # ET-016 PR-8: the journal and export of the recorded trip.
    if (!(Test-RecordingJournalReceipt -Recording $recording)) { return $false }
    return $true
}

# ET-016 PR-4 journal journey: run 1 shows the empty history in the Journal tab with the Live lines in the first
# viewport; the seed writes the synthetic journal database; run 2 opens only that database and reads it through the
# Journal tab: three list pages, two filters, every anchor's row and detail, and the paging trip's timeline, intervals
# and samples. Both runs exit orderly; the synthetic file is closed without sidecars or backups.
function Test-JournalReceipt {
    param([object]$Driver)
    $journal = $Driver.journal
    if ($null -eq $journal) { return $false }
    foreach ($field in @('liveLinesInViewport','liveHiddenInJournal','emptyHistoryShown','recordingOffNoteShown','liveRestored','seeded','syntheticBannerShown',
        'pagesWalked','anchorRowsMatch','anchorDetailsMatch','backKeptPage','sampleGapShown','timelinePaged','intervalsPaged','samplesPaged','filtersApplied','shutdownClean')) {
        if ($journal.$field -isnot [bool] -or $journal.$field -ne $true) { return $false }
    }
    $empty = $journal.emptyHistory
    if ($null -eq $empty -or $empty.empty -cne 'No trips recorded' -or
        $empty.emptyNote -cne 'Game history recording is off in this version, so no game trips are recorded yet.' -or
        $null -ne $empty.banner -or $null -ne $empty.error -or @($empty.rows).Count -ne 0) { return $false }
    $seed = $journal.seed
    if ($null -eq $seed -or !(Test-ReceiptInteger -Value $seed.trips -Minimum 119 -Maximum 119) -or !(Test-ReceiptInteger -Value $seed.fillers -Minimum 110 -Maximum 110) -or
        !(Test-ReceiptInteger -Value $seed.pagingTolls -Minimum 104 -Maximum 104) -or !(Test-ReceiptInteger -Value $seed.pagingSamples -Minimum 3600 -Maximum 3600)) { return $false }
    if ((@($journal.pages | ForEach-Object { $_.count }) -join ',') -cne '50,50,19' -or @($journal.pages)[2].next -isnot [bool] -or @($journal.pages)[2].next) { return $false }
    $filters = $journal.filters
    if ($null -eq $filters -or @($filters.none).Count -ne 3 -or !(Test-ReceiptInteger -Value $filters.partial -Minimum 39 -Maximum 39)) { return $false }
    # Review round 1: the B6 viewport bounds and the anchors' order are re-checked here, not only as driver flags. The
    # status, speed and fuel lines must lie inside the first viewport; page 3 lists the anchors newest first, and the
    # details are opened oldest first.
    $viewport = $journal.liveViewport
    if ($null -eq $viewport -or !(Test-ReceiptInteger -Value $viewport.innerHeight -Minimum 1 -Maximum 100000)) { return $false }
    foreach ($line in @('status','speed','fuel')) {
        $box = $viewport.$line
        if ($null -eq $box -or $box.visible -isnot [bool] -or !$box.visible -or !(Test-ReceiptInteger -Value $box.top -Minimum 0 -Maximum 100000) -or
            !(Test-ReceiptInteger -Value $box.bottom -Minimum 0 -Maximum 100000) -or $box.top -gt $box.bottom -or $box.bottom -gt $viewport.innerHeight) { return $false }
    }
    $anchorRows = '7a000000-0000-4000-8000-000000000008,7a000000-0000-4000-8000-000000000007,7a000000-0000-4000-8000-000000000006,7a000000-0000-4000-8000-000000000005,7a000000-0000-4000-8000-000000000004,7a000000-0000-4000-8000-000000000003,7a000000-0000-4000-8000-000000000002,7a000000-0000-4000-8000-000000000001'
    $anchorDetails = '7a000000-0000-4000-8000-000000000001,7a000000-0000-4000-8000-000000000002,7a000000-0000-4000-8000-000000000003,7a000000-0000-4000-8000-000000000004,7a000000-0000-4000-8000-000000000005,7a000000-0000-4000-8000-000000000006,7a000000-0000-4000-8000-000000000007,7a000000-0000-4000-8000-000000000008'
    if ((@($journal.anchorRows | ForEach-Object { $_.trip }) -join ',') -cne $anchorRows -or
        (@($journal.anchorDetails | ForEach-Object { $_.trip }) -join ',') -cne $anchorDetails) { return $false }
    if ((@($journal.deliveredSamples | ForEach-Object { $_.kind }) -join ',') -cne 'sample,sample,gap,sample' -or
        @($journal.deliveredSamples)[2].text -cne 'no samples for 1 s') { return $false }
    if (@($journal.pagingTimeline.pageTwo).Count -ne 5 -or !(Test-ReceiptInteger -Value $journal.pagingIntervals.pageTwo -Minimum 4 -Maximum 4) -or
        (@($journal.pagingSamples.kinds) -join ',') -cne 'sample') { return $false }
    # ET-016 PR-5 trip export: the paging trip and the delivered anchor saved and checked, a cancelled dialog and a refused
    # data-folder target that wrote nothing, and exactly the expected export rows in run 2's main log.
    foreach ($field in @('exportNoteShown','exportsSaved','exportCancelledWritesNothing','exportTargetRefused','dataFolderUnchanged')) {
        if ($journal.$field -isnot [bool] -or $journal.$field -ne $true) { return $false }
    }
    if ((@($journal.exportFolder) -join ',') -cne 'delivered.json,paging.json') { return $false }
    $pagingExport = $journal.pagingExport
    if ($null -eq $pagingExport -or !(Test-ReceiptInteger -Value $pagingExport.events -Minimum 105 -Maximum 105) -or
        !(Test-ReceiptInteger -Value $pagingExport.intervals -Minimum 104 -Maximum 104) -or !(Test-ReceiptInteger -Value $pagingExport.samples -Minimum 3600 -Maximum 3600) -or
        $pagingExport.snapshot -isnot [bool] -or !$pagingExport.snapshot) { return $false }
    if ((@($journal.deliveredExport.events | ForEach-Object { $_[0] }) -join ',') -cne '4,5,6,7,8,9' -or $journal.deliveredExport.bounds.snapshot -isnot [bool] -or
        $journal.deliveredExport.bounds.snapshot) { return $false }
    $exportEvents = @($journal.exportEvents)
    if ((@($exportEvents | ForEach-Object { $_.event }) -join ',') -cne 'JOURNAL_EXPORT_SAVED,JOURNAL_EXPORT_SAVED,JOURNAL_EXPORT_CANCELLED,JOURNAL_EXPORT_FAILED' -or
        $exportEvents[3].facts.code -cne 'EXPORT_TARGET_REFUSED' -or !(Test-ReceiptInteger -Value $exportEvents[0].facts.samples -Minimum 3600 -Maximum 3600) -or
        !(Test-ReceiptInteger -Value $exportEvents[1].facts.events -Minimum 6 -Maximum 6)) { return $false }
    $exit = $journal.emptyRunExit
    if ($null -eq $exit -or !(Test-ReceiptInteger -Value $exit.launcherExit -Minimum 0 -Maximum 0) -or $null -ne $exit.signal) { return $false }
    if (!(Test-ReceiptInteger -Value $journal.restartLauncherExit -Minimum 0 -Maximum 0) -or $Driver.launcherExit -ne 0 -or
        $null -eq $Driver.probesAfterExit -or @($Driver.probesAfterExit).Count -ne 0) { return $false }
    $files = $journal.files
    if ($null -eq $files -or !(Test-ReceiptInteger -Value $files.userVersion -Minimum 2 -Maximum 2) -or @($files.sidecars).Count -ne 0 -or
        $files.syntheticBackups -isnot [bool] -or $files.syntheticBackups) { return $false }
    # Run 1 opened the new history database; run 2 only the existing synthetic one.
    $serviceEvents = @($Driver.serviceEvents); $restartService = @($journal.restartServiceEvents)
    # The refused export target's row is run 2's only expected failure code (ET-016 PR-5); it is checked above.
    $restartMain = @($journal.restartMainEvents | Where-Object { !($_.event -ceq 'JOURNAL_EXPORT_FAILED' -and $_.facts.code -ceq 'EXPORT_TARGET_REFUSED') })
    if (@($journal.restartMainEvents).Count - $restartMain.Count -ne 1) { return $false }
    if (!(Test-OrderlyRunEvent -MainEvents @($Driver.mainEvents) -ServiceEvents $serviceEvents) -or
        !(Test-OrderlyRunEvent -MainEvents $restartMain -ServiceEvents $restartService)) { return $false }
    if (@($serviceEvents | Where-Object { $_.event -ceq 'RECORDING_TARGET' }).Count -ne 0) { return $false }
    foreach ($run in @(@{rows=$serviceEvents; created=$true}, @{rows=$restartService; created=$false})) {
        $opened = @($run.rows | Where-Object { $_.event -ceq 'HISTORY_STORAGE_OPENED' })
        if ($opened.Count -ne 1 -or $opened[0].facts.created -isnot [bool] -or $opened[0].facts.created -ne $run.created -or
            !(Test-ReceiptInteger -Value $opened[0].facts.schemaVersion -Minimum 2 -Maximum 2)) { return $false }
        if (@($run.rows | Where-Object { $_.event -ceq 'HISTORY_STORAGE_CLOSED' }).Count -ne 1) { return $false }
    }
    $targets = @($restartService | Where-Object { $_.event -ceq 'RECORDING_TARGET' })
    if ($targets.Count -ne 1 -or $targets[0].facts.purpose -cne 'synthetic') { return $false }
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
    # Recording is additive too (ET-015a PR-4); it tightens no earlier scenario.
    if ($ExpectedScenario -ceq 'recording' -and !(Test-RecordingReceipt -Driver $driver)) {
        $validation.reason = 'RECORDING_RESULT_INCOMPLETE_OR_INVALID'; return $validation
    }
    # Journal is additive too (ET-016 PR-4); it tightens no earlier scenario.
    if ($ExpectedScenario -ceq 'journal' -and !(Test-JournalReceipt -Driver $driver)) {
        $validation.reason = 'JOURNAL_RESULT_INCOMPLETE_OR_INVALID'; return $validation
    }
    $validation.passed = $true
    return $validation
}
