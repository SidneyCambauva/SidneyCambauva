#!/usr/bin/env bash
# Script didatico da SIX: prepara uma instancia Ubuntu/AWS para rodar o projeto.
# Uso recomendado, dentro da pasta do projeto:
#   sudo bash deploy/aws-install-deps.sh
# Com dominio e subpasta:
#   sudo bash deploy/aws-install-deps.sh /opt/six www.capitao.tec.br /xis

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTED_PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="${1:-${DETECTED_PROJECT_DIR}}"
DOMAIN="${2:-_}"
PUBLIC_PATH="${3:-/}"
APP_USER="${SIX_APP_USER:-six}"
NODE_MAJOR_REQUIRED="24"
NODE_BIN=""

if [ "$(id -u)" -ne 0 ]; then
  echo "Execute com sudo: sudo bash deploy/aws-install-deps.sh [PASTA_PROJETO] [DOMINIO] [CAMINHO]"
  exit 1
fi

normalize_public_path() {
  local value="$1"
  if [ -z "${value}" ] || [ "${value}" = "/" ]; then
    echo "/"
    return
  fi
  value="/${value#/}"
  echo "${value%/}"
}

PUBLIC_PATH="$(normalize_public_path "${PUBLIC_PATH}")"

echo "== SIX AWS/Ubuntu setup =="
echo "Projeto: ${PROJECT_DIR}"
echo "Dominio Nginx: ${DOMAIN}"
echo "Caminho publico: ${PUBLIC_PATH}"
echo

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  git \
  build-essential \
  sqlite3 \
  nginx \
  ufw \
  unzip \
  tar \
  xz-utils \
  certbot \
  python3-certbot-nginx

install_node_24() {
  if command -v node >/dev/null 2>&1; then
    local current_major
    current_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
    if [ "${current_major}" -ge "${NODE_MAJOR_REQUIRED}" ]; then
      NODE_BIN="$(command -v node)"
      echo "Node.js ja instalado: $(node -v) em ${NODE_BIN}"
      return
    fi
  fi

  echo "Instalando Node.js ${NODE_MAJOR_REQUIRED}.x pelo NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR_REQUIRED}.x" | bash -
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  NODE_BIN="$(command -v node)"
}

install_node_24

NODE_MAJOR="$(${NODE_BIN} -p 'Number(process.versions.node.split(".")[0])')"
if [ "${NODE_MAJOR}" -lt "${NODE_MAJOR_REQUIRED}" ]; then
  echo "Erro: Node.js ${NODE_MAJOR_REQUIRED}+ e necessario. Versao atual: $(${NODE_BIN} -v)"
  exit 1
fi

echo "Node: $(${NODE_BIN} -v)"
echo "NPM: $(npm -v)"

if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --system --create-home --shell /usr/sbin/nologin "${APP_USER}"
fi

mkdir -p "${PROJECT_DIR}"

if [ ! -f "${PROJECT_DIR}/package.json" ]; then
  cat <<MSG

A pasta ${PROJECT_DIR} ainda nao tem package.json.
Envie ou clone o projeto para essa pasta e rode este script novamente.

Exemplo:
  sudo mkdir -p ${PROJECT_DIR}
  sudo chown -R ubuntu:ubuntu ${PROJECT_DIR}
  git clone SEU_REPOSITORIO ${PROJECT_DIR}
  cd ${PROJECT_DIR}
  sudo bash deploy/aws-install-deps.sh ${PROJECT_DIR} ${DOMAIN} ${PUBLIC_PATH}
MSG
  exit 0
fi

cd "${PROJECT_DIR}"

mkdir -p data certs

if [ -f package-lock.json ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

set_env() {
  local key="$1"
  local value="$2"
  touch .env
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '%s=%s\n' "${key}" "${value}" >> .env
  fi
}

set_env SIX_PLATFORM_NAME SIX
set_env SIX_SCHOOL_NAME "Capitao Pedro Monteiro do Amaral"
set_env SIX_ALLOWED_EMAIL_DOMAINS educacao.sp.gov.br,professor.educacao.sp.gov.br
set_env SIX_HOST 127.0.0.1
set_env SIX_PORT 3000
set_env SIX_DATA_DIR ./data
set_env SIX_DB_PATH ./data/six.sqlite
set_env SIX_SESSION_DAYS 14
set_env SIX_MAX_POST_LENGTH 560
set_env SIX_FIRST_USER_ADMIN true
set_env SIX_COOKIE_SECURE false
set_env SIX_HTTPS_ENABLED false

chown -R "${APP_USER}:${APP_USER}" "${PROJECT_DIR}"

cat >/etc/systemd/system/six.service <<SERVICE
[Unit]
Description=SIX Intranet
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_BIN} src/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
User=${APP_USER}
Group=${APP_USER}

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable six
systemctl restart six

if [ "${PUBLIC_PATH}" = "/" ]; then
  cat >/etc/nginx/sites-available/six.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 32m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
else
  cat >/etc/nginx/sites-available/six.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 32m;

    location = ${PUBLIC_PATH} {
        return 301 ${PUBLIC_PATH}/;
    }

    location ${PUBLIC_PATH}/ {
        proxy_pass http://127.0.0.1:3000/;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
fi

ln -sf /etc/nginx/sites-available/six.conf /etc/nginx/sites-enabled/six.conf
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx
systemctl reload nginx

if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
fi

sleep 2
curl -fsS http://127.0.0.1:3000/api/config >/dev/null
curl -fsS -H "Host: ${DOMAIN}" "http://127.0.0.1${PUBLIC_PATH}" >/dev/null

echo
echo "OK. Dependencias instaladas e SIX rodando."
echo "Servico: sudo systemctl status six"
echo "Logs: sudo journalctl -u six -f"
echo "Nginx: sudo nginx -t && sudo systemctl reload nginx"
echo
if [ "${DOMAIN}" = "_" ]; then
  echo "Acesso via IP publico da AWS: http://SEU_IP_PUBLICO${PUBLIC_PATH}"
else
  echo "Acesso: http://${DOMAIN}${PUBLIC_PATH}"
  echo "Para HTTPS valido, depois que o DNS apontar para a AWS:"
  echo "  sudo certbot --nginx -d ${DOMAIN}"
fi

echo
echo "No Security Group da AWS, libere entrada TCP: 22, 80 e 443."