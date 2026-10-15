#!/usr/bin/env pwsh
# install-aliases.ps1 — einmalig ausfuehren.
#
# Legt PowerShell-Funktionen in $PROFILE an, die castel-restart und
# castel-deploy (push-and-redeploy) aufrufen. Idempotent: gleiche
# Funktionen werden ersetzt.
#
# Aufruf:
#   pwsh ./scripts/install-aliases.ps1
#   # danach PowerShell neu starten

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
$ProfileDir = Split-Path -Parent $PROFILE
if (-not (Test-Path $ProfileDir)) { New-Item -ItemType Directory -Path $ProfileDir | Out-Null }
if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE | Out-Null }

$block = @"

# ---- castel helpers (install-aliases.ps1) ----
function castel-restart {
    # Fresh test stack: down -v + pull + up. DB is wiped.
    & "$RepoRoot\scripts\castel-restart.ps1" @args
}
function castel-deploy {
    # git push, wait for GHCR, fresh redeploy.
    $sha = git -C "$RepoRoot" rev-parse HEAD
    git -C "$RepoRoot" push @args
    if ($LASTEXITCODE -ne 0) { throw "git push failed" }
    & "$RepoRoot\scripts\castel-restart.ps1" -WaitForSha $sha -WaitTimeoutSec 300
}
function castel-logs-api {
    docker compose -f "$RepoRoot\docker-compose.yml" logs -f api
}
function castel-status {
    docker compose -f "$RepoRoot\docker-compose.yml" ps
}
# ---- /castel helpers ----

"@

$existing = Get-Content $PROFILE -Raw -ErrorAction SilentlyContinue
# Marker pairs to strip from the profile before writing the new block:
# the current markers plus the legacy markers of the pre-rename install.
$markerPairs = @(
    @("# ---- castel helpers", "# ---- /castel helpers"),
    @("# ---- bma-lager helpers", "# ---- /bma-lager helpers")
)
foreach ($pair in $markerPairs) {
    $startMarker = $pair[0]
    $endMarker = $pair[1]
    if ($existing -and $existing.Contains($startMarker) -and $existing.Contains($endMarker)) {
        $pattern = "(?s)$([regex]::Escape($startMarker)).*?$([regex]::Escape($endMarker))"
        $existing = [regex]::Replace($existing, $pattern, "")
        $existing = $existing.TrimEnd() + "`n`n"
        Write-Host "Entfernt: $startMarker-Block aus $PROFILE" -ForegroundColor DarkGray
    }
}
if ($existing) {
    $new = $existing.TrimEnd() + "`n`n" + $block
    Set-Content -Path $PROFILE -Value $new -NoNewline
    Write-Host "Aliasse in $PROFILE aktualisiert." -ForegroundColor Green
} else {
    Set-Content -Path $PROFILE -Value $block -NoNewline
    Write-Host "Aliasse zu $PROFILE hinzugefuegt." -ForegroundColor Green
}

Write-Host ""
Write-Host "Restart PowerShell, then these are available:" -ForegroundColor Cyan
Write-Host "  castel-restart              fresh stack (down -v + pull + up)" -ForegroundColor Cyan
Write-Host "  castel-deploy               git push + wait for GHCR + redeploy" -ForegroundColor Cyan
Write-Host "  castel-status               docker compose ps" -ForegroundColor Cyan
Write-Host "  castel-logs-api             docker compose logs -f api" -ForegroundColor Cyan