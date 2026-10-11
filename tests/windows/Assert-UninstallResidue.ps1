# Pinned Squirrel may retain its own mapped helpers; no application payload is allowed.
function Assert-UninstallResidue {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$BinaryRoot,[Parameter(Mandatory)][ValidateSet('0.1.0','0.1.1')][string]$Version,
        [Parameter(Mandatory)][object]$Squirrel,[object[]]$Registration=@(),[object[]]$ProductShortcuts=@())
    if(@($Registration).Count){throw 'UNINSTALL_REGISTRATION_REMAINS'}
    if(@($ProductShortcuts).Count){throw 'UNINSTALL_PRODUCT_SHORTCUT_REMAINS'}
    if(![IO.Path]::IsPathRooted($BinaryRoot) -or !(Test-Path -LiteralPath $BinaryRoot -PathType Container)){throw 'UNINSTALL_ROOT_OR_MARKER_MISSING'}
    if($Squirrel.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $Squirrel.bytes -le 0 -or $Squirrel.bytes -gt 8388608){throw 'UNINSTALL_VENDOR_PROJECTION_INVALID'}
    $root=(Get-Item -LiteralPath $BinaryRoot);if($root.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UNINSTALL_REPARSE_POINT'}
    $files=[Collections.Generic.List[object]]::new();$marker=$false
    $allowed=@('Update.exe',('app-'+$Version+'/squirrel.exe'))
    foreach($item in Get-ChildItem -LiteralPath $root.FullName -Recurse -Force){
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'UNINSTALL_REPARSE_POINT'}
        $relative=$item.FullName.Substring($root.FullName.Length+1).Replace('\','/')
        if($item.PSIsContainer){if($relative -ine ('app-'+$Version)){throw 'UNINSTALL_UNEXPECTED_DIRECTORY'};continue}
        if($relative -ieq '.dead'){
            if($item.Length -ne 1){throw 'UNINSTALL_MARKER_INVALID'}
            $stream=[IO.File]::OpenRead($item.FullName);try{if($stream.ReadByte() -ne 32 -or $stream.ReadByte() -ne -1){throw 'UNINSTALL_MARKER_INVALID'}}finally{$stream.Dispose()}
            $marker=$true;$files.Add(@{path=$item.FullName;relative=$relative;bytes=1;kind='dead-marker';sha256=(Get-FileHash -LiteralPath $item.FullName).Hash});continue
        }
        if($allowed -inotcontains $relative){throw 'UNINSTALL_UNEXPECTED_FILE'}
        if($item.Length -ne $Squirrel.bytes -or (Get-FileHash -LiteralPath $item.FullName).Hash -ne $Squirrel.sha256){throw 'UNINSTALL_VENDOR_HELPER_CHANGED'}
        $files.Add(@{path=$item.FullName;relative=$relative;bytes=$item.Length;kind='vendor-helper';sha256=$Squirrel.sha256})
    }
    if(!$marker){throw 'UNINSTALL_ROOT_OR_MARKER_MISSING'}
    @{productUninstalled=$true;binaryRootEmpty=$false;vendorCleanupPending=$true;deadMarkerVerified=$true;residue=$files.ToArray();syntheticDataDeletionClaimed=$false}
}
