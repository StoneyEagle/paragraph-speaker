<#
Installs the natural voice (Kokoro) for the paragraph-speaker mod, once: a
Python environment with kokoro-onnx, and the two voice model files, each one
checked against its known SHA-256 before it is used. Everything goes into one
folder, %LOCALAPPDATA%\paragraph-speaker; delete that folder to remove it.

Run it from Claude Code by typing   /speak setup
or by hand:   powershell -NoProfile -ExecutionPolicy Bypass -File setup_voice.ps1

Lines it writes, which the mod shows:   step <n>/4 <what>,   error <why>,   done <folder>
#>
param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'paragraph-speaker')
)

# Native commands report through exit codes; each one is checked below.
$ErrorActionPreference = 'Continue'
# Invoke-WebRequest runs many times slower while it draws a progress bar.
$ProgressPreference = 'SilentlyContinue'

$Package = 'kokoro-onnx==0.6.1'   # installs on Python 3.10 to 3.13
$Release = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0'
$Models = @(
    @{ Name = 'kokoro-v1.0.onnx'; Sha256 = '7D5DF8ECF7D4B1878015A32686053FD0EEBE2BC377234608764CC0EF3636A6C5' },
    @{ Name = 'voices-v1.0.bin'; Sha256 = 'BCA610B8308E8D99F32E6FE4197E7EC01679264EFED0CAC9140FE9C29F1FBF7D' }
)

function Write-Step([int]$n, [string]$what) { Write-Output "step $n/4 $what" }
function Stop-Setup([string]$why) { Write-Output "error $why"; exit 1 }

# A Python that kokoro-onnx installs on, as an argument list: 3.12 first, then 3.13, 3.11, 3.10.
function Find-Python {
    $wanted = @('3.12', '3.13', '3.11', '3.10')
    $candidates = New-Object System.Collections.ArrayList
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in $wanted) { [void]$candidates.Add(@('py', "-$v")) }
    }
    foreach ($folder in @("$env:LOCALAPPDATA\Programs\Python", $env:ProgramFiles)) {
        Get-ChildItem -Path $folder -Filter 'Python31*' -Directory -ErrorAction SilentlyContinue | ForEach-Object {
            $exe = Join-Path $_.FullName 'python.exe'
            if (Test-Path $exe) { [void]$candidates.Add(@($exe)) }
        }
    }
    $onPath = Get-Command python -ErrorAction SilentlyContinue
    if ($onPath) { [void]$candidates.Add(@($onPath.Source)) }

    $found = @{}
    foreach ($c in $candidates) {
        $exe = $c[0]
        $rest = @($c | Select-Object -Skip 1)
        $version = $null
        try { $version = (& $exe @rest -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null | Select-Object -First 1) } catch { continue }
        if ($LASTEXITCODE -ne 0 -or $null -eq $version) { continue }
        $version = "$version".Trim()
        if (($wanted -contains $version) -and -not $found.ContainsKey($version)) { $found[$version] = $c }
    }
    foreach ($v in $wanted) { if ($found.ContainsKey($v)) { return , $found[$v] } }
    return $null
}

function Test-Model([string]$path, [string]$sha256) {
    (Test-Path $path) -and ((Get-FileHash -Path $path -Algorithm SHA256).Hash -eq $sha256)
}

# 1. Python
Write-Step 1 'Finding Python'
$python = Find-Python
if ($null -eq $python) {
    Stop-Setup 'Python 3.10 to 3.13 was not found. Install Python 3.12 from https://www.python.org/downloads/ and run /speak setup again.'
}
$pythonExe = $python[0]
$pythonArgs = @($python | Select-Object -Skip 1)

# 2. Its own environment, so nothing is installed into the system Python
$venvPython = Join-Path $InstallDir 'venv\Scripts\python.exe'
Write-Step 2 'Creating the Python environment'
if (-not (Test-Path $venvPython)) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $out = & $pythonExe @pythonArgs -m venv (Join-Path $InstallDir 'venv') 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $venvPython)) {
        Stop-Setup "Could not create the Python environment: $(($out | Select-Object -Last 1))"
    }
}

# 3. The voice engine
Write-Step 3 'Installing the voice engine (kokoro-onnx)'
$out = & $venvPython -m pip install --disable-pip-version-check --quiet $Package 2>&1
if ($LASTEXITCODE -ne 0) {
    Stop-Setup "pip could not install ${Package}: $(($out | Select-Object -Last 1))"
}

# 4. The voice model, checked before use
Write-Step 4 'Downloading the voice model (about 340 MB)'
$modelDir = Join-Path $InstallDir 'models'
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
foreach ($m in $Models) {
    $path = Join-Path $modelDir $m.Name
    if (Test-Model $path $m.Sha256) { continue }
    $part = "$path.part"
    Remove-Item -Force -ErrorAction SilentlyContinue $part
    $url = "$Release/$($m.Name)"
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe -L --fail --silent --show-error --retry 2 -o $part $url 2>$null
        $ok = $LASTEXITCODE -eq 0
    } else {
        try { Invoke-WebRequest -Uri $url -OutFile $part -UseBasicParsing -ErrorAction Stop; $ok = $true } catch { $ok = $false }
    }
    if (-not $ok) { Remove-Item -Force -ErrorAction SilentlyContinue $part; Stop-Setup "Could not download $($m.Name). Check the internet connection and run /speak setup again." }
    if (-not (Test-Model $part $m.Sha256)) {
        Remove-Item -Force -ErrorAction SilentlyContinue $part
        Stop-Setup "$($m.Name) did not match its known checksum, so it was deleted. Run /speak setup again."
    }
    Move-Item -Force -Path $part -Destination $path
}

$out = & $venvPython -I -c 'import kokoro_onnx' 2>&1
if ($LASTEXITCODE -ne 0) { Stop-Setup "The voice engine did not load: $(($out | Select-Object -Last 1))" }

Write-Output "done $InstallDir"
