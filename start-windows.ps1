# Script didatico: prepara o ambiente no Windows e inicia o servidor SIX.
$ErrorActionPreference = "Stop"


# Garante que os comandos rodem na pasta onde o script esta salvo.
Set-Location -LiteralPath $PSScriptRoot


# Confere se o Node.js esta instalado antes de tentar iniciar o projeto.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "Node.js nao encontrado. Instale o Node.js 24 ou superior."
  exit 1
}


# Cria o .env na primeira execucao usando o exemplo do projeto.
if (-not (Test-Path -LiteralPath ".env")) {
  Copy-Item -LiteralPath ".env.example" -Destination ".env"
  Write-Host "Arquivo .env criado a partir do .env.example."
}


# Garante a existencia da pasta onde ficam banco e uploads.
New-Item -ItemType Directory -Force -Path "data" | Out-Null

$nodeVersion = node -p "process.versions.node"
Write-Host "Node.js $nodeVersion"
Write-Host "SIX iniciando em http://127.0.0.1:3000"
Write-Host "Para parar, pressione Ctrl+C."


# Inicia o servidor Node.js em primeiro plano.
node src/server.js
