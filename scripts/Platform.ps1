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

    # Lets the catch below see errors that would otherwise be non-terminating. On its own it does
    # not stop the caller: this is an advanced function, and an error escaping one reaches the
    # caller as statement-terminating, so a caller running with Continue would print it and carry
    # on with the file unprotected. The catch rethrows with `throw`, which stops every caller.
    $ErrorActionPreference = 'Stop'

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Cannot restrict permissions on '$Path': the file does not exist."
    }
    # ProviderPath, not Path. Path keeps PowerShell's own form - 'Drive:\x' for a PowerShell
    # drive, 'Microsoft.PowerShell.Core\FileSystem::\\server\share\x' for a network share - and
    # neither FileInfo nor chmod understands it.
    $full = (Resolve-Path -LiteralPath $Path).ProviderPath

    try {
        if ($IsWindows) {
            # Not Get-Acl/Set-Acl. Set-Acl writes every section of the descriptor; when that
            # fails for want of a privilege it retries without the audit section only if the new
            # descriptor's AreAuditRulesProtected equals the EXISTING file's
            # AreAccessRulesProtected (PowerShell FileSystemSecurity.cs, SetSecurityDescriptor).
            # Once a first call has protected the DACL those differ, so every later call tries to
            # write the SACL and fails with SeSecurityPrivilege - which is what Get-SigningSecret
            # hit on every read. See UNKNOWNS U21.
            #
            # Reading only the Access section and persisting through .NET writes only the
            # sections that changed (FileSystemSecurity.Persist,
            # GetAccessControlSectionsFromChanges), so the owner and audit sections are never
            # touched and no privilege is needed.
            $info = [System.IO.FileInfo]::new($full)
            $acl = [System.IO.FileSystemAclExtensions]::GetAccessControl($info, [System.Security.AccessControl.AccessControlSections]::Access)
            $acl.SetAccessRuleProtection($true, $false)
            $sid = [System.Security.Principal.SecurityIdentifier]
            foreach ($ace in @($acl.GetAccessRules($true, $false, $sid))) { $acl.RemoveAccessRuleSpecific($ace) }
            $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
            $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new(
                $me,
                [System.Security.AccessControl.FileSystemRights]::FullControl,
                [System.Security.AccessControl.AccessControlType]::Allow))
            [System.IO.FileSystemAclExtensions]::SetAccessControl($info, $acl)
            return
        }

        # chmod is on every supported macOS and Linux host. The mode is read back rather than
        # trusting the exit code: a umask, or a filesystem that ignores modes (exFAT, a 9p mount,
        # some SMB and NFS exports), lets chmod return 0 on a file that is still world-readable.
        # Those are also the mounts where stat is most likely to misbehave, so a read-back that
        # cannot be completed is treated as a failure - otherwise both halves of the check fail
        # together and silently.
        & chmod 600 $full
        if ($LASTEXITCODE -ne 0) { throw "chmod 600 failed (exit $LASTEXITCODE)." }

        $mode = & stat @(if ($IsMacOS) { '-f'; '%Lp' } else { '-c'; '%a' }) $full
        if ($LASTEXITCODE -ne 0 -or -not $mode) {
            throw "its permissions could not be read back after chmod (stat exit $LASTEXITCODE)."
        }

        $digits = ([string]$mode).Trim() -replace '\D', ''
        if (-not $digits) { throw "stat returned '$mode', which is not a file mode." }
        # 0x3F is octal 077 - the group and other bits. PowerShell has no 0o literal.
        if ([Convert]::ToInt32($digits, 8) -band 0x3F) {
            throw "it is still readable by group or other (mode $mode)."
        }
    } catch {
        throw "Could not restrict '$full' to its owner: $($_.Exception.Message) It holds the signing secret, so this stops here."
    }
}
