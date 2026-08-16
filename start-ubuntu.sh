#!/usr/bin/env bash
# Script didatico: prepara o ambiente no Ubuntu e inicia o servidor SIX.
set -euo pipefail


# Garante que os comandos rodem na pasta onde o script esta salvo.
cd "$(dirname "$0")"


# Confere se o Node.js esta instalado antes de tentar iniciar o projeto.
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nao encontrado. Instale o Node.js 24 ou superior."
  exit 1
fi


# Cria o .env na primeira execucao usando o exemplo do projeto.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Arquivo .env criado a partir do .env.example."
fi


# Garante a existencia da pasta onde ficam banco e uploads.
mkdir -p data

echo "Node.js $(node -p 'process.versions.node')"
echo "SIX iniciando em http://0.0.0.0:3000"
echo "Para parar, pressione Ctrl+C."


# Inicia o servidor Node.js em primeiro plano.
exec node src/server.js
