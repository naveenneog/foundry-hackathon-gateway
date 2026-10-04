#Requires -Version 7.0

<#
    Platform differences, in one place.

    PowerShell 7 runs on Windows, macOS and Linux, and almost all of this console is portable
    already. The exception is file permissions: the ACL cmdlets are Windows-only, so the code that
    restricted the signing secret did nothing on a Mac or a Linux box - and did it quietly, inside
    a catch that warned and carried on. See ADR-0010 and UNKNOWNS U19.
#>

function Protect-File {
    <#
        Restrict a file to its owner.

        Windows: drop inheritance and leave one ACE for the current user.
        macOS/Linux: chmod 600.

        Throws if it cannot. The file this guards mints a key for any participant, any budget and
        any model, so "could not restrict permissions" is a stop, not a warning - the previous
        version warned, which is how the secret came to be world-readable off Windows.
    #>
    param([Parameter(Mandatory)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Cannot restrict permissions on '$Path': the file does not exist."
    }
    $full = (Resolve-Path -LiteralPath $Path).Path

    if ($IsWindows) {
        $acl = Get-Acl -LiteralPath $full
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($ace in @($acl.Access)) { [void]$acl.RemoveAccessRule($ace) }
        $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
        $acl.SetAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
            $me, 'FullControl', 'Allow')))
        Set-Acl -LiteralPath $full -AclObject $acl
        return
    }

    # chmod is on every supported macOS and Linux host. The mode is read back rather than trusting
    # the exit code: a umask, or a filesystem that ignores modes (exFAT, a 9p mount, some SMB and
    # NFS exports), lets chmod return 0 on a file that is still world-readable. Those are also the
    # mounts where stat is most likely to misbehave, so a read-back that cannot be completed is
    # treated as a failure - otherwise both halves of the check fail together and silently.
    & chmod 600 $full
    if ($LASTEXITCODE -ne 0) { throw "chmod 600 failed on '$full' (exit $LASTEXITCODE)." }

    $mode = & stat @(if ($IsMacOS) { '-f'; '%Lp' } else { '-c'; '%a' }) $full
    if ($LASTEXITCODE -ne 0 -or -not $mode) {
        throw "Could not read the permissions of '$full' back after chmod (stat exit $LASTEXITCODE). It holds the signing secret; refusing to continue."
    }

    $digits = ([string]$mode).Trim() -replace '\D', ''
    if (-not $digits) {
        throw "Could not parse the permissions of '$full' from stat output '$mode'. It holds the signing secret; refusing to continue."
    }
    # 0x3F is octal 077 - the group and other bits. PowerShell has no 0o literal.
    if ([Convert]::ToInt32($digits, 8) -band 0x3F) {
        throw "'$full' is still readable by group or other (mode $mode). It holds the signing secret; refusing to continue."
    }
}
