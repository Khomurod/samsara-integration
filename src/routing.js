function extractUnitNumber(value) {
  const raw = String(value || '');
  const match = raw.match(/\d+/);
  return match ? match[0] : null;
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveGroupByUnitAndName(candidates, unitNumber, nameHints = []) {
  const cleanUnit = String(unitNumber || '').replace(/\D/g, '');
  if (!cleanUnit || !Array.isArray(candidates) || candidates.length === 0) return null;

  const unitMatches = candidates.filter((row) => {
    const firstNumber = extractUnitNumber(row.group_name);
    return firstNumber === cleanUnit;
  });
  if (unitMatches.length === 0) return null;
  if (unitMatches.length === 1) return unitMatches[0];

  const normalizedHints = nameHints.map(normalizeName).filter((hint) => hint.length >= 3);
  if (normalizedHints.length === 0) return null;

  return unitMatches.find((row) => {
    const normalizedGroupName = normalizeName(row.group_name);
    return normalizedHints.some((hint) => normalizedGroupName.includes(hint));
  }) || null;
}


/**
 * Which resolution wins, and what that says about the fleet's data. PURE.
 *
 * Until now a Samsara safety alert found its driver by pulling the first number
 * out of a free-form vehicle label and matching it against the first number in a
 * Telegram chat title. That works until a label reads "2021 Freightliner 305",
 * at which point the alert routes as unit 2021 — to nobody. `groups` has carried
 * an indexed `samsara_vehicle_id` column all along, and nothing ever wrote to it.
 *
 * Now something does (bot-backend's duplicate-unit scan), so this prefers the
 * stored association and keeps the string parse underneath it. The parse is not
 * removed, because a fleet whose links are half-written still has to route.
 *
 * THE FINDINGS ARE THE POINT OF DOING IT THIS WAY. A silent switchover is a
 * switchover nobody can audit:
 *
 *   - the two agree            → nothing to say
 *   - only the parse resolved  → an `info` finding naming the group it chose,
 *                                so "how much of the fleet still routes by
 *                                string" is a number instead of a feeling
 *   - they disagree            → a `serious` finding. One of the two is sending
 *                                a safety alert to the wrong driver, and which
 *                                one is not for this function to decide. The
 *                                stored id wins because it is the explicit
 *                                fact, and the finding preserves the other.
 *
 * @returns {{group: object|null, matchReason: string|null, finding: object|null}}
 */
function chooseRoutedGroup({
  stored = null, parsed = null, vehicleId = null, vehicleName = '', unitNumber = null,
} = {}) {
  const subjectId = vehicleId ? String(vehicleId) : `unit:${unitNumber || 'unknown'}`;

  if (stored && parsed && String(stored.id) !== String(parsed.id)) {
    return {
      group: stored,
      matchReason: 'vehicle_id',
      finding: {
        checkKey: 'integrations.samsara_routing_disagreement',
        subjectType: 'samsara_vehicle',
        subjectId,
        title: `Samsara vehicle ${subjectId} routes to a different driver by stored id than by name`,
        severity: 'serious',
        evidence: {
          vehicleId: vehicleId || null,
          vehicleName: vehicleName || null,
          unitNumber: unitNumber || null,
          storedGroupId: stored.id,
          storedGroupName: stored.group_name || null,
          parsedGroupId: parsed.id,
          parsedGroupName: parsed.group_name || null,
          routedTo: 'stored',
        },
      },
    };
  }

  if (stored) return { group: stored, matchReason: 'vehicle_id', finding: null };

  if (parsed) {
    return {
      group: parsed,
      matchReason: parsed.matchReason || 'unit',
      finding: {
        checkKey: 'integrations.samsara_routed_by_name',
        subjectType: 'samsara_vehicle',
        subjectId,
        title: `Samsara vehicle ${subjectId} has no stored group link — routed by parsing its label`,
        severity: 'info',
        evidence: {
          vehicleId: vehicleId || null,
          vehicleName: vehicleName || null,
          unitNumber: unitNumber || null,
          parsedGroupId: parsed.id,
          parsedGroupName: parsed.group_name || null,
          matchReason: parsed.matchReason || 'unit',
        },
      },
    };
  }

  return { group: null, matchReason: null, finding: null };
}

async function determineTargetGroup(alertData, resolveGroupByUnit, managementGroupId) {
  const vehicleName = String(alertData?.vehicleName || '');
  const driverName = String(alertData?.driverName || '');
  const vehicleId = String(alertData?.vehicleId || '');
  const unitNumber = extractUnitNumber(vehicleName);

  // A vehicle id is enough on its own now. It did not used to be, so a label
  // carrying no digits at all ended the resolution here — with a stored link
  // sitting in the database, unread, that would have answered it.
  if (!unitNumber && !vehicleId) {
    return {
      targetGroupId: null,
      unitNumber: null,
      vehicleId,
      matchReason: 'fallback-no-unit',
    };
  }

  const resolved = await resolveGroupByUnit(unitNumber, driverName, vehicleName, vehicleId);
  if (!resolved?.telegramGroupId) {
    return {
      targetGroupId: null,
      unitNumber: unitNumber || null,
      vehicleId,
      matchReason: 'fallback-unmapped',
    };
  }

  return {
    targetGroupId: resolved.telegramGroupId,
    unitNumber: unitNumber || null,
    vehicleId,
    matchReason: resolved.matchReason || 'unit',
    groupName: resolved.groupName,
  };
}

module.exports = {
  chooseRoutedGroup,
  extractUnitNumber,
  normalizeName,
  resolveGroupByUnitAndName,
  determineTargetGroup,
};

