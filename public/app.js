// Arquivo didatico: interface web da SIX, escrita em JavaScript puro no navegador.
const app = document.querySelector('#app');
const toast = document.querySelector('#toast');
const scriptUrl = new URL(document.currentScript?.src || 'app.js', window.location.href);
const BASE_PATH = scriptUrl.pathname.replace(/\/app\.js$/, '').replace(/\/$/, '');
const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_POST_IMAGES = 4;
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
const VOICE_POLL_MS = 4000;
const VOICE_SIGNAL_POLL_MS = 1200;
const UNREAD_POLL_MS = 8000;
const PRESENCE_POLL_MS = 15000;
const CALL_RING_INTERVAL_MS = 3600;
const CALL_RING_BURST_SECONDS = 1.15;
const CALL_NOTIFICATION_TAG = 'six-incoming-call';
const PORTRAIT_VIDEO_WIDTH = 720;
const PORTRAIT_VIDEO_HEIGHT = 1280;


// Monta URLs corretamente tanto na raiz quanto publicado em subpasta, como /xis/.
function appPath(path = '/') {
  const normalized = String(path || '/').startsWith('/') ? String(path || '/') : `/${path}`;
  return `${BASE_PATH}${normalized}` || normalized;
}


// Converte URLs de uploads para respeitar o caminho publico atual da aplicacao.
function mediaUrl(value) {
  const text = String(value || '');
  if (!text || text.startsWith('http://') || text.startsWith('https://') || text.startsWith('data:')) return text;
  return text.startsWith('/') ? appPath(text) : text;
}


// Estado global simples da interface: configuracao, usuario atual, tela aberta e aba admin.
const state = {
  config: null,
  me: null,
  view: 'home',
  params: {},
  adminTab: 'requests',
  unreadCounts: { notifications: 0, messages: 0 },
  unreadPollTimer: null,
  onlineUserIds: new Set(),
  presencePollTimer: null
};


// Itens do menu principal. Os icones sao gerados por navIconHtml().
const navItems = [
  ['home', 'Inicio'],
  ['search', 'Busca'],
  ['notifications', 'Avisos'],
  ['messages', 'Mensagens'],
  ['profile', 'Perfil']
];
// Estado da chamada de audio/video em andamento no navegador.
const voiceState = {
  call: null,
  peer: null,
  pc: null,
  localStream: null,
  sourceStream: null,
  portraitVideo: null,
  portraitCanvas: null,
  portraitFrame: null,
  cameraFacing: 'user',
  switchingCamera: false,
  remoteStream: null,
  remoteAudio: null,
  kind: 'audio',
  signalCursor: 0,
  incomingPollTimer: null,
  signalPollTimer: null,
  pendingCandidates: [],
  pollingSignals: false,
  isBusy: false,
  isCaller: false,
  statusText: ''
};
// Estado dos alertas locais de chamada: notificacao do sistema e toque do navegador.
const callAlertState = {
  audioContext: null,
  ringTimer: null,
  activeNotification: null,
  lastCallId: null,
  setup: false
};
// Estado do modal de imagem aberto a partir da timeline.
const imageModalState = {
  images: [],
  index: 0,
  keyHandler: null
};

init().catch((error) => {
  console.error(error);
  app.innerHTML = `<div class="empty">Nao foi possivel iniciar a SIX.</div>`;
});


// Inicializacao: carrega configuracao, verifica sessao e decide entre login ou app principal.
async function init() {
  state.config = await api('/api/config');
  const me = await api('/api/me');
  state.me = me.user;
  document.title = state.config.platformName;
  if (state.me) {
    setupDeviceCallAlerts();
    await refreshUnreadCounts(false);
    await refreshPresence(false);
    await go('home');
    startVoicePolling();
    startUnreadPolling();
    startPresencePolling();
  } else {
    renderAuth('login');
  }
}


// Cliente HTTP unico da interface: envia JSON, cookies e transforma erros em mensagens.
async function api(path, options = {}) {
  const init = {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {}
  };

  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  const response = await fetch(appPath(path), init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erro na requisicao.');
  return data;
}


// Tela de entrada: alterna entre login e cadastro institucional.
function renderAuth(mode) {
  const domains = state.config.allowedDomains.map((domain) => `@${domain}`).join(', ');
  app.innerHTML = `
    <main class="auth-wrap">
      <section class="auth-brand">
        <img class="brand-mark" src="${appPath('/assets/logo.svg')}" alt="${escapeAttr(state.config.platformName)}">
        <div>
          <h1 class="auth-title">${escapeHtml(state.config.platformName)}</h1>
          <p class="auth-slogan">A Nossa Rede Social</p>
          <p class="auth-subtitle">${escapeHtml(state.config.schoolName)}</p>
        </div>
      </section>
      <section class="auth-card" aria-label="Acesso">
        <div class="tabs">
          <button class="tab ${mode === 'login' ? 'active' : ''}" data-auth-mode="login">Entrar</button>
          <button class="tab ${mode === 'register' ? 'active' : ''}" data-auth-mode="register">Criar conta</button>
        </div>
        <form id="auth-form">
          ${mode === 'register' ? `
            <div class="field">
              <label for="displayName">Nome</label>
              <input id="displayName" name="displayName" autocomplete="name" required maxlength="60">
            </div>
            <div class="field">
              <label for="username">Usuario</label>
              <input id="username" name="username" autocomplete="username" required minlength="3" maxlength="24" pattern="[a-z0-9_]+">
            </div>
            <div class="field">
              <label for="email">E-mail institucional</label>
              <input id="email" name="email" type="email" autocomplete="email" required>
              <span class="hint">${escapeHtml(domains)}</span>
            </div>
            <div class="field">
              <label for="password">Senha</label>
              <input id="password" name="password" type="password" autocomplete="new-password" required minlength="8">
            </div>
          ` : `
            <div class="field">
              <label for="login">Usuario ou e-mail</label>
              <input id="login" name="login" autocomplete="username" required>
            </div>
            <div class="field">
              <label for="password">Senha</label>
              <input id="password" name="password" type="password" autocomplete="current-password" required>
            </div>
          `}
          <button class="primary-btn auth-submit" type="submit">${mode === 'register' ? 'Criar conta' : 'Entrar'}</button>
        </form>
      </section>
    </main>
  `;

  document.querySelectorAll('[data-auth-mode]').forEach((button) => {
    button.addEventListener('click', () => renderAuth(button.dataset.authMode));
  });

  document.querySelector('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setupDeviceCallAlerts();
    primeCallAlertAudio();
    requestCallNotificationPermission();
    const form = new FormData(event.currentTarget);
    try {
      const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const payload = mode === 'register'
        ? {
            displayName: form.get('displayName'),
            username: form.get('username'),
            email: form.get('email'),
            password: form.get('password')
          }
        : {
            login: form.get('login'),
            password: form.get('password')
          };
      const result = await api(endpoint, { method: 'POST', body: payload });
      state.me = result.user;
      await refreshUnreadCounts(false);
      await refreshPresence(false);
      await go('home');
      startVoicePolling();
      startUnreadPolling();
      startPresencePolling();
      showToast(mode === 'register' && result.user.role === 'admin' ? 'Primeira conta criada como admin.' : 'Bem-vindo a SIX.');
    } catch (error) {
      showToast(error.message);
    }
  });
}


// Navegacao interna sem recarregar a pagina inteira.
async function go(view, params = {}) {
  state.view = view;
  state.params = params;
  if (state.me) {
    await refreshUnreadCounts(false);
    await refreshPresence(false);
  }
  renderShell();

  if (view === 'home') await loadHome();
  if (view === 'search') await loadSearch(params.q || '');
  if (view === 'notifications') await loadNotifications();
  if (view === 'messages') await loadMessages(params.userId || null);
  if (view === 'profile') await loadProfile(params.username || state.me.username);
  if (view === 'thread') await loadThread(params.id);
  if (view === 'admin') await loadAdmin(params.tab || state.adminTab);
}
// Icone de sair usado no perfil e no painel da conta.
function logoutIconHtml() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 5H6.5A1.5 1.5 0 0 0 5 6.5v11A1.5 1.5 0 0 0 6.5 19H10"/><path d="M14 8l4 4-4 4"/><path d="M8 12h10"/></svg>';
}
// Icone de lixeira usado para exclusao administrativa imediata.
function trashIconHtml() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M6 7l1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>';
}

// Gera os icones do menu principal. O perfil usa a foto/avatar do usuario logado.
function navIconHtml(view) {
  const icons = {
    home: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.7 12 3l9 7.7v9.8a1.5 1.5 0 0 1-1.5 1.5H15v-6h-6v6H4.5A1.5 1.5 0 0 1 3 20.5v-9.8Z"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 5 5"/></svg>',
    notifications: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9.5a6 6 0 0 0-12 0c0 7-3 7-3 8.5h18c0-1.5-3-1.5-3-8.5Z"/><path d="M9.5 21a2.7 2.7 0 0 0 5 0"/></svg>',
    messages: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5h16v11H4z"/><path d="m4.5 7 7.5 6 7.5-6"/></svg>',
    admin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 2.9 8.5 7 10 4.1-1.5 7-5.5 7-10V6l-7-3Z"/><path d="M9 12h6"/><path d="M12 9v6"/></svg>'
  };
  if (view === 'profile') return avatarHtml(state.me, 'nav-avatar');
  return icons[view] || `<span>${escapeHtml(view.slice(0, 1).toUpperCase())}</span>`;
}
// Retorna o ponto vermelho quando existe aviso ou mensagem nao lida.
function unreadBadgeHtml(view) {
  const count = view === 'notifications'
    ? state.unreadCounts.notifications
    : view === 'messages'
      ? state.unreadCounts.messages
      : 0;
  return count > 0 ? `<span class="nav-badge" title="${count} nao lido${count === 1 ? '' : 's'}"></span>` : '';
}

// Atualiza os contadores de nao lidos sem recarregar a pagina inteira.
async function refreshUnreadCounts(updateDom = true) {
  if (!state.me) return;
  try {
    const counts = await api('/api/unread-counts');
    state.unreadCounts = {
      notifications: Number(counts.notifications || 0),
      messages: Number(counts.messages || 0)
    };
    if (updateDom) renderUnreadBadges();
  } catch {
    state.unreadCounts = { notifications: 0, messages: 0 };
  }
}

function renderUnreadBadges() {
  document.querySelectorAll('.nav-symbol .nav-badge').forEach((badge) => badge.remove());
  ['notifications', 'messages'].forEach((view) => {
    const holder = document.querySelector(`.nav-btn[data-go="${view}"] .nav-symbol`);
    if (holder) holder.insertAdjacentHTML('beforeend', unreadBadgeHtml(view));
  });
}
function startUnreadPolling() {
  if (state.unreadPollTimer) return;
  refreshUnreadCounts().catch(() => null);
  state.unreadPollTimer = setInterval(() => refreshUnreadCounts().catch(() => null), UNREAD_POLL_MS);
}

function stopUnreadPolling() {
  if (state.unreadPollTimer) clearInterval(state.unreadPollTimer);
  state.unreadPollTimer = null;
}


