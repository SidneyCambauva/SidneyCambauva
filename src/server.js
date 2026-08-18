// Arquivo didatico: servidor HTTP da SIX, com API, autenticacao, feed, uploads e moderacao.
import http from 'node:http';
import https from 'node:https';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashPassword, isAllowedInstitutionalEmail, parseCookies, randomToken, serializeCookie, verifyPassword } from './auth.js';
import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { rankFeedRows } from './ranking.js';

const SESSION_COOKIE = 'six_session';
const JSON_LIMIT_BYTES = 28 * 1024 * 1024;
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;
const ROLES = new Set(['student', 'teacher', 'admin']);
const MAX_PROFILE_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_POST_IMAGES = 4;
const ONLINE_WINDOW_SECONDS = 120;
const PRESENCE_TOUCH_SECONDS = 30;
const IMAGE_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);


// Erro HTTP controlado: permite responder 400, 401, 403 etc. sem cair como erro interno.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}


// Cria a aplicacao completa: configuracao, banco, rotas e servidor HTTP nativo do Node.js.
export function createApp(options = {}) {
  const config = options.config || readConfig(options.env || process.env);
  const db = options.db || createDatabase(config);
  const routes = buildRoutes();

  const handler = (req, res) => {
    handleRequest(req, res, { config, db, routes }).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = status === 500 ? 'Erro interno da SIX.' : error.message;
      if (status === 500) console.error(error);
      sendJson(res, status, { error: message });
    });
  };

  const server = http.createServer(handler);
  const httpsServer = config.httpsEnabled
    ? https.createServer(readHttpsOptions(config), handler)
    : null;

  return { config, db, server, httpsServer };
}


// Le o certificado local quando o modo HTTPS estiver ativado no .env.
function readHttpsOptions(config) {
  if (!config.httpsPfxPath || !fsSync.existsSync(config.httpsPfxPath)) {
    throw new Error(`Certificado HTTPS nao encontrado: ${config.httpsPfxPath}`);
  }

  const options = { pfx: fsSync.readFileSync(config.httpsPfxPath) };
  if (config.httpsPfxPassphrase) options.passphrase = config.httpsPfxPassphrase;
  return options;
}


