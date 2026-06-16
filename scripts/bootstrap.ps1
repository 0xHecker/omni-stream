param(
    [string]$InstallDir,
    [string]$BinDir,
    [string]$RepoUrl,
    [string]$Branch,
    [int]$WebPort = 0,
    [int]$CoordinatorPort = 0,
    [int]$AgentPort = 0,
    [switch]$NoRun,
    [switch]$NoSync
)

$ErrorActionPreference = "Stop"

$script:RequiredPythonMajor = 3
$script:RequiredPythonMinor = 11
$script:PinnedUvVersion = "0.10.4"
$script:PythonCmd = $null
$script:UsingManagedPython = $false
$script:UvPythonVersion = if ($env:OMNI_STREAM_PYTHON) { $env:OMNI_STREAM_PYTHON } else { "3.11" }

$defaultLocalAppData = [Environment]::GetFolderPath("LocalApplicationData")
if ([string]::IsNullOrWhiteSpace($defaultLocalAppData)) {
    $defaultLocalAppData = Join-Path $HOME "AppData\Local"
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
    $InstallDir = if ($env:OMNI_STREAM_INSTALL_DIR) { $env:OMNI_STREAM_INSTALL_DIR } else { Join-Path $defaultLocalAppData "OmniStream" }
}
if ([string]::IsNullOrWhiteSpace($BinDir)) {
    $BinDir = if ($env:OMNI_STREAM_BIN_DIR) { $env:OMNI_STREAM_BIN_DIR } else { Join-Path $defaultLocalAppData "Programs\OmniStream\bin" }
}
if ([string]::IsNullOrWhiteSpace($RepoUrl)) {
    $RepoUrl = if ($env:OMNI_STREAM_REPO_URL) { $env:OMNI_STREAM_REPO_URL } else { "https://github.com/0xHecker/omni-stream.git" }
}
if ([string]::IsNullOrWhiteSpace($Branch)) {
    $Branch = if ($env:OMNI_STREAM_BRANCH) { $env:OMNI_STREAM_BRANCH } else { "master" }
}

function Test-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-PythonVersionTuple {
    param([Parameter(Mandatory = $true)][hashtable]$PythonCmd)
    $out = & $PythonCmd.Exe @($PythonCmd.PrefixArgs + @("-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")) 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }
    $parts = ([string]$out).Trim().Split(".")
    if ($parts.Count -ne 2) {
        return $null
    }
    try {
        return @{ Major = [int]$parts[0]; Minor = [int]$parts[1] }
    } catch {
        return $null
    }
}

function Test-PythonMeetsRequirement {
    param([Parameter(Mandatory = $true)][hashtable]$PythonCmd)
    $version = Get-PythonVersionTuple -PythonCmd $PythonCmd
    if (-not $version) {
        return $false
    }
    return ($version.Major -gt $script:RequiredPythonMajor) -or
        ($version.Major -eq $script:RequiredPythonMajor -and $version.Minor -ge $script:RequiredPythonMinor)
}

function Resolve-PythonCommand {
    if (Test-CommandExists -Name "py") {
        $candidate = @{ Exe = "py"; PrefixArgs = @("-3") }
        if (Test-PythonMeetsRequirement -PythonCmd $candidate) {
            return $candidate
        }
    }
    if (Test-CommandExists -Name "python") {
        $candidate = @{ Exe = "python"; PrefixArgs = @() }
        if (Test-PythonMeetsRequirement -PythonCmd $candidate) {
            return $candidate
        }
    }
    return $null
}

function Invoke-Uv {
    param([Parameter(Mandatory = $true)][string[]]$Args)
    if (Test-CommandExists -Name "uv") {
        & uv @Args
        return
    }
    if ($script:PythonCmd) {
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "uv") + $Args)
        return
    }
    throw "uv is not available."
}

