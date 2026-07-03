/**
 * BOLÃO OAZ — Brasil × Noruega · V13 · UX ágil
 *
 * BASE DO PROJETO
 * - A planilha usa apenas: Cadastros, Palpites e Resultados.
 * - O Apps Script conecta o site à planilha e mantém cadastro, edição e exclusão.
 * - O resultado oficial é preenchido manualmente na aba "Resultados".
 * - Ao definir Status como "final" e preencher todas as métricas, o pódio e a
 *   classificação completa são calculados automaticamente no site.
 *
 * PRIMEIRO USO
 * 1. Importe o arquivo Excel atualizado para o Google Sheets.
 * 2. Abra Extensões > Apps Script e substitua todo o conteúdo por este arquivo.
 * 3. Execute setup() uma única vez e autorize.
 * 4. Implante/atualize como Aplicativo da Web mantendo o mesmo /exec.
 */

const BOLAO = {
  VERSION: '2026-07-03-brasil-noruega-v13-ux-agil',
  TZ: 'America/Sao_Paulo',
  ALLOWED_EMAIL_DOMAIN: 'oaz.co',

  GAME: {
    gameId: 'brasil-noruega-2026-07-05',
    competition: 'Copa do Mundo 2026 · Oitavas de final',
    home: 'Brasil',
    away: 'Noruega',
    startAt: '2026-07-05T17:00:00-03:00',
    // Prazo solicitado: hoje, 03/07/2026, às 23h50 de São Paulo.
    closeAt: '2026-07-03T23:50:00-03:00',
    homeFlag: 'br',
    awayFlag: 'no',
    venue: 'New York New Jersey Stadium · East Rutherford, EUA'
  },

  CACHE: {
    // Leituras públicas usam cache curto. Cadastros, exclusões e edições
    // administrativas limpam o cache imediatamente; assim, o polling não relê
    // a planilha inteira a cada pessoa, mas continua refletindo a base oficial.
    ROWS_TTL_SECONDS: {
      Cadastros: 12,
      Palpites: 12,
      Resultados: 12
    },
    PARTICIPATION_TTL_SECONDS: 12,
    ROWS_KEYS: {
      Cadastros: 'bolao_rows_cadastros_br_noruega_v13',
      Palpites: 'bolao_rows_palpites_br_noruega_v13',
      Resultados: 'bolao_rows_resultados_br_noruega_v13'
    }
  },

  SCHEMAS: {
    Cadastros: ['Email', 'Nome', 'CriadoEm', 'AtualizadoEm', 'ParticipantId'],
    Palpites: [
      'GameId', 'Email', 'Nome',
      'PlacarBrasil', 'PlacarNoruega',
      'MinutoPrimeiroGol', 'Escanteios', 'CartoesAmarelos',
      'PosseBrasil', 'PosseNoruega', 'ResultadoIntervalo', 'Impedimentos',
      'FinalizacoesBrasil', 'FinalizacoesNoruega',
      'ArtilheiroPartida', 'VaiParaPenaltis', 'PrimeiroGolBrasil', 'ProximoAdversarioBrasil',
      'CriadoEm', 'AtualizadoEm', 'ParticipantId'
    ],
    Resultados: [
      'GameId',
      'PlacarBrasil', 'PlacarNoruega',
      'MinutoPrimeiroGol', 'Escanteios', 'CartoesAmarelos',
      'PosseBrasil', 'PosseNoruega', 'ResultadoIntervalo', 'Impedimentos',
      'FinalizacoesBrasil', 'FinalizacoesNoruega',
      'ArtilheiroPartida', 'VaiParaPenaltis', 'PrimeiroGolBrasil', 'ProximoAdversarioBrasil',
      'Status', 'AtualizadoEm'
    ]
  },

  OPTIONS: {
    minuteFirstGoal: ["0'-15'", "16'-30'", "31'-45+'", "46'-60'", "61'-75'", "76'-90+'", 'Sem gol'],
    corners: ['0-3', '4-6', '7-10', '11-14', '15+'],
    yellowCards: ['0', '1-2', '3-4', '5+'],
    possession: ['0%-45%', '46%-55%', '56%-65%', '66%-75%', '76%-100%'],
    halfTime: ['brasil', 'empate', 'noruega'],
    offsides: ['0-1', '2-3', '4-5', '6+'],
    topScorer: ['Neymar', 'Endrick', 'Vini Júnior'],
    penalties: ['Sim', 'Não'],
    firstBrazilGoal: ['Neymar', 'Endrick', 'Vini Júnior', 'Douglas Santos', 'Matheus Cunha'],
    nextBrazilOpponent: ['Inglaterra', 'México']
  },

  // A soma máxima é 100 pontos. Em empate de pontos-base, erro acumulado,
  // horário de envio e ParticipantId geram um ajuste técnico inferior a 1 ponto.
  SCORE_RULES: [
    { label: 'Placar exato', description: '22 pontos', maxPoints: 22 },
    { label: 'Resultado final correto', description: '10 pontos, quando o placar não for exato', maxPoints: 10 },
    { label: 'Placar do Brasil', description: '5 pontos', maxPoints: 5 },
    { label: 'Placar da Noruega', description: '5 pontos', maxPoints: 5 },
    { label: 'Minuto do 1º gol', description: '7 pontos', maxPoints: 7 },
    { label: 'Total de escanteios', description: '7 pontos', maxPoints: 7 },
    { label: 'Total de cartões amarelos', description: '5 pontos', maxPoints: 5 },
    { label: 'Posse de bola do Brasil', description: '5 pontos', maxPoints: 5 },
    { label: 'Posse de bola da Noruega', description: '5 pontos', maxPoints: 5 },
    { label: 'Resultado do intervalo', description: '8 pontos', maxPoints: 8 },
    { label: 'Impedimentos', description: '4 pontos', maxPoints: 4 },
    { label: 'Finalizações a gol do Brasil', description: '5 exato · 2 com diferença de 1', maxPoints: 5 },
    { label: 'Finalizações a gol da Noruega', description: '5 exato · 2 com diferença de 1', maxPoints: 5 },
    { label: 'Artilheiro da partida', description: '5 pontos', maxPoints: 5 },
    { label: 'Decisão nos pênaltis', description: '3 pontos', maxPoints: 3 },
    { label: 'Primeiro gol do Brasil', description: '4 pontos', maxPoints: 4 },
    { label: 'Próximo adversário do Brasil', description: '5 pontos', maxPoints: 5 }
  ]
};

let BOLAO_BOOK = null;
let BOLAO_WRITE_SHEETS_READY = false;

/* =============================== PRIMEIRO USO =============================== */

function setup() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) throw new Error('Abra este projeto pelo Google Sheets e execute setup() uma vez.');

  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', active.getId());
  BOLAO_BOOK = active;

  ensureSheets_();
  const consolidation = deduplicateProfilesByEmail_();
  removeLegacyGamesSheet_();
  keepOnlyBrazilNorwayResult_();
  styleAllSheets_();
  installAdminSyncTrigger_();
  markBaseChanged_('admin');

  return 'Base preparada: Cadastros, Palpites e Resultados. E-mail obrigatório: @oaz.co. E-mails duplicados consolidados: ' + consolidation.removedProfiles + '. Palpites até sexta-feira, 03/07/2026, às 23h50.';
}

function repararFormatacaoDaBase() {
  return withWriteLock_(function() {
    ensureSheets_();
    repairDataFormats_();
    SpreadsheetApp.flush();
    markBaseChanged_('admin');
    return 'Formatação reparada: números, textos e datas da base foram normalizados. Os palpites existentes continuam preservados.';
  });
}

/**
 * Limpa apenas os registros de teste/participação.
 * A aba Resultados NÃO é alterada, para não apagar o resultado oficial.
 * Execute esta função pelo editor do Apps Script quando quiser reiniciar o bolão.
 */
function limparBaseDeDados() {
  return withWriteLock_(function() {
    ensureWriteSheets_();

    const removed = {
      cadastros: clearSheetData_('Cadastros'),
      palpites: clearSheetData_('Palpites')
    };

    const dataVersion = markBaseChanged_('admin');
    SpreadsheetApp.flush();

    return 'Base limpa com sucesso. Foram removidos ' + removed.cadastros +
      ' cadastro(s) e ' + removed.palpites +
      ' palpite(s). A aba Resultados foi preservada. Versão da base: ' + dataVersion + '.';
  });
}

// Nome alternativo para quem preferir deixá-lo explícito no editor.
function limparBaseDeTestes() {
  return limparBaseDeDados();
}

/**
 * Garante o gatilho que invalida o cache quando a administração edita,
 * adiciona ou remove linhas diretamente na planilha.
 * Só é necessário executar caso o projeto não tenha sido preparado antes.
 */
function ativarSincronizacaoAdministrativa() {
  ensureSheets_();
  installAdminSyncTrigger_();
  const dataVersion = markBaseChanged_('admin');
  return 'Sincronização administrativa ativa. Alterações manuais aparecerão no site após a atualização automática. Versão da base: ' + dataVersion + '.';
}

function atualizarRankingDosFinalizados() {
  return withWriteLock_(function() {
    ensureSheets_();
    const result = currentResult_();
    if (!isCompleteFinalResult_(result)) {
      return 'Ainda não há resultado final completo. Preencha todos os campos da aba Resultados e altere Status para final.';
    }

    const ranking = rankingForGame_(result, rows_('Palpites'));
    clearPublicCache_();

    if (!ranking.length) return 'Resultado final registrado, mas ainda não há palpites para Brasil × Noruega.';

    const podium = ranking.slice(0, 3).map(function(row) {
      return row.position + 'º ' + row.name + ' (' + formatPoints_(row.points) + ' pts)';
    }).join(' · ');

    return 'Ranking publicado: ' + podium + '.';
  });
}

function recalcularPontuacoes() {
  return atualizarRankingDosFinalizados();
}


/* =============================== MENU DA PLANILHA =============================== */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Bolão OAZ')
    .addItem('Abrir aba Resultados', 'menuAbrirResultados_')
    .addItem('Publicar / atualizar ranking', 'menuAtualizarRanking_')
    .addSeparator()
    .addItem('Buscar participante por nome', 'menuBuscarUsuarioPorNome_')
    .addItem('Excluir participante', 'menuExcluirUsuario_')
    .addItem('Consolidar e-mails duplicados', 'menuConsolidarCadastros_')
    .addItem('Reparar formatação de dados', 'menuRepararFormatacaoDaBase_')
    .addSeparator()
    .addItem('Limpar cadastros e palpites de teste', 'menuLimparBaseDeDados_')
    .addItem('Ativar sincronização de edições manuais', 'ativarSincronizacaoAdministrativa')
    .addToUi();
}