// Decide se a requisicao e arquivo estatico ou API, identifica o usuario logado e chama a rota correta.
async function handleRequest(req, res, state) {
  const protocol = req.socket.encrypted ? 'https' : 'http';
  const url = new URL(req.url || '/', `${protocol}://${req.headers.host || 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(url, res, state.config);
    return;
  }

  const match = matchRoute(state.routes, req.method || 'GET', url.pathname);
  if (!match) throw new HttpError(404, 'Rota nao encontrada.');

  const user = getSessionUser(req, state.db);
  touchUserPresence(state.db, user);
  const ctx = { ...state, req, res, url, user, params: match.params };
  await match.handler(ctx);
}


// Registra todas as rotas da API. Cada add() liga metodo + caminho a uma funcao handler.
function buildRoutes() {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, segments: splitPath(pattern), handler });


  // Configuracoes publicas que o navegador precisa para montar a interface.
  add('GET', '/api/config', ({ config, res }) => {
    sendJson(res, 200, {
      platformName: config.platformName,
      schoolName: config.schoolName,
      allowedDomains: config.allowedDomains,
      maxPostLength: config.maxPostLength
    });
  });


  // Cadastro: valida nome, usuario, e-mail institucional e define a primeira conta como admin.
  add('POST', '/api/auth/register', async (ctx) => {
    const body = await readJson(ctx.req);
    const displayName = cleanText(body.displayName, 60);
    const username = String(body.username || '').trim().toLowerCase();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');

    if (displayName.length < 2) throw new HttpError(400, 'Informe um nome com pelo menos 2 caracteres.');
    if (!USERNAME_PATTERN.test(username)) throw new HttpError(400, 'Use um usuario com 3 a 24 letras, numeros ou underscore.');
    if (!isAllowedInstitutionalEmail(email, ctx.config.allowedDomains)) {
      throw new HttpError(400, `Use um e-mail institucional: ${ctx.config.allowedDomains.map((domain) => `@${domain}`).join(', ')}.`);
    }
    if (password.length < 8) throw new HttpError(400, 'A senha precisa ter pelo menos 8 caracteres.');

    const userCount = ctx.db.prepare('SELECT COUNT(*) AS total FROM users').get().total;
    const role = userCount === 0 && ctx.config.firstUserAdmin ? 'admin' : 'student';

    try {
      const result = ctx.db.prepare(`
        INSERT INTO users (display_name, username, email, role, password_hash, last_seen_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(displayName, username, email, role, hashPassword(password));

      const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(result.lastInsertRowid));
      createSession(ctx, user.id);
      sendJson(ctx.res, 201, { user: selfUserShape(user) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) {
        throw new HttpError(409, 'Usuario ou e-mail ja cadastrado.');
      }
      throw error;
    }
  });


  // Login: aceita usuario ou e-mail, confere senha e cria o cookie de sessao.
  add('POST', '/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const login = String(body.login || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = ctx.db.prepare(`
      SELECT * FROM users
      WHERE lower(username) = ? OR lower(email) = ?
      LIMIT 1
    `).get(login, login);

    if (!user || !verifyPassword(password, user.password_hash)) {
      throw new HttpError(401, 'Credenciais invalidas.');
    }
    if (user.suspended_at) throw new HttpError(403, 'Esta conta esta suspensa.');

    createSession(ctx, user.id);
    touchUserPresence(ctx.db, user, true);
    sendJson(ctx.res, 200, { user: selfUserShape(user) });
  });


  // Logout: apaga a sessao do banco e expira o cookie no navegador.
  add('POST', '/api/auth/logout', (ctx) => {
    const token = parseCookies(ctx.req.headers.cookie || '')[SESSION_COOKIE];
    const session = token ? ctx.db.prepare('SELECT user_id FROM sessions WHERE id = ?').get(token) : null;
    if (token) ctx.db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    if (session?.user_id && !ctx.db.prepare('SELECT 1 FROM sessions WHERE user_id = ? LIMIT 1').get(session.user_id)) {
      ctx.db.prepare("UPDATE users SET last_seen_at = datetime('now', ?) WHERE id = ?").run(`-${ONLINE_WINDOW_SECONDS + 1} seconds`, session.user_id);
    }
    ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, expires: new Date(0), secure: ctx.config.secureCookie }));
    sendJson(ctx.res, 200, { ok: true });
  });


  // Retorna quem esta logado; se nao houver sessao, responde user:null.
  add('GET', '/api/me', (ctx) => {
    if (!ctx.user) {
      sendJson(ctx.res, 200, { user: null });
      return;
    }
    sendJson(ctx.res, 200, { user: selfUserShape(ctx.user) });
  });


  // Atualiza perfil, bio, foto e capa do usuario autenticado.
  add('PATCH', '/api/me', async (ctx) => {
    requireAuth(ctx);
    const body = await readJson(ctx.req);
    const displayName = cleanText(body.displayName ?? ctx.user.display_name, 60);
    const bio = cleanText(body.bio ?? ctx.user.bio, 240);
    let avatarUrl = cleanUrl(body.avatarUrl ?? ctx.user.avatar_url);
    let bannerUrl = cleanUrl(body.bannerUrl ?? ctx.user.banner_url);

    if (body.removeAvatar) avatarUrl = '';
    if (body.removeBanner) bannerUrl = '';
    if (body.avatarDataUrl) avatarUrl = await saveProfileImage(ctx.config, ctx.user.id, 'avatar', body.avatarDataUrl);
    if (body.bannerDataUrl) bannerUrl = await saveProfileImage(ctx.config, ctx.user.id, 'banner', body.bannerDataUrl);

    if (displayName.length < 2) throw new HttpError(400, 'Informe um nome com pelo menos 2 caracteres.');

    ctx.db.prepare(`
      UPDATE users
      SET display_name = ?, bio = ?, avatar_url = ?, banner_url = ?
      WHERE id = ?
    `).run(displayName, bio, avatarUrl, bannerUrl, ctx.user.id);

    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    sendJson(ctx.res, 200, { user: selfUserShape(user) });
  });


  // Feed recomendado: busca posts visiveis e passa pelo ranking antes de enviar ao aluno.
  add('GET', '/api/feed', (ctx) => {
    requireAuth(ctx);
    const limit = clampNumber(ctx.url.searchParams.get('limit'), 1, 80, 40);
    const offset = clampNumber(ctx.url.searchParams.get('offset'), 0, 10000, 0);
    const rows = fetchPosts(ctx.db, `
      WHERE p.deleted_at IS NULL
        AND p.parent_id IS NULL
        AND (p.repost_of_id IS NULL OR op.deleted_at IS NULL)
        ${postVisibilitySql(ctx.user)}
      ORDER BY p.created_at DESC
      LIMIT 240
    `, [], ctx.user.id);
    const ranked = rankFeedRows(rows).slice(offset, offset + limit);
    sendJson(ctx.res, 200, { posts: ranked, nextOffset: offset + ranked.length });
  });


  // Criacao de publicacao: aceita texto, resposta e ate quatro imagens de 4 MB cada.
  add('POST', '/api/posts', async (ctx) => {
    requireAuth(ctx);
    const body = await readJson(ctx.req);
    const postBody = cleanText(body.body, ctx.config.maxPostLength);
    const parentId = body.parentId ? Number(body.parentId) : null;
    const images = parsePostImages(body.imageDataUrls);

    if (!postBody && images.length === 0) throw new HttpError(400, 'Escreva algo ou adicione uma imagem antes de publicar.');
    if (postBody.length > ctx.config.maxPostLength) throw new HttpError(400, `O limite e ${ctx.config.maxPostLength} caracteres.`);

    let parent = null;
    if (parentId) {
      parent = ctx.db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(parentId);
      if (!parent) throw new HttpError(404, 'Publicacao original nao encontrada.');
    }

    const result = ctx.db.prepare(`
      INSERT INTO posts (author_id, body, parent_id)
      VALUES (?, ?, ?)
    `).run(ctx.user.id, postBody, parentId);

    const postId = Number(result.lastInsertRowid);
    try {
      if (images.length) await savePostMedia(ctx.config, ctx.db, ctx.user.id, postId, images);
    } catch (error) {
      ctx.db.prepare('DELETE FROM posts WHERE id = ?').run(postId);
      throw error;
    }

    if (parent) {
      notify(ctx.db, parent.author_id, ctx.user.id, 'reply', 'post', postId, `${ctx.user.display_name} respondeu sua publicacao.`);
    }

    const post = fetchPosts(ctx.db, 'WHERE p.id = ?', [postId], ctx.user.id)[0];
    sendJson(ctx.res, 201, { post });
  });


  // Conversa de um post: carrega a publicacao raiz e suas respostas.
  add('GET', '/api/posts/:id/thread', (ctx) => {
    requireAuth(ctx);
    const id = intParam(ctx, 'id');
    const target = ctx.db.prepare('SELECT id, parent_id FROM posts WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!target) throw new HttpError(404, 'Publicacao nao encontrada.');
    const rootId = target.parent_id || target.id;
    if (ctx.user.role !== 'admin' && (hasPendingDeletionRequest(ctx.db, target.id) || hasPendingDeletionRequest(ctx.db, rootId))) {
      throw new HttpError(404, 'Publicacao em revisao pelo admin.');
    }
    const posts = fetchPosts(ctx.db, `
      WHERE p.deleted_at IS NULL
        AND (p.id = ? OR p.parent_id = ?)
        AND (p.repost_of_id IS NULL OR op.deleted_at IS NULL)
        ${postVisibilitySql(ctx.user)}
      ORDER BY p.created_at ASC
    `, [rootId, rootId], ctx.user.id);
    sendJson(ctx.res, 200, { posts });
  });


  // Curtir: grava uma curtida no post original e notifica o autor.
  add('POST', '/api/posts/:id/like', (ctx) => {
    requireAuth(ctx);
    const target = getActionTarget(ctx.db, intParam(ctx, 'id'), ctx.user);
    ctx.db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(ctx.user.id, target.id);
    notify(ctx.db, target.author_id, ctx.user.id, 'like', 'post', target.id, `${ctx.user.display_name} curtiu sua publicacao.`);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Remover curtida do usuario atual.
  add('DELETE', '/api/posts/:id/like', (ctx) => {
    requireAuth(ctx);
    const target = getActionTarget(ctx.db, intParam(ctx, 'id'), ctx.user);
    ctx.db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(ctx.user.id, target.id);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Repost: cria uma publicacao vazia apontando para o post original.
  add('POST', '/api/posts/:id/repost', (ctx) => {
    requireAuth(ctx);
    const target = getActionTarget(ctx.db, intParam(ctx, 'id'), ctx.user);
    const existing = ctx.db.prepare(`
      SELECT id FROM posts
      WHERE author_id = ? AND repost_of_id = ? AND deleted_at IS NULL
    `).get(ctx.user.id, target.id);

    if (!existing) {
      ctx.db.prepare('INSERT INTO posts (author_id, body, repost_of_id) VALUES (?, ?, ?)').run(ctx.user.id, '', target.id);
      notify(ctx.db, target.author_id, ctx.user.id, 'repost', 'post', target.id, `${ctx.user.display_name} repostou sua publicacao.`);
    }

    sendJson(ctx.res, 200, { ok: true });
  });


  // Desfaz o repost feito pelo usuario atual.
  add('DELETE', '/api/posts/:id/repost', (ctx) => {
    requireAuth(ctx);
    const target = getActionTarget(ctx.db, intParam(ctx, 'id'), ctx.user);
    ctx.db.prepare(`
      DELETE FROM posts
      WHERE author_id = ? AND repost_of_id = ?
    `).run(ctx.user.id, target.id);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Denuncia: envia o post para revisao de professores e administradores.
  add('POST', '/api/posts/:id/report', async (ctx) => {
    requireAuth(ctx);
    const postId = intParam(ctx, 'id');
    const body = await readJson(ctx.req);
    const reason = cleanText(body.reason || 'Revisao solicitada', 80);
    const details = cleanText(body.details || '', 500);
    const post = ctx.db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
    if (!post) throw new HttpError(404, 'Publicacao nao encontrada.');

    ctx.db.prepare(`
      INSERT INTO reports (reporter_id, post_id, reason, details)
      VALUES (?, ?, ?, ?)
    `).run(ctx.user.id, postId, reason, details);

    notifyRoles(ctx.db, ['teacher', 'admin'], ctx.user.id, 'report', 'post', postId, `${ctx.user.display_name} enviou uma denuncia para revisao.`);
    sendJson(ctx.res, 201, { ok: true });
  });


  // Pedido de exclusao: esconde o post dos alunos ate o admin aprovar ou rejeitar.
  add('POST', '/api/posts/:id/deletion-request', async (ctx) => {
    requireAuth(ctx);
    const postId = intParam(ctx, 'id');
    const body = await readJson(ctx.req);
    const reason = cleanText(body.reason || 'Solicitacao de exclusao', 300);
    const post = ctx.db.prepare('SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
    if (!post) throw new HttpError(404, 'Publicacao nao encontrada.');
    if (post.author_id !== ctx.user.id && !isStaff(ctx.user)) {
      throw new HttpError(403, 'Voce so pode solicitar exclusao do proprio conteudo.');
    }

    const pending = ctx.db.prepare(`
      SELECT id FROM deletion_requests
      WHERE requester_id = ? AND post_id = ? AND status = 'pending'
    `).get(ctx.user.id, postId);
    if (!pending) {
      ctx.db.prepare(`
        INSERT INTO deletion_requests (requester_id, post_id, reason)
        VALUES (?, ?, ?)
      `).run(ctx.user.id, postId, reason);
      notifyRoles(ctx.db, ['admin'], ctx.user.id, 'delete_request', 'post', postId, `${ctx.user.display_name} pediu autorizacao para excluir uma publicacao.`);
    }

    sendJson(ctx.res, 201, { ok: true });
  });


  // Lista usuarios para busca, sugestoes e envio de mensagens.
  add('GET', '/api/users', (ctx) => {
    requireAuth(ctx);
    const q = cleanText(ctx.url.searchParams.get('q') || '', 80);
    const like = `%${q}%`;
    const rows = ctx.db.prepare(`
      SELECT u.*,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS followed_by_me,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS follower_count,
        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count
      FROM users u
      WHERE u.suspended_at IS NULL
        AND (? = '' OR u.display_name LIKE ? OR u.username LIKE ?)
      ORDER BY followed_by_me DESC, u.display_name ASC
      LIMIT 30
    `).all(ctx.user.id, q, like, like);
    sendJson(ctx.res, 200, { users: rows.map((row) => publicUserShape(row)) });
  });


  // Perfil publico: dados do usuario e publicacoes visiveis para quem esta olhando.
  add('GET', '/api/users/:username', (ctx) => {
    requireAuth(ctx);
    const username = String(ctx.params.username || '').trim().toLowerCase();
    const user = ctx.db.prepare(`
      SELECT u.*,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS followed_by_me,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS follower_count,
        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count
      FROM users u
      WHERE lower(u.username) = ?
      LIMIT 1
    `).get(ctx.user.id, username);
    if (!user || user.suspended_at) throw new HttpError(404, 'Perfil nao encontrado.');

    const posts = fetchPosts(ctx.db, `
      WHERE p.deleted_at IS NULL
        AND p.author_id = ?
        AND (p.repost_of_id IS NULL OR op.deleted_at IS NULL)
        ${postVisibilitySql(ctx.user)}
      ORDER BY p.created_at DESC
      LIMIT 80
    `, [user.id], ctx.user.id);
    sendJson(ctx.res, 200, { user: publicUserShape(user), posts });
  });


  // Seguir usuario: cria a relacao follower/following e gera notificacao.
  add('POST', '/api/users/:id/follow', (ctx) => {
    requireAuth(ctx);
    const followingId = intParam(ctx, 'id');
    if (followingId === ctx.user.id) throw new HttpError(400, 'Voce nao pode seguir a propria conta.');
    const user = ctx.db.prepare('SELECT id, display_name FROM users WHERE id = ? AND suspended_at IS NULL').get(followingId);
    if (!user) throw new HttpError(404, 'Usuario nao encontrado.');

    ctx.db.prepare('INSERT OR IGNORE INTO follows (follower_id, following_id) VALUES (?, ?)').run(ctx.user.id, followingId);
    notify(ctx.db, followingId, ctx.user.id, 'follow', 'user', ctx.user.id, `${ctx.user.display_name} comecou a seguir voce.`);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Deixar de seguir usuario.
  add('DELETE', '/api/users/:id/follow', (ctx) => {
    requireAuth(ctx);
    const followingId = intParam(ctx, 'id');
    ctx.db.prepare('DELETE FROM follows WHERE follower_id = ? AND following_id = ?').run(ctx.user.id, followingId);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Busca simples por usuarios e publicacoes, respeitando posts em revisao.
  add('GET', '/api/search', (ctx) => {
    requireAuth(ctx);
    const q = cleanText(ctx.url.searchParams.get('q') || '', 80);
    if (q.length < 2) {
      sendJson(ctx.res, 200, { posts: [], users: [] });
      return;
    }
    const like = `%${q}%`;
    const users = ctx.db.prepare(`
      SELECT u.*,
        EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.following_id = u.id) AS followed_by_me,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS follower_count,
        (SELECT COUNT(*) FROM follows f WHERE f.follower_id = u.id) AS following_count
      FROM users u
      WHERE u.suspended_at IS NULL AND (u.display_name LIKE ? OR u.username LIKE ?)
      ORDER BY u.display_name ASC
      LIMIT 12
    `).all(ctx.user.id, like, like);
    const posts = fetchPosts(ctx.db, `
      WHERE p.deleted_at IS NULL
        AND p.body LIKE ?
        AND (p.repost_of_id IS NULL OR op.deleted_at IS NULL)
        ${postVisibilitySql(ctx.user)}
      ORDER BY p.created_at DESC
      LIMIT 40
    `, [like], ctx.user.id);
    sendJson(ctx.res, 200, { users: users.map((row) => publicUserShape(row)), posts });
  });

  // Contadores leves para pontos vermelhos de avisos e mensagens no menu.
  add('GET', '/api/unread-counts', (ctx) => {
    requireAuth(ctx);
    const notifications = ctx.db.prepare(`
      SELECT COUNT(*) AS total
      FROM notifications
      WHERE user_id = ? AND read_at IS NULL
    `).get(ctx.user.id).total;
    const messages = ctx.db.prepare(`
      SELECT COUNT(*) AS total
      FROM messages
      WHERE recipient_id = ? AND read_at IS NULL
    `).get(ctx.user.id).total;
    sendJson(ctx.res, 200, { notifications, messages });
  });

  // Presenca online: usuarios ativos recentemente, usada para destacar avatares e nomes.
  add('GET', '/api/presence', (ctx) => {
    requireAuth(ctx);
    const rows = ctx.db.prepare(`
      SELECT id
      FROM users
      WHERE suspended_at IS NULL
        AND last_seen_at >= datetime('now', ?)
    `).all(`-${ONLINE_WINDOW_SECONDS} seconds`);
    sendJson(ctx.res, 200, { onlineUserIds: rows.map((row) => row.id) });
  });

  // Central de notificacoes do usuario logado.
  add('GET', '/api/notifications', (ctx) => {
    requireAuth(ctx);
    const notifications = ctx.db.prepare(`
      SELECT n.*, a.display_name AS actor_name, a.username AS actor_username, a.role AS actor_role,
        a.avatar_url AS actor_avatar_url, a.last_seen_at AS actor_last_seen_at
      FROM notifications n
      LEFT JOIN users a ON a.id = n.actor_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
      LIMIT 80
    `).all(ctx.user.id).map((row) => ({
      id: row.id,
      type: row.type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      body: row.body,
      readAt: toIso(row.read_at),
      createdAt: toIso(row.created_at),
      actor: row.actor_id ? {
        id: row.actor_id,
        displayName: row.actor_name,
        username: row.actor_username,
        role: row.actor_role,
        avatarUrl: row.actor_avatar_url || '',
        lastSeenAt: toIso(row.actor_last_seen_at),
        online: isOnlineTimestamp(row.actor_last_seen_at)
      } : null
    }));
    sendJson(ctx.res, 200, { notifications });
  });


  // Marca todas as notificacoes do usuario como lidas.
  add('POST', '/api/notifications/read', (ctx) => {
    requireAuth(ctx);
    ctx.db.prepare(`
      UPDATE notifications
      SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE user_id = ?
    `).run(ctx.user.id);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Lista conversas privadas agrupadas pela outra pessoa.
  add('GET', '/api/messages/conversations', (ctx) => {
    requireAuth(ctx);
    const rows = ctx.db.prepare(`
      SELECT m.*, sender.display_name AS sender_name, recipient.display_name AS recipient_name
      FROM messages m
      JOIN users sender ON sender.id = m.sender_id
      JOIN users recipient ON recipient.id = m.recipient_id
      WHERE m.sender_id = ? OR m.recipient_id = ?
      ORDER BY m.created_at DESC
      LIMIT 300
    `).all(ctx.user.id, ctx.user.id);

    const seen = new Map();
    for (const row of rows) {
      const otherId = row.sender_id === ctx.user.id ? row.recipient_id : row.sender_id;
      if (!seen.has(otherId)) {
        const other = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
        seen.set(otherId, {
          user: publicUserShape(other),
          lastMessage: messageShape(row, ctx.user.id),
          unread: 0
        });
      }
      if (row.recipient_id === ctx.user.id && !row.read_at) seen.get(otherId).unread += 1;
    }

    sendJson(ctx.res, 200, { conversations: Array.from(seen.values()) });
  });


  // Historico de mensagens com um usuario especifico.
  add('GET', '/api/messages/:userId', (ctx) => {
    requireAuth(ctx);
    const otherId = intParam(ctx, 'userId');
    const other = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND suspended_at IS NULL').get(otherId);
    if (!other) throw new HttpError(404, 'Usuario nao encontrado.');

    ctx.db.prepare(`
      UPDATE messages
      SET read_at = COALESCE(read_at, CURRENT_TIMESTAMP)
      WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL
    `).run(otherId, ctx.user.id);

    const messages = ctx.db.prepare(`
      SELECT * FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
      ORDER BY created_at ASC
      LIMIT 200
    `).all(ctx.user.id, otherId, otherId, ctx.user.id).map((row) => messageShape(row, ctx.user.id));

    sendJson(ctx.res, 200, { user: publicUserShape(other), messages });
  });


  // Envia uma mensagem privada e avisa o destinatario por notificacao.
  add('POST', '/api/messages', async (ctx) => {
    requireAuth(ctx);
    const body = await readJson(ctx.req);
    const recipientId = Number(body.recipientId);
    const text = cleanText(body.body, 1000);
    if (!recipientId || recipientId === ctx.user.id) throw new HttpError(400, 'Escolha uma pessoa valida.');
    if (!text) throw new HttpError(400, 'Escreva uma mensagem.');
    const recipient = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND suspended_at IS NULL').get(recipientId);
    if (!recipient) throw new HttpError(404, 'Destinatario nao encontrado.');

    const result = ctx.db.prepare(`
      INSERT INTO messages (sender_id, recipient_id, body)
      VALUES (?, ?, ?)
    `).run(ctx.user.id, recipientId, text);
    notify(ctx.db, recipientId, ctx.user.id, 'message', 'message', Number(result.lastInsertRowid), `${ctx.user.display_name} enviou uma mensagem.`);
    sendJson(ctx.res, 201, { message: messageShape(ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(result.lastInsertRowid)), ctx.user.id) });
  });

  // Cria uma chamada de audio ou video 1 para 1 entre o usuario logado e outra pessoa.
  add('POST', '/api/calls', async (ctx) => {
    requireAuth(ctx);
    expireOldVoiceCalls(ctx.db);
    const body = await readJson(ctx.req);
    const recipientId = Number(body.recipientId);
    const kind = ['audio', 'video'].includes(String(body.kind || 'audio')) ? String(body.kind || 'audio') : '';
    if (!recipientId || recipientId === ctx.user.id) throw new HttpError(400, 'Escolha uma pessoa valida para chamar.');
    if (!kind) throw new HttpError(400, 'Tipo de chamada invalido.');

    const recipient = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND suspended_at IS NULL').get(recipientId);
    if (!recipient) throw new HttpError(404, 'Destinatario nao encontrado.');
    if (activeCallForUser(ctx.db, ctx.user.id) || activeCallForUser(ctx.db, recipientId)) {
      throw new HttpError(409, 'Ja existe uma chamada em andamento para um dos usuarios.');
    }

    const result = ctx.db.prepare(`
      INSERT INTO voice_calls (caller_id, recipient_id, kind)
      VALUES (?, ?, ?)
    `).run(ctx.user.id, recipientId, kind);
    const callId = Number(result.lastInsertRowid);
    const mediaLabel = kind === 'video' ? 'video' : 'voz';
    notify(ctx.db, recipientId, ctx.user.id, 'voice_call', 'voice_call', callId, `${ctx.user.display_name} esta chamando voce por ${mediaLabel}.`);
    sendJson(ctx.res, 201, { call: callShape(getCallForUser(ctx.db, callId, ctx.user.id), ctx.user.id) });
  });

  // Lista chamadas tocando ou ativas para o usuario logado; usada pelo polling do navegador.
  add('GET', '/api/calls/active', (ctx) => {
    requireAuth(ctx);
    expireOldVoiceCalls(ctx.db);
    const calls = activeCallRows(ctx.db, ctx.user.id).map((row) => callShape(row, ctx.user.id));
    sendJson(ctx.res, 200, { calls });
  });

  // Aceita uma chamada recebida e muda o estado para ativa.
  add('POST', '/api/calls/:id/answer', (ctx) => {
    requireAuth(ctx);
    const id = intParam(ctx, 'id');
    const call = getCallForUser(ctx.db, id, ctx.user.id);
    if (!call) throw new HttpError(404, 'Chamada nao encontrada.');
    if (call.recipientId !== ctx.user.id) throw new HttpError(403, 'Apenas quem recebeu a chamada pode atender.');
    if (call.status !== 'ringing') throw new HttpError(409, 'Esta chamada nao esta mais tocando.');

    ctx.db.prepare(`
      UPDATE voice_calls
      SET status = 'active', answered_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
    notify(ctx.db, call.callerId, ctx.user.id, 'voice_call_answered', 'voice_call', id, `${ctx.user.display_name} atendeu sua chamada.`);
    sendJson(ctx.res, 200, { call: callShape(getCallForUser(ctx.db, id, ctx.user.id), ctx.user.id) });
  });

  // Recusa uma chamada recebida antes de ela ficar ativa.
  add('POST', '/api/calls/:id/decline', (ctx) => {
    requireAuth(ctx);
    const id = intParam(ctx, 'id');
    const call = getCallForUser(ctx.db, id, ctx.user.id);
    if (!call) throw new HttpError(404, 'Chamada nao encontrada.');
    if (call.recipientId !== ctx.user.id) throw new HttpError(403, 'Apenas quem recebeu a chamada pode recusar.');
    if (!['ringing', 'active'].includes(call.status)) throw new HttpError(409, 'Esta chamada ja foi encerrada.');

    ctx.db.prepare(`
      UPDATE voice_calls
      SET status = 'declined', ended_at = CURRENT_TIMESTAMP, ended_by = ?
      WHERE id = ?
    `).run(ctx.user.id, id);
    notify(ctx.db, call.callerId, ctx.user.id, 'voice_call_declined', 'voice_call', id, `${ctx.user.display_name} recusou sua chamada.`);
    sendJson(ctx.res, 200, { call: callShape(getCallForUser(ctx.db, id, ctx.user.id), ctx.user.id) });
  });

  // Encerra uma chamada tocando ou ativa para qualquer participante.
  add('POST', '/api/calls/:id/end', (ctx) => {
    requireAuth(ctx);
    const id = intParam(ctx, 'id');
    const call = getCallForUser(ctx.db, id, ctx.user.id);
    if (!call) throw new HttpError(404, 'Chamada nao encontrada.');
    if (['ringing', 'active'].includes(call.status)) {
      ctx.db.prepare(`
        UPDATE voice_calls
        SET status = 'ended', ended_at = CURRENT_TIMESTAMP, ended_by = ?
        WHERE id = ?
      `).run(ctx.user.id, id);
      const otherId = call.callerId === ctx.user.id ? call.recipientId : call.callerId;
      notify(ctx.db, otherId, ctx.user.id, 'voice_call_ended', 'voice_call', id, `${ctx.user.display_name} encerrou a chamada.`);
    }
    sendJson(ctx.res, 200, { call: callShape(getCallForUser(ctx.db, id, ctx.user.id), ctx.user.id) });
  });

  // Recebe os sinais WebRTC do navegador: offer, answer e ICE candidates.
  add('POST', '/api/calls/:id/signals', async (ctx) => {
    requireAuth(ctx);
    const id = intParam(ctx, 'id');
    const call = getCallForUser(ctx.db, id, ctx.user.id);
    if (!call) throw new HttpError(404, 'Chamada nao encontrada.');
    if (!['ringing', 'active'].includes(call.status)) throw new HttpError(409, 'Esta chamada ja foi encerrada.');

    const body = await readJson(ctx.req);
    const type = String(body.type || '').trim();
    if (!['offer', 'answer', 'candidate'].includes(type)) throw new HttpError(400, 'Tipo de sinal invalido.');
    const payload = body.payload ?? {};
    const payloadText = JSON.stringify(payload);
    if (Buffer.byteLength(payloadText) > 64 * 1024) throw new HttpError(413, 'Sinal WebRTC muito grande.');

    const result = ctx.db.prepare(`
      INSERT INTO voice_call_signals (call_id, sender_id, type, payload)
      VALUES (?, ?, ?, ?)
    `).run(id, ctx.user.id, type, payloadText);
    const signal = ctx.db.prepare('SELECT * FROM voice_call_signals WHERE id = ?').get(Number(result.lastInsertRowid));
    sendJson(ctx.res, 201, { signal: signalShape(signal) });
  });

  // Entrega sinais novos para o outro navegador e tambem devolve o estado atual da chamada.
  add('GET', '/api/calls/:id/signals', (ctx) => {
    requireAuth(ctx);
    const id = intParam(ctx, 'id');
    const call = getCallForUser(ctx.db, id, ctx.user.id);
    if (!call) throw new HttpError(404, 'Chamada nao encontrada.');
    const after = clampNumber(ctx.url.searchParams.get('after'), 0, Number.MAX_SAFE_INTEGER, 0);
    const rows = ctx.db.prepare(`
      SELECT * FROM voice_call_signals
      WHERE call_id = ? AND id > ? AND sender_id <> ?
      ORDER BY id ASC
      LIMIT 80
    `).all(id, after, ctx.user.id);
    const lastSignalId = rows.reduce((max, row) => Math.max(max, row.id), after);
    sendJson(ctx.res, 200, { call: callShape(call, ctx.user.id), signals: rows.map(signalShape), lastSignalId });
  });

  // Resumo da equipe: quantidade de usuarios, posts e itens pendentes.
  add('GET', '/api/admin/overview', (ctx) => {
    requireStaff(ctx);
    const overview = {
      users: ctx.db.prepare('SELECT COUNT(*) AS total FROM users').get().total,
      posts: ctx.db.prepare('SELECT COUNT(*) AS total FROM posts WHERE deleted_at IS NULL').get().total,
      openReports: ctx.db.prepare("SELECT COUNT(*) AS total FROM reports WHERE status = 'open'").get().total,
      pendingDeletionRequests: ctx.db.prepare("SELECT COUNT(*) AS total FROM deletion_requests WHERE status = 'pending'").get().total
    };
    sendJson(ctx.res, 200, { overview });
  });


  // Lista denuncias para professores e administradores analisarem.
  add('GET', '/api/admin/reports', (ctx) => {
    requireStaff(ctx);
    const reports = ctx.db.prepare(`
      SELECT r.*, reporter.display_name AS reporter_name, reporter.username AS reporter_username,
        p.body AS post_body, p.author_id AS post_author_id, author.display_name AS post_author_name, author.username AS post_author_username
      FROM reports r
      JOIN users reporter ON reporter.id = r.reporter_id
      JOIN posts p ON p.id = r.post_id
      JOIN users author ON author.id = p.author_id
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all().map(reportShape);
    sendJson(ctx.res, 200, { reports });
  });


  // Atualiza o estado de uma denuncia no painel da equipe.
  add('PATCH', '/api/admin/reports/:id', async (ctx) => {
    requireStaff(ctx);
    const id = intParam(ctx, 'id');
    const body = await readJson(ctx.req);
    const status = String(body.status || '').trim();
    if (!['open', 'reviewed', 'dismissed'].includes(status)) throw new HttpError(400, 'Status invalido.');
    ctx.db.prepare(`
      UPDATE reports
      SET status = ?, resolved_by = ?, resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE CURRENT_TIMESTAMP END
      WHERE id = ?
    `).run(status, ctx.user.id, status, id);
    sendJson(ctx.res, 200, { ok: true });
  });


  // Lista pedidos de exclusao pendentes ou ja revisados, apenas para admin.
  add('GET', '/api/admin/deletion-requests', (ctx) => {
    requireAdmin(ctx);
    const requests = ctx.db.prepare(`
      SELECT d.*, requester.display_name AS requester_name, requester.username AS requester_username,
        p.body AS post_body, p.author_id AS post_author_id, author.display_name AS post_author_name, author.username AS post_author_username
      FROM deletion_requests d
      JOIN users requester ON requester.id = d.requester_id
      JOIN posts p ON p.id = d.post_id
      JOIN users author ON author.id = p.author_id
      ORDER BY d.created_at DESC
      LIMIT 100
    `).all().map(deletionRequestShape);
    sendJson(ctx.res, 200, { requests });
  });


  // Admin aprova ou rejeita exclusao; rejeitado volta a aparecer na timeline.
  add('PATCH', '/api/admin/deletion-requests/:id', async (ctx) => {
    requireAdmin(ctx);
    const id = intParam(ctx, 'id');
    const body = await readJson(ctx.req);
    const status = String(body.status || '').trim();
    const note = cleanText(body.adminNote || '', 300);
    if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'Escolha aprovar ou rejeitar.');

    const request = ctx.db.prepare('SELECT * FROM deletion_requests WHERE id = ?').get(id);
    if (!request) throw new HttpError(404, 'Solicitacao nao encontrada.');
    if (request.status !== 'pending') throw new HttpError(409, 'Esta solicitacao ja foi analisada.');

    ctx.db.exec('BEGIN');
    try {
      ctx.db.prepare(`
        UPDATE deletion_requests
        SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_note = ?
        WHERE id = ?
      `).run(status, ctx.user.id, note, id);

      if (status === 'approved') {
        ctx.db.prepare(`
          UPDATE posts
          SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), deleted_by = ?, delete_reason = ?
          WHERE id = ?
        `).run(ctx.user.id, request.reason, request.post_id);
      }

      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    }

    const message = status === 'approved' ? 'Sua solicitacao de exclusao foi aprovada.' : 'Sua solicitacao de exclusao foi rejeitada.';
    notify(ctx.db, request.requester_id, ctx.user.id, 'delete_review', 'post', request.post_id, message);
    sendJson(ctx.res, 200, { ok: true });
  });

  // Admin exclui diretamente, pela visualizacao do post, uma publicacao com pedido pendente.
  add('POST', '/api/admin/posts/:id/delete-request', async (ctx) => {
    requireAdmin(ctx);
    const postId = intParam(ctx, 'id');
    const body = await readJson(ctx.req);
    const note = cleanText(body.adminNote || 'Excluido durante visualizacao pelo admin.', 300);
    const request = ctx.db.prepare(`
      SELECT d.*
      FROM deletion_requests d
      JOIN posts p ON p.id = d.post_id
      WHERE d.post_id = ? AND d.status = 'pending' AND p.deleted_at IS NULL
      ORDER BY d.created_at DESC
      LIMIT 1
    `).get(postId);
    if (!request) throw new HttpError(404, 'Nao ha solicitacao pendente para esta publicacao.');

    ctx.db.exec('BEGIN');
    try {
      ctx.db.prepare(`
        UPDATE deletion_requests
        SET status = 'approved', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, admin_note = ?
        WHERE id = ?
      `).run(ctx.user.id, note, request.id);
      ctx.db.prepare(`
        UPDATE posts
        SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), deleted_by = ?, delete_reason = ?
        WHERE id = ?
      `).run(ctx.user.id, request.reason, postId);
      ctx.db.exec('COMMIT');
    } catch (error) {
      ctx.db.exec('ROLLBACK');
      throw error;
    }

    notify(ctx.db, request.requester_id, ctx.user.id, 'delete_review', 'post', postId, 'Sua solicitacao de exclusao foi aprovada.');
    sendJson(ctx.res, 200, { ok: true });
  });

  // Painel de usuarios: mostra papeis, contagens e situacao da conta.
  add('GET', '/api/admin/users', (ctx) => {
    requireStaff(ctx);
    const users = ctx.db.prepare(`
      SELECT u.*,
        (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id AND p.deleted_at IS NULL) AS post_count,
        (SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id) AS follower_count
      FROM users u
      ORDER BY u.created_at DESC
      LIMIT 300
    `).all().map((row) => ({
      ...selfUserShape(row),
      postCount: row.post_count,
      followerCount: row.follower_count
    }));
    sendJson(ctx.res, 200, { users });
  });


  // Admin altera papel ou suspensao de contas, com protecoes contra remover o proprio admin.
  add('PATCH', '/api/admin/users/:id', async (ctx) => {
    requireAdmin(ctx);
    const id = intParam(ctx, 'id');
    const body = await readJson(ctx.req);
    const role = body.role === undefined ? undefined : String(body.role);
    const suspend = body.suspended === undefined ? undefined : Boolean(body.suspended);
    const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw new HttpError(404, 'Usuario nao encontrado.');
    if (id === ctx.user.id && (role && role !== 'admin')) throw new HttpError(400, 'Voce nao pode remover seu proprio papel admin.');
    if (id === ctx.user.id && suspend === true) throw new HttpError(400, 'Voce nao pode suspender sua propria conta.');
    if (role !== undefined && !ROLES.has(role)) throw new HttpError(400, 'Papel invalido.');

    if (role !== undefined) {
      ctx.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    if (suspend !== undefined) {
      ctx.db.prepare(`
        UPDATE users
        SET suspended_at = CASE WHEN ? THEN COALESCE(suspended_at, CURRENT_TIMESTAMP) ELSE NULL END
        WHERE id = ?
      `).run(suspend ? 1 : 0, id);
    }
    sendJson(ctx.res, 200, { user: selfUserShape(ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  });

  return routes;
}


// Regra central de visibilidade: posts com exclusao pendente aparecem apenas para admin.
function postVisibilitySql(viewer) {
  if (viewer?.role === 'admin') return '';
  return "AND NOT EXISTS (SELECT 1 FROM deletion_requests visibility_request WHERE visibility_request.post_id = COALESCE(p.repost_of_id, p.id) AND visibility_request.status = 'pending')";
}


// Consulta rapida para saber se existe pedido de exclusao pendente para um post.
function hasPendingDeletionRequest(db, postId) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM deletion_requests
    WHERE post_id = ? AND status = 'pending'
    LIMIT 1
  `).get(postId));
}


