/* Conexão do site com a base Google Sheets via Apps Script. */
window.BOLAO_CONFIG = {
  apiUrl: 'https://script.google.com/macros/s/AKfycbwmWz7wwl22droTZPiyf8vd7oqFXlTZtB0IHVyWq1oY5L9ZPiUfcCmsx4H-DK8LTD4Y/exec',
  accessCode: '',

  // Leituras periódicas usam o cache curto da base; alterações administrativas
  // limpam esse cache e aparecem automaticamente na próxima atualização.
  participantsPollSeconds: 10,
  pollSeconds: 20,

  // O botão responde rápido. Em caso de oscilação, a mesma requestId é
  // confirmada em segundo plano sem travar a pessoa em um modal.
  requestTimeoutMs: 6000,
  writeRequestTimeoutMs: 7000,
  receiptTimeoutMs: 2800,
  receiptPollAttempts: 2,
  receiptPollIntervalMs: 450,
  writeAttempts: 1,
  readRetries: 0
};
