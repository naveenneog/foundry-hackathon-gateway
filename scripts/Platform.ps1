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

    # Every failure in here has to reach the caller. Platform.ps1 is dot-sourced into scripts
    # with their own preference, and a non-terminating error from an ACL call would otherwise
    # print and carry on - leaving the file unprotected behind a function that returned.
    $ErrorActionPreference = 'Stop'

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Cannot restrict permissions on '$Path': the file does not exist."
    }
    $full = (Resolve-Path -LiteralPath $Path).Path

    if ($IsWindows) {
        # Not Get-Acl/Set-Acl. Set-Acl writes every section of the descriptor; when that fails
        # for want of a privilege it retries without the audit section only if the new
        # descriptor's AreAuditRulesProtected equals the EXISTING file's AreAccessRulesProtected
        # (PowerShell FileSystemSecurity.cs, SetSecurityDescriptor). Once a first call has
        # protected the DACL those differ, so every later call tries to write the SACL and
        # fails with SeSecurityPrivilege - which is what Get-SigningSecret hit on every read.
        #
        # Reading only the Access section and persisting through .NET writes only the sections
        # that changed (FileSystemSecurity.Persist, GetAccessControlSectionsFromChanges), so the
        # owner and audit sections are never touched and no privilege is needed.
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
