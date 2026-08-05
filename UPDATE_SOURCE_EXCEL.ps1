$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Add-Type -AssemblyName System.Windows.Forms

$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Выберите новый Excel-источник дашборда'
$dialog.Filter = 'Excel files (*.xlsx)|*.xlsx'
$dialog.Multiselect = $false

if ($dialog.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
    Write-Host 'Файл не выбран.' -ForegroundColor Yellow
    Read-Host 'Нажмите Enter, чтобы закрыть окно'
    exit 0
}

$source = $dialog.FileName
$target = Join-Path $PSScriptRoot 'dashboard_data.xlsx'
$sourceFull = [System.IO.Path]::GetFullPath($source)
$targetFull = [System.IO.Path]::GetFullPath($target)

if ($sourceFull -ieq $targetFull) {
    Write-Host 'Этот файл уже является источником дашборда.' -ForegroundColor Yellow
} else {
    if (Test-Path -LiteralPath $target) {
        $backup = Join-Path $PSScriptRoot ('dashboard_data_backup_' + (Get-Date -Format 'yyyyMMdd_HHmmss') + '.xlsx')
        Copy-Item -LiteralPath $target -Destination $backup -Force
        Write-Host "Создана резервная копия: $backup" -ForegroundColor DarkGray
    }
    Copy-Item -LiteralPath $source -Destination $target -Force
    Write-Host 'Excel-источник обновлён.' -ForegroundColor Green
}

Write-Host 'Формирую локальный data.v207.js...' -ForegroundColor Cyan
& python (Join-Path $PSScriptRoot 'build_data.py')
if ($LASTEXITCODE -ne 0) {
    throw 'Не удалось преобразовать Excel в data.v207.js.'
}

Write-Host 'Проверяю релиз...' -ForegroundColor Cyan
& python (Join-Path $PSScriptRoot 'validate_release.py')
if ($LASTEXITCODE -ne 0) {
    throw 'Проверка релиза завершилась с ошибкой.'
}

Write-Host 'Источник и данные дашборда обновлены и проверены.' -ForegroundColor Green
Write-Host 'Обновите страницу сочетанием Ctrl+F5.'
Read-Host 'Нажмите Enter, чтобы закрыть окно'
