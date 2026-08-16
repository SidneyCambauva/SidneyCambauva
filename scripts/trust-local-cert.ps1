# Script didatico da SIX: instala o certificado local usado pelo HTTPS de teste.
# Execute este arquivo em PowerShell como Administrador se o navegador mostrar aviso de certificado.

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$certPath = Join-Path $projectRoot 'certs\six-localhost.cer'

if (-not (Test-Path $certPath)) {
  throw "Certificado nao encontrado em: $certPath"
}

Write-Host "Instalando certificado local da SIX..." -ForegroundColor Cyan
certutil -f -addstore Root $certPath
certutil -user -f -addstore Root $certPath
Write-Host "Certificado instalado. Feche e abra o navegador antes de testar https://localhost:3443" -ForegroundColor Green