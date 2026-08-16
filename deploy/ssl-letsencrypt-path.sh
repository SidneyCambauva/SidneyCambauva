#!/usr/bin/env bash
# Script didatico: automatiza configuracao de servidor, Nginx, DNS ou SSL para a SIX.
set -euo pipefail

DOMAIN="${1:-www.capitao.tec.br}"
EMAIL="${2:-}"
PUBLIC_PATH="${3:-/xis}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"


# Algumas alteracoes mexem em /etc, systemd ou Nginx, por isso precisam de sudo/root.
if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo bash deploy/ssl-letsencrypt-path.sh ${DOMAIN} seu-email@dominio.com ${PUBLIC_PATH}"
  exit 1
fi

if [ -z "${EMAIL}" ]; then
  echo "Informe um e-mail para avisos do certificado:"
  echo "sudo bash deploy/ssl-letsencrypt-path.sh ${DOMAIN} seu-email@dominio.com ${PUBLIC_PATH}"
  exit 1
fi

case "${PUBLIC_PATH}" in
  /*) ;;
  *) PUBLIC_PATH="/${PUBLIC_PATH}" ;;
esac
PUBLIC_PATH="${PUBLIC_PATH%/}"
if [ -z "${PUBLIC_PATH}" ]; then
  PUBLIC_PATH="/"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nao encontrado. Instale Node.js 24+ antes."
  exit 1
fi

echo "Dominio SSL: ${DOMAIN}"
echo "Caminho publico: ${PUBLIC_PATH}"
echo "Projeto: ${PROJECT_DIR}"
echo
echo "Antes de continuar, confirme:"
echo "1. ${DOMAIN} aponta no DNS publico para o IP publico deste servidor."
echo "2. As portas 80 e 443 estao liberadas no roteador/firewall."
echo "3. Se ja existe site em ${DOMAIN}, este Nginx precisa ser o proxy desse dominio."
echo


# Instala pacotes do Ubuntu necessarios para proxy, DNS ou certificados.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx certbot python3-certbot-nginx curl

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
  
# Escreve a configuracao do Nginx que encaminha o dominio para o Node.js.
cat >/etc/nginx/sites-available/six.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 20m;

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
  
# Escreve a configuracao do Nginx que encaminha o dominio para o Node.js.
cat >/etc/nginx/sites-available/six.conf <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    client_max_body_size 20m;

    location = / {
        return 302 ${PUBLIC_PATH}/;
    }

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


# Solicita o certificado valido da Let''s Encrypt e ativa redirecionamento para HTTPS.
certbot --nginx \
  -d "${DOMAIN}" \
  --redirect \
  --agree-tos \
  --non-interactive \
  -m "${EMAIL}"

systemctl reload nginx
systemctl restart six || true
certbot renew --dry-run

echo
echo "OK. HTTPS configurado: https://${DOMAIN}${PUBLIC_PATH}/"
echo "O certificado e do dominio ${DOMAIN}; o caminho publico da SIX e ${PUBLIC_PATH}/."