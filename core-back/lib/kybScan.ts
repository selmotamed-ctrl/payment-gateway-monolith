/**
 * The local KYB malware gate.
 *
 * The gate is fail-closed. A file is only `CLEAN` when a scanner mode was
 * configured explicitly through `KYB_SCANNER_MODE` and that scanner examined
 * the bytes and found nothing:
 *
 *  - unset / `disabled` / any unknown value: nothing is scanned, so every file
 *    stays `PENDING` and reviewers cannot preview it (production default);
 *  - `eicar`: the built-in content gate for dev and tests. It marks files
 *    `CLEAN` after the checks below pass. It is NOT a malware engine.
 *
 * Whatever the mode, active content is refused by content sniffing: HTML and
 * SVG with script, PDFs carrying `/JS`, `/JavaScript`, `/OpenAction`,
 * `/Launch` or embedded files, and native executables (PE, ELF, Mach-O,
 * shebang scripts). The EICAR test signature is always recognised.
 */
export type KybScanStatus = "PENDING" | "CLEAN" | "INFECTED";

const EICAR = "EICAR-STANDARD-ANTIVIRUS-TEST-FILE";

const ACTIVE_CONTENT_TEXT: readonly RegExp[] = [
  /<\s*script/i,
  /<\s*html/i,
  /<!doctype\s+html/i,
  /<\s*svg/i,
  /<\s*iframe/i,
  /<\s*object/i,
  /<\s*embed/i,
  /<\?php/i,
  /javascript\s*:/i,
  /\bon(?:load|error|click)\s*=/i,
];

const PDF_ACTIVE_CONTENT = /\/(?:JS|JavaScript|OpenAction|Launch|RichMedia|EmbeddedFile|XFA)\b/;

const hasExecutableHeader = (bytes: Buffer): boolean => {
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return true; // PE "MZ"
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return true; // ELF
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true; // "#!" script
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE(0);
    if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic)) return true; // Mach-O / fat
  }
  return false;
};

/** True when the bytes carry active or executable content that KYB never accepts. */
export const containsActiveContent = (bytes: Buffer): boolean => {
  if (hasExecutableHeader(bytes)) return true;
  const text = bytes.toString("latin1");
  if (text.startsWith("%PDF-") && PDF_ACTIVE_CONTENT.test(text)) return true;
  return ACTIVE_CONTENT_TEXT.some((pattern) => pattern.test(text));
};

export const scanKybBytes = (
  bytes: Buffer,
  mode: string | undefined = process.env.KYB_SCANNER_MODE,
): KybScanStatus => {
  if (bytes.includes(EICAR) || containsActiveContent(bytes)) {
    return "INFECTED";
  }
  if (mode === "eicar") {
    return "CLEAN";
  }
  return "PENDING";
};
