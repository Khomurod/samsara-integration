/**
 * driverGroupSwitch.js
 *
 * Whether an alert may ALSO be posted into one driver's own Telegram group.
 *
 * The switch is `groups.samsara_driver_alerts_enabled`, written by bot-backend
 * (Wenze → Driver Groups → driver details; bot-backend migration 0090). Like
 * the routing itself, it is read from the shared database at the moment of
 * sending, so a change applies from the very next alert — no restart, no cache.
 *
 * It governs ONLY the driver-group copy. The "Samsara Notifications" group,
 * every subscriber, the safety-event record and the routing are decided
 * elsewhere and never read it.
 *
 *   true   → post to the driver group, exactly as before the switch existed
 *   false  → somebody switched this group off: do not post there
 *   throws → the database could not answer. The caller must not guess in
 *            either direction: posting would override a person's "off", and
 *            skipping would drop a driver's alert silently.
 *
 * A database that does not have the column yet (the service deployed before
 * bot-backend's migration ran) reads as ON — that is today's behaviour, and it
 * is what keeps this service from going quiet on a deploy-order accident. So
 * does a row that is no longer there: routing found the group a moment ago.
 */
const UNDEFINED_COLUMN = '42703';

let warnedMissingColumn = false;

function defaultPool() {
  return require('./db').getPgPool();
}

/**
 * @param {{groupId?: number|string|null, telegramGroupId?: number|string|null}} target
 *   `groups.id` when the caller has it (the immediate send), otherwise the chat
 *   id a sent message carries (the video recovery).
 * @param {{query: Function}|null} [pool]
 * @returns {Promise<boolean>}
 */
async function isDriverGroupAlertsEnabled({ groupId = null, telegramGroupId = null } = {}, pool = defaultPool()) {
  if (!pool) return true;
  const id = groupId == null ? '' : String(groupId).trim();
  const chat = telegramGroupId == null ? '' : String(telegramGroupId).trim();
  if (!id && !chat) return true;

  try {
    const res = id
      ? await pool.query('SELECT samsara_driver_alerts_enabled FROM groups WHERE id = $1', [id])
      : await pool.query(
        'SELECT samsara_driver_alerts_enabled FROM groups WHERE telegram_group_id::text = $1',
        [chat],
      );
    if (!res.rows.length) return true;
    return res.rows[0].samsara_driver_alerts_enabled !== false;
  } catch (err) {
    if (err && err.code === UNDEFINED_COLUMN) {
      if (!warnedMissingColumn) {
        warnedMissingColumn = true;
        console.warn(
          '[DriverGroupSwitch] groups.samsara_driver_alerts_enabled does not exist yet '
          + '(bot-backend migration 0090 has not run) — every driver group is treated as ON.',
        );
      }
      return true;
    }
    throw err;
  }
}

/**
 * Sort a recovery's waiting messages by the switch, before a video is folded
 * into them (src/videoRecoveryWorker.js).
 *
 * A driver group switched off AFTER its alert went out gets no recovered video:
 * the video is a new post into that chat. Its text alert stays where it is.
 *
 *   send    → post the video here, as before
 *   dropped → switched off: done with, never retried
 *   held    → the switch could not be read: keep it for the next attempt
 *
 * Only `botKind: 'driver'` messages are looked at. Every other destination goes
 * to `send` untouched.
 */
async function sortTargetsBySwitch(targets, isEnabled, log = console) {
  const send = [];
  const dropped = [];
  const held = [];
  for (const ref of Array.isArray(targets) ? targets : []) {
    if (ref?.botKind !== 'driver') {
      send.push(ref);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      if (await isEnabled({ telegramGroupId: ref.chatId }) === false) {
        dropped.push(ref);
        log.log?.(`[VideoRecovery] driver group ${ref.chatId} has Samsara alerts switched off - no recovered video posted there`);
      } else {
        send.push(ref);
      }
    } catch (err) {
      held.push(ref);
      log.warn?.(`[VideoRecovery] could not read the Samsara switch for driver group ${ref.chatId}: ${err.message}`);
    }
  }
  return { send, dropped, held };
}

module.exports = {
  isDriverGroupAlertsEnabled,
  sortTargetsBySwitch,
  _forTest: { resetWarning: () => { warnedMissingColumn = false; } },
};