// Atualiza a lista de usuarios online sem recarregar a tela atual.
async function refreshPresence(updateDom = true) {
  if (!state.me) return;
  try {
    const data = await api('/api/presence');
    state.onlineUserIds = new Set((data.onlineUserIds || []).map((id) => Number(id)));
    if (updateDom) renderPresenceIndicators();
  } catch {
    state.onlineUserIds = new Set();
  }
}


// Aplica ou remove o destaque discreto nos elementos de usuarios ja renderizados.
function renderPresenceIndicators() {
  document.querySelectorAll('[data-online-user]').forEach((element) => {
    const online = state.onlineUserIds.has(Number(element.dataset.onlineUser));
    element.classList.toggle('is-online', online);
  });
}


function startPresencePolling() {
  if (state.presencePollTimer) return;
  refreshPresence().catch(() => null);
  state.presencePollTimer = setInterval(() => refreshPresence().catch(() => null), PRESENCE_POLL_MS);
}


function stopPresencePolling() {
  if (state.presencePollTimer) clearInterval(state.presencePollTimer);
  state.presencePollTimer = null;
}

// Estrutura fixa do app logado: menu esquerdo, coluna central e painel direito.
function renderShell() {
  const staffNav = isStaff() ? [['admin', 'Equipe']] : [];
  const activeItems = [...navItems, ...staffNav];
  app.innerHTML = `
    <div class="main-layout">
      <aside class="left-nav">
        <div class="brand-row">
          <img src="${appPath('/assets/logo.svg')}" alt="${escapeAttr(state.config.platformName)}">
          <strong>${escapeHtml(state.config.platformName)}</strong>
        </div>
        <nav class="nav-list" aria-label="Principal">
          ${activeItems.map(([view, label]) => `
            <button class="nav-btn ${state.view === view ? 'active' : ''}" data-go="${view}">
              <span class="nav-symbol">${navIconHtml(view)}${unreadBadgeHtml(view)}</span>
              <span class="nav-label">${label}</span>
            </button>
          `).join('')}
        </nav>
        <button class="primary-btn post-wide" data-compose>Publicar</button>
        <button class="account-mini" data-go="profile">
          ${avatarHtml(state.me)}
          <span class="account-text">
            <strong class="online-name${onlineClass(state.me)}"${onlineUserAttr(state.me)}>${escapeHtml(state.me.displayName)}</strong><br>
            <span class="username">@${escapeHtml(state.me.username)}</span>
          </span>
        </button>
      </aside>
      <main id="main" class="feed-main">
        <div class="view-header"><h1>${escapeHtml(viewTitle())}</h1></div>
        <div class="loading">Carregando...</div>
      </main>
      <aside class="right-rail">
        ${rightRailHtml()}
      </aside>
    </div>
  `;

  document.querySelectorAll('[data-go]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.go;
      if (target === 'profile') go('profile', { username: state.me.username });
      else go(target);
    });
  });

  document.querySelector('[data-compose]')?.addEventListener('click', () => {
    go('home').then(() => document.querySelector('#composer-body')?.focus());
  });

  bindLogoutButtons(app);
}


// Painel lateral com contexto da escola e atalhos da equipe.
function rightRailHtml() {
  const domains = state.config.allowedDomains.map((domain) => `@${domain}`).join('<br>');
  return `
    <section class="rail-card">
      <h2>${escapeHtml(state.config.schoolName)}</h2>
      <div class="rail-row">
        <strong>Rede escolar</strong>
        <span class="muted">Todos os alunos visualizam a escola inteira.</span>
      </div>
      <div class="rail-row">
        <strong>E-mails aceitos</strong>
        <span class="muted">${domains}</span>
      </div>
    </section>
    <section class="rail-card">
      <h2>Conta</h2>
      <div class="rail-row">
        <strong>${escapeHtml(roleLabel(state.me.role))}</strong>
        <span class="muted">@${escapeHtml(state.me.username)}</span>
      </div>
      <div class="rail-row">
        <button class="ghost-btn logout-btn" type="button" data-logout><span class="btn-icon">${logoutIconHtml()}</span><span>Sair</span></button>
      </div>
    </section>
  `;
}


// Carrega o feed recomendado e conecta o compositor de novas publicacoes.
async function loadHome() {
  setMain(`
    <div class="view-header"><h1>Inicio</h1><button class="ghost-btn" data-refresh>Atualizar</button></div>
    ${composerHtml()}
    <section id="feed-list"><div class="loading">Carregando feed...</div></section>
  `);
  attachComposer(null, () => loadHome());
  document.querySelector('[data-refresh]')?.addEventListener('click', () => loadHome());

  const data = await api('/api/feed');
  const list = document.querySelector('#feed-list');
  list.innerHTML = data.posts.length ? data.posts.map(postHtml).join('') : `<div class="empty">Nada publicado ainda.</div>`;
  attachPostActions(list);
}


// Carrega uma conversa especifica e permite responder ao post raiz.
async function loadThread(postId) {
  if (!postId) {
    await go('home');
    return;
  }
  setMain(`
    <div class="view-header">
      <button class="ghost-btn" data-back>Voltar</button>
      <h1>Conversa</h1>
      <span></span>
    </div>
    <section id="thread-list"><div class="loading">Carregando conversa...</div></section>
    ${composerHtml(postId, 'Responder')}
  `);
  document.querySelector('[data-back]')?.addEventListener('click', () => go('home'));
  attachComposer(postId, () => loadThread(postId));

  const data = await api(`/api/posts/${postId}/thread`);
  const list = document.querySelector('#thread-list');
  list.innerHTML = data.posts.length ? data.posts.map(postHtml).join('') : `<div class="empty">Conversa nao encontrada.</div>`;
  attachPostActions(list);
}


// Tela de busca por pessoas e publicacoes.
async function loadSearch(query) {
  setMain(`
    <div class="view-header"><h1>Busca</h1></div>
    <form class="search-box" id="search-form">
      <input name="q" value="${escapeAttr(query)}" placeholder="Buscar pessoas e publicacoes" autocomplete="off">
    </form>
    <section id="search-results">${query ? '<div class="loading">Buscando...</div>' : '<div class="empty">Digite pelo menos 2 caracteres.</div>'}</section>
  `);

  document.querySelector('#search-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    go('search', { q });
  });

  if (!query || query.length < 2) return;

  const data = await api(`/api/search?q=${encodeURIComponent(query)}`);
  const results = document.querySelector('#search-results');
  results.innerHTML = `
    <h2 class="section-title">Pessoas</h2>
    ${data.users.length ? data.users.map(userCardHtml).join('') : '<div class="empty">Nenhuma pessoa encontrada.</div>'}
    <h2 class="section-title">Publicacoes</h2>
    ${data.posts.length ? data.posts.map(postHtml).join('') : '<div class="empty">Nenhuma publicacao encontrada.</div>'}
  `;
  attachUserActions(results);
  attachPostActions(results);
}


// Mostra notificacoes e marca tudo como lido quando a tela abre.
async function loadNotifications() {
  setMain(`
    <div class="view-header">
      <h1>Notificacoes</h1>
      <button class="ghost-btn" data-read-all>Lidas</button>
    </div>
    <section id="notifications-list"><div class="loading">Carregando notificacoes...</div></section>
  `);

  document.querySelector('[data-read-all]')?.addEventListener('click', async () => {
    await api('/api/notifications/read', { method: 'POST', body: {} });
    await refreshUnreadCounts();
    await loadNotifications();
  });

  const data = await api('/api/notifications');
  const list = document.querySelector('#notifications-list');
  list.innerHTML = data.notifications.length
    ? data.notifications.map(notificationCardHtml).join('')
    : '<div class="empty">Sem notificacoes.</div>';
  attachNotificationActions(list);

  if (data.notifications.some((notification) => !notification.readAt)) {
    await api('/api/notifications/read', { method: 'POST', body: {} });
    list.querySelectorAll('.notice-card.unread').forEach((card) => {
      card.classList.remove('unread');
      card.classList.add('read');
    });
    list.querySelectorAll('[data-notice-new]').forEach((badge) => badge.remove());
    await refreshUnreadCounts();
  }
}


// Monta cada aviso com link para o usuario e para o destino da acao.
function notificationCardHtml(notification) {
  const actor = notification.actor;
  const target = notificationTarget(notification);
  const actionAttrs = target
    ? ` data-notification-action="${escapeAttr(target.action)}" data-notification-value="${escapeAttr(target.value)}"`
    : '';
  const actorProfile = actor?.username
    ? ` data-notification-profile="${escapeAttr(actor.username)}"`
    : '';
  const actorName = actor?.displayName || 'SIX';
  const actorUsername = actor?.username ? `@${actor.username}` : 'Sistema';

  return `
    <article class="notice-card ${notification.readAt ? 'read' : 'unread'}${target ? ' notice-card-action' : ''}"${actionAttrs}>
      ${actor ? `
        <button class="notice-avatar-link" type="button"${actorProfile} title="Abrir perfil de ${escapeAttr(actorName)}" aria-label="Abrir perfil de ${escapeAttr(actorName)}">
          ${avatarHtml(actor)}
        </button>
      ` : avatarHtml({ displayName: 'SIX', username: 'six' })}
      <div class="notice-body">
        <div class="message-top">
          ${actor ? `
            <button class="name ghost-link${onlineClass(actor)}" type="button"${actorProfile}${onlineUserAttr(actor)}>${escapeHtml(actorName)}</button>
          ` : `<strong>${escapeHtml(actorName)}</strong>`}
          ${notification.readAt ? '' : '<span class="role teacher" data-notice-new>novo</span>'}
        </div>
        <p>${escapeHtml(notification.body)}</p>
        <div class="username">${escapeHtml(actorUsername)}</div>
        <div class="muted">${formatTime(notification.createdAt)}</div>
      </div>
      ${target ? `<button class="ghost-btn notice-target-btn" type="button" data-notification-action="${escapeAttr(target.action)}" data-notification-value="${escapeAttr(target.value)}">${escapeHtml(target.label)}</button>` : ''}
    </article>
  `;
}


// Decide para onde cada notificacao deve levar quando o usuario clica nela.
function notificationTarget(notification) {
  if (notification.entityType === 'message' && notification.actor?.id) {
    return { action: 'messages', value: notification.actor.id, label: 'Abrir conversa' };
  }
  if (notification.entityType === 'voice_call' && notification.actor?.id) {
    return { action: 'messages', value: notification.actor.id, label: 'Abrir mensagens' };
  }
  if (notification.entityType === 'post' && notification.entityId) {
    return { action: 'thread', value: notification.entityId, label: 'Abrir publicacao' };
  }
  if (notification.actor?.username) {
    return { action: 'profile', value: notification.actor.username, label: 'Abrir perfil' };
  }
  return null;
}


