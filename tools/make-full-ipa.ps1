# Adds your own copies of the games to the CI-built unsigned IPA, locally.
# Usage:
#   .\tools\make-full-ipa.ps1 -Ipa .\AlabasterDawn.ipa `
#       -Alabaster "F:\SteamLibrary\steamapps\common\Alabaster Dawn" `
#       -CrossCode "F:\SteamLibrary\steamapps\common\CrossCode" [-Out .\AlabasterDawn-full.ipa]
# Either game is optional. The output contains the games: personal use only, never upload or share it.
param(
    [Parameter(Mandatory)][string]$Ipa,
    [string]$Alabaster,
    [string]$CrossCode,
    [string]$Out = "AlabasterDawn-full.ipa"
)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (-not $Alabaster -and -not $CrossCode) { throw "Pass -Alabaster and/or -CrossCode" }

function Add-Tree($zip, $srcRoot, $destId, $skipPattern) {
    $base = (Resolve-Path $srcRoot).Path.TrimEnd('\')
    $n = 0
    Get-ChildItem $srcRoot -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/')
        if ($skipPattern -and $rel -like $skipPattern) { return }
        $entry = "Payload/AlabasterDawn.app/Game/$destId/$rel"
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, 'Fastest')
        $n++
    }
    Write-Host "${destId}: added $n files"
}

Copy-Item $Ipa $Out -Force
$zip = [System.IO.Compression.ZipFile]::Open((Resolve-Path $Out), 'Update')
try {
    if ($Alabaster) {
        $t = Join-Path $Alabaster "terra"
        if (-not (Test-Path (Join-Path $t "dist\bundle.js"))) { throw "No terra\dist\bundle.js under $Alabaster" }
        Add-Tree $zip $t "alabaster" 'greenworks/lib/*'
    }
    if ($CrossCode) {
        $a = Join-Path $CrossCode "assets"
        if (-not (Test-Path (Join-Path $a "node-webkit.html"))) { throw "No assets\node-webkit.html under $CrossCode" }
        Add-Tree $zip $a "crosscode" $null
    }
} finally { $zip.Dispose() }
Write-Host "Done: $Out ($([math]::Round((Get-Item $Out).Length/1MB)) MB)"
