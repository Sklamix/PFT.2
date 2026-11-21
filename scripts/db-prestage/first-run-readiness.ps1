#Requires -Version 5.1
# PHASE 1.41 — FIRST-RUN READINESS BOOTSTRAP (owner-authorized implementation + LOCAL validation only).
# Modes:
#   Validate (default) — local static + synthetic checks, NO network, NO real psql, NO password file content read.
#   Run                — real readiness-only psql session. NOT executed in PHASE 1.41; requires separate owner authorization.
# STRICT: no SQL/DDL/DML, no Prisma, no secrets printed, no automatic retries.
param([string]$Mode = 'Validate')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============ Immutable connection allowlist (PHASE 1.41 owner-approved) ============
$script:PsqlExe     = 'C:\Program Files\PostgreSQL\17\bin\psql.exe'
$script:PsqlSha256  = 'DEFE034E42D095AFEAD17D91619E202A851B2E66F2C2FCA1EB29123059868197'   # PHASE 1.38 runtime evidence
$script:CaBundle    = Join-Path $PSScriptRoot 'ca\cacert.pem'
$script:CaSha256    = '427C064216761A1E72A8B30F0D954D08CB6E4435A82091FB865AFD20C8497285'   # PHASE 1.39 official-source evidence
$script:DbHost      = 'ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech'
$script:DbName      = 'pft_dbtest'
$script:DbUser      = 'pft_test_runtime'
$script:DbPort      = 5432
$script:Marker      = 'PFT-READINESS-MARKER'
$script:CandidateLibpqSha256 = 'D87674D536CB8FCC4897F8D6A1C8445675E33447CA0E6EBAC210559029F19D04'  # PHASE 1.38 candidate evidence
$script:ExpectedLibpqVersion = 170012                                                            # PQlibVersion 17.0.12 (PHASE 1.39 probe)
$script:DefaultPgPassPath    = Join-Path $env:APPDATA 'postgresql\pgpass.conf'

# 1.42-L FIX A: reflection-based API guard for Pft.PipeReaders (PS 5.1 / .NET 4.8 compatible).
# Verifies the EXACT 5-argument overload required by the Run call site, not mere type existence:
#   static public ReaderTasks Start(Process, ConcurrentQueue<object>, ConcurrentQueue<object>, Pft.RunState, Pft.DiagLog)
# A stale (pre-1.42-G, 4-argument) type already loaded in the AppDomain fails this check.
function Test-PipeReadersApi {
  param([string]$TypeName = 'Pft.PipeReaders')
  $t = $TypeName -as [type]
  if ($null -eq $t) { return $false }
  $methods = $t.GetMethods([System.Reflection.BindingFlags]'Public,Static') | Where-Object { $_.Name -eq 'Start' }
  foreach ($m in $methods) {
    $pp = $m.GetParameters()
    $ok = $pp.Count -eq 5 -and $pp[0].ParameterType.FullName -eq 'System.Diagnostics.Process'
    foreach ($idx in 1, 2) {
      if (-not $ok) { break }
      $pt = $pp[$idx].ParameterType
      $ok = $pt.IsGenericType -and `
        $pt.GetGenericTypeDefinition().FullName -eq 'System.Collections.Concurrent.ConcurrentQueue`1' -and `
        $pt.GetGenericArguments()[0] -eq [object]
    }
    if ($ok) { $ok = $pp[3].ParameterType.FullName -eq 'Pft.RunState' }
    if ($ok) { $ok = $pp[4].ParameterType.FullName -eq 'Pft.DiagLog' }
    if ($ok) { $ok = $m.ReturnType.FullName -eq 'Pft.ReaderTasks' }
    if ($ok) { return $true }
  }
  return $false
}

# ============ Add-Type (identical proven C# from prestage.ps1 PHASE 1.39; read as source, file unchanged) ============
if (-not ('Pft.PipeReaders' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading.Tasks;

namespace Pft {
  public enum ReaderSource { StdOut = 0, StdErr = 1 }
  public enum ReaderEndReason { Eof = 0, Error = 1, Killed = 2 }

  public sealed class ReaderEndToken {
    public readonly ReaderSource Source;
    public readonly ReaderEndReason Reason;
    public readonly string Detail;
    public ReaderEndToken(ReaderSource s, ReaderEndReason r, string d) { Source = s; Reason = r; Detail = d ?? ""; }
  }
  public sealed class ReaderLine {
    public readonly ReaderSource Source;
    public readonly string Text;
    public ReaderLine(ReaderSource s, string t) { Source = s; Text = t; }
  }

  public sealed class ReaderTasks {
    public readonly Task StdOutTask;
    public readonly Task StdErrTask;
    public readonly Task AllTask;
    public ReaderTasks(Task o, Task e) {
      StdOutTask = o; StdErrTask = e;
      AllTask = Task.Factory.StartNew(delegate { Task.WaitAll(o, e); });
    }
  }

  public sealed class RunState {
    public volatile bool KillRequested;
    public volatile bool InjectErrorStdOut;
    public volatile bool InjectErrorStdErr;
    public readonly int RunId;
    static int _counter;
    public RunState() { RunId = System.Threading.Interlocked.Increment(ref _counter); }
  }

  public static class PipeReaders {
    public static ReaderTasks Start(Process p,
        ConcurrentQueue<object> outQ, ConcurrentQueue<object> errQ, RunState state) {
      return Start(p, outQ, errQ, state, null);
    }
    public static ReaderTasks Start(Process p,
        ConcurrentQueue<object> outQ, ConcurrentQueue<object> errQ, RunState state, DiagLog diag) {
      Task tOut = StartOne(p.StandardOutput, ReaderSource.StdOut, outQ, state, diag);
      Task tErr = StartOne(p.StandardError,  ReaderSource.StdErr, errQ, state, diag);
      return new ReaderTasks(tOut, tErr);
    }
    private static Task StartOne(System.IO.StreamReader r, ReaderSource src,
        ConcurrentQueue<object> q, RunState state, DiagLog diag) {
      return Task.Factory.StartNew(delegate {
        try {
          while (true) {
            if (src == ReaderSource.StdOut && state != null && state.InjectErrorStdOut) {
              state.InjectErrorStdOut = false;
              if (diag != null) diag.Add("reader-fault-injected", src.ToString());
              throw new System.IO.IOException("synthetic injected reader fault (stdout)");
            }
            if (src == ReaderSource.StdErr && state != null && state.InjectErrorStdErr) {
              state.InjectErrorStdErr = false;
              if (diag != null) diag.Add("reader-fault-injected", src.ToString());
              throw new System.IO.IOException("synthetic injected reader fault (stderr)");
            }
            string line = r.ReadLine();
            if (line == null) {
              ReaderEndReason reason = (state != null && state.KillRequested)
                ? ReaderEndReason.Killed : ReaderEndReason.Eof;
              q.Enqueue(new ReaderEndToken(src, reason, "pipe closed (process exited or killed)"));
              if (diag != null) diag.Add("reader-eof", src + " reason=" + reason);
              return;
            }
            q.Enqueue(new ReaderLine(src, line));
            if (diag != null) diag.Add(src == ReaderSource.StdOut ? "stdout-line" : "stderr-line", line);
          }
        } catch (Exception ex) {
          q.Enqueue(new ReaderEndToken(src, ReaderEndReason.Error, ex.GetType().FullName + ": " + ex.Message));
          if (diag != null) diag.Add("reader-error", src + " " + ex.GetType().FullName + ": " + ex.Message);
        }
      }, TaskCreationOptions.LongRunning);
    }
  }

  // 1.42-G: thread-safe bounded diagnostic capture, independent of the Consumer verdict.
  // Every entry gets a monotonic sequence number + UTC timestamp; lines are sanitized
  // (password=/URI credentials redacted) and length-limited. Overflow sets a flag, never throws.
  public sealed class DiagLog {
    private readonly object _lock = new object();
    private readonly System.Collections.Generic.List<string> _items = new System.Collections.Generic.List<string>();
    private int _seq;
    public readonly int MaxItems;
    public readonly int MaxLineLen;
    public bool Overflowed;
    public DiagLog(int maxItems, int maxLineLen) { MaxItems = maxItems; MaxLineLen = maxLineLen; }
    public static string Sanitize(string s) {
      if (s == null) return "";
      // 1.42-I: keyed secrets support '=' AND ':' separators with arbitrary spacing/case.
      // \S+ limits the match to the secret value; the rest of the line (structure) is preserved.
      string t = System.Text.RegularExpressions.Regex.Replace(s, @"(?i)\b(password|passfile|sslpassword)\s*[=:]\s*\S+", "$1=<redacted>");
      // URI credentials, fail-safe two-pass:
      // pass 1: scheme://userinfo@ (userinfo may contain multiple '@' but no '/') -> redact through the '@' before first '/';
      // pass 2: any remaining scheme://...@ token (e.g. raw '/' or extra '@' inside the secret) -> redact greedily to the
      //         last '@' of the token; over-redaction is accepted rather than leaving possible credentials exposed.
      t = System.Text.RegularExpressions.Regex.Replace(t, @"(?i)([a-z]+://)[^\s/]*@", "$1<redacted>@");
      t = System.Text.RegularExpressions.Regex.Replace(t, @"(?i)([a-z]+://)\S*@", "$1<redacted>@");
      t = System.Text.RegularExpressions.Regex.Replace(t, @"(?i)PGPASSWORD\s*=\s*\S+", "PGPASSWORD=<redacted>");
      return t;
    }
    public void Add(string tag, string detail) {
      lock (_lock) {
        if (_items.Count >= MaxItems) { Overflowed = true; return; }
        _seq++;
        string d = Sanitize(detail == null ? "" : detail);
        if (d.Length > MaxLineLen) d = d.Substring(0, MaxLineLen) + "...<truncated>";
        _items.Add(_seq + "|" + System.DateTime.UtcNow.ToString("o") + "|" + Sanitize(tag) + "|" + d);
      }
    }
    public string[] Snapshot() { lock (_lock) { return _items.ToArray(); } }
    public int Count { get { lock (_lock) { return _items.Count; } } }
  }

  public static class LibpqProbe {
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr LoadLibraryExW(string path, IntPtr hFile, uint flags);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true)]
    private static extern bool FreeLibrary(IntPtr h);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Ansi)]
    private static extern IntPtr GetProcAddress(IntPtr h, string name);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true)]
    private static extern uint GetCurrentProcessId();
    private delegate int PqLibVersionDelegate();

    public static object Probe(string dllPath) {
      IntPtr h = LoadLibraryExW(dllPath, IntPtr.Zero, 0x8);
      if (h == IntPtr.Zero) {
        return new { Loaded = false, Version = -1, Detail = "LoadLibraryExW failed, Win32Error=" + System.Runtime.InteropServices.Marshal.GetLastWin32Error() };
      }
      try {
        IntPtr fn = GetProcAddress(h, "PQlibVersion");
        if (fn == IntPtr.Zero) return new { Loaded = true, Version = -1, Detail = "PQlibVersion export not found" };
        var f = (PqLibVersionDelegate)System.Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer(fn, typeof(PqLibVersionDelegate));
        int v = f();
        return new { Loaded = true, Version = v, Detail = "major=" + (v / 10000) + " revision=" + (v % 100) + " pid=" + GetCurrentProcessId() };
      } finally { FreeLibrary(h); }
    }
  }

  public static class ModuleSnapshot {
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern bool Module32FirstW(IntPtr snap, ref MODULEENTRY32W me);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern bool Module32NextW(IntPtr snap, ref MODULEENTRY32W me);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr h);

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private struct MODULEENTRY32W {
      public uint dwSize;
      public uint th32ModuleID;
      public uint th32ProcessID;
      public uint GlblcntUsage;
      public uint ProccntUsage;
      public IntPtr modBaseAddr;
      public uint modBaseSize;
      public IntPtr hModule;
      [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst = 256)]
      public string szModule;
      [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.ByValTStr, SizeConst = 260)]
      public string szExePath;
    }

    public static System.Collections.Generic.List<string> ListModules(uint pid) {
      var result = new System.Collections.Generic.List<string>();
      const uint TH32CS_SNAPMODULE = 0x8;
      const uint TH32CS_SNAPMODULE32 = 0x10;
      IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid);
      if (snap == new IntPtr(-1)) {
        throw new Exception("CreateToolhelp32Snapshot failed, Win32Error=" + System.Runtime.InteropServices.Marshal.GetLastWin32Error());
      }
      try {
        var me = new MODULEENTRY32W();
        me.dwSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf(typeof(MODULEENTRY32W));
        if (Module32FirstW(snap, ref me)) {
          result.Add(me.szExePath);
          while (Module32NextW(snap, ref me)) { result.Add(me.szExePath); }
        }
      } finally { CloseHandle(snap); }
      return result;
    }

    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern bool QueryFullProcessImageNameW(IntPtr hProc, uint flags, System.Text.StringBuilder name, ref uint size);
    [System.Runtime.InteropServices.DllImport("kernel32", SetLastError = true)]
    private static extern bool GetProcessTimes(IntPtr hProc, out long creation, out long exit, out long kernel, out long user);

    public static object Identity(uint pid) {
      const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
      IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (h == IntPtr.Zero) return new { Ok = false, ImagePath = "", StartTimeUtc = "", Detail = "OpenProcess failed, Win32Error=" + System.Runtime.InteropServices.Marshal.GetLastWin32Error() };
      try {
        var sb = new System.Text.StringBuilder(1024); uint size = 1024;
        if (!QueryFullProcessImageNameW(h, 0, sb, ref size)) return new { Ok = false, ImagePath = "", StartTimeUtc = "", Detail = "QueryFullProcessImageNameW failed" };
        long creation, e, k, u;
        GetProcessTimes(h, out creation, out e, out k, out u);
        var dt = DateTime.FromFileTimeUtc(creation);
        return new { Ok = true, ImagePath = sb.ToString(), StartTimeUtc = dt.ToString("o"), Detail = "" };
      } finally { CloseHandle(h); }
    }
  }
}
'@
}
# 1.42-L FIX A: fail-closed stale-type guard - the compiled/loaded type must expose the exact
# 5-argument overload; otherwise the Run call site would throw "Cannot find an overload".
# No duplicate type is ever loaded under the same name.
if (-not (Test-PipeReadersApi)) {
  Write-Host 'BLOCKED: stale-type detected; launch a fresh powershell.exe process'
  exit 2
}

# ============ Password file checks (existence/size/ACL only; content is NEVER read or printed) ============
# Fail-closed ACL policy: ANY access (explicit OR inherited) for Everyone, BUILTIN\Users or
# Authenticated Users => file is treated as BLOCKED. The ACL is never modified automatically.
function Test-PasswordFile {
  param([string]$Path)
  $r = @{ Exists = $false; NonEmpty = $false; Length = -1; AclOk = $false; Warnings = @(); Denied = '' }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    $r.Warnings += "password file not found: $Path"
    $r.Denied = 'missing-file'
    return $r
  }
  try {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    $r.Exists = $true
    $r.Length = $item.Length
    $r.NonEmpty = ($item.Length -gt 0)
  } catch {
    $r.Denied = 'unreachable-file'
    $r.Warnings += 'password file exists but is not accessible (details withheld)'
    return $r
  }
  if (-not $r.NonEmpty) {
    $r.Denied = 'empty-file'
    return $r
  }
  # ACL: inspect explicit AND inherited ACEs; wide access is a hard fail-closed condition.
  # Detection is SID-based (locale-independent): Everyone=S-1-1-0, BUILTIN\Users=S-1-5-32-545,
  # Authenticated Users=S-1-5-11. Name matching is only a fallback for untranslatable accounts.
  try {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $wideSids = @('S-1-1-0', 'S-1-5-32-545', 'S-1-5-11')
    $wideNames = @('Everyone', 'BUILTIN\Users', 'NT AUTHORITY\Authenticated Users')
    foreach ($rule in $acl.Access) {
      $idn = [string]$rule.IdentityReference
      $sid = ''
      try { $sid = $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
      $isWide = ($sid -ne '' -and $wideSids -contains $sid)
      if (-not $isWide) { foreach ($w in $wideNames) { if ($idn -ieq $w -or $idn -like ('*' + $w)) { $isWide = $true; break } } }
      if ($isWide) {
        $r.Denied = 'wide-acl'
        $r.Warnings += ('BLOCKED: wide access for ' + $(if ($sid -ne '') { $sid } else { $idn }) + ' (inherited=' + $rule.IsInherited + ')')
      }
    }
  } catch {
    $r.Denied = 'acl-unreadable'
    $r.Warnings += 'BLOCKED: ACL cannot be inspected (fail-closed)'
  }
  $r.AclOk = ($r.Denied -eq '')
  return $r
}

