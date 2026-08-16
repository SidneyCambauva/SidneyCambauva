// Arquivo didatico: funcoes pequenas de seguranca usadas pela SIX.
import crypto from 'node:crypto';

const SCRYPT_KEY_LENGTH = 64;


// Cria um hash seguro da senha usando scrypt e um salt aleatorio.
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString('hex');
  return `scrypt$${salt}$${hash}`;
}


// Compara a senha digitada com o hash salvo sem vazar informacao por tempo de resposta.
export function verifyPassword(password, encoded) {
  const [method, salt, storedHash] = String(encoded || '').split('$');
  if (method !== 'scrypt' || !salt || !storedHash) return false;

  const candidate = crypto.scryptSync(password, salt, SCRYPT_KEY_LENGTH);
  const stored = Buffer.from(storedHash, 'hex');
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}


// Gera tokens aleatorios para sessoes e nomes de arquivos enviados pelo usuario.
export function randomToken() {
  return crypto.randomBytes(32).toString('base64url');
}


// Converte o cabecalho Cookie do navegador em um objeto facil de consultar.
export function parseCookies(cookieHeader = '') {
  const cookies = {};
  for (const part of cookieHeader.split(';')) {
    const [rawKey, ...rawValue] = part.trim().split('=');
    if (!rawKey) continue;
    cookies[rawKey] = decodeURIComponent(rawValue.join('=') || '');
  }
  return cookies;
}


// Monta o cabecalho Set-Cookie com opcoes de seguranca como HttpOnly e SameSite.
export function serializeCookie(name, value, options = {}) {
  const segments = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) segments.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) segments.push(`Expires=${options.expires.toUTCString()}`);
  segments.push(`Path=${options.path || '/'}`);
  segments.push(`SameSite=${options.sameSite || 'Strict'}`);
  if (options.httpOnly !== false) segments.push('HttpOnly');
  if (options.secure) segments.push('Secure');
  return segments.join('; ');
}


// Garante que o cadastro use apenas os dominios institucionais configurados.
export function isAllowedInstitutionalEmail(email, allowedDomains) {
  const normalized = String(email || '').trim().toLowerCase();
  return allowedDomains.some((domain) => normalized.endsWith(`@${domain}`));
}