// Busca posts e metricas em uma consulta unica; depois anexa midias antes de devolver.
function fetchPosts(db, whereAndOrderSql, params, viewerId) {
  const rows = db.prepare(`
    SELECT
      ? AS viewerId,
      p.id AS id,
      p.body AS body,
      p.parent_id AS parentId,
      p.repost_of_id AS repostOfId,
      p.created_at AS createdAt,
      u.id AS authorId,
      u.display_name AS authorName,
      u.username AS authorUsername,
      u.role AS authorRole,
      u.bio AS authorBio,
      u.avatar_url AS authorAvatarUrl,
      u.last_seen_at AS authorLastSeenAt,
      op.id AS originalId,
      op.body AS originalBody,
      op.created_at AS originalCreatedAt,
      ou.id AS originalAuthorId,
      ou.display_name AS originalAuthorName,
      ou.username AS originalAuthorUsername,
      ou.role AS originalAuthorRole,
      ou.avatar_url AS originalAuthorAvatarUrl,
      ou.last_seen_at AS originalAuthorLastSeenAt,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = COALESCE(p.repost_of_id, p.id)) AS likeCount,
      (SELECT COUNT(*) FROM posts replies WHERE replies.parent_id = COALESCE(p.repost_of_id, p.id) AND replies.deleted_at IS NULL) AS replyCount,
      (SELECT COUNT(*) FROM posts reposts WHERE reposts.repost_of_id = COALESCE(p.repost_of_id, p.id) AND reposts.deleted_at IS NULL) AS repostCount,
      EXISTS(SELECT 1 FROM likes my_like WHERE my_like.user_id = ? AND my_like.post_id = COALESCE(p.repost_of_id, p.id)) AS likedByMe,
      EXISTS(SELECT 1 FROM posts my_repost WHERE my_repost.author_id = ? AND my_repost.repost_of_id = COALESCE(p.repost_of_id, p.id) AND my_repost.deleted_at IS NULL) AS repostedByMe,
      EXISTS(SELECT 1 FROM follows rel WHERE rel.follower_id = ? AND rel.following_id = p.author_id) AS followsAuthor,
      EXISTS(SELECT 1 FROM deletion_requests pending_delete WHERE pending_delete.post_id = COALESCE(p.repost_of_id, p.id) AND pending_delete.status = 'pending') AS pendingDeletionRequest
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN posts op ON op.id = p.repost_of_id
    LEFT JOIN users ou ON ou.id = op.author_id
    ${whereAndOrderSql}
  `).all(viewerId, viewerId, viewerId, viewerId, ...params);

  const posts = rows.map(postShape);
  attachPostMedia(db, posts);
  return posts;
}


