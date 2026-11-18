# Network path probe for the dashboard's Network Path page (/network-path) — run on the USER'S DEVICE (Windows PowerShell 5.1+, no admin).
# For every TTL it sends -Probes ICMP echo requests limited to that TTL (like mtr): the router at that hop answers
# "TTL expired", the destination answers "success". It records only raw facts per hop — which addresses answered, how
# many probes were sent / answered, each round-trip time — and prints one JSON document (format aud-netpath/1).
# The dashboard computes loss and latency from these raw values. Nothing is sent anywhere by this script.
#
#   powershell -ExecutionPolicy Bypass -File netpath-probe.ps1 -Target login.microsoftonline.com > path.json
#   then upload path.json on the page (or paste its text).
#
# Limits (said on the page too): a router may rate-limit or ignore ICMP to itself — loss at a middle hop that does not
# continue to the destination is that router's ICMP policy, not packet loss on the path. IPv4 only.
param(
  [Parameter(Mandatory = $true)][string]$Target,
  [int]$MaxHops = 30,
  [int]$Probes = 10,
  [int]$TimeoutMs = 1000,
  [string]$Device = $env:COMPUTERNAME
)
$ErrorActionPreference = 'Stop'
$addr = [System.Net.Dns]::GetHostAddresses($Target) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | Select-Object -First 1
if (-not $addr) { throw "No IPv4 address for $Target" }
$targetIp = $addr.IPAddressToString
$ping = New-Object System.Net.NetworkInformation.Ping
$buffer = New-Object byte[] 32
$started = (Get-Date).ToUniversalTime().ToString('o')
$hops = @()
$reached = $false
for ($ttl = 1; $ttl -le $MaxHops -and -not $reached; $ttl++) {
  $options = New-Object System.Net.NetworkInformation.PingOptions($ttl, $true)
  $seen = @{}
  $rtts = @()
  $received = 0
  for ($i = 0; $i -lt $Probes; $i++) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try { $reply = $ping.Send($targetIp, $TimeoutMs, $buffer, $options) } catch { $reply = $null }
    $watch.Stop()
    if ($reply -and ($reply.Status -eq 'TtlExpired' -or $reply.Status -eq 'Success')) {
      $received++
      $ip = $reply.Address.IPAddressToString
      if ($seen.ContainsKey($ip)) { $seen[$ip]++ } else { $seen[$ip] = 1 }
      # .NET reports RoundtripTime 0 for TTL-expired replies on some systems — then the stopwatch time of that probe
      $ms = if ($reply.RoundtripTime -gt 0) { [double]$reply.RoundtripTime } else { [math]::Round($watch.Elapsed.TotalMilliseconds, 2) }
      $rtts += $ms
      if ($reply.Status -eq 'Success') { $reached = $true }
    }
  }
  $hops += [ordered]@{ ttl = $ttl; addresses = $seen; sent = $Probes; received = $received; rtt = $rtts }
}
[ordered]@{
  format = 'aud-netpath/1'; target = $Target; targetIp = $targetIp; device = $Device; startedAt = $started
  probes = $Probes; timeoutMs = $TimeoutMs; reached = $reached; hops = $hops
} | ConvertTo-Json -Depth 6 -Compress
