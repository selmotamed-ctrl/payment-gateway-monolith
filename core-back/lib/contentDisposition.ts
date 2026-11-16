/**
 * A `Content-Disposition` header value for a file whose name comes from a user.
 *
 * HTTP header values are Latin-1: `response.setHeader` throws `ERR_INVALID_CHAR` for any character above
 * U+00FF. A file named in Arabic (the normal case here: KYB documents, dispute evidence, bank statements)
 * therefore made the download answer 500, after the "viewed" audit row had already been written. The name is
 * sent twice, as RFC 6266 section 4.3 recommends:
 *
 *   attachment; filename="<ASCII fallback>"; filename*=UTF-8''<percent-encoded UTF-8>
 *
 * Every current browser uses `filename*`; the plain `filename` is the fallback and is pure printable ASCII
 * with quotes, backslashes, control characters and path separators removed, so the value can neither break out
 * of the quoted string nor start a new header.
 */
const ASCII_UNSAFE = /[^\x20-\x7e]|["\\/:*?<>|]/g;

/** RFC 5987 `attr-char` encoding: `encodeURIComponent` plus the characters it leaves but the grammar forbids. */
const encodeRfc5987 = (value: string): string =>
  encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

const MAX_NAME_CHARS = 200;

export const contentDisposition = (
  kind: "attachment" | "inline",
  fileName: string | null | undefined,
  fallbackName = "download",
): string => {
  // Line breaks and other control characters never reach either form; a path keeps its last segment only.
  const cleaned = String(fileName ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .split(/[\\/]/)
    .pop()!
    .trim()
    .slice(0, MAX_NAME_CHARS);
  const name = cleaned.length > 0 ? cleaned : fallbackName;
  const ascii = name.replace(ASCII_UNSAFE, "_").replace(/_{2,}/g, "_");
  // A name with no ASCII letters or digits left ("____.pdf") is useless as a fallback: use the default stem
  // and keep the extension when it is a plain one.
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(ascii)?.[0] ?? "";
  const asciiName = /[A-Za-z0-9]/.test(ascii.slice(0, ascii.length - extension.length)) ? ascii : `${fallbackName}${extension}`;
  const base = `${kind}; filename="${asciiName}"`;
  return asciiName === name ? base : `${base}; filename*=UTF-8''${encodeRfc5987(name)}`;
};