function menuAbrirResultados_() {
  activateSheet_('Resultados');
  SpreadsheetApp.getUi().alert(
    'Como finalizar e publicar o ranking',
    'Preencha a única linha de Brasil × Noruega. Quando todos os campos estiverem preenchidos e Status estiver como final, o site calcula o pódio e a classificação completa.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function menuAtualizarRanking_() {
  SpreadsheetApp.getUi().alert(atualizarRankingDosFinalizados());
}

function menuConsolidarCadastros_() {
  const result = withWriteLock_(function() {
    const consolidation = deduplicateProfilesByEmail_();
    clearPublicCache_();
    return consolidation;
  });

  SpreadsheetApp.getUi().alert(
    'Cadastros consolidados',
    'Cadastros removidos por e-mail duplicado: ' + result.removedProfiles + '. Palpites vinculados ao cadastro mantido: ' + result.relinkedPredictions + '.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function menuRepararFormatacaoDaBase_() {
  SpreadsheetApp.getUi().alert(repararFormatacaoDaBase());
}

function menuLimparBaseDeDados_() {
  const ui = SpreadsheetApp.getUi();
  const confirmation = ui.alert(
    'Limpar base de testes?',
    'Esta ação remove TODOS os cadastros e palpites das abas Cadastros e Palpites. A aba Resultados será preservada. Esta ação não pode ser desfeita.',
    ui.ButtonSet.YES_NO
  );

  if (confirmation === ui.Button.YES) {
    ui.alert(limparBaseDeDados());
  }
}

function buscarUsuariosPorNome(nome) {
  const search = normalizeSearch_(nome);
  if (search.length < 2) throw new Error('Digite pelo menos duas letras do nome.');

  const predictions = rows_('Palpites');
  return uniqueProfiles_(rows_('Cadastros'))
    .filter(function(profile) {
      return normalizeSearch_(profile.Nome).indexOf(search) >= 0;
    })
    .map(function(profile) {
      const participantId = participantIdFromRow_(profile);
      const count = predictions.filter(function(row) {
        return string_(row.GameId) === BOLAO.GAME.gameId && participantMatches_(row, participantId, [profile.Email]);
      }).length;

      return {
        nome: string_(profile.Nome),
        email: normalizeEmail_(profile.Email),
        criadoEm: iso_(profile.CriadoEm),
        palpites: count
      };
    })
    .sort(function(a, b) {
      return a.nome.localeCompare(b.nome, 'pt-BR');
    });
}

function menuBuscarUsuarioPorNome_() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Buscar participante', 'Digite parte do nome.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const matches = buscarUsuariosPorNome(response.getResponseText());
  if (!matches.length) return ui.alert('Nenhum participante encontrado.');

  const text = matches.map(function(item) {
    return item.nome + '\n' + item.email + ' · ' + item.palpites + ' palpite(s) para Brasil × Noruega';
  }).join('\n\n');

  ui.alert('Resultados encontrados (' + matches.length + ')', text, ui.ButtonSet.OK);
}

function excluirUsuarioPorEmail(email) {
  const normalized = normalizeEmail_(email);
  if (!isValidEmail_(normalized)) throw new Error('Informe um e-mail válido.');

  return withWriteLock_(function() {
    const profiles = rows_('Cadastros');
    const profile = profiles.filter(function(row) {
      return normalizeEmail_(row.Email) === normalized;
    })[0];

    if (!profile) throw new Error('Nenhum participante encontrado com este e-mail.');

    const participantId = participantIdFromRow_(profile);
    const removed = {
      cadastros: deleteRowsWhere_('Cadastros', function(row) {
        return participantMatches_(row, participantId, [normalized]);
      }),
      palpites: deleteRowsWhere_('Palpites', function(row) {
        return participantMatches_(row, participantId, [normalized]);
      })
    };

    clearPublicCache_();
    return 'Participante removido: ' + string_(profile.Nome) + '. ' + removed.palpites + ' palpite(s) também foram removidos.';
  });
}

function menuExcluirUsuario_() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Excluir participante', 'Digite parte do nome para localizar.', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;

  const matches = buscarUsuariosPorNome(response.getResponseText());
  if (!matches.length) return ui.alert('Nenhum participante encontrado.');

  const options = matches.map(function(item) {
    return item.nome + ' — ' + item.email;
  }).join('\n');

  const choose = ui.prompt(
    'Confirmar exclusão',
    'Encontrados:\n' + options + '\n\nCole o e-mail exato da pessoa que deseja excluir.',
    ui.ButtonSet.OK_CANCEL
  );
  if (choose.getSelectedButton() !== ui.Button.OK) return;

  const email = normalizeEmail_(choose.getResponseText());
  const selected = matches.filter(function(item) {
    return item.email === email;
  })[0];

  if (!selected) return ui.alert('O e-mail informado não corresponde a um dos resultados. Nenhuma exclusão foi feita.');

  const confirmation = ui.alert(
    'Excluir ' + selected.nome + '?',
    'O cadastro e todos os palpites dessa pessoa serão apagados.',
    ui.ButtonSet.YES_NO
  );

  if (confirmation === ui.Button.YES) ui.alert(excluirUsuarioPorEmail(selected.email));
}

/* =============================== WEB APP =============================== */

function doGet(e) {
  const params = (e && e.parameter) || {};
  const callback = params.prefix || '';

  try {
    const action = string_(params.action || 'state');

    if (action === 'state') {
      return output_({
        ok: true,
        data: appState_(params.email || '', params.participantId || '', isTruthy_(params.fresh))
      }, callback);
    }

    if (action === 'health') {
      return output_({
        ok: true,
        data: { ready: true, version: BOLAO.VERSION, at: nowIso_() }
      }, callback);
    }

    if (action === 'receipt') {
      // Consultas rápidas verificam apenas o recibo em cache. A leitura direta
      // da planilha fica reservada para o fallback explícito, evitando que uma
      // confirmação concorra com a própria gravação.
      return output_({ ok: true, data: readWriteReceipt_(params, isTruthy_(params.fallback)) }, callback);
    }
    // As escritas também podem vir por JSONP: isso permite ao site confirmar a
    // gravação na própria resposta, sem depender de um iframe oculto.


    if (['upsertProfile', 'savePrediction', 'deletePrediction', 'deleteProfile'].indexOf(action) >= 0) {
      const payload = queryPayload_(params, action);
      return output_({ ok: true, data: runWrite_(payload) }, callback);
    }

    throw new Error('Ação não reconhecida.');
  } catch (error) {
    return output_({ ok: false, error: error.message || String(error) }, callback);
  }
}

function doPost(e) {
  try {
    const payload = postPayload_(e);
    return output_({ ok: true, data: runWrite_(payload) }, '');
  } catch (error) {
    return output_({ ok: false, error: error.message || String(error) }, '');
  }
}

function queryPayload_(params, action) {
  const raw = string_(params.payload);
  let payload = {};

  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch (_) {
      throw new Error('Não foi possível ler os dados enviados.');
    }
  }

  payload.action = string_(payload.action || action);
  return payload;
}

function runWrite_(payload) {
  verifyAccess_(payload);

  const action = string_(payload && payload.action).trim();
  const requestId = string_(payload && payload.requestId).trim();

  // A requestId identifica uma intenção de escrita. A resposta deve ser a mesma
  // mesmo que outro participante tenha gravado algo depois: a versão global da
  // base não pode transformar uma confirmação tardia em duplicidade.
  if (requestId) {
    const previous = readWriteReceipt_({ requestId: requestId });
    if (previous && previous.confirmed && previous.data) return previous.data;
  }

  // dataVersion é um marcador de sincronização da interface, não uma trava
  // global. Um novo cadastro não deve falhar porque outra pessoa acabou de
  // participar do bolão em paralelo.
  let data;
  if (action === 'upsertProfile') data = upsertProfile_(payload);
  else if (action === 'savePrediction') data = savePrediction_(payload);
  else if (action === 'deletePrediction' || action === 'deleteProfile') data = deleteProfile_(payload);
  else throw new Error('Ação de gravação não reconhecida.');

  // Não forçamos SpreadsheetApp.flush(): a resposta só é entregue quando a
  // execução termina e o Apps Script persiste a alteração. Evitar o flush reduz
  // a latência percebida em cadastros e exclusões concorrentes.
  const dataVersion = markBaseChanged_('write');
  data = Object.assign({}, data || {}, {
    dataVersion: dataVersion,
    adminVersion: adminVersion_()
  });
  writeWriteReceipt_(payload, { confirmed: true, data: data, dataVersion: dataVersion });
  return data;
}

/* =============================== RECIBO DE ESCRITA =============================== */

function writeReceiptKey_(requestId) {
  return 'bolao_write_receipt_br_noruega_' + string_(requestId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 160);
}

function writeWriteReceipt_(payload, value) {
  const requestId = string_(payload && payload.requestId).trim();
  if (!requestId) return;

  const receipt = Object.assign({
    action: string_(payload.action),
    requestId: requestId,
    at: nowIso_()
  }, value || {});

  try {
    CacheService.getScriptCache().put(writeReceiptKey_(requestId), JSON.stringify(receipt), 1800);
  } catch (_) {
    // O recibo é uma aceleração; a leitura da planilha continua como fallback.
  }
}

function readWriteReceipt_(params, allowSheetFallback) {
  const requestId = string_(params.requestId).trim();
  if (requestId) {
    try {
      const cached = CacheService.getScriptCache().get(writeReceiptKey_(requestId));
      if (cached) return JSON.parse(cached);
    } catch (_) {
      // O fallback abaixo continua disponível quando solicitado.
    }
  }

  // Enquanto a escrita original está em andamento, ler a base inteira aqui
  // adiciona latência e pode fazer o navegador concluir, incorretamente, que o
  // palpite falhou. O cliente faz pequenas consultas ao recibo e só solicita a
  // checagem direta quando realmente necessário.
  if (!allowSheetFallback) return { confirmed: false };

  const action = string_(params.writeAction || '').trim();
  const email = normalizeEmail_(params.email || '');
  const participantId = string_(params.participantId || '').trim();
  const aliases = normalizeEmailList_([email]);

  if (action === 'upsertProfile') {
    const profile = findProfileByIdentity_(rows_('Cadastros'), participantId, email, aliases);
    if (profile) {
      return {
        confirmed: true,
        fallback: true,
        data: { profile: publicProfile_(profile) }
      };
    }
  }

  if (action === 'savePrediction') {
    const profile = findProfileByIdentity_(rows_('Cadastros'), participantId, email, aliases);
    const id = profile ? participantIdFromRow_(profile) : participantId;
    const prediction = rows_('Palpites').filter(function(row) {
      return string_(row.GameId) === BOLAO.GAME.gameId && participantMatches_(row, id, aliases);
    })[0];

    if (prediction) {
      return {
        confirmed: true,
        fallback: true,
        data: {
          saved: true,
          gameId: BOLAO.GAME.gameId,
          participantId: id,
          updatedAt: iso_(prediction.AtualizadoEm)
        }
      };
    }
  }

  if (action === 'deleteProfile' || action === 'deletePrediction') {
    const stillExists = rows_('Cadastros').some(function(row) {
      return participantMatches_(row, participantId, aliases);
    });

    if (!stillExists) {
      return {
        confirmed: true,
        fallback: true,
        data: { deleted: true, alreadyDeleted: true, participantId: participantId, removed: { cadastros: 0, palpites: 0 } }
      };
    }
  }

  return { confirmed: false };
}