function Ensure-Uv {
    if (Test-CommandExists -Name "uv") {
        return
    }

    if ($script:PythonCmd) {
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "uv", "--version")) *> $null
        if ($LASTEXITCODE -eq 0) {
            return
        }
    }

    Write-Host "uv not found. Attempting install..."
    $installed = $false
    if (Test-CommandExists -Name "winget") {
        try {
            winget install --id astral-sh.uv --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
            $installed = $true
        } catch {
            Write-Host "winget install for uv failed, trying fallback..."
        }
    }

    if (-not $installed -and (Test-CommandExists -Name "choco")) {
        choco install uv --yes --version "$script:PinnedUvVersion"
        $installed = $true
    }

    if (-not $installed -and $script:PythonCmd) {
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "pip", "install", "--upgrade", "pip"))
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "pip", "install", "--user", "--upgrade", "uv==$script:PinnedUvVersion"))
    }

    if (Test-CommandExists -Name "uv") {
        return
    }
    if ($script:PythonCmd) {
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "uv", "--version")) *> $null
        if ($LASTEXITCODE -eq 0) {
            return
        }
    }
    throw "uv installation failed. Install uv manually from https://docs.astral.sh/uv/getting-started/installation/"
}

function Ensure-Python {
    $script:PythonCmd = Resolve-PythonCommand
    if ($script:PythonCmd) {
        return
    }

    Ensure-Uv
    if (Test-CommandExists -Name "uv") {
        Write-Host "System Python not found. Installing uv-managed Python 3.11..."
        Invoke-Uv -Args @("python", "install", "3.11")
        $script:UsingManagedPython = $true
        return
    }

    Write-Host "Python 3.11+ not found. Attempting to install system Python..."
    if (Test-CommandExists -Name "winget") {
        winget install --id Python.Python.3.11 --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
    } elseif (Test-CommandExists -Name "choco") {
        choco install python --yes
    } else {
        throw "Python is not installed and no supported package manager (winget/choco) was found."
    }

    $script:PythonCmd = Resolve-PythonCommand
    if (-not $script:PythonCmd) {
        throw "Python installation finished but python is still not available in PATH. Restart terminal and run this script again."
    }
}

function Sync-Dependencies {
    if ($NoSync) {
        return
    }
    Invoke-Uv -Args @("sync", "--frozen", "--python", "$script:UvPythonVersion")
}

function Test-PortValue {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Value
    )
    if ($Value -lt 1 -or $Value -gt 65535) {
        throw "$Name must be a port from 1 to 65535, got '$Value'."
    }
}

function Get-EnvFileValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key
    )
    if (-not (Test-Path $Path)) {
        return $null
    }
    foreach ($line in Get-Content -Path $Path) {
        if ($line -match "^$([regex]::Escape($Key))=(.*)$") {
            return $Matches[1]
        }
    }
    return $null
}

function Set-EnvFileValue {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Key,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $lines = @()
    $done = $false
    if (Test-Path $Path) {
        foreach ($line in Get-Content -Path $Path) {
            if ($line -match "^$([regex]::Escape($Key))=") {
                $lines += "$Key=$Value"
                $done = $true
            } else {
                $lines += $line
            }
        }
    }
    if (-not $done) {
        $lines += "$Key=$Value"
    }
    $parent = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    Set-Content -Path $Path -Value $lines -Encoding UTF8
}

function Resolve-PortSetting {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$ExplicitValue,
        [Parameter(Mandatory = $true)][string]$EnvName,
        [Parameter(Mandatory = $true)][string]$EnvFile,
        [Parameter(Mandatory = $true)][int]$DefaultValue
    )
    if ($ExplicitValue -gt 0) {
        Test-PortValue -Name $Name -Value $ExplicitValue
        return $ExplicitValue
    }
    $envValue = [Environment]::GetEnvironmentVariable($EnvName)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        $parsed = [int]$envValue
        Test-PortValue -Name $Name -Value $parsed
        return $parsed
    }
    $fileValue = Get-EnvFileValue -Path $EnvFile -Key $EnvName
    if (-not [string]::IsNullOrWhiteSpace($fileValue)) {
        $parsed = [int]$fileValue
        Test-PortValue -Name $Name -Value $parsed
        return $parsed
    }
    return $DefaultValue
}

