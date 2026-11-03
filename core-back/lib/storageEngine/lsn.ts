const LSN_PATTERN = /^[0-9a-f]+\/[0-9a-f]+$/i;

const parseLsn = (lsn: string): bigint | null => {
  const trimmed = lsn.trim();
  if (!LSN_PATTERN.test(trimmed)) {
    return null;
  }
  const [hi, lo] = trimmed.split("/");
  try {
    return (BigInt(`0x${hi}`) << 32n) | BigInt(`0x${lo}`);
  } catch {
    return null;
  }
};

export const isValidLsn = (lsn: string): boolean => parseLsn(lsn) !== null;

export const isLsnGreaterOrEqual = (candidateLsn: string, targetLsn: string): boolean => {
  const candidate = parseLsn(candidateLsn);
  const target = parseLsn(targetLsn);
  if (candidate === null || target === null) {
    return false;
  }
  return candidate >= target;
};

export const compareLsn = (left: string, right: string): number => {
  const a = parseLsn(left);
  const b = parseLsn(right);
  if (a === null || b === null) {
    return 0;
  }
  return a === b ? 0 : a > b ? 1 : -1;
};
