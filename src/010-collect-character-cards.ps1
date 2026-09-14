<#
.SYNOPSIS
第一阶段（010）：从人工指定的来源目录复制 PNG/JSON 到本项目的待分类目录。

.INPUTS
- 必填参数 -SourceDirectory：一个或多个来源目录（仅读取）。
- 可选参数 -Destination：默认 data/未分类角色卡。
- 可选参数 -ReportDirectory：默认 reports/collection。

.OUTPUTS
- 复制后的文件：Destination。原始来源文件不会被移动、删除或改写。
- 每次运行的 CSV 日志：ReportDirectory/collect-character-cards-<时间>.csv。
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string[]]$SourceDirectory,
    [string]$Destination = (Join-Path $PSScriptRoot '..\data\未分类角色卡'),
    [string]$ReportDirectory = (Join-Path $PSScriptRoot '..\reports\collection')
)

$ErrorActionPreference = 'Stop'

$allowedExtensions = @('.png', '.json')
$runId = "$(Get-Date -Format 'yyyyMMdd-HHmmss-fff')-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$records = [System.Collections.Generic.List[object]]::new()

function Get-FileSha256([string]$Path) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (-not (Test-Path -LiteralPath $Destination -PathType Container)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}

foreach ($sourceDirectory in $SourceDirectory) {
    if (-not (Test-Path -LiteralPath $sourceDirectory -PathType Container)) {
        Write-Warning "找不到来源目录，已跳过：$sourceDirectory"
        $records.Add([pscustomobject]@{
            Timestamp = Get-Date -Format 's'; Status = 'source_missing'; Source = $sourceDirectory
            Destination = ''; Detail = '来源目录不存在'
        })
        continue
    }

    Get-ChildItem -LiteralPath $sourceDirectory -File -Recurse | Where-Object {
        $allowedExtensions -contains $_.Extension.ToLowerInvariant()
    } | ForEach-Object {
        $sourceFile = $_
        $destinationFile = Join-Path $Destination $sourceFile.Name

        $status = ''
        $detail = ''

        if (Test-Path -LiteralPath $destinationFile) {
            try {
                $sourceHash = Get-FileSha256 $sourceFile.FullName
                $destinationHash = Get-FileSha256 $destinationFile

                if ($sourceHash -eq $destinationHash) {
                    $records.Add([pscustomobject]@{
                        Timestamp = Get-Date -Format 's'; Status = 'skipped_identical'; Source = $sourceFile.FullName
                        Destination = $destinationFile; Detail = '目标目录已有内容完全相同的文件'
                    })
                    return
                }

                $stem = [System.IO.Path]::GetFileNameWithoutExtension($sourceFile.Name)
                $extension = $sourceFile.Extension
                $shortHash = $sourceHash.Substring(0, 12)
                $versionNumber = 1

                while ($true) {
                    $suffix = if ($versionNumber -eq 1) { "__$shortHash" } else { "__$shortHash-$versionNumber" }
                    $versionedName = "$stem$suffix$extension"
                    $destinationFile = Join-Path $Destination $versionedName

                    if (-not (Test-Path -LiteralPath $destinationFile)) {
                        break
                    }

                    if ((Get-FileSha256 $destinationFile) -eq $sourceHash) {
                        $records.Add([pscustomobject]@{
                            Timestamp = Get-Date -Format 's'; Status = 'skipped_identical'; Source = $sourceFile.FullName
                            Destination = $destinationFile; Detail = '目标目录已有内容完全相同的版本文件'
                        })
                        return
                    }

                    $versionNumber += 1
                }

                $status = 'copied_version'
                $detail = "同名但内容不同，已按不同版本保存为 $versionedName"
            }
            catch {
                $records.Add([pscustomobject]@{
                    Timestamp = Get-Date -Format 's'; Status = 'failed'; Source = $sourceFile.FullName
                    Destination = $destinationFile; Detail = "比较同名文件失败：$($_.Exception.Message)"
                })
                Write-Warning "比较同名文件失败：$($sourceFile.FullName) - $($_.Exception.Message)"
                return
            }
        }

        try {
            if ($PSCmdlet.ShouldProcess($destinationFile, "复制 $($sourceFile.FullName)")) {
                Copy-Item -LiteralPath $sourceFile.FullName -Destination $destinationFile
                if (-not $status) {
                    $status = 'copied'
                }
            }
            else {
                $status = if ($status -eq 'copied_version') { 'would_copy_version' } else { 'would_copy' }
                $detail = if ($detail) { "$detail；WhatIf 模式" } else { 'WhatIf 模式' }
            }
        }
        catch {
            $status = 'failed'
            $detail = $_.Exception.Message
            Write-Warning "复制失败：$($sourceFile.FullName) - $detail"
        }

        $records.Add([pscustomobject]@{
            Timestamp = Get-Date -Format 's'; Status = $status; Source = $sourceFile.FullName
            Destination = $destinationFile; Detail = $detail
        })
    }
}

if (-not (Test-Path -LiteralPath $ReportDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $ReportDirectory -Force | Out-Null
}

$reportPath = Join-Path $ReportDirectory "collect-character-cards-$runId.csv"
$records | Export-Csv -LiteralPath $reportPath -NoTypeInformation -Encoding utf8

$summary = $records | Group-Object Status | Sort-Object Name | ForEach-Object { "$($_.Name): $($_.Count)" }
Write-Host "运行日志：$reportPath"
Write-Host ($summary -join '; ')
