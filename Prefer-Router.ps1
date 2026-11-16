#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$router = Get-NetAdapter -Name 'Ethernet'
$phone = Get-NetAdapter -Name 'Ethernet 5'
if ($router.InterfaceDescription -notmatch 'Realtek PCIe' -or $phone.InterfaceDescription -notmatch 'Remote NDIS') { throw 'Adapters changed. Ask Codex to check them before applying this script.' }
Set-NetIPInterface -InterfaceIndex $router.ifIndex -AutomaticMetric Disabled -InterfaceMetric 10
Set-NetIPInterface -InterfaceIndex $phone.ifIndex -AutomaticMetric Disabled -InterfaceMetric 500
Get-NetIPInterface | Where-Object InterfaceIndex -in @($router.ifIndex,$phone.ifIndex) | Format-Table InterfaceAlias,AddressFamily,InterfaceMetric
Write-Host 'Router is preferred for PC traffic. BrowserAuto mobile mode still binds to the phone.'