/* =============================== ESTADO PÚBLICO =============================== */

function appState_(requestedEmail, requestedParticipantId, forceFresh) {
  const snapshot = readSnapshot_(forceFresh);
  const result = snapshot.results.filter(function(row) {
    return string_(row.GameId) === BOLAO.GAME.gameId;
  })[0] || {};

  const complete = isCompleteFinalResult_(result);
  const game = publicGame_(result, complete);
  const participantId = string_(requestedParticipantId).trim();
  const email = normalizeEmail_(requestedEmail);

  // A chave principal continua sendo o ParticipantId persistido no navegador.
  // Como segunda camada de recuperação, usamos o e-mail salvo pela própria pessoa
  // quando o navegador volta sem a chave local (por exemplo, após limpeza de cache).
  // Isso não cria novo cadastro nem altera a planilha; apenas restaura a identidade
  // já existente e devolve o ParticipantId correto ao site.
  const profile = findProfileByIdentity_(
    snapshot.cadastros,
    participantId,
    email,
    email ? [email] : []
  );

  const profileId = profile ? participantIdFromRow_(profile) : participantId;
  const prediction = profile
    ? predictionForParticipant_(snapshot.palpites, profileId, [normalizeEmail_(profile.Email), email])
    : null;

  const ranking = complete ? rankingForGame_(result, snapshot.palpites) : [];

  return {
    games: [game],
    activeGameId: BOLAO.GAME.gameId,
    lastFinalGameId: complete ? BOLAO.GAME.gameId : '',
    updatedAt: nowIso_(),
    state: {
      game: game,
      result: publicResult_(result, complete),
      resultComplete: complete,
      myProfile: profile ? publicProfile_(profile) : null,
      myPrediction: prediction ? publicPrediction_(prediction) : null,
      participation: publicParticipation_(snapshot.cadastros, snapshot.palpites, profileId),
      ranking: ranking,
      rankingCriteria: publicRankingCriteria_(),
      dataVersion: dataVersion_(),
      adminVersion: adminVersion_(),
      submittedUntil: {
        closeAt: BOLAO.GAME.closeAt,
        isOpen: !complete && Date.now() < toEpoch_(BOLAO.GAME.closeAt)
      }
    }
  };
}

function publicGame_(result, complete) {
  const game = BOLAO.GAME;
  const now = Date.now();
  const status = complete ? 'final' : now >= toEpoch_(game.startAt) ? 'live' : 'pre';

  return {
    gameId: game.gameId,
    competition: game.competition,
    home: game.home,
    away: game.away,
    startAt: game.startAt,
    closeAt: game.closeAt,
    status: status,
    homeFlag: game.homeFlag,
    awayFlag: game.awayFlag,
    venue: game.venue,
    scoreHome: complete ? sportNumber_(result.PlacarBrasil) : '',
    scoreAway: complete ? sportNumber_(result.PlacarNoruega) : '',
    locked: complete || Date.now() >= toEpoch_(game.closeAt)
  };
}

function publicResult_(result, complete) {
  if (!complete) return { available: false };

  return {
    available: true,
    scoreHome: sportNumber_(result.PlacarBrasil),
    scoreAway: sportNumber_(result.PlacarNoruega),
    minutoPrimeiroGol: string_(result.MinutoPrimeiroGol),
    escanteios: normalizeRange_(result.Escanteios, 'corners'),
    cartoesAmarelos: normalizeRange_(result.CartoesAmarelos, 'yellowCards'),
    posseBrasil: normalizePossession_(result.PosseBrasil),
    posseNoruega: normalizePossession_(result.PosseNoruega),
    resultadoIntervalo: normalizeHalfTime_(result.ResultadoIntervalo),
    impedimentos: normalizeRange_(result.Impedimentos, 'offsides'),
    finalizacoesBrasil: sportNumber_(result.FinalizacoesBrasil),
    finalizacoesNoruega: sportNumber_(result.FinalizacoesNoruega),
    artilheiroPartida: string_(result.ArtilheiroPartida),
    vaiParaPenaltis: normalizeYesNo_(result.VaiParaPenaltis),
    primeiroGolBrasil: string_(result.PrimeiroGolBrasil),
    proximoAdversarioBrasil: string_(result.ProximoAdversarioBrasil),
    updatedAt: iso_(result.AtualizadoEm)
  };
}

function publicProfile_(row) {
  return {
    id: participantIdFromRow_(row),
    email: normalizeEmail_(row.Email),
    name: string_(row.Nome),
    createdAt: iso_(row.CriadoEm),
    updatedAt: iso_(row.AtualizadoEm)
  };
}

function publicPrediction_(row) {
  return {
    scoreHome: sportNumber_(row.PlacarBrasil),
    scoreAway: sportNumber_(row.PlacarNoruega),
    minutoPrimeiroGol: string_(row.MinutoPrimeiroGol),
    escanteios: normalizeRange_(row.Escanteios, 'corners'),
    cartoesAmarelos: normalizeRange_(row.CartoesAmarelos, 'yellowCards'),
    posseBrasil: normalizePossession_(row.PosseBrasil),
    posseNoruega: normalizePossession_(row.PosseNoruega),
    resultadoIntervalo: normalizeHalfTime_(row.ResultadoIntervalo),
    impedimentos: normalizeRange_(row.Impedimentos, 'offsides'),
    finalizacoesBrasil: sportNumber_(row.FinalizacoesBrasil),
    finalizacoesNoruega: sportNumber_(row.FinalizacoesNoruega),
    artilheiroPartida: string_(row.ArtilheiroPartida),
    vaiParaPenaltis: normalizeYesNo_(row.VaiParaPenaltis),
    primeiroGolBrasil: string_(row.PrimeiroGolBrasil),
    proximoAdversarioBrasil: string_(row.ProximoAdversarioBrasil),
    updatedAt: iso_(row.AtualizadoEm)
  };
}

function readSnapshot_(forceFresh) {
  return {
    cadastros: rowsCached_('Cadastros', forceFresh),
    palpites: rowsCached_('Palpites', forceFresh),
    results: rowsCached_('Resultados', forceFresh)
  };
}

function rowsCached_(sheetName, forceFresh) {
  const key = BOLAO.CACHE.ROWS_KEYS[sheetName];
  if (!key) return rows_(sheetName);

  if (!forceFresh) {
    const cached = readCacheJson_(key);
    if (Array.isArray(cached)) return cached;
  }

  const fresh = rows_(sheetName);
  const ttlConfig = BOLAO.CACHE.ROWS_TTL_SECONDS;
  const ttl = Number(typeof ttlConfig === 'object' ? ttlConfig[sheetName] : ttlConfig) || 60;
  writeCacheJson_(key, fresh, ttl);
  return fresh;
}

function publicParticipation_(cadastros, palpites, currentParticipantId) {
  const base = participationBase_(cadastros, palpites);
  const current = string_(currentParticipantId).trim();

  return {
    registeredCount: base.registeredCount,
    predictionCount: base.predictionCount,
    totalPredictionCount: base.predictionCount,
    gameId: BOLAO.GAME.gameId,
    updatedAt: base.updatedAt,
    participants: base.participants.map(function(item) {
      return {
        position: item.position,
        participantId: item.participantId,
        name: item.name,
        hasPrediction: item.hasPrediction,
        predictionsForGame: item.predictionsForGame,
        totalPredictions: item.predictionsForGame,
        mine: !!current && item.participantId === current
      };
    })
  };
}

function participationBase_(cadastros, palpites) {
  const cacheKey = 'bolao_participation_br_noruega_v13';
  const cached = readCacheJson_(cacheKey);
  if (cached && Array.isArray(cached.participants)) return cached;

  const profiles = uniqueProfiles_(cadastros).sort(function(a, b) {
    const timeA = toEpoch_(a.CriadoEm);
    const timeB = toEpoch_(b.CriadoEm);
    if (timeA !== timeB) return timeA - timeB;
    return string_(a.Nome).localeCompare(string_(b.Nome), 'pt-BR');
  });

  // Um palpite sem cadastro correspondente foi apagado/alterado manualmente
  // pela administração e não pode continuar sendo contado no site.
  const activeParticipantIds = {};
  profiles.forEach(function(profile) {
    activeParticipantIds[participantIdFromRow_(profile)] = true;
  });

  const predictionsById = {};
  latestPredictionsForGame_(palpites).forEach(function(row) {
    const participantId = participantIdFromRow_(row);
    if (activeParticipantIds[participantId]) predictionsById[participantId] = true;
  });

  const base = {
    registeredCount: profiles.length,
    predictionCount: Object.keys(predictionsById).length,
    updatedAt: nowIso_(),
    participants: profiles.map(function(profile, index) {
      const participantId = participantIdFromRow_(profile);
      const hasPrediction = !!predictionsById[participantId];

      return {
        position: index + 1,
        participantId: participantId,
        name: string_(profile.Nome).trim() || 'Participante',
        hasPrediction: hasPrediction,
        predictionsForGame: hasPrediction ? 1 : 0
      };
    })
  };

  writeCacheJson_(cacheKey, base, BOLAO.CACHE.PARTICIPATION_TTL_SECONDS);
  return base;
}

/* =============================== CADASTRO E PALPITE =============================== */

function upsertProfile_(payload) {
  const email = normalizeEmail_(payload.email);
  const name = string_(payload.name).trim();
  const suppliedId = string_(payload.participantId).trim();
  const now = new Date();

  if (!name) throw new Error('Informe o seu nome completo para participar.');
  if (!isValidEmail_(email)) throw new Error('Informe um e-mail válido.');
  if (!isAllowedEmail_(email)) throw new Error('Para participar do Bolão OAZ, use um e-mail corporativo com domínio @oaz.co.');
  if (Date.now() >= toEpoch_(BOLAO.GAME.closeAt)) {
    throw new Error('Infelizmente, você não poderá mais fazer palpite. O horário disponível para realizar palpites finalizou.');
  }

  return withWriteLock_(function() {
    ensureWriteSheets_();
    const profiles = rows_('Cadastros');
    const profileById = suppliedId
      ? latestProfile_(profiles.filter(function(row) {
          return participantIdFromRow_(row) === suppliedId;
        }))
      : null;
    const profileWithSameEmail = latestProfile_(profiles.filter(function(row) {
      return normalizeEmail_(row.Email) === email;
    }));

    // A validação de e-mail é estrita: um novo cadastro nunca "assume" o
    // cadastro de outra sessão. Só quem já possui o mesmo ParticipantId pode
    // alterar o próprio nome/e-mail por meio do botão Alterar cadastro.
    if (profileWithSameEmail &&
        (!profileById || participantIdFromRow_(profileWithSameEmail) !== participantIdFromRow_(profileById))) {
      throw new Error('Este e-mail já possui cadastro no Bolão OAZ. Use outro e-mail corporativo ou altere o cadastro na sessão original.');
    }

    // Edição só pode atingir um cadastro que ainda existe. Isso impede que uma
    // aba antiga recrie um perfil removido manualmente, sem bloquear cadastros
    // novos quando outra pessoa altera a base em paralelo.
    if (isTruthy_(payload.editing) && suppliedId && !profileById) {
      throw new Error('Seu cadastro não existe mais na base. Preencha os dados novamente para participar.');
    }

    if (profileById) {
      updateRowsWhere_('Cadastros', function(row) {
        return participantIdFromRow_(row) === participantIdFromRow_(profileById);
      }, function(row) {
        row.Email = email;
        row.Nome = name;
        row.CriadoEm = row.CriadoEm || now;
        row.AtualizadoEm = now;
        row.ParticipantId = participantIdFromRow_(profileById);
        return row;
      });

      updateRowsWhere_('Palpites', function(row) {
        return participantIdFromRow_(row) === participantIdFromRow_(profileById);
      }, function(row) {
        row.Email = email;
        row.Nome = name;
        row.AtualizadoEm = now;
        row.ParticipantId = participantIdFromRow_(profileById);
        return row;
      });

      return {
        profile: publicProfile_({
          Email: email,
          Nome: name,
          CriadoEm: profileById.CriadoEm || now,
          AtualizadoEm: now,
          ParticipantId: participantIdFromRow_(profileById)
        })
      };
    }

    const participantId = suppliedId || newParticipantId_();
    fastAppend_('Cadastros', {
      Email: email,
      Nome: name,
      CriadoEm: now,
      AtualizadoEm: now,
      ParticipantId: participantId
    });

    return {
      profile: publicProfile_({
        Email: email,
        Nome: name,
        CriadoEm: now,
        AtualizadoEm: now,
        ParticipantId: participantId
      })
    };
  });
}

