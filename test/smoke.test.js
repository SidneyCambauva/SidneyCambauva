// Arquivo didatico: teste de fumaca cobrindo cadastro, feed, imagens, moderacao, mensagens, nao lidos e chamadas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/server.js';


// Este teste sobe o servidor em uma porta temporaria e simula o uso real da plataforma.
test('SIX social workflow', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'six-test-'));
  const app = createApp({
    env: {
      SIX_DATA_DIR: dataDir,
      SIX_DB_PATH: path.join(dataDir, 'six.sqlite'),
      SIX_ALLOWED_EMAIL_DOMAINS: 'escola.edu.br',
      SIX_FIRST_USER_ADMIN: 'true',
      SIX_SESSION_DAYS: '1',
      SIX_COOKIE_SECURE: 'false'
    }
  });

  await listen(app.server);
  t.after(async () => {
    await closeServer(app.server);
    app.db.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${app.server.address().port}`;


  // Cadastro com dominio externo deve ser bloqueado.
  const denied = await request(base, '/api/auth/register', {
    method: 'POST',
    body: {
      displayName: 'Aluno Fora',
      username: 'fora',
      email: 'fora@gmail.com',
      password: 'senha1234'
    }
  });
  assert.equal(denied.status, 400);


  // A primeira conta vira administradora quando SIX_FIRST_USER_ADMIN=true.
  const admin = await request(base, '/api/auth/register', {
    method: 'POST',
    body: {
      displayName: 'Admin SIX',
      username: 'admin',
      email: 'admin@escola.edu.br',
      password: 'senha1234'
    }
  });
  assert.equal(admin.status, 201);
  assert.equal(admin.data.user.role, 'admin');
  assert.ok(admin.cookie);


  // A segunda conta entra como aluno normal.
  const student = await request(base, '/api/auth/register', {
    method: 'POST',
    body: {
      displayName: 'Aluno Um',
      username: 'aluno1',
      email: 'aluno1@escola.edu.br',
      password: 'senha1234'
    }
  });
  assert.equal(student.status, 201);
  assert.equal(student.data.user.role, 'student');


  // Imagem PNG minima usada para testar upload sem depender de arquivos externos.
  const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
  const profileUpdate = await request(base, '/api/me', {
    method: 'PATCH',
    cookie: student.cookie,
    body: { displayName: 'Aluno Um', bio: 'Perfil com foto.', avatarDataUrl: tinyPng }
  });
  assert.equal(profileUpdate.status, 200);
  assert.match(profileUpdate.data.user.avatarUrl, /^\/uploads\/avatar\/avatar-\d+-/);
  const avatarResponse = await fetch(`${base}${profileUpdate.data.user.avatarUrl}`);
  assert.equal(avatarResponse.status, 200);
  assert.equal(avatarResponse.headers.get('content-type'), 'image/png');

  const bannerUpdate = await request(base, '/api/me', {
    method: 'PATCH',
    cookie: student.cookie,
    body: { bannerDataUrl: tinyPng }
  });
  assert.equal(bannerUpdate.status, 200);
  assert.equal(bannerUpdate.data.user.avatarUrl, profileUpdate.data.user.avatarUrl);
  assert.match(bannerUpdate.data.user.bannerUrl, /^\/uploads\/banner\/banner-\d+-/);

  const post = await request(base, '/api/posts', {
    method: 'POST',
    cookie: admin.cookie,
    body: { body: 'Bem-vindos a SIX.' }
  });
  assert.equal(post.status, 201);

  const follow = await request(base, `/api/users/${admin.data.user.id}/follow`, {
    method: 'POST',
    cookie: student.cookie,
    body: {}
  });
  assert.equal(follow.status, 200);

  const like = await request(base, `/api/posts/${post.data.post.id}/like`, {
    method: 'POST',
    cookie: student.cookie,
    body: {}
  });
  assert.equal(like.status, 200);

  const reply = await request(base, '/api/posts', {
    method: 'POST',
    cookie: student.cookie,
    body: { body: 'Confirmado, professor.', parentId: post.data.post.id }
  });
  assert.equal(reply.status, 201);

  const repost = await request(base, `/api/posts/${post.data.post.id}/repost`, {
    method: 'POST',
    cookie: student.cookie,
    body: {}
  });
  assert.equal(repost.status, 200);

  const studentPost = await request(base, '/api/posts', {
    method: 'POST',
    cookie: student.cookie,
    body: { body: 'Publicacao raiz do aluno.' }
  });
  assert.equal(studentPost.status, 201);


  // Postagem com imagem e sem texto deve funcionar para alunos.
  const imagePost = await request(base, '/api/posts', {
    method: 'POST',
    cookie: student.cookie,
    body: { body: '', imageDataUrls: [tinyPng] }
  });
  assert.equal(imagePost.status, 201);
  assert.equal(imagePost.data.post.media.length, 1);
  assert.match(imagePost.data.post.media[0].url, /^\/uploads\/posts\/post-\d+-/);
  const postImageResponse = await fetch(`${base}${imagePost.data.post.media[0].url}`);
  assert.equal(postImageResponse.status, 200);
  assert.equal(postImageResponse.headers.get('content-type'), 'image/png');


  // O servidor deve rejeitar mais de quatro imagens na mesma publicacao.
  const tooManyImages = await request(base, '/api/posts', {
    method: 'POST',
    cookie: student.cookie,
    body: { body: 'Album grande demais.', imageDataUrls: [tinyPng, tinyPng, tinyPng, tinyPng, tinyPng] }
  });
  assert.equal(tooManyImages.status, 400);

  const feed = await request(base, '/api/feed', { cookie: student.cookie });
  assert.equal(feed.status, 200);
  assert.ok(feed.data.posts.length >= 2);
  const feedAuthors = new Set(feed.data.posts.map((item) => item.author.username));
  assert.ok(feedAuthors.has('admin'));
  assert.ok(feedAuthors.has('aluno1'));
  assert.equal(feed.data.posts.find((item) => item.id === post.data.post.id).metrics.likes, 1);  const feedImagePost = feed.data.posts.find((item) => item.id === imagePost.data.post.id);
  assert.ok(feedImagePost);
  assert.equal(feedImagePost.media.length, 1);


  const hideRequest = await request(base, `/api/posts/${studentPost.data.post.id}/deletion-request`, {
    method: 'POST',
    cookie: student.cookie,
    body: { reason: 'Quero revisar antes de manter.' }
  });
  assert.equal(hideRequest.status, 201);

  const studentFeedDuringReview = await request(base, '/api/feed', { cookie: student.cookie });
  assert.equal(studentFeedDuringReview.status, 200);
  assert.equal(studentFeedDuringReview.data.posts.some((item) => item.id === studentPost.data.post.id), false);

  const adminFeedDuringReview = await request(base, '/api/feed', { cookie: admin.cookie });
  assert.equal(adminFeedDuringReview.status, 200);
  const adminPendingPost = adminFeedDuringReview.data.posts.find((item) => item.id === studentPost.data.post.id);
  assert.ok(adminPendingPost);
  assert.equal(adminPendingPost.moderation.pendingDeletion, true);

  const adminNotifications = await request(base, '/api/notifications', { cookie: admin.cookie });
  assert.equal(adminNotifications.status, 200);
  assert.ok(adminNotifications.data.notifications.some((item) => item.type === 'delete_request' && item.entityId === studentPost.data.post.id));

  const unreadAfterDeleteRequest = await request(base, '/api/unread-counts', { cookie: admin.cookie });
  assert.equal(unreadAfterDeleteRequest.status, 200);
  assert.ok(unreadAfterDeleteRequest.data.notifications >= 1);

  const readAdminNotifications = await request(base, '/api/notifications/read', {
    method: 'POST',
    cookie: admin.cookie,
    body: {}
  });
  assert.equal(readAdminNotifications.status, 200);

  const unreadAfterReadAll = await request(base, '/api/unread-counts', { cookie: admin.cookie });
  assert.equal(unreadAfterReadAll.status, 200);
  assert.equal(unreadAfterReadAll.data.notifications, 0);

  const pendingForStudentPost = await request(base, '/api/admin/deletion-requests', { cookie: admin.cookie });
  assert.equal(pendingForStudentPost.status, 200);
  const studentPostRequest = pendingForStudentPost.data.requests.find((item) => item.post.id === studentPost.data.post.id && item.status === 'pending');
  assert.ok(studentPostRequest);

  const rejectedStudentPost = await request(base, `/api/admin/deletion-requests/${studentPostRequest.id}`, {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { status: 'rejected', adminNote: 'Mantido na timeline.' }
  });
  assert.equal(rejectedStudentPost.status, 200);

  const studentFeedAfterReview = await request(base, '/api/feed', { cookie: student.cookie });
  assert.equal(studentFeedAfterReview.status, 200);
  assert.ok(studentFeedAfterReview.data.posts.some((item) => item.id === studentPost.data.post.id));

  const directDeletedPost = await request(base, '/api/posts', {
    method: 'POST',
    cookie: student.cookie,
    body: { body: 'Post para exclusao direta pelo admin.' }
  });
  assert.equal(directDeletedPost.status, 201);

  const directDeletionRequest = await request(base, `/api/posts/${directDeletedPost.data.post.id}/deletion-request`, {
    method: 'POST',
    cookie: student.cookie,
    body: { reason: 'Pode apagar direto.' }
  });
  assert.equal(directDeletionRequest.status, 201);

  const directAdminDelete = await request(base, `/api/admin/posts/${directDeletedPost.data.post.id}/delete-request`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { adminNote: 'Excluido no card da timeline.' }
  });
  assert.equal(directAdminDelete.status, 200);

  const directDeletedThread = await request(base, `/api/posts/${directDeletedPost.data.post.id}/thread`, { cookie: admin.cookie });
  assert.equal(directDeletedThread.status, 404);

  const message = await request(base, '/api/messages', {
    method: 'POST',
    cookie: student.cookie,
    body: { recipientId: admin.data.user.id, body: 'Oi, admin.' }
  });
  assert.equal(message.status, 201);

  const conversations = await request(base, '/api/messages/conversations', { cookie: admin.cookie });
  assert.equal(conversations.status, 200);
  assert.equal(conversations.data.conversations.length, 1);

  const unreadAfterMessage = await request(base, '/api/unread-counts', { cookie: admin.cookie });
  assert.equal(unreadAfterMessage.status, 200);
  assert.equal(unreadAfterMessage.data.messages, 1);

  const adminMessageThread = await request(base, `/api/messages/${student.data.user.id}`, { cookie: admin.cookie });
  assert.equal(adminMessageThread.status, 200);

  const unreadAfterMessageRead = await request(base, '/api/unread-counts', { cookie: admin.cookie });
  assert.equal(unreadAfterMessageRead.status, 200);
  assert.equal(unreadAfterMessageRead.data.messages, 0);

  const voiceCall = await request(base, '/api/calls', {
    method: 'POST',
    cookie: student.cookie,
    body: { recipientId: admin.data.user.id }
  });
  assert.equal(voiceCall.status, 201);
  assert.equal(voiceCall.data.call.status, 'ringing');
  assert.equal(voiceCall.data.call.kind, 'audio');
  assert.equal(voiceCall.data.call.peer.username, 'admin');

  const offerSignal = await request(base, `/api/calls/${voiceCall.data.call.id}/signals`, {
    method: 'POST',
    cookie: student.cookie,
    body: { type: 'offer', payload: { type: 'offer', sdp: 'fake-offer' } }
  });
  assert.equal(offerSignal.status, 201);

  const activeForAdmin = await request(base, '/api/calls/active', { cookie: admin.cookie });
  assert.equal(activeForAdmin.status, 200);
  assert.equal(activeForAdmin.data.calls[0].incoming, true);
  assert.equal(activeForAdmin.data.calls[0].peer.username, 'aluno1');

  const adminSignals = await request(base, `/api/calls/${voiceCall.data.call.id}/signals?after=0`, { cookie: admin.cookie });
  assert.equal(adminSignals.status, 200);
  assert.equal(adminSignals.data.signals[0].type, 'offer');

  const answeredCall = await request(base, `/api/calls/${voiceCall.data.call.id}/answer`, {
    method: 'POST',
    cookie: admin.cookie,
    body: {}
  });
  assert.equal(answeredCall.status, 200);
  assert.equal(answeredCall.data.call.status, 'active');

  const answerSignal = await request(base, `/api/calls/${voiceCall.data.call.id}/signals`, {
    method: 'POST',
    cookie: admin.cookie,
    body: { type: 'answer', payload: { type: 'answer', sdp: 'fake-answer' } }
  });
  assert.equal(answerSignal.status, 201);

  const studentSignals = await request(base, `/api/calls/${voiceCall.data.call.id}/signals?after=${offerSignal.data.signal.id}`, { cookie: student.cookie });
  assert.equal(studentSignals.status, 200);
  assert.equal(studentSignals.data.signals[0].type, 'answer');

  const endedCall = await request(base, `/api/calls/${voiceCall.data.call.id}/end`, {
    method: 'POST',
    cookie: student.cookie,
    body: {}
  });
  assert.equal(endedCall.status, 200);
  assert.equal(endedCall.data.call.status, 'ended');

  const activeAfterEnd = await request(base, '/api/calls/active', { cookie: admin.cookie });
  assert.equal(activeAfterEnd.status, 200);
  assert.equal(activeAfterEnd.data.calls.some((call) => call.id === voiceCall.data.call.id), false);
  const invalidCall = await request(base, '/api/calls', {
    method: 'POST',
    cookie: student.cookie,
    body: { recipientId: admin.data.user.id, kind: 'screen' }
  });
  assert.equal(invalidCall.status, 400);

  const videoCall = await request(base, '/api/calls', {
    method: 'POST',
    cookie: student.cookie,
    body: { recipientId: admin.data.user.id, kind: 'video' }
  });
  assert.equal(videoCall.status, 201);
  assert.equal(videoCall.data.call.status, 'ringing');
  assert.equal(videoCall.data.call.kind, 'video');

  const activeVideoForAdmin = await request(base, '/api/calls/active', { cookie: admin.cookie });
  assert.equal(activeVideoForAdmin.status, 200);
  assert.equal(activeVideoForAdmin.data.calls[0].incoming, true);
  assert.equal(activeVideoForAdmin.data.calls[0].kind, 'video');

  const endedVideoCall = await request(base, `/api/calls/${videoCall.data.call.id}/end`, {
    method: 'POST',
    cookie: student.cookie,
    body: {}
  });
  assert.equal(endedVideoCall.status, 200);
  assert.equal(endedVideoCall.data.call.status, 'ended');
  const deletion = await request(base, `/api/posts/${reply.data.post.id}/deletion-request`, {
    method: 'POST',
    cookie: student.cookie,
    body: { reason: 'Publiquei no lugar errado.' }
  });
  assert.equal(deletion.status, 201);

  const requests = await request(base, '/api/admin/deletion-requests', { cookie: admin.cookie });
  assert.equal(requests.status, 200);
  const replyDeletionRequest = requests.data.requests.find((item) => item.post.id === reply.data.post.id && item.status === 'pending');
  assert.ok(replyDeletionRequest);

  const approved = await request(base, `/api/admin/deletion-requests/${replyDeletionRequest.id}`, {
    method: 'PATCH',
    cookie: admin.cookie,
    body: { status: 'approved', adminNote: 'Aprovado.' }
  });
  assert.equal(approved.status, 200);

  const search = await request(base, '/api/search?q=SIX', { cookie: student.cookie });
  assert.equal(search.status, 200);
  assert.ok(search.data.posts.length >= 1);
});


// Helper para iniciar o servidor apenas durante o teste.
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}


// Helper para fechar o servidor e liberar a porta no final do teste.
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}


// Pequeno cliente HTTP usado pelos cenarios acima.
async function request(base, pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  return {
    status: response.status,
    data,
    cookie: response.headers.get('set-cookie')?.split(';')[0] || options.cookie || ''
  };
}