// Liga os cliques dos avisos ao perfil, publicacao ou conversa correspondente.
function attachNotificationActions(scope) {
  scope.querySelectorAll('[data-notification-profile]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      go('profile', { username: element.dataset.notificationProfile });
    });
  });

  scope.querySelectorAll('[data-notification-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openNotificationTarget(element.dataset.notificationAction, element.dataset.notificationValue);
    });
  });
}


// Abre o destino escolhido para a notificacao.
function openNotificationTarget(action, value) {
  if (action === 'thread') return go('thread', { id: value });
  if (action === 'messages') return go('messages', { userId: value });
  if (action === 'profile') return go('profile', { username: value });
  return null;
}


// Perfil publico: capa, foto, bio, seguir/mensagem e posts do usuario.
async function loadProfile(username) {
  setMain(`
    <div class="view-header"><h1>Perfil</h1></div>
    <section id="profile-view"><div class="loading">Carregando perfil...</div></section>
  `);

  const data = await api(`/api/users/${encodeURIComponent(username)}`);
  const profile = document.querySelector('#profile-view');
  const user = data.user;
  const mine = user.id === state.me.id;
  profile.innerHTML = `
    <div class="profile-banner"${user.bannerUrl ? ` style="background-image:url('${escapeAttr(mediaUrl(user.bannerUrl))}');background-size:cover;background-position:center"` : ''}></div>
    <div class="profile-head">
      <div class="profile-actions">
        ${mine ? `
          <button class="ghost-btn" data-upload-profile-image="avatar">Trocar foto</button>
          <button class="ghost-btn" data-upload-profile-image="banner">Trocar capa</button>
          <button class="primary-btn" data-edit-profile>Editar perfil</button>
          <button class="ghost-btn icon-only logout-icon-btn" type="button" data-logout title="Sair" aria-label="Sair">${logoutIconHtml()}</button>
        ` : `
          <button class="ghost-btn" data-dm-user="${user.id}">Mensagem</button>
          <button class="primary-btn" data-follow-user="${user.id}" data-followed="${user.followedByMe ? '1' : '0'}">${user.followedByMe ? 'Seguindo' : 'Seguir'}</button>
        `}
      </div>
      ${avatarHtml(user, 'profile-avatar')}
      <h2 class="profile-name${onlineClass(user)}"${onlineUserAttr(user)}>${escapeHtml(user.displayName)}</h2>
      <div class="username">@${escapeHtml(user.username)} <span class="role ${escapeAttr(user.role)}">${escapeHtml(roleLabel(user.role))}</span></div>
      <p class="profile-bio">${escapeHtml(user.bio || '')}</p>
      <div class="profile-stats">
        <span><strong>${user.followingCount}</strong> seguindo</span>
        <span><strong>${user.followerCount}</strong> seguidores</span>
      </div>
    </div>
    <h2 class="section-title">Publicacoes</h2>
    <section>${data.posts.length ? data.posts.map(postHtml).join('') : '<div class="empty">Sem publicacoes.</div>'}</section>
  `;

  attachUserActions(profile);
  attachPostActions(profile);
  bindLogoutButtons(profile);
  document.querySelector('[data-edit-profile]')?.addEventListener('click', editProfile);
  document.querySelectorAll('[data-upload-profile-image]').forEach((button) => {
    button.addEventListener('click', () => chooseProfileImage(button.dataset.uploadProfileImage));
  });
}


// Tela de mensagens privadas com lista de conversas e painel de conversa.
async function loadMessages(userId) {
  setMain(`
    <div class="view-header"><h1>Mensagens</h1></div>
    <section class="two-pane">
      <aside class="pane-list">
        <form class="search-box" id="message-search">
          <input name="q" placeholder="Buscar pessoa" autocomplete="off">
        </form>
        <div id="conversation-list"><div class="loading">Carregando...</div></div>
      </aside>
      <section id="message-panel"><div class="empty">Selecione uma conversa.</div></section>
    </section>
  `);

  document.querySelector('#message-search').addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get('q');
    const data = await api(`/api/users?q=${encodeURIComponent(q)}`);
    document.querySelector('#conversation-list').innerHTML = data.users.length
      ? data.users.map((user) => conversationButtonHtml(user, '', Number(userId) === user.id)).join('')
      : '<div class="empty">Nenhuma pessoa encontrada.</div>';
    attachConversationButtons();
  });

  const conversations = await api('/api/messages/conversations');
  const list = document.querySelector('#conversation-list');
  list.innerHTML = conversations.conversations.length
    ? conversations.conversations.map((item) => conversationButtonHtml(item.user, item.lastMessage.body, Number(userId) === item.user.id, item.unread)).join('')
    : '<div class="empty">Sem conversas.</div>';
  attachConversationButtons();

  if (userId) await renderMessageThread(userId);
}


// Renderiza o historico com uma pessoa e liga o formulario de envio.
async function renderMessageThread(userId) {
  const data = await api(`/api/messages/${userId}`);
  await refreshUnreadCounts();
  const panel = document.querySelector('#message-panel');
  panel.innerHTML = `
    <div class="view-header message-head">
      <h1 class="online-name${onlineClass(data.user)}"${onlineUserAttr(data.user)}>${escapeHtml(data.user.displayName)}</h1>
      <div class="message-head-actions">
        <button class="ghost-btn" data-profile="${escapeAttr(data.user.username)}">@${escapeHtml(data.user.username)}</button>
        <button class="ghost-btn" type="button" data-start-voice="${data.user.id}">Voz</button>
        <button class="primary-btn" type="button" data-start-video="${data.user.id}">Video</button>
      </div>
    </div>
    <div class="message-thread" id="message-thread">
      ${data.messages.length ? data.messages.map((message) => `
        <div class="bubble ${message.mine ? 'mine' : ''}">
          ${escapeHtml(message.body)}
          <div class="time">${formatTime(message.createdAt)}</div>
        </div>
      `).join('') : '<div class="empty">Comece a conversa.</div>'}
    </div>
    <form class="message-form" id="message-form">
      <textarea name="body" placeholder="Mensagem" maxlength="1000" required></textarea>
      <button class="primary-btn">Enviar</button>
    </form>
  `;
  document.querySelector('#message-thread')?.scrollTo(0, 999999);
  document.querySelector('[data-profile]')?.addEventListener('click', (event) => go('profile', { username: event.currentTarget.dataset.profile }));
  document.querySelector('[data-start-voice]')?.addEventListener('click', (event) => startVoiceCall(event.currentTarget.dataset.startVoice, 'audio'));
  document.querySelector('[data-start-video]')?.addEventListener('click', (event) => startVoiceCall(event.currentTarget.dataset.startVideo, 'video'));
  document.querySelector('#message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const body = new FormData(event.currentTarget).get('body');
    await api('/api/messages', { method: 'POST', body: { recipientId: Number(userId), body } });
    await loadMessages(userId);
  });
}

// Inicia uma chamada de audio ou video para a pessoa aberta na conversa.
async function startVoiceCall(peerId, kind = 'audio') {
  const problem = voiceSupportProblem(kind);
  if (problem) {
    showToast(problem);
    return;
  }
  if (voiceState.call) {
    showToast('Ja existe uma chamada em andamento.');
    return;
  }

  let createdCall = null;
  voiceState.kind = kind;
  voiceState.isBusy = true;
  voiceState.statusText = openingMediaLabel(kind);
  try {
    const data = await api('/api/calls', { method: 'POST', body: { recipientId: Number(peerId), kind } });
    createdCall = data.call;
    await prepareVoiceConnection(createdCall, true, kind);
    const offer = await voiceState.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: kind === 'video' });
    await voiceState.pc.setLocalDescription(offer);
    await sendVoiceSignal('offer', voiceState.pc.localDescription);
    voiceState.isBusy = false;
    voiceState.statusText = 'Chamando...';
    renderVoiceCallPanel();
    startVoiceSignalPolling();
  } catch (error) {
    if (createdCall?.id) await api(`/api/calls/${createdCall.id}/end`, { method: 'POST', body: {} }).catch(() => null);
    cleanupVoiceCall();
    showToast(friendlyVoiceError(error, kind));
  }
}

// Prepara microfone/camera, conexao WebRTC e elementos de midia remota.
async function prepareVoiceConnection(call, isCaller, requestedKind = 'audio') {
  const kind = call.kind || requestedKind || 'audio';
  voiceState.call = call;
  voiceState.peer = call.peer;
  voiceState.kind = kind;
  voiceState.isCaller = isCaller;
  voiceState.pendingCandidates = [];
  voiceState.signalCursor = 0;
  voiceState.statusText = isCaller ? 'Chamando...' : 'Conectando...';

  const sourceStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video' ? videoCaptureConstraints('user') : false
  });
  voiceState.sourceStream = sourceStream;
  voiceState.cameraFacing = 'user';
  voiceState.localStream = kind === 'video' ? createPortraitVideoStream(sourceStream) : sourceStream;

  const pc = new RTCPeerConnection(RTC_CONFIG);
  voiceState.pc = pc;
  voiceState.localStream.getTracks().forEach((track) => pc.addTrack(track, voiceState.localStream));

  pc.addEventListener('icecandidate', (event) => {
    if (event.candidate) sendVoiceSignal('candidate', event.candidate).catch(() => null);
  });
  pc.addEventListener('track', (event) => {
    voiceState.remoteStream = event.streams[0] || voiceState.remoteStream;
    if (currentCallKind() === 'video') {
      attachVideoStreams();
    } else {
      const audio = ensureRemoteAudio();
      audio.srcObject = voiceState.remoteStream;
      audio.play().catch(() => null);
    }
  });
  pc.addEventListener('connectionstatechange', () => {
    const label = {
      connecting: 'Conectando...',
      connected: currentCallKind() === 'video' ? 'Chamada de video ativa' : 'Chamada ativa',
      disconnected: 'Reconectando...',
      failed: 'Falha na chamada',
      closed: 'Chamada encerrada'
    }[pc.connectionState];
    if (label) {
      voiceState.statusText = label;
      renderVoiceCallPanel();
    }
    if (['failed', 'closed'].includes(pc.connectionState)) cleanupVoiceCall();
  });

  renderVoiceCallPanel();
}
// Atende uma chamada recebida e responde ao offer WebRTC do chamador.
async function answerVoiceCall() {
  const call = voiceState.call;
  const kind = currentCallKind();
  const problem = voiceSupportProblem(kind);
  if (!call || voiceState.isBusy) return;
  stopIncomingCallAlert();
  if (problem) {
    voiceState.statusText = problem;
    renderVoiceCallPanel();
    showToast(problem);
    return;
  }

  voiceState.isBusy = true;
  voiceState.statusText = openingMediaLabel(kind);
  renderVoiceCallPanel();
  stopVoiceSignalPolling();

  try {
    await prepareVoiceConnection(call, false, kind);
    const answered = await api(`/api/calls/${call.id}/answer`, { method: 'POST', body: {} });
    voiceState.call = answered.call;
    voiceState.peer = answered.call.peer;
    const signals = await api(`/api/calls/${call.id}/signals?after=0`);
    voiceState.signalCursor = signals.lastSignalId || 0;
    for (const signal of signals.signals) await handleVoiceSignal(signal);
    voiceState.isBusy = false;
    voiceState.statusText = 'Conectando...';
    renderVoiceCallPanel();
    startVoiceSignalPolling();
  } catch (error) {
    resetVoiceConnection();
    voiceState.isBusy = false;
    voiceState.statusText = friendlyVoiceError(error, kind);
    renderVoiceCallPanel();
    startVoiceSignalPolling();
    showToast(voiceState.statusText);
  }
}

