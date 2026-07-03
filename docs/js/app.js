(function () {
  const API = window.BolaoAPI;
  const CONFIG = window.BOLAO_CONFIG || {};
  const USER_KEY = 'bolao_oaz_brasil_noruega_user_v12';
  const LEGACY_USER_KEYS = ['bolao_oaz_brasil_noruega_v6', 'bolao_oaz_brasil_noruega_user_v9', 'bolao_oaz_brasil_noruega_user_v10'];
  const USER_COOKIE_KEY = 'bolao_oaz_brasil_noruega_participant';
  const USER_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
  // Cópia local da última resposta válida: reabre a tela na hora, mesmo
  // enquanto o Apps Script faz uma atualização em segundo plano.
  const STATE_CACHE_KEY = 'bolao_oaz_brasil_noruega_state_v12';
  const LEGACY_STATE_CACHE_KEYS = ['bolao_oaz_brasil_noruega_state_v9', 'bolao_oaz_brasil_noruega_state_v10'];
  const PREDICTION_DRAFT_KEY_PREFIX = 'bolao_oaz_brasil_noruega_prediction_draft_v12:';
  const PENDING_PREDICTION_KEY_PREFIX = 'bolao_oaz_brasil_noruega_pending_prediction_v12:';
  const STATE_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 12;
  const PREDICTION_DRAFT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const escape = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;'
  }[char]));

  let state = null;
  let schedule = [];
  let lastFinalGameId = '';
  let countdownTimer = null;
  let pollTimer = null;
  let refreshing = false;
  let saving = false;
  let previewOnly = false;
  let connectionIssue = false;
  let currentPage = 'palpite';
  let slowSaveTimer = null;
  let pendingReconciliationTimer = null;
  // Evita que um palpite salvo no navegador seja reenviado antes da
  // confirmação da base ao reabrir o site.
  let profileSyncPending = false;
  // Sinaliza que a base removeu/alterou o cadastro que estava salvo localmente.
  let sessionClearedByBase = false;

  // Esta referência local impede que o projeto exiba um adversário vindo de
  // uma implantação antiga do Apps Script. Mesmo sem backend configurado, a
  // primeira abertura mostra corretamente Brasil × Noruega.
  const LOCAL_PREVIEW_GAME = {
    gameId: 'brasil-noruega-2026-07-05',
    competition: 'Copa do Mundo 2026 · Oitavas de final',
    home: 'Brasil',
    away: 'Noruega',
    startAt: '2026-07-05T17:00:00-03:00',
    closeAt: '2026-07-03T23:50:00-03:00',
    status: 'pre',
    homeFlag: 'br',
    awayFlag: 'no',
    venue: 'New York New Jersey Stadium · East Rutherford, EUA',
    locked: false
  };

  function normalizeAliases(values) {
    const all = Array.isArray(values) ? values : [values];
    return [...new Set(all.map((value) => API.cleanEmail(value)).filter(Boolean))];
  }

  // O cadastro é mantido no navegador para que a pessoa volte diretamente
  // aos próprios palpites. Além do localStorage, guardamos somente o ParticipantId
  // em um cookie de 1 ano: ele recupera a sessão mesmo quando o navegador limpa o
  // armazenamento local em fechamentos ou atualizações.
  function emptyUser() {
    return { id: '', email: '', name: '', aliases: [] };
  }

  function parseStoredUser(value) {
    try {
      const user = JSON.parse(value || '{}') || {};
      return {
        id: String(user.id || '').trim(),
        email: API.cleanEmail(user.email || ''),
        name: String(user.name || '').trim(),
        aliases: normalizeAliases(user.aliases || [user.email || ''])
      };
    } catch (_) {
      return emptyUser();
    }
  }

  function readParticipantCookie() {
    try {
      const prefix = `${USER_COOKIE_KEY}=`;
      const item = document.cookie.split('; ').find((part) => part.indexOf(prefix) === 0);
      return item ? decodeURIComponent(item.slice(prefix.length)).trim() : '';
    } catch (_) {
      return '';
    }
  }

  function writeParticipantCookie(participantId) {
    const id = String(participantId || '').trim();
    if (!id) return;
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${USER_COOKIE_KEY}=${encodeURIComponent(id)}; Max-Age=${USER_COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  }

  function clearParticipantCookie() {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `${USER_COOKIE_KEY}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
  }

  function hasStoredIdentity(user) {
    return Boolean(user?.id || user?.email || user?.name);
  }

  function readStoredUser() {
    let local = emptyUser();
    let sourceKey = USER_KEY;

    try {
      const keys = [USER_KEY].concat(LEGACY_USER_KEYS);
      for (const key of keys) {
        const candidate = parseStoredUser(localStorage.getItem(key));
        if (!hasStoredIdentity(candidate)) continue;
        local = candidate;
        sourceKey = key;
        break;
      }

      // Migra versões anteriores sem apagar a identidade já reconhecida.
      if (sourceKey !== USER_KEY && hasStoredIdentity(local)) {
        localStorage.setItem(USER_KEY, JSON.stringify(local));
      }
    } catch (_) {
      // O cookie abaixo ainda permite recuperar o cadastro quando localStorage não está disponível.
    }

    const cookieId = readParticipantCookie();
    return {
      id: local.id || cookieId,
      email: local.email,
      name: local.name,
      aliases: local.aliases
    };
  }

  function persistUser(user) {
    const normalized = {
      id: String(user.id || '').trim(),
      email: API.cleanEmail(user.email || ''),
      name: String(user.name || '').trim(),
      aliases: normalizeAliases(user.aliases || [user.email || ''])
    };

    try {
      localStorage.setItem(USER_KEY, JSON.stringify(normalized));
    } catch (_) {
      // A identificação continua no cookie quando o armazenamento local está bloqueado.
    }

    writeParticipantCookie(normalized.id);
    return normalized;
  }

  function getUser() {
    const user = readStoredUser();
    // Migra instalações antigas, que tinham apenas localStorage, para o cookie de recuperação.
    if (user.id) writeParticipantCookie(user.id);
    return user;
  }

  function setUser(user = {}) {
    const previous = readStoredUser();
    const email = API.cleanEmail(user.email || previous.email);
    const aliases = normalizeAliases([
      ...(previous.aliases || []),
      ...(user.aliases || []),
      previous.email,
      email
    ]);

    return persistUser({
      id: user.id || previous.id || '',
      email,
      name: user.name || previous.name || '',
      aliases
    });
  }

  function clearStateCache() {
    try {
      localStorage.removeItem(STATE_CACHE_KEY);
      LEGACY_STATE_CACHE_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (_) {}
  }

  function persistStateCache() {
    if (!state || !state.game || !isBrazilNorwayGame(state.game)) return;

    const user = getUser();
    const participantId = String(state?.myProfile?.id || user.id || '').trim();
    const snapshot = {
      version: 12,
      storedAt: Date.now(),
      participantId,
      games: schedule,
      lastFinalGameId,
      state
    };

    try {
      localStorage.setItem(STATE_CACHE_KEY, JSON.stringify(snapshot));
    } catch (_) {
      // A sessão por cookie continua funcionando quando o armazenamento estiver bloqueado.
    }
  }

  function readStateCache(user = getUser()) {
    try {
      const raw = localStorage.getItem(STATE_CACHE_KEY);
      const cached = JSON.parse(raw || '{}') || {};
      const age = Date.now() - Number(cached.storedAt || 0);
      if (!cached.state || age < 0 || age > STATE_CACHE_MAX_AGE_MS) return null;
      if (!isBrazilNorwayGame(cached.state.game)) return null;

      const cachedId = String(cached.participantId || cached.state?.myProfile?.id || '').trim();
      const currentId = String(user.id || '').trim();
      if (cachedId && currentId && cachedId !== currentId) return null;

      const restored = {
        games: Array.isArray(cached.games) && cached.games.length ? cached.games : [cached.state.game],
        lastFinalGameId: String(cached.lastFinalGameId || ''),
        state: cached.state
      };

      // Nunca expõe o cadastro anterior caso os dados locais tenham sido apagados.
      if (!currentId && cachedId) {
        restored.state.myProfile = null;
        restored.state.myPrediction = null;
        if (Array.isArray(restored.state?.participation?.participants)) {
          restored.state.participation.participants = restored.state.participation.participants.map((person) => ({
            ...person,
            mine: false
          }));
        }
      }

      return restored;
    } catch (_) {
      return null;
    }
  }

  function restoreCachedState(user = getUser()) {
    const cached = readStateCache(user);
    if (!cached) return false;

    schedule = cached.games || [];
    lastFinalGameId = cached.lastFinalGameId || '';
    state = cached.state;

    // A última sessão já é suficiente para abrir a tela imediatamente. A base
    // continua sendo sincronizada em segundo plano e, caso a administração tenha
    // removido o cadastro, a próxima leitura limpa esta sessão automaticamente.
    if (hasStoredIdentity(user)) {
      state.myProfile = {
        id: user.id || state?.myProfile?.id || '',
        email: user.email || state?.myProfile?.email || '',
        name: user.name || state?.myProfile?.name || '',
        createdAt: state?.myProfile?.createdAt || ''
      };
      if (Array.isArray(state?.participation?.participants)) {
        state.participation.participants = state.participation.participants.map((person) => ({
          ...person,
          mine: Boolean(user.id && String(person.participantId || '') === String(user.id))
        }));
      }
    }
    profileSyncPending = false;
    return true;
  }

  function prepareFastShell(user = getUser()) {
    const preview = localPreviewState();
    schedule = preview.games;
    lastFinalGameId = '';
    state = preview.state;
    profileSyncPending = false;

    // A pessoa volta direto ao próprio palpite. A conferência da base roda
    // silenciosamente e só muda a tela se a administração tiver removido algo.
    if (user.id && (user.name || user.email)) {
      state.myProfile = {
        id: user.id,
        email: user.email,
        name: user.name,
        createdAt: new Date().toISOString()
      };
    }
    profileSyncPending = false;
  }

  function clearUser() {
    try {
      localStorage.removeItem(USER_KEY);
      LEGACY_USER_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch (_) {}
    clearStateCache();
    clearParticipantCookie();
  }

  function clearLocalSessionBecauseBaseIsMissing(user = getUser(), gameId = state?.game?.gameId || '') {
    // A planilha é a fonte oficial. Quando a API responde que não existe mais
    // cadastro, removemos cache, cookie, rascunho e envio pendente para que um
    // teste apagado manualmente nunca reapareça por causa do navegador.
    clearPendingPrediction(user, gameId);
    clearPredictionDraft(user, gameId);
    clearUser();
    sessionClearedByBase = true;
  }

  function isProfileMissingError(error) {
    return /cadastro não existe mais|cadastro não foi encontrado/i.test(String(error?.message || ''));
  }

  async function reloadFromAuthoritativeBase(noticeTarget, message) {
    try {
      const target = state?.game?.gameId || gameIdFromUrl();
      await loadState(target, '', { fresh: true, skipIdentityRecovery: true });
      renderPalpite();
      if (noticeTarget && message) showNotice(noticeTarget, message, '');
    } catch (_) {
      if (noticeTarget) showNotice(noticeTarget, 'Não foi possível sincronizar agora. Seus dados continuam seguros; tente novamente em alguns instantes.', 'error');
    }
  }

  function predictionDraftKey(user = getUser(), gameId = state?.game?.gameId || '') {
    const identity = String(user?.id || API.cleanEmail(user?.email) || '').trim();
    if (!identity || !gameId) return '';
    return `${PREDICTION_DRAFT_KEY_PREFIX}${encodeURIComponent(identity)}:${encodeURIComponent(gameId)}`;
  }

  function readPredictionDraft(user = getUser(), gameId = state?.game?.gameId || '') {
    const key = predictionDraftKey(user, gameId);
    if (!key) return null;

    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{}') || {};
      const storedAt = Number(raw.storedAt || 0);
      if (!raw.values || !storedAt || Date.now() - storedAt > PREDICTION_DRAFT_MAX_AGE_MS) return null;
      return raw.values;
    } catch (_) {
      return null;
    }
  }

  function persistPredictionDraft(payload) {
    const user = getUser();
    const key = predictionDraftKey({
      id: payload?.participantId || user.id,
      email: payload?.email || user.email
    }, payload?.gameId || state?.game?.gameId || '');
    if (!key) return;

    const fields = [
      'scoreHome', 'scoreAway', 'minutoPrimeiroGol', 'escanteios', 'cartoesAmarelos',
      'posseBrasil', 'posseNoruega', 'resultadoIntervalo', 'impedimentos',
      'finalizacoesBrasil', 'finalizacoesNoruega', 'artilheiroPartida',
      'vaiParaPenaltis', 'primeiroGolBrasil', 'proximoAdversarioBrasil'
    ];
    const values = {};
    fields.forEach((field) => { values[field] = payload?.[field] ?? ''; });

    try {
      localStorage.setItem(key, JSON.stringify({
        version: 1,
        storedAt: Date.now(),
        values
      }));
    } catch (_) {
      // A confirmação no servidor continua sendo a fonte principal.
    }
  }

  function clearPredictionDraft(user = getUser(), gameId = state?.game?.gameId || '') {
    const key = predictionDraftKey(user, gameId);
    if (!key) return;
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function pendingPredictionKey(user = getUser(), gameId = state?.game?.gameId || '') {
    const identity = String(user?.id || API.cleanEmail(user?.email) || '').trim();
    if (!identity || !gameId) return '';
    return `${PENDING_PREDICTION_KEY_PREFIX}${encodeURIComponent(identity)}:${encodeURIComponent(gameId)}`;
  }

  function readPendingPrediction(user = getUser(), gameId = state?.game?.gameId || '') {
    const key = pendingPredictionKey(user, gameId);
    if (!key) return null;

    try {
      const raw = JSON.parse(localStorage.getItem(key) || '{}') || {};
      const storedAt = Number(raw.storedAt || 0);
      if (!raw.payload || !raw.payload.requestId || !storedAt || Date.now() - storedAt > PREDICTION_DRAFT_MAX_AGE_MS) {
        return null;
      }
      return raw;
    } catch (_) {
      return null;
    }
  }

  function persistPendingPrediction(payload) {
    const user = getUser();
    const participantId = payload?.participantId || user.id;
    const email = payload?.email || user.email;
    const gameId = payload?.gameId || state?.game?.gameId || '';
    const key = pendingPredictionKey({ id: participantId, email }, gameId);
    if (!key || !payload?.requestId) return;

    try {
      localStorage.setItem(key, JSON.stringify({
        version: 1,
        storedAt: Date.now(),
        payload: { ...payload }
      }));
    } catch (_) {
      // O rascunho continua sendo a camada de proteção quando localStorage falha.
    }
  }

  function clearPendingPrediction(user = getUser(), gameId = state?.game?.gameId || '') {
    const key = pendingPredictionKey(user, gameId);
    if (!key) return;
    try { localStorage.removeItem(key); } catch (_) {}
  }

  function predictionValuesMatch(left, right) {
    if (!left || !right) return false;
    const fields = [
      'scoreHome', 'scoreAway', 'minutoPrimeiroGol', 'escanteios', 'cartoesAmarelos',
      'posseBrasil', 'posseNoruega', 'resultadoIntervalo', 'impedimentos',
      'finalizacoesBrasil', 'finalizacoesNoruega', 'artilheiroPartida',
      'vaiParaPenaltis', 'primeiroGolBrasil', 'proximoAdversarioBrasil'
    ];
    return fields.every((field) => String(left[field] ?? '') === String(right[field] ?? ''));
  }

  function setBusy(active, message = 'Estamos salvando o seu palpite…', blocking = true) {
    saving = Boolean(active);
    const overlay = $('saving-overlay');
    const text = $('saving-overlay-text');
    const hint = $('saving-overlay-hint');
    if (!overlay) return;
    if (text) text.textContent = message;
    if (hint) {
      hint.textContent = blocking
        ? 'Aguarde só um instante. Seus dados já estão protegidos neste dispositivo.'
        : 'Você pode continuar navegando. Vamos concluir a confirmação em segundo plano.';
    }
    overlay.classList.toggle('show', saving && blocking);
    overlay.setAttribute('aria-hidden', saving && blocking ? 'false' : 'true');
    document.body.classList.toggle('saving', saving && blocking);
  }

  function startSlowSaveFeedback() {
    clearTimeout(slowSaveTimer);
    slowSaveTimer = window.setTimeout(() => {
      if (!saving) return;
      // O Apps Script pode concluir a escrita após a resposta JSONP atrasar.
      // A bolinha deixa de bloquear a tela e o palpite continua protegido.
      setBusy(true, 'Confirmando o seu palpite…', false);
      showNotice(
        'prediction-notice',
        'Estamos confirmando seu envio. Seus dados continuam protegidos neste dispositivo; você não precisa preencher tudo de novo.',
        'loading'
      );
    }, 1800);
  }

  function stopSlowSaveFeedback() {
    clearTimeout(slowSaveTimer);
    slowSaveTimer = null;
  }

  function dateFull(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    }).format(new Date(value));
  }

  function shortDate(value) {
    if (!value) return '—';
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Sao_Paulo'
    }).format(new Date(value));
  }

  function countdown(value, status) {
    if (status === 'final') return 'Partida finalizada';
    const delta = new Date(value).getTime() - Date.now();
    if (delta <= 0) return 'O jogo começou';
    const total = Math.floor(delta / 1000);
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `Faltam <b>${days}d&nbsp; ${String(hours).padStart(2, '0')}h&nbsp; ${String(minutes).padStart(2, '0')}min</b> para o início`;
  }

  function flag(code, team) {
    return `<span class="flag-box"><img src="../assets/flags/${escape(code || 'br')}.svg" alt="Bandeira de ${escape(team)}"></span>`;
  }

  function statusLabel(game) {
    if (game.status === 'final') return '🏁 Finalizado';
    if (game.status === 'live') return '● Ao vivo';
    return '⌛ Pré-jogo';
  }

  function showNotice(target, message, type = '') {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return;
    el.textContent = message;
    el.className = `notice show ${type}`;
  }

  function clearNotice(target) {
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return;
    el.textContent = '';
    el.className = 'notice';
  }

  function showToast(message, type = '') {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { el.className = 'toast'; }, 3600);
  }

  let modalResolve = null;

  function getActionModal() {
    return {
      root: $('action-modal'),
      panel: $('action-modal-panel'),
      icon: $('action-modal-icon'),
      title: $('action-modal-title'),
      message: $('action-modal-message'),
      cancel: $('action-modal-cancel'),
      confirm: $('action-modal-confirm')
    };
  }

  function closeActionModal(value) {
    const modal = getActionModal();
    if (!modal.root) return;
    modal.root.classList.remove('show');
    modal.root.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('modal-open');
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(value);
  }

  function openActionModal(options = {}) {
    const modal = getActionModal();
    if (!modal.root) return Promise.resolve(true);

    const type = options.type || 'success';
    modal.root.className = `action-modal show ${type}`;
    modal.root.setAttribute('aria-hidden', 'false');
    document.body.classList.add('modal-open');

    modal.icon.className = `action-modal-icon ${type}`;
    modal.icon.innerHTML = type === 'success'
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 9.4 17 19 7.5"></path></svg>'
      : type === 'warning'
        ? '<span aria-hidden="true">⌛</span>'
        : '<span aria-hidden="true">!</span>';

    modal.title.textContent = options.title || 'Tudo certo';
    modal.message.textContent = options.message || '';
    modal.confirm.textContent = options.confirmText || 'OK';
    modal.confirm.className = `btn ${type === 'danger' ? 'danger modal-confirm' : 'primary modal-confirm'}`;

    const hasCancel = Boolean(options.cancelText);
    modal.cancel.hidden = !hasCancel;
    modal.cancel.textContent = options.cancelText || 'Cancelar';

    return new Promise((resolve) => {
      modalResolve = resolve;
      modal.confirm.onclick = () => closeActionModal(true);
      modal.cancel.onclick = () => closeActionModal(false);
      modal.root.onclick = (event) => {
        if (event.target === modal.root && hasCancel) closeActionModal(false);
      };
      setTimeout(() => modal.confirm.focus(), 20);
    });
  }

  async function showSuccessModal(title, message) {
    await openActionModal({ type: 'success', title, message, confirmText: 'OK' });
  }

  let deadlineModalShown = false;

  async function showDeadlineModal() {
    if (deadlineModalShown) return;
    deadlineModalShown = true;
    await openActionModal({
      type: 'warning',
      title: 'Palpites encerrados',
      message: 'Infelizmente, você não poderá mais fazer palpite. O horário disponível para realizar palpites finalizou.',
      confirmText: 'Entendi'
    });
  }

  function isBettingClosed() {
    return Boolean(!state?.submittedUntil?.isOpen || state?.game?.status === 'final');
  }

  function queueDeadlineModal() {
    if (currentPage === 'palpite' && isBettingClosed()) {
      window.setTimeout(showDeadlineModal, 100);
    }
  }

  async function confirmDeleteModal() {
    return openActionModal({
      type: 'danger',
      title: 'Excluir cadastro e palpites?',
      message: 'Seu nome, e-mail e todos os palpites ainda abertos serão removidos da base. Esta ação não pode ser desfeita.',
      confirmText: 'Excluir tudo',
      cancelText: 'Cancelar'
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const modal = getActionModal();
    if (modal.root?.classList.contains('show') && !modal.cancel.hidden) closeActionModal(false);
  });

  function gameIdFromUrl() {
    return new URLSearchParams(location.search).get('jogo') || '';
  }

  function localPreviewState() {
    return {
      games: [LOCAL_PREVIEW_GAME],
      activeGameId: LOCAL_PREVIEW_GAME.gameId,
      lastFinalGameId: '',
      state: {
        game: { ...LOCAL_PREVIEW_GAME },
        result: { available: false },
        resultComplete: false,
        myProfile: null,
        myPrediction: null,
        participation: {
          registeredCount: 0,
          predictionCount: 0,
          totalPredictionCount: 0,
          participants: []
        },
        ranking: [],
        rankingCriteria: [],
        // A tela básica é usada só enquanto os dados chegam. O Apps Script
        // continua sendo a fonte de verdade na hora de gravar um palpite.
        submittedUntil: {
          closeAt: LOCAL_PREVIEW_GAME.closeAt,
          isOpen: Date.now() < new Date(LOCAL_PREVIEW_GAME.closeAt).getTime()
        }
      }
    };
  }

  function isBrazilNorwayGame(game) {
    return Boolean(game) &&
      String(game.gameId || '') === LOCAL_PREVIEW_GAME.gameId &&
      String(game.home || '').trim().toLowerCase() === 'brasil' &&
      String(game.away || '').trim().toLowerCase() === 'noruega';
  }

  async function loadState(forcedGameId = '', emailOverride = '', options = {}) {
    const user = getUser();
    const email = API.cleanEmail(emailOverride || user.email);
    const participantId = String(options.participantId || user.id || '').trim();
    const targetGameId = forcedGameId || gameIdFromUrl();
    const response = await API.getState(targetGameId, email, participantId, {
      // Polling usa cache da base. Uma consulta forçada só é usada ao voltar
      // para a aba ou após uma falha explícita de sincronização.
      fresh: options.fresh === true
    });

    if (!isBrazilNorwayGame(response?.state?.game)) {
      throw new Error('O Apps Script conectado ainda não é a versão Brasil × Noruega. Cole o Code.gs deste pacote e atualize a implantação antes de usar o site.');
    }

    schedule = response.games || [];
    lastFinalGameId = response.lastFinalGameId || '';
    state = response.state;

    if (!state?.game) throw new Error('A base do bolão respondeu sem dados de jogo.');

    if (state?.myProfile?.id) {
      setUser(state.myProfile);
      profileSyncPending = false;
      sessionClearedByBase = false;
    } else if (hasStoredIdentity(user)) {
      // A resposta da API é definitiva: não existe perfil na base. Isso acontece
      // quando a administração exclui ou limpa testes manualmente. Não restauramos
      // dados locais nem reenviamos palpites antigos.
      clearLocalSessionBecauseBaseIsMissing(user, state?.game?.gameId || targetGameId);
      state.myProfile = null;
      state.myPrediction = null;
      profileSyncPending = false;
    } else {
      profileSyncPending = false;
    }

    // Quando uma resposta anterior caiu após a escrita, o estado fresco pode
    // confirmar o mesmo conteúdo. Só então removemos a tentativa pendente e o
    // rascunho local; um palpite em edição nunca é apagado por uma leitura antiga.
    const pending = readPendingPrediction(getUser(), state?.game?.gameId || targetGameId);
    const pendingOwner = pending?.payload ? {
      id: pending.payload.participantId || state?.myProfile?.id || getUser().id,
      email: pending.payload.email || state?.myProfile?.email || getUser().email
    } : null;

    // Apenas uma mudança administrativa cancela uma tentativa pendente. Ações
    // de outros participantes não devem invalidar o palpite que esta pessoa está
    // confirmando.
    if (pending?.payload && state?.adminVersion && pending.payload.adminVersion &&
        String(pending.payload.adminVersion) !== String(state.adminVersion)) {
      clearPendingPrediction(pendingOwner, pending.payload.gameId);
      clearPredictionDraft(pendingOwner, pending.payload.gameId);
    } else if (pending?.payload && state?.myPrediction && predictionValuesMatch(state.myPrediction, pending.payload)) {
      clearPendingPrediction(pendingOwner, pending.payload.gameId);
      clearPredictionDraft(pendingOwner, pending.payload.gameId);
    }

    persistStateCache();
    return state;
  }

  

  function profileFromWrite(response, fallback = {}) {
    const profile = response && response.profile && response.profile.email ? response.profile : {};
    const previous = getUser();
    return {
      id: profile.id || response?.participantId || fallback.id || previous.id || '',
      email: API.cleanEmail(profile.email || fallback.email || previous.email || ''),
      name: profile.name || fallback.name || previous.name || '',
      aliases: normalizeAliases([
        ...(previous.aliases || []),
        ...(fallback.aliases || []),
        fallback.email,
        profile.email
      ])
    };
  }

  function newParticipantId() {
    const uuid = window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}${Math.random().toString(36).slice(2)}`;
    return `p_${uuid}`;
  }

  function patchParticipationProfile(profile) {
    if (!state) return;
    const participation = state.participation || {
      registeredCount: 0,
      predictionCount: 0,
      totalPredictionCount: 0,
      participants: []
    };
    const participantId = String(profile.id || '').trim();
    const email = API.cleanEmail(profile.email);
    const people = Array.isArray(participation.participants) ? participation.participants : [];
    let person = people.find((item) => String(item.participantId || '') === participantId) ||
      people.find((item) => API.cleanEmail(item.email || '') === email);

    if (!person) {
      person = {
        participantId,
        name: profile.name,
        hasPrediction: false,
        predictionsForGame: 0,
        totalPredictions: 0,
        mine: true
      };
      people.push(person);
      participation.registeredCount = Number(participation.registeredCount || 0) + 1;
    } else {
      person.participantId = participantId || person.participantId;
      person.name = profile.name;
      person.mine = true;
    }

    people.forEach((item, index) => { item.position = index + 1; });
    participation.participants = people;
    state.participation = participation;
    renderParticipation();
  }

  function patchParticipationPrediction(participantId) {
    const participation = state?.participation;
    if (!participation) return;
    const person = (participation.participants || []).find((item) => String(item.participantId || '') === String(participantId || ''));
    if (person && !person.hasPrediction) {
      person.hasPrediction = true;
      person.predictionsForGame = 1;
      person.totalPredictions = Number(person.totalPredictions || 0) + 1;
      participation.predictionCount = Number(participation.predictionCount || 0) + 1;
      participation.totalPredictionCount = Number(participation.totalPredictionCount || 0) + 1;
    }
    renderParticipation();
  }

  function patchParticipationDelete(participantId, email) {
    const participation = state?.participation;
    if (!participation) return;
    const id = String(participantId || '');
    const normalized = API.cleanEmail(email);
    const person = (participation.participants || []).find((item) =>
      String(item.participantId || '') === id || API.cleanEmail(item.email || '') === normalized
    );
    if (person) {
      participation.registeredCount = Math.max(0, Number(participation.registeredCount || 0) - 1);
      if (person.hasPrediction) participation.predictionCount = Math.max(0, Number(participation.predictionCount || 0) - 1);
      participation.totalPredictionCount = Math.max(0, Number(participation.totalPredictionCount || 0) - Number(person.totalPredictions || 0));
      participation.participants = participation.participants.filter((item) => item !== person);
      participation.participants.forEach((item, index) => { item.position = index + 1; });
      renderParticipation();
    }
  }

  function scheduleBackgroundRefresh(delay = 1800) {
    const target = state?.game?.gameId || gameIdFromUrl();
    // Em um pico de acessos, cada pessoa já recebeu a confirmação do próprio
    // envio. Espalhamos a atualização pública para não criar uma fila de leituras
    // idênticas no Apps Script ao mesmo tempo.
    const stagger = Math.floor(Math.random() * 4500);
    window.setTimeout(async () => {
      if (saving || document.hidden || readPendingPrediction()) return;
      try {
        // A gravação já atualizou a tela localmente. Esta leitura é leve e serve
        // somente para alinhar contadores e dados públicos de outros participantes.
        await loadState(target, '', { keepLocalUser: true });
        renderParticipation();
        renderSchedule();
      } catch (_) {
        // A interface já avançou; esta leitura apenas atualiza os números públicos.
      }
    }, Math.max(0, Number(delay) || 0) + stagger);
  }

  function startCountdown() {
    clearInterval(countdownTimer);
    const el = document.querySelector('[data-countdown]');
    if (!el) return;

    const paint = () => {
      el.innerHTML = countdown(el.dataset.countdown, el.dataset.status || '');
    };
    paint();
    countdownTimer = setInterval(paint, 30000);
  }

  function renderHero(game, officialScore) {
    const root = $('match-hero');
    if (!root || !game) return;

    const score = officialScore && state?.result?.available
      ? `${state.result.scoreHome} <small>×</small> ${state.result.scoreAway}`
      : '×';

    root.innerHTML = `
      <div class="hero-topline">
        <span>${escape(game.competition || 'Bolão OAZ')}</span>
        <span class="status-pill ${escape(game.status)}">${statusLabel(game)}</span>
      </div>
      <div class="teams">
        <div class="team"><div class="team-flag">${flag(game.homeFlag, game.home)}</div><b>${escape(game.home)}</b></div>
        <div class="match-score">${score}</div>
        <div class="team"><div class="team-flag">${flag(game.awayFlag, game.away)}</div><b>${escape(game.away)}</b></div>
      </div>
      <p class="match-date">${escape(dateFull(game.startAt))}</p>
      <div class="countdown" data-countdown="${escape(game.startAt)}" data-status="${escape(game.status)}">${countdown(game.startAt, game.status)}</div>
      <div class="deadline">Envios até <b>${escape(shortDate(game.closeAt))}</b></div>`;

    startCountdown();
  }

  function navMarkup(active) {
    const links = [
      ['palpite.html', 'Palpite', 'palpite'],
      ['resultado.html', 'Resultado final', 'resultado']
    ];
    return links.map(([href, label, key]) =>
      `<a class="nav-link ${active === key ? 'active' : ''}" href="${href}">${label}</a>`
    ).join('');
  }

  function setNav(active) {
    const root = $('nav-links');
    if (root) root.innerHTML = navMarkup(active);
  }

  function renderSchedule() {
    const root = $('schedule-list');
    if (!root) return;

    root.innerHTML = schedule.map((game) => `
      <a class="game-card" href="palpite.html?jogo=${encodeURIComponent(game.gameId)}">
        <div class="game-card-teams">${flag(game.homeFlag, game.home)}<span>${escape(game.home)} × ${escape(game.away)}</span>${flag(game.awayFlag, game.away)}</div>
        <small>${escape(shortDate(game.startAt))} · envios até ${escape(shortDate(game.closeAt))}</small>
      </a>`).join('');
  }


  function initials(name) {
    return String(name || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part.charAt(0).toUpperCase())
      .join('') || 'O';
  }

  function renderParticipation() {
    const count = $('participants-count');
    const predictions = $('predictions-count');
    const totalPredictions = $('total-predictions-count');
    const label = $('predictions-label');
    const root = $('participants-list');
    const updated = $('participants-updated');
    const participation = state?.participation;

    if (!participation) return;

    if (count) count.textContent = String(participation.registeredCount || 0);
    if (predictions) predictions.textContent = String(participation.predictionCount || 0);
    if (totalPredictions) totalPredictions.textContent = String(participation.totalPredictionCount || 0);
    if (label) label.textContent = 'Palpites neste jogo';

    if (root) {
      const people = Array.isArray(participation.participants) ? participation.participants : [];
      root.innerHTML = people.length
        ? people.map((person) => {
            const currentStatus = person.hasPrediction ? 'Palpite enviado' : 'Cadastro realizado';
            const mine = person.mine ? ' mine' : '';
            const mineLabel = person.mine ? ' · você' : '';
            const sent = person.hasPrediction ? ' sent' : '';
            return `
              <article class="participant-row${mine}${sent}">
                <span class="participant-number">${person.position}</span>
                <span class="avatar mini-avatar" aria-hidden="true">${escape(initials(person.name))}</span>
                <div class="participant-copy">
                  <b>${escape(person.name)}${mineLabel}</b>
                  <small class="participant-status${sent}">${currentStatus}</small>
                </div>
              </article>`;
          }).join('')
        : '<p class="empty-text">Ainda não há participantes cadastrados. O primeiro nome aparecerá aqui automaticamente.</p>';
    }

    if (updated) {
      updated.textContent = connectionIssue
        ? 'Participação indisponível no momento.'
        : 'Participação ao vivo · atualização automática em poucos segundos.';
    }
  }

  function injectTeamSelectors(game) {
    const select = $('resultadoIntervalo');
    if (select) {
      const current = select.value;
      const options = [
        ['brasil', game.home],
        ['empate', 'Empate'],
        ['noruega', game.away]
      ];
      select.innerHTML = '<option value="">Selecione</option>' +
        options.map(([value, label]) => `<option value="${value}">${escape(label)}</option>`).join('');
      if (current) select.value = current;
    }

    document.querySelectorAll('[data-home-label]').forEach((el) => { el.textContent = game.home; });
    document.querySelectorAll('[data-away-label]').forEach((el) => { el.textContent = game.away; });
  }

  function profileCard(game) {
    const root = $('profile-content');
    if (!root) return;

    if (previewOnly || !API.configured() || connectionIssue) {
      root.innerHTML = `
        <section class="result-zero connection-card">
          <span class="eyebrow">Bolão OAZ</span>
          <h2>Não foi possível carregar agora</h2>
          <p>Tente novamente em alguns instantes.</p>
          <button id="retry-connection" class="btn primary" type="button">Tentar novamente</button>
        </section>`;
      $('retry-connection')?.addEventListener('click', () => boot(currentPage));
      return;
    }
    if (profileSyncPending) {
      root.innerHTML = `
        <section class="result-zero connection-card">
          <span class="eyebrow">Bolão OAZ</span>
          <h2>Confirmando seu cadastro</h2>
          <p>Estamos consultando a base oficial para garantir que os dados exibidos estejam atualizados.</p>
        </section>`;
      return;
    }

    // A planilha é a fonte do cadastro: uma base nova sempre abre com os campos vazios.
    const profile = state?.myProfile || null;

    if (profile?.email && profile?.name) {
      const locked = isBettingClosed();
      root.innerHTML = `
        <div class="profile-ready simple-profile">
          <div class="profile-copy">
            <span>Cadastro pronto</span>
            <b>${escape(profile.name)}</b>
            <small>${escape(profile.email)} · seus dados e palpites ficam vinculados a este cadastro e refletem a base oficial.</small>
          </div>
          <div class="profile-actions">
            ${locked ? '' : '<button id="change-profile" class="text-button" type="button">Alterar cadastro</button>'}
            <button id="delete-profile" class="text-button danger-text" type="button">Excluir meus dados</button>
          </div>
        </div>`;
      $('change-profile')?.addEventListener('click', () => renderProfileForm(game, profile, true));
      $('delete-profile')?.addEventListener('click', onDeleteProfile);
      return;
    }

    renderProfileForm(game, {}, false);
  }

  function renderProfileForm(game, user = {}, editing = false) {
    const root = $('profile-content');
    if (!root) return;
    const locked = isBettingClosed();

    root.innerHTML = `
      <div class="section-title">
        <div><span class="eyebrow">Bolão OAZ</span><h2>${locked ? 'Prazo de cadastro encerrado' : editing ? 'Edite seu cadastro' : 'Faça seu cadastro para palpitar'}</h2></div>
      </div>
      <div class="login-flags">${flag(game.homeFlag, game.home)}<b>${escape(game.home)}</b><span>×</span><b>${escape(game.away)}</b>${flag(game.awayFlag, game.away)}</div>
      <p class="form-intro">${locked
        ? 'O prazo de participação encerrou. Os campos permanecem bloqueados.'
        : editing
          ? 'Atualize livremente seu nome ou e-mail. Seus palpites já enviados permanecem vinculados ao seu cadastro.'
          : 'Use seu e-mail corporativo @oaz.co. Depois do primeiro cadastro, este navegador retorna diretamente aos seus palpites.'}</p>
      <form id="profile-form" class="profile-form">
        <label>Nome completo<input id="profile-name" type="text" value="${escape(user.name || '')}" placeholder="Seu nome" autocomplete="name" ${locked ? 'disabled' : ''}></label>
        <label>E-mail corporativo<input id="profile-email" type="email" inputmode="email" value="${escape(user.email || '')}" placeholder="nome@oaz.co" autocomplete="email" ${locked ? 'disabled' : ''}></label>
        <div class="profile-form-actions">
          <button class="btn primary" type="submit" ${locked ? 'disabled' : ''}>${locked ? 'Prazo encerrado' : editing ? 'Salvar alterações' : 'Continuar para o palpite'}</button>
          ${editing && !locked ? '<button id="cancel-profile-edit" class="text-button" type="button">Cancelar</button>' : ''}
        </div>
      </form>`;

    $('cancel-profile-edit')?.addEventListener('click', () => profileCard(game));

    $('profile-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      clearNotice('profile-notice');

      if (isBettingClosed()) {
        showDeadlineModal();
        return;
      }

      const name = $('profile-name').value.trim();
      const email = API.cleanEmail($('profile-email').value);

      if (!name || !email) {
        showNotice('profile-notice', 'Informe nome e e-mail corporativo para continuar.', 'error');
        return;
      }

      if (!/^[^\s@]+@oaz\.co$/i.test(email)) {
        showNotice('profile-notice', 'Para participar, use um e-mail corporativo com domínio @oaz.co.', 'error');
        return;
      }

      const userBefore = getUser();
      const stableId = userBefore.id || state?.myProfile?.id || newParticipantId();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const fallback = { id: stableId, email, name, aliases: userBefore.aliases || [] };

      // A identidade só passa a existir no navegador depois da confirmação da
      // base. Assim, um e-mail duplicado ou uma falha de rede nunca deixa um
      // "cadastro fantasma" preso na tela.
      button.disabled = true;
      button.textContent = editing ? 'Salvando…' : 'Abrindo o palpite…';
      setBusy(true, editing ? 'Salvando o seu cadastro…' : 'Preparando o seu palpite…', false);
      showNotice('profile-notice', editing ? 'Salvando suas alterações…' : 'Criando seu cadastro…', 'loading');

      try {
        const answer = await API.post({
          action: 'upsertProfile',
          name,
          email,
          participantId: stableId,
          editing: editing ? '1' : '0',
          dataVersion: state?.dataVersion || ''
        });

        const profile = profileFromWrite(answer, fallback);
        if (answer?.dataVersion) state.dataVersion = answer.dataVersion;
        setUser(profile);
        state.myProfile = {
          id: profile.id,
          email: profile.email,
          name: profile.name,
          createdAt: state?.myProfile?.createdAt || new Date().toISOString()
        };
        patchParticipationProfile(state.myProfile);
        profileSyncPending = false;
        persistStateCache();
        renderPalpite();
        showToast(editing ? 'Cadastro atualizado.' : 'Cadastro pronto. Agora envie seu palpite.', 'success');
        scheduleBackgroundRefresh();

        if (!state.submittedUntil?.isOpen || state.game?.status === 'final') {
          window.setTimeout(showDeadlineModal, 80);
        }
      } catch (error) {
        if (isProfileMissingError(error)) {
          await reloadFromAuthoritativeBase('profile-notice', 'Seu cadastro foi removido da base. Preencha os dados novamente para continuar.');
        } else {
          showNotice('profile-notice', error.message || 'Não foi possível salvar o cadastro. Tente novamente.', 'error');
        }
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = editing ? 'Salvar alterações' : 'Continuar para o palpite';
        }
      } finally {
        setBusy(false);
      }
    });
  }

  function fillPrediction(prediction) {
    if (!prediction) return;

    const fields = {
      scoreHome: 'scoreHome',
      scoreAway: 'scoreAway',
      minutoPrimeiroGol: 'minutoPrimeiroGol',
      escanteios: 'escanteios',
      cartoesAmarelos: 'cartoesAmarelos',
      posseBrasil: 'posseBrasil',
      posseNoruega: 'posseNoruega',
      resultadoIntervalo: 'resultadoIntervalo',
      impedimentos: 'impedimentos',
      finalizacoesBrasil: 'finalizacoesBrasil',
      finalizacoesNoruega: 'finalizacoesNoruega',
      artilheiroPartida: 'artilheiroPartida',
      vaiParaPenaltis: 'vaiParaPenaltis',
      primeiroGolBrasil: 'primeiroGolBrasil',
      proximoAdversarioBrasil: 'proximoAdversarioBrasil'
    };

    Object.entries(fields).forEach(([key, id]) => {
      if ($(id) && prediction[key] !== undefined) $(id).value = prediction[key];
    });
  }

  function renderPredictionForm() {
    const root = $('prediction-content');
    if (!root || !state) return;

    if (previewOnly || !API.configured() || connectionIssue) {
      root.classList.add('hidden');
      return;
    }

    const game = state.game;
    const profileReady = Boolean(state.myProfile?.id && state.myProfile?.name);

    if (!profileReady) {
      root.classList.add('hidden');
      return;
    }

    if (profileSyncPending) {
      root.classList.remove('hidden');
      $('prediction-title').textContent = 'Carregando o seu palpite';
      $('prediction-subtitle').textContent = 'Estamos confirmando seus dados salvos. Isso acontece em segundo plano.';
      $('prediction-form').querySelectorAll('input, select, button').forEach((field) => { field.disabled = true; });
      $('submit-prediction').textContent = 'Aguarde…';
      const deleteButton = $('delete-prediction');
      if (deleteButton) {
        deleteButton.hidden = true;
        deleteButton.disabled = true;
      }
      return;
    }

    const locked = isBettingClosed();
    const savedPrediction = state.myPrediction || null;
    const pendingPrediction = readPendingPrediction(getUser(), game.gameId);
    const localDraft = readPredictionDraft(getUser(), game.gameId);
    // Uma alteração que ainda está sendo confirmada tem prioridade visual sobre
    // o palpite antigo vindo da base. Isso impede que campos "voltem atrás" ao
    // atualizar a página durante uma resposta lenta.
    const visiblePrediction = pendingPrediction?.payload || savedPrediction || localDraft;

    injectTeamSelectors(game);
    root.classList.remove('hidden');
    fillPrediction(visiblePrediction);

    $('prediction-title').textContent = pendingPrediction
      ? 'Confirmando seu palpite'
      : savedPrediction
        ? 'Edite seu palpite'
        : localDraft
          ? 'Continue o seu palpite'
          : 'Monte seu palpite';
    $('prediction-subtitle').textContent = locked
      ? `O prazo terminou em ${shortDate(game.closeAt)}. Seu cadastro continua ativo, mas não é possível fazer apostas.`
      : pendingPrediction
        ? 'Sua última tentativa está protegida neste navegador enquanto confirmamos a gravação.'
        : `Você pode enviar ou alterar até ${shortDate(game.closeAt)}.`;

    $('prediction-form').querySelectorAll('input, select, button').forEach((field) => { field.disabled = locked; });
    const submitButton = $('submit-prediction');
    if (pendingPrediction && !locked) {
      $('prediction-form').querySelectorAll('input, select').forEach((field) => { field.disabled = true; });
      submitButton.disabled = false;
      submitButton.textContent = 'Confirmar novamente';
    } else {
      submitButton.textContent = savedPrediction ? 'Atualizar palpite' : 'Enviar palpite';
    }

    const deleteButton = $('delete-prediction');
    if (deleteButton) {
      deleteButton.hidden = true;
      deleteButton.disabled = true;
    }

    if (locked) {
      showNotice(
        'prediction-notice',
        'Infelizmente, você não poderá mais fazer palpite. O horário disponível para realizar palpites finalizou.',
        'error'
      );
    } else if (pendingPrediction) {
      showNotice(
        'prediction-notice',
        'Ainda estamos confirmando sua última tentativa. Seus dados estão protegidos aqui; clique em “Confirmar novamente” apenas se a confirmação não chegar.',
        'loading'
      );
    } else if (localDraft && !savedPrediction) {
      showNotice('prediction-notice', 'Seu rascunho foi restaurado neste navegador. Envie o palpite para confirmá-lo na base.', '');
    } else {
      clearNotice('prediction-notice');
    }
  }

  function predictionPayload() {
    const user = getUser();
    const read = (id) => $(id)?.value ?? '';

    return {
      action: 'savePrediction',
      gameId: state.game.gameId,
      dataVersion: state?.dataVersion || '',
      adminVersion: state?.adminVersion || '',
      // O servidor não precisa varrer a aba inteira quando é o primeiro envio.
      // Em edição, ele localiza somente o registro daquele ParticipantId.
      editingPrediction: state?.myPrediction ? '1' : '',
      participantId: user.id || state?.myProfile?.id || '',
      aliases: user.aliases || [],
      email: user.email || state?.myProfile?.email || '',
      name: user.name || state?.myProfile?.name || '',
      scoreHome: read('scoreHome'),
      scoreAway: read('scoreAway'),
      minutoPrimeiroGol: read('minutoPrimeiroGol'),
      escanteios: read('escanteios'),
      cartoesAmarelos: read('cartoesAmarelos'),
      posseBrasil: read('posseBrasil'),
      posseNoruega: read('posseNoruega'),
      resultadoIntervalo: read('resultadoIntervalo'),
      impedimentos: read('impedimentos'),
      finalizacoesBrasil: read('finalizacoesBrasil'),
      finalizacoesNoruega: read('finalizacoesNoruega'),
      artilheiroPartida: read('artilheiroPartida'),
      vaiParaPenaltis: read('vaiParaPenaltis'),
      primeiroGolBrasil: read('primeiroGolBrasil'),
      proximoAdversarioBrasil: read('proximoAdversarioBrasil')
    };
  }

  function applyConfirmedPrediction(payload, response, wasEditing, message = '') {
    if (response?.dataVersion) state.dataVersion = response.dataVersion;
    const participantId = response?.participantId || getUser().id || payload.participantId;
    if (participantId) setUser({ id: participantId });

    state.myPrediction = {
      scoreHome: Number(payload.scoreHome),
      scoreAway: Number(payload.scoreAway),
      minutoPrimeiroGol: payload.minutoPrimeiroGol,
      escanteios: payload.escanteios,
      cartoesAmarelos: payload.cartoesAmarelos,
      posseBrasil: payload.posseBrasil,
      posseNoruega: payload.posseNoruega,
      resultadoIntervalo: payload.resultadoIntervalo,
      impedimentos: payload.impedimentos,
      finalizacoesBrasil: Number(payload.finalizacoesBrasil),
      finalizacoesNoruega: Number(payload.finalizacoesNoruega),
      artilheiroPartida: payload.artilheiroPartida,
      vaiParaPenaltis: payload.vaiParaPenaltis,
      primeiroGolBrasil: payload.primeiroGolBrasil,
      proximoAdversarioBrasil: payload.proximoAdversarioBrasil,
      updatedAt: response?.updatedAt || new Date().toISOString()
    };

    patchParticipationPrediction(participantId);
    const owner = { id: participantId, email: payload.email };
    clearPendingPrediction(owner, payload.gameId);
    clearPredictionDraft(owner, payload.gameId);
    persistStateCache();

    if (currentPage === 'palpite') {
      renderPalpite();
      scheduleBackgroundRefresh();
    }

    showToast(message || (wasEditing ? 'Palpite atualizado.' : 'Palpite enviado com sucesso.'), 'success');
  }

  async function reconcilePendingPrediction(options = {}) {
    const pending = readPendingPrediction();
    if (!pending?.payload || pending.payload.action !== 'savePrediction') return false;

    const payload = pending.payload;
    const confirmed = await API.confirmWrite(payload, {
      attempts: options.attempts ?? 2,
      intervalMs: options.intervalMs ?? 800
    });

    if (confirmed) {
      applyConfirmedPrediction(payload, confirmed, Boolean(payload.editingPrediction), 'Palpite confirmado com sucesso.');
      return true;
    }

    // Não reenviamos automaticamente. Caso a administração tenha excluído ou
    // alterado dados, um reenvio silencioso poderia recriar um palpite apagado.
    // O botão "Confirmar novamente" é a única ação que pode disparar nova escrita.
    return false;
  }

  function schedulePendingPredictionReconciliation(delay = 1800, retryWrite = true) {
    clearTimeout(pendingReconciliationTimer);
    pendingReconciliationTimer = window.setTimeout(async () => {
      if (saving || document.hidden) return;
      const resolved = await reconcilePendingPrediction({ retryWrite });
      if (!resolved && currentPage === 'palpite' && readPendingPrediction()) {
        showNotice(
          'prediction-notice',
          'Ainda não foi possível confirmar a última tentativa. Seu palpite segue protegido neste navegador; você pode usar “Confirmar novamente”.',
          'loading'
        );
      }
    }, Math.max(0, Number(delay) || 0));
  }

  async function onPredictionSubmit(event) {
    event.preventDefault();
    clearNotice('prediction-notice');

    if (!state.submittedUntil?.isOpen) {
      showDeadlineModal();
      return;
    }

    const existingPending = readPendingPrediction();
    const payload = predictionPayload();
    // Reutiliza a mesma requestId ao confirmar novamente. O backend trata essa
    // operação como idempotente e não cria um segundo palpite.
    payload.requestId = existingPending?.payload?.requestId || API.newRequestId();

    const form = $('prediction-form');
    if (form && !form.checkValidity()) {
      form.reportValidity();
      showNotice('prediction-notice', 'Preencha todos os campos do palpite.', 'error');
      return;
    }

    const requiredFields = [
      'scoreHome', 'scoreAway', 'minutoPrimeiroGol', 'escanteios', 'cartoesAmarelos',
      'posseBrasil', 'posseNoruega', 'resultadoIntervalo', 'impedimentos',
      'finalizacoesBrasil', 'finalizacoesNoruega', 'artilheiroPartida',
      'vaiParaPenaltis', 'primeiroGolBrasil', 'proximoAdversarioBrasil'
    ];
    const incomplete = requiredFields.some((key) => String(payload[key] ?? '').trim() === '');

    if (incomplete) {
      showNotice('prediction-notice', 'Preencha todos os campos do palpite.', 'error');
      return;
    }

    // Primeiro persiste no navegador. Mesmo com aba fechada, refresh ou demora
    // de resposta, o preenchimento volta com a mesma requestId para reconciliação.
    persistPredictionDraft(payload);
    persistPendingPrediction(payload);

    const button = $('submit-prediction');
    const wasEditing = Boolean(state.myPrediction);
    button.disabled = true;
    button.textContent = 'Salvando…';
    setBusy(true, wasEditing ? 'Atualizando o seu palpite…' : 'Registrando o seu palpite…');
    startSlowSaveFeedback();

    try {
      const response = await API.post(payload);
      applyConfirmedPrediction(payload, response, wasEditing);
    } catch (error) {
      const message = error.message || 'Não foi possível enviar o palpite.';
      if (/horário estabelecido|encerrou|prazo/i.test(message)) {
        clearPendingPrediction({ id: payload.participantId, email: payload.email }, payload.gameId);
        showDeadlineModal();
      } else if (isProfileMissingError(error)) {
        clearPendingPrediction({ id: payload.participantId, email: payload.email }, payload.gameId);
        await reloadFromAuthoritativeBase('prediction-notice', 'Seu cadastro não existe mais na base. A tela foi atualizada para você começar novamente.');
      } else if (API.isRetryableWriteError?.(error)) {
        showNotice(
          'prediction-notice',
          'Ainda não foi possível confirmar a última tentativa. Seus dados ficaram como rascunho neste navegador; clique em “Confirmar novamente” quando desejar tentar de novo.',
          'loading'
        );
        schedulePendingPredictionReconciliation(1400, false);
      } else {
        showNotice('prediction-notice', message, 'error');
      }
    } finally {
      stopSlowSaveFeedback();
      setBusy(false);
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = readPendingPrediction()
          ? 'Confirmar novamente'
          : state?.myPrediction
            ? 'Atualizar palpite'
            : 'Enviar palpite';
      }
    }
  }

  async function onDeleteEverything(source = 'profile') {
    const user = getUser();
    if (!user.email && !user.id) return;

    const confirmed = await confirmDeleteModal();
    if (!confirmed) return;

    const sourceButton = source === 'prediction' ? $('delete-prediction') : $('delete-profile');
    if (sourceButton) {
      sourceButton.disabled = true;
      sourceButton.textContent = 'Excluindo…';
    }
    setBusy(true, 'Excluindo o seu cadastro e todos os palpites…', false);
    showNotice(source === 'prediction' ? 'prediction-notice' : 'profile-notice', 'Excluindo seus dados…', 'loading');

    try {
      const deleted = await API.post({
        action: 'deleteProfile',
        email: user.email,
        participantId: user.id,
        aliases: user.aliases || [],
        dataVersion: state?.dataVersion || ''
      });
      const totalRemoved = Number(deleted?.removed?.cadastros || 0) + Number(deleted?.removed?.palpites || 0) + Number(deleted?.removed?.pontuacoes || 0);
      if (!deleted?.deleted || (!totalRemoved && !deleted?.alreadyDeleted)) {
        throw new Error('Não foi possível confirmar a exclusão dos seus dados.');
      }

      // A própria resposta confirma que as linhas foram removidas. Limpamos a sessão
      // e a tela sem esperar uma leitura adicional da planilha.
      patchParticipationDelete(user.id, user.email);
      clearUser();
      state.myProfile = null;
      state.myPrediction = null;
      persistStateCache();
      renderPalpite();
      scheduleBackgroundRefresh();
      setBusy(false);
      showToast('Cadastro e palpites excluídos.', 'success');
      $('profile-name')?.focus();
    } catch (error) {
      const target = source === 'prediction' ? 'prediction-notice' : 'profile-notice';
      if (isProfileMissingError(error)) {
        await reloadFromAuthoritativeBase(target, 'Seus dados já não existem na base. Atualizamos a sua tela.');
      } else {
        showNotice(target, error.message || 'Não foi possível confirmar a exclusão. Tente novamente em alguns instantes.', 'error');
      }
    } finally {
      setBusy(false);
      if (sourceButton?.isConnected) {
        sourceButton.disabled = false;
        sourceButton.textContent = source === 'prediction'
          ? 'Excluir cadastro e todos os palpites'
          : 'Excluir meus dados';
      }
    }
  }

  function onPredictionDraftInput() {
    if (!state?.game || !state?.myProfile?.id || profileSyncPending) return;
    persistPredictionDraft(predictionPayload());
  }

  function onDeletePrediction() {
    return onDeleteEverything('prediction');
  }

  function onDeleteProfile() {
    return onDeleteEverything('profile');
  }

  function renderPalpite() {
    setNav('palpite');
    renderHero(state.game, false);
    renderSchedule();
    renderParticipation();
    profileCard(state.game);
    renderPredictionForm();
    if (sessionClearedByBase) {
      showNotice('profile-notice', 'O cadastro anterior não existe mais na base. Você pode preencher os dados novamente para criar um novo cadastro.', '');
      sessionClearedByBase = false;
    }
    $('prediction-form')?.removeEventListener('submit', onPredictionSubmit);
    $('prediction-form')?.addEventListener('submit', onPredictionSubmit);
    $('prediction-form')?.removeEventListener('input', onPredictionDraftInput);
    $('prediction-form')?.addEventListener('input', onPredictionDraftInput);
    $('prediction-form')?.removeEventListener('change', onPredictionDraftInput);
    $('prediction-form')?.addEventListener('change', onPredictionDraftInput);
    $('delete-prediction')?.removeEventListener('click', onDeletePrediction);
    $('delete-prediction')?.addEventListener('click', onDeletePrediction);
    queueDeadlineModal();
  }

  function readable(value, game) {
    const labels = {
      brasil: game.home,
      noruega: game.away,
      empate: 'Empate'
    };
    return labels[value] || value || '—';
  }

  function formatPoints(value) {
    const points = Number(value || 0);
    return points.toFixed(4).replace('.', ',');
  }

  function officialMetrics(result, game) {
    const items = [
      ['Minuto do 1º gol', result.minutoPrimeiroGol],
      ['Total de escanteios', result.escanteios],
      ['Total de cartões amarelos', result.cartoesAmarelos],
      ['Posse de bola do Brasil', result.posseBrasil],
      ['Posse de bola da Noruega', result.posseNoruega],
      ['Resultado do intervalo', readable(result.resultadoIntervalo, game)],
      ['Impedimentos', result.impedimentos],
      ['Finalizações a gol do Brasil', result.finalizacoesBrasil],
      ['Finalizações a gol da Noruega', result.finalizacoesNoruega],
      ['Artilheiro da partida', result.artilheiroPartida],
      ['Vai para os pênaltis?', result.vaiParaPenaltis],
      ['Primeiro gol do Brasil', result.primeiroGolBrasil],
      ['Próximo adversário do Brasil', result.proximoAdversarioBrasil]
    ];

    return items.map(([label, value]) =>
      `<div class="metric-result"><span>${escape(label)}</span><b>${escape(value)}</b></div>`
    ).join('');
  }

  function predictionDetails(row, game) {
    const prediction = row.prediction || {};
    const details = [
      ['Placar', `${prediction.scoreHome ?? '—'} × ${prediction.scoreAway ?? '—'}`],
      ['Minuto do 1º gol', prediction.minutoPrimeiroGol],
      ['Total de escanteios', prediction.escanteios],
      ['Total de cartões amarelos', prediction.cartoesAmarelos],
      ['Posse Brasil', prediction.posseBrasil],
      ['Posse Noruega', prediction.posseNoruega],
      ['Intervalo', readable(prediction.resultadoIntervalo, game)],
      ['Impedimentos', prediction.impedimentos],
      ['Finalizações Brasil', prediction.finalizacoesBrasil],
      ['Finalizações Noruega', prediction.finalizacoesNoruega],
      ['Artilheiro', prediction.artilheiroPartida],
      ['Pênaltis?', prediction.vaiParaPenaltis],
      ['1º gol Brasil', prediction.primeiroGolBrasil],
      ['Próximo adversário', prediction.proximoAdversarioBrasil]
    ];

    return `<div class="prediction-summary-grid">${details.map(([label, value]) =>
      `<div><span>${escape(label)}</span><b>${escape(value ?? '—')}</b></div>`
    ).join('')}</div>`;
  }

  function compactRanking(ranking, game) {
    if (!ranking?.length) return '<p class="empty-text">Nenhum palpite foi enviado para este jogo.</p>';

    return ranking.map((row) => `
      <article class="rank-row rank-row-expanded">
        <div class="rank-position ${row.position <= 3 ? `top-${row.position}` : ''}">
          ${row.position <= 3 ? ['🥇', '🥈', '🥉'][row.position - 1] : row.position}
        </div>
        <div class="rank-name">
          <div class="rank-topline">
            <b>${escape(row.name)}</b>
            <span class="rank-score">${formatPoints(row.points)} pts</span>
          </div>
          <small>${row.matches} ${row.matches === 1 ? 'acerto' : 'acertos'} · pontuação-base: ${Number(row.basePoints || 0)} pts</small>
          ${predictionDetails(row, game)}
        </div>
      </article>`).join('');
  }

  function podium(ranking) {
    const leaders = (ranking || []).slice(0, 3);
    if (!leaders.length) return '<p class="empty-text">Pódio liberado após a conferência do resultado.</p>';

    return `<div class="podium">${leaders.map((row, index) =>
      `<div class="podium-item place-${index + 1}">
        <b>${escape(row.name)}</b><span>${formatPoints(row.points)} pts</span><div class="podium-step">${index + 1}º</div>
      </div>`).join('')}</div>`;
  }

  function renderResultado() {
    setNav('resultado');
    renderHero(state.game, state.resultComplete);
    renderParticipation();

    const root = $('result-content');
    if (!root) return;

    if (!state.resultComplete) {
      root.innerHTML = `
        <section class="result-zero">
          <span class="eyebrow">Resultado final</span>
          <h1>Em apuração</h1>
          <p>Estamos conferindo as métricas oficiais. Assim que o resultado for confirmado, o ranking será liberado aqui.</p>
        </section>`;
      return;
    }

    const game = state.game;
    root.innerHTML = `
      <section class="official-result">
        <span class="eyebrow">Resultado oficial</span>
        <div class="official-score">
          <div>${flag(game.homeFlag, game.home)}<b>${escape(game.home)}</b></div>
          <strong>${state.result.scoreHome} <i>×</i> ${state.result.scoreAway}</strong>
          <div>${flag(game.awayFlag, game.away)}<b>${escape(game.away)}</b></div>
        </div>
        <div class="metric-grid">${officialMetrics(state.result, game)}</div>
      </section>
      <section class="podium-section">
        <span class="eyebrow">Pódio</span>
        <p class="result-note">Os três maiores pontuadores da rodada.</p>
        ${podium(state.ranking)}
      </section>
      <section class="results-list">
        <span class="eyebrow">Classificação completa</span>
        <p class="result-note">Veja o palpite de cada participante, a quantidade de acertos e a pontuação final. O desempate técnico impede pontuações iguais no ranking.</p>
        <div class="rank-list">${compactRanking(state.ranking, game)}</div>
      </section>`;
  }

  function renderPage(page) {
    if (page === 'resultado') renderResultado();
    else renderPalpite();
  }

  async function refreshLiveData(page, options = {}) {
    if (previewOnly || refreshing || saving || document.hidden) return;
    refreshing = true;

    try {
      const target = page === 'resultado'
        ? (lastFinalGameId || state?.game?.gameId || '')
        : (state?.game?.gameId || gameIdFromUrl());
      const before = {
        profileId: state?.myProfile?.id || '',
        profileEmail: state?.myProfile?.email || '',
        profileName: state?.myProfile?.name || '',
        predictionUpdatedAt: state?.myPrediction?.updatedAt || '',
        resultComplete: Boolean(state?.resultComplete),
        locked: Boolean(isBettingClosed())
      };

      // O polling usa a base como fonte de verdade. Assim, exclusões e edições
      // feitas pela administração refletem no navegador sem exigir novo login.
      await loadState(target, '', { fresh: options.fresh === true, keepLocalUser: false });

      if (page === 'resultado') {
        renderResultado();
      } else {
        const after = {
          profileId: state?.myProfile?.id || '',
          profileEmail: state?.myProfile?.email || '',
          profileName: state?.myProfile?.name || '',
          predictionUpdatedAt: state?.myPrediction?.updatedAt || '',
          resultComplete: Boolean(state?.resultComplete),
          locked: Boolean(isBettingClosed())
        };
        const baseChanged = JSON.stringify(before) !== JSON.stringify(after);
        const typing = Boolean(document.activeElement?.closest('#profile-form, #prediction-form'));

        // Não interrompe alguém enquanto digita, exceto quando a rodada foi
        // fechada/finalizada. Fora esse caso, a tela passa a mostrar a edição
        // administrativa na atualização automática seguinte.
        if (baseChanged && (!typing || after.resultComplete || after.locked)) {
          renderPalpite();
        } else {
          renderParticipation();
          renderSchedule();
        }
      }
    } catch (_) {
      // Mantém a última tela legível se houver uma oscilação temporária.
    } finally {
      refreshing = false;
    }
  }

  function startPolling(page) {
    clearInterval(pollTimer);
    if (previewOnly) return;

    const seconds = page === 'palpite'
      ? Math.max(10, Number(CONFIG.participantsPollSeconds || 15))
      : Math.max(15, Number(CONFIG.pollSeconds || 30));

    // A primeira leitura é distribuída para os navegadores que abriram o
    // bolão juntos; depois disso cada navegador mantém o próprio intervalo.
    window.setTimeout(() => refreshLiveData(page), 1200 + Math.floor(Math.random() * 5000));
    pollTimer = setInterval(() => refreshLiveData(page), seconds * 1000);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLiveData(currentPage, { fresh: true });
  });

  async function boot(page) {
    currentPage = page || 'palpite';
    connectionIssue = false;
    previewOnly = !API.configured();

    if (previewOnly) {
      const preview = localPreviewState();
      schedule = preview.games;
      lastFinalGameId = '';
      state = preview.state;
      connectionIssue = true;
      showNotice('page-notice', 'A conexão do Bolão OAZ ainda não foi configurada.', 'error');
      renderPage(currentPage);
      return;
    }

    const savedUser = getUser();
    const restoredFromCache = restoreCachedState(savedUser);
    if (!restoredFromCache) prepareFastShell(savedUser);

    // A página abre de imediato com a última cópia conhecida — ou com a estrutura
    // do jogo — e a resposta do Apps Script é carregada sem travar a pessoa no
    // modal de espera. O modal central fica reservado para gravações reais.
    previewOnly = false;
    connectionIssue = false;
    renderPage(currentPage);
    startPolling(currentPage);

    try {
      await loadState(gameIdFromUrl(), '', { fresh: false });

      if (currentPage === 'resultado' && !gameIdFromUrl() && lastFinalGameId && state.game.gameId !== lastFinalGameId) {
        await loadState(lastFinalGameId);
      }

      previewOnly = false;
      connectionIssue = false;
      profileSyncPending = false;
      clearNotice('page-notice');
      renderPage(currentPage);
      if (currentPage === 'palpite' && readPendingPrediction()) {
        schedulePendingPredictionReconciliation(900, true);
      }
    } catch (_) {
      // Sem travar nem apagar o que já estava na tela. Uma nova atualização será
      // tentada pelo polling/retorno à aba; os salvamentos continuam confirmados
      // individualmente antes de avançar.
      if (restoredFromCache) {
        showNotice('page-notice', 'Mostrando seus dados salvos enquanto atualizamos as informações do bolão.', '');
      } else if (savedUser.id) {
        // Mantém os dados locais visíveis quando a rede oscila. A base será
        // sincronizada na próxima tentativa automática, sem bloquear a jornada.
        profileSyncPending = false;
        renderPage(currentPage);
        showNotice('page-notice', 'Não foi possível sincronizar agora. Seus dados salvos continuam disponíveis e tentaremos novamente automaticamente.', '');
      }
      if (currentPage === 'palpite' && readPendingPrediction()) {
        schedulePendingPredictionReconciliation(1200, true);
      }
    }
  }

  window.BolaoApp = { boot };
})();