function Configure-EnvFile {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $envFile = Join-Path $RepoRoot ".env"
    $resolvedWebPort = Resolve-PortSetting -Name "WEB_PORT" -ExplicitValue $WebPort -EnvName "WEB_PORT" -EnvFile $envFile -DefaultValue 5000
    $resolvedCoordinatorPort = Resolve-PortSetting -Name "COORDINATOR_PORT" -ExplicitValue $CoordinatorPort -EnvName "COORDINATOR_PORT" -EnvFile $envFile -DefaultValue 7000
    $resolvedAgentPort = Resolve-PortSetting -Name "AGENT_PORT" -ExplicitValue $AgentPort -EnvName "AGENT_PORT" -EnvFile $envFile -DefaultValue 7001

    Set-EnvFileValue -Path $envFile -Key "STREAM_SERVICE" -Value "all"
    Set-EnvFileValue -Path $envFile -Key "WEB_HOST" -Value "0.0.0.0"
    Set-EnvFileValue -Path $envFile -Key "WEB_PORT" -Value "$resolvedWebPort"
    Set-EnvFileValue -Path $envFile -Key "COORDINATOR_HOST" -Value "0.0.0.0"
    Set-EnvFileValue -Path $envFile -Key "COORDINATOR_PORT" -Value "$resolvedCoordinatorPort"
    Set-EnvFileValue -Path $envFile -Key "AGENT_HOST" -Value "0.0.0.0"
    Set-EnvFileValue -Path $envFile -Key "AGENT_PORT" -Value "$resolvedAgentPort"
}

function Get-PythonFallbackCommand {
    if (-not $script:PythonCmd) {
        return "python"
    }
    if ($script:PythonCmd.Exe -eq "py") {
        return "py -3"
    }
    return $script:PythonCmd.Exe
}

function Install-Launcher {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $launcher = Join-Path $BinDir "omni-stream.cmd"
    $pythonFallback = Get-PythonFallbackCommand
    $content = @"
@echo off
setlocal
cd /d "$RepoRoot"
if not defined UV_PYTHON set "UV_PYTHON=$script:UvPythonVersion"
where uv >nul 2>nul
if %ERRORLEVEL%==0 (
  uv run python omni_stream_cli.py %*
) else (
  $pythonFallback -m uv run python omni_stream_cli.py %*
)
"@
    Set-Content -Path $launcher -Value $content -Encoding ASCII
    Write-Host "Installed launcher: $launcher"
}