// Carrega imagens dos posts em lote para evitar uma consulta por publicacao.
function attachPostMedia(db, posts) {
  const ids = new Set();
  for (const post of posts) {
    ids.add(post.id);
    if (post.original?.id) ids.add(post.original.id);
  }

  if (!ids.size) return;

  const idList = Array.from(ids);
  const placeholders = idList.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT post_id, url, mime_type, alt_text, position
    FROM post_media
    WHERE post_id IN (${placeholders})
    ORDER BY post_id, position, id
  `).all(...idList);

  const grouped = new Map();
  for (const row of rows) {
    const item = {
      url: row.url,
      mimeType: row.mime_type,
      altText: row.alt_text || '',
      position: row.position
    };
    if (!grouped.has(row.post_id)) grouped.set(row.post_id, []);
    grouped.get(row.post_id).push(item);
  }

  for (const post of posts) {
    post.media = grouped.get(post.id) || [];
    if (post.original) post.original.media = grouped.get(post.original.id) || [];
  }
}

// Converte nomes do SQLite para o formato JSON usado pelo navegador.
function postShape(row) {
  const original = row.originalId ? {
    id: row.originalId,
    body: row.originalBody,
    createdAt: toIso(row.originalCreatedAt),
    author: {
      id: row.originalAuthorId,
      displayName: row.originalAuthorName,
      username: row.originalAuthorUsername,
      role: row.originalAuthorRole,
      avatarUrl: row.originalAuthorAvatarUrl || '',
      lastSeenAt: toIso(row.originalAuthorLastSeenAt),
      online: isOnlineTimestamp(row.originalAuthorLastSeenAt)
    }
  } : null;

  return {
    id: row.id,
    body: row.body,
    parentId: row.parentId,
    repostOfId: row.repostOfId,
    createdAt: toIso(row.createdAt),
    score: row.score || null,
    viewerId: row.viewerId,
    authorId: row.authorId,
    authorRole: row.authorRole,
    followsAuthor: Boolean(row.followsAuthor),
    author: {
      id: row.authorId,
      displayName: row.authorName,
      username: row.authorUsername,
      role: row.authorRole,
      bio: row.authorBio || '',
      avatarUrl: row.authorAvatarUrl || '',
      lastSeenAt: toIso(row.authorLastSeenAt),
      online: isOnlineTimestamp(row.authorLastSeenAt)
    },
    original,
    media: [],
    metrics: {
      likes: row.likeCount,
      replies: row.replyCount,
      reposts: row.repostCount
    },
    viewer: {
      liked: Boolean(row.likedByMe),
      reposted: Boolean(row.repostedByMe)
    },
    moderation: {
      pendingDeletion: Boolean(row.pendingDeletionRequest)
    }
  };
}


// Acoes em reposts devem afetar o post original, mantendo contadores corretos.
function getActionTarget(db, postId, viewer) {
  const post = db.prepare('SELECT id, author_id, repost_of_id FROM posts WHERE id = ? AND deleted_at IS NULL').get(postId);
  if (!post) throw new HttpError(404, 'Publicacao nao encontrada.');
  const targetId = post.repost_of_id || post.id;
  if (viewer?.role !== 'admin' && hasPendingDeletionRequest(db, targetId)) {
    throw new HttpError(404, 'Publicacao em revisao pelo admin.');
  }
  const target = db.prepare('SELECT id, author_id FROM posts WHERE id = ? AND deleted_at IS NULL').get(targetId);
  if (!target) throw new HttpError(404, 'Publicacao original nao encontrada.');
  return target;
}


// Atualiza a presenca do usuario sem escrever no banco a cada requisicao.
function touchUserPresence(db, user, force = false) {
  if (!user) return;
  if (!force && isRecentTimestamp(user.last_seen_at, PRESENCE_TOUCH_SECONDS)) return;
  db.prepare('UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);
  user.last_seen_at = new Date().toISOString();
}


// Um usuario e considerado online quando teve atividade nos ultimos minutos.
function isOnlineTimestamp(value) {
  return isRecentTimestamp(value, ONLINE_WINDOW_SECONDS);
}


// Compara datas gravadas pelo SQLite com uma janela em segundos.
function isRecentTimestamp(value, windowSeconds) {
  const iso = toIso(value);
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && Date.now() - time <= windowSeconds * 1000;
}


// Le o cookie da requisicao e encontra o usuario da sessao no banco.
function getSessionUser(req, db) {
  const token = parseCookies(req.headers.cookie || '')[SESSION_COOKIE];
  if (!token) return null;

  const row = db.prepare(`
    SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
    LIMIT 1
  `).get(token);

  if (!row) return null;
  if (Date.parse(toIso(row.session_expires_at)) <= Date.now() || row.suspended_at) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(token);
    return null;
  }
  return row;
}


// Cria uma sessao persistida no SQLite e envia o cookie ao navegador.
function createSession(ctx, userId) {
  const token = randomToken();
  const maxAge = ctx.config.sessionDays * 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + maxAge * 1000).toISOString();
  ctx.db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  ctx.res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, {
    maxAge,
    httpOnly: true,
    sameSite: 'Strict',
    secure: ctx.config.secureCookie
  }));
}


// Insere notificacao para uma pessoa, ignorando notificacoes para si mesmo.
function notify(db, userId, actorId, type, entityType, entityId, body) {
  if (!userId || userId === actorId) return;
  db.prepare(`
    INSERT INTO notifications (user_id, actor_id, type, entity_type, entity_id, body)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(userId, actorId, type, entityType, entityId, body);
}