// Recusa a chamada recebida antes de abrir o microfone.
async function declineVoiceCall() {
  const call = voiceState.call;
  if (!call) return;
  stopIncomingCallAlert();
  try {
    await api(`/api/calls/${call.id}/decline`, { method: 'POST', body: {} });
  } catch (error) {
    showToast(error.message);
  } finally {
    cleanupVoiceCall();
  }
}

// Encerra a chamada localmente e avisa o servidor quando ainda houver sessao.
async function endVoiceCall(sendRequest = true) {
  const call = voiceState.call;
  stopIncomingCallAlert();
  if (sendRequest && call) {
    await api(`/api/calls/${call.id}/end`, { method: 'POST', body: {} }).catch(() => null);
  }
  cleanupVoiceCall();
}

// Envia offer, answer ou candidate para o servidor entregar ao outro navegador.
async function sendVoiceSignal(type, payload) {
  if (!voiceState.call) return;
  const safePayload = JSON.parse(JSON.stringify(payload || {}));
  await api(`/api/calls/${voiceState.call.id}/signals`, { method: 'POST', body: { type, payload: safePayload } });
}

// Consulta sinais novos enquanto a chamada esta tocando ou ativa.
function startVoiceSignalPolling() {
  stopVoiceSignalPolling();
  voiceState.signalPollTimer = setInterval(() => pollVoiceSignals().catch(() => null), VOICE_SIGNAL_POLL_MS);
  pollVoiceSignals().catch(() => null);
}

function stopVoiceSignalPolling() {
  if (voiceState.signalPollTimer) clearInterval(voiceState.signalPollTimer);
  voiceState.signalPollTimer = null;
}

async function pollVoiceSignals() {
  if (!voiceState.call || voiceState.pollingSignals || voiceState.isBusy) return;
  voiceState.pollingSignals = true;
  try {
    const previousStatus = voiceState.call.status;
    const data = await api(`/api/calls/${voiceState.call.id}/signals?after=${voiceState.signalCursor}`);
    voiceState.call = data.call;
    voiceState.peer = data.call.peer;
    if (!['ringing', 'active'].includes(data.call.status)) {
      showToast(voiceCallStatusLabel(data.call.status, data.call.kind || currentCallKind()));
      cleanupVoiceCall();
      return;
    }
    voiceState.signalCursor = data.lastSignalId || voiceState.signalCursor;
    for (const signal of data.signals) await handleVoiceSignal(signal);
    if (data.call.status !== previousStatus || data.signals.length > 0) renderVoiceCallPanel();
  } finally {
    voiceState.pollingSignals = false;
  }
}

// Aplica os sinais recebidos: offer cria answer, answer fecha negociacao, candidate ajuda a conectar.
async function handleVoiceSignal(signal) {
  if (!voiceState.pc) return;
  if (signal.type === 'offer') {
    if (voiceState.pc.signalingState !== 'stable') return;
    await voiceState.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
    await flushPendingVoiceCandidates();
    const answer = await voiceState.pc.createAnswer();
    await voiceState.pc.setLocalDescription(answer);
    await sendVoiceSignal('answer', voiceState.pc.localDescription);
    voiceState.statusText = 'Conectando...';
  }
  if (signal.type === 'answer') {
    if (!voiceState.pc.currentRemoteDescription) {
      await voiceState.pc.setRemoteDescription(new RTCSessionDescription(signal.payload));
      await flushPendingVoiceCandidates();
      voiceState.statusText = 'Conectando...';
    }
  }
  if (signal.type === 'candidate') await addRemoteVoiceCandidate(signal.payload);
}

async function addRemoteVoiceCandidate(candidate) {
  if (!candidate || !voiceState.pc) return;
  if (!voiceState.pc.remoteDescription) {
    voiceState.pendingCandidates.push(candidate);
    return;
  }
  await voiceState.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => null);
}

async function flushPendingVoiceCandidates() {
  const candidates = voiceState.pendingCandidates.splice(0);
  for (const candidate of candidates) await addRemoteVoiceCandidate(candidate);
}

// Polling leve para descobrir chamadas recebidas mesmo quando a aba Mensagens nao esta aberta.
function startVoicePolling() {
  if (voiceState.incomingPollTimer) return;
  pollIncomingVoiceCalls().catch(() => null);
  voiceState.incomingPollTimer = setInterval(() => pollIncomingVoiceCalls().catch(() => null), VOICE_POLL_MS);
}

function stopVoicePolling() {
  if (voiceState.incomingPollTimer) clearInterval(voiceState.incomingPollTimer);
  voiceState.incomingPollTimer = null;
}
// Prepara o navegador para tocar e mostrar notificacoes de chamadas recebidas.
function setupDeviceCallAlerts() {
  if (callAlertState.setup) return;
  callAlertState.setup = true;
  const enableAlerts = () => {
    primeCallAlertAudio();
    requestCallNotificationPermission();
  };
  document.addEventListener('pointerdown', enableAlerts, { once: true, passive: true });
  document.addEventListener('keydown', enableAlerts, { once: true });
}

function requestCallNotificationPermission() {
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  if (!window.isSecureContext && !isLocalBrowserHost()) return;
  const permissionRequest = Notification.requestPermission();
  if (permissionRequest?.catch) permissionRequest.catch(() => null);
}

function isLocalBrowserHost() {
  const host = window.location.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function ensureCallAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  if (!callAlertState.audioContext) callAlertState.audioContext = new AudioContextClass();
  return callAlertState.audioContext;
}

function primeCallAlertAudio() {
  const context = ensureCallAudioContext();
  if (!context || context.state !== 'suspended') return;
  context.resume().catch(() => null);
}

function startIncomingCallAlert(call) {
  if (!call?.incoming) return;
  if (callAlertState.lastCallId === call.id && callAlertState.ringTimer) return;
  stopIncomingCallAlert();
  callAlertState.lastCallId = call.id;
  showIncomingCallNotification(call);
  playIncomingCallRing();
  callAlertState.ringTimer = setInterval(playIncomingCallRing, CALL_RING_INTERVAL_MS);
}

function stopIncomingCallAlert() {
  if (callAlertState.ringTimer) clearInterval(callAlertState.ringTimer);
  callAlertState.ringTimer = null;
  callAlertState.lastCallId = null;
  callAlertState.activeNotification?.close();
  callAlertState.activeNotification = null;
}

function showIncomingCallNotification(call) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (!window.isSecureContext && !isLocalBrowserHost()) return;
  const peerName = call.peer?.displayName || 'Usuario';
  const mediaLabel = (call.kind || 'audio') === 'video' ? 'video' : 'voz';
  callAlertState.activeNotification?.close();
  const notification = new Notification(`${state.config?.platformName || 'SIX'} - chamada de ${mediaLabel}`, {
    body: `${peerName} esta chamando voce.`,
    icon: appPath('/assets/logo.svg'),
    tag: CALL_NOTIFICATION_TAG,
    renotify: true,
    requireInteraction: true
  });
  notification.addEventListener('click', () => {
    window.focus();
    notification.close();
    if (call.peer?.id) go('messages', { userId: call.peer.id }).catch(() => null);
  });
  callAlertState.activeNotification = notification;
}

