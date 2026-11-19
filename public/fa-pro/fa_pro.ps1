# Font Awesome Pro Free fetcher - PowerShell Version

$ErrorActionPreference = "Stop"

$Headers = @{
    "Referer" = "https://fontawesome.com"
}
$ApiUrl = "https://api.github.com/repos/FortAwesome/Font-Awesome/releases/latest"

try {
    $LatestRelease = Invoke-RestMethod -Uri $ApiUrl -Headers @{ "Accept" = "application/vnd.github.v3+json" }
    $Version = $LatestRelease.tag_name
} catch {
    Write-Host "Failed to get latest version from GitHub: $_" -ForegroundColor Red
    exit 1
}

Write-Host "Latest Font Awesome Pro version: $Version" -ForegroundColor Green

$CssFiles = @(
    "all.css", "solid.css", "regular.css", "light.css", "thin.css",
    "duotone.css", "duotone-regular.css", "duotone-light.css", "duotone-thin.css",
    "sharp-solid.css", "sharp-regular.css", "sharp-light.css", "sharp-thin.css",
    "sharp-duotone-solid.css", "sharp-duotone-regular.css", "sharp-duotone-light.css", "sharp-duotone-thin.css",
    "brands.css", "chisel-regular.css", "etch-solid.css", "graphite-thin.css",
    "jelly-regular.css", "jelly-duo-regular.css", "jelly-fill-regular.css",
    "mosaic-solid.css", "notdog-solid.css", "notdog-duo-solid.css", "pixel-regular.css",
    "slab-regular.css", "slab-press-regular.css", "slab-duo-regular.css", "slab-press-duo-regular.css",
    "thumbprint-light.css", "utility-semibold.css", "utility-fill-semibold.css", "utility-duo-semibold.css",
    "vellum-solid.css", "whiteboard-semibold.css"
)

$FetchedUrls = @{}

foreach ($CssFile in $CssFiles) {
    $BaseUrl = "https://site-assets.fontawesome.com/releases/v$Version/css/$CssFile"
    $BasePath = Join-Path "css" $CssFile
    
    $BaseDir = Split-Path $BasePath
    if (!(Test-Path $BaseDir)) { New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null }
    
    Write-Host "`n[$CssFile] Fetching $BaseUrl to $BasePath..." -ForegroundColor Cyan
    
    try {
        Invoke-WebRequest -Uri $BaseUrl -Headers $Headers -OutFile $BasePath -UseBasicParsing
    } catch {
        Write-Host "  -> Failed to fetch ${CssFile}: $_" -ForegroundColor Red
        continue
    }

    $Content = Get-Content -Path $BasePath -Raw
    
    # Extract URLs from url(...)
    $Matches = [regex]::Matches($Content, 'url\((.*?)\)')
    
    $UniqueUrls = @()
    foreach ($Match in $Matches) {
        $U = $Match.Groups[1].Value -replace '^["'']', '' -replace '["'']$', ''
        if ($UniqueUrls -notcontains $U) {
            $UniqueUrls += $U
        }
    }
    
    foreach ($U in $UniqueUrls) {
        if ($U.StartsWith("data:")) { continue }
        
        # Handle relative URLs
        $AssetUri = [System.Uri]::new([System.Uri]$BaseUrl, $U)
        $FetchUrl = $AssetUri.AbsoluteUri
        
        if ($FetchedUrls.ContainsKey($FetchUrl)) { continue }
        
        # Determine local file path
        if ($AssetUri.Host -eq "site-assets.fontawesome.com") {
            $UriPrefix = "/releases/v$Version/"
            if ($AssetUri.AbsolutePath.StartsWith($UriPrefix)) {
                $LocalPath = $AssetUri.AbsolutePath.Substring($UriPrefix.Length)
                $OutPath = $LocalPath -replace '/', [IO.Path]::DirectorySeparatorChar
            } else {
                $OutPath = Join-Path "css" ([System.IO.Path]::GetFileName($AssetUri.AbsolutePath))
            }
        } else {
            $OutPath = Join-Path "css" ([System.IO.Path]::GetFileName($AssetUri.AbsolutePath))
        }

        # The OutDir check
        $OutDir = Split-Path $OutPath
        if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
        
        if (!(Test-Path $OutPath)) {
            Write-Host "  -> Fetching asset $FetchUrl to $OutPath..."
            try {
                Invoke-WebRequest -Uri $FetchUrl -Headers $Headers -OutFile $OutPath -UseBasicParsing
                $FetchedUrls[$FetchUrl] = $true
            } catch {
                Write-Host "  -> Failed to fetch asset: $_" -ForegroundColor Red
            }
        } else {
            $FetchedUrls[$FetchUrl] = $true
        }
    }
}
