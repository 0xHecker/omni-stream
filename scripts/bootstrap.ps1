param(
    [switch]$NoSync
)

$ErrorActionPreference = "Stop"
$script:PythonCmd = $null
$script:UsingManagedPython = $false

function Test-CommandExists {
    param([Parameter(Mandatory = $true)][string]$Name)
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Resolve-PythonCommand {
    if (Test-CommandExists -Name "py") {
        return @{
            Exe = "py"
            PrefixArgs = @("-3")
        }
    }
    if (Test-CommandExists -Name "python") {
        return @{
            Exe = "python"
            PrefixArgs = @()
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
        choco install uv --yes
        $installed = $true
    }

    if (-not $installed -and $script:PythonCmd) {
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "pip", "install", "--upgrade", "pip"))
        & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("-m", "pip", "install", "--user", "--upgrade", "uv"))
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
    if ($script:UsingManagedPython) {
        Invoke-Uv -Args @("sync", "--python", "3.11")
        return
    }
    Invoke-Uv -Args @("sync")
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

Ensure-Python
if ($script:PythonCmd) {
    & $script:PythonCmd.Exe @($script:PythonCmd.PrefixArgs + @("--version"))
} else {
    Write-Host "Using uv-managed Python runtime."
}
Ensure-Uv

if (-not $NoSync) {
    Sync-Dependencies
}

Write-Host "Bootstrap complete."
if ($NoSync) {
    if ($script:UsingManagedPython) {
        Write-Host "Run 'uv sync --python 3.11' when you are ready."
    } else {
        Write-Host "Run 'uv sync' (or 'py -3 -m uv sync') when you are ready."
    }
}