function playIncomingCallRing() {
  const context = ensureCallAudioContext();
  if (!context) return;
  const startTone = () => {
    const startAt = context.currentTime + 0.02;
    const stopAt = startAt + CALL_RING_BURST_SECONDS;
    const gain = context.createGain();
    const lowTone = context.createOscillator();
    const highTone = context.createOscillator();
    lowTone.type = 'sine';
    highTone.type = 'sine';
    lowTone.frequency.setValueAtTime(440, startAt);
    highTone.frequency.setValueAtTime(480, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    schedulePhonePulse(gain.gain, startAt, 0, 0.43);
    schedulePhonePulse(gain.gain, startAt, 0.62, 0.43);
    lowTone.connect(gain);
    highTone.connect(gain);
    gain.connect(context.destination);
    lowTone.start(startAt);
    highTone.start(startAt);
    lowTone.stop(stopAt);
    highTone.stop(stopAt);
    highTone.addEventListener('ended', () => {
      lowTone.disconnect();
      highTone.disconnect();
      gain.disconnect();
    }, { once: true });
  };
  if (context.state === 'suspended') {
    context.resume().then(startTone).catch(() => null);
  } else {
    startTone();
  }
}

function schedulePhonePulse(param, baseTime, offset, duration) {
  const startAt = baseTime + offset;
  const endAt = startAt + duration;
  param.setValueAtTime(0.0001, startAt);
  param.exponentialRampToValueAtTime(0.18, startAt + 0.03);
  param.setValueAtTime(0.18, endAt - 0.04);
  param.exponentialRampToValueAtTime(0.0001, endAt);
}

async function pollIncomingVoiceCalls() {
  if (!state.me || voiceState.call) return;
  const data = await api('/api/calls/active');
  const incoming = data.calls.find((call) => call.incoming);
  if (!incoming) return;
  voiceState.call = incoming;
  voiceState.peer = incoming.peer;
  voiceState.kind = incoming.kind || 'audio';
  voiceState.statusText = currentCallKind() === 'video' ? 'Chamada de video recebida' : 'Chamada recebida';
  startIncomingCallAlert(incoming);
  renderVoiceCallPanel();
  startVoiceSignalPolling();
}

// Mostra o painel flutuante da chamada e conecta seus botoes.
function renderVoiceCallPanel() {
  let panel = document.querySelector('#voice-call-panel');
  if (!voiceState.call) {
    panel?.remove();
    return;
  }
  if (!panel) {
    document.body.insertAdjacentHTML('beforeend', '<section class="voice-call-panel" id="voice-call-panel" aria-live="polite"></section>');
    panel = document.querySelector('#voice-call-panel');
  }

  const call = voiceState.call;
  const kind = currentCallKind();
  const incomingWaiting = call.incoming && !voiceState.pc;
  const status = voiceState.statusText || voiceCallStatusLabel(call.status, kind);
  const disabled = voiceState.isBusy || voiceState.switchingCamera ? ' disabled' : '';
  const title = kind === 'video' ? 'Chamada de video' : 'Chamada de voz';
  panel.classList.toggle('video-active', kind === 'video');
  panel.innerHTML = `
    <div class="voice-call-content">
      <div class="voice-call-main">
        ${avatarHtml(voiceState.peer || call.peer)}
        <div>
          <strong class="online-name${onlineClass(voiceState.peer || call.peer)}"${onlineUserAttr(voiceState.peer || call.peer)}>${escapeHtml((voiceState.peer || call.peer).displayName)}</strong>
          <span>${escapeHtml(title)} - ${escapeHtml(status)}</span>
        </div>
      </div>
      ${kind === 'video' && !incomingWaiting ? `
        <div class="voice-video-grid portrait-mode" id="voice-video-grid">
          <video id="voice-remote-video" class="voice-remote-video" autoplay playsinline></video>
          <video id="voice-local-video" class="voice-local-video" autoplay playsinline muted></video>
        </div>
      ` : ''}
    </div>
    <div class="voice-call-actions">
      ${incomingWaiting ? `
        <button class="primary-btn" type="button" data-voice-action="answer"${disabled}>${voiceState.isBusy ? 'Atendendo...' : 'Atender'}</button>
        <button class="danger-btn" type="button" data-voice-action="decline"${disabled}>Recusar</button>
      ` : `
        ${kind === 'video' ? `<button class="ghost-btn" type="button" data-voice-action="switch-camera"${disabled}>${voiceState.switchingCamera ? 'Trocando...' : 'Trocar camera'}</button><button class="ghost-btn" type="button" data-voice-action="fullscreen"${disabled}>Tela cheia</button>` : ''}
        <button class="danger-btn" type="button" data-voice-action="end"${disabled}>Encerrar</button>
      `}
    </div>
  `;

  attachVideoStreams();
  panel.querySelector('[data-voice-action="answer"]')?.addEventListener('click', answerVoiceCall);
  panel.querySelector('[data-voice-action="decline"]')?.addEventListener('click', declineVoiceCall);
  panel.querySelector('[data-voice-action="switch-camera"]')?.addEventListener('click', switchVoiceCamera);
  panel.querySelector('[data-voice-action="fullscreen"]')?.addEventListener('click', openVoiceVideoFullscreen);
  panel.querySelector('[data-voice-action="end"]')?.addEventListener('click', () => endVoiceCall(true));
}

function attachVideoStreams() {
  const localVideo = document.querySelector('#voice-local-video');
  if (localVideo && voiceState.localStream && localVideo.srcObject !== voiceState.localStream) {
    localVideo.srcObject = voiceState.localStream;
    localVideo.play().catch(() => null);
  }

  const remoteVideo = document.querySelector('#voice-remote-video');
  if (remoteVideo && voiceState.remoteStream && remoteVideo.srcObject !== voiceState.remoteStream) {
    remoteVideo.srcObject = voiceState.remoteStream;
    remoteVideo.play().catch(() => null);
  }
}



function videoCaptureConstraints(facingMode = 'user', strict = false) {
  return {
    width: { ideal: PORTRAIT_VIDEO_WIDTH },
    height: { ideal: PORTRAIT_VIDEO_HEIGHT },
    aspectRatio: { ideal: 9 / 16 },
    facingMode: strict ? { exact: facingMode } : { ideal: facingMode }
  };
}

async function openCameraOnlyStream(facingMode) {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: false, video: videoCaptureConstraints(facingMode, true) });
  } catch {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: videoCaptureConstraints(facingMode, false) });
  }
}
function createPortraitVideoStream(sourceStream) {
  const videoTrack = sourceStream.getVideoTracks()[0];
  if (!videoTrack || !HTMLCanvasElement.prototype.captureStream) return sourceStream;

  const portraitVideo = document.createElement('video');
  portraitVideo.muted = true;
  portraitVideo.playsInline = true;
  portraitVideo.autoplay = true;
  portraitVideo.srcObject = new MediaStream([videoTrack]);

  const portraitCanvas = document.createElement('canvas');
  portraitCanvas.width = PORTRAIT_VIDEO_WIDTH;
  portraitCanvas.height = PORTRAIT_VIDEO_HEIGHT;
  const context = portraitCanvas.getContext('2d', { alpha: false });
  if (!context) return sourceStream;

  const drawFrame = () => {
    drawPortraitFrame(context, portraitVideo, portraitCanvas);
    voiceState.portraitFrame = requestAnimationFrame(drawFrame);
  };
  const startPortraitRender = () => {
    if (voiceState.portraitFrame) cancelAnimationFrame(voiceState.portraitFrame);
    drawFrame();
  };

  if (portraitVideo.readyState >= 1) {
    startPortraitRender();
  } else {
    portraitVideo.addEventListener('loadedmetadata', startPortraitRender, { once: true });
  }
  portraitVideo.play().catch(() => null);

  voiceState.portraitVideo = portraitVideo;
  voiceState.portraitCanvas = portraitCanvas;

  const portraitStream = portraitCanvas.captureStream(30);
  sourceStream.getAudioTracks().forEach((track) => portraitStream.addTrack(track));
  return portraitStream;
}

function drawPortraitFrame(context, video, canvas) {
  const videoWidth = video.videoWidth || PORTRAIT_VIDEO_WIDTH;
  const videoHeight = video.videoHeight || PORTRAIT_VIDEO_HEIGHT;
  const targetRatio = canvas.width / canvas.height;
  const sourceRatio = videoWidth / videoHeight;
  let sx = 0;
  let sy = 0;
  let sw = videoWidth;
  let sh = videoHeight;

  if (sourceRatio > targetRatio) {
    sw = videoHeight * targetRatio;
    sx = (videoWidth - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    sh = videoWidth / targetRatio;
    sy = (videoHeight - sh) / 2;
  }

  context.fillStyle = '#050505';
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (video.readyState >= 2) context.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
}


async function switchVoiceCamera() {
  if (currentCallKind() !== 'video' || !voiceState.pc || !voiceState.sourceStream || voiceState.switchingCamera) return;

  const nextFacing = voiceState.cameraFacing === 'user' ? 'environment' : 'user';
  const previousFacing = voiceState.cameraFacing || 'user';
  const previousLocalStream = voiceState.localStream;
  const previousLocalVideoTracks = previousLocalStream?.getVideoTracks() || [];
  const previousSourceVideoTracks = voiceState.sourceStream.getVideoTracks();
  const previousPortraitVideo = voiceState.portraitVideo;
  voiceState.switchingCamera = true;
  voiceState.statusText = 'Trocando camera...';
  renderVoiceCallPanel();

  let cameraStream = null;
  try {
    cameraStream = await openCameraOnlyStream(nextFacing);
    const newSourceTrack = cameraStream.getVideoTracks()[0];
    if (!newSourceTrack) throw new Error('Camera nao encontrada.');

    const nextSourceStream = new MediaStream([...voiceState.sourceStream.getAudioTracks(), newSourceTrack]);
    const newLocalStream = createPortraitVideoStream(nextSourceStream);
    const newVideoTrack = newLocalStream.getVideoTracks()[0];
    const sender = voiceState.pc.getSenders().find((item) => item.track?.kind === 'video');
    if (!sender || !newVideoTrack) throw new Error('Nao foi possivel substituir a camera.');

    await sender.replaceTrack(newVideoTrack);
    newSourceTrack.enabled = true;
    [...previousSourceVideoTracks, ...previousLocalVideoTracks].forEach((track) => {
      if (track !== newSourceTrack && track !== newVideoTrack) track.stop();
    });
    if (previousPortraitVideo && previousPortraitVideo !== voiceState.portraitVideo) {
      previousPortraitVideo.pause();
      previousPortraitVideo.srcObject = null;
    }

    voiceState.sourceStream = nextSourceStream;
    voiceState.localStream = newLocalStream;
    voiceState.cameraFacing = nextFacing;
    voiceState.statusText = nextFacing === 'environment' ? 'Camera traseira ativa' : 'Camera dianteira ativa';
    attachVideoStreams();
  } catch (error) {
    cameraStream?.getTracks().forEach((track) => track.stop());
    voiceState.cameraFacing = previousFacing;
    voiceState.statusText = 'Chamada de video ativa';
    showToast(nextFacing === 'environment' ? 'Nao foi possivel abrir a camera traseira.' : 'Nao foi possivel abrir a camera dianteira.');
  } finally {
    voiceState.switchingCamera = false;
    renderVoiceCallPanel();
  }
}
async function openVoiceVideoFullscreen() {
  const target = document.querySelector('#voice-video-grid');
  if (!target) return;
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    const request = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
    if (request) await request.call(target);
  } catch (error) {
    showToast('Nao foi possivel abrir em tela cheia.');
  }
}
function ensureRemoteAudio() {
  if (!voiceState.remoteAudio) {
    const audio = document.createElement('audio');
    audio.id = 'voice-remote-audio';
    audio.autoplay = true;
    audio.playsInline = true;
    document.body.append(audio);
    voiceState.remoteAudio = audio;
  }
  return voiceState.remoteAudio;
}

function resetVoiceConnection() {
  voiceState.pc?.close();
  if (voiceState.portraitFrame) cancelAnimationFrame(voiceState.portraitFrame);
  voiceState.portraitVideo?.pause();
  if (voiceState.portraitVideo) voiceState.portraitVideo.srcObject = null;
  const tracks = new Set([
    ...(voiceState.localStream?.getTracks() || []),
    ...(voiceState.sourceStream?.getTracks() || [])
  ]);
  tracks.forEach((track) => track.stop());
  voiceState.remoteAudio?.remove();
  voiceState.pc = null;
  voiceState.localStream = null;
  voiceState.sourceStream = null;
  voiceState.portraitVideo = null;
  voiceState.portraitCanvas = null;
  voiceState.portraitFrame = null;
  voiceState.cameraFacing = 'user';
  voiceState.switchingCamera = false;
  voiceState.remoteStream = null;
  voiceState.remoteAudio = null;
  voiceState.pendingCandidates = [];
}
function cleanupVoiceCall() {
  stopIncomingCallAlert();
  stopVoiceSignalPolling();
  resetVoiceConnection();
  voiceState.call = null;
  voiceState.peer = null;
  voiceState.signalCursor = 0;
  voiceState.pendingCandidates = [];
  voiceState.pollingSignals = false;
  voiceState.isBusy = false;
  voiceState.kind = 'audio';
  voiceState.statusText = '';
  renderVoiceCallPanel();
}

function currentCallKind() {
  return voiceState.call?.kind || voiceState.kind || 'audio';
}

function openingMediaLabel(kind = currentCallKind()) {
  return kind === 'video' ? 'Abrindo camera e microfone...' : 'Abrindo microfone...';
}

function voiceSupportProblem(kind = 'audio') {
  const host = window.location.hostname;
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const mediaName = kind === 'video' ? 'camera e microfone' : 'microfone';
  if (!window.isSecureContext && !localHost) {
    return `O navegador bloqueia ${mediaName} em HTTP pelo IP da rede. Use HTTPS ou teste em localhost.`;
  }
  if (!window.RTCPeerConnection) {
    return 'Este navegador nao tem WebRTC habilitado para chamadas.';
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return `O navegador nao liberou acesso a ${mediaName}. Use HTTPS e confira as permissoes.`;
  }
  return '';
}