// Envia notificacao para todos os usuarios de determinados papeis, como admins.
function notifyRoles(db, roles, actorId, type, entityType, entityId, body) {
  const placeholders = roles.map(() => '?').join(', ');
  const users = db.prepare(`SELECT id FROM users WHERE role IN (${placeholders}) AND suspended_at IS NULL`).all(...roles);
  for (const user of users) notify(db, user.id, actorId, type, entityType, entityId, body);
}

// Encerra como perdidas chamadas que ficaram tocando por muito tempo sem resposta.
function expireOldVoiceCalls(db) {
  db.prepare(`
    UPDATE voice_calls
    SET status = 'missed', ended_at = CURRENT_TIMESTAMP
    WHERE status = 'ringing' AND created_at < datetime('now', '-2 minutes')
  `).run();
}

// Busca qualquer chamada tocando ou ativa que envolva um usuario.
function activeCallForUser(db, userId) {
  expireOldVoiceCalls(db);
  return db.prepare(`
    SELECT id FROM voice_calls
    WHERE status IN ('ringing', 'active') AND (caller_id = ? OR recipient_id = ?)
    LIMIT 1
  `).get(userId, userId);
}

// Carrega chamadas abertas com dados dos dois participantes para a interface.
function activeCallRows(db, userId) {
  return db.prepare(`
    SELECT ${callSelectSql()}
    FROM voice_calls c
    JOIN users caller ON caller.id = c.caller_id
    JOIN users recipient ON recipient.id = c.recipient_id
    WHERE c.status IN ('ringing', 'active') AND (c.caller_id = ? OR c.recipient_id = ?)
    ORDER BY CASE WHEN c.status = 'ringing' AND c.recipient_id = ? THEN 0 ELSE 1 END, c.created_at DESC
    LIMIT 10
  `).all(userId, userId, userId);
}

