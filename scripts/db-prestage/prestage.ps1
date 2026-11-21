#Requires -Version 5.1
# PHASE 1.39 FINAL HARDENING — per-run kill state + complete local reader failure matrix.
# STRICT: no DB connections, no SQL, no psql with connection parameters, no network, no secrets printed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ============ Add-Type: typed tokens, readers with PER-RUN kill state (C# 5 compatible) ============
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

  // PER-RUN state: one instance per launched process. Never shared, never global.
  // Causality contract: KillRequested=true may only be set immediately before/while
  // killing THIS process. EOF classification uses it; if EOF arrives without the flag
  // the token is Eof (natural pipe close). If the child had ALREADY exited naturally
  // when the flag is set, classification is causally indeterminate -> the consumer
  // must treat it as ambiguous and fail closed (see harness scenario 12).
  public sealed class RunState {
    public volatile bool KillRequested;
    public volatile bool InjectErrorStdOut;   // deterministic fault injection (harness only)
    public volatile bool InjectErrorStdErr;
    public readonly int RunId;
    static int _counter;
    public RunState() { RunId = System.Threading.Interlocked.Increment(ref _counter); }
  }

  public static class PipeReaders {
    public static ReaderTasks Start(Process p,
        ConcurrentQueue<object> outQ, ConcurrentQueue<object> errQ, RunState state) {
      Task tOut = StartOne(p.StandardOutput, ReaderSource.StdOut, outQ, state);
      Task tErr = StartOne(p.StandardError,  ReaderSource.StdErr, errQ, state);
      return new ReaderTasks(tOut, tErr);
    }
    // Windows pipes yield null (EOF) on broken pipe after kill — not an exception.
    // Genuine reader IO failures are reported as Error.
    private static Task StartOne(System.IO.StreamReader r, ReaderSource src,
        ConcurrentQueue<object> q, RunState state) {
      return Task.Factory.StartNew(delegate {
        try {
          while (true) {
            if (src == ReaderSource.StdOut && state != null && state.InjectErrorStdOut) {
              state.InjectErrorStdOut = false;
              throw new System.IO.IOException("synthetic injected reader fault (stdout)");
            }
            if (src == ReaderSource.StdErr && state != null && state.InjectErrorStdErr) {
              state.InjectErrorStdErr = false;
              throw new System.IO.IOException("synthetic injected reader fault (stderr)");
            }
            string line = r.ReadLine();   // blocks until line or EOF (null)
            if (line == null) {
              ReaderEndReason reason = (state != null && state.KillRequested)
                ? ReaderEndReason.Killed : ReaderEndReason.Eof;
              q.Enqueue(new ReaderEndToken(src, reason, "pipe closed (process exited or killed)"));
              return;
            }
            q.Enqueue(new ReaderLine(src, line));
          }
        } catch (Exception ex) {
          q.Enqueue(new ReaderEndToken(src, ReaderEndReason.Error, ex.GetType().FullName + ": " + ex.Message));
        }
      }, TaskCreationOptions.LongRunning);
    }
  }

  // RuntimeDll helper: hash-verified LoadLibraryEx + PQlibVersion (libpq-misc, documented function)
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
        if (fn == IntPtr.Zero) {
          return new { Loaded = true, Version = -1, Detail = "PQlibVersion export not found" };
        }
        var f = (PqLibVersionDelegate)System.Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer(fn, typeof(PqLibVersionDelegate));
        int v = f();
        return new { Loaded = true, Version = v, Detail = "major=" + (v / 10000) + " minor=" + ((v / 100) % 100) + " revision=" + (v % 100) + " pid=" + GetCurrentProcessId() };
      } finally {
        FreeLibrary(h);
      }
    }
  }

  // Snapshot helper: enumerate modules of a live process (Toolhelp)
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

# ============ Harness helpers ============
function New-ChildArgs([string]$childScript) {
  '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childScript))
}