function friendlyVoiceError(error, kind = currentCallKind()) {
  const name = String(error?.name || '');
  const message = String(error?.message || '');
  const mediaName = kind === 'video' ? 'camera e microfone' : 'microfone';
  if (name === 'NotAllowedError' || message.toLowerCase().includes('permission')) {
    return `${mediaName[0].toUpperCase()}${mediaName.slice(1)} bloqueado. Permita no navegador e tente novamente.`;
  }
  if (name === 'NotFoundError' || message.toLowerCase().includes('requested device not found')) {
    return kind === 'video' ? 'Nenhuma camera foi encontrada neste dispositivo.' : 'Nenhum microfone foi encontrado neste dispositivo.';
  }
  if (message) return message;
  return kind === 'video' ? 'Nao foi possivel iniciar a chamada de video.' : 'Nao foi possivel iniciar a chamada de voz.';
}

function voiceCallStatusLabel(status, kind = 'audio') {
  const fallback = kind === 'video' ? 'Chamada de video' : 'Chamada de voz';
  return {
    ringing: 'Chamando...',
    active: kind === 'video' ? 'Chamada de video ativa' : 'Chamada ativa',
    ended: 'Chamada encerrada',
    declined: 'Chamada recusada',
    missed: 'Chamada perdida'
  }[status] || fallback;
}

// Painel da equipe: metricas, pedidos de exclusao, denuncias e usuarios.
async function loadAdmin(tab) {
  state.adminTab = tab;
  setMain(`
    <div class="view-header"><h1>Equipe</h1></div>
    <nav class="admin-tabs">
      ${['requests', 'reports', 'users'].map((item) => `<button class="tab ${tab === item ? 'active' : ''}" data-admin-tab="${item}">${adminTabLabel(item)}</button>`).join('')}
    </nav>
    <section id="admin-view"><div class="loading">Carregando painel...</div></section>
  `);

  document.querySelectorAll('[data-admin-tab]').forEach((button) => {
    button.addEventListener('click', () => go('admin', { tab: button.dataset.adminTab }));
  });

  const overview = await api('/api/admin/overview');
  const top = `
    <div class="admin-grid">
      <div class="metric"><strong>${overview.overview.users}</strong><span class="muted">usuarios</span></div>
      <div class="metric"><strong>${overview.overview.posts}</strong><span class="muted">publicacoes</span></div>
      <div class="metric"><strong>${overview.overview.openReports}</strong><span class="muted">denuncias</span></div>
      <div class="metric"><strong>${overview.overview.pendingDeletionRequests}</strong><span class="muted">exclusoes</span></div>
    </div>
  `;

  const view = document.querySelector('#admin-view');
  if (tab === 'requests') {
    const data = await api('/api/admin/deletion-requests');
    view.innerHTML = top + (data.requests.length ? data.requests.map(deletionRequestHtml).join('') : '<div class="empty">Sem solicitacoes.</div>');
  }
  if (tab === 'reports') {
    const data = await api('/api/admin/reports');
    view.innerHTML = top + (data.reports.length ? data.reports.map(reportHtml).join('') : '<div class="empty">Sem denuncias.</div>');
  }
  if (tab === 'users') {
    const data = await api('/api/admin/users');
    view.innerHTML = top + (data.users.length ? data.users.map(adminUserHtml).join('') : '<div class="empty">Sem usuarios.</div>');
  }

  attachAdminActions(view);
}


// Liga botoes de sair criados no menu lateral, painel direito ou perfil.
function bindLogoutButtons(scope = document) {
  scope.querySelectorAll('[data-logout]').forEach((button) => {
    if (button.dataset.logoutBound === '1') return;
    button.dataset.logoutBound = '1';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      logout().catch((error) => showToast(error.message));
    });
  });
}


// Substitui apenas a coluna central, preservando navegacao e painel lateral.
function setMain(html) {
  document.querySelector('#main').innerHTML = html;
  bindLogoutButtons(document);
}


// HTML do compositor: texto, escolha de imagens, contador e botao de envio.
function composerHtml(parentId = '', label = 'Publicar') {
  return `
    <form class="composer" id="composer" data-parent-id="${parentId || ''}">
      ${avatarHtml(state.me)}
      <div>
        <textarea id="composer-body" name="body" maxlength="${state.config.maxPostLength}" placeholder="${parentId ? 'Escreva sua resposta' : 'O que esta acontecendo na escola?'}"></textarea>
        <div class="composer-media-preview" id="composer-media-preview"></div>
        <div class="composer-actions">
          <div class="composer-tools">
            <input class="visually-hidden" id="composer-images" type="file" accept="${IMAGE_ACCEPT}" multiple>
            <button class="icon-btn media-picker-btn" id="composer-image-btn" type="button" title="Adicionar imagens" aria-label="Adicionar imagens">Imagem</button>
          </div>
          <div class="composer-submit">
            <span class="char-count" id="char-count">0/${state.config.maxPostLength}</span>
            <button class="primary-btn" type="submit">${label}</button>
          </div>
        </div>
      </div>
    </form>
  `;
}


// Liga eventos do compositor: contador, preview, validacao de imagens e publicacao.
function attachComposer(parentId, afterSubmit) {
  const form = document.querySelector('#composer');
  const textarea = document.querySelector('#composer-body');
  const counter = document.querySelector('#char-count');
  const imageInput = document.querySelector('#composer-images');
  const imageButton = document.querySelector('#composer-image-btn');
  const preview = document.querySelector('#composer-media-preview');
  if (!form || !textarea) return;

  let imageFiles = [];
  let previewUrls = [];

  const renderPreview = () => {
    if (!preview) return;
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls = imageFiles.map((file) => URL.createObjectURL(file));
    preview.innerHTML = imageFiles.map((file, index) => `
      <div class="composer-media-thumb">
        <img src="${escapeAttr(previewUrls[index])}" alt="${escapeAttr(file.name || 'Imagem selecionada')}">
        <button class="media-remove" type="button" data-remove-image="${index}" aria-label="Remover imagem">x</button>
      </div>
    `).join('');

    preview.querySelectorAll('[data-remove-image]').forEach((button) => {
      button.addEventListener('click', () => {
        imageFiles = imageFiles.filter((_, index) => index !== Number(button.dataset.removeImage));
        renderPreview();
      });
    });
  };

  const addImages = (files) => {
    const selected = Array.from(files || []);
    if (!selected.length) return;
    if (imageFiles.length + selected.length > MAX_POST_IMAGES) {
      throw new Error(`Escolha no maximo ${MAX_POST_IMAGES} imagens.`);
    }
    selected.forEach(validateImageFile);
    imageFiles = imageFiles.concat(selected);
    renderPreview();
  };

  textarea.addEventListener('input', () => {
    counter.textContent = `${textarea.value.length}/${state.config.maxPostLength}`;
  });

  imageButton?.addEventListener('click', () => imageInput?.click());

  imageInput?.addEventListener('change', () => {
    try {
      addImages(imageInput.files);
    } catch (error) {
      showToast(error.message);
    } finally {
      imageInput.value = '';
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    try {
      const body = textarea.value;
      const imageDataUrls = await Promise.all(imageFiles.map(fileToDataUrl));
      await api('/api/posts', { method: 'POST', body: { body, parentId: parentId ? Number(parentId) : null, imageDataUrls } });
      textarea.value = '';
      imageFiles = [];
      renderPreview();
      counter.textContent = `0/${state.config.maxPostLength}`;
      showToast(parentId ? 'Resposta publicada.' : 'Publicado.');
      await afterSubmit();
    } catch (error) {
      showToast(error.message);
    } finally {
      submitButton.disabled = false;
    }
  });
}


// Card principal da timeline, incluindo repost, texto, imagens, moderacao e acoes.
function postHtml(post) {
  const targetId = post.repostOfId || post.id;
  const canDeleteRequest = (post.author.id === state.me.id || isStaff()) && !post.moderation?.pendingDeletion;
  const canAdminDeletePending = state.me.role === 'admin' && post.moderation?.pendingDeletion;
  const moderationNotice = post.moderation?.pendingDeletion ? '<div class="moderation-line">Exclusao pendente: visivel somente para admin.</div>' : '';
  const body = post.original
    ? quoteHtml(post.original)
    : `${post.body ? `<p class="post-body" data-open-post="${post.id}">${escapeHtml(post.body)}</p>` : ''}${postMediaHtml(post.media, post.id)}`;

  return `
    <article class="post-card" data-post-card="${post.id}">
      ${avatarHtml(post.author)}
      <div>
        ${post.original ? `<div class="repost-line">${escapeHtml(post.author.displayName)} repostou</div>` : ''}
        <div class="post-top">
          <button class="name ghost-link${onlineClass(post.author)}" data-profile="${escapeAttr(post.author.username)}"${onlineUserAttr(post.author)}>${escapeHtml(post.author.displayName)}</button>
          <span class="username">@${escapeHtml(post.author.username)}</span>
          <span class="role ${escapeAttr(post.author.role)}">${escapeHtml(roleLabel(post.author.role))}</span>
          <span class="time">${formatTime(post.createdAt)}</span>
        </div>
        ${body}
        ${moderationNotice}
        <div class="post-actions">
          <button class="icon-btn" data-action="reply" data-id="${targetId}">Resp ${post.metrics.replies}</button>
          <button class="icon-btn ${post.viewer.liked ? 'active-like' : ''}" data-action="like" data-id="${targetId}" data-active="${post.viewer.liked ? '1' : '0'}">Curtir ${post.metrics.likes}</button>
          <button class="icon-btn ${post.viewer.reposted ? 'active-repost' : ''}" data-action="repost" data-id="${targetId}" data-active="${post.viewer.reposted ? '1' : '0'}">Repost ${post.metrics.reposts}</button>
          ${canDeleteRequest ? `<button class="icon-btn" data-action="delete-request" data-id="${post.id}">Excluir</button>` : '<span></span>'}
          <button class="icon-btn" data-action="report" data-id="${post.id}">Denunciar</button>
          ${canAdminDeletePending ? `<button class="icon-btn admin-delete-post" data-action="admin-delete-pending" data-id="${targetId}" title="Excluir publicacao solicitada" aria-label="Excluir publicacao solicitada">${trashIconHtml()}</button>` : ''}
        </div>
      </div>
    </article>
  `;
}


// Versao compacta de um post quando ele aparece dentro de um repost.
function quoteHtml(post) {
  return `
    <div class="quote-card" data-open-post="${post.id}">
      <div class="post-top">
        <strong class="online-name${onlineClass(post.author)}"${onlineUserAttr(post.author)}>${escapeHtml(post.author.displayName)}</strong>
        <span class="username">@${escapeHtml(post.author.username)}</span>
        <span class="time">${formatTime(post.createdAt)}</span>
      </div>
      ${post.body ? `<p class="post-body">${escapeHtml(post.body)}</p>` : ''}
      ${postMediaHtml(post.media, post.id)}
    </div>
  `;
}


// Grade responsiva das imagens anexadas a uma publicacao.
function postMediaHtml(media = [], postId = '') {
  if (!Array.isArray(media) || !media.length) return '';
  const images = media.slice(0, MAX_POST_IMAGES);
  return `
    <div class="post-media-grid count-${images.length}" data-open-post="${postId}">
      ${images.map((item, index) => {
        const src = mediaUrl(item.url);
        const alt = item.altText || 'Imagem da publicacao';
        return `
          <div class="post-media-item">
            <button class="post-media-button" type="button" data-open-image data-image-index="${index}" data-image-src="${escapeAttr(src)}" data-image-alt="${escapeAttr(alt)}" aria-label="Abrir imagem da publicacao">
              <img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" loading="lazy">
            </button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Liga botoes de responder, curtir, repostar, pedir exclusao e denunciar.
function attachPostActions(scope) {
  scope.querySelectorAll('[data-profile]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      go('profile', { username: button.dataset.profile });
    });
  });

  scope.querySelectorAll('[data-open-image]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openImageModal(button);
    });
  });
  scope.querySelectorAll('[data-open-post]').forEach((element) => {
    element.addEventListener('click', () => go('thread', { id: element.dataset.openPost }));
  });

  scope.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.id;
      const action = button.dataset.action;
      try {
        if (action === 'reply') await go('thread', { id });
        if (action === 'like') {
          await api(`/api/posts/${id}/like`, { method: button.dataset.active === '1' ? 'DELETE' : 'POST', body: {} });
          await reloadCurrent();
        }
        if (action === 'repost') {
          await api(`/api/posts/${id}/repost`, { method: button.dataset.active === '1' ? 'DELETE' : 'POST', body: {} });
          await reloadCurrent();
        }
        if (action === 'delete-request') {
          const reason = prompt('Motivo da exclusao');
          if (reason !== null) {
            await api(`/api/posts/${id}/deletion-request`, { method: 'POST', body: { reason } });
            showToast('Solicitacao enviada ao admin.');
          }
        }
        if (action === 'admin-delete-pending') {
          if (confirm('Excluir agora esta publicacao solicitada?')) {
            await api(`/api/admin/posts/${id}/delete-request`, { method: 'POST', body: { adminNote: 'Excluido durante visualizacao pelo admin.' } });
            showToast('Publicacao excluida.');
            await reloadCurrent();
          }
        }
        if (action === 'report') {
          const details = prompt('Descreva o problema');
          if (details !== null) {
            await api(`/api/posts/${id}/report`, { method: 'POST', body: { reason: 'Denuncia', details } });
            showToast('Denuncia enviada para revisao.');
          }
        }
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}