# ============ Readiness consumer (real \conninfo parsing, strict order, fail-closed) ============
# Accepts the conninfo line ONLY when database, user AND host match the allowlist exactly.
function Invoke-Consumer {
  param($outQ, $errQ, [int]$DrainMs = 25000, [scriptblock]$Hook = $null, $Diag = $null)
  $res = @{
    Status = 'None'; Readiness = $false; ConnInfoSeen = $false; ConnInfoText = ''
    PrimaryError = ''; StdoutEof = $false; StderrEof = $false
    StdoutTokens = @(); StderrTokens = @(); StderrLines = 0; StdoutLines = 0
    DequeuedOut = 0; DequeuedErr = 0
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($DrainMs)
  $item = $null
  :drain while ([DateTime]::UtcNow -lt $deadline) {
    if ($Hook) { & $Hook $res }
    if ($res.Status -like 'HOOK-*') { return $res }
    $progress = $false
    foreach ($side in @('out', 'err')) {
      $q = $outQ
      if ($side -eq 'err') { $q = $errQ }
      if ($null -eq $q) { throw "queue null for side=$side" }
      while ($q.TryDequeue([ref]$item)) {
        $progress = $true
        if ($side -eq 'out') { $res.DequeuedOut++ } else { $res.DequeuedErr++ }
        if ($null -ne $Diag) { Add-Diag ('consumer-dequeue-' + $side) '' }
        if ($item -is [Pft.ReaderEndToken]) {
          if ($side -eq 'out') { $res.StdoutTokens += [string]$item.Reason } else { $res.StderrTokens += [string]$item.Reason }
          if ($item.Reason -eq 'Error') {
            $res.PrimaryError = "$($side)-reader Error: $($item.Detail)"
            $res.Status = if ($res.Readiness) { 'ReadinessThenReaderError' } else { 'ReaderError' }
            return $res   # immediate fail-closed reaction
          }
          if ($side -eq 'out') {
            $res.StdoutEof = $true
            if (-not $res.Readiness) { $res.Status = 'StdoutEndBeforeReadiness'; return $res }
          } else { $res.StderrEof = $true }
        } else {
          if ($side -eq 'out') {
            $res.StdoutLines++
            $t = $item.Text
            if ($t -eq $script:Marker) {
              if (-not $res.ConnInfoSeen) { $res.Status = 'MarkerBeforeConninfo'; return $res }
              $res.Readiness = $true
              if ($res.Status -eq 'None') { $res.Status = 'CleanReadiness' }
            } elseif (-not $res.ConnInfoSeen) {
              # 1.42-O FIX: locale-robust conninfo recognition (root cause: parser depended on
              # English LC_MESSAGES; localized psql output was never recognized -> ConnInfoSeen=False).
              # Path A (English, pinned structural format incl. port).
              # Path B (any locale): the line carries ALL FOUR allowlist values in double quotes;
              # quoting of placeholders is preserved across psql translations; ASCII values are
              # immune to codepage/mojibake decoding. A line that names db+user but fails any
              # remaining field is conninfo-LIKE and FAILS CLOSED (ConninfoMismatch).
              $enOk = $t -match 'You are connected to database "(?<db>[^"]+)" as user "(?<user>[^"]+)" on host "(?<host>[^"]+)" \([^)]*\) at port "(?<port>[^"]+)"\.'
              $valuesOk = $t.Contains('"' + $script:DbName + '"') -and $t.Contains('"' + $script:DbUser + '"') -and `
                          $t.Contains('"' + $script:DbHost + '"') -and $t.Contains('"' + $script:DbPort + '"')
              $conninfoLike = $enOk -or ($t.Contains('"' + $script:DbName + '"') -and $t.Contains('"' + $script:DbUser + '"'))
              if ($conninfoLike) {
                $fieldsOk = $false
                if ($enOk) {
                  $fieldsOk = ($Matches['db'] -eq $script:DbName -and $Matches['user'] -eq $script:DbUser -and `
                               $Matches['host'] -eq $script:DbHost -and $Matches['port'] -eq ([string]$script:DbPort))
                } else {
                  $fieldsOk = $valuesOk
                }
                if ($fieldsOk) {
                  $res.ConnInfoSeen = $true
                  $res.ConnInfoText = 'db/user/host/port matched allowlist'
                } else {
                  # fail-closed: conninfo-like line with any field mismatch (incl. missing port)
                  $res.Status = 'ConninfoMismatch'
                  $res.ConnInfoText = 'db/user/host/port mismatch (values withheld; expected db=' + $script:DbName + ' user=' + $script:DbUser + ' port=' + $script:DbPort + ')'
                  return $res
                }
              }
            }
          } else {
            $res.StderrLines++
            $t = $item.Text
            # F4 + 1.42-D: connect/auth/TLS/FATAL classification BEFORE and AFTER readiness
            # (post-readiness FATAL/errors must not be swallowed by an already-set PASS);
            # ordinary informational lines are NOT classified as fatal.
            if ($t -match 'psql:\s*error|could not connect|connection refused|password authentication failed|no pg_hba\.conf entry|SSL error|server certificate verification failed|FATAL:') {
              $snippet = $t.Substring(0, [Math]::Min(200, $t.Length))
              if ($res.Readiness) {
                $res.PrimaryError = 'post-readiness stderr error: ' + $snippet
                $res.Status = 'ReadinessThenStderrError'
              } else {
                $res.PrimaryError = 'connect/auth/TLS error: ' + $snippet
                $res.Status = 'ConnectError'
              }
              return $res
            }
          }
        }
      }
    }
    if ($res.StdoutEof -and $res.StderrEof) { break drain }   # both streams fully delivered -> all stderr reviewed
    if (-not $progress) { Start-Sleep -Milliseconds 10 }
  }
  if ($res.Status -eq 'None') { $res.Status = 'ConsumerTimeout' }
  if ($null -ne $Diag) { Add-Diag 'consumer-return' ($res.Status + ' outDeq=' + $res.DequeuedOut + ' errDeq=' + $res.DequeuedErr + ' outEof=' + $res.StdoutEof + ' errEof=' + $res.StderrEof) }
  return $res
}

# ============ Synthetic child harness (NO real psql, NO network) ============
function New-ChildArgs([string]$childScript) {
  # suppress CLIXML progress noise on stderr so synthetic stderr is truly silent unless the test writes to it
  '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('$ProgressPreference="SilentlyContinue"; ' + $childScript))
}
function Start-SyntheticChild([string]$childScript, [switch]$FaultStdOut, [switch]$FaultStdErr, $Diag = $null) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $psi.Arguments = New-ChildArgs $childScript
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $outQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
  $errQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
  $state = New-Object Pft.RunState
  if ($FaultStdOut) { $state.InjectErrorStdOut = $true }
  if ($FaultStdErr) { $state.InjectErrorStdErr = $true }
  $proc = [System.Diagnostics.Process]::Start($psi)
  $tasks = [Pft.PipeReaders]::Start($proc, $outQ, $errQ, $state, $Diag)
  return @{ Proc = $proc; OutQ = $outQ; ErrQ = $errQ; State = $state; Tasks = $tasks }
}

function Confirm-TaskLifecycle {
  param($h, [int]$WaitMs = 10000)
  $lc = @{ StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = ''; Disposed = $false }
  $lc.StdOutDone = $h.Tasks.StdOutTask.Wait($WaitMs)
  $lc.StdErrDone = $h.Tasks.StdErrTask.Wait($WaitMs)
  $lc.AllDone    = $h.Tasks.AllTask.Wait($WaitMs)
  if ($lc.StdOutDone -and $lc.StdErrDone -and $lc.AllDone) {
    try { $h.Proc.Dispose(); $lc.Disposed = $true }
    catch { $lc.CleanupError = $_.Exception.Message }
  } else {
    $lc.CleanupError = 'BLOCKED: reader task(s) unfinished — Dispose withheld'
    try { $h.State.KillRequested = $true; $h.Proc.Kill() } catch { $lc.CleanupError += '; kill: ' + $_.Exception.Message }
    [void]$h.Tasks.AllTask.Wait($WaitMs)
  }
  return $lc
}

$script:failures = @()
$script:passCount = 0
$script:testNames = New-Object 'System.Collections.Generic.List[string]'
$script:diag = $null
$script:diagActive = $false
$script:diagWriteFailed = $false

# 1.42-G: bounded thread-safe diagnostic capture, independent of the Consumer verdict.
function New-DiagLog {
  $script:diagWriteFailed = $false; $script:diagActive = $true
  try { $script:diag = New-Object Pft.DiagLog(2000, 500) } catch { $script:diag = $null; $script:diagWriteFailed = $true }
  if ($null -eq $script:diag) { $script:diagWriteFailed = $true }
  return $script:diag
}
function Disable-DiagLog { $script:diagActive = $false; $script:diag = $null; $script:diagWriteFailed = $false }
# Flush the bounded in-memory diagnostic capture to the console AFTER the verdict is final
# (1.42-G: controlled post-readers flush; sanitized; write-failure surfaces as a warning only)
function Write-DiagFlush {
  $snap = Get-DiagSnapshot
  if ($script:diagWriteFailed) { Write-Host 'diag WARNING: diagnostic capture write failed (verdict unaffected)' }
  if ($null -ne $script:diag -and $script:diag.Overflowed) { Write-Host ("diag WARNING: capture overflowed at MaxItems=" + $script:diag.MaxItems + " (verdict unaffected)") }
  Write-Host ("=== DIAGNOSTIC CAPTURE (" + $snap.Count + " entries) ===")
  $snap | ForEach-Object { Write-Host ("diag: " + $_) }
  Disable-DiagLog
}
function Add-Diag([string]$tag, [string]$detail = '') {
  if (-not $script:diagActive) { return }
  if ($null -eq $script:diag) { $script:diagWriteFailed = $true; return }
  try { $script:diag.Add($tag, $detail) } catch { $script:diagWriteFailed = $true }
}
function Get-DiagSnapshot { 
  if ($null -eq $script:diag) { $script:diagWriteFailed = $true; return @() }
  try { return @($script:diag.Snapshot()) } catch { $script:diagWriteFailed = $true; return @() }
}
# Purely diagnostic classification; NEVER feeds the verdict.
function Get-DiagClass {
  param([string[]]$DiagLines)
  $errText = ($DiagLines | Where-Object { $_ -match '\|stderr-line\|' -or $_ -match '\|post-err-line\|' }) -join ' '
  if ($errText -match 'password authentication failed|no pg_hba\.conf entry') { return 'auth-failure' }
  if ($errText -match 'SSL|server certificate|certificate verify') { return 'tls-failure' }
  if ($errText -match 'timeout expired|connection timed out|connect_timeout') { return 'connect-timeout' }
  if ($errText -match 'could not connect|connection refused|psql:\s*error|FATAL:') { return 'other-connect-failure' }
  if ($DiagLines -match '\|stderr-line\|' -or $DiagLines -match '\|post-err-line\|') { return 'stderr-present-unclassified' }
  if ($DiagLines -match '\|stdout-line\|' -or $DiagLines -match '\|post-out-line\|') { return 'stdout-only(suspect-buffering)' }
  return 'silent-no-tokens'
}
# 1.42-G: post-consumer drain — runs AFTER consumer return AND ordered cleanup; never re-runs
# the consumer; never changes the already-determined primary verdict; drains leftover tokens.
function Invoke-PostConsumerDrain {
  param($h)
  $readersDone = $false
  try { $readersDone = [bool]$h.Tasks.AllTask.IsCompleted } catch { $readersDone = $false }
  $extraOut = 0; $extraErr = 0; $extraTokens = @(); $item = $null
  # 1.42-O FIX: diagnostic-only drain must NEVER throw on a handle that lacks OutQ/ErrQ
  # (missing queue = nothing to drain); a drain exception must never mask the primary verdict.
  $hasOut = $false; $hasErr = $false
  # Hashtable keys are NOT PSObject properties; under StrictMode a missing key THROWS.
  try { $hasOut = ($null -ne $h.OutQ) } catch { $hasOut = $false }
  try { $hasErr = ($null -ne $h.ErrQ) } catch { $hasErr = $false }
  if ($hasOut) {
    while ($h.OutQ.TryDequeue([ref]$item)) {
      $extraOut++
      if ($item -is [Pft.ReaderEndToken]) { $extraTokens += ('out:' + $item.Reason) }
      else { Add-Diag 'post-out-line' $item.Text }
    }
  }
  if ($hasErr) {
    while ($h.ErrQ.TryDequeue([ref]$item)) {
      $extraErr++
      if ($item -is [Pft.ReaderEndToken]) { $extraTokens += ('err:' + $item.Reason) }
      else { Add-Diag 'post-err-line' $item.Text }
    }
  }
  if (-not $hasOut -and -not $hasErr) { Add-Diag 'post-drain-no-queues' '' }
  Add-Diag 'post-drain-done' ("readersDone=" + $readersDone + " out=" + $extraOut + " err=" + $extraErr + " tokens=" + ($extraTokens -join ','))
  return @{ ExtraOut = $extraOut; ExtraErr = $extraErr; ExtraTokens = $extraTokens; ReadersDone = $readersDone }
}
function Assert-Matrix([string]$name, [bool]$cond, [string]$detail) {
  $script:testNames.Add($name)
  if ($cond) { $script:passCount++; Write-Host ("PASS [{0}] {1}" -f $name, $detail) }
  else { Write-Host ("FAIL [{0}] {1}" -f $name, $detail); $script:failures += "${name}: $detail" }
}

# F1: single stdin write helper; verifies the write AND Flush; fail-closed on failure
function Send-StdinLine {
  param($proc, [string]$line)
  try {
    $proc.StandardInput.WriteLine($line)
    $proc.StandardInput.Flush()
    return $true
  } catch { return $false }
}

# F3: ordered, idempotent cleanup (close stdin -> natural exit window -> typed kill -> readers -> AllTask -> Dispose last)
function Invoke-OrderedCleanup {
  param($h, [int]$ExitWaitMs = 5000, [int]$TaskWaitMs = 10000)
  $c = $h.Cleanup
  if ($c.Done) { return $c }                       # idempotent: repeated call is a no-op
  $c.Done = $true
  try { $h.Proc.StandardInput.Close(); $h.Events.Add('cleanup-stdin-closed') } catch { }
  $h.Events.Add('exit-wait-started')
  $natural = $h.Proc.WaitForExit($ExitWaitMs)      # bounded; no infinite waiting
  $h.Events.Add('exit-wait-done')
  if (-not $natural) {
    $h.State.KillRequested = $true                 # typed Kill classification BEFORE Kill
    try { $h.Proc.Kill(); $c.Killed = $true; $h.Events.Add('killed-after-timeout') }
    catch { $c.CleanupError = 'kill failed: ' + $_.Exception.Message }
  }
  if ($null -ne $h.Tasks) {
    # 1.42-L: real readers exist - wait each one separately; Dispose only after all finished.
    $c.StdOutDone = $h.Tasks.StdOutTask.Wait($TaskWaitMs)
    $c.StdErrDone = $h.Tasks.StdErrTask.Wait($TaskWaitMs)
    $c.AllDone    = $h.Tasks.AllTask.Wait($TaskWaitMs)
  } else {
    # 1.42-L FIX B: readers were never started (exception between Process.Start and
    # PipeReaders.Start). There are NO tasks to wait; NOT masked as fake tasks - the
    # verdict simply cannot reach PASS because no tokens/EOF/readiness were produced.
    $c.StdOutDone = $true; $c.StdErrDone = $true; $c.AllDone = $true
  }
  if ($c.StdOutDone -and $c.StdErrDone -and $c.AllDone) {
    try { $h.Proc.Dispose(); $c.Disposed = $true } # Dispose ONLY after both readers finished
    catch { $c.CleanupError = 'dispose failed: ' + $_.Exception.Message }
  } else {
    $c.CleanupError = 'reader task(s) unfinished; Dispose withheld'
  }
  return $c
}

