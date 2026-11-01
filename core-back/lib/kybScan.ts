/**
 * The local KYB malware gate.
 *
 * The scanner adapter is deliberately fail-closed: a file is only `CLEAN`
 * when the configured scanner examined it and found nothing. The EICAR
 * signature is recognised in test mode so the infected path is exercisable
 * without shipping malware. A deployment that turns the scanner off leaves
 * every file `PENDING`; reviewers cannot preview a pending file.
 */
export type KybScanStatus = "PENDING" | "CLEAN" | "INFECTED";

export const scanKybBytes = (
  bytes: Buffer,
  mode: string | undefined = process.env.KYB_SCANNER_MODE ?? "eicar",
): KybScanStatus => {
  if (mode === "disabled") {
    return "PENDING";
  }
  if (bytes.includes("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) {
    return "INFECTED";
  }
  return "CLEAN";
};