function savePrediction_(payload) {
  const result = currentResult_();
  if (isCompleteFinalResult_(result)) throw new Error('Este jogo já foi finalizado.');

  if (Date.now() >= toEpoch_(BOLAO.GAME.closeAt)) {
    throw new Error('Infelizmente, você não poderá mais fazer palpite. O horário disponível para realizar palpites finalizou.');
  }

  const participantId = string_(payload.participantId).trim();
  const email = normalizeEmail_(payload.email);
  const name = string_(payload.name).trim();
  if (!participantId || !email || !name) throw new Error('Não foi possível vincular seu cadastro. Preencha seus dados novamente para continuar.');
  if (!isAllowedEmail_(email)) throw new Error('Para participar do Bolão OAZ, use um e-mail corporativo com domínio @oaz.co.');

  const prediction = predictionFromPayload_(payload);
  const now = new Date();
  const editingPrediction = isTruthy_(payload.editingPrediction);

  const record = {
    GameId: BOLAO.GAME.gameId,
    Email: email,
    Nome: name,
    PlacarBrasil: prediction.PlacarBrasil,
    PlacarNoruega: prediction.PlacarNoruega,
    MinutoPrimeiroGol: prediction.MinutoPrimeiroGol,
    Escanteios: prediction.Escanteios,
    CartoesAmarelos: prediction.CartoesAmarelos,
    PosseBrasil: prediction.PosseBrasil,
    PosseNoruega: prediction.PosseNoruega,
    ResultadoIntervalo: prediction.ResultadoIntervalo,
    Impedimentos: prediction.Impedimentos,
    FinalizacoesBrasil: prediction.FinalizacoesBrasil,
    FinalizacoesNoruega: prediction.FinalizacoesNoruega,
    ArtilheiroPartida: prediction.ArtilheiroPartida,
    VaiParaPenaltis: prediction.VaiParaPenaltis,
    PrimeiroGolBrasil: prediction.PrimeiroGolBrasil,
    ProximoAdversarioBrasil: prediction.ProximoAdversarioBrasil,
    CriadoEm: now,
    AtualizadoEm: now,
    ParticipantId: participantId
  };

  return withWriteLock_(function() {
    ensureWriteSheets_();
    const profile = latestProfile_(rows_('Cadastros').filter(function(row) {
      return participantIdFromRow_(row) === participantId && normalizeEmail_(row.Email) === email;
    }));
    if (!profile) throw new Error('Seu cadastro não existe mais na base. Preencha os dados novamente para participar.');

    if (!editingPrediction) {
      // O primeiro envio não precisa varrer a aba inteira para descobrir algo
      // que a própria interface já sabe: ainda não existe palpite deste perfil.
      // A requestId mantém tentativas repetidas idempotentes.
      fastAppend_('Palpites', record);
    } else {
      const updated = updatePredictionByParticipant_(record, participantId);
      if (!updated) fastAppend_('Palpites', record);
    }

    return {
      saved: true,
      gameId: BOLAO.GAME.gameId,
      participantId: participantId,
      updatedAt: iso_(now)
    };
  });
}

function updatePredictionByParticipant_(record, participantId) {
  const sheet = sheet_('Palpites');
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;

  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(string_);
  const gameColumn = headers.indexOf('GameId');
  const participantColumn = headers.indexOf('ParticipantId');
  const updatedColumn = headers.indexOf('AtualizadoEm');
  if (gameColumn < 0 || participantColumn < 0) return false;

  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  let targetIndex = -1;
  let newest = -Infinity;

  values.forEach(function(row, index) {
    if (string_(row[gameColumn]) !== BOLAO.GAME.gameId) return;
    if (string_(row[participantColumn]).trim() !== participantId) return;
    const stamp = updatedColumn >= 0 ? toEpoch_(row[updatedColumn]) : index;
    if (stamp >= newest) {
      newest = stamp;
      targetIndex = index;
    }
  });

  if (targetIndex < 0) return false;

  const oldRow = values[targetIndex];
  const output = headers.map(function(header, column) {
    if (header === 'CriadoEm') return oldRow[column] || record.CriadoEm;
    return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : oldRow[column];
  });

  sheet.getRange(targetIndex + 2, 1, 1, width).setValues([output]);
  return true;
}

function deleteProfile_(payload) {
  const participantId = string_(payload.participantId).trim();
  const aliases = normalizeEmailList_([payload.email].concat(payload.aliases || []));

  if (!participantId && !aliases.length) {
    return {
      deleted: true,
      type: 'profile',
      participantId: '',
      removed: { cadastros: 0, palpites: 0 },
      alreadyDeleted: true
    };
  }

  return withWriteLock_(function() {
    ensureWriteSheets_();
    const removed = {
      cadastros: deleteRowsWhere_('Cadastros', function(row) {
        return participantMatches_(row, participantId, aliases);
      }),
      palpites: deleteRowsWhere_('Palpites', function(row) {
        return participantMatches_(row, participantId, aliases);
      })
    };

    return {
      deleted: true,
      type: 'profile',
      participantId: participantId,
      removed: removed,
      alreadyDeleted: !removed.cadastros && !removed.palpites
    };
  });
}

function predictionFromPayload_(payload) {
  const numeric = ['scoreHome', 'scoreAway', 'finalizacoesBrasil', 'finalizacoesNoruega'];
  numeric.forEach(function(field) {
    if (isBlank_(payload[field]) || !isInteger_(payload[field])) {
      throw new Error('Preencha os placares e as finalizações a gol com números inteiros.');
    }
  });

  const values = {
    scoreHome: number_(payload.scoreHome),
    scoreAway: number_(payload.scoreAway),
    finalizacoesBrasil: number_(payload.finalizacoesBrasil),
    finalizacoesNoruega: number_(payload.finalizacoesNoruega)
  };

  if (values.scoreHome < 0 || values.scoreHome > 20 ||
      values.scoreAway < 0 || values.scoreAway > 20 ||
      values.finalizacoesBrasil < 0 || values.finalizacoesBrasil > 30 ||
      values.finalizacoesNoruega < 0 || values.finalizacoesNoruega > 30) {
    throw new Error('Confira os valores numéricos do palpite.');
  }

  const selectRules = [
    ['minutoPrimeiroGol', BOLAO.OPTIONS.minuteFirstGoal],
    ['escanteios', BOLAO.OPTIONS.corners],
    ['cartoesAmarelos', BOLAO.OPTIONS.yellowCards],
    ['posseBrasil', BOLAO.OPTIONS.possession],
    ['posseNoruega', BOLAO.OPTIONS.possession],
    ['resultadoIntervalo', BOLAO.OPTIONS.halfTime],
    ['impedimentos', BOLAO.OPTIONS.offsides],
    ['artilheiroPartida', BOLAO.OPTIONS.topScorer],
    ['vaiParaPenaltis', BOLAO.OPTIONS.penalties],
    ['primeiroGolBrasil', BOLAO.OPTIONS.firstBrazilGoal],
    ['proximoAdversarioBrasil', BOLAO.OPTIONS.nextBrazilOpponent]
  ];

  selectRules.forEach(function(rule) {
    const field = rule[0];
    const options = rule[1];
    if (options.indexOf(string_(payload[field])) < 0) {
      throw new Error('Selecione uma opção válida para todos os campos do palpite.');
    }
  });

  return {
    PlacarBrasil: values.scoreHome,
    PlacarNoruega: values.scoreAway,
    MinutoPrimeiroGol: string_(payload.minutoPrimeiroGol),
    Escanteios: string_(payload.escanteios),
    CartoesAmarelos: string_(payload.cartoesAmarelos),
    PosseBrasil: string_(payload.posseBrasil),
    PosseNoruega: string_(payload.posseNoruega),
    ResultadoIntervalo: string_(payload.resultadoIntervalo),
    Impedimentos: string_(payload.impedimentos),
    FinalizacoesBrasil: values.finalizacoesBrasil,
    FinalizacoesNoruega: values.finalizacoesNoruega,
    ArtilheiroPartida: string_(payload.artilheiroPartida),
    VaiParaPenaltis: string_(payload.vaiParaPenaltis),
    PrimeiroGolBrasil: string_(payload.primeiroGolBrasil),
    ProximoAdversarioBrasil: string_(payload.proximoAdversarioBrasil)
  };
}

/* =============================== RESULTADO E PONTUAÇÃO =============================== */

function currentResult_() {
  return rowsCached_('Resultados', false).filter(function(row) {
    return string_(row.GameId) === BOLAO.GAME.gameId;
  })[0] || {};
}

function isCompleteFinalResult_(result) {
  if (!result || normalizeSearch_(result.Status) !== 'final') return false;

  const fields = [
    'PlacarBrasil', 'PlacarNoruega',
    'MinutoPrimeiroGol', 'Escanteios', 'CartoesAmarelos', 'PosseBrasil', 'PosseNoruega',
    'ResultadoIntervalo', 'Impedimentos',
    'FinalizacoesBrasil', 'FinalizacoesNoruega',
    'ArtilheiroPartida', 'VaiParaPenaltis', 'PrimeiroGolBrasil', 'ProximoAdversarioBrasil'
  ];

  return fields.every(function(field) {
    return !isBlank_(result[field]);
  });
}

