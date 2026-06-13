"use strict";

function countMatches(value, pattern) {
  const matches = value.match(pattern);
  return matches ? matches.length : 0;
}

function scoreReadableEastAsianText(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }
  return (
    countMatches(value, /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) * 3 +
    countMatches(value, /[\u3040-\u30ff]/g) * 2 +
    countMatches(value, /[\uac00-\ud7af]/g) * 2
  );
}

function scoreUtf8MojibakeMarkers(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }
  return (
    countMatches(value, /[ÃÂÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) +
    countMatches(value, /[\u0080-\u009f]/g) * 2
  );
}

function countReplacementChars(value) {
  return countMatches(value, /\uFFFD/g);
}

function attemptUtf8MojibakeRepair(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  try {
    return Buffer.from(value, "latin1").toString("utf8");
  } catch {
    return value;
  }
}

function shouldAcceptRepair(originalValue, repairedValue) {
  if (!repairedValue || repairedValue === originalValue) {
    return false;
  }

  const originalReadableScore = scoreReadableEastAsianText(originalValue);
  const repairedReadableScore = scoreReadableEastAsianText(repairedValue);
  const originalMarkerScore = scoreUtf8MojibakeMarkers(originalValue);
  const repairedMarkerScore = scoreUtf8MojibakeMarkers(repairedValue);
  const originalReplacementChars = countReplacementChars(originalValue);
  const repairedReplacementChars = countReplacementChars(repairedValue);

  if (repairedReadableScore <= originalReadableScore) {
    return false;
  }

  if (repairedMarkerScore > originalMarkerScore) {
    return false;
  }

  if (
    repairedReplacementChars > Math.max(1, originalReplacementChars) &&
    repairedReadableScore < originalReadableScore + 4
  ) {
    return false;
  }

  return true;
}

function maybeRepairUtf8Mojibake(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }

  const markerScore = scoreUtf8MojibakeMarkers(value);
  if (markerScore === 0) {
    return value;
  }

  let bestValue = value;
  let candidate = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    candidate = attemptUtf8MojibakeRepair(candidate);
    if (!shouldAcceptRepair(bestValue, candidate)) {
      break;
    }
    bestValue = candidate;
  }

  if (bestValue === value && markerScore > 0) {
    const repaired = attemptUtf8MojibakeRepair(value);
    if (shouldAcceptRepair(value, repaired)) {
      return repaired;
    }
  }

  return bestValue;
}

module.exports = {
  countMatches,
  countReplacementChars,
  scoreReadableEastAsianText,
  scoreUtf8MojibakeMarkers,
  maybeRepairUtf8Mojibake
};