// Carrega uma chamada especifica apenas se o usuario logado participa dela.
function getCallForUser(db, callId, userId) {
  return db.prepare(`
    SELECT ${callSelectSql()}
    FROM voice_calls c
    JOIN users caller ON caller.id = c.caller_id
    JOIN users recipient ON recipient.id = c.recipient_id
    WHERE c.id = ? AND (c.caller_id = ? OR c.recipient_id = ?)
    LIMIT 1
  `).get(callId, userId, userId);
}

// Campos compartilhados pelas consultas de chamada.
function callSelectSql() {
  return `
    c.id AS id,
    c.caller_id AS callerId,
    c.recipient_id AS recipientId,
    c.status AS status,
    c.kind AS kind,
    c.created_at AS createdAt,
    c.answered_at AS answeredAt,
    c.ended_at AS endedAt,
    c.ended_by AS endedBy,
    caller.display_name AS callerDisplayName,
    caller.username AS callerUsername,
    caller.role AS callerRole,
    caller.bio AS callerBio,
    caller.avatar_url AS callerAvatarUrl,
    caller.banner_url AS callerBannerUrl,
    caller.last_seen_at AS callerLastSeenAt,
    recipient.display_name AS recipientDisplayName,
    recipient.username AS recipientUsername,
    recipient.role AS recipientRole,
    recipient.bio AS recipientBio,
    recipient.avatar_url AS recipientAvatarUrl,
    recipient.banner_url AS recipientBannerUrl,
    recipient.last_seen_at AS recipientLastSeenAt
  `;
}