function publicRankingCriteria_() {
  return BOLAO.SCORE_RULES.map(function(rule) {
    return {
      label: rule.label,
      description: rule.description,
      maxPoints: rule.maxPoints
    };
  }).concat([{
    label: 'Desempate técnico',
    description: 'Menor erro acumulado; persistindo, palpite enviado primeiro. Um ajuste técnico inferior a 1 ponto evita pontuações finais iguais.',
    maxPoints: 0
  }]);
}

function rankingForGame_(result, predictions) {
  const source = Array.isArray(predictions) ? predictions : rowsCached_('Palpites');
  const ranked = latestPredictionsForGame_(source)
    .map(function(prediction) {
      const scored = scorePrediction_(prediction, result);

      return {
        participantId: participantIdFromRow_(prediction),
        name: string_(prediction.Nome) || 'Participante',
        predictedScore: sportNumber_(prediction.PlacarBrasil) + ' × ' + sportNumber_(prediction.PlacarNoruega),
        prediction: publicPrediction_(prediction),
        basePoints: scored.basePoints,
        points: scored.basePoints,
        matches: scored.matches,
        checks: scored.checks,
        precisionError: scored.precisionError,
        createdAt: iso_(prediction.CriadoEm),
        updatedAt: iso_(prediction.AtualizadoEm)
      };
    })
    .sort(function(a, b) {
      if (b.basePoints !== a.basePoints) return b.basePoints - a.basePoints;
      if (a.precisionError !== b.precisionError) return a.precisionError - b.precisionError;
      if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
      if (a.participantId !== b.participantId) return a.participantId.localeCompare(b.participantId);
      return a.name.localeCompare(b.name, 'pt-BR');
    });

  applyTechnicalTieBreak_(ranked);

  return ranked.map(function(row, index) {
    row.position = index + 1;
    row.points = Number(row.points.toFixed(4));
    return row;
  });
}

function applyTechnicalTieBreak_(rows) {
  let start = 0;

  while (start < rows.length) {
    const base = rows[start].basePoints;
    let end = start + 1;
    while (end < rows.length && rows[end].basePoints === base) end += 1;

    const groupSize = end - start;
    if (groupSize > 1) {
      const step = 0.9 / (groupSize + 1);

      for (let offset = 0; offset < groupSize; offset += 1) {
        if (base >= 100) {
          rows[start + offset].points = 100 - (step * offset);
        } else {
          rows[start + offset].points = base + (step * (groupSize - offset));
        }
      }
    }

    start = end;
  }
}

function scorePrediction_(prediction, result) {
  let basePoints = 0;
  let matches = 0;
  let precisionError = 0;
  const checks = [];

  function reward(label, points, matched) {
    if (matched && points > 0) {
      basePoints += points;
      matches += 1;
    }
    checks.push({ label: label, ok: !!matched, points: matched ? points : 0 });
  }

  function numericExact(predictionKey, resultKey, label, points) {
    const difference = Math.abs(sportNumber_(prediction[predictionKey]) - sportNumber_(result[resultKey]));
    precisionError += difference;
    reward(label, points, difference === 0);
  }

  function numericProximity(predictionKey, resultKey, label, exactPoints, oneAwayPoints) {
    const difference = Math.abs(sportNumber_(prediction[predictionKey]) - sportNumber_(result[resultKey]));
    precisionError += difference;
    const points = difference === 0 ? exactPoints : difference === 1 ? oneAwayPoints : 0;
    reward(label + (difference === 0 ? ' (exato)' : points ? ' (proximidade)' : ''), points, points > 0);
  }

  function categorical(predictionKey, resultKey, label, points, options) {
    const predicted = canonicalOptionValue_(prediction[predictionKey], options);
    const official = canonicalOptionValue_(result[resultKey], options);
    const predictedIndex = options.indexOf(predicted);
    const officialIndex = options.indexOf(official);
    const matched = predicted === official && predictedIndex >= 0;
    precisionError += matched ? 0 : categoryDistance_(predictedIndex, officialIndex);
    reward(label, points, matched);
  }

  const exactScore = sportNumber_(prediction.PlacarBrasil) === sportNumber_(result.PlacarBrasil) &&
    sportNumber_(prediction.PlacarNoruega) === sportNumber_(result.PlacarNoruega);

  const scoreError = Math.abs(sportNumber_(prediction.PlacarBrasil) - sportNumber_(result.PlacarBrasil)) +
    Math.abs(sportNumber_(prediction.PlacarNoruega) - sportNumber_(result.PlacarNoruega));
  precisionError += scoreError;

  if (exactScore) {
    reward('Placar exato', 22, true);
  } else {
    reward(
      'Resultado final correto',
      10,
      outcome_(prediction.PlacarBrasil, prediction.PlacarNoruega) === outcome_(result.PlacarBrasil, result.PlacarNoruega)
    );
  }

  numericExact('PlacarBrasil', 'PlacarBrasil', 'Placar do Brasil', 5);
  numericExact('PlacarNoruega', 'PlacarNoruega', 'Placar da Noruega', 5);
  categorical('MinutoPrimeiroGol', 'MinutoPrimeiroGol', 'Minuto do 1º gol', 7, BOLAO.OPTIONS.minuteFirstGoal);
  categorical('Escanteios', 'Escanteios', 'Total de escanteios', 7, BOLAO.OPTIONS.corners);
  categorical('CartoesAmarelos', 'CartoesAmarelos', 'Total de cartões amarelos', 5, BOLAO.OPTIONS.yellowCards);
  categorical('PosseBrasil', 'PosseBrasil', 'Posse de bola do Brasil', 5, BOLAO.OPTIONS.possession);
  categorical('PosseNoruega', 'PosseNoruega', 'Posse de bola da Noruega', 5, BOLAO.OPTIONS.possession);
  categorical('ResultadoIntervalo', 'ResultadoIntervalo', 'Resultado do intervalo', 8, BOLAO.OPTIONS.halfTime);
  categorical('Impedimentos', 'Impedimentos', 'Impedimentos', 4, BOLAO.OPTIONS.offsides);
  numericProximity('FinalizacoesBrasil', 'FinalizacoesBrasil', 'Finalizações a gol do Brasil', 5, 2);
  numericProximity('FinalizacoesNoruega', 'FinalizacoesNoruega', 'Finalizações a gol da Noruega', 5, 2);
  categorical('ArtilheiroPartida', 'ArtilheiroPartida', 'Artilheiro da partida', 5, BOLAO.OPTIONS.topScorer);
  categorical('VaiParaPenaltis', 'VaiParaPenaltis', 'Decisão nos pênaltis', 3, BOLAO.OPTIONS.penalties);
  categorical('PrimeiroGolBrasil', 'PrimeiroGolBrasil', 'Primeiro gol do Brasil', 4, BOLAO.OPTIONS.firstBrazilGoal);
  categorical('ProximoAdversarioBrasil', 'ProximoAdversarioBrasil', 'Próximo adversário do Brasil', 5, BOLAO.OPTIONS.nextBrazilOpponent);

  return {
    basePoints: Math.max(0, Math.min(100, basePoints)),
    matches: matches,
    checks: checks,
    precisionError: precisionError
  };
}

function categoryDistance_(predictedIndex, officialIndex) {
  if (predictedIndex < 0 || officialIndex < 0) return 5;
  return Math.max(1, Math.abs(predictedIndex - officialIndex));
}

function outcome_(home, away) {
  const diff = sportNumber_(home) - sportNumber_(away);
  return diff > 0 ? 'brasil' : diff < 0 ? 'noruega' : 'empate';
}

function formatPoints_(value) {
  return Number(value || 0).toFixed(4).replace('.', ',');
}

/* =============================== PLANILHA =============================== */

function ensureSheets_() {
  const book = getBook_();
  Object.keys(BOLAO.SCHEMAS).forEach(function(name) {
    ensureSheet_(book, name, BOLAO.SCHEMAS[name]);
  });
}

function ensureWriteSheets_() {
  // A validação estrutural precisa continuar existindo, mas aplicar cor, fonte e
  // congelamento de linha a cada envio criava diversas escritas extras sob a
  // mesma trava global. Em pico de acessos, isso fazia o submit ultrapassar o
  // timeout do navegador mesmo quando o palpite era gravado corretamente.
  if (BOLAO_WRITE_SHEETS_READY) return;

  const book = getBook_();
  ['Cadastros', 'Palpites'].forEach(function(name) {
    ensureSheetStructure_(book, name, BOLAO.SCHEMAS[name]);
  });
  BOLAO_WRITE_SHEETS_READY = true;
}

function ensureSheet_(book, name, headers) {
  const sheet = ensureSheetStructure_(book, name, headers);
  styleHeader_(sheet, headers.length);
  sheet.setFrozenRows(1);
  return sheet;
}

function ensureSheetStructure_(book, name, headers) {
  let sheet = book.getSheetByName(name);

  if (!sheet) {
    sheet = book.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sheet;
  }

  const width = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, width).getValues()[0].map(string_);
  const hasHeader = existing.some(function(value) { return value; });

  if (!hasHeader) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else if (!sameHeaders_(existing, headers)) {
    migrateSheetToSchema_(sheet, name, headers);
  }

  return sheet;
}

function sameHeaders_(current, expected) {
  const compact = current.filter(function(value) { return value; });
  if (compact.length !== expected.length) return false;
  return expected.every(function(header, index) {
    return compact[index] === header;
  });
}

function migrateSheetToSchema_(sheet, sheetName, headers) {
  const raw = sheet.getLastRow() >= 2
    ? sheet.getDataRange().getValues()
    : [sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0]];

  const oldHeaders = raw[0].map(string_);
  const records = raw.slice(1)
    .filter(function(row) {
      return row.some(function(cell) { return !isBlank_(cell); });
    })
    .map(function(row) {
      const object = {};
      oldHeaders.forEach(function(header, index) {
        object[header] = row[index];
      });
      return migrateRecord_(sheetName, object);
    })
    .filter(function(record) {
      if (sheetName === 'Cadastros') return !!(record.Email || record.Nome || record.ParticipantId);
      if (sheetName === 'Palpites') return !!record.GameId;
      return !!record.GameId;
    });

  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);

  if (records.length) {
    const values = records.map(function(record) {
      return headers.map(function(header) {
        return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '';
      });
    });
    sheet.getRange(2, 1, values.length, headers.length).setValues(values);
  }
}

