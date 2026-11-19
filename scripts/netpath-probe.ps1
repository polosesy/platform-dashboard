# Network path probe for the dashboard's Network Path page (/network-path) - run on the USER'S DEVICE (Windows PowerShell 5.1+, no admin).
# Format aud-netpath/2 (like Datadog Network Path: traceroute_queries 3, max_ttl 30, timeout 1000 ms, end-to-end probes):
#   1. -Queries traceroutes: TTL 1, 2, ... one ICMP echo each (.NET Ping with a TTL - "TTL expired" from the router of
#      that hop, "success" from the destination); every probe is kept as it was: the address that answered and its time.
#      A traceroute stops at the destination, at -MaxHops, or after -MaxUnknown TTLs in a row without an answer.
#   2. -E2e end-to-end probes to the destination, one after another: TCP connect to -Port (default; many SaaS hosts do not
#      answer ICMP) or ICMP echo (-E2eProtocol icmp). Every time is kept in order (a lost probe = -1) - the dashboard
#      computes loss, latency and jitter from them.
#   3. The link the device uses to reach the target: its type and speed only (no name, no address).
#   4. Only with -Lookup: each public hop's reverse DNS name (PTR) and its AS (Team Cymru, DNS TXT) - this sends the hop
#      addresses to the device's DNS and to Team Cymru's DNS. Off by default.
# One JSON line per run; -Repeat runs -IntervalSec apart (every line is a run - upload them together).
#
#   powershell -ExecutionPolicy Bypass -File netpath-probe.ps1 -Target login.microsoftonline.com | Set-Clipboard
#   powershell -ExecutionPolicy Bypass -File netpath-probe.ps1 -Target login.microsoftonline.com -Repeat 12 -IntervalSec 300 -OutFile path.jsonl
#
# Limits (said on the page too): a router may rate-limit or ignore ICMP to itself - loss at a middle hop that does not
# continue to the destination is that router's ICMP policy, not packet loss on the path. Per-flow load balancing may
# hash ICMP differently from TCP, so the hops are the ICMP path. IPv4 only.
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$Queries = 3,
  [int]$MaxHops = 30,
  [int]$MaxUnknown = 8,
  [int]$TimeoutMs = 1000,
  [int]$E2e = 20,
  [ValidateSet('tcp', 'icmp')][string]$E2eProtocol = 'tcp',
  [int]$Port = 443,
  [switch]$Lookup,
  [int]$Repeat = 1,
  [int]$IntervalSec = 60,
  [string]$OutFile = '',
  [string]$Device = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'

function Get-TargetIp {
  $a = [System.Net.Dns]::GetHostAddresses($Target) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
  if (-not $a) { throw "No IPv4 address for $Target" }
  $a.IPAddressToString
}

# the interface the device would use to reach the target (a UDP "connect" picks the route; no packet is sent)
function Get-Link([string]$ip) {
  try {
    $u = New-Object System.Net.Sockets.UdpClient
    $u.Connect($ip, 443)
    $local = $u.Client.LocalEndPoint.Address.IPAddressToString
    $u.Close()
    foreach ($n in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
      foreach ($a in $n.GetIPProperties().UnicastAddresses) {
        if ($a.Address.IPAddressToString -eq $local) {
          $mbps = if ($n.Speed -gt 0) { [math]::Round($n.Speed / 1000000) } else { $null }
          return [ordered]@{ type = "$($n.NetworkInterfaceType)"; mbps = $mbps }
        }
      }
    }
  } catch { }
  $null
}

function Invoke-Traceroute([string]$ip) {
  $ping = New-Object System.Net.NetworkInformation.Ping
  $buffer = New-Object byte[] 32
  $hops = New-Object System.Collections.Generic.List[object]
  $silent = 0
  for ($ttl = 1; $ttl -le $MaxHops; $ttl++) {
    $options = New-Object System.Net.NetworkInformation.PingOptions($ttl, $true)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try { $reply = $ping.Send($ip, $TimeoutMs, $buffer, $options) } catch { $reply = $null }
    $watch.Stop()
    if ($reply -and ($reply.Status -eq 'TtlExpired' -or $reply.Status -eq 'Success')) {
      # .NET reports RoundtripTime 0 for TTL-expired replies (measured) - the stopwatch time of this probe instead
      $ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 2)
      $st = if ($reply.Status -eq 'Success') { 'd' } else { 'x' }
      $hops.Add([ordered]@{ ttl = $ttl; ip = $reply.Address.IPAddressToString; ms = $ms; st = $st })
      $silent = 0
      if ($st -eq 'd') { break }
    } else {
      $hops.Add([ordered]@{ ttl = $ttl; ip = $null; ms = $null; st = '-' })
      $silent++
      if ($silent -ge $MaxUnknown) { break }
    }
  }
  [ordered]@{ hops = $hops }
}