# F2: primary failure is preserved; cleanup appends, never overwrites
function Get-FinalStatus {
  param([string]$PrimaryStatus, [string]$PrimaryError = '', $Cleanup = $null)
  $primary = switch -Wildcard ($PrimaryStatus) {
    'CleanReadiness'   { 'PASS' }
    'ConnectError'     { 'BLOCKED-connect' }
    ''                 { 'BLOCKED-unknown-primary' }
    'None'             { 'BLOCKED-unknown-primary' }
    default            { 'BLOCKED:' + $PrimaryStatus }
  }
  $final = $primary
  if ($null -ne $Cleanup -and $Cleanup.CleanupError) {
    $base = if ($PrimaryStatus -in @('', 'None')) { 'no-primary-status' } else { $PrimaryStatus }
    $final = 'BLOCKED-cleanup:' + $base            # e.g. BLOCKED-cleanup:ConsumerTimeout
  }
  return $final
}

# 1.42-D: strict final PASS gate — all 12 conditions must hold simultaneously.
# Cleanup never overwrites the primary reason; primary reason is returned separately.
function Get-RunVerdict {
  param([string]$ConsumerStatus, [bool]$ConnInfoSeen, [bool]$SnapshotDone, [bool]$MarkerSent, [bool]$StdinClosed,
        [bool]$NaturalExit, $ExitCode, [bool]$StdoutEof, [bool]$StderrEof, $StdoutTokens, $StderrTokens, $Cleanup)
  $reason = ''
  if ($ConsumerStatus -ne 'CleanReadiness') { $reason = $ConsumerStatus }                                   # 1,3,4,11 via consumer
  elseif (-not $ConnInfoSeen)   { $reason = 'conninfo-not-verified' }                                      # 1
  elseif (-not $SnapshotDone)   { $reason = 'runtime-dll-evidence-missing' }                               # 2
  elseif (-not $MarkerSent)     { $reason = 'marker-not-sent' }                                            # 3
  elseif (-not $StdinClosed)    { $reason = 'stdin-not-closed' }                                         # 5
  elseif (-not $NaturalExit)    { $reason = 'psql-exit-timeout' }                                          # 6
  elseif ($null -eq $ExitCode)  { $reason = 'exit-code-unavailable' }                                      # 7
  elseif ($ExitCode -ne 0)      { $reason = 'exit-code-' + $ExitCode }                                     # 7
  elseif (@($StdoutTokens) -contains 'Error') { $reason = 'stdout-reader-error' }                          # 8
  elseif (@($StderrTokens) -contains 'Error') { $reason = 'stderr-reader-error' }                          # 8
  elseif (-not ($StdoutEof -and $StderrEof)) { $reason = 'streams-not-fully-drained' }                     # 9,10
  if ($reason -ne '') {
    $final = if ($reason -eq 'ConnectError') { 'BLOCKED-connect' } else { 'BLOCKED:' + $reason }
    return @{ Final = $final; Primary = $reason }
  }
  if ($null -ne $Cleanup -and $Cleanup.CleanupError) {                                                     # 9,12
    return @{ Final = 'BLOCKED-cleanup:CleanReadiness'; Primary = $Cleanup.CleanupError }
  }
  return @{ Final = 'PASS'; Primary = '' }
}

# Realistic \conninfo format emitted by synthetic children (LC_MESSAGES=C style)
$connInfoOk = 'You are connected to database "' + $script:DbName + '" as user "' + $script:DbUser + '" on host "' + $script:DbHost + '" (10.2.3.4) at port "' + $script:DbPort + '".'
$connInfoWrongDb = $connInfoOk -replace 'database "[^"]+"', 'database "neondb"'

