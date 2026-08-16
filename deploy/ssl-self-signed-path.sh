#!/usr/bin/env bash
# Script didatico: automatiza configuracao de servidor, Nginx, DNS ou SSL para a SIX.
set -euo pipefail

DOMAIN="${1:-www.capitao.tec.br}"
SERVER_IP="${2:-}"
PUBLIC_PATH="${3:-/xis}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="/etc/ssl/six"


# Algumas alteracoes mexem em /etc, systemd ou Nginx, por isso precisam de sudo/root.
if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo bash deploy/ssl-self-signed-path.sh ${DOMAIN} [IP_DO_SERVIDOR] ${PUBLIC_PATH}"
  exit 1
fi

if [ -z "${SERVER_IP}" ]; then
  SERVER_IP="$(hostname -I | awk '{print $1}')"
fi

case "${PUBLIC_PATH}" in
  /*) ;;
  *) PUBLIC_PATH="/${PUBLIC_PATH}" ;;
esac
PUBLIC_PATH="${PUBLIC_PATH%/}"
if [ -z "${PUBLIC_PATH}" ]; then
  PUBLIC_PATH="/"
fi

if [ -z "${SERVER_IP}" ]; then
  echo "Informe o IP do servidor:"
  echo "sudo bash deploy/ssl-self-signed-path.sh ${DOMAIN} 192.168.0.188 ${PUBLIC_PATH}"
  exit 1
fi


# Instala pacotes do Ubuntu necessarios para proxy, DNS ou certificados.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx openssl curl

mkdir -p "${CERT_DIR}"

# Gera certificado interno para intranet quando nao ha dominio publico validavel.
openssl req -x509 -nodes -newkey rsa:4096 -sha256 -days 825 \
  -keyout "${CERT_DIR}/six.key" \
  -out "${CERT_DIR}/six.crt" \
  -subj "/CN=${DOMAIN}" \
  -addext "subjectAltName=DNS:${DOMAIN},IP:${SERVER_IP}"

cd "${PROJECT_DIR}"
if [ ! -f .env ]; then
  cp .env.example .env
fi


# Atualiza ou cria uma chave no .env sem duplicar linhas.
set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
  else
    printf '\n%s=%s\n' "${key}" "${value}" >> .env
  fi
}

set_env SIX_HOST 127.0.0.1
set_env SIX_PORT 3000
set_env SIX_COOKIE_SECURE true
set_env SIX_PUBLIC_URL "https://${DOMAIN}${PUBLIC_PATH}"

if [ "${PUBLIC_PATH}" = "/" ]; then
  LOCATION_BLOCK="location / { proxy_pass http://127.0.0.1:3000; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }"
else
  LOCATION_BLOCK="location = / { return 302 ${PUBLIC_PATH}/; } location = ${PUBLIC_PATH} { return 301 ${PUBLIC_PATH}/; } location ${PUBLIC_PATH}/ { proxy_pass http://127.0.0.1:3000/; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; }"
fi


# Escreve a configuracao do Nginx que encaminha o dominio para o Node.js.
cat >/etc/nginx/sites-available/six.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name ${DOMAIN};

    ssl_certificate ${CERT_DIR}/six.crt;
    ssl_certificate_key ${CERT_DIR}/six.key;

    client_max_body_size 20m;

    ${LOCATION_BLOCK}
}
NGINX

ln -sf /etc/nginx/sites-available/six.conf /etc/nginx/sites-enabled/six.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
systemctl daemon-reload
systemctl restart six || true


# Se o firewall UFW estiver ativo, libera as portas necessarias.
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi

echo
echo "OK. Certificado interno configurado: https://${DOMAIN}${PUBLIC_PATH}/"
echo "Aviso: navegadores vao mostrar alerta ate voce confiar no certificado ${CERT_DIR}/six.crt."