function Invoke-E2e([string]$ip) {
  $times = New-Object System.Collections.Generic.List[object]
  $ping = New-Object System.Net.NetworkInformation.Ping
  $buffer = New-Object byte[] 32
  for ($i = 0; $i -lt $E2e; $i++) {
    $ms = -1
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    if ($E2eProtocol -eq 'tcp') {
      $c = New-Object System.Net.Sockets.TcpClient
      try {
        $task = $c.ConnectAsync($ip, $Port)
        if ($task.Wait($TimeoutMs) -and $c.Connected) { $watch.Stop(); $ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 2) }
      } catch { }
      $c.Close()
    } else {
      try { $r = $ping.Send($ip, $TimeoutMs, $buffer) } catch { $r = $null }
      $watch.Stop()
      if ($r -and $r.Status -eq 'Success') { $ms = [math]::Round($watch.Elapsed.TotalMilliseconds, 2) }
    }
    $times.Add($ms)
    Start-Sleep -Milliseconds 100
  }
  [ordered]@{ protocol = $E2eProtocol; port = $(if ($E2eProtocol -eq 'tcp') { $Port } else { $null }); rtt = $times }
}

function Test-Public([string]$ip) {
  $p = $ip.Split('.') | ForEach-Object { [int]$_ }
  -not ($p[0] -eq 10 -or ($p[0] -eq 172 -and $p[1] -ge 16 -and $p[1] -le 31) -or ($p[0] -eq 192 -and $p[1] -eq 168) -or ($p[0] -eq 100 -and $p[1] -ge 64 -and $p[1] -le 127) -or $p[0] -eq 127 -or ($p[0] -eq 169 -and $p[1] -eq 254))
}

$asCache = @{}
function Get-Lookup($passes, [string]$targetIp) {
  $out = [ordered]@{}
  $ips = @($passes | ForEach-Object { $_.hops } | Where-Object { $_.ip } | ForEach-Object { $_.ip }) + $targetIp | Sort-Object -Unique
  foreach ($ip in $ips) {
    if (-not (Test-Public $ip)) { continue }
    $e = [ordered]@{}
    try { $n = [System.Net.Dns]::GetHostEntry($ip).HostName; if ($n -and $n -ne $ip) { $e.ptr = $n } } catch { }
    try {
      $rev = ($ip.Split('.')[3, 2, 1, 0]) -join '.'
      $o = ((Resolve-DnsName "$rev.origin.asn.cymru.com" -Type TXT -DnsOnly -ErrorAction Stop | Where-Object { $_.Strings }) | Select-Object -First 1).Strings -join ''
      if ($o) {
        $e.origin = $o
        $asn = ($o.Split('|')[0]).Trim().Split(' ')[0]
        if ($asn -match '^\d+$') {
          if (-not $asCache.ContainsKey($asn)) {
            $asCache[$asn] = ((Resolve-DnsName "AS$asn.asn.cymru.com" -Type TXT -DnsOnly -ErrorAction Stop | Where-Object { $_.Strings }) | Select-Object -First 1).Strings -join ''
          }
          if ($asCache[$asn]) { $e.as = $asCache[$asn] }
        }
      }
    } catch { }
    if ($e.Count) { $out[$ip] = $e }
  }
  $out
}

for ($run = 1; $run -le $Repeat; $run++) {
  $targetIp = Get-TargetIp
  $started = (Get-Date).ToUniversalTime().ToString('o')
  $passes = New-Object System.Collections.Generic.List[object]
  for ($q = 0; $q -lt $Queries; $q++) { $passes.Add((Invoke-Traceroute $targetIp)) }
  $doc = [ordered]@{
    format = 'aud-netpath/2'; target = $Target; targetIp = $targetIp; device = $Device; startedAt = $started
    protocol = 'icmp'; maxHops = $MaxHops; timeoutMs = $TimeoutMs; passes = $passes; e2e = (Invoke-E2e $targetIp); link = (Get-Link $targetIp)
  }
  if ($Lookup) { $doc.lookup = Get-Lookup $passes $targetIp }
  $line = $doc | ConvertTo-Json -Depth 8 -Compress
  if ($OutFile) { Add-Content -Path $OutFile -Value $line -Encoding UTF8 }
  $line
  if ($run -lt $Repeat) { Start-Sleep -Seconds $IntervalSec }
}
