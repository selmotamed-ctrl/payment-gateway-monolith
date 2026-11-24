/** Mask an email address for clipboard summaries so copied text does not carry a full identifier. */
export const maskEmail = (value: string | null | undefined): string | null => {
    const email = (value ?? "").trim();
    if (!email) return null;
    const [local, domain] = email.split("@");
    if (!domain) return email.length <= 2 ? "**" : `${email.slice(0, 1)}***`;
    const head = (local ?? "").slice(0, 1);
    return `${head}***@${domain}`;
};
