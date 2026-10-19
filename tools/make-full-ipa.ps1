# Adds your own copy of the game (terra/) to the CI-built unsigned IPA, locally.
# Usage: .\tools\make-full-ipa.ps1 -Ipa .\AlabasterDawn.ipa -Game "F:\SteamLibrary\steamapps\common\Alabaster Dawn" [-Out .\AlabasterDawn-full.ipa]
# The output contains the game: personal use only, never upload or share it.
param(
    [Parameter(Mandatory)][string]$Ipa,
    [Parameter(Mandatory)][string]$Game,
    [string]$Out = "AlabasterDawn-full.ipa"
)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$terra = Join-Path $Game "terra"
if (-not (Test-Path (Join-Path $terra "dist\bundle.js"))) { throw "No terra\dist\bundle.js under $Game" }
Copy-Item $Ipa $Out -Force
$zip = [System.IO.Compression.ZipFile]::Open((Resolve-Path $Out), 'Update')
try {
    $base = (Resolve-Path $terra).Path.TrimEnd('\')
    $n = 0
    Get-ChildItem $terra -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($base.Length + 1).Replace('\', '/')
        if ($rel -like 'greenworks/lib/*') { return }
        $entry = "Payload/AlabasterDawn.app/Game/terra/$rel"
        # media is already compressed (ogg/png): store without recompressing
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $entry, 'Fastest')
        $n++
    }
    Write-Host "Added $n files"
} finally { $zip.Dispose() }
Write-Host "Done: $Out ($([math]::Round((Get-Item $Out).Length/1MB)) MB)"