function migrateRecord_(sheetName, row) {
  if (sheetName === 'Cadastros') {
    return {
      Email: normalizeEmail_(row.Email),
      Nome: string_(row.Nome),
      CriadoEm: row.CriadoEm || '',
      AtualizadoEm: row.AtualizadoEm || row.CriadoEm || '',
      ParticipantId: string_(row.ParticipantId) || (row.Email ? 'legacy:' + normalizeEmail_(row.Email) : '')
    };
  }

  if (sheetName === 'Palpites') {
    return {
      GameId: string_(row.GameId),
      Email: normalizeEmail_(row.Email),
      Nome: string_(row.Nome),
      PlacarBrasil: firstValue_(row.PlacarBrasil, row.PlacarCasa),
      PlacarNoruega: firstValue_(row.PlacarNoruega, row.PlacarFora),
      MinutoPrimeiroGol: firstValue_(row.MinutoPrimeiroGol, row.FaixaPrimeiroGol),
      Escanteios: normalizeRange_(firstValue_(row.Escanteios, ''), 'corners'),
      CartoesAmarelos: normalizeRange_(firstValue_(row.CartoesAmarelos, ''), 'yellowCards'),
      PosseBrasil: normalizePossession_(row.PosseBrasil),
      PosseNoruega: normalizePossession_(row.PosseNoruega),
      ResultadoIntervalo: normalizeHalfTime_(firstValue_(row.ResultadoIntervalo, row.VencedorPrimeiroTempo)),
      Impedimentos: normalizeRange_(firstValue_(row.Impedimentos, ''), 'offsides'),
      FinalizacoesBrasil: string_(row.FinalizacoesBrasil),
      FinalizacoesNoruega: string_(row.FinalizacoesNoruega),
      ArtilheiroPartida: string_(row.ArtilheiroPartida),
      VaiParaPenaltis: normalizeYesNo_(row.VaiParaPenaltis),
      PrimeiroGolBrasil: string_(row.PrimeiroGolBrasil),
      ProximoAdversarioBrasil: string_(row.ProximoAdversarioBrasil),
      CriadoEm: row.CriadoEm || '',
      AtualizadoEm: row.AtualizadoEm || row.CriadoEm || '',
      ParticipantId: string_(row.ParticipantId) || (row.Email ? 'legacy:' + normalizeEmail_(row.Email) : '')
    };
  }

  return {
    GameId: string_(row.GameId),
    PlacarBrasil: firstValue_(row.PlacarBrasil, row.PlacarCasa),
    PlacarNoruega: firstValue_(row.PlacarNoruega, row.PlacarFora),
    MinutoPrimeiroGol: firstValue_(row.MinutoPrimeiroGol, row.FaixaPrimeiroGol),
    Escanteios: normalizeRange_(firstValue_(row.Escanteios, ''), 'corners'),
    CartoesAmarelos: normalizeRange_(firstValue_(row.CartoesAmarelos, ''), 'yellowCards'),
    PosseBrasil: normalizePossession_(row.PosseBrasil),
    PosseNoruega: normalizePossession_(row.PosseNoruega),
    ResultadoIntervalo: normalizeHalfTime_(firstValue_(row.ResultadoIntervalo, row.VencedorPrimeiroTempo)),
    Impedimentos: normalizeRange_(firstValue_(row.Impedimentos, ''), 'offsides'),
    FinalizacoesBrasil: string_(row.FinalizacoesBrasil),
    FinalizacoesNoruega: string_(row.FinalizacoesNoruega),
    ArtilheiroPartida: string_(row.ArtilheiroPartida),
    VaiParaPenaltis: normalizeYesNo_(row.VaiParaPenaltis),
    PrimeiroGolBrasil: string_(row.PrimeiroGolBrasil),
    ProximoAdversarioBrasil: string_(row.ProximoAdversarioBrasil),
    Status: string_(row.Status || 'pendente'),
    AtualizadoEm: row.AtualizadoEm || ''
  };
}

function firstValue_() {
  for (let i = 0; i < arguments.length; i += 1) {
    if (!isBlank_(arguments[i])) return arguments[i];
  }
  return '';
}

function normalizeHalfTime_(value) {
  const text = normalizeSearch_(value);
  if (['casa', 'brasil', 'home'].indexOf(text) >= 0) return 'brasil';
  if (['fora', 'noruega', 'away'].indexOf(text) >= 0) return 'noruega';
  if (['empate', 'draw', 'tie'].indexOf(text) >= 0) return 'empate';
  return '';
}

function normalizePossession_(value) {
  const text = string_(value).trim();
  return BOLAO.OPTIONS.possession.indexOf(text) >= 0 ? text : '';
}

function normalizeYesNo_(value) {
  const text = normalizeSearch_(value);
  if (['sim', 'yes'].indexOf(text) >= 0) return 'Sim';
  if (['nao', 'não', 'no'].indexOf(text) >= 0) return 'Não';
  return '';
}

function normalizeRange_(value, type) {
  const text = string_(value).trim();
  const options = type === 'corners' ? BOLAO.OPTIONS.corners :
    type === 'yellowCards' ? BOLAO.OPTIONS.yellowCards :
    BOLAO.OPTIONS.offsides;

  if (options.indexOf(text) >= 0) return text;

  // Em colunas que estavam formatadas como data, "3-4" pode chegar como uma
  // data de 1900. Recuperamos tanto o padrão dia-mês quanto mês-dia antes de
  // usar o número serial como último recurso.
  const recoveredDateRange = rangeOptionFromDate_(value, options);
  if (recoveredDateRange) return recoveredDateRange;

  const numericText = isDateValue_(value) ? String(sportNumber_(value)) : text;
  if (!isInteger_(numericText)) return '';

  const numeric = number_(numericText);
  if (type === 'corners') return numeric <= 3 ? '0-3' : numeric <= 6 ? '4-6' : numeric <= 10 ? '7-10' : numeric <= 14 ? '11-14' : '15+';
  if (type === 'yellowCards') return numeric === 0 ? '0' : numeric <= 2 ? '1-2' : numeric <= 4 ? '3-4' : '5+';
  return numeric <= 1 ? '0-1' : numeric <= 3 ? '2-3' : numeric <= 5 ? '4-5' : '6+';
}

function rangeOptionFromDate_(value, options) {
  if (!isDateValue_(value)) return '';

  const parts = Utilities.formatDate(value, BOLAO.TZ, 'd-M').split('-').map(Number);
  if (parts.length !== 2 || !parts.every(function(part) { return Number.isFinite(part); })) return '';

  const direct = parts[0] + '-' + parts[1];
  const reversed = parts[1] + '-' + parts[0];
  if (options.indexOf(direct) >= 0) return direct;
  if (options.indexOf(reversed) >= 0) return reversed;
  return '';
}

function canonicalOptionValue_(value, options) {
  if (options === BOLAO.OPTIONS.corners) return normalizeRange_(value, 'corners');
  if (options === BOLAO.OPTIONS.yellowCards) return normalizeRange_(value, 'yellowCards');
  if (options === BOLAO.OPTIONS.offsides) return normalizeRange_(value, 'offsides');
  if (options === BOLAO.OPTIONS.possession) return normalizePossession_(value);
  if (options === BOLAO.OPTIONS.halfTime) return normalizeHalfTime_(value);
  if (options === BOLAO.OPTIONS.penalties) return normalizeYesNo_(value);
  return string_(value).trim();
}

function keepOnlyBrazilNorwayResult_() {
  const existing = rows_('Resultados').filter(function(row) {
    return string_(row.GameId) === BOLAO.GAME.gameId;
  })[0] || {};

  replaceRows_('Resultados', [{
    GameId: BOLAO.GAME.gameId,
    PlacarBrasil: existing.PlacarBrasil || '',
    PlacarNoruega: existing.PlacarNoruega || '',
    MinutoPrimeiroGol: existing.MinutoPrimeiroGol || '',
    Escanteios: existing.Escanteios || '',
    CartoesAmarelos: existing.CartoesAmarelos || '',
    PosseBrasil: existing.PosseBrasil || '',
    PosseNoruega: existing.PosseNoruega || '',
    ResultadoIntervalo: existing.ResultadoIntervalo || '',
    Impedimentos: existing.Impedimentos || '',
    FinalizacoesBrasil: existing.FinalizacoesBrasil || '',
    FinalizacoesNoruega: existing.FinalizacoesNoruega || '',
    ArtilheiroPartida: existing.ArtilheiroPartida || '',
    VaiParaPenaltis: existing.VaiParaPenaltis || '',
    PrimeiroGolBrasil: existing.PrimeiroGolBrasil || '',
    ProximoAdversarioBrasil: existing.ProximoAdversarioBrasil || '',
    Status: string_(existing.Status || 'pendente').toLowerCase(),
    AtualizadoEm: existing.AtualizadoEm || ''
  }]);
}

function deduplicateProfilesByEmail_() {
  const profiles = rows_('Cadastros');
  const predictions = rows_('Palpites');
  const groups = {};
  const withoutEmail = [];

  profiles.forEach(function(row) {
    const email = normalizeEmail_(row.Email);
    if (!email) {
      withoutEmail.push(row);
      return;
    }
    if (!groups[email]) groups[email] = [];
    groups[email].push(row);
  });

  const canonicalProfiles = withoutEmail.slice();
  const idMap = {};
  let removedProfiles = 0;

  Object.keys(groups).forEach(function(email) {
    const group = groups[email];
    const selected = latestProfile_(group);
    const canonicalId = participantIdFromRow_(selected) || newParticipantId_();
    const canonical = Object.assign({}, selected, {
      Email: email,
      Nome: string_(selected.Nome).trim(),
      ParticipantId: canonicalId,
      CriadoEm: selected.CriadoEm || selected.AtualizadoEm || nowIso_(),
      AtualizadoEm: selected.AtualizadoEm || selected.CriadoEm || nowIso_()
    });
    canonicalProfiles.push(canonical);

    group.forEach(function(row) {
      idMap[participantIdFromRow_(row)] = canonicalId;
    });
    removedProfiles += Math.max(0, group.length - 1);
  });

  let relinkedPredictions = 0;
  const normalizedPredictions = predictions.map(function(row) {
    const email = normalizeEmail_(row.Email);
    const previousId = participantIdFromRow_(row);
    const canonicalId = idMap[previousId] || (email && groups[email] ? participantIdFromRow_(latestProfile_(groups[email])) : previousId);
    if (canonicalId && canonicalId !== previousId) relinkedPredictions += 1;
    return Object.assign({}, row, { ParticipantId: canonicalId || previousId });
  });

  if (removedProfiles) {
    replaceRows_('Cadastros', canonicalProfiles);
    replaceRows_('Palpites', normalizedPredictions);
  }

  return { removedProfiles: removedProfiles, relinkedPredictions: relinkedPredictions };
}

// Mudanças feitas diretamente pela administração na planilha invalidam o cache.
// A próxima atualização automática do site passa a mostrar o novo dado sem republicação.
function onEdit(e) {
  try {
    const name = e && e.range && e.range.getSheet && e.range.getSheet().getName();
    if (['Cadastros', 'Palpites', 'Resultados'].indexOf(name) >= 0) markBaseChanged_('admin');
  } catch (_) {
    // Não interrompe a edição manual caso o cache esteja indisponível.
  }
}

function onAdminSheetChange_(e) {
  // Cobre inclusão/remoção de linhas e alterações estruturais feitas diretamente
  // pela administração, que nem sempre passam pelo onEdit simples.
  markBaseChanged_('admin');
}

function installAdminSyncTrigger_() {
  try {
    const book = getBook_();
    const hasTrigger = ScriptApp.getProjectTriggers().some(function(trigger) {
      return trigger.getHandlerFunction() === 'onAdminSheetChange_';
    });

    if (!hasTrigger) {
      ScriptApp.newTrigger('onAdminSheetChange_')
        .forSpreadsheet(book)
        .onChange()
        .create();
    }
  } catch (_) {
    // onEdit continua cobrindo as alterações de células mesmo sem o gatilho instalável.
  }
}

