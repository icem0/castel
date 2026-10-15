#!/usr/bin/env pwsh
# castel-restart.ps1 — Fresh test stack.
#
# Always drops the data volume (castel_pgdata) and restarts with the
# latest GHCR images, so every run is a clean *from-scratch* test:
# fresh DB, no admin -> PWA shows the setup form.
#
# This script is intended for LOCAL TESTING only. For production /
# live use, run `docker compose down && docker compose pull &&
# docker compose up -d` directly against the base docker-compose.yml
# WITHOUT this wrapper and WITHOUT docker-compose.override.yml (see
# the comment at the top of that file).
#
# Photo data under ./.data/fotos survives every restart (bind mount,
# not a named volume -> untouched by `down -v`).
#
# Aufruf:
#   powershell -File ./scripts/castel-restart.ps1
#   powershell -File ./scripts/castel-restart.ps1 -WaitForSha 82877e68... -WaitTimeoutSec 300
#
# Parameter:
#   -WaitForSha <sha>   Wait until the GHCR images for this SHA are
#                       available (docker buildx imagetools inspect),
#                       then restart. Practical directly after
#                       'git push' for auto-redeploy.
#   -WaitTimeoutSec <n> Timeout for -WaitForSha (default 60).
#   -SkipPull           Skip `docker compose pull`.
#
# Prerequisite: Docker Desktop (provides `docker buildx imagetools`
# for the GHCR check) and WSL 2.

param(
    [string]$WaitForSha = "",
    [int]$WaitTimeoutSec = 60,
    [switch]$SkipPull
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Repo-Root bestimmen (Verzeichnis mit docker-compose.yml).
$RepoRoot = (Resolve-Path "$PSScriptRoot/..").Path
Set-Location $RepoRoot

function Get-GhcrDigest {
    # Liefert den sha256-Digest des :latest-Manifests ueber
    # `docker buildx imagetools inspect` (das in Docker Desktop
    # enthalten ist). Bei Fehler: $null.
    param([string]$Image)

    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $out = docker buildx imagetools inspect "ghcr.io/icem0/${Image}:latest" 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        # Ausgabe parsen: Zeile "Digest:    sha256:..."
        foreach ($line in $out) {
            if ($line -match "^\s*Digest:\s*(sha256:\S+)") {
                return $Matches[1]
            }
        }
        return $null
    } catch {
        return $null
    } finally {
        $ErrorActionPreference = $oldEap
    }
}

function Test-GhcrManifest {
    # Prueft, ob ein bestimmter Tag am GHCR-Image existiert.
    # Strategie: docker buildx imagetools inspect gibt 0 zurueck,
    # wenn der Tag existiert, != 0 sonst.
    param([string]$Image, [string]$Tag)

    $oldEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $null = docker buildx imagetools inspect "ghcr.io/icem0/${Image}:${Tag}" 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $oldEap
    }
}

if ($WaitForSha) {
    Write-Host "[castel] Warte auf GHCR-Images fuer SHA $WaitForSha..." -ForegroundColor Cyan

    # Strategie: GHCR rewritet SHA-Tags nicht zuverlaessig. Wir pollen
    # daher auf den Digest von :latest und warten, bis sich der Digest
    # aendert ODER das SHA-Tag erreichbar wird (was je nach GHCR-
    # Verhalten eines von beidem zuerst eintrifft).

    $beforeApi = Get-GhcrDigest -Image "castel-api"
    $beforePwa = Get-GhcrDigest -Image "castel-pwa"
    $deadline = (Get-Date).AddSeconds($WaitTimeoutSec)
    $readyApi = $false
    $readyPwa = $false
    while ((Get-Date) -lt $deadline) {
        if (-not $readyApi) {
            $digest = Get-GhcrDigest -Image "castel-api"
            if ($digest -and $digest -ne $beforeApi) {
                $readyApi = $true
                Write-Host "  api :latest digest geaendert -> $digest" -ForegroundColor DarkGray
            } elseif (Test-GhcrManifest -Image "castel-api" -Tag $WaitForSha) {
                $readyApi = $true
                Write-Host "  api :$WaitForSha erreichbar" -ForegroundColor DarkGray
            }
        }
        if (-not $readyPwa) {
            $digest = Get-GhcrDigest -Image "castel-pwa"
            if ($digest -and $digest -ne $beforePwa) {
                $readyPwa = $true
                Write-Host "  pwa :latest digest geaendert -> $digest" -ForegroundColor DarkGray
            } elseif (Test-GhcrManifest -Image "castel-pwa" -Tag $WaitForSha) {
                $readyPwa = $true
                Write-Host "  pwa :$WaitForSha erreichbar" -ForegroundColor DarkGray
            }
        }
        if ($readyApi -and $readyPwa) { break }
        Write-Host "  warte... (api=$readyApi, pwa=$readyPwa)" -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
    if (-not ($readyApi -and $readyPwa)) {
        throw "GHCR-Images fuer SHA $WaitForSha nach $WaitTimeoutSec s nicht verfuegbar. Build noch nicht durch? Siehe .github/workflows/build-and-push.yml."
    }
    Write-Host "  beide Images verfuegbar." -ForegroundColor Green
}

Write-Host "[castel] Stopping stack and removing the data volume (fresh test)..." -ForegroundColor Cyan
docker compose down -v | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker compose down -v failed" }

if (-not $SkipPull) {
    Write-Host "[castel] Pulling latest images from GHCR..." -ForegroundColor Cyan
    docker compose pull | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker compose pull failed" }
} else {
    Write-Host "[castel] Skipping pull (-SkipPull)." -ForegroundColor DarkGray
}

Write-Host "[castel] Starting stack..." -ForegroundColor Cyan
docker compose up -d | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker compose up -d failed" }

Write-Host "[castel] Waiting for healthchecks..." -ForegroundColor Cyan
Start-Sleep -Seconds 20

Write-Host "[castel] Status:" -ForegroundColor Cyan
docker compose ps

Write-Host "[castel] API health (direct):" -ForegroundColor Cyan
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:4242/api/healthz" -UseBasicParsing -TimeoutSec 5
    Write-Host "  HTTP $($resp.StatusCode)"
} catch {
    Write-Host "  not reachable: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "[castel] Setup status (should be setupRequired:true):" -ForegroundColor Cyan
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:4242/api/auth/setup-status" -UseBasicParsing -TimeoutSec 5
    Write-Host "  $($resp.Content)"
} catch {
    Write-Host "  not reachable: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "[castel] Done. PWA: http://localhost:4280  API: http://localhost:4242" -ForegroundColor Green