function Start-SyntheticChild([string]$childScript, [switch]$FaultStdOut, [switch]$FaultStdErr) {
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
  # fault flags MUST be set BEFORE readers start (reader only checks at loop top)
  if ($FaultStdOut) { $state.InjectErrorStdOut = $true }
  if ($FaultStdErr) { $state.InjectErrorStdErr = $true }
  $proc = [System.Diagnostics.Process]::Start($psi)
  $tasks = [Pft.PipeReaders]::Start($proc, $outQ, $errQ, $state)   # readers BEFORE any interaction
  return @{ Proc = $proc; OutQ = $outQ; ErrQ = $errQ; State = $state; Tasks = $tasks }
}

# Readiness consumer: fair alternate drain of BOTH queues; strict order CONN-INFO -> MARKER;
# immediate stop on any Error token; stdout EOF before readiness = fatal; stderr EOF = normal.
function Invoke-Consumer {
  param($outQ, $errQ, [int]$DrainMs = 25000, [scriptblock]$Hook = $null)
  $res = @{
    Status = 'None'; Readiness = $false; ConnInfoSeen = $false
    PrimaryError = ''; StdoutEof = $false; StderrEof = $false
    StdoutTokens = @(); StderrTokens = @(); StderrLines = 0; StdoutLines = 0
  }
  $deadline = [DateTime]::UtcNow.AddMilliseconds($DrainMs)
  $item = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($Hook) { & $Hook $res }
    if ($res.Status -like 'HOOK-*') { return $res }   # hook may stop consumption (e.g. after kill handling)
    $progress = $false
    foreach ($side in @('out', 'err')) {
      $q = $outQ
      if ($side -eq 'err') { $q = $errQ }
      if ($null -eq $q) { throw "queue null for side=$side" }
      while ($q.TryDequeue([ref]$item)) {
        $progress = $true
        if ($item -is [Pft.ReaderEndToken]) {
          if ($side -eq 'out') { $res.StdoutTokens += [string]$item.Reason } else { $res.StderrTokens += [string]$item.Reason }
          if ($item.Reason -eq 'Error') {
            $res.PrimaryError = "$($side)-reader Error: $($item.Detail)"
            $res.Status = if ($res.Readiness) { 'ReadinessThenReaderError' } else { 'ReaderError' }
            return $res   # immediate reaction, no waiting for deadline
          }
          if ($side -eq 'out') {
            $res.StdoutEof = $true
            if (-not $res.Readiness) { $res.Status = 'StdoutEndBeforeReadiness'; return $res }  # fatal (Eof OR Killed)
          } else {
            $res.StderrEof = $true   # stderr EOF is NOT an automatic error
          }
        } else {
          if ($side -eq 'out') {
            $res.StdoutLines++
            if ($item.Text -eq 'PFT-READINESS-MARKER') {
              if (-not $res.ConnInfoSeen) { $res.Status = 'MarkerBeforeConninfo'; return $res }  # order violation -> fail-closed
              $res.Readiness = $true
              if ($res.Status -eq 'None') { $res.Status = 'CleanReadiness' }
            } elseif ($item.Text -eq 'CONN-INFO') { $res.ConnInfoSeen = $true }
          } else { $res.StderrLines++ }
        }
      }
    }
    if (-not $progress) { Start-Sleep -Milliseconds 10 }
  }
  if ($res.Status -eq 'None') { $res.Status = 'ConsumerTimeout' }
  return $res
}

# Task lifecycle: separate waits with separate deadlines; Dispose ONLY after both readers finished.
function Confirm-TaskLifecycle {
  param($h, [int]$WaitMs = 10000)
  $lc = @{ StdOutDone = $false; StdErrDone = $false; AllDone = $false; CleanupError = ''; Disposed = $false }
  $lc.StdOutDone = $h.Tasks.StdOutTask.Wait($WaitMs)
  $lc.StdErrDone = $h.Tasks.StdErrTask.Wait($WaitMs)
  $lc.AllDone    = $h.Tasks.AllTask.Wait($WaitMs)
  if ($lc.StdOutDone -and $lc.StdErrDone -and $lc.AllDone) {
    try { $h.Proc.Dispose(); $lc.Disposed = $true }   # ONLY after both readers finished
    catch { $lc.CleanupError = $_.Exception.Message }
  } else {
    $lc.CleanupError = 'BLOCKED: reader task(s) unfinished — Dispose withheld'
    try { $h.State.KillRequested = $true; $h.Proc.Kill() } catch { $lc.CleanupError += '; kill: ' + $_.Exception.Message }
    [void]$h.Tasks.AllTask.Wait($WaitMs)
  }
  return $lc
}