// Formata chamada de audio/video para o navegador, mostrando sempre quem e a outra pessoa.
function callShape(row, viewerId) {
  const peerPrefix = row.callerId === viewerId ? 'recipient' : 'caller';
  const peer = prefixedCallUser(row, peerPrefix);
  return {
    id: row.id,
    callerId: row.callerId,
    recipientId: row.recipientId,
    status: row.status,
    kind: row.kind || 'audio',
    incoming: row.recipientId === viewerId && row.status === 'ringing',
    outgoing: row.callerId === viewerId && row.status === 'ringing',
    peer,
    createdAt: toIso(row.createdAt),
    answeredAt: toIso(row.answeredAt),
    endedAt: toIso(row.endedAt),
    endedBy: row.endedBy || null
  };
}

// Monta um usuario vindo de colunas prefixadas como callerDisplayName ou recipientDisplayName.
function prefixedCallUser(row, prefix) {
  const cap = prefix[0].toUpperCase() + prefix.slice(1);
  return {
    id: prefix === 'caller' ? row.callerId : row.recipientId,
    displayName: row[`${prefix}DisplayName`] || row[`${cap}DisplayName`],
    username: row[`${prefix}Username`] || row[`${cap}Username`],
    role: row[`${prefix}Role`] || row[`${cap}Role`],
    bio: row[`${prefix}Bio`] || row[`${cap}Bio`] || '',
    avatarUrl: row[`${prefix}AvatarUrl`] || row[`${cap}AvatarUrl`] || '',
    bannerUrl: row[`${prefix}BannerUrl`] || row[`${cap}BannerUrl`] || '',
    lastSeenAt: toIso(row[`${prefix}LastSeenAt`] || row[`${cap}LastSeenAt`]),
    online: isOnlineTimestamp(row[`${prefix}LastSeenAt`] || row[`${cap}LastSeenAt`])
  };
}

// Formata um sinal WebRTC salvo no banco e reconverte o payload JSON.
function signalShape(row) {
  let payload = {};
  try {
    payload = JSON.parse(row.payload || '{}');
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    callId: row.call_id,
    senderId: row.sender_id,
    type: row.type,
    payload,
    createdAt: toIso(row.created_at)
  };
}

// Formata mensagem e informa se ela foi enviada pelo usuario atual.
function messageShape(row, viewerId) {
  return {
    id: row.id,
    senderId: row.sender_id,
    recipientId: row.recipient_id,
    body: row.body,
    mine: row.sender_id === viewerId,
    readAt: toIso(row.read_at),
    createdAt: toIso(row.created_at)
  };
}


// Formata denuncia para o painel de moderacao.
function reportShape(row) {
  return {
    id: row.id,
    reason: row.reason,
    details: row.details,
    status: row.status,
    createdAt: toIso(row.created_at),
    resolvedAt: toIso(row.resolved_at),
    reporter: { id: row.reporter_id, displayName: row.reporter_name, username: row.reporter_username },
    post: {
      id: row.post_id,
      body: row.post_body,
      author: { id: row.post_author_id, displayName: row.post_author_name, username: row.post_author_username }
    }
  };
}


// Formata pedido de exclusao para o painel do administrador.
function deletionRequestShape(row) {
  return {
    id: row.id,
    reason: row.reason,
    status: row.status,
    adminNote: row.admin_note,
    createdAt: toIso(row.created_at),
    reviewedAt: toIso(row.reviewed_at),
    requester: { id: row.requester_id, displayName: row.requester_name, username: row.requester_username },
    post: {
      id: row.post_id,
      body: row.post_body,
      author: { id: row.post_author_id, displayName: row.post_author_name, username: row.post_author_username }
    }
  };
}


// Formato completo do proprio usuario, usado em login e edicao de perfil.
function selfUserShape(user) {
  return {
    id: user.id,
    displayName: user.display_name,
    username: user.username,
    email: user.email,
    role: user.role,
    bio: user.bio || '',
    avatarUrl: user.avatar_url || '',
    bannerUrl: user.banner_url || '',
    lastSeenAt: toIso(user.last_seen_at),
    online: isOnlineTimestamp(user.last_seen_at),
    suspendedAt: toIso(user.suspended_at),
    createdAt: toIso(user.created_at)
  };
}


// Formato publico de usuario, sem e-mail nem dados sensiveis.
function publicUserShape(user) {
  return {
    id: user.id,
    displayName: user.display_name,
    username: user.username,
    role: user.role,
    bio: user.bio || '',
    avatarUrl: user.avatar_url || '',
    bannerUrl: user.banner_url || '',
    lastSeenAt: toIso(user.last_seen_at),
    online: isOnlineTimestamp(user.last_seen_at),
    followedByMe: Boolean(user.followed_by_me),
    followerCount: user.follower_count || 0,
    followingCount: user.following_count || 0,
    createdAt: toIso(user.created_at)
  };
}


