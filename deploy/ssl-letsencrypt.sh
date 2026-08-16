#!/usr/bin/env bash
# Script didatico: automatiza configuracao de servidor, Nginx, DNS ou SSL para a SIX.
set -euo pipefail

DOMAIN="${1:-www.xis.com.br}"
EMAIL="${2:-}"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"


# Algumas alteracoes mexem em /etc, systemd ou Nginx, por isso precisam de sudo/root.
if [ "$(id -u)" -ne 0 ]; then
  echo "Execute como root: sudo bash deploy/ssl-letsencrypt.sh ${DOMAIN} seu-email@dominio.com"
  exit 1
fi

if [ -z "${EMAIL}" ]; then
  echo "Informe um e-mail para avisos do certificado:"
  echo "sudo bash deploy/ssl-letsencrypt.sh ${DOMAIN} seu-email@dominio.com"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js nao encontrado. Instale Node.js 24+ antes."
  exit 1
fi

echo "Dominio: ${DOMAIN}"
echo "Projeto: ${PROJECT_DIR}"
echo

echo "Antes de continuar, confirme:"
echo "1. O dominio ${DOMAIN} aponta no DNS publico para o IP publico deste servidor."
echo "2. As portas 80 e 443 estao liberadas no modem/firewall."
echo "3. A SIX ja responde por http://${DOMAIN} ou pelo IP do servidor."
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
echo "OK. HTTPS configurado: https://${DOMAIN}"
echo "Renovacao automatica: systemd timer/cron do certbot."