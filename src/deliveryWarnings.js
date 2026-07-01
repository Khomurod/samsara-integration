const DRIVER_GROUP_MISSING_NOTE = "\n\n<i>Note: seems like @wenzefeedback_bot is not in the driver's group.</i>";

function isDriverMembershipAccessError(err) {
  const code = err?.response?.body?.error_code;
  const description = String(err?.response?.body?.description || err?.message || '').toLowerCase();

  if (code === 403) return true;
  if (description.includes('chat not found')) return true;
  if (description.includes('forbidden')) return true;
  if (description.includes('bot was kicked')) return true;
  if (description.includes('bot is not a member')) return true;
  return false;
}

function appendDriverMissingNote(text) {
  const base = String(text || '');
  if (base.includes("@wenzefeedback_bot is not in the driver's group")) {
    return base;
  }
  return `${base}${DRIVER_GROUP_MISSING_NOTE}`;
}

function shouldRetryDelivery(notificationsStatus) {
  return notificationsStatus === 'fail';
}

module.exports = {
  DRIVER_GROUP_MISSING_NOTE,
  isDriverMembershipAccessError,
  appendDriverMissingNote,
  shouldRetryDelivery,
};
