// Arquivo didatico: centraliza configuracoes vindas do .env e do ambiente.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');


// Interpreta textos comuns de verdadeiro/falso usados em arquivos .env.
function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'sim', 'on'].includes(String(value).trim().toLowerCase());
}


// Converte portas, limites e duracoes para numero com valor padrao seguro.
function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}


// Resolve caminhos relativos a partir da raiz do projeto, evitando depender da pasta atual do terminal.
function resolveFromRoot(value, fallback) {
  const candidate = value || fallback;
  return path.isAbsolute(candidate) ? candidate : path.resolve(projectRoot, candidate);
}


// Le o arquivo .env manualmente para manter o projeto sem dependencias externas.
export function loadEnvFile(filePath = path.join(projectRoot, '.env'), env = process.env) {
  if (!fs.existsSync(filePath)) return;

  const source = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const equalsAt = line.indexOf('=');
    if (equalsAt === -1) continue;

    const key = line.slice(0, equalsAt).trim();
    let value = line.slice(equalsAt + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && env[key] === undefined) env[key] = value;
  }
}


// Reune todas as configuracoes que o servidor usa em um unico objeto.
export function readConfig(env = process.env) {
  loadEnvFile(path.join(projectRoot, '.env'), env);

  const dataDir = resolveFromRoot(env.SIX_DATA_DIR, './data');
  const dbPath = resolveFromRoot(env.SIX_DB_PATH, path.join(dataDir, 'six.sqlite'));
  const allowedDomains = String(env.SIX_ALLOWED_EMAIL_DOMAINS || 'escola.edu.br')
    .split(',')
    .map((domain) => domain.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);

  return {
    projectRoot,
    publicDir: path.join(projectRoot, 'public'),
    dataDir,
    dbPath,
    host: env.SIX_HOST || '0.0.0.0',
    port: parseNumber(env.SIX_PORT || env.PORT, 3000),
    httpsEnabled: parseBool(env.SIX_HTTPS_ENABLED, false),
    httpsPort: parseNumber(env.SIX_HTTPS_PORT, 3443),
    httpsPfxPath: resolveFromRoot(env.SIX_SSL_PFX_PATH, './certs/six-localhost.pfx'),
    httpsPfxPassphrase: env.SIX_SSL_PFX_PASSPHRASE || '',
    platformName: env.SIX_PLATFORM_NAME || 'SIX',
    schoolName: env.SIX_SCHOOL_NAME || 'Escola',
    allowedDomains,
    sessionDays: parseNumber(env.SIX_SESSION_DAYS, 14),
    maxPostLength: parseNumber(env.SIX_MAX_POST_LENGTH, 560),
    firstUserAdmin: parseBool(env.SIX_FIRST_USER_ADMIN, true),
    secureCookie: parseBool(env.SIX_COOKIE_SECURE, false)
  };
}
