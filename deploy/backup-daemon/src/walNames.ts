/**
 * PostgreSQL WAL file naming and archiver arithmetic.
 *
 * `pg_stat_archiver.last_archived_wal` is a 24-hex-character segment FILE NAME
 * (`00000001000000000000001A`), not an LSN, so it can never be passed to
 * `pg_wal_lsn_diff()` (that raised "function pg_wal_lsn_diff(pg_lsn, text)
 * does not exist" on every poll and left the lag reported as 0 forever).
 */

export const WAL_SEGMENT_PATTERN = /^[0-9A-F]{24}$/;
export const WAL_HISTORY_PATTERN = /^[0-9A-F]{8}\.history$/;
export const WAL_BACKUP_LABEL_PATTERN = /^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/;
export const WAL_PARTIAL_PATTERN = /^[0-9A-F]{24}\.partial$/;

export const DEFAULT_WAL_SEGMENT_BYTES = 16 * 1024 * 1024;

export const isWalSegmentName = (name: string): boolean => WAL_SEGMENT_PATTERN.test(name);

/** Everything `archive_command` may push: segments, timeline history files, backup labels. */
export const isArchivableWalFile = (name: string): boolean =>
  WAL_SEGMENT_PATTERN.test(name) || WAL_HISTORY_PATTERN.test(name) || WAL_BACKUP_LABEL_PATTERN.test(name);

export const WAL_TARGETS = ["postgres_core", "audit_db"] as const;
export type WalTarget = (typeof WAL_TARGETS)[number];

export const isWalTarget = (value: string): value is WalTarget => (WAL_TARGETS as readonly string[]).includes(value);

/** Absolute segment number (timeline ignored): `logId * segmentsPerLog + segId`. */
export const walSegmentNumber = (name: string, segmentBytes = DEFAULT_WAL_SEGMENT_BYTES): number | null => {
  if (!WAL_SEGMENT_PATTERN.test(name)) return null;
  const segmentsPerLog = Math.floor(0x1_0000_0000 / segmentBytes);
  const logId = Number.parseInt(name.slice(8, 16), 16);
  const segId = Number.parseInt(name.slice(16, 24), 16);
  return logId * segmentsPerLog + segId;
};

export const walSegmentName = (timeline: number, segmentNumber: number, segmentBytes = DEFAULT_WAL_SEGMENT_BYTES): string => {
  const segmentsPerLog = Math.floor(0x1_0000_0000 / segmentBytes);
  const hex = (value: number): string => value.toString(16).toUpperCase().padStart(8, "0");
  return `${hex(timeline)}${hex(Math.floor(segmentNumber / segmentsPerLog))}${hex(segmentNumber % segmentsPerLog)}`;
};

/** Bytes between the segment being written and the last archived one (0 when unknown). */
export const archiveLagBytes = (
  currentWalFile: string,
  lastArchivedWal: string,
  segmentBytes = DEFAULT_WAL_SEGMENT_BYTES,
): number => {
  const current = walSegmentNumber(currentWalFile, segmentBytes);
  const last = walSegmentNumber(lastArchivedWal, segmentBytes);
  if (current === null || last === null) return 0;
  return Math.max(0, current - last) * segmentBytes;
};

export interface WalArchiveStatus {
  lastArchivedWal: string;
  /** Alert-relevant lag: time since the last archive, but ONLY while archiving is actually behind (see below). */
  lagSeconds: number;
  /** Plain time since the last archived segment, regardless of whether anything is waiting. */
  secondsSinceLastArchive: number;
  archivedCount: number;
  failedCount: number;
  currentLsn: string;
  currentWalFile: string;
  lagBytes: number;
  /** Completed segments PostgreSQL has moved past that are not archived yet (the segment being written does not count). */
  completedPendingSegments: number;
  /** The archiver's most recent attempt failed (last_failed_time is newer than last_archived_time). */
  failing: boolean;
}

/**
 * Parses the pipe-separated `psql -A -t` row of WAL_ARCHIVE_STATUS_QUERY:
 * `last_archived_wal|lag_seconds|archived_count|failed_count|current_lsn|current_wal_file[|failing]`.
 * An empty `last_archived_wal` (archiver has never run) is a valid initial state.
 *
 * "Time since the last archive" alone is the wrong alarm: an idle database writes no WAL, so nothing is
 * archived and the number grows forever. Lag only counts while archiving is genuinely behind, i.e. a
 * COMPLETED segment is waiting (current segment > last archived + 1) or the archiver is failing. The
 * segment currently being written is not late: PostgreSQL's `archive_timeout` hands it over.
 */
export const parseWalArchiveStatus = (stdout: string, segmentBytes = DEFAULT_WAL_SEGMENT_BYTES): WalArchiveStatus => {
  const row = stdout.trim().split(/\r?\n/)[0] ?? "";
  const [lastArchivedWal = "", lag = "0", archived = "0", failed = "0", currentLsn = "", currentWalFile = "", failingText = "false"] = row
    .split("|")
    .map((value) => value.trim());
  const number = (value: string): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : 0;
  };
  const secondsSinceLastArchive = number(lag);
  const failing = failingText.toLowerCase() === "true" || failingText.toLowerCase() === "t";
  const current = walSegmentNumber(currentWalFile, segmentBytes);
  const last = walSegmentNumber(lastArchivedWal, segmentBytes);
  const completedPendingSegments = current !== null && last !== null ? Math.max(0, current - last - 1) : 0;
  return {
    lastArchivedWal,
    lagSeconds: completedPendingSegments > 0 || failing ? secondsSinceLastArchive : 0,
    secondsSinceLastArchive,
    archivedCount: number(archived),
    failedCount: number(failed),
    currentLsn,
    currentWalFile,
    lagBytes: archiveLagBytes(currentWalFile, lastArchivedWal, segmentBytes),
    completedPendingSegments,
    failing,
  };
};

/** `0/2000028` -> absolute byte position. */
export const lsnToBytes = (lsn: string): number | null => {
  const match = /^([0-9A-Fa-f]+)\/([0-9A-Fa-f]+)$/.exec(lsn.trim());
  if (!match) return null;
  return Number.parseInt(match[1]!, 16) * 0x1_0000_0000 + Number.parseInt(match[2]!, 16);
};

/** The WAL segment file that contains `lsn` on `timeline`. */
export const lsnToSegmentName = (lsn: string, timeline: number, segmentBytes = DEFAULT_WAL_SEGMENT_BYTES): string | null => {
  const bytes = lsnToBytes(lsn);
  if (bytes === null) return null;
  return walSegmentName(timeline, Math.floor(bytes / segmentBytes), segmentBytes);
};

/**
 * `recovery_target_time` value PostgreSQL can parse while it is still reading its configuration.
 * An ISO string ending in `Z` is REJECTED there ("invalid value for parameter recovery_target_time":
 * the `Z` abbreviation table is not loaded yet), so use a numeric UTC offset instead.
 */
export const pgRecoveryTimestamp = (date: Date): string =>
  date.toISOString().replace("T", " ").replace("Z", "+00");
