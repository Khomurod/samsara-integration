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

async function determineTargetGroup(alertData, resolveGroupByUnit, managementGroupId) {
  const vehicleName = String(alertData?.vehicleName || '');
  const driverName = String(alertData?.driverName || '');
  const vehicleId = String(alertData?.vehicleId || '');
  const unitNumber = extractUnitNumber(vehicleName);

  if (!unitNumber) {
    return {
      targetGroupId: null,
      unitNumber: null,
      vehicleId,
      matchReason: 'fallback-no-unit',
    };
  }

  const resolved = await resolveGroupByUnit(unitNumber, driverName, vehicleName);
  if (!resolved?.telegramGroupId) {
    return {
      targetGroupId: null,
      unitNumber,
      vehicleId,
      matchReason: 'fallback-unmapped',
    };
  }

  return {
    targetGroupId: resolved.telegramGroupId,
    unitNumber,
    vehicleId,
    matchReason: resolved.matchReason || 'unit',
    groupName: resolved.groupName,
  };
}

module.exports = {
  extractUnitNumber,
  normalizeName,
  resolveGroupByUnitAndName,
  determineTargetGroup,
};