// Abre imagens da timeline em um modal escuro, com navegacao parecida com redes sociais.
function openImageModal(trigger) {
  const buttons = Array.from(trigger.closest('.post-media-grid')?.querySelectorAll('[data-open-image]') || [trigger]);
  const images = buttons
    .map((button) => ({ src: button.dataset.imageSrc || '', alt: button.dataset.imageAlt || 'Imagem da publicacao' }))
    .filter((image) => image.src);
  if (!images.length) return;

  imageModalState.images = images;
  imageModalState.index = Math.max(0, buttons.indexOf(trigger));
  document.body.classList.add('modal-open');
  renderImageModal();
}

function renderImageModal() {
  const images = imageModalState.images;
  const total = images.length;
  if (!total) return;

  imageModalState.index = Math.max(0, Math.min(imageModalState.index, total - 1));
  const image = images[imageModalState.index];
  let modal = document.querySelector('#image-lightbox');
  if (!modal) {
    document.body.insertAdjacentHTML('beforeend', '<section class="image-lightbox" id="image-lightbox" role="dialog" aria-modal="true" aria-label="Imagem da publicacao"></section>');
    modal = document.querySelector('#image-lightbox');
  }

  modal.innerHTML = `
    <button class="image-lightbox-close" type="button" data-image-modal-close aria-label="Fechar imagem">x</button>
    <div class="image-lightbox-stage" data-image-modal-stage>
      ${total > 1 ? '<button class="image-lightbox-nav prev" type="button" data-image-modal-prev aria-label="Imagem anterior">&lt;</button>' : ''}
      <img class="image-lightbox-image" src="${escapeAttr(image.src)}" alt="${escapeAttr(image.alt)}" draggable="false">
      ${total > 1 ? '<button class="image-lightbox-nav next" type="button" data-image-modal-next aria-label="Proxima imagem">&gt;</button>' : ''}
    </div>
    ${total > 1 ? `<div class="image-lightbox-footer">${imageModalState.index + 1}/${total}</div>` : ''}
  `;

  modal.querySelector('[data-image-modal-close]')?.addEventListener('click', closeImageModal);
  modal.querySelector('[data-image-modal-prev]')?.addEventListener('click', () => moveImageModal(-1));
  modal.querySelector('[data-image-modal-next]')?.addEventListener('click', () => moveImageModal(1));
  modal.querySelector('[data-image-modal-stage]')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeImageModal();
  });
  modal.onclick = (event) => {
    if (event.target === modal) closeImageModal();
  };

  if (!imageModalState.keyHandler) {
    imageModalState.keyHandler = (event) => {
      if (event.key === 'Escape') closeImageModal();
      if (event.key === 'ArrowLeft') moveImageModal(-1);
      if (event.key === 'ArrowRight') moveImageModal(1);
    };
    document.addEventListener('keydown', imageModalState.keyHandler);
  }
  modal.querySelector('[data-image-modal-close]')?.focus();
}

function moveImageModal(direction) {
  const total = imageModalState.images.length;
  if (total < 2) return;
  imageModalState.index = (imageModalState.index + direction + total) % total;
  renderImageModal();
}

function closeImageModal() {
  document.querySelector('#image-lightbox')?.remove();
  document.body.classList.remove('modal-open');
  if (imageModalState.keyHandler) document.removeEventListener('keydown', imageModalState.keyHandler);
  imageModalState.images = [];
  imageModalState.index = 0;
  imageModalState.keyHandler = null;
}

// Card de usuario usado em busca e listas.
function userCardHtml(user) {
  const mine = user.id === state.me.id;
  return `
    <article class="user-card">
      ${avatarHtml(user)}
      <div>
        <button class="name ghost-link${onlineClass(user)}" data-profile="${escapeAttr(user.username)}"${onlineUserAttr(user)}>${escapeHtml(user.displayName)}</button>
        <div class="username">@${escapeHtml(user.username)} <span class="role ${escapeAttr(user.role)}">${escapeHtml(roleLabel(user.role))}</span></div>
        <div class="muted">${escapeHtml(user.bio || '')}</div>
      </div>
      <div class="inline-actions">
        ${mine ? '' : `<button class="ghost-btn" data-dm-user="${user.id}">Mensagem</button>`}
        ${mine ? '' : `<button class="primary-btn" data-follow-user="${user.id}" data-followed="${user.followedByMe ? '1' : '0'}">${user.followedByMe ? 'Seguindo' : 'Seguir'}</button>`}
      </div>
    </article>
  `;
}


// Liga botoes de seguir e mensagem nos cards de usuario.
function attachUserActions(scope) {
  scope.querySelectorAll('[data-profile]').forEach((button) => {
    button.addEventListener('click', () => go('profile', { username: button.dataset.profile }));
  });
  scope.querySelectorAll('[data-follow-user]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await api(`/api/users/${button.dataset.followUser}/follow`, { method: button.dataset.followed === '1' ? 'DELETE' : 'POST', body: {} });
        await reloadCurrent();
      } catch (error) {
        showToast(error.message);
      }
    });
  });
  scope.querySelectorAll('[data-dm-user]').forEach((button) => {
    button.addEventListener('click', () => go('messages', { userId: button.dataset.dmUser }));
  });
}


// Botao de conversa na lista lateral de mensagens privadas.
function conversationButtonHtml(user, lastMessage = '', active = false, unread = 0) {
  return `
    <button class="conversation ${active ? 'active' : ''}" data-conversation="${user.id}">
      <div class="user-row">
        ${avatarHtml(user)}
        <div>
          <strong class="online-name${onlineClass(user)}"${onlineUserAttr(user)}>${escapeHtml(user.displayName)}</strong>
          <div class="username">@${escapeHtml(user.username)}${unread ? ` · ${unread} nova(s)` : ''}</div>
        </div>
      </div>
      ${lastMessage ? `<div class="muted">${escapeHtml(lastMessage)}</div>` : ''}
    </button>
  `;
}


// Navega para a conversa escolhida pelo usuario.
function attachConversationButtons() {
  document.querySelectorAll('[data-conversation]').forEach((button) => {
    button.addEventListener('click', () => go('messages', { userId: button.dataset.conversation }));
  });
}


// Linha do pedido de exclusao vista pelo administrador.
function deletionRequestHtml(request) {
  const pending = request.status === 'pending';
  return `
    <article class="admin-card">
      <div class="message-top">
        <strong>${escapeHtml(request.requester.displayName)}</strong>
        <span class="muted">pediu exclusao</span>
        <span class="role">${escapeHtml(request.status)}</span>
      </div>
      <p class="post-body">${escapeHtml(request.reason)}</p>
      <div class="quote-card">
        <strong>${escapeHtml(request.post.author.displayName)}</strong>
        <p class="post-body">${escapeHtml(request.post.body)}</p>
      </div>
      ${state.me.role === 'admin' && pending ? `
        <div class="admin-actions">
          <button class="primary-btn" data-admin-action="approve-delete" data-id="${request.id}">Aprovar</button>
          <button class="danger-btn" data-admin-action="reject-delete" data-id="${request.id}">Rejeitar</button>
        </div>
      ` : ''}
    </article>
  `;
}


// Linha de denuncia vista por professor/admin.
function reportHtml(report) {
  return `
    <article class="admin-card">
      <div class="message-top">
        <strong>${escapeHtml(report.reporter.displayName)}</strong>
        <span class="muted">${escapeHtml(report.reason)}</span>
        <span class="role">${escapeHtml(report.status)}</span>
      </div>
      <p class="post-body">${escapeHtml(report.details || '')}</p>
      <div class="quote-card">
        <strong>${escapeHtml(report.post.author.displayName)}</strong>
        <p class="post-body">${escapeHtml(report.post.body)}</p>
      </div>
      <div class="admin-actions">
        <button class="ghost-btn" data-admin-action="review-report" data-status="reviewed" data-id="${report.id}">Revisada</button>
        <button class="ghost-btn" data-admin-action="review-report" data-status="dismissed" data-id="${report.id}">Descartar</button>
      </div>
    </article>
  `;
}


// Linha de usuario no painel da equipe, com papel e suspensao.
function adminUserHtml(user) {
  const canEdit = state.me.role === 'admin' && user.id !== state.me.id;
  return `
    <article class="admin-card">
      <div class="user-row">
        ${avatarHtml(user)}
        <div>
          <strong class="online-name${onlineClass(user)}"${onlineUserAttr(user)}>${escapeHtml(user.displayName)}</strong>
          <div class="username">@${escapeHtml(user.username)} · ${escapeHtml(user.email)}</div>
          <div class="muted">${user.postCount} publicacoes · ${user.followerCount} seguidores</div>
        </div>
      </div>
      <div class="admin-actions">
        ${canEdit ? `
          <select data-role-user="${user.id}">
            ${['student', 'teacher', 'admin'].map((role) => `<option value="${role}" ${role === user.role ? 'selected' : ''}>${roleLabel(role)}</option>`).join('')}
          </select>
          <button class="ghost-btn" data-admin-action="suspend-user" data-id="${user.id}" data-suspended="${user.suspendedAt ? '1' : '0'}">${user.suspendedAt ? 'Reativar' : 'Suspender'}</button>
        ` : `<span class="role ${escapeAttr(user.role)}">${escapeHtml(roleLabel(user.role))}</span>`}
      </div>
    </article>
  `;
}


