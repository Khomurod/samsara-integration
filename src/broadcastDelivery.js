/**
 * broadcastDelivery.js
 *
 * Idempotent, per-target delivery of a single formatted alert.
 *
 * Every target (each notification subscriber, the hardcoded "Samsara
 * Notifications" group, and the matched driver group) is tracked individually
 * in a durable Postgres ledger keyed by (event_id, target_chat_id). Before
 * sending to a target we check the ledger and SKIP anything already delivered
 * or permanently failed. After a successful send we record it.
 *
 * The function only asks its caller to retry (by throwing) when at least one
 * TRANSIENT failure remains on a not-yet-succeeded target. A PERMANENT failure
 * (e.g. the notifications group's "chat not found") never triggers a retry, so
 * an already-delivered driver group can never be re-sent. This is what fixes
 * the production duplicate bug.
 *
 * All external collaborators are injected via `deps` so the whole thing is
 * unit-testable with fakes and no real network.
 */

/**
 * Send one notification-style message (video → single video → text fallbacks)
 * to a chat via the notification bot. Returns metadata about the sent message
 * (for later edits) or throws the underlying Telegram error if even the text
 * send fails.
 */
async function sendNotificationToTarget(bot, chatId, alert, log) {
  const { text, videoUrl, inwardVideoUrl, getVideoBuffer } = alert;

  if (videoUrl && inwardVideoUrl) {
    try {
      const [forwardBuf, inwardBuf] = await Promise.all([
        getVideoBuffer(videoUrl),
        getVideoBuffer(inwardVideoUrl),
      ]);
      const mediaMessages = await bot.sendMediaGroup(chatId, [
        { type: 'video', media: 'attach://forward', caption: text, parse_mode: 'HTML' },
        { type: 'video', media: 'attach://inward' },
      ], {}, {
        forward: { value: forwardBuf, options: { filename: 'forward.mp4', contentType: 'video/mp4' } },
        inward: { value: inwardBuf, options: { filename: 'inward.mp4', contentType: 'video/mp4' } },
      });
      const messageId = Array.isArray(mediaMessages) ? mediaMessages[0]?.message_id : undefined;
      return { type: 'caption', messageId };
    } catch (dualErr) {
      log.error('[Bot] Dual camera send failed, trying single video fallback:', dualErr.message);
    }
  }

  if (videoUrl) {
    try {
      const buffer = await getVideoBuffer(videoUrl);
      const sentVideo = await bot.sendVideo(chatId, buffer, {
        caption: text,
        parse_mode: 'HTML',
      }, {
        filename: 'event.mp4',
        contentType: 'video/mp4',
      });
      return { type: 'caption', messageId: sentVideo?.message_id };
    } catch (videoErr) {
      log.error('[Bot] Video send failed, falling back to text:', videoErr.message);
    }
  }

  const sentMessage = await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  return { type: 'text', messageId: sentMessage?.message_id };
}

/**
 * Deliver a formatted alert to every target, idempotently.
 * @param {Object|string} alertData
 * @param {Object} deps injected collaborators (see index.js for the wiring)
 */