$failures = @()
function Assert-Matrix([string]$name, [bool]$cond, [string]$detail) {
  if ($cond) { Write-Host ("PASS [{0}] {1}" -f $name, $detail) }
  else { Write-Host ("FAIL [{0}] {1}" -f $name, $detail); $script:failures += "${name}: $detail" }
}

Write-Host '=== READER FAILURE MATRIX (synthetic local children, no network, no psql) ==='

# --- S1: both streams finish normally, readiness in strict order ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Write-Output PFT-READINESS-MARKER; Write-Output AFTER-1; [Console]::Error.WriteLine("NOTE-S1")'
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S1' ($r.Status -eq 'CleanReadiness' -and $r.ConnInfoSeen -and $r.Readiness -and $lc.AllDone -and -not $lc.CleanupError) "status=$($r.Status) out=$($r.StdoutTokens -join ',') err=$($r.StderrTokens -join ',')"

# --- S2: stdout reader error before readiness (DETERMINISTIC injected fault; dispose-under-read
#     is forbidden and proven nondeterministic: blocked ReadLine survives BaseStream.Dispose) ---
$h = Start-SyntheticChild 'Start-Sleep -Seconds 20' -FaultStdOut
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
$extra = @(); $item = $null
while ($h.ErrQ.TryDequeue([ref]$item)) { if ($item -is [Pft.ReaderEndToken]) { $extra += [string]$item.Reason } }
Assert-Matrix 'S2' ($r.Status -eq 'ReaderError' -and $r.PrimaryError -match 'out-reader Error' -and -not $r.Readiness -and $lc.AllDone -and $extra -contains 'Killed' -and $lc.CleanupError -eq '') "status=$($r.Status) primary=$($r.PrimaryError) stderr-extra=$($extra -join ',')"

# --- S3: stderr reader error before readiness (deterministic injected fault) ---
$h = Start-SyntheticChild 'Start-Sleep -Seconds 20' -FaultStdErr
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
$extra = @(); $item = $null
while ($h.OutQ.TryDequeue([ref]$item)) { if ($item -is [Pft.ReaderEndToken]) { $extra += [string]$item.Reason } }
Assert-Matrix 'S3' ($r.Status -eq 'ReaderError' -and $r.PrimaryError -match 'err-reader Error' -and -not $r.Readiness -and $lc.AllDone) "status=$($r.Status) primary=$($r.PrimaryError) stdout-extra=$($extra -join ',')"

# --- S4: stdout EOF before readiness (silent natural exit, no marker) ---
$h = Start-SyntheticChild 'Start-Sleep -Milliseconds 200'
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$exitCode = $h.Proc.ExitCode          # capture BEFORE Dispose (handle closed afterwards)
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S4' ($r.Status -eq 'StdoutEndBeforeReadiness' -and $r.StdoutTokens -contains 'Eof' -and -not $r.Readiness -and $exitCode -eq 0) "status=$($r.Status) exit=$exitCode"

# --- S5: stderr EOF after process finished (normal, not an error) ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Write-Output PFT-READINESS-MARKER'
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S5' ($r.Status -eq 'CleanReadiness' -and $r.StderrEof -and $r.PrimaryError -eq '') "status=$($r.Status) stderrEof=$($r.StderrEof)"

# --- S6: large stdout stream + immediate stderr reader error; no false-positive readiness PASS ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Write-Output PFT-READINESS-MARKER; 1..300 | ForEach-Object { Write-Output ("BIG-OUT-" + $_) }; Start-Sleep -Seconds 20' -FaultStdErr
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S6' (($r.Status -eq 'ReaderError' -or $r.Status -eq 'ReadinessThenReaderError') -and $r.PrimaryError -match 'err-reader Error' -and $r.Status -ne 'CleanReadiness' -and $lc.AllDone) "status=$($r.Status) primary=$($r.PrimaryError)"