// Guard simples: exige login antes de seguir com a rota.
function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Entre na SIX para continuar.');
}


// Guard para area da equipe: professor ou admin.
function requireStaff(ctx) {
  requireAuth(ctx);
  if (!isStaff(ctx.user)) throw new HttpError(403, 'Acesso restrito a professores e admins.');
}


// Guard para acoes exclusivas do administrador.
function requireAdmin(ctx) {
  requireAuth(ctx);
  if (ctx.user.role !== 'admin') throw new HttpError(403, 'Acesso restrito ao admin.');
}


// Helper semantico para conferir se o papel pertence a equipe escolar.
function isStaff(user) {
  return user.role === 'teacher' || user.role === 'admin';
}


// Le JSON do corpo da requisicao com limite para impedir uploads grandes demais.
async function readJson(req) {
  let size = 0;
  const chunks = [];

  for await (const chunk of req) {
    size += chunk.length;
    if (size > JSON_LIMIT_BYTES) throw new HttpError(413, 'Requisicao muito grande.');
    chunks.push(chunk);
  }

  const source = Buffer.concat(chunks).toString('utf8').trim();
  if (!source) return {};

  try {
    return JSON.parse(source);
  } catch {
    throw new HttpError(400, 'JSON invalido.');
  }
}


// Resposta padrao da API: JSON em UTF-8 e sem cache.
function sendJson(res, status, payload) {
  if (res.headersSent) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}


// Serve a interface em public/ e os arquivos enviados em data/uploads/.
async function serveStatic(url, res, config) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith('/uploads/')) {
    await serveFileFromRoot(path.resolve(config.dataDir, 'uploads'), pathname.slice('/uploads/'.length), res, false);
    return;
  }

  const publicRoot = path.resolve(config.publicDir);
  if (pathname === '/') pathname = '/index.html';

  try {
    await serveFileFromRoot(publicRoot, pathname.slice(1), res, true);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const data = await fs.readFile(path.join(publicRoot, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  }
}


// Serve um arquivo garantindo que o caminho pedido nao escape da pasta permitida.
async function serveFileFromRoot(root, requestPath, res, allowDirectoryIndex) {
  let filePath = path.resolve(root, requestPath || 'index.html');
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    sendPlain(res, 403, 'Acesso negado.');
    return;
  }

  const stat = await fs.stat(filePath);
  if (stat.isDirectory()) {
    if (!allowDirectoryIndex) {
      sendPlain(res, 404, 'Arquivo nao encontrado.');
      return;
    }
    filePath = path.join(filePath, 'index.html');
  }

  const data = await fs.readFile(filePath);
  res.writeHead(200, {
    'Content-Type': mimeType(filePath),
    'Cache-Control': cacheControl(filePath)
  });
  res.end(data);
}


// Resposta de texto simples usada em erros de arquivos estaticos.
function sendPlain(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}


// HTML, CSS e JS nao ficam em cache para facilitar atualizacoes durante testes.
function cacheControl(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ['.html', '.js', '.css'].includes(extension) ? 'no-store' : 'public, max-age=3600';
}


// Mapeia extensoes conhecidas para Content-Type correto no navegador.
function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  }[extension] || 'application/octet-stream';
}


// Compara a URL recebida com as rotas registradas, incluindo parametros como :id.
function matchRoute(routes, method, pathname) {
  const actual = splitPath(pathname);
  for (const route of routes) {
    if (route.method !== method || route.segments.length !== actual.length) continue;
    const params = {};
    let matched = true;

    for (let index = 0; index < route.segments.length; index += 1) {
      const expected = route.segments[index];
      const value = actual[index];
      if (expected.startsWith(':')) {
        params[expected.slice(1)] = value;
      } else if (expected !== value) {
        matched = false;
        break;
      }
    }

    if (matched) return { handler: route.handler, params };
  }
  return null;
}


// Quebra um caminho em partes para facilitar a comparacao das rotas.
function splitPath(pathname) {
  return pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
}


// Valida parametros numericos positivos vindos da URL.
function intParam(ctx, name) {
  const value = Number(ctx.params[name]);
  if (!Number.isInteger(value) || value <= 0) throw new HttpError(400, 'Parametro invalido.');
  return value;
}


// Garante que paginacao e limites fiquem dentro de uma faixa segura.
function clampNumber(value, min, max, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}


// Normaliza texto recebido do usuario e aplica tamanho maximo.
function cleanText(value, maxLength = 500) {
  return String(value || '').replace(/\s+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim().slice(0, maxLength);
}


// Valida Data URL de imagem e converte para Buffer antes de gravar no disco.
function parseProfileImageDataUrl(dataUrl) {
  const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/i);
  if (!match) throw new HttpError(400, 'Envie uma imagem PNG, JPG, WebP ou GIF valida.');

  const mime = match[1].toLowerCase();
  const extension = IMAGE_EXTENSIONS.get(mime);
  if (!extension) throw new HttpError(400, 'Formato de imagem nao permitido.');

  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) throw new HttpError(400, 'Imagem vazia.');
  if (buffer.length > MAX_PROFILE_IMAGE_BYTES) throw new HttpError(413, 'A imagem deve ter ate 4 MB.');

  return { buffer, extension, mime };
}


// Valida a lista de imagens do post: array, no maximo quatro itens e tipos permitidos.
function parsePostImages(values) {
  if (values === undefined || values === null || values === '') return [];
  if (!Array.isArray(values)) throw new HttpError(400, 'Envie as imagens em uma lista.');
  const filtered = values.filter(Boolean);
  if (filtered.length > MAX_POST_IMAGES) throw new HttpError(400, `Envie no maximo ${MAX_POST_IMAGES} imagens por publicacao.`);
  return filtered.map((value) => parseProfileImageDataUrl(value));
}


// Grava as imagens do post em data/uploads/posts e registra as URLs no SQLite.
async function savePostMedia(config, db, userId, postId, images) {
  const directory = path.join(config.dataDir, 'uploads', 'posts');
  await fs.mkdir(directory, { recursive: true });
  const insert = db.prepare(`
    INSERT INTO post_media (post_id, url, mime_type, position)
    VALUES (?, ?, ?, ?)
  `);

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const fileName = `post-${postId}-${index}-${userId}-${Date.now()}-${randomToken().slice(0, 12)}.${image.extension}`;
    await fs.writeFile(path.join(directory, fileName), image.buffer);
    insert.run(postId, `/uploads/posts/${fileName}`, image.mime, index);
  }
}

// Grava foto ou capa do perfil no disco e devolve a URL publica local.
async function saveProfileImage(config, userId, kind, dataUrl) {
  const { buffer, extension } = parseProfileImageDataUrl(dataUrl);
  const directory = path.join(config.dataDir, 'uploads', kind);
  await fs.mkdir(directory, { recursive: true });
  const fileName = `${kind}-${userId}-${Date.now()}-${randomToken().slice(0, 12)}.${extension}`;
  await fs.writeFile(path.join(directory, fileName), buffer);
  return `/uploads/${kind}/${fileName}`;
}


// Aceita apenas URLs seguras ou arquivos internos de uploads para perfil e capa.
function cleanUrl(value) {
  const text = cleanText(value || '', 500);
  if (!text) return '';
  if (text.startsWith('/uploads/') && !text.includes('..')) return text;
  try {
    const url = new URL(text);
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch {
    return '';
  }
}


// Padroniza datas do SQLite para ISO, formato facil para o JavaScript do navegador.
function toIso(value) {
  if (!value) return null;
  const text = String(value);
  if (text.includes('T')) return text;
  return `${text.replace(' ', 'T')}Z`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp();
  app.server.listen(app.config.port, app.config.host, () => {
    console.log(`${app.config.platformName} rodando em http://${app.config.host}:${app.config.port}`);
    console.log(`Banco de dados: ${app.config.dbPath}`);
  });

  if (app.httpsServer) {
    app.httpsServer.listen(app.config.httpsPort, app.config.host, () => {
      console.log(`${app.config.platformName} rodando com HTTPS em https://${app.config.host}:${app.config.httpsPort}`);
    });
  }
}