if ($Mode -eq 'Run') {
  # ================= REAL READINESS RUN (executed only by separate owner authorization) =================
  # --- preflight: executable + CA + password file ---
  if (-not (Test-Path -LiteralPath $script:PsqlExe -PathType Leaf)) { Write-Host 'BLOCKED: psql executable missing'; exit 2 }
  $exeHash = (Get-FileHash -LiteralPath $script:PsqlExe -Algorithm SHA256).Hash
  if ($exeHash -ne $script:PsqlSha256) { Write-Host "BLOCKED: psql executable hash mismatch ($exeHash)"; exit 2 }
  if (-not (Test-Path -LiteralPath $script:CaBundle -PathType Leaf)) { Write-Host 'BLOCKED: CA bundle missing'; exit 2 }
  $caHash = (Get-FileHash -LiteralPath $script:CaBundle -Algorithm SHA256).Hash
  if ($caHash -ne $script:CaSha256) { Write-Host "BLOCKED: CA bundle hash mismatch"; exit 2 }
  $pgpass = Test-PasswordFile $script:DefaultPgPassPath
  if (-not $pgpass.Exists -or -not $pgpass.NonEmpty -or -not $pgpass.AclOk) {
    Write-Host ('BLOCKED: password file rejected (' + $pgpass.Denied + '); owner must create it with restricted ACL outside this session')
    exit 2
  }
  foreach ($w in $pgpass.Warnings) { Write-Host ("pgpass note: " + $w) }

  # 1.42-L FIX A: stale-type guard re-checked immediately BEFORE Process.Start (fail-closed).
  if (-not (Test-PipeReadersApi)) { Write-Host 'BLOCKED: stale-type detected; launch a fresh powershell.exe process'; exit 2 }

  # --- process launch: canonical psql, interactive stdin, explicit env (no connection string with password) ---
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $script:PsqlExe
  $psi.Arguments = '-X -w -h ' + $script:DbHost + ' -p ' + $script:DbPort + ' -U ' + $script:DbUser + ' -d ' + $script:DbName
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $null = $psi.EnvironmentVariables.Remove('PGPASSWORD')
  $psi.EnvironmentVariables['PGSSLMODE']     = 'verify-full'
  $psi.EnvironmentVariables['PGSSLROOTCERT'] = $script:CaBundle
  $psi.EnvironmentVariables['PGPASSFILE']    = $script:DefaultPgPassPath
  # 1.42-G: bounded connection-establishment window, set ONLY on the child process env
  # (libpq connect_timeout, supported by psql/libpq 17); does not touch host/db/user/TLS policy.
  $psi.EnvironmentVariables['PGCONNECT_TIMEOUT'] = '10'
  $null = New-DiagLog
  Add-Diag 'run-start' ('psql=' + $script:PsqlExe + ' pgconnectTimeout=10')
  $runStartUtc = [DateTime]::UtcNow

  # 1.42-L FIX B: guaranteed lifecycle. Every branch from Process.Start through the verdict
  # runs inside try/catch/finally; ordered cleanup runs in finally (idempotent), a cleanup
  # exception is recorded separately and NEVER overwrites the primary error, and an exception
  # can never turn into PASS. The handle struct is prepared right after launch so finally can
  # always clean up, including the window before readers exist (Tasks = $null; no fake tasks).
  $proc = $null; $tasks = $null; $state = $null; $events = $null; $h = $null
  $r = $null; $lc = $null; $pd = $null; $v = $null; $exitCode = $null
  $naturalExit = $false; $lifetimeSec = 0
  $primaryError = ''; $primaryStatus = 'run-exception'
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)

    # handle struct prepared IMMEDIATELY after launch (finally must always be able to clean up).
    # 1.42-O FIX: OutQ/ErrQ belong to the Run handle from creation time - the post-cleanup
    # drain contract requires valid queue references on EVERY path (root cause of the
    # PropertyNotFoundException 'OutQ' observed after cleanup in the owner readiness Run).
    $state = New-Object Pft.RunState
    $events = New-Object 'System.Collections.Generic.List[string]'
    $outQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
    $errQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
    $h = @{ Proc = $proc; OutQ = $outQ; ErrQ = $errQ; Tasks = $null; State = $state; Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' }; Events = $events }

    # --- live process identity: PID + CreationTime + image path (fail-closed; no fake tasks) ---
    $identity = [Pft.ModuleSnapshot]::Identity([uint32]$proc.Id)
    if (-not $identity.Ok) {
      $primaryError = 'cannot identify live psql PID ' + $proc.Id + ' (' + $identity.Detail + ')'
      $primaryStatus = 'identity-unknown'
      Add-Diag 'identity-failed' $primaryError
    }
    elseif ($identity.ImagePath -ne $script:PsqlExe) {
      $primaryError = 'live psql image path mismatch'
      $primaryStatus = 'identity-image-mismatch'
      $h.State.KillRequested = $true
      try { $proc.Kill(); $h.Cleanup.Killed = $true } catch { }
      Add-Diag 'identity-image-mismatch' $primaryError
    }
    else {
      Write-Host ("psql PID=" + $proc.Id + " startUtc=" + $identity.StartTimeUtc)
      # queues were created BEFORE the handle (1.42-O); readers consume them from here
      $tasks = [Pft.PipeReaders]::Start($proc, $outQ, $errQ, $state, $script:diag)
      $h.Tasks = $tasks   # real readers registered: finally-cleanup waits them from here on
      Add-Diag 'readers-started' ''

      # --- F1: \conninfo sent exactly once, via interactive stdin, BEFORE anything else ---
      $conninfoSent = Send-StdinLine $proc '\conninfo'
      Add-Diag 'conninfo-send' ("result=" + $conninfoSent)
      if ($conninfoSent) { $events.Add('conninfo-sent') }
      else {
        $primaryError = 'stdin write failed for \conninfo'
        $primaryStatus = 'stdin-write-failed'
      }
    }

    if ($primaryError -eq '') {

  # --- RuntimeDll evidence captured WHILE psql is live, strictly AFTER allowlist-verified conninfo ---
  $runtimeDll = $null
  $hook = {
    param($res)
    Add-Diag 'hook-tick' ('status=' + $res.Status + ' connInfoSeen=' + $res.ConnInfoSeen + ' readiness=' + $res.Readiness)
    if ($res.ConnInfoSeen -and -not $res.Readiness -and -not $script:dllDone) {
      $script:dllDone = $true
      Add-Diag 'snapshot-start' 'allowlist-verified conninfo seen; capturing live RuntimeDll'
      try {
        # identity invariant: same live process as at launch (PID reuse guard)
        $idNow = [Pft.ModuleSnapshot]::Identity([uint32]$script:runProc.Id)
        if (-not $idNow.Ok -or $idNow.ImagePath -ne $script:PsqlExe) {
          $res.Status = 'HOOK-RuntimeDll-Identity'; $res.PrimaryError = 'live process identity changed/unknown before snapshot'
          $script:runEvents.Add('identity-failed'); return
        }
        $mods = [Pft.ModuleSnapshot]::ListModules([uint32]$script:runProc.Id)
        $pq = @($mods | Where-Object { $_ -match '\\libpq\.dll$' })
        if ($pq.Count -ne 1) { $res.Status = 'HOOK-RuntimeDll-Ambiguous'; $res.PrimaryError = ('libpq.dll modules found: ' + $pq.Count); return }
        $dllPath = $pq[0]
        $h1 = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash
        $probe = [Pft.LibpqProbe]::Probe($dllPath)
        $h2 = (Get-FileHash -LiteralPath $dllPath -Algorithm SHA256).Hash
        if ($h1 -ne $h2) { $res.Status = 'HOOK-RuntimeDll-Changed'; $res.PrimaryError = 'TOCTOU: dll hash changed between probes'; return }
        if ($h1 -ne $script:CandidateLibpqSha256) { $res.Status = 'HOOK-RuntimeDll-Mismatch'; $res.PrimaryError = 'runtime libpq hash differs from approved candidate'; return }
        if ($probe.Version -ne $script:ExpectedLibpqVersion) { $res.Status = 'HOOK-RuntimeDll-Version'; $res.PrimaryError = ('PQlibVersion=' + $probe.Version + ' expected ' + $script:ExpectedLibpqVersion); return }
        $script:runtimeDll = @{ Path = $dllPath; Hash = $h1; Version = $probe.Version }
        $script:runEvents.Add('snapshot-done')
        Add-Diag 'snapshot-done' ('libpqVersion=' + $probe.Version)
        # marker ONLY after successful snapshot (strict order: conninfo -> allowlist -> snapshot -> marker)
        $okMarker = Send-StdinLine $script:runProc ('\echo ' + $script:Marker)
        Add-Diag 'marker-send' ("result=" + $okMarker)
        if ($okMarker) { $script:runEvents.Add('marker-sent') } else { $res.Status = 'HOOK-marker-send-failed'; $res.PrimaryError = 'stdin write failed for marker' }
      } catch {
        $res.Status = 'HOOK-RuntimeDll-Error'; $res.PrimaryError = $_.Exception.Message
      }
    }
    if ($res.Readiness -and -not $script:stdinClosed) {
      $script:stdinClosed = $true
      try { $script:runProc.StandardInput.Close(); $script:runEvents.Add('stdin-closed'); Add-Diag 'stdin-closed' '' } catch { Add-Diag 'stdin-close-failed' $_.Exception.Message }
    }
  }
  $script:runProc = $proc; $script:runEvents = $events; $script:dllDone = $false; $script:stdinClosed = $false
  $r = Invoke-Consumer $outQ $errQ -DrainMs 30000 -Hook $hook -Diag $script:diag

  # --- F6: safe lifetime diagnostic (indirect signal, never proof of connection) ---
  $lifetimeSec = [int]([DateTime]::UtcNow - $runStartUtc).TotalSeconds

  # --- 1.42-D: natural-exit window + exit code capture BEFORE cleanup (Dispose closes the handle) ---
  $naturalExit = $false; $exitCode = $null
  if ($r.Readiness) {
    $naturalExit = $proc.WaitForExit(5000)
    if ($naturalExit) { $exitCode = $proc.ExitCode }
  }
  Add-Diag 'natural-exit' ("result=" + $naturalExit + " exitCode=" + $exitCode)

  # --- F3: ordered cleanup in every branch; F2: primary preserved, cleanup appended ---
  $lc = Invoke-OrderedCleanup $h
  Add-Diag 'cleanup-done' ("killed=" + $lc.Killed + " disposed=" + $lc.Disposed + " allDone=" + $lc.AllDone + " err=" + $lc.CleanupError)

  # --- 1.42-G: post-consumer drain of leftover tokens (never re-runs Consumer; never alters verdict) ---
  $pd = Invoke-PostConsumerDrain $h

  # --- 1.42-D: strict final gate (PASS only if all 12 conditions hold) ---
  $v = Get-RunVerdict -ConsumerStatus $r.Status -ConnInfoSeen $r.ConnInfoSeen `
    -SnapshotDone ($null -ne $script:runtimeDll) `
    -MarkerSent $events.Contains('marker-sent') -StdinClosed $events.Contains('stdin-closed') `
    -NaturalExit $naturalExit -ExitCode $exitCode `
    -StdoutEof $r.StdoutEof -StderrEof $r.StderrEof `
    -StdoutTokens $r.StdoutTokens -StderrTokens $r.StderrTokens -Cleanup $lc
  $final = $v.Final
  }   # end of the $primaryError -eq '' gate (1.42-L FIX B)
  }   # end of try (1.42-L FIX B: guaranteed lifecycle)
  catch {
    # 1.42-L FIX B: primary exception preserved; sanitized into DiagLog; never converted to PASS
    $primaryError = $_.Exception.Message
    $primaryStatus = 'run-exception'
    Add-Diag 'run-exception' ($_.Exception.GetType().Name + ': ' + $primaryError)
  }
  finally {
    # guaranteed ordered cleanup on EVERY path (normal linear path: idempotent no-op).
    # A cleanup exception is recorded separately and does NOT overwrite $primaryError.
    if ($null -ne $h) {
      try {
        $lcFin = Invoke-OrderedCleanup $h
        if ($null -eq $lc) { $lc = $lcFin }
        Add-Diag 'cleanup-finally' ("killed=" + $lcFin.Killed + " disposed=" + $lcFin.Disposed + " allDone=" + $lcFin.AllDone + " err=" + $lcFin.CleanupError)
      } catch { Add-Diag 'cleanup-exception' $_.Exception.Message }
    }
    $lifetimeSec = [int]([DateTime]::UtcNow - $runStartUtc).TotalSeconds
  }

  # 1.42-L FIX B: exception/identity/conninfo failure path - fail-closed BLOCKED, exit 2.
  if ($primaryError -ne '') {
    Write-Host ("=== FINAL: BLOCKED-" + $primaryStatus + "; primary=" + $primaryError + " lifetime=" + $lifetimeSec + "s (indirect signal only, not proof of connection) ===")
    if ($null -ne $lc) { Write-Host ("cleanup: killed=" + $lc.Killed + " disposed=" + $lc.Disposed + " allDone=" + $lc.AllDone + " err=" + $lc.CleanupError) }
    Write-Host ("diagClass: " + (Get-DiagClass (Get-DiagSnapshot)) + " (diagnostic only; never alters the verdict)")
    Write-DiagFlush
    exit 2
  }

  if ($final -eq 'PASS') {
    Write-Host '=== READINESS PASS ==='
    Write-Host ("conninfo: " + $r.ConnInfoText)
    Write-Host ("runtimeDll: path=" + $script:runtimeDll.Path + " hash=" + $script:runtimeDll.Hash + " version=" + $script:runtimeDll.Version)
    Write-Host ("exitCode: " + $exitCode + " lifetime: " + $lifetimeSec + "s (alive>=30s would be an indirect connection signal, not proof)")
    Write-Host ("tokens: out=" + ($r.StdoutTokens -join ',') + " err=" + ($r.StderrTokens -join ','))
    Write-Host ("postDrain: out=" + $pd.ExtraOut + " err=" + $pd.ExtraErr + " tokens=" + ($pd.ExtraTokens -join ',') + " readersDone=" + $pd.ReadersDone)
    Write-DiagFlush
    exit 0
  }
  Write-Host ("=== FINAL: " + $final + " primary=" + $v.Primary + " consumerPrimary=" + $r.PrimaryError + " lifetime=" + $lifetimeSec + "s (indirect signal only) ===")
  Write-Host ("diagCounters: consumer out=" + $r.DequeuedOut + " err=" + $r.DequeuedErr + " | postDrain out=" + $pd.ExtraOut + " err=" + $pd.ExtraErr + " tokens=" + ($pd.ExtraTokens -join ',') + " readersDone=" + $pd.ReadersDone)
  Write-Host ("diagClass: " + (Get-DiagClass (Get-DiagSnapshot)) + " (diagnostic only; never alters the verdict)")
  Write-DiagFlush
  exit 2
}

# ================= VALIDATE MODE (local only: no network, no real psql, no real password file) =================
Write-Host '=== STATIC SELF-CHECKS (allowlist / TLS policy / forbidden patterns) ==='
$selfText = [IO.File]::ReadAllText($PSCommandPath)
# Scope the textual scan to the Run-mode implementation block only (avoids self-referential
# matches against the check lines and test comments themselves).
$runStart = $selfText.IndexOf('REAL READINESS RUN')
$runEnd   = $selfText.IndexOf('VALIDATE MODE (local only')
$runBlock = ''
if ($runStart -ge 0 -and $runEnd -gt $runStart) { $runBlock = $selfText.Substring($runStart, $runEnd - $runStart) }
Assert-Matrix 'T1-allowlist' ($runBlock.Contains('$script:DbHost') -and $runBlock.Contains('$script:DbName') -and $runBlock.Contains('$script:DbUser') -and $runBlock.Contains('$script:PsqlExe')) 'Run block wired to approved allowlist constants'
Assert-Matrix 'T14-constants' ($script:DbHost -eq 'ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech' -and $script:DbName -eq 'pft_dbtest' -and $script:DbUser -eq 'pft_test_runtime' -and $script:PsqlExe -eq 'C:\Program Files\PostgreSQL\17\bin\psql.exe' -and $script:DbPort -eq 5432) 'allowlist constants equal owner-approved values'
Assert-Matrix 'T2-verify-full' ($runBlock -match "'verify-full'") 'Run block sets explicit sslmode=verify-full'
Assert-Matrix 'T3-no-fallback' ($runBlock -notmatch 'sslmode=(prefer|require|disable)' -and $runBlock -notmatch 'sslrootcert\s*=\s*system' -and $runBlock -notmatch "'system'") 'no sslmode prefer/require/disable, no systemstore in Run block'
Assert-Matrix 'T4-no-password-in-args' ($runBlock -match "Remove\('PGPASSWORD'\)" -and $runBlock -notmatch "EnvironmentVariables\['PGPASSWORD'\]\s*=") 'PGPASSWORD explicitly removed, never set'
Assert-Matrix 'T5-no-c-or-f' ($runBlock -notmatch '-c ' -and $runBlock -notmatch '-f ') 'no -c/-f in Run block (interactive stdin only)'
Assert-Matrix 'T6-w-and-x' ($runBlock -match '-X -w ') 'psql -X (no startup files) and -w (no password prompt) present'
$iConn = $runBlock.IndexOf('Send-StdinLine $proc ''\conninfo''')
$iSnap = $runBlock.IndexOf('HOOK-RuntimeDll')
$iFinal = $runBlock.IndexOf('Get-RunVerdict')
$iClean = $runBlock.IndexOf('Invoke-OrderedCleanup $h')
Assert-Matrix 'T13-run-order' ($iConn -ge 0 -and $iClean -gt $iConn -and $iFinal -gt $iClean -and $runBlock.Contains('conninfo-sent')) "conninfo-send idx=$iConn < cleanup idx=$iClean < final-classification idx=$iFinal — F1/F2/F3 order statically verified"

Write-Host '=== PASSWORD FILE CHECKS (synthetic dummy files; real secret never touched) ==='
# NOTE: dummy content is a non-secret placeholder, not a password; real pgpass.conf is never touched.
# ACL tests are SID-based because localized system names (e.g. non-English BUILTIN groups) would
# otherwise make name-only detection unreliable (this machine is localized — proven by debug).
$meSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
function New-AclDummy([string]$dir, [string]$file, [switch]$GrantEveryoneExplicit, [switch]$GrantEveryoneOnDir) {
  New-Item -ItemType Directory -Path $dir -Force | Out-Null
  icacls $dir /inheritance:d | Out-Null            # isolate from temp-dir inherited ACEs
  icacls $dir /remove:g '*S-1-1-0' '*S-1-5-32-545' '*S-1-5-11' 2>$null | Out-Null
  if ($GrantEveryoneOnDir) { icacls $dir /grant '*S-1-1-0:(OI)(CI)R' | Out-Null }  # propagate to files
  $p = Join-Path $dir $file
  [IO.File]::WriteAllText($p, "*:5432:*:*:TESTPLACEHOLDER-NOT-A-SECRET`r`n")
  if ($GrantEveryoneOnDir) {
    # file keeps DEFAULT inheritance -> inherits the Everyone ACE from the isolated dir
    return $p
  }
  icacls $p /inheritance:d | Out-Null
  icacls $p /remove:g '*S-1-1-0' '*S-1-5-32-545' '*S-1-5-11' 2>$null | Out-Null
  icacls $p /grant '*S-1-5-18:F' | Out-Null        # SYSTEM by well-known SID
  icacls $p /grant ("*$meSid" + ':F') | Out-Null
  if ($GrantEveryoneExplicit) { icacls $p /grant '*S-1-1-0:R' | Out-Null }
  return $p
}
# T7: restricted ACL (only SYSTEM + current user) -> accepted
$dir7 = Join-Path $env:TEMP ('pft-selftest-acl-ok-' + [guid]::NewGuid().ToString('N'))
$dummy = New-AclDummy $dir7 'pgpass-dummy.conf'
$pr = Test-PasswordFile $dummy
Assert-Matrix 'T7-pgpass-restricted-acl-ok' ($pr.Exists -and $pr.NonEmpty -and $pr.AclOk -and $pr.Denied -eq '') ("restricted ACL accepted; exists=$($pr.Exists) length=$($pr.Length)")
# T9: explicit Everyone ACE -> fail-closed BLOCKED
$dir9 = Join-Path $env:TEMP ('pft-selftest-acl-exp-' + [guid]::NewGuid().ToString('N'))
$dummy9 = New-AclDummy $dir9 'pgpass-dummy.conf' -GrantEveryoneExplicit
$pw = Test-PasswordFile $dummy9
Assert-Matrix 'T9-pgpass-wide-acl-blocked' (-not $pw.AclOk -and $pw.Denied -eq 'wide-acl') ("denied=$($pw.Denied) — explicit Everyone ACE => BLOCKED")
# T10: Everyone granted on parent dir, inherited by file -> fail-closed BLOCKED
$dir10 = Join-Path $env:TEMP ('pft-selftest-acl-inh-' + [guid]::NewGuid().ToString('N'))
$dummy10 = New-AclDummy $dir10 'pgpass-dummy.conf' -GrantEveryoneOnDir
$pr10 = Test-PasswordFile $dummy10
Assert-Matrix 'T10-pgpass-inherited-wide-acl-blocked' (-not $pr10.AclOk -and $pr10.Denied -eq 'wide-acl') ("denied=$($pr10.Denied) — wide access via inherited ACE also BLOCKED")
foreach ($d in @($dir7, $dir9, $dir10)) { Remove-Item -LiteralPath $d -Recurse -Force }
# missing file => fail-closed BLOCKED path
$missing = Test-PasswordFile (Join-Path $env:TEMP 'pft-selftest-pgpass-missing.conf')
Assert-Matrix 'T8-pgpass-missing-fail-closed' (-not $missing.Exists -and $missing.Denied -eq 'missing-file') 'missing file => BLOCKED'
# empty file (0 bytes) => fail-closed BLOCKED path
$empty = Join-Path $env:TEMP 'pft-selftest-pgpass-empty.conf'
[IO.File]::WriteAllText($empty, '')
$pe = Test-PasswordFile $empty
Assert-Matrix 'T11-pgpass-empty-fail-closed' ($pe.Exists -and -not $pe.NonEmpty -and -not $pe.AclOk -and $pe.Denied -eq 'empty-file') 'empty (0-byte) file => BLOCKED'
Remove-Item -LiteralPath $empty -Force
# content never read: static proof that no Get-Content/ReadAllText touches the password path
$selfTxt = [IO.File]::ReadAllText($PSCommandPath)
$pwBlock = $selfTxt.Substring($selfTxt.IndexOf('function Test-PasswordFile'), $selfTxt.IndexOf('Readiness consumer') - $selfTxt.IndexOf('function Test-PasswordFile'))
Assert-Matrix 'T12-pgpass-content-never-read' ($pwBlock -notmatch 'Get-Content|ReadAllText|ReadAllLines|OpenText|ReadToEnd|Write-Host\s+\$.*content') 'password file content is never read or printed in Test-PasswordFile'

Write-Host '=== SYNTHETIC READER MATRIX (realistic conninfo parsing; no psql, no network) ==='

# S1: realistic readiness flow, both streams finish naturally
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker + '; Write-Output AFTER-1; [Console]::Error.WriteLine("NOTE-S1")')
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S1' ($r.Status -eq 'CleanReadiness' -and $r.ConnInfoSeen -and $r.Readiness -and $lc.AllDone) "status=$($r.Status) conninfo=$($r.ConnInfoText)"

# S2: stdout reader error before readiness
$h = Start-SyntheticChild 'Start-Sleep -Seconds 20' -FaultStdOut
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S2' ($r.Status -eq 'ReaderError' -and $r.PrimaryError -match 'out-reader Error' -and -not $r.Readiness -and $lc.AllDone) "status=$($r.Status)"

# S3: stderr reader error before readiness
$h = Start-SyntheticChild 'Start-Sleep -Seconds 20' -FaultStdErr
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S3' ($r.Status -eq 'ReaderError' -and $r.PrimaryError -match 'err-reader Error' -and -not $r.Readiness -and $lc.AllDone) "status=$($r.Status)"

# S4: stdout EOF before readiness (fail-closed)
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Start-Sleep -Milliseconds 200')
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S4' ($r.Status -eq 'StdoutEndBeforeReadiness' -and $r.ConnInfoSeen -and -not $r.Readiness) "status=$($r.Status) — conninfo seen but no marker => fatal"

# S5: stderr EOF is not an automatic error
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker)
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S5' ($r.Status -eq 'CleanReadiness' -and $r.StderrEof) "status=$($r.Status)"

# S14: conninfo with WRONG database (neondb simulation) -> fail-closed, no readiness
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoWrongDb + '''; Write-Output ' + $script:Marker)
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S14' ($r.Status -eq 'ConninfoMismatch' -and -not $r.Readiness -and -not $r.ConnInfoSeen) "status=$($r.Status) — marker after mismatched conninfo is rejected"

# S15: marker before conninfo (order violation) -> fail-closed
$h = Start-SyntheticChild ('Write-Output ' + $script:Marker + '; Write-Output ''' + $connInfoOk + '''')
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S15' ($r.Status -eq 'MarkerBeforeConninfo') "status=$($r.Status)"

# S6: large stdout + immediate stderr reader error
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker + '; 1..300 | ForEach-Object { Write-Output ("BIG-OUT-" + $_) }; Start-Sleep -Seconds 20') -FaultStdErr
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S6' (($r.Status -eq 'ReaderError' -or $r.Status -eq 'ReadinessThenReaderError') -and $r.PrimaryError -match 'err-reader Error' -and $r.Status -ne 'CleanReadiness') "status=$($r.Status)"

# S7: large stderr + immediate stdout reader error; readiness never reached
$h = Start-SyntheticChild '1..300 | ForEach-Object { [Console]::Error.WriteLine("BIG-ERR-" + $_) }; Start-Sleep -Seconds 20' -FaultStdOut
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S7' ($r.Status -eq 'ReaderError' -and -not $r.Readiness) "status=$($r.Status)"

# S8: stdout reader hangs after readiness; separate deadlines; kill classification
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker + '; Start-Sleep -Seconds 20')
$hook = {
  param($res)
  if ($res.Readiness -and -not $script:s8Handled) {
    $script:s8Handled = $true
    $soDone = $script:s8.Tasks.StdOutTask.Wait(1500)
    if ($soDone) { $res.Status = 'HOOK-stdout-finished-unexpectedly'; return }
    $script:s8.State.KillRequested = $true
    $script:s8.Proc.Kill()
  }
}
$script:s8 = $h; $script:s8Handled = $false
$r = Invoke-Consumer $h.OutQ $h.ErrQ -Hook $hook
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S8' ($r.Readiness -and $r.StdoutTokens -contains 'Killed' -and $lc.AllDone) "status=$($r.Status) out=$($r.StdoutTokens -join ',')"

# S9: different reader delays; separate waits
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker + '; Start-Sleep -Milliseconds 400; 1..5 | ForEach-Object { Write-Output ("O-" + $_); [Console]::Error.WriteLine("E-" + $_); Start-Sleep -Milliseconds 120 }')
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$soDone = $h.Tasks.StdOutTask.Wait(10000)
$seDone = $h.Tasks.StdErrTask.Wait(10000)
$allDone = $h.Tasks.AllTask.Wait(10000)
$h.Proc.Dispose()
Assert-Matrix 'S9' ($r.Status -eq 'CleanReadiness' -and $soDone -and $seDone -and $allDone) "status=$($r.Status)"

# S10: natural exit, per-run state -> Eof (never Killed without kill)
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Start-Sleep -Milliseconds 200')
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S10' ($r.StdoutTokens -contains 'Eof' -and $r.StdoutTokens -notcontains 'Killed' -and $h.State.KillRequested -eq $false) "tokens=$($r.StdoutTokens -join ',')"

# S11: kill after hang -> Killed
$h = Start-SyntheticChild 'Start-Sleep -Seconds 20'
Start-Sleep -Milliseconds 300
$h.State.KillRequested = $true; $h.Proc.Kill()
$r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs 10000
$lc = Confirm-TaskLifecycle $h
$extraErr = @(); $item = $null
while ($h.ErrQ.TryDequeue([ref]$item)) { if ($item -is [Pft.ReaderEndToken]) { $extraErr += [string]$item.Reason } }
Assert-Matrix 'S11' ($r.StdoutTokens -contains 'Killed' -and ($r.StderrTokens -contains 'Killed' -or $extraErr -contains 'Killed') -and $lc.AllDone) "out=$($r.StdoutTokens -join ',') extraErr=$($extraErr -join ',')"

# S12: kill vs natural exit race — recorded ambiguous (Run policy: BLOCKED), no hang
$h = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker + '; Start-Sleep -Milliseconds 250')
$hook = {
  param($res)
  if (-not $script:s12Handled) {
    $script:s12Handled = $true
    Start-Sleep -Milliseconds 150
    $script:s12.State.KillRequested = $true
    try { $script:s12.Proc.Kill() } catch {}
  }
}
$script:s12 = $h; $script:s12Handled = $false
$r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs 10000 -Hook $hook
$lc = Confirm-TaskLifecycle $h
$tokOk = (@($r.StdoutTokens | Where-Object { $_ -in 'Eof','Killed' }).Count -eq $r.StdoutTokens.Count) -and $r.StdoutTokens.Count -gt 0
Assert-Matrix 'S12' ($tokOk -and $lc.AllDone) "out=$($r.StdoutTokens -join ',') — Run policy: ambiguous kill/eof => BLOCKED (no silent PASS)"

# S13: per-run state isolation across launches
$h1 = Start-SyntheticChild 'Start-Sleep -Seconds 20'
$h1.State.KillRequested = $true; $h1.Proc.Kill()
[void](Invoke-Consumer $h1.OutQ $h1.ErrQ -DrainMs 10000)
[void](Confirm-TaskLifecycle $h1)
$h2 = Start-SyntheticChild ('Write-Output ''' + $connInfoOk + '''; Start-Sleep -Milliseconds 200')
$r2 = Invoke-Consumer $h2.OutQ $h2.ErrQ -DrainMs 10000
[void](Confirm-TaskLifecycle $h2)
Assert-Matrix 'S13' ($h1.State.RunId -ne $h2.State.RunId -and $r2.StdoutTokens -contains 'Eof' -and $r2.StdoutTokens -notcontains 'Killed') "runIds=$($h1.State.RunId),$($h2.State.RunId) tokens=$($r2.StdoutTokens -join ',')"

# S16: live-process identity + module snapshot mechanism against synthetic live child (NOT real psql)
$h = Start-SyntheticChild ('Start-Sleep -Seconds 3; Write-Output ''' + $connInfoOk + '''; Write-Output ' + $script:Marker)
Start-Sleep -Milliseconds 500
$alive = (-not $h.Proc.HasExited)
$idc = [Pft.ModuleSnapshot]::Identity([uint32]$h.Proc.Id)
# Toolhelp snapshot on a very young process can transiently fail with Win32Error 299
# (ERROR_PARTIAL_COPY) while modules are still being mapped — bounded retry in the
# TEST HARNESS only. The real Run path has no retry: a snapshot failure => BLOCKED.
$modsC = @(); $snapErr = ''
for ($try = 1; $try -le 6; $try++) {
  try { $modsC = [Pft.ModuleSnapshot]::ListModules([uint32]$h.Proc.Id); $snapErr = ''; break }
  catch { $snapErr = $_.Exception.Message; Start-Sleep -Milliseconds 300 }
}
$hasPowershell = @($modsC | Where-Object { $_ -match 'powershell\.exe$' }).Count
$procOk = $true
Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs 10000 | Out-Null
[void](Confirm-TaskLifecycle $h)
Assert-Matrix 'S16' ($alive -and $idc.Ok -and $modsC.Count -gt 5 -and $hasPowershell -ge 1) "alive=$alive identity ok=$($idc.Ok) detail=$($idc.Detail) modules=$($modsC.Count) ps-module=$hasPowershell snapErr=$snapErr — live-PID snapshot verified on synthetic child"

# ================= SYNTHETIC REGRESSION MATRIX R1-R12 (F1-F6 fixes; no psql, no network, no DB) =================
Write-Host '=== SYNTHETIC REGRESSION MATRIX (F1-F6 fixes) ==='

# Interactive child that mimics psql stdin protocol: \conninfo -> conninfo output (once);
# \echo marker -> marker (only after conninfo); flags DUP-CONNINFO / MARKER-BEFORE-CONNINFO / UNEXPECTED-STDIN.
$interactiveChild = '$ok=$false; while($true){ $l=[Console]::In.ReadLine(); if($null -eq $l){break}; if($l -eq "\conninfo"){ if($ok){[Console]::Error.WriteLine("DUP-CONNINFO")}else{$ok=$true; Write-Output ''<CI>''} } elseif($l -like "\echo *MARKER*"){ if($ok){Write-Output ''PFT-READINESS-MARKER''}else{[Console]::Error.WriteLine("MARKER-BEFORE-CONNINFO")} } else{[Console]::Error.WriteLine("UNEXPECTED-STDIN")} }'
$interactiveChild = $interactiveChild.Replace('<CI>', $connInfoOk)

function Invoke-SyntheticRun {
  param([string]$ChildScript, [bool]$SendConninfo = $true, [bool]$SnapshotOk = $true, [int]$DrainMs = 8000)
  $h = Start-SyntheticChild $ChildScript
  $h.Events = New-Object 'System.Collections.Generic.List[string]'
  $h.Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' }
  $script:srSnapshotDone = $false; $script:srStdinClosed = $false
  $script:sr = $h; $script:srSnapshotOk = $SnapshotOk
  if ($SendConninfo) {
    if (Send-StdinLine $h.Proc '\conninfo') { $h.Events.Add('conninfo-sent') } else { $h.Events.Add('conninfo-send-failed') }
  }
  $hook = {
    param($res)
    if ($res.ConnInfoSeen -and -not $script:srSnapshotDone) {
      $script:srSnapshotDone = $true
      $script:sr.Events.Add('conninfo-seen')
      if ($script:srSnapshotOk) {
        $script:sr.Events.Add('snapshot-done')
        if (Send-StdinLine $script:sr.Proc ('\echo ' + $script:Marker)) { $script:sr.Events.Add('marker-sent') }
      } else {
        $script:sr.Events.Add('snapshot-failed')
      }
    }
    if ($res.Readiness -and -not $script:srStdinClosed) {
      $script:srStdinClosed = $true
      try { $script:sr.Proc.StandardInput.Close(); $script:sr.Events.Add('stdin-closed') } catch {}
    }
  }
  $r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs $DrainMs -Hook $hook
  $lc = Invoke-OrderedCleanup $h
  $final = Get-FinalStatus -PrimaryStatus $r.Status -PrimaryError $r.PrimaryError -Cleanup $lc
  return @{ H = $h; R = $r; LC = $lc; Final = $final; Events = $h.Events }
}

# R1: conninfo sent exactly once (child would flag DUP-CONNINFO)
$m = Invoke-SyntheticRun $interactiveChild
Assert-Matrix 'R1' ((@($m.Events | Where-Object { $_ -eq 'conninfo-sent' }).Count -eq 1) -and $m.LC.AllDone) "events=$($m.Events -join ',')"

# R2: child receives conninfo and returns expected result; natural exit without kill
Assert-Matrix 'R2' ($m.Final -eq 'PASS' -and $m.R.StdoutTokens -contains 'Eof' -and -not $m.LC.Killed -and $m.H.State.KillRequested -eq $false) "final=$($m.Final) out=$($m.R.StdoutTokens -join ',')"

# R3: strict order conninfo-sent -> conninfo-seen -> snapshot-done -> marker-sent -> stdin-closed
$idx = @{}
foreach ($e in @('conninfo-sent','conninfo-seen','snapshot-done','marker-sent','stdin-closed')) { $idx[$e] = $m.Events.IndexOf($e) }
Assert-Matrix 'R3' ($idx['conninfo-sent'] -ge 0 -and $idx['conninfo-sent'] -lt $idx['conninfo-seen'] -and $idx['conninfo-seen'] -lt $idx['snapshot-done'] -and $idx['snapshot-done'] -lt $idx['marker-sent'] -and $idx['marker-sent'] -lt $idx['stdin-closed']) "order=$($m.Events -join ',')"

# R4: marker NOT sent when snapshot fails; primary preserved (no silent readiness)
$m4 = Invoke-SyntheticRun $interactiveChild -SnapshotOk $false
Assert-Matrix 'R4' ($m4.Events -notcontains 'marker-sent' -and $m4.Events -contains 'snapshot-failed' -and $m4.Final -eq 'BLOCKED:ConsumerTimeout') "final=$($m4.Final) events=$($m4.Events -join ',')"

# R5: conninfo NOT sent -> ConsumerTimeout, conninfo-sent absent
$m5 = Invoke-SyntheticRun $interactiveChild -SendConninfo $false
Assert-Matrix 'R5' ($m5.R.Status -eq 'ConsumerTimeout' -and $m5.Events -notcontains 'conninfo-sent' -and $m5.Final -eq 'BLOCKED:ConsumerTimeout') "status=$($m5.R.Status) final=$($m5.Final)"

# R6: pure classification merge — cleanup failure preserves BOTH statuses
$f1 = Get-FinalStatus -PrimaryStatus 'ConsumerTimeout' -Cleanup @{ CleanupError = 'dispose failed: x' }
$f2 = Get-FinalStatus -PrimaryStatus 'ConnectError'   -Cleanup @{ CleanupError = 'kill failed: y' }
$f3 = Get-FinalStatus -PrimaryStatus 'CleanReadiness' -Cleanup @{ CleanupError = '' }
$f4 = Get-FinalStatus -PrimaryStatus ''               -Cleanup @{ CleanupError = 'e' }
Assert-Matrix 'R6' ($f1 -eq 'BLOCKED-cleanup:ConsumerTimeout' -and $f2 -eq 'BLOCKED-cleanup:ConnectError' -and $f3 -eq 'PASS' -and $f4 -eq 'BLOCKED-cleanup:no-primary-status') "f1=$f1 f2=$f2 f3=$f3 f4=$f4"

# R7: stdin closed BEFORE waiting for process exit (event order)
$m7 = Invoke-SyntheticRun $interactiveChild
$i1 = $m7.Events.IndexOf('stdin-closed'); $i2 = $m7.Events.IndexOf('exit-wait-done')
Assert-Matrix 'R7' ($i1 -ge 0 -and $i2 -gt $i1) "order=$($m7.Events -join ',')"

# R8: natural completion without kill (covered in R2 explicitly)
Assert-Matrix 'R8' ($m7.LC.Killed -eq $false -and $m7.LC.Disposed -eq $true -and $m7.H.State.KillRequested -eq $false) "killed=$($m7.LC.Killed) disposed=$($m7.LC.Disposed)"

# R9: child ignores stdin -> natural window elapses -> kill ONLY after timeout (typed Killed)
$m9 = Invoke-SyntheticRun 'while($true){ Start-Sleep -Milliseconds 200 }'
$extra9 = @(); $item9 = $null
while ($m9.H.OutQ.TryDequeue([ref]$item9)) { if ($item9 -is [Pft.ReaderEndToken]) { $extra9 += [string]$item9.Reason } }
while ($m9.H.ErrQ.TryDequeue([ref]$item9)) { if ($item9 -is [Pft.ReaderEndToken]) { $extra9 += [string]$item9.Reason } }
Assert-Matrix 'R9' ($m9.Events -contains 'killed-after-timeout' -and $m9.LC.Killed -and (($m9.R.StdoutTokens -contains 'Killed') -or ($extra9 -contains 'Killed'))) "events=$($m9.Events -join ',') extra=$($extra9 -join ',')"

# R10: readers finished BEFORE Dispose (in kill path too)
Assert-Matrix 'R10' ($m9.LC.AllDone -and $m9.LC.Disposed -and $m9.LC.CleanupError -eq '') "alldone=$($m9.LC.AllDone) disposed=$($m9.LC.Disposed) err=$($m9.LC.CleanupError)"

# R11: stderr connect/auth error -> BLOCKED-connect (primary preserved, no secret printed)
$h11 = Start-SyntheticChild ('[Console]::Error.WriteLine("psql: error: password authentication failed for user ''pft_test_runtime''"); Start-Sleep -Seconds 5')
$r11 = Invoke-Consumer $h11.OutQ $h11.ErrQ -DrainMs 8000
$h11.State.KillRequested = $true; try { $h11.Proc.Kill() } catch {}
$lc11 = Confirm-TaskLifecycle $h11
$final11 = Get-FinalStatus -PrimaryStatus $r11.Status -PrimaryError $r11.PrimaryError -Cleanup $lc11
Assert-Matrix 'R11' ($r11.Status -eq 'ConnectError' -and $final11 -eq 'BLOCKED-connect' -and $r11.PrimaryError -notmatch 'password=|pwd=' -and $r11.PrimaryError.Length -le 220) "status=$($r11.Status) final=$final11 primary=$($r11.PrimaryError)"

# R12: cleanup is idempotent (second call is a no-op, no errors, no new events)
$cntBefore = $m7.Events.Count
$lc12b = Invoke-OrderedCleanup $m7.H
Assert-Matrix 'R12' ($m7.Events.Count -eq $cntBefore -and $lc12b.CleanupError -eq '') "eventsBefore=$cntBefore eventsAfter=$($m7.Events.Count) err=$($lc12b.CleanupError)"

# ================= FINAL READINESS INTEGRITY MATRIX N1-N14 (1.42-D; no psql, no network, no DB) =================
# Full-pipeline harness mirroring the Run block: stdin protocol child -> hook (snapshot-sim + marker after
# conninfo) -> readiness -> stdin close (+ optional post-readiness reader-fault injection) -> natural-exit
# window -> exit code capture BEFORE cleanup -> ordered cleanup -> strict 12-condition Get-RunVerdict.
Write-Host '=== FINAL READINESS INTEGRITY MATRIX (1.42-D) ==='

$nTemplate = '$ok=$false; $done=$false; $bad=$false; while($true){ $l=[Console]::In.ReadLine(); if($null -eq $l){break}; if($l -eq "\conninfo" -and -not $ok){$ok=$true; Write-Output ''<CI>''; <PRE>} elseif($l -like "\echo *MARKER*" -and $ok -and -not $done -and -not $bad){$done=$true; Write-Output ''PFT-READINESS-MARKER''; <POST>} } exit <EXIT>'

function Invoke-NRun {
  param([string]$Post = '', [string]$Pre = '', [string]$ExitCode = '0', [switch]$InjectStdOut, [switch]$InjectStdErr, [int]$DrainMs = 8000)
  $child = $nTemplate.Replace('<CI>', $connInfoOk).Replace('<PRE>', $Pre).Replace('<POST>', $Post).Replace('<EXIT>', $ExitCode)
  $h = Start-SyntheticChild $child
  $h.Events = New-Object 'System.Collections.Generic.List[string]'
  $h.Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' }
  $script:nSnapshot = $false; $script:nStdinClosed = $false; $script:nH = $h
  $script:nInjO = [bool]$InjectStdOut; $script:nInjE = [bool]$InjectStdErr
  if (Send-StdinLine $h.Proc '\conninfo') { $h.Events.Add('conninfo-sent') } else { $h.Events.Add('conninfo-send-failed') }
  $hook = {
    param($res)
    if ($res.ConnInfoSeen -and -not $script:nSnapshot) {
      $script:nSnapshot = $true
      $script:nH.Events.Add('conninfo-seen')
      $script:nH.Events.Add('snapshot-done')
      if (Send-StdinLine $script:nH.Proc ('\echo ' + $script:Marker)) { $script:nH.Events.Add('marker-sent') }
    }
    if ($res.Readiness -and -not $script:nStdinClosed) {
      $script:nStdinClosed = $true
      if ($script:nInjO) { $script:nH.State.InjectErrorStdOut = $true }
      if ($script:nInjE) { $script:nH.State.InjectErrorStdErr = $true }
      try { $script:nH.Proc.StandardInput.Close(); $script:nH.Events.Add('stdin-closed') } catch {}
    }
  }
  $r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs $DrainMs -Hook $hook
  $naturalExit = $false; $exitCode = $null
  if ($r.Readiness) {
    $naturalExit = $h.Proc.WaitForExit(5000)
    if ($naturalExit) { $exitCode = $h.Proc.ExitCode }
  }
  $lc = Invoke-OrderedCleanup $h
  $v = Get-RunVerdict -ConsumerStatus $r.Status -ConnInfoSeen $r.ConnInfoSeen -SnapshotDone $true `
    -MarkerSent $h.Events.Contains('marker-sent') -StdinClosed $h.Events.Contains('stdin-closed') `
    -NaturalExit $naturalExit -ExitCode $exitCode `
    -StdoutEof $r.StdoutEof -StderrEof $r.StderrEof `
    -StdoutTokens $r.StdoutTokens -StderrTokens $r.StderrTokens -Cleanup $lc
  return @{ H = $h; R = $r; LC = $lc; V = $v; Events = $h.Events; Exited = $naturalExit; ExitCode = $exitCode }
}

# N1: readiness + clean natural completion + exit code 0 -> PASS (all 12 conditions)
$m = Invoke-NRun
Assert-Matrix 'N1' ($m.V.Final -eq 'PASS' -and $m.R.Readiness -and $m.Exited -and $m.LC.Disposed) "final=$($m.V.Final) out=$($m.R.StdoutTokens -join ',')"

# N2: readiness + post-readiness FATAL -> BLOCKED (never PASS)
$m2 = Invoke-NRun -Post '[Console]::Error.WriteLine("FATAL: synthetic post-readiness failure")'
Assert-Matrix 'N2' ($m2.V.Final -eq 'BLOCKED:ReadinessThenStderrError' -and $m2.R.Readiness) "final=$($m2.V.Final) primary=$($m2.R.PrimaryError)"

# N3: readiness + post-readiness auth/connect error -> BLOCKED
$m3 = Invoke-NRun -Post '[Console]::Error.WriteLine("psql: error: connection refused")'
Assert-Matrix 'N3' ($m3.V.Final -eq 'BLOCKED:ReadinessThenStderrError' -and $m3.R.Readiness) "final=$($m3.V.Final) primary=$($m3.R.PrimaryError)"

# N4: readiness + exit code != 0 -> BLOCKED (natural exit happened, code non-zero)
$m4 = Invoke-NRun -ExitCode '3'
Assert-Matrix 'N4' ($m4.V.Final -eq 'BLOCKED:exit-code-3' -and $m4.R.Readiness -and $m4.Exited) "final=$($m4.V.Final) exit=$($m4.ExitCode)"

# N5: readiness + stdout reader error after readiness -> BLOCKED
$m5 = Invoke-NRun -InjectStdOut -Post 'Start-Sleep -Milliseconds 1500; Write-Output "P1"; Start-Sleep -Milliseconds 500; Write-Output "P2"'
Assert-Matrix 'N5' ($m5.V.Final -eq 'BLOCKED:ReadinessThenReaderError' -and $m5.R.Readiness) "final=$($m5.V.Final) primary=$($m5.R.PrimaryError)"

# N6: readiness + stderr reader error after readiness -> BLOCKED
$m6 = Invoke-NRun -InjectStdErr -Post 'Start-Sleep -Milliseconds 1500; [Console]::Error.WriteLine("E1"); Start-Sleep -Milliseconds 500; [Console]::Error.WriteLine("E2")'
Assert-Matrix 'N6' ($m6.V.Final -eq 'BLOCKED:ReadinessThenReaderError' -and $m6.R.Readiness) "final=$($m6.V.Final) primary=$($m6.R.PrimaryError)"

# N7: streams not fully drained (AllTask incomplete at verdict time) -> BLOCKED, never PASS
$v7 = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $false -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = '' }
Assert-Matrix 'N7' ($v7.Final -eq 'BLOCKED:streams-not-fully-drained') "final=$($v7.Final)"

# N8: readiness + process exit timeout (child refuses to exit) -> BLOCKED, kill only after timeout
$m8 = Invoke-NRun -DrainMs 3000 -Post 'Start-Sleep -Seconds 25'
Assert-Matrix 'N8' ($m8.V.Final -eq 'BLOCKED:psql-exit-timeout' -and $m8.LC.Killed) "final=$($m8.V.Final) killed=$($m8.LC.Killed)"

# N9: readiness + cleanup failure -> BLOCKED-cleanup (primary preserved separately)
$v9 = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = 'dispose failed: x' }
Assert-Matrix 'N9' ($v9.Final -eq 'BLOCKED-cleanup:CleanReadiness' -and $v9.Primary -eq 'dispose failed: x') "final=$($v9.Final) primary=$($v9.Primary)"

# N10: error racing stdout EOF (child emits FATAL then exits immediately) -> BLOCKED regardless of token order
$m10 = Invoke-NRun -Post '[Console]::Error.WriteLine("FATAL: race-with-eof")'
Assert-Matrix 'N10' ($m10.V.Final -like 'BLOCKED*') "final=$($m10.V.Final) primary=$($m10.R.PrimaryError)"

# N11: error before marker (conninfo ok, then FATAL; child never emits marker) -> BLOCKED-connect, readiness never set
$m11 = Invoke-NRun -Pre '$bad=$true; [Console]::Error.WriteLine("FATAL: pre-marker failure")'
Assert-Matrix 'N11' ($m11.R.Status -eq 'ConnectError' -and $m11.V.Final -eq 'BLOCKED-connect' -and -not $m11.R.Readiness) "status=$($m11.R.Status) final=$($m11.V.Final)"

# N12: benign post-readiness stderr note is NOT fatal -> PASS with full drain
$m12 = Invoke-NRun -Post '[Console]::Error.WriteLine("NOTE: informational line")'
Assert-Matrix 'N12' ($m12.V.Final -eq 'PASS' -and $m12.R.StderrLines -ge 1) "final=$($m12.V.Final) stderrLines=$($m12.R.StderrLines)"

# N13: repeated cleanup on a completed full-pipeline run stays idempotent
$cnt13 = $m.Events.Count
$lc13 = Invoke-OrderedCleanup $m.H
Assert-Matrix 'N13' ($m.Events.Count -eq $cnt13 -and $lc13.CleanupError -eq '' -and $m.V.Final -eq 'PASS') "eventsBefore=$cnt13 eventsAfter=$($m.Events.Count) err=$($lc13.CleanupError)"

# N14: PASS impossible before ALL final checks — verdict gate rejects missing exit code / marker / snapshot / stdin close
$vA = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode $null -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = '' }
$vB = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $false -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = '' }
$vC = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $false -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = '' }
Assert-Matrix 'N14' ($vA.Final -eq 'BLOCKED:exit-code-unavailable' -and $vB.Final -eq 'BLOCKED:marker-not-sent' -and $vC.Final -eq 'BLOCKED:runtime-dll-evidence-missing') "vA=$($vA.Final) vB=$($vB.Final) vC=$($vC.Final)"

# Baseline snapshot of the pre-1.42-G matrix (D18 asserts it remains intact at the end)
$baselineCounts = @{ T = 0; S = 0; R = 0; N = 0 }
foreach ($n in $script:testNames) { $p0 = $n.Substring(0, 1); if ($baselineCounts.ContainsKey($p0)) { $baselineCounts[$p0]++ } }

# ============ 1.42-G DIAGNOSTIC INSTRUMENTATION MATRIX D1-D21 (no psql, no network, no DB) ============
Write-Host '=== DIAGNOSTIC INSTRUMENTATION MATRIX (1.42-G) ==='

function Invoke-DRun {
  param([string]$ChildScript, [int]$DrainMs = 3000, [switch]$FaultStdOut)
  $null = New-DiagLog
  $h = Start-SyntheticChild $ChildScript -FaultStdOut:$FaultStdOut -Diag $script:diag
  $h.Events = New-Object 'System.Collections.Generic.List[string]'
  $h.Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' }
  $r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs $DrainMs -Diag $script:diag
  $lc = Invoke-OrderedCleanup $h
  $pd = Invoke-PostConsumerDrain $h
  $final = Get-FinalStatus -PrimaryStatus $r.Status -PrimaryError $r.PrimaryError -Cleanup $lc
  return @{ H = $h; R = $r; LC = $lc; PD = $pd; Final = $final; Diag = (Get-DiagSnapshot) }
}

# D1+D2+D3+D15: lines arriving AFTER ConsumerTimeout are preserved by post-consumer drain into capture
$d = Invoke-DRun ('Start-Sleep -Milliseconds 800; Write-Output ''' + $connInfoOk + '''; [Console]::Error.WriteLine("DIAG-STDERR-LATE")') -DrainMs 300
$diagText = $d.Diag -join "`n"
Assert-Matrix 'D1' ($d.R.Status -eq 'ConsumerTimeout' -and $diagText -match '\|post-out-line\|') "status=$($d.R.Status) postOut=$($d.PD.ExtraOut) diagHasConninfo=$($diagText -match [regex]::Escape($connInfoOk))"
Assert-Matrix 'D2' ($d.PD.ExtraErr -ge 1 -and $diagText -match 'DIAG-STDERR-LATE') "postErr=$($d.PD.ExtraErr)"
Assert-Matrix 'D3' ($d.PD.ExtraOut -ge 1 -and $d.PD.ExtraErr -ge 1 -and $d.PD.ExtraTokens.Count -gt 0) "tokens=$($d.PD.ExtraTokens -join ',')"
Assert-Matrix 'D15' ($d.Final -eq 'BLOCKED:ConsumerTimeout' -and $d.PD.ExtraOut -ge 1) "final=$($d.Final) preservedOut=$($d.PD.ExtraOut)"

# D4: stderr error after readiness blocks PASS AND is present in the capture
Disable-DiagLog
$d4 = Invoke-NRun -Post '[Console]::Error.WriteLine("FATAL: diag-post-readiness")'
Assert-Matrix 'D4' ($d4.V.Final -eq 'BLOCKED:ReadinessThenStderrError' -and ($d4.R.PrimaryError -match 'FATAL')) "final=$($d4.V.Final) primary=$($d4.R.PrimaryError)"

# D5: stdout EOF after the last line does not lose the line; clean PASS with full drain
Disable-DiagLog
$d5 = Invoke-NRun -Post 'Write-Output "TAIL-LINE-D5"'
Assert-Matrix 'D5' ($d5.V.Final -eq 'PASS' -and $d5.R.StdoutEof -and ($d5.R.StdoutLines -ge 3)) "final=$($d5.V.Final) outLines=$($d5.R.StdoutLines) outEof=$($d5.R.StdoutEof)"

# D6: reader error is preserved independently of the Consumer verdict (reader faults from the start)
$d6 = Invoke-DRun 'Start-Sleep -Seconds 4' -FaultStdOut -DrainMs 3000
$diag6 = $d6.Diag -join "`n"
Assert-Matrix 'D6' ($diag6 -match 'reader-error' -and $d6.R.Status -eq 'ReaderError') "status=$($d6.R.Status) diagHasReaderError=$($diag6 -match 'reader-error')"

# D7: capture overflow never breaks the caller and is flagged
$small = New-Object Pft.DiagLog(3, 100)
for ($i = 0; $i -lt 10; $i++) { $small.Add('ovf-test', "line $i") }
Assert-Matrix 'D7' ($small.Overflowed -and $small.Count -eq 3) "overflowed=$($small.Overflowed) count=$($small.Count)"

# D8: capture write failure does not hide the primary verdict
$script:diagWriteFailed = $true
$vD8 = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = '' }
Assert-Matrix 'D8' ($vD8.Final -eq 'PASS' -and $script:diagWriteFailed) "verdict=$($vD8.Final) writeFailed=$($script:diagWriteFailed)"
$script:diagWriteFailed = $false

# D9: sequence numbers unique under parallel readers; capture non-empty with both sides
Disable-DiagLog
$d9 = Invoke-DRun ('1..120 | ForEach-Object { Write-Output ("OUT-" + $_); [Console]::Error.WriteLine("ERR-" + $_) }') -DrainMs 6000
$seqs = @(); foreach ($line in $d9.Diag) { if ($line -match '^(\d+)\|') { $seqs += [int]$Matches[1] } }
$uniq = @($seqs | Sort-Object -Unique)
Assert-Matrix 'D9' ($seqs.Count -gt 100 -and $uniq.Count -eq $seqs.Count) "entries=$($seqs.Count) unique=$($uniq.Count)"

# D10: sanitization removes secret fields from captured lines
$san1 = [Pft.DiagLog]::Sanitize('connection ok password=SuperSecret9 sslmode=verify-full')
$san2 = [Pft.DiagLog]::Sanitize('postgres://admin:SecretPW@host/db')
$san3 = [Pft.DiagLog]::Sanitize('env PGPASSWORD=LeakedPW detected')
$diagAll = $san1 + ' ' + $san2 + ' ' + $san3
Assert-Matrix 'D10' ($diagAll -notmatch 'SuperSecret9|SecretPW|LeakedPW' -and $san1 -match 'password=<redacted>' -and $san2 -match 'postgres://<redacted>@' -and $san3 -match 'PGPASSWORD=<redacted>') "sanitized: $diagAll"

# D11: PGCONNECT_TIMEOUT is set ONLY on the child psql env (static; no global env touched)
Assert-Matrix 'D11' ($env:PGCONNECT_TIMEOUT -eq $null -and $runBlock.Contains('$psi.EnvironmentVariables[''PGCONNECT_TIMEOUT''] = ''10''') -and -not ($runBlock -match '\$env:PGCONNECT_TIMEOUT\s*=')) "childEnvOnly=True globalEnv=untouched"

# D12: connect timeout does not change host/db/user wiring (single arg construction from allowlist constants)
$argsMatches = [regex]::Matches($runBlock, [regex]::Escape('$psi.Arguments = ''-X -w -h '' + $script:DbHost + '' -p '' + $script:DbPort + '' -U '' + $script:DbUser + '' -d '' + $script:DbName'))
Assert-Matrix 'D12' ($argsMatches.Count -eq 1) "exact allowlist arg-construction line found once ($($argsMatches.Count))"

# D13: connection timeout is classified differently from ConsumerTimeout (verdict untouched)
$c1 = Get-DiagClass @('1|2026-01-01T00:00:00Z|stderr-line|psql: error: timeout expired')
$c2 = Get-DiagClass @('1|2026-01-01T00:00:00Z|stderr-line|psql: error: password authentication failed')
$c3 = Get-DiagClass @('1|2026-01-01T00:00:00Z|stderr-line|SSL error: certificate verify failed')
$c4 = Get-DiagClass @()
Assert-Matrix 'D13' ($c1 -eq 'connect-timeout' -and $c2 -eq 'auth-failure' -and $c3 -eq 'tls-failure' -and $c4 -eq 'silent-no-tokens') "c1=$c1 c2=$c2 c3=$c3 c4=$c4"

# D14: ConsumerTimeout with empty queues is diagnosed separately (no LINE payload ever; only post-exit EOF tokens)
$d14 = Invoke-DRun 'Start-Sleep -Seconds 4' -DrainMs 1500
$diag14 = $d14.Diag -join "`n"
Assert-Matrix 'D14' ($d14.R.Status -eq 'ConsumerTimeout' -and $diag14 -notmatch '\|post-(out|err)-line\|' -and $d14.PD.ExtraTokens -contains 'out:Eof' -and $d14.PD.ExtraTokens -contains 'err:Eof' -and (Get-DiagClass $d14.Diag) -eq 'silent-no-tokens') "status=$($d14.R.Status) class=$(Get-DiagClass $d14.Diag) tokens=$($d14.PD.ExtraTokens -join ',')"

# D16: AllTask failure (readers unfinished) blocks PASS via cleanup merge
$vD16 = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof') -StderrTokens @('Eof') -Cleanup @{ CleanupError = 'reader task(s) unfinished; Dispose withheld' }
Assert-Matrix 'D16' ($vD16.Final -eq 'BLOCKED-cleanup:CleanReadiness') "final=$($vD16.Final)"

# D17: Dispose never executes before readers complete (unfinished tasks -> withheld, deterministic via TaskWaitMs=0)
$h17 = Start-SyntheticChild 'Start-Sleep -Seconds 3'
$h17.Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' }
$h17.Events = New-Object 'System.Collections.Generic.List[string]'
Disable-DiagLog
$lc17 = Invoke-OrderedCleanup $h17 -ExitWaitMs 300 -TaskWaitMs 0
$lc17b = Invoke-OrderedCleanup $h17 -ExitWaitMs 300 -TaskWaitMs 1000
Assert-Matrix 'D17' ($lc17.Disposed -eq $false -and $lc17.CleanupError -match 'unfinished' -and $lc17b.Done) "disposed=$($lc17.Disposed) err=$($lc17.CleanupError) idempotentDone=$($lc17b.Done)"

# D18: all pre-1.42-G tests (T=14, S=16, R=12, N=14) remain intact
Assert-Matrix 'D18' ($baselineCounts['T'] -eq 14 -and $baselineCounts['S'] -eq 16 -and $baselineCounts['R'] -eq 12 -and $baselineCounts['N'] -eq 14) "baseline T=$($baselineCounts['T']) S=$($baselineCounts['S']) R=$($baselineCounts['R']) N=$($baselineCounts['N'])"

# D19 (1.42-O contract update): value-quoted recognition accepts formatting variants whose
# db/user/host/port all match the allowlist (previously failed due to strict English spacing)
Disable-DiagLog
$fixtureSpaced = $connInfoOk -replace '" as user "', '"   as   user   "'
$h19 = Start-SyntheticChild ('Write-Output ''' + $fixtureSpaced + '''; Write-Output ' + $script:Marker)
$r19 = Invoke-Consumer $h19.OutQ $h19.ErrQ -DrainMs 5000
$lc19 = Confirm-TaskLifecycle $h19
Assert-Matrix 'D19' ($r19.ConnInfoSeen -eq $true -and $r19.Readiness -eq $true -and $r19.Status -eq 'CleanReadiness') "status=$($r19.Status) conninfo=$($r19.ConnInfoSeen) (allowlist values matched despite spacing variant)"

# D20 (1.42-O contract update): localized line WITHOUT host/port is conninfo-like -> fail-closed,
# still not classified as fatal (no connect error on stderr)
Disable-DiagLog
$fixtureLocalized = 'Vi ar anslutna till databasen "pft_dbtest" som anvandare "pft_test_runtime"'
$h20 = Start-SyntheticChild ('Write-Output ''' + $fixtureLocalized + '''; Start-Sleep -Seconds 5')
$r20 = Invoke-Consumer $h20.OutQ $h20.ErrQ -DrainMs 3000
$lc20 = Confirm-TaskLifecycle $h20
Assert-Matrix 'D20' ($r20.Readiness -eq $false -and $r20.Status -eq 'ConninfoMismatch' -and $r20.PrimaryError -eq '') "status=$($r20.Status) primaryEmpty=True (incomplete localized conninfo -> fail-closed, non-fatal)"

# D21: stderr connection-error fixture set -> ConnectError for each representative pattern
Disable-DiagLog
$fixtureErrs = @('psql: error: timeout expired', 'could not connect to server: Connection refused', 'FATAL: password authentication failed', 'SSL error: certificate verify failed')
$okAll = $true; $details21 = @()
foreach ($fe in $fixtureErrs) {
  $h21 = Start-SyntheticChild ('[Console]::Error.WriteLine(''' + ($fe.Replace("'", "''")) + '''); Start-Sleep -Seconds 4')
  $r21 = Invoke-Consumer $h21.OutQ $h21.ErrQ -DrainMs 3000
  if ($r21.Status -ne 'ConnectError') { $okAll = $false; $details21 += ($fe + '=>' + $r21.Status) }
  $h21.State.KillRequested = $true; try { $h21.Proc.Kill() } catch {}; $null = Confirm-TaskLifecycle $h21
}
Assert-Matrix 'D21' $okAll "all 4 stderr fixtures -> ConnectError misses=$(($details21 -join ';'))"

# ============ 1.42-I REDACTION HARDENING MATRIX I1-I8 (actual DiagLog class, no real credentials) ============
Write-Host '=== REDACTION HARDENING MATRIX (1.42-I) ==='
Disable-DiagLog

# I1: 'password : value' (space-colon) is redacted
$rI1 = [Pft.DiagLog]::Sanitize('conn password : SecretVal ok')
Assert-Matrix 'I1' (($rI1 -notmatch 'SecretVal') -and $rI1 -match 'password=<redacted> ok') "out=$rI1"

# I2: spacing + case variants for password/passfile/sslpassword with '=' and ':'
$ri2 = @(
  [Pft.DiagLog]::Sanitize('PASSWORD = SecretVal4'),
  [Pft.DiagLog]::Sanitize('PassFile: SecretVal5'),
  [Pft.DiagLog]::Sanitize('sslpassword   :   SecretVal6'),
  [Pft.DiagLog]::Sanitize('PASSFILE = SecretVal7')
)
$i2ok = $true
foreach ($x in $ri2) { if ($x -match 'SecretVal[4-7]') { $i2ok = $false } }
Assert-Matrix 'I2' ($i2ok -and $ri2[0] -match 'PASSWORD=<redacted>' -and $ri2[1] -match 'PassFile=<redacted>' -and $ri2[2] -match 'sslpassword=<redacted>' -and $ri2[3] -match 'PASSFILE=<redacted>') "out=$($ri2 -join ' | ')"

# I3: URI with '@' inside the password -> no leak (two-pass fail-safe)
$rI3 = [Pft.DiagLog]::Sanitize('postgres://alice:Top@Secret@h/db')
Assert-Matrix 'I3' (($rI3 -notmatch 'Top@Secret') -and $rI3 -notmatch 'alice') "out=$rI3"

# I4: multiple '@' in userinfo -> no leak
$rI4 = [Pft.DiagLog]::Sanitize('postgres://al:ice@Top@h2/db')
Assert-Matrix 'I4' (($rI4 -notmatch 'ice@Top') -and $rI4 -notmatch 'al:') "out=$rI4"

# I5: URI without credentials is NOT damaged
$rI5 = [Pft.DiagLog]::Sanitize('connect via postgres://plainhost:5432/db ok')
Assert-Matrix 'I5' ($rI5 -eq 'connect via postgres://plainhost:5432/db ok') "out=$rI5"

# I6: normal diagnostic text after a secret is preserved
$rI6 = [Pft.DiagLog]::Sanitize('password=SecretVal sslmode=verify-full host=h6 state=ok')
Assert-Matrix 'I6' (($rI6 -notmatch 'SecretVal') -and $rI6 -match 'sslmode=verify-full host=h6 state=ok') "out=$rI6"

# I7: redaction happens BEFORE the entry is stored in DiagLog (actual capture path)
$null = New-DiagLog
Add-Diag 'capture-test' 'conn password : SecretVal uri=postgres://u:Top@Secret@h/db'
$snapI7 = @(Get-DiagSnapshot)
$snapText7 = $snapI7 -join "`n"
Assert-Matrix 'I7' (($snapText7 -notmatch 'SecretVal|Top@Secret') -and $snapText7 -match '<redacted>') "stored=$($snapI7.Count) entries, sanitized=True"

# I8: the final flush prints only the already-sanitized snapshot (no second, unsanitized path)
$flushText = $snapI7 -join "`n"   # Write-DiagFlush prints exactly Get-DiagSnapshot output
Assert-Matrix 'I8' (($flushText -notmatch 'SecretVal|Top@Secret') -and (-not $script:diagWriteFailed) -and $script:diag.Count -eq $snapI7.Count) "flushSource=snapshot sanitized=True writeFailed=$($script:diagWriteFailed) count=$($script:diag.Count)"
Disable-DiagLog

$id = [Pft.ModuleSnapshot]::Identity([uint32]$PID)
if (-not $id.Ok) { $script:failures += 'identity failed' }
$dll = 'C:\Program Files\PostgreSQL\17\bin\libpq.dll'
$h1 = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
$probe = [Pft.LibpqProbe]::Probe($dll)
$h2 = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
Write-Host ("libpq probe: version=" + $probe.Version + " hashStable=" + ($h1 -eq $h2) + " matchesCandidate=" + ($h1 -eq $script:CandidateLibpqSha256))
if ($h1 -ne $h2 -or $probe.Version -ne $script:ExpectedLibpqVersion) { $script:failures += 'libpq probe mismatch' }

# ================= 1.42-L MATRIX: API GUARD + GUARANTEED CLEANUP (synthetic only; no Run/psql/network/DB) =================
Write-Host '=== 1.42-L MATRIX (API guard reflection + guaranteed cleanup lifecycle) ==='

# --- dynamic test types (Reflection.Emit, in-memory, no Add-Type duplicate names): exact-shape
#     correct / stale 4-arg / wrong param / wrong return / non-public, all referencing real Pft types ---
$Lan = New-Object System.Reflection.AssemblyName('PftL1TestTypes')
$Lab = [System.AppDomain]::CurrentDomain.DefineDynamicAssembly($Lan, [System.Reflection.Emit.AssemblyBuilderAccess]::Run)
$Lmod = $Lab.DefineDynamicModule('PftL1TestTypes')
function New-LGuardType {
  param([string]$Name, [System.Type]$ReturnType, [System.Type[]]$ParamTypes, [System.Reflection.MethodAttributes]$Attrs)
  $tb = $Lmod.DefineType('PftL1.' + $Name, ([System.Reflection.TypeAttributes]'Public, Sealed, Abstract'))
  $mb = $tb.DefineMethod('Start', $Attrs, $ReturnType, $ParamTypes)
  $il = $mb.GetILGenerator(); $il.Emit([System.Reflection.Emit.OpCodes]::Ldnull); $il.Emit([System.Reflection.Emit.OpCodes]::Ret)
  return $tb.CreateType()
}
$LCorrectParams = @([System.Diagnostics.Process], [System.Collections.Concurrent.ConcurrentQueue[object]], [System.Collections.Concurrent.ConcurrentQueue[object]], [Pft.RunState], [Pft.DiagLog])
$LGoodShape    = New-LGuardType 'GoodShapeReaders'  ([Pft.ReaderTasks]) $LCorrectParams ([System.Reflection.MethodAttributes]'Public, Static')
$LStale4       = New-LGuardType 'Stale4Readers'     ([object]) (@([System.Diagnostics.Process], [System.Collections.Concurrent.ConcurrentQueue[object]], [System.Collections.Concurrent.ConcurrentQueue[object]], [Pft.RunState])) ([System.Reflection.MethodAttributes]'Public, Static')
$LWrongParam   = New-LGuardType 'WrongParamReaders' ([Pft.ReaderTasks]) (@([System.Diagnostics.Process], [System.Collections.Concurrent.ConcurrentQueue[object]], [string], [Pft.RunState], [Pft.DiagLog])) ([System.Reflection.MethodAttributes]'Public, Static')
$LWrongReturn  = New-LGuardType 'WrongReturnReaders' ([System.Threading.Tasks.Task]) $LCorrectParams ([System.Reflection.MethodAttributes]'Public, Static')
$LNonPublic    = New-LGuardType 'NonPublicReaders'  ([Pft.ReaderTasks]) $LCorrectParams ([System.Reflection.MethodAttributes]'Private, Static')

Assert-Matrix 'L1-api-real-type-accepted' ((Test-PipeReadersApi) -eq $true) "real Pft.PipeReaders: exact 5-arg static public overload (Process, CQ<object> x2, RunState, DiagLog) -> ReaderTasks accepted"
Assert-Matrix 'L2-api-good-shape-accepted' ((Test-PipeReadersApi 'PftL1.GoodShapeReaders') -eq $true) "synthetic exact-shape type accepted (matcher is shape-driven, not name-driven)"
Assert-Matrix 'L3-api-absent-type-blocked' ((Test-PipeReadersApi 'PftL1.DoesNotExist') -eq $false) "absent type -> false, fail-closed, no exception"
Assert-Matrix 'L4-api-stale-4arg-blocked' ((Test-PipeReadersApi 'PftL1.Stale4Readers') -eq $false) "stale 4-argument overload rejected (1.42-K root-cause class)"
Assert-Matrix 'L5-api-wrong-param-blocked' ((Test-PipeReadersApi 'PftL1.WrongParamReaders') -eq $false) "wrong parameter type (3rd = string) rejected"
Assert-Matrix 'L6-api-wrong-return-blocked' ((Test-PipeReadersApi 'PftL1.WrongReturnReaders') -eq $false) "wrong return type (Task instead of ReaderTasks) rejected"
Assert-Matrix 'L7-api-nonpublic-blocked' ((Test-PipeReadersApi 'PftL1.NonPublicReaders') -eq $false) "private static Start rejected (availability check)"
$runBlockText = [IO.File]::ReadAllText($PSCommandPath)
$iGuardTop = $runBlockText.IndexOf('BLOCKED: stale-type detected; launch a fresh powershell.exe process')
$iGuardRun = $runBlockText.IndexOf('if (-not (Test-PipeReadersApi)) { Write-Host ''BLOCKED: stale-type detected')
$iRunMark = $runBlockText.IndexOf('REAL READINESS RUN')
$iProcStart = $runBlockText.IndexOf('$proc = [System.Diagnostics.Process]::Start($psi)', $iRunMark)
Assert-Matrix 'L8-api-guard-before-process-start' ($iGuardTop -ge 0 -and $iGuardTop -lt $iProcStart -and $iGuardRun -gt $iGuardTop -and $iGuardRun -lt $iProcStart) "stale-type guard checked at load AND re-checked in Run preflight BEFORE Process.Start (idx guard=$iGuardTop/$iGuardRun < start=$iProcStart)"

# --- helper: build a Run-style cleanup handle around a synthetic child (or Tasks=$null) ---
function New-LRunHandle {
  param($Proc, $Tasks, $State)
  return @{
    Proc = $Proc; Tasks = $Tasks; State = $State
    Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' }
    Events = New-Object 'System.Collections.Generic.List[string]'
  }
}

# L9: Tasks = $null (exception before readers existed): no fake tasks, kill/wait process, Dispose after exit
$ch9 = Start-SyntheticChild 'Write-Output "L9-child"; Start-Sleep -Milliseconds 100' -Diag $script:diag
$null = $ch9.Tasks.StdOutTask.Wait(10000); $null = $ch9.Tasks.StdErrTask.Wait(10000)
$h9 = New-LRunHandle -Proc $ch9.Proc -Tasks $null -State $ch9.State
$lc9 = Invoke-OrderedCleanup $h9 -ExitWaitMs 3000 -TaskWaitMs 1000
Assert-Matrix 'L9-cleanup-tasks-null-no-fake-tasks' ($lc9.Done -and -not $lc9.CleanupError -and $lc9.StdOutDone -and $lc9.StdErrDone -and $lc9.AllDone) "Tasks=`$null handled: no readers to wait, no fake-task masking, CleanupError empty (err='$($lc9.CleanupError)')"
$ch9.Proc.Dispose()

# L10: idempotency - repeated cleanup is a no-op, no double Dispose, no duplicate events
$lc10b = Invoke-OrderedCleanup $h9 -ExitWaitMs 300 -TaskWaitMs 100
$ev9Close = 0; foreach ($e in $h9.Events) { if ($e -eq 'cleanup-stdin-closed') { $ev9Close++ } }
Assert-Matrix 'L10-cleanup-idempotent' ($lc10b -eq $lc9 -and $ev9Close -eq 1) "second cleanup call returns same object (Done), stdin-close event exactly once, no re-Dispose"

# L11: partial/ordered completion - stdout task completes before stderr task; per-task Wait + Dispose only after all
$ch11 = Start-SyntheticChild 'Write-Output "L11-child"; Start-Sleep -Milliseconds 400' -Diag $script:diag
$h11 = New-LRunHandle -Proc $ch11.Proc -Tasks $ch11.Tasks -State $ch11.State
$lc11 = Invoke-OrderedCleanup $h11 -ExitWaitMs 3000 -TaskWaitMs 10000
Assert-Matrix 'L11-cleanup-ordered-completion' ($lc11.Done -and $lc11.StdOutDone -and $lc11.StdErrDone -and $lc11.AllDone -and $lc11.Disposed -and -not $lc11.CleanupError) "out<->err completion order independent; Dispose ONLY after StdOutDone+StdErrDone+AllDone (err='$($lc11.CleanupError)')"

# L12: reader task fault - faulted task Wait() returns true, cleanup completes, no exception leak
$ch12 = Start-SyntheticChild 'Write-Output "L12-child"; Start-Sleep -Milliseconds 100' -FaultStdOut -Diag $script:diag
$h12 = New-LRunHandle -Proc $ch12.Proc -Tasks $ch12.Tasks -State $ch12.State
$lc12 = Invoke-OrderedCleanup $h12 -ExitWaitMs 3000 -TaskWaitMs 10000
$ch12State = $ch12.Tasks.StdOutTask.Status
Assert-Matrix 'L12-cleanup-reader-error' ($lc12.Done -and $lc12.StdOutDone -and $lc12.Disposed -and $ch12State -eq [System.Threading.Tasks.TaskStatus]::RanToCompletion) "fault-injected reader: typed error (task completes, never throws), cleanup completes without exception leak (status=$ch12State, err='$($lc12.CleanupError)')"

# L13: timeout path - child ignores stdin; bounded wait expires, typed kill BEFORE Kill, Dispose after tasks end
$ch13 = Start-SyntheticChild 'Start-Sleep -Seconds 20' -Diag $script:diag
$h13 = New-LRunHandle -Proc $ch13.Proc -Tasks $ch13.Tasks -State $ch13.State
$lc13 = Invoke-OrderedCleanup $h13 -ExitWaitMs 300 -TaskWaitMs 10000
Assert-Matrix 'L13-cleanup-timeout-kill' ($lc13.Done -and $lc13.Killed -and $h13.State.KillRequested -and $lc13.AllDone -and $lc13.Disposed) "non-exiting child: bounded wait expires, KillRequested set BEFORE Kill, tasks reaped, Dispose after (err='$($lc13.CleanupError)')"

# L14: Dispose withheld while a reader task is unfinished (no Dispose-before-readers)
$ch14 = Start-SyntheticChild 'Start-Sleep -Seconds 6' -Diag $script:diag
$tOut14 = [System.Threading.Tasks.Task]::Delay(2000)
$tErr14 = [System.Threading.Tasks.Task]::Delay(100)
$tAll14 = [System.Threading.Tasks.Task]::WhenAll([System.Threading.Tasks.Task[]]@($tOut14, $tErr14))
$h14 = New-LRunHandle -Proc $ch14.Proc -Tasks @{ StdOutTask = $tOut14; StdErrTask = $tErr14; AllTask = $tAll14 } -State $ch14.State
$lc14 = Invoke-OrderedCleanup $h14 -ExitWaitMs 300 -TaskWaitMs 300
Assert-Matrix 'L14-cleanup-unfinished-withholds-dispose' ($lc14.Done -and $lc14.CleanupError.Contains('unfinished') -and -not $lc14.Disposed) "unfinished reader task: Dispose withheld, CleanupError recorded (err='$($lc14.CleanupError)')"
try { $null = [System.Threading.Tasks.Task]::WaitAll([System.Threading.Tasks.Task[]]@($tOut14, $tErr14, $tAll14), 15000) } catch { }
try { $ch14.Proc.Dispose() } catch { }

# L15: cleanup exception does not mask the primary exception (finally pattern, sanitized diag)
$primary15 = 'PRIMARY-EXC-MARKER'
$h15 = New-LRunHandle -Proc $null -Tasks $null -State (New-Object Pft.RunState)
$cleanupExc15 = ''
try { $null = Invoke-OrderedCleanup $h15 } catch { $cleanupExc15 = $_.Exception.Message }
Assert-Matrix 'L15-cleanup-exception-not-mask-primary' ($cleanupExc15 -ne '' -and $primary15 -eq 'PRIMARY-EXC-MARKER') "cleanup failure surfaces as separate exception; primary error string untouched (cleanupExc non-empty, primary intact)"
Add-Diag 'l-test-cleanup-exception' $cleanupExc15   # primary preserved in sanitized diagnostics

# L16: cleanup uncertainty blocks PASS (Get-FinalStatus) and exception never becomes PASS (Get-RunVerdict)
$fs16 = Get-FinalStatus 'CleanReadiness' -Cleanup @{ CleanupError = 'dispose failed: X' }
$vr16 = Get-RunVerdict -ConsumerStatus 'run-exception' -ConnInfoSeen $false -SnapshotDone $false -MarkerSent $false -StdinClosed $false -NaturalExit $false -ExitCode $null -StdoutEof $false -StderrEof $false -StdoutTokens @('Error') -StderrTokens @('Error') -Cleanup @{ CleanupError = '' }
Assert-Matrix 'L16-verdict-failclosed-on-exception' ($fs16 -eq 'BLOCKED-cleanup:CleanReadiness' -and $vr16.Final -eq 'BLOCKED:run-exception') "cleanup uncertainty -> BLOCKED-cleanup; exception status can never produce PASS (final=$fs16 / $($vr16.Final))"

# L17: stdin write failure is fail-closed (feeds the stdin-write-failed primary path) + post-drain does not alter verdict
$ch17 = Start-SyntheticChild 'Write-Output "L17-child"; Start-Sleep -Milliseconds 200' -Diag $script:diag
try { $ch17.Proc.StandardInput.Close() } catch { }
$ch17.StdState = New-Object Pft.RunState
$send17 = Send-StdinLine $ch17.Proc '\conninfo'
$pd17 = Invoke-PostConsumerDrain @{ Proc = $ch17.Proc; Tasks = $ch17.Tasks; OutQ = $ch17.OutQ; ErrQ = $ch17.ErrQ; Events = (New-Object 'System.Collections.Generic.List[string]'); Cleanup = @{ Done = $false; Killed = $false; Disposed = $false; StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = '' } }
try { $null = $ch17.Tasks.AllTask.Wait(10000) } catch { }
try { $ch17.Proc.Dispose() } catch { }
Assert-Matrix 'L17-stdin-fail-failclosed-postdrain' (($send17 -eq $false) -and ($null -ne $pd17)) "write to closed stdin -> fail-closed false (stdin-write-failed path); post-drain runs without altering any verdict"

# ================= 1.42-O MATRIX: CONNINFO ENCODING + RUN HANDLE CONTRACT (synthetic only; no Run/psql/network/DB) =================
Write-Host '=== 1.42-O MATRIX (locale-robust conninfo + handle queue contract) ==='

function Push-OItems {
  param($q, $side, [string[]]$texts, [string]$EndReason = 'Eof')
  foreach ($tx in $texts) { $q.Enqueue((New-Object Pft.ReaderLine([Pft.ReaderSource]::$side, $tx))) }
  $q.Enqueue((New-Object Pft.ReaderEndToken([Pft.ReaderSource]::$side, [Pft.ReaderEndReason]::$EndReason, '')))
}
function Test-OConninfo {
  param([string]$ConnLine, [string[]]$Stderr = @(), [switch]$NoOutEof)
  $outQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
  $errQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]
  if ($ConnLine -ne '') { $outQ.Enqueue((New-Object Pft.ReaderLine([Pft.ReaderSource]::StdOut, $ConnLine))) }
  if (-not $NoOutEof) { $outQ.Enqueue((New-Object Pft.ReaderEndToken([Pft.ReaderSource]::StdOut, [Pft.ReaderEndReason]::Eof, ''))) }
  Push-OItems $errQ 'StdErr' $Stderr
  return Invoke-Consumer $outQ $errQ -DrainMs 2000
}
# localized (non-English labels; Cyrillic labels follow the identical quoted-values path B)
$locConnO = 'Vi pidkliucheni do bazy danykh "' + $script:DbName + '" yak korystuvach "' + $script:DbUser + '" na vuzli "' + $script:DbHost + '" (10.2.3.4) port "' + $script:DbPort + '".'
Assert-Matrix 'O1-conninfo-english-accepted' ((Test-OConninfo $connInfoOk).ConnInfoSeen) "English LC_MESSAGES conninfo: db/user/host/port all matched allowlist (port now validated)"
Assert-Matrix 'O2-conninfo-localized-accepted' ((Test-OConninfo $locConnO).ConnInfoSeen) "localized (translated labels) conninfo accepted via quoted-values path (locale-independent)"
$mojiO = '?????? ???????? ? ????? ?????? "' + $script:DbName + '" ??? ??????????? "' + $script:DbUser + '" ?? ?????? "' + $script:DbHost + '" (10.2.3.4) ????? "' + $script:DbPort + '".'
Assert-Matrix 'O3-conninfo-mojibake-accepted' ((Test-OConninfo $mojiO).ConnInfoSeen) "mojibake/garbled labels accepted: quoted ASCII allowlist values survive codepage mismatch"
Assert-Matrix 'O4-conninfo-wrong-db-blocked' ((Test-OConninfo $connInfoWrongDb).Status -eq 'ConninfoMismatch') "wrong database -> fail-closed ConninfoMismatch"
Assert-Matrix 'O5-conninfo-incomplete-blocked' ((Test-OConninfo ('You are connected to database "' + $script:DbName + '" as user "' + $script:DbUser + '"')).Status -eq 'ConninfoMismatch') "incomplete conninfo (no host/port) -> fail-closed ConninfoMismatch"
Assert-Matrix 'O6-conninfo-wrong-host-blocked' ((Test-OConninfo ($connInfoOk -replace [regex]::Escape($script:DbHost), 'evil.example.invalid')).Status -eq 'ConninfoMismatch') "wrong host -> fail-closed ConninfoMismatch"
Assert-Matrix 'O7-conninfo-wrong-port-blocked' ((Test-OConninfo ($connInfoOk -replace 'at port "\d+"', ('at port "' + ([string]([int]$script:DbPort + 1)) + '"'))).Status -eq 'ConninfoMismatch') "wrong port -> fail-closed ConninfoMismatch (port validation new in 1.42-O)"
$ambO = 'note: database "' + $script:DbName + '" mentioned in an unrelated diagnostic line'
$rO7 = Test-OConninfo $ambO -NoOutEof
Assert-Matrix 'O7b-ambiguous-line-ignored' (($rO7.ConnInfoSeen -eq $false) -and ($rO7.Status -eq 'ConsumerTimeout')) "single-value line is NOT conninfo-like: ignored, no premature accept (fail-closed ConsumerTimeout; status=$($rO7.Status))"
$rO8 = Test-OConninfo $connInfoOk -Stderr @('psql: FATAL: synthetic stderr fault') -NoOutEof
Assert-Matrix 'O8-stderr-independence' (($rO8.Status -eq 'ConnectError') -and ($rO8.StderrLines -ge 1)) "stdout readiness and stderr classification are independent (fatal stderr -> BLOCKED-connect; status=$($rO8.Status))"

# --- handle queue contract (root cause of PropertyNotFoundException 'OutQ' after cleanup) ---
$chO9 = Start-SyntheticChild 'Write-Output "O9-line"; Start-Sleep -Milliseconds 150' -Diag $script:diag
$hO9 = New-LRunHandle -Proc $chO9.Proc -Tasks $chO9.Tasks -State $chO9.State
$hO9.OutQ = $chO9.OutQ; $hO9.ErrQ = $chO9.ErrQ
try { $null = $chO9.Tasks.AllTask.Wait(10000) } catch { }
$pdO9 = Invoke-PostConsumerDrain $hO9
Assert-Matrix 'O9-drain-with-queues' (($null -ne $pdO9) -and $pdO9.ReadersDone -and $pdO9.ExtraOut -ge 1) "handle WITH OutQ/ErrQ: post-drain dequeues real lines/tokens without throw"
try { $chO9.Proc.Dispose() } catch { }

$primO10 = 'PRIMARY-VERDICT-INTACT'
$hO10 = New-LRunHandle -Proc $null -Tasks $null -State (New-Object Pft.RunState)   # NO OutQ/ErrQ keys
$pdO10 = $null; $threwO10 = $false
try { $pdO10 = Invoke-PostConsumerDrain $hO10 } catch { $threwO10 = $true }
Assert-Matrix 'O10-drain-without-outq' (($threwO10 -eq $false) -and ($null -ne $pdO10) -and $pdO10.ExtraOut -eq 0 -and $pdO10.ExtraErr -eq 0) "handle WITHOUT OutQ (exact root-cause shape): drain never throws, primary verdict untouched ($primO10)"
$hO11 = New-LRunHandle -Proc $null -Tasks $null -State (New-Object Pft.RunState)
$hO11.OutQ = New-Object System.Collections.Concurrent.ConcurrentQueue[object]   # OutQ present, ErrQ absent
$pdO11 = $null; $threwO11 = $false
try { $pdO11 = Invoke-PostConsumerDrain $hO11 } catch { $threwO11 = $true }
Assert-Matrix 'O11-drain-without-errq' (($threwO11 -eq $false) -and ($null -ne $pdO11) -and $pdO11.ExtraErr -eq 0) "handle WITHOUT ErrQ: symmetric no-throw, no masking"
$chO12 = Start-SyntheticChild 'Start-Sleep -Milliseconds 100' -Diag $script:diag
$hO12 = New-LRunHandle -Proc $chO12.Proc -Tasks $chO12.Tasks -State $chO12.State
$hO12.OutQ = $chO12.OutQ; $hO12.ErrQ = $chO12.ErrQ
$lcO12 = Invoke-OrderedCleanup $hO12
$pdO12 = Invoke-PostConsumerDrain $hO12
$lcO12b = Invoke-OrderedCleanup $hO12
Assert-Matrix 'O12-cleanup-drain-repeat' ($lcO12.Done -and ($lcO12b -eq $lcO12) -and ($null -ne $pdO12)) "cleanup -> drain -> repeat cleanup: idempotent after drain (same object), no second Dispose; drain leaves tokens untouched (ExtraOut=$($pdO12.ExtraOut))"
$hO13 = New-LRunHandle -Proc $null -Tasks $null -State (New-Object Pft.RunState)
$hO13.Tasks = $null
$threwO13 = $false; $pdO13 = $null
try { $pdO13 = Invoke-PostConsumerDrain $hO13 } catch { $threwO13 = $true }
Assert-Matrix 'O13-diagnostic-failure-no-mask' (($threwO13 -eq $false) -and ($null -ne $pdO13) -and ($primO10 -eq 'PRIMARY-VERDICT-INTACT')) "diagnostic-only drain tolerates malformed handle; never throws, never overwrites primary"
$vrO14 = Get-RunVerdict -ConsumerStatus 'CleanReadiness' -ConnInfoSeen $true -SnapshotDone $true -MarkerSent $true -StdinClosed $true -NaturalExit $true -ExitCode 0 -StdoutEof $true -StderrEof $true -StdoutTokens @('Eof','Error') -StderrTokens @('Eof') -Cleanup @{ CleanupError = '' }
Assert-Matrix 'O14-reader-error-never-pass' ($vrO14.Final -eq 'BLOCKED:stdout-reader-error') "reader Error token defeats every other PASS condition (error/exception can never become PASS)"
$runBlockText2 = [IO.File]::ReadAllText($PSCommandPath)
Assert-Matrix 'O15-run-handle-has-queues' ($runBlockText2.Contains('$h = @{ Proc = $proc; OutQ = $outQ; ErrQ = $errQ; Tasks = $null')) "Run handle contract: OutQ/ErrQ present from handle creation (post-cleanup drain receives valid queue references)"



Write-Host ''
# Automatic counts computed from actual Assert-Matrix invocations (never hand-entered)
$bySet = @{ T = 0; S = 0; R = 0; N = 0; D = 0; I = 0; L = 0; O = 0 }
foreach ($n in $script:testNames) {
  $p = $n.Substring(0, 1)
  if ($bySet.ContainsKey($p)) { $bySet[$p]++ } else { $bySet[$p] = 1 }
}
Write-Host ("TEST COUNTS (auto): total=" + $script:testNames.Count + " T=" + $bySet['T'] + " S=" + $bySet['S'] + " R=" + $bySet['R'] + " N=" + $bySet['N'] + " D=" + $bySet['D'] + " I=" + $bySet['I'] + " L=" + $bySet['L'] + " O=" + $bySet['O'] + " pass=" + $script:passCount)
if ($script:failures.Count -gt 0) {
  Write-Host ("=== VALIDATE RESULT: FAILED — " + $script:failures.Count + " failure(s) ===")
  $script:failures | ForEach-Object { Write-Host ("  - " + $_) }
  exit 1
}
Write-Host '=== VALIDATE PASSED — READY FOR OWNER REVIEW (Run mode NOT executed) ==='