# --- S7: large stderr stream + immediate stdout reader error; readiness never reached ---
$h = Start-SyntheticChild '1..300 | ForEach-Object { [Console]::Error.WriteLine("BIG-ERR-" + $_) }; Start-Sleep -Seconds 20' -FaultStdOut
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$h.State.KillRequested = $true; try { $h.Proc.Kill() } catch {}
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S7' ($r.Status -eq 'ReaderError' -and -not $r.Readiness -and $r.PrimaryError -match 'out-reader Error' -and $lc.AllDone) "status=$($r.Status)"

# --- S8: stdout reader hangs (stream open), stderr done; readiness ok; separate deadlines; then kill ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Write-Output PFT-READINESS-MARKER; Start-Sleep -Seconds 20'
$hook = {
  param($res)
  if ($res.Readiness -and -not $script:s8Handled) {
    $script:s8Handled = $true
    $soDone = $script:s8.Tasks.StdOutTask.Wait(1500)   # separate StdOutTask deadline: must NOT finish
    if ($soDone) { $res.Status = 'HOOK-stdout-finished-unexpectedly'; return }
    $script:s8.State.KillRequested = $true
    $script:s8.Proc.Kill()
  }
}
$script:s8 = $h; $script:s8Handled = $false
$r = Invoke-Consumer $h.OutQ $h.ErrQ -Hook $hook
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S8' ($r.Readiness -and $r.StdoutTokens -contains 'Killed' -and $r.StderrTokens -contains 'Killed' -and $lc.AllDone -and -not $lc.CleanupError) "status=$($r.Status) out=$($r.StdoutTokens -join ',') err=$($r.StderrTokens -join ',')"

# --- S9: both readers finish with different delays; separate task waits ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Write-Output PFT-READINESS-MARKER; Start-Sleep -Milliseconds 400; 1..5 | ForEach-Object { Write-Output ("O-" + $_); [Console]::Error.WriteLine("E-" + $_); Start-Sleep -Milliseconds 120 }'
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$soDone = $h.Tasks.StdOutTask.Wait(10000)
$firstDone = 'StdOut'
$seDone = $false
$sw = [Diagnostics.Stopwatch]::StartNew()
while (-not ($seDone = $h.Tasks.StdErrTask.Wait(50)) -and $sw.ElapsedMilliseconds -lt 10000) {
  if (-not $h.Tasks.StdOutTask.IsCompleted) { $firstDone = 'StdErr-first?' }
}
$allDone = $h.Tasks.AllTask.Wait(10000)
$h.Proc.Dispose()
Assert-Matrix 'S9' ($r.Status -eq 'CleanReadiness' -and $soDone -and $seDone -and $allDone -and $firstDone -eq 'StdOut') "status=$($r.Status) firstDone=$firstDone so=$soDone se=$seDone all=$allDone"

# --- S10: natural exit (no kill), tokens must be Eof (per-run state isolation: fresh RunState) ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Start-Sleep -Milliseconds 200'
$r = Invoke-Consumer $h.OutQ $h.ErrQ
$lc = Confirm-TaskLifecycle $h
Assert-Matrix 'S10' ($r.Status -eq 'StdoutEndBeforeReadiness' -and $r.StdoutTokens -contains 'Eof' -and $r.StdoutTokens -notcontains 'Killed' -and $h.State.KillRequested -eq $false) "status=$($r.Status) tokens=$($r.StdoutTokens -join ',')"

# --- S11: kill after hang; per-run state -> Killed, not Eof; early-stop consumer still sees leftover err token ---
$h = Start-SyntheticChild 'Start-Sleep -Seconds 20'
Start-Sleep -Milliseconds 300
$h.State.KillRequested = $true; $h.Proc.Kill()
$r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs 10000
$lc = Confirm-TaskLifecycle $h
$extraErr = @(); $item = $null
while ($h.ErrQ.TryDequeue([ref]$item)) { if ($item -is [Pft.ReaderEndToken]) { $extraErr += [string]$item.Reason } }
Assert-Matrix 'S11' ($r.StdoutTokens -contains 'Killed' -and ($r.StderrTokens -contains 'Killed' -or $extraErr -contains 'Killed') -and $lc.AllDone) "out=$($r.StdoutTokens -join ',') err=$($r.StderrTokens -join ',') extraErr=$($extraErr -join ',')"