function removeLegacyGamesSheet_() {
  const book = getBook_();
  const legacy = book.getSheetByName('Jogos');
  if (legacy && book.getSheets().length > 1) book.deleteSheet(legacy);
}

function styleAllSheets_() {
  const cadastros = sheet_('Cadastros');
  const palpites = sheet_('Palpites');
  const resultados = sheet_('Resultados');

  styleHeader_(cadastros, BOLAO.SCHEMAS.Cadastros.length);
  styleHeader_(palpites, BOLAO.SCHEMAS.Palpites.length);
  styleHeader_(resultados, BOLAO.SCHEMAS.Resultados.length);
  repairDataFormats_();

  cadastros.setFrozenRows(1);
  palpites.setFrozenRows(1);
  resultados.setFrozenRows(1);

  cadastros.getRange('A:E').setVerticalAlignment('middle');
  palpites.getRange('A:U').setVerticalAlignment('middle');
  resultados.getRange('A:R').setVerticalAlignment('middle');

  cadastros.getRange('C:D').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  palpites.getRange('S:T').setNumberFormat('dd/MM/yyyy HH:mm:ss');
  resultados.getRange('R:R').setNumberFormat('dd/MM/yyyy HH:mm:ss');

  cadastros.setColumnWidths(1, 1, 240);
  cadastros.setColumnWidths(2, 1, 250);
  cadastros.setColumnWidths(3, 2, 165);
  cadastros.setColumnWidths(5, 1, 300);

  palpites.setColumnWidths(1, 1, 225);
  palpites.setColumnWidths(2, 1, 240);
  palpites.setColumnWidths(3, 1, 230);
  palpites.setColumnWidths(4, 2, 95);
  palpites.setColumnWidths(6, 7, 150);
  palpites.setColumnWidths(13, 2, 145);
  palpites.setColumnWidths(15, 3, 170);
  palpites.setColumnWidths(18, 1, 165);
  palpites.setColumnWidths(19, 2, 165);
  palpites.setColumnWidths(21, 1, 300);

  resultados.setColumnWidths(1, 1, 225);
  resultados.setColumnWidths(2, 2, 95);
  resultados.setColumnWidths(4, 7, 150);
  resultados.setColumnWidths(11, 2, 145);
  resultados.setColumnWidths(13, 3, 170);
  resultados.setColumnWidths(16, 1, 165);
  resultados.setColumnWidths(17, 1, 105);
  resultados.setColumnWidths(18, 1, 165);

  const validations = [
    ['MinutoPrimeiroGol', BOLAO.OPTIONS.minuteFirstGoal],
    ['Escanteios', BOLAO.OPTIONS.corners],
    ['CartoesAmarelos', BOLAO.OPTIONS.yellowCards],
    ['PosseBrasil', BOLAO.OPTIONS.possession],
    ['PosseNoruega', BOLAO.OPTIONS.possession],
    ['ResultadoIntervalo', BOLAO.OPTIONS.halfTime],
    ['Impedimentos', BOLAO.OPTIONS.offsides],
    ['ArtilheiroPartida', BOLAO.OPTIONS.topScorer],
    ['VaiParaPenaltis', BOLAO.OPTIONS.penalties],
    ['PrimeiroGolBrasil', BOLAO.OPTIONS.firstBrazilGoal],
    ['ProximoAdversarioBrasil', BOLAO.OPTIONS.nextBrazilOpponent]
  ];

  validations.forEach(function(item) {
    applyListValidation_(palpites, item[0], item[1]);
    applyListValidation_(resultados, item[0], item[1]);
  });
  applyListValidation_(resultados, 'Status', ['pendente', 'final']);
}

function repairDataFormats_() {
  Object.keys(BOLAO.SCHEMAS).forEach(function(sheetName) {
    const sheet = sheet_(sheetName);
    const headers = BOLAO.SCHEMAS[sheetName];
    const formatMap = columnFormatMap_(sheetName);
    const formatRow = headers.map(function(header) {
      return formatMap[header] || '@';
    });

    // A importação da base anterior trouxe algumas colunas de métrica como data.
    // Quando isso ocorre, um valor como 2 volta do Sheets como Date e vira o
    // timestamp negativo visto no formulário. Lemos primeiro os valores crus
    // (para recuperar intervalos como "3-4"), ajustamos os formatos e só então
    // gravamos a versão normalizada, sem apagar nenhum palpite.
    const lastRow = sheet.getLastRow();
    const original = lastRow >= 2
      ? sheet.getRange(2, 1, lastRow - 1, headers.length).getValues()
      : [];
    const height = Math.max(sheet.getMaxRows() - 1, 1);
    const formats = Array.from({ length: height }, function() {
      return formatRow.slice();
    });
    sheet.getRange(2, 1, height, headers.length).setNumberFormats(formats);
    repairStoredValues_(sheetName, sheet, headers, original);
  });
}

function repairStoredValues_(sheetName, sheet, headers, originalValues) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const range = sheet.getRange(2, 1, lastRow - 1, headers.length);
  const original = Array.isArray(originalValues) && originalValues.length
    ? originalValues
    : range.getValues();
  let changed = false;
  const repaired = original.map(function(row) {
    return row.map(function(value, column) {
      const fixed = repairStoredValue_(sheetName, headers[column], value);
      if (!sameCellValue_(value, fixed)) changed = true;
      return fixed;
    });
  });

  if (changed) range.setValues(repaired);
}

function repairStoredValue_(sheetName, header, value) {
  if (isBlank_(value)) return value;

  if (header === 'PlacarBrasil' || header === 'PlacarNoruega' ||
      header === 'FinalizacoesBrasil' || header === 'FinalizacoesNoruega') {
    return sportNumber_(value);
  }

  let normalized = '';
  if (header === 'Escanteios') normalized = normalizeRange_(value, 'corners');
  else if (header === 'CartoesAmarelos') normalized = normalizeRange_(value, 'yellowCards');
  else if (header === 'Impedimentos') normalized = normalizeRange_(value, 'offsides');
  else if (header === 'PosseBrasil' || header === 'PosseNoruega') normalized = normalizePossession_(value);
  else if (header === 'ResultadoIntervalo') normalized = normalizeHalfTime_(value);
  else if (header === 'VaiParaPenaltis') normalized = normalizeYesNo_(value);

  // Nunca zere uma informação só porque ela veio de uma versão antiga com
  // formato inesperado. Se não houver uma conversão segura, o valor original
  // permanece preservado para revisão manual.
  return normalized || value;
}

function sameCellValue_(left, right) {
  if (isDateValue_(left) || isDateValue_(right)) {
    return isDateValue_(left) && isDateValue_(right) && left.getTime() === right.getTime();
  }
  return left === right;
}

function columnFormatMap_(sheetName) {
  const timestamps = {
    Cadastros: ['CriadoEm', 'AtualizadoEm'],
    Palpites: ['CriadoEm', 'AtualizadoEm'],
    Resultados: ['AtualizadoEm']
  };

  const numeric = {
    Cadastros: [],
    Palpites: ['PlacarBrasil', 'PlacarNoruega', 'FinalizacoesBrasil', 'FinalizacoesNoruega'],
    Resultados: ['PlacarBrasil', 'PlacarNoruega', 'FinalizacoesBrasil', 'FinalizacoesNoruega']
  };

  const map = {};
  (timestamps[sheetName] || []).forEach(function(header) {
    map[header] = 'dd/MM/yyyy HH:mm:ss';
  });
  (numeric[sheetName] || []).forEach(function(header) {
    map[header] = '0';
  });
  return map;
}

function applyListValidation_(sheet, header, values) {
  const column = headerIndex_(sheet, header);
  if (column < 1) return;

  const range = sheet.getRange(2, column, Math.max(sheet.getMaxRows() - 1, 1), 1);
  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(false)
    .build();

  range.setDataValidation(rule);
}

function headerIndex_(sheet, header) {
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(string_);
  return headers.indexOf(header) + 1;
}

function styleHeader_(sheet, width) {
  sheet.getRange(1, 1, 1, width)
    .setFontWeight('bold')
    .setBackground('#063822')
    .setFontColor('#ffffff')
    .setHorizontalAlignment('center')
    .setVerticalAlignment('middle');
}

/* =============================== LEITURA E ESCRITA =============================== */

function getBook_() {
  if (BOLAO_BOOK) return BOLAO_BOOK;

  const id = scriptProperty_('SPREADSHEET_ID');
  if (!id) throw new Error('A base ainda não foi configurada. Abra a planilha e execute setup() uma vez.');

  BOLAO_BOOK = SpreadsheetApp.openById(id);
  return BOLAO_BOOK;
}

function sheet_(name) {
  const sheet = getBook_().getSheetByName(name);
  if (!sheet) throw new Error('Aba "' + name + '" não encontrada. Execute setup() na planilha.');
  return sheet;
}

function activateSheet_(name) {
  const sheet = sheet_(name);
  getBook_().setActiveSheet(sheet);
}

function rows_(sheetName) {
  const sheet = sheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const width = sheet.getLastColumn();
  const values = sheet.getRange(1, 1, lastRow, width).getValues();
  const headers = values[0].map(string_);

  return values.slice(1)
    .filter(function(row) {
      return row.some(function(cell) { return !isBlank_(cell); });
    })
    .map(function(row) {
      const item = {};
      headers.forEach(function(header, index) {
        item[header] = row[index];
      });
      return item;
    });
}

function append_(sheetName, object) {
  const sheet = sheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(string_);
  const values = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '';
  });

  sheet.getRange(sheet.getLastRow() + 1, 1, 1, headers.length).setValues([values]);
}

function fastAppend_(sheetName, object) {
  const sheet = sheet_(sheetName);
  const headers = BOLAO.SCHEMAS[sheetName] || sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(string_);
  const values = headers.map(function(header) {
    return Object.prototype.hasOwnProperty.call(object, header) ? object[header] : '';
  });

  // appendRow evita a dupla leitura getLastRow + setValues e é a operação mais
  // adequada para muitos cadastros simultâneos.
  sheet.appendRow(values);
}

function replaceRows_(sheetName, records) {
  const sheet = sheet_(sheetName);
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(string_);

  if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
  if (!records.length) return;

  const values = records.map(function(record) {
    return headers.map(function(header) {
      return Object.prototype.hasOwnProperty.call(record, header) ? record[header] : '';
    });
  });

  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

function updateRowsWhere_(sheetName, predicate, transform) {
  const sheet = sheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const width = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, width).getValues()[0].map(string_);
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const changes = [];

  values.forEach(function(valuesRow, index) {
    const row = {};
    headers.forEach(function(header, column) {
      row[header] = valuesRow[column];
    });

    if (!predicate(row)) return;

    const next = transform(row) || row;
    changes.push({
      rowNumber: index + 2,
      values: headers.map(function(header, column) {
        return Object.prototype.hasOwnProperty.call(next, header) ? next[header] : valuesRow[column];
      })
    });
  });

  changes.forEach(function(change) {
    sheet.getRange(change.rowNumber, 1, 1, width).setValues([change.values]);
  });

  return changes.length;
}

