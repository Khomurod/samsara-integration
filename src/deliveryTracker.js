/**
 * deliveryTracker.js
 *
 * Durable, per-(event, target) delivery tracking + Telegram error
 * classification. This is the core of the "never send a duplicate" guarantee.
 *
 * The tracker is a thin wrapper over the DB layer (db.getEventDeliveries /
 * db.recordEventDelivery) so it can be exercised with a fake DB in tests and
 * so the delivery logic never touches SQL directly.
 */

/**
 * Classify a Telegram (or network) error into a retry policy.
 *
 *   'permanent'  → do NOT retry, do NOT block the event. The target can never
 *                  receive this message right now (chat not found, bad request,
 *                  bot blocked/kicked/not a member).
 *   'transient'  → safe to retry (429 rate limit, 5xx, network/timeout, or any
 *                  unknown error — we default to retrying rather than dropping).
 *
 * @param {*} err
 * @returns {'permanent'|'transient'}
 */
function classifyTelegramError(err) {
  const code = err?.response?.body?.error_code ?? err?.response?.statusCode ?? err?.code;
  const description = String(err?.response?.body?.description || err?.message || '').toLowerCase();

  // ── Permanent: no point retrying, must not block sibling targets ──
  if (code === 400 || code === 403) return 'permanent';
  if (description.includes('chat not found')) return 'permanent';
  if (description.includes('bad request')) return 'permanent';
  if (description.includes('bot was blocked')) return 'permanent';
  if (description.includes('bot was kicked')) return 'permanent';
  if (description.includes('bot is not a member')) return 'permanent';
  if (description.includes('not a member')) return 'permanent';
  if (description.includes('forbidden')) return 'permanent';
  if (description.includes('user is deactivated')) return 'permanent';

  // ── Transient: retry is safe ──
  if (code === 429) return 'transient';
  if (typeof code === 'number' && code >= 500 && code < 600) return 'transient';

  // Unknown / network / timeout → treat as transient (retry rather than drop).
  return 'transient';
}

/**
 * Build a delivery tracker bound to a DB module.
 * @param {{ getEventDeliveries: Function, recordEventDelivery: Function }} db
 */
function createDeliveryTracker(db) {
  return {
    /**
     * Load the current per-target ledger for an event.
     * @param {string} eventId
     * @returns {Promise<Map<string, string>>} target_chat_id → status
     */
    async getTargetStatuses(eventId) {
      const map = new Map();
      if (!eventId || !db || typeof db.getEventDeliveries !== 'function') return map;
      const rows = await db.getEventDeliveries(eventId);
      for (const row of rows || []) {
        if (row && row.target_chat_id != null) {
          map.set(String(row.target_chat_id), String(row.status));
        }
      }
      return map;
    },

    /** Record that a target successfully received the event. */
    async recordSuccess(eventId, targetChatId) {
      if (!eventId || !db || typeof db.recordEventDelivery !== 'function') return;
      await db.recordEventDelivery(eventId, String(targetChatId), 'delivered');
    },

    /** Record that a target can never receive the event (permanent failure). */
    async recordPermanentSkip(eventId, targetChatId) {
      if (!eventId || !db || typeof db.recordEventDelivery !== 'function') return;
      await db.recordEventDelivery(eventId, String(targetChatId), 'permanent');
    },
  };
}

module.exports = {
  classifyTelegramError,
  createDeliveryTracker,
};