# --- S12: kill concurrently with natural exit — causally ambiguous -> fail-closed, never silent PASS ---
$h = Start-SyntheticChild 'Write-Output CONN-INFO; Write-Output PFT-READINESS-MARKER; Start-Sleep -Milliseconds 250'
$hook = {
  param($res)
  if (-not $script:s12Handled) {
    $script:s12Handled = $true
    Start-Sleep -Milliseconds 150
    $script:s12.State.KillRequested = $true     # may or may not win the race with natural exit
    try { $script:s12.Proc.Kill() } catch {}
  }
}
$script:s12 = $h; $script:s12Handled = $false
$r = Invoke-Consumer $h.OutQ $h.ErrQ -DrainMs 10000 -Hook $hook
$lc = Confirm-TaskLifecycle $h
$tokOk = (@($r.StdoutTokens | Where-Object { $_ -in 'Eof','Killed' }).Count -eq $r.StdoutTokens.Count) -and $r.StdoutTokens.Count -gt 0
Assert-Matrix 'S12' ($tokOk -and $lc.AllDone) "out=$($r.StdoutTokens -join ',') err=$($r.StderrTokens -join ',') status=$($r.Status) readiness=$($r.Readiness) — race outcome recorded as ambiguous; first-run policy: fail-closed (no silent PASS)"

# --- S13: per-run state independence — a natural-exit run AFTER a killed run must be Eof ---
$h1 = Start-SyntheticChild 'Start-Sleep -Seconds 20'
$h1.State.KillRequested = $true; $h1.Proc.Kill()
[void](Invoke-Consumer $h1.OutQ $h1.ErrQ -DrainMs 10000)
[void](Confirm-TaskLifecycle $h1)
$h2 = Start-SyntheticChild 'Write-Output CONN-INFO; Start-Sleep -Milliseconds 200'
$r2 = Invoke-Consumer $h2.OutQ $h2.ErrQ -DrainMs 10000
$lc2 = Confirm-TaskLifecycle $h2
Assert-Matrix 'S13' ($h1.State.RunId -ne $h2.State.RunId -and $r2.StdoutTokens -contains 'Eof' -and $r2.StdoutTokens -notcontains 'Killed') "runIds=$($h1.State.RunId),$($h2.State.RunId) tokens=$($r2.StdoutTokens -join ',') — no cross-run kill-flag leakage"

Write-Host '=== REPEATED CORE TESTS (unchanged since 1.39 first pass) ==='

# --- process identity ---
$id = [Pft.ModuleSnapshot]::Identity([uint32]$PID)
Write-Host ("self identity: ok=$($id.Ok) image=$($id.ImagePath) startUtc=$($id.StartTimeUtc)")
if (-not $id.Ok) { $failures += 'identity failed' }

# --- module snapshot of OWN live process ---
$mods = [Pft.ModuleSnapshot]::ListModules([uint32]$PID)
$hasKernel = @($mods | Where-Object { $_ -match 'kernel32\.dll$' }).Count
Write-Host ("modules enumerated: " + $mods.Count + " kernel32: " + $hasKernel)
if ($mods.Count -lt 10 -or $hasKernel -lt 1) { $failures += 'module snapshot incomplete' }

# --- libpq probe: hash before -> LoadLibraryEx -> PQlibVersion -> hash after (TOCTOU guard) ---
$dll = 'C:\Program Files\PostgreSQL\17\bin\libpq.dll'
$h1 = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
$probe = [Pft.LibpqProbe]::Probe($dll)
$h2 = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
Write-Host ("PQlibVersion: " + $probe.Version + " (" + $probe.Detail + "); hash stable: " + ($h1 -eq $h2))
if ($h1 -ne $h2 -or $probe.Version -lt 0) { $failures += 'libpq probe failed' }

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host ("=== MATRIX RESULT: FAILED — " + $failures.Count + " failure(s) ===")
  $failures | ForEach-Object { Write-Host ("  - " + $_) }
  exit 1
}
Write-Host '=== ALL LOCAL HARDENING TESTS PASSED ==='