function Ensure-Path {
    New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $currentUserPath) {
        $currentUserPath = ""
    }
    $entries = $currentUserPath.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)
    $alreadyPresent = $false
    foreach ($entry in $entries) {
        if ($entry.TrimEnd("\") -ieq $BinDir.TrimEnd("\")) {
            $alreadyPresent = $true
            break
        }
    }

    if (-not $alreadyPresent) {
        $newPath = if ([string]::IsNullOrWhiteSpace($currentUserPath)) { $BinDir } else { "$currentUserPath;$BinDir" }
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-Host "Added $BinDir to the user PATH."
    }

    $envEntries = $env:Path.Split(";", [System.StringSplitOptions]::RemoveEmptyEntries)
    $processHasPath = $false
    foreach ($entry in $envEntries) {
        if ($entry.TrimEnd("\") -ieq $BinDir.TrimEnd("\")) {
            $processHasPath = $true
            break
        }
    }
    if (-not $processHasPath) {
        $env:Path = "$BinDir;$env:Path"
    }
}

function Copy-SourceFromArchive {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    $archiveBase = $RepoUrl
    if ($archiveBase.EndsWith(".git")) {
        $archiveBase = $archiveBase.Substring(0, $archiveBase.Length - 4)
    }
    if ($archiveBase.StartsWith("git@github.com:")) {
        $archiveBase = "https://github.com/" + $archiveBase.Substring("git@github.com:".Length)
    }
    $zipUrl = "$archiveBase/archive/$Branch.zip"

    $tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("omni-stream-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
    try {
        $archive = Join-Path $tempDir "source.zip"
        $extractDir = Join-Path $tempDir "src"
        Write-Host "Downloading $zipUrl"
        Invoke-WebRequest -Uri $zipUrl -OutFile $archive -UseBasicParsing
        Expand-Archive -Path $archive -DestinationPath $extractDir -Force

        $sourceRoot = Get-ChildItem -Path $extractDir -Directory | Select-Object -First 1
        if (-not $sourceRoot) {
            throw "Downloaded archive did not contain a source directory."
        }

        New-Item -ItemType Directory -Force -Path $RepoRoot | Out-Null
        $existing = Get-ChildItem -Path $RepoRoot -Force -ErrorAction SilentlyContinue
        $marker = Join-Path $RepoRoot ".omni-stream-install"
        if ($existing.Count -gt 0 -and -not (Test-Path $marker)) {
            throw "$RepoRoot is not empty and does not look like an Omni Stream install. Choose another directory with -InstallDir."
        }

        Get-ChildItem -Path $RepoRoot -Force |
            Where-Object { $_.Name -ne ".env" } |
            Remove-Item -Recurse -Force
        Get-ChildItem -Path $sourceRoot.FullName -Force |
            Copy-Item -Destination $RepoRoot -Recurse -Force
        New-Item -ItemType File -Force -Path $marker | Out-Null
    } finally {
        Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

function Find-LocalRepo {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        return $null
    }
    $candidate = Resolve-Path (Join-Path $PSScriptRoot "..") -ErrorAction SilentlyContinue
    if ($candidate -and (Test-Path (Join-Path $candidate.Path "pyproject.toml"))) {
        return $candidate.Path
    }
    return $null
}

function Bootstrap-Repo {
    param([Parameter(Mandatory = $true)][string]$RepoRoot)
    Set-Location $RepoRoot
    Ensure-Python
    if ($script:PythonCmd) {
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("--version"))
    } else {
        Write-Host "Using uv-managed Python runtime."
    }
    Ensure-Uv
    Sync-Dependencies
}

$localRepo = Find-LocalRepo
if ($localRepo) {
    Configure-EnvFile -RepoRoot $localRepo
    Bootstrap-Repo -RepoRoot $localRepo
    Install-Launcher -RepoRoot $localRepo
    Ensure-Path
    Write-Host "Bootstrap complete."
    Write-Host "Run 'omni-stream' to start, or 'omni-stream --help' for CLI commands."
    return
}

$resolvedInstallDir = [System.IO.Path]::GetFullPath((New-Item -ItemType Directory -Force -Path $InstallDir).FullName)
Copy-SourceFromArchive -RepoRoot $resolvedInstallDir
Configure-EnvFile -RepoRoot $resolvedInstallDir
Bootstrap-Repo -RepoRoot $resolvedInstallDir
Install-Launcher -RepoRoot $resolvedInstallDir
Ensure-Path

$envFile = Join-Path $resolvedInstallDir ".env"
$webPortValue = Get-EnvFileValue -Path $envFile -Key "WEB_PORT"
Write-Host "Install complete."
Write-Host "Open locally: http://127.0.0.1:$webPortValue/"
Write-Host "Run 'omni-stream' to start, or 'omni-stream --help' for CLI commands."

if (-not $NoRun) {
    Write-Host "Starting Omni Stream. Press Ctrl+C to stop."
    & (Join-Path $BinDir "omni-stream.cmd")
}