function deleteRowsWhere_(sheetName, predicate) {
  const sheet = sheet_(sheetName);
  const rows = rows_(sheetName);
  const toDelete = [];

  rows.forEach(function(row, index) {
    if (predicate(row)) toDelete.push(index + 2);
  });

  deleteRowNumbers_(sheet, toDelete);
  return toDelete.length;
}

function deleteRowNumbers_(sheet, rowNumbers) {
  if (!rowNumbers || !rowNumbers.length) return;

  const ordered = rowNumbers.slice().sort(function(a, b) { return a - b; });
  const ranges = [];
  let start = ordered[0];
  let end = ordered[0];

  ordered.slice(1).forEach(function(row) {
    if (row === end + 1) {
      end = row;
      return;
    }
    ranges.push([start, end - start + 1]);
    start = row;
    end = row;
  });

  ranges.push([start, end - start + 1]);
  ranges.reverse().forEach(function(range) {
    sheet.deleteRows(range[0], range[1]);
  });
}

/* =============================== IDENTIDADE =============================== */

function newParticipantId_() {
  return 'p_' + Utilities.getUuid().replace(/-/g, '');
}

function participantIdFromRow_(row) {
  const explicit = string_(row && row.ParticipantId).trim();
  if (explicit) return explicit;

  const email = normalizeEmail_(row && row.Email);
  return email ? 'legacy:' + email : '';
}

function normalizeEmailList_(values) {
  const list = Array.isArray(values) ? values : [values];
  const seen = {};

  return list.map(function(value) {
    return normalizeEmail_(value);
  }).filter(function(value) {
    if (!value || seen[value]) return false;
    seen[value] = true;
    return true;
  });
}

function participantMatches_(row, participantId, aliases) {
  const rowId = participantIdFromRow_(row);
  const rowEmail = normalizeEmail_(row && row.Email);
  const id = string_(participantId).trim();
  const allowedEmails = normalizeEmailList_(aliases || []);

  if (id && rowId === id) return true;
  return allowedEmails.indexOf(rowEmail) >= 0;
}

function findProfileByIdentity_(profiles, participantId, email, aliases) {
  const allAliases = normalizeEmailList_([email].concat(aliases || []));
  const id = string_(participantId).trim();

  if (id) {
    const byId = profiles.filter(function(row) {
      return participantIdFromRow_(row) === id;
    });
    const latestById = latestProfile_(byId);
    if (latestById) return latestById;
  }

  // O e-mail é um caminho de recuperação quando não há ParticipantId reconhecido.
  // Caso existam cadastros antigos com o mesmo e-mail, devolvemos o mais recente.
  return latestProfile_(profiles.filter(function(row) {
    return allAliases.indexOf(normalizeEmail_(row.Email)) >= 0;
  }));
}

function latestProfile_(profiles) {
  return (profiles || []).reduce(function(current, row) {
    if (!current) return row;
    const currentTime = toEpoch_(current.AtualizadoEm || current.CriadoEm);
    const rowTime = toEpoch_(row.AtualizadoEm || row.CriadoEm);
    return rowTime >= currentTime ? row : current;
  }, null);
}

function uniqueProfiles_(profiles) {
  const byIdentity = {};

  profiles.forEach(function(row) {
    const email = normalizeEmail_(row.Email);
    const identity = email || participantIdFromRow_(row);
    if (!identity) return;

    const current = byIdentity[identity];
    if (!current || toEpoch_(row.AtualizadoEm || row.CriadoEm) >= toEpoch_(current.AtualizadoEm || current.CriadoEm)) {
      byIdentity[identity] = row;
    }
  });

  return Object.keys(byIdentity).map(function(identity) {
    return byIdentity[identity];
  });
}

function latestPredictionsForGame_(predictions) {
  const byIdentity = {};

  predictions.filter(function(row) {
    return string_(row.GameId) === BOLAO.GAME.gameId;
  }).forEach(function(row) {
    const email = normalizeEmail_(row.Email);
    const identity = email || participantIdFromRow_(row);
    if (!identity) return;

    const current = byIdentity[identity];
    if (!current || toEpoch_(row.AtualizadoEm || row.CriadoEm) >= toEpoch_(current.AtualizadoEm || current.CriadoEm)) {
      byIdentity[identity] = row;
    }
  });

  return Object.keys(byIdentity).map(function(identity) {
    return byIdentity[identity];
  });
}

function predictionForParticipant_(predictions, participantId, aliases) {
  // Para uma identidade específica não é necessário montar o mapa de todos os
  // palpites. A busca direta reduz trabalho em cada leitura do site.
  return (predictions || []).reduce(function(latest, row) {
    if (string_(row.GameId) !== BOLAO.GAME.gameId) return latest;
    if (!participantMatches_(row, participantId, aliases)) return latest;
    if (!latest) return row;

    const latestTime = toEpoch_(latest.AtualizadoEm || latest.CriadoEm);
    const rowTime = toEpoch_(row.AtualizadoEm || row.CriadoEm);
    return rowTime >= latestTime ? row : latest;
  }, null);
}

/* =============================== UTILITÁRIOS =============================== */

function output_(payload, callbackName) {
  const text = JSON.stringify(payload);
  const output = callbackName
    ? sanitizeCallback_(callbackName) + '(' + text + ');'
    : text;

  return ContentService.createTextOutput(output).setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function sanitizeCallback_(value) {
  return string_(value).replace(/[^a-zA-Z0-9_$\.]/g, '');
}

function postPayload_(event) {
  const raw = event && event.parameter && event.parameter.payload
    ? event.parameter.payload
    : event && event.postData && event.postData.contents
      ? event.postData.contents
      : '{}';

  try {
    return JSON.parse(raw || '{}');
  } catch (_) {
    throw new Error('Não foi possível ler os dados enviados.');
  }
}

function verifyAccess_(payload) {
  const expected = string_(scriptProperty_('ACCESS_CODE')).trim();
  if (expected && string_(payload.accessCode).trim() !== expected) {
    throw new Error('Código de acesso inválido.');
  }
}

function isAllowedEmail_(email) {
  const normalized = normalizeEmail_(email);
  const domain = normalized.split('@')[1] || '';
  return domain === BOLAO.ALLOWED_EMAIL_DOMAIN;
}

function withWriteLock_(callback) {
  const lock = LockService.getScriptLock();
  // Não deixe a pessoa presa em uma fila de gravação. A interface preserva a
  // requestId e confirma/reenvia de forma idempotente, então a fila responde
  // rapidamente como "ocupada" em vez de somar até 5 segundos por tentativa.
  if (!lock.tryLock(1200)) {
    throw new Error('A base está ocupada por outro envio. Tente novamente em instantes.');
  }

  try {
    return callback();
  } finally {
    lock.releaseLock();
  }
}

function readCacheJson_(key) {
  try {
    const raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeCacheJson_(key, value, ttlSeconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), ttlSeconds);
  } catch (_) {
    // Cache não é obrigatório para o funcionamento.
  }
}

function clearPublicCache_() {
  try {
    const rowKeys = Object.keys(BOLAO.CACHE.ROWS_KEYS).map(function(sheetName) {
      return BOLAO.CACHE.ROWS_KEYS[sheetName];
    });

    CacheService.getScriptCache().removeAll(rowKeys.concat([
      'bolao_rows_cadastros_br_noruega_v9',
      'bolao_rows_palpites_br_noruega_v9',
      'bolao_rows_resultados_br_noruega_v9',
      'bolao_participation_br_noruega_v9',
      'bolao_participation_br_noruega_v11',
      'bolao_participation_br_noruega_v13',
      'bolao_rows_cadastros_br_noruega_v13',
      'bolao_rows_palpites_br_noruega_v13',
      'bolao_rows_resultados_br_noruega_v13',
      'bolao-public-br-noruega-v9'
    ]));
  } catch (_) {
    // O app continua funcionando mesmo sem cache.
  }
}

function dataVersion_() {
  return scriptProperty_('BOLAO_DATA_VERSION') || 'base-inicial';
}

function adminVersion_() {
  return scriptProperty_('BOLAO_ADMIN_VERSION') || 'admin-inicial';
}

function markBaseChanged_(source) {
  const version = String(Date.now()) + '_' + Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  const properties = PropertiesService.getScriptProperties();
  properties.setProperty('BOLAO_DATA_VERSION', version);
  if (source === 'admin') properties.setProperty('BOLAO_ADMIN_VERSION', version);
  clearPublicCache_();
  return version;
}

function clearSheetData_(sheetName) {
  const sheet = sheet_(sheetName);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const width = Math.max(sheet.getLastColumn(), BOLAO.SCHEMAS[sheetName].length);
  const values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const count = values.filter(function(row) {
    return row.some(function(cell) { return !isBlank_(cell); });
  }).length;

  // Mantém cabeçalhos, validações e formato da planilha. Apenas os registros são limpos.
  sheet.getRange(2, 1, lastRow - 1, width).clearContent();
  return count;
}

function scriptProperty_(name) {
  return PropertiesService.getScriptProperties().getProperty(name) || '';
}

function normalizeEmail_(value) {
  return string_(value).trim().toLowerCase();
}

function normalizeSearch_(value) {
  return string_(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isValidEmail_(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(string_(value));
}

function string_(value) {
  return value === null || value === undefined ? '' : String(value);
}

function number_(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isDateValue_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !Number.isNaN(value.getTime());
}

function sportNumber_(value) {
  // Corrige registros antigos gravados quando uma coluna numérica estava
  // formatada como data no Google Sheets. Por exemplo, o valor 2 foi lido como
  // 01/01/1900 e convertido para um timestamp negativo no JSON público.
  if (isDateValue_(value)) {
    const dateText = Utilities.formatDate(value, BOLAO.TZ, 'yyyy-MM-dd');
    const parts = dateText.split('-').map(Number);
    if (parts.length === 3 && parts.every(function(part) { return Number.isFinite(part); })) {
      const serial = Math.round(
        (Date.UTC(parts[0], parts[1] - 1, parts[2]) - Date.UTC(1899, 11, 30)) /
        (24 * 60 * 60 * 1000)
      );
      return Number.isFinite(serial) ? serial : 0;
    }
  }
  return number_(value);
}

function isInteger_(value) {
  return /^\d+$/.test(string_(value).trim());
}

function isBlank_(value) {
  return value === '' || value === null || value === undefined;
}

function isTruthy_(value) {
  return ['1', 'true', 'sim', 'yes'].indexOf(normalizeSearch_(value)) >= 0;
}

function nowIso_() {
  return new Date().toISOString();
}

function iso_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? string_(value) : date.toISOString();
}

function toEpoch_(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function dateLabel_(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return string_(value);
  return Utilities.formatDate(date, BOLAO.TZ, 'dd/MM/yyyy HH:mm');
}
