@{
    # Used by scripts/Invoke-ScriptAnalysis.ps1. Every default rule runs at every severity except the exclusions
    # below; their reasons are listed in docs/setup.md#powershell-script-analysis.
    Severity = @('Error', 'Warning', 'Information')
    ExcludeRules = @(
        # Naming and -WhatIf conventions for published cmdlets; all functions here are private script helpers.
        'PSUseApprovedVerbs',
        'PSUseSingularNouns',
        'PSUseShouldProcessForStateChangingFunctions',
        # Argument-style preference; rewriting reviewed acceptance harnesses would not fix a defect.
        'PSAvoidUsingPositionalParameters'
    )
}
