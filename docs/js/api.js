/*
 * Cliente do Apps Script.
 * O site usa JSONP porque pode ser publicado fora do Google Apps Script.
 *
 * Escritas são idempotentes por requestId. Quando a resposta demora, o cliente
 * confirma o recibo da mesma requisição antes de tentar de novo, sem perder o
 * palpite nem gerar duplicidade.
 */
(function () {
  const C = window.BOLAO_CONFIG || {};

  function configured() {
    const url = String(C.apiUrl || '').trim();
    return Boolean(url && !url.includes('COLE_AQUI'));
  }

  function cleanEmail(value) {
    return String(value || '').trim().toLowerCase();
  }

  function newRequestId() {
    const uuid = window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return `r_${uuid}`;
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function requestError(message, code) {
    const error = new Error(message);
    error.code = code || 'request';
    return error;
  }

  function jsonpOnce(action, params, timeoutOverride) {
    return new Promise((resolve, reject) => {
      const callback = `bolao_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
      const timeoutMs = Math.max(4500, Number(timeoutOverride || C.requestTimeoutMs || 9000));
      let done = false;

      function clean() {
        clearTimeout(timeout);
        try { delete window[callback]; } catch (_) { window[callback] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      function fail(message, code) {
        if (done) return;
        done = true;
        clean();
        reject(requestError(message, code));
      }

      const timeout = window.setTimeout(() => {
        fail('A confirmação demorou mais do que o esperado.', 'timeout');
      }, timeoutMs);

      window[callback] = (response) => {
        if (done) return;
        done = true;
        clean();
        if (response && response.ok) {
          resolve(response.data);
        } else {
          reject(requestError(
            (response && response.error) || 'Não foi possível concluir agora. Tente novamente.',
            'server'
          ));
        }
      };

      script.async = true;
      script.onerror = () => fail('Não foi possível conectar ao Bolão OAZ. Tente novamente.', 'network');

      const query = new URLSearchParams({
        action,
        prefix: callback,
        _: String(Date.now()),
        ...(params || {})
      });

      script.src = `${C.apiUrl}?${query.toString()}`;
      document.head.appendChild(script);
    });
  }

  async function getState(gameId, email, participantId, options = {}) {
    if (!configured()) throw new Error('A conexão do Bolão OAZ ainda não está pronta.');

    const retries = Math.max(0, Number(C.readRetries ?? 0));
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await jsonpOnce('state', {
          gameId: gameId || '',
          email: cleanEmail(email),
          participantId: String(participantId || '').trim(),
          fresh: options.fresh ? '1' : ''
        }, C.requestTimeoutMs || 9000);
      } catch (error) {
        lastError = error;
        if (attempt < retries) await wait(700 * (attempt + 1));
      }
    }

    throw lastError || new Error('Não foi possível carregar o Bolão OAZ.');
  }

  function receiptParams(data) {
    return {
      requestId: String(data?.requestId || ''),
      writeAction: String(data?.action || ''),
      email: cleanEmail(data?.email),
      participantId: String(data?.participantId || '').trim()
    };
  }

  async function confirmWrite(data, options = {}) {
    // A primeira consulta é intencionalmente leve: ela lê somente o recibo
    // publicado após a gravação terminar, sem disputar acesso à planilha
    // enquanto a escrita original ainda está em andamento.
    const attempts = Math.max(1, Number(options.attempts ?? C.receiptPollAttempts ?? 4));
    const intervalMs = Math.max(250, Number(options.intervalMs ?? C.receiptPollIntervalMs ?? 650));
    const timeoutMs = Math.max(3500, Number(options.timeoutMs ?? C.receiptTimeoutMs ?? 5000));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const receipt = await jsonpOnce('receipt', {
          ...receiptParams(data),
          // Só no último ciclo é permitido conferir a planilha. No caminho
          // normal, o recibo fica em cache e não disputa acesso com a escrita.
          fallback: attempt === attempts - 1 ? '1' : ''
        }, timeoutMs);
        if (receipt?.confirmed && receipt?.data) return receipt.data;
      } catch (_) {
        // Uma consulta de recibo pode falhar enquanto o Apps Script inicia.
        // As próximas tentativas usam a mesma requestId e não reenviam dados.
      }

      if (attempt < attempts - 1) {
        await wait(intervalMs * (attempt + 1));
      }
    }

    return null;
  }

  function isRetryableWriteError(error) {
    const message = String(error?.message || '');
    return error?.code === 'timeout' ||
      error?.code === 'network' ||
      /base está ocupada|ocupada por outro envio|temporariamente indisponível/i.test(message);
  }

  async function post(payload) {
    if (!configured()) throw new Error('A conexão do Bolão OAZ ainda não está pronta.');

    const data = {
      ...(payload || {}),
      accessCode: C.accessCode || '',
      requestId: String(payload?.requestId || newRequestId())
    };

    const writeTimeoutMs = Math.max(6500, Number(C.writeRequestTimeoutMs || 10000));
    const attempts = Math.max(1, Number(C.writeAttempts || 2));
    let lastError;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await jsonpOnce(data.action, {
          payload: JSON.stringify(data)
        }, writeTimeoutMs);
      } catch (error) {
        lastError = error;

        // A escrita pode já estar concluída, mas a resposta JSONP ter se perdido.
        // Confirma antes de qualquer nova tentativa para preservar idempotência.
        const confirmed = await confirmWrite(data);
        if (confirmed) return confirmed;

        if (!isRetryableWriteError(error) || attempt === attempts - 1) break;
        await wait(700 * (attempt + 1));
      }
    }

    throw lastError || new Error('Não foi possível confirmar o envio agora.');
  }

  window.BolaoAPI = {
    configured,
    getState,
    post,
    confirmWrite,
    cleanEmail,
    newRequestId,
    isRetryableWriteError
  };
})();