async function deliverEvent(alertData, deps) {
  const {
    bot,
    driverBot,
    store,
    determineTargetGroup,
    resolveDriverCaption,
    sendDriverGroupAlert,
    isDriverMembershipAccessError,
    appendDriverMissingNote,
    tracker,
    classifyTelegramError,
    forcedId,
    managementGroupId,
    getVideoBuffer,
    // Optional DRIVER-GROUP-only video transform (music overlay). When present it
    // is handed to sendDriverGroupAlert and applied to the driver group's video
    // copy only. The notifications group / subscribers path never receives it.
    prepareDriverVideo = null,
    log = console,
  } = deps;

  const text = typeof alertData === 'string' ? alertData : alertData.text;
  const videoUrl = typeof alertData === 'string' ? null : alertData.videoUrl;
  const inwardVideoUrl = typeof alertData === 'string' ? null : alertData.inwardVideoUrl;
  const eventId = typeof alertData === 'string' ? null : alertData.samsaraEventId;
  const alertObj = typeof alertData === 'string' ? {} : alertData;
  // Speeding events are tagged by the speeding poller; the music overlay is
  // scoped to speeding events only.
  const isSpeeding = typeof alertData === 'string' ? false : alertData.isSpeeding === true;

  // Durable per-target ledger for this event (empty when no eventId / no DB).
  const statuses = await tracker.getTargetStatuses(eventId);
  const statusOf = (target) => statuses.get(String(target));
  const alreadyDelivered = (target) => statusOf(target) === 'delivered';
  // A target is "settled" once it has either been delivered or permanently
  // failed — in both cases we must never attempt it again.
  const isSettled = (target) => {
    const s = statusOf(target);
    return s === 'delivered' || s === 'permanent';
  };

  // True when at least one transient failure remains on a target that has NOT
  // yet succeeded — the only condition that justifies a retry of the event.
  let transientPending = false;

  const markSuccess = async (target) => {
    statuses.set(String(target), 'delivered');
    await tracker.recordSuccess(eventId, target);
  };
  const markPermanent = async (target) => {
    if (!isSettled(target)) statuses.set(String(target), 'permanent');
    await tracker.recordPermanentSkip(eventId, target);
  };

  const alert = { text, videoUrl, inwardVideoUrl, getVideoBuffer };

  // ── 1) Notification subscribers + hardcoded notifications group ──────────────
  const subscribers = await store.getAll();
  if (!subscribers.map(String).includes(String(forcedId))) {
    subscribers.push(String(forcedId));
  }

  const sentNotificationMessages = [];
  let notificationsOk = 0;
  let notificationsSkipped = 0;
  let notificationsTransientFail = 0;
  let notificationsPermanentFail = 0;

  if (subscribers.length === 0) {
    log.warn?.('[Bot] No subscribers to broadcast to.');
  } else {
    log.log?.(`[Bot] Broadcasting to ${subscribers.length} subscriber(s)...`);
    for (const chatId of subscribers) {
      if (isSettled(chatId)) {
        notificationsSkipped += 1;
        continue;
      }
      try {
        const sent = await sendNotificationToTarget(bot, chatId, alert, log);
        if (sent?.messageId) {
          // Carry the exact text that was sent so the video backfill can reuse
          // it verbatim as the replacement message's caption (see videoBackfill).
          sentNotificationMessages.push({ botKind: 'notification', chatId, messageId: sent.messageId, type: sent.type, caption: text });
        }
        await markSuccess(chatId);
        notificationsOk += 1;
        log.log?.(`[Bot] Successfully sent alert to ${chatId}`);
      } catch (err) {
        const kind = classifyTelegramError(err);
        log.error(`[Bot] Failed to send to ${chatId}: ${err.message} (${kind})`);
        if (kind === 'permanent') {
          notificationsPermanentFail += 1;
          await markPermanent(chatId);
          if (err.response?.body?.error_code === 403) {
            log.log?.(`[Bot] Removing blocked user ${chatId}`);
            try { await store.remove(chatId); } catch (_) { /* best effort */ }
          }
        } else {
          notificationsTransientFail += 1;
          transientPending = true;
        }
      }
    }
  }

  // ── 2) Matched driver group (send-only, via the main/feedback bot) ───────────
  const target = await determineTargetGroup(
    alertObj,
    store.findGroupByUnit.bind(store),
    managementGroupId,
  );
  const targetDriverGroupId = target.targetGroupId;
  const unitLabel = target.unitNumber || 'unknown';
  const isFallback = String(target.matchReason || '').startsWith('fallback');

  let driverStatus = 'skip';
  let driverMembershipAccessError = false;
  let driverSentMessage = null;

  if (isFallback) {
    log.warn?.(`[Bot] Unmapped vehicle ${target.vehicleId || 'unknown'} unit ${unitLabel} - no driver group mapped, skipping driver forward`);
  } else if (targetDriverGroupId && driverBot) {
    if (isSettled(targetDriverGroupId)) {
      driverStatus = alreadyDelivered(targetDriverGroupId) ? 'skip-delivered' : 'skip-permanent';
    } else {
      log.log?.(`[Bot] Forwarding alert for Unit #${unitLabel} to group ${targetDriverGroupId}...`);
      let driverCaption = text;
      try {
        driverCaption = await resolveDriverCaption(alertObj, text);
      } catch (aiErr) {
        log.error('[Bot] Driver caption AI failed, using standard text:', aiErr.message);
        driverCaption = text;
      }

      try {
        const driverSent = await sendDriverGroupAlert(driverBot, targetDriverGroupId, {
          caption: driverCaption,
          videoUrl,
          inwardVideoUrl,
          getVideoBuffer,
          // Driver-group-only music overlay (no-op unless wired + enabled + speeding).
          prepareVideo: prepareDriverVideo,
          videoContext: {
            isSpeeding,
            eventId,
            groupId: targetDriverGroupId,
            source: 'immediate',
          },
        });
        if (driverSent?.messageId) {
          driverSentMessage = {
            botKind: 'driver',
            chatId: targetDriverGroupId,
            messageId: driverSent.messageId,
            type: driverSent.type,
            // The driver group gets its own (possibly AI-rephrased) caption; keep
            // it so the video backfill preserves that exact text on replacement.
            caption: driverCaption,
          };
        }
        await markSuccess(targetDriverGroupId);
        driverStatus = 'ok';
        log.log?.(`[Bot] Successfully forwarded to Driver Group ${targetDriverGroupId}`);
      } catch (err) {
        driverMembershipAccessError = isDriverMembershipAccessError(err);
        const kind = classifyTelegramError(err);
        log.error(`[Bot] Forwarding failed to ${targetDriverGroupId}: ${err.message} (${kind})`);
        if (kind === 'permanent') {
          driverStatus = 'fail-permanent';
          await markPermanent(targetDriverGroupId);
        } else {
          driverStatus = 'fail-transient';
          transientPending = true;
        }
      }
    }
  }

  // ── 3) If the driver bot isn't in the group, annotate the notifications we
  //       actually sent THIS run (best effort; never affects retry logic). ─────
  if (driverMembershipAccessError && sentNotificationMessages.length > 0) {
    const notedText = appendDriverMissingNote(text);
    for (const sent of sentNotificationMessages) {
      try {
        if (sent.type === 'text') {
          await bot.editMessageText(notedText, {
            chat_id: sent.chatId,
            message_id: sent.messageId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        } else {
          await bot.editMessageCaption(notedText, {
            chat_id: sent.chatId,
            message_id: sent.messageId,
            parse_mode: 'HTML',
          });
        }
      } catch (noteErr) {
        log.error(`[Bot] Failed to append driver warning note for ${sent.chatId}:`, noteErr.message);
      }
    }
  }

  log.log?.(
    `[Bot] Broadcast complete event=${eventId || 'unknown'} `
    + `notif_ok=${notificationsOk} notif_skip=${notificationsSkipped} `
    + `notif_transient=${notificationsTransientFail} notif_permanent=${notificationsPermanentFail} `
    + `driver=${driverStatus} unit=${unitLabel} transientPending=${transientPending}`,
  );

  // Retry ONLY when a transient failure remains on a not-yet-succeeded target.
  // Permanent failures are recorded and swallowed so the event is considered
  // handled — preventing the re-queue that used to re-send the driver group.
  if (transientPending) {
    throw new Error(`Transient delivery failure for event ${eventId || 'unknown'}; will retry pending targets`);
  }

  // Message references the caller can reply to later to attach the dashcam
  // video (backfill) once it becomes available. Only messages we actually sent
  // THIS run are included; already-delivered/skipped targets are omitted.
  const sentMessages = [...sentNotificationMessages];
  if (driverSentMessage) sentMessages.push(driverSentMessage);

  return {
    eventId,
    notificationsOk,
    notificationsSkipped,
    notificationsTransientFail,
    notificationsPermanentFail,
    driverStatus,
    transientPending,
    // True when the alert already carried video at send time (no backfill needed).
    hadVideoAtSend: Boolean(videoUrl || inwardVideoUrl),
    sentMessages,
  };
}

module.exports = {
  deliverEvent,
  sendNotificationToTarget,
};
