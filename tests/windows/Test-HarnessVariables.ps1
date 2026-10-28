[CmdletBinding()]
param(
    # The PowerShell scripts to check, separated by '|' (powershell.exe -File passes one string); each is parsed, never run.
    [Parameter(Mandatory = $true)][string]$Path
)
# ET-055 PR-5 fix round 2 (hosted run 40689215872): PowerShell variable names are case-insensitive, so a local `$key`
# assigns a parameter `[string]$Key` of the same function and its type constraint turns the value into a string;
# Read-RegistrationView then called `.Dispose()` on the key's name. This parses each script and reports every variable
# that a statement of a scope (the function, or the script's own param block for code outside every function) writes,
# when its name equals a parameter of that scope but differs from it in case: such a name was meant to be a separate
# variable.
# ET-055 PR-8 (PR-5 review) widens what counts as a write and what is reported:
# - the writes are an assignment (also `[type]$x = ...` and the elements of `$a, $b = ...`), a foreach variable, a
#   `[ref]$x` argument, the name given to -OutVariable, -ErrorVariable, -WarningVariable, -InformationVariable or
#   -PipelineVariable (also their aliases and accepted abbreviations; a leading `+` removed), the -Name (or first
#   positional) argument of Set-Variable/sv and New-Variable/nv, and `$local:`/`$private:` writes under the bare name;
# - a write in the parameter's own spelling is reported too when the parameter has a type constraint (other than
#   [object]) or a Validate* attribute, because that write is converted or validated as the parameter, not stored as is.
# Prints one JSON line: {files, violations: ["<file>:<line> <scope> $<name> -> $<param>[ (constrained)]"]}.
$ErrorActionPreference = 'Stop'
$violations = [Collections.Generic.List[string]]::new()
function Get-ParameterRows($Parameters) {
    # Each parameter's name and whether a write to it is converted or validated.
    return @($Parameters | Where-Object { $_ } | ForEach-Object {
        $constrained = @($_.Attributes | Where-Object {
            ($_ -is [Management.Automation.Language.TypeConstraintAst] -and $_.TypeName.FullName -notin @('object', 'System.Object')) -or
                ($_ -is [Management.Automation.Language.AttributeAst] -and $_.TypeName.Name -match '^Validate')
        }).Count -gt 0
        [pscustomobject]@{Name = $_.Name.VariablePath.UserPath; Constrained = $constrained}
    })
}
function Get-WrittenNames($Node) {
    # The names one node writes: [pscustomobject]@{Name; Line}; empty for a node that writes nothing.
    $rows = @()
    $variableOf = {
        param($Expression)
        if ($Expression -is [Management.Automation.Language.VariableExpressionAst]) { return $Expression }
        if ($Expression -is [Management.Automation.Language.ConvertExpressionAst] -and $Expression.Child -is [Management.Automation.Language.VariableExpressionAst]) { return $Expression.Child }
        return $null
    }
    $fromVariable = {
        param($Variable)
        if (!$Variable -or $Variable.VariablePath.IsScript -or $Variable.VariablePath.IsGlobal) { return }
        # $local:x and $private:x write the scope's own variable, so they count under the bare name; any other drive stays out.
        $name = $Variable.VariablePath.UserPath -replace '^(?i:local|private):', ''
        if ($name -match ':') { return }
        [pscustomobject]@{Name = $name; Line = $Variable.Extent.StartLineNumber}
    }
    # The common parameters that name a variable to write, with the shortest prefix PowerShell accepts for each and their aliases.
    $variableParameters = @(@('OutVariable', 4, 'ov'), @('ErrorVariable', 6, 'ev'), @('WarningVariable', 8, 'wv'), @('InformationVariable', 12, 'iv'),
        @('PipelineVariable', 9, 'pv'))
    $namesVariable = {
        param([string]$ParameterName)
        foreach ($row in $variableParameters) {
            if ($ParameterName -ieq $row[2] -or ($ParameterName.Length -ge $row[1] -and $row[0].StartsWith($ParameterName, [StringComparison]::OrdinalIgnoreCase))) { return $true }
        }
        return $false
    }
    if ($Node -is [Management.Automation.Language.AssignmentStatementAst]) {
        $targets = if ($Node.Left -is [Management.Automation.Language.ArrayLiteralAst]) { @($Node.Left.Elements) } else { @($Node.Left) }
        foreach ($target in $targets) { $rows += @(& $fromVariable (& $variableOf $target)) }
    } elseif ($Node -is [Management.Automation.Language.ForEachStatementAst]) {
        $rows += @(& $fromVariable $Node.Variable)
    } elseif ($Node -is [Management.Automation.Language.ConvertExpressionAst] -and $Node.Type.TypeName.Name -ieq 'ref' -and
        $Node.Child -is [Management.Automation.Language.VariableExpressionAst]) {
        $rows += @(& $fromVariable $Node.Child)
    } elseif ($Node -is [Management.Automation.Language.CommandAst]) {
        $elements = @($Node.CommandElements)
        $command = $Node.GetCommandName()
        for ($index = 1; $index -lt $elements.Count; $index++) {
            $element = $elements[$index]
            if ($element -isnot [Management.Automation.Language.CommandParameterAst]) { continue }
            $setsVariable = (& $namesVariable $element.ParameterName) -or ($command -match '^(Set-Variable|sv|New-Variable|nv)$' -and $element.ParameterName -ieq 'Name')
            if (!$setsVariable) { continue }
            $argument = if ($element.Argument) { $element.Argument } elseif ($index + 1 -lt $elements.Count) { $elements[$index + 1] } else { $null }
            if ($argument -is [Management.Automation.Language.StringConstantExpressionAst]) {
                $rows += [pscustomobject]@{Name = $argument.Value.TrimStart('+'); Line = $argument.Extent.StartLineNumber}
            }
        }
        if ($command -match '^(Set-Variable|sv|New-Variable|nv)$' -and !@($elements | Where-Object { $_ -is [Management.Automation.Language.CommandParameterAst] -and $_.ParameterName -ieq 'Name' }).Count -and
            $elements.Count -gt 1 -and $elements[1] -is [Management.Automation.Language.StringConstantExpressionAst]) {
            $rows += [pscustomobject]@{Name = $elements[1].Value; Line = $elements[1].Extent.StartLineNumber}
        }
    }
    return $rows
}
function Test-Scope([string]$File, [string]$ScopeName, $Parameters, $Body) {
    if (!@($Parameters).Count -or !$Body) { return }
    # The nodes of this scope that can write a variable, without those of nested function definitions (their own scope).
    $nodes = $Body.FindAll({
        param($node)
        $node -is [Management.Automation.Language.AssignmentStatementAst] -or $node -is [Management.Automation.Language.ForEachStatementAst] -or
            $node -is [Management.Automation.Language.ConvertExpressionAst] -or $node -is [Management.Automation.Language.CommandAst]
    }, $true)
    foreach ($node in $nodes) {
        $parent = $node.Parent; $nested = $false
        while ($parent -and $parent -ne $Body) {
            if ($parent -is [Management.Automation.Language.FunctionDefinitionAst]) { $nested = $true; break }
            $parent = $parent.Parent
        }
        if ($nested) { continue }
        foreach ($written in @(Get-WrittenNames $node)) {
            foreach ($parameter in $Parameters) {
                if ($written.Name -ine $parameter.Name) { continue }
                if ($written.Name -cne $parameter.Name) {
                    $violations.Add(('{0}:{1} {2} ${3} -> ${4}' -f [IO.Path]::GetFileName($File), $written.Line, $ScopeName, $written.Name, $parameter.Name))
                } elseif ($parameter.Constrained) {
                    $violations.Add(('{0}:{1} {2} ${3} -> ${4} (constrained)' -f [IO.Path]::GetFileName($File), $written.Line, $ScopeName, $written.Name, $parameter.Name))
                }
            }
        }
    }
}
$files = @($Path -split '\|' | Where-Object { $_ })
foreach ($file in $files) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ('PARSE_FAILED ' + [IO.Path]::GetFileName($file)) }
    Test-Scope $file '<script>' (Get-ParameterRows $ast.ParamBlock.Parameters) $ast
    foreach ($function in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
        $parameters = @(Get-ParameterRows $function.Parameters) + @(Get-ParameterRows $function.Body.ParamBlock.Parameters)
        Test-Scope $file $function.Name $parameters $function.Body
    }
}
[ordered]@{files = $files.Count; violations = @($violations)} | ConvertTo-Json -Compress
