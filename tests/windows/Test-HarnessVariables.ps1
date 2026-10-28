[CmdletBinding()]
param(
    # The PowerShell scripts to check, separated by '|' (powershell.exe -File passes one string); each is parsed, never run.
    [Parameter(Mandatory = $true)][string]$Path
)
# ET-055 PR-5 fix round 2 (hosted run 40689215872): PowerShell variable names are case-insensitive, so a local `$key`
# assigns a parameter `[string]$Key` of the same function and its type constraint turns the value into a string;
# Read-RegistrationView then called `.Dispose()` on the key's name. This parses each script and reports every assignment
# or foreach variable whose name equals a parameter of the same scope (the function, or the script's own param block for
# code outside every function) but differs from it in case: such a name was meant to be a separate variable. Writing a
# parameter in its own spelling stays allowed. Prints one JSON line: {files, violations: ["<file>:<line> <scope> $<name> -> $<param>"]}.
$ErrorActionPreference = 'Stop'
$violations = [Collections.Generic.List[string]]::new()
function Get-ParameterNames($Parameters) {
    return @($Parameters | Where-Object { $_ } | ForEach-Object { $_.Name.VariablePath.UserPath })
}
function Test-Scope([string]$File, [string]$ScopeName, [string[]]$Parameters, $Body) {
    if (!$Parameters -or !$Body) { return }
    # Assignments and foreach variables in this scope, without those of nested function definitions (their own scope).
    $nodes = $Body.FindAll({
        param($node)
        ($node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.VariableExpressionAst]) -or
            ($node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left -is [Management.Automation.Language.ConvertExpressionAst] -and
                $node.Left.Child -is [Management.Automation.Language.VariableExpressionAst]) -or
            $node -is [Management.Automation.Language.ForEachStatementAst]
    }, $true)
    foreach ($node in $nodes) {
        $parent = $node.Parent; $nested = $false
        while ($parent -and $parent -ne $Body) {
            if ($parent -is [Management.Automation.Language.FunctionDefinitionAst]) { $nested = $true; break }
            $parent = $parent.Parent
        }
        if ($nested) { continue }
        $variable = if ($node -is [Management.Automation.Language.ForEachStatementAst]) { $node.Variable }
            elseif ($node.Left -is [Management.Automation.Language.ConvertExpressionAst]) { $node.Left.Child } else { $node.Left }
        $name = $variable.VariablePath.UserPath
        if ($variable.VariablePath.IsScript -or $variable.VariablePath.IsGlobal -or $name -match ':') { continue }
        foreach ($parameter in $Parameters) {
            if ($name -ieq $parameter -and $name -cne $parameter) {
                $violations.Add(('{0}:{1} {2} ${3} -> ${4}' -f [IO.Path]::GetFileName($File), $node.Extent.StartLineNumber, $ScopeName, $name, $parameter))
            }
        }
    }
}
$files = @($Path -split '\|' | Where-Object { $_ })
foreach ($file in $files) {
    $tokens = $null; $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($file, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw ('PARSE_FAILED ' + [IO.Path]::GetFileName($file)) }
    Test-Scope $file '<script>' (Get-ParameterNames $ast.ParamBlock.Parameters) $ast
    foreach ($function in @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true))) {
        $parameters = @(Get-ParameterNames $function.Parameters) + @(Get-ParameterNames $function.Body.ParamBlock.Parameters)
        Test-Scope $file $function.Name $parameters $function.Body
    }
}
[ordered]@{files = $files.Count; violations = @($violations)} | ConvertTo-Json -Compress