// Liga acoes administrativas: aprovar/rejeitar exclusao, revisar denuncia e alterar usuarios.
function attachAdminActions(scope) {
  scope.querySelectorAll('[data-admin-action]').forEach((button) => {
    button.addEventListener('click', async () => {
      const id = button.dataset.id;
      const action = button.dataset.adminAction;
      try {
        if (action === 'approve-delete' || action === 'reject-delete') {
          const adminNote = prompt('Nota do admin') || '';
          await api(`/api/admin/deletion-requests/${id}`, {
            method: 'PATCH',
            body: { status: action === 'approve-delete' ? 'approved' : 'rejected', adminNote }
          });
        }
        if (action === 'review-report') {
          await api(`/api/admin/reports/${id}`, { method: 'PATCH', body: { status: button.dataset.status } });
        }
        if (action === 'suspend-user') {
          await api(`/api/admin/users/${id}`, { method: 'PATCH', body: { suspended: button.dataset.suspended !== '1' } });
        }
        await loadAdmin(state.adminTab);
      } catch (error) {
        showToast(error.message);
      }
    });
  });

  scope.querySelectorAll('[data-role-user]').forEach((select) => {
    select.addEventListener('change', async () => {
      try {
        await api(`/api/admin/users/${select.dataset.roleUser}`, { method: 'PATCH', body: { role: select.value } });
        showToast('Papel atualizado.');
      } catch (error) {
        showToast(error.message);
      }
    });
  });
}


// Atalho para trocar foto ou capa diretamente pelo perfil.
async function chooseProfileImage(kind) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = IMAGE_ACCEPT;

  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;

    try {
      const dataUrl = await fileToDataUrl(file);
      const payload = kind === 'banner' ? { bannerDataUrl: dataUrl } : { avatarDataUrl: dataUrl };
      const result = await api('/api/me', { method: 'PATCH', body: payload });
      state.me = result.user;
      showToast(kind === 'banner' ? 'Capa atualizada.' : 'Foto atualizada.');
      await go('profile', { username: state.me.username });
    } catch (error) {
      showToast(error.message);
    }
  }, { once: true });

  input.click();
}


// Modal completo de edicao de perfil, incluindo remocao e troca de imagens.
async function editProfile() {
  document.querySelector('#profile-editor-modal')?.remove();
  document.body.insertAdjacentHTML('beforeend', `
    <div class="modal-backdrop" id="profile-editor-modal" role="dialog" aria-modal="true" aria-label="Editar perfil">
      <form class="profile-editor" id="profile-editor-form">
        <div class="modal-head">
          <button class="ghost-btn" type="button" data-close-profile-editor>Cancelar</button>
          <h2>Editar perfil</h2>
          <button class="primary-btn" type="submit">Salvar</button>
        </div>
        <div class="field">
          <label for="edit-display-name">Nome</label>
          <input id="edit-display-name" name="displayName" value="${escapeAttr(state.me.displayName)}" maxlength="60" required>
        </div>
        <div class="field">
          <label for="edit-bio">Bio</label>
          <textarea id="edit-bio" name="bio" maxlength="240" rows="4">${escapeHtml(state.me.bio || '')}</textarea>
        </div>
        <div class="editor-grid">
          <div class="image-field">
            <span class="field-label">Foto do perfil</span>
            <div class="image-preview avatar-preview" id="avatar-preview">
              ${state.me.avatarUrl ? `<img src="${escapeAttr(mediaUrl(state.me.avatarUrl))}" alt="">` : `<span>${escapeHtml(initialsFor(state.me))}</span>`}
            </div>
            <input id="avatar-file" name="avatarFile" type="file" accept="${IMAGE_ACCEPT}">
            <label class="checkbox-row"><input type="checkbox" name="removeAvatar"> Remover foto</label>
          </div>
          <div class="image-field">
            <span class="field-label">Capa do perfil</span>
            <div class="image-preview banner-preview" id="banner-preview"${state.me.bannerUrl ? ` style="background-image:url('${escapeAttr(mediaUrl(state.me.bannerUrl))}')"` : ''}>
              ${state.me.bannerUrl ? '' : '<span>Capa</span>'}
            </div>
            <input id="banner-file" name="bannerFile" type="file" accept="${IMAGE_ACCEPT}">
            <label class="checkbox-row"><input type="checkbox" name="removeBanner"> Remover capa</label>
          </div>
        </div>
      </form>
    </div>
  `);

  const modal = document.querySelector('#profile-editor-modal');
  const form = document.querySelector('#profile-editor-form');
  const avatarInput = document.querySelector('#avatar-file');
  const bannerInput = document.querySelector('#banner-file');
  const avatarPreview = document.querySelector('#avatar-preview');
  const bannerPreview = document.querySelector('#banner-preview');

  modal.addEventListener('click', (event) => {
    if (event.target === modal) modal.remove();
  });
  document.querySelector('[data-close-profile-editor]').addEventListener('click', () => modal.remove());

  avatarInput.addEventListener('change', async () => {
    await updateImagePreview(avatarInput.files[0], avatarPreview, 'avatar');
  });
  bannerInput.addEventListener('change', async () => {
    await updateImagePreview(bannerInput.files[0], bannerPreview, 'banner');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(form);
    const avatarFile = avatarInput.files[0] || null;
    const bannerFile = bannerInput.files[0] || null;

    try {
      const payload = {
        displayName: formData.get('displayName'),
        bio: formData.get('bio'),
        removeAvatar: formData.get('removeAvatar') === 'on',
        removeBanner: formData.get('removeBanner') === 'on'
      };
      if (avatarFile) payload.avatarDataUrl = await fileToDataUrl(avatarFile);
      if (bannerFile) payload.bannerDataUrl = await fileToDataUrl(bannerFile);

      const result = await api('/api/me', { method: 'PATCH', body: payload });
      state.me = result.user;
      modal.remove();
      showToast('Perfil atualizado.');
      await go('profile', { username: state.me.username });
    } catch (error) {
      showToast(error.message);
    }
  });
}


// Mostra uma pre-visualizacao local antes de enviar foto ou capa ao servidor.
async function updateImagePreview(file, preview, kind) {
  if (!file) return;
  const dataUrl = await fileToDataUrl(file);
  if (kind === 'avatar') {
    preview.innerHTML = `<img src="${escapeAttr(dataUrl)}" alt="">`;
  } else {
    preview.style.backgroundImage = `url('${dataUrl}')`;
    preview.innerHTML = '';
  }
}


// Converte arquivo local em Data URL para enviar dentro do JSON da API.
function fileToDataUrl(file) {
  validateImageFile(file);

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(reader.result));
    reader.addEventListener('error', () => reject(new Error('Nao foi possivel ler a imagem.')));
    reader.readAsDataURL(file);
  });
}


// Regras do navegador para imagens: formato permitido e ate 4 MB.
function validateImageFile(file) {
  const allowed = IMAGE_ACCEPT.split(',');
  if (!file || !allowed.includes(file.type)) throw new Error('Use PNG, JPG, WebP ou GIF.');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('A imagem deve ter ate 4 MB.');
  return file;
}


// Recarrega a tela atual depois de uma acao que muda dados no servidor.
async function reloadCurrent() {
  await go(state.view, state.params);
}


// Encerra sessao no servidor e volta para a tela de login.
async function logout() {
  await endVoiceCall(true);
  stopVoicePolling();
  stopIncomingCallAlert();
  stopUnreadPolling();
  stopPresencePolling();
  await api('/api/auth/logout', { method: 'POST', body: {} });
  state.me = null;
  state.unreadCounts = { notifications: 0, messages: 0 };
  state.onlineUserIds = new Set();
  renderAuth('login');
}


// Titulo mostrado no cabecalho de cada tela.
function viewTitle() {
  return {
    home: 'Inicio',
    search: 'Busca',
    notifications: 'Notificacoes',
    messages: 'Mensagens',
    profile: 'Perfil',
    thread: 'Conversa',
    admin: 'Equipe'
  }[state.view] || 'SIX';
}


// Nome amigavel das abas administrativas.
function adminTabLabel(tab) {
  return {
    requests: 'Exclusoes',
    reports: 'Denuncias',
    users: 'Usuarios'
  }[tab] || tab;
}


// Traduz os papeis internos para texto em portugues.
function roleLabel(role) {
  return {
    student: 'Aluno',
    teacher: 'Professor',
    admin: 'Admin'
  }[role] || role;
}


// A interface usa este helper para mostrar ou esconder itens da equipe.
function isStaff() {
  return state.me && ['teacher', 'admin'].includes(state.me.role);
}


// Gera iniciais quando o usuario ainda nao possui foto.
function initialsFor(user) {
  return String(user.displayName || user.username || 'S')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || 'S';
}


// Renderiza avatar com imagem enviada ou iniciais geradas.
function avatarHtml(user, extraClass = '') {
  const initials = initialsFor(user);
  const cls = `avatar ${extraClass}${onlineClass(user)}`.trim();
  const attrs = onlineUserAttr(user);
  if (user.avatarUrl) return `<span class="${cls}"${attrs}><img src="${escapeAttr(mediaUrl(user.avatarUrl))}" alt=""></span>`;
  return `<span class="${cls}"${attrs}>${escapeHtml(initials || 'S')}</span>`;
}


// Verifica se um usuario deve receber o destaque online na interface.
function isUserOnline(user) {
  const id = Number(user?.id);
  if (id && state.onlineUserIds.has(id)) return true;
  return Boolean(user?.online);
}


// Classe aplicada em nomes e avatares quando o usuario esta online.
function onlineClass(user) {
  return isUserOnline(user) ? ' is-online' : '';
}


// Atributo usado pelo polling de presenca para atualizar elementos existentes.
function onlineUserAttr(user) {
  const id = Number(user?.id);
  return id ? ` data-online-user="${escapeAttr(id)}"` : '';
}


// Transforma datas ISO em tempo relativo, como 'ha 2 minutos'.
function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  const delta = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(delta);
  const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (abs < 60) return formatter.format(delta, 'second');
  if (abs < 3600) return formatter.format(Math.round(delta / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(delta / 3600), 'hour');
  if (abs < 604800) return formatter.format(Math.round(delta / 86400), 'day');
  return date.toLocaleDateString('pt-BR');
}


// Mostra avisos temporarios no canto da tela.
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}


// Escapa texto do usuario antes de colocar no HTML, prevenindo injecao de codigo.
function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}


// Escapa valores usados dentro de atributos HTML.
function escapeAttr(value) {
  return escapeHtml(value).replaceAll('`', '&#96;');
}
