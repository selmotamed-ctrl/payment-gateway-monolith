/**
 * Beneficial-owner form helpers for the merchant 360 page. The field set, the
 * defaults and the validation mirror `pages/join-requests/[id].tsx` (the
 * join-request owner handlers) and the zod schema of
 * `POST /merchants/:id/beneficial-owners`. The identity number is write-only:
 * it is never read back from the server, so an edit form always starts blank.
 */

export type OwnerIdentityType = "NATIONAL_ID" | "PASSPORT";
export type OwnerRole = "OWNER" | "DIRECTOR" | "SIGNATORY" | "CONTROLLER";

export const OWNER_IDENTITY_TYPES: OwnerIdentityType[] = ["NATIONAL_ID", "PASSPORT"];
export const OWNER_ROLES: OwnerRole[] = ["OWNER", "DIRECTOR", "SIGNATORY", "CONTROLLER"];

export interface OwnerForm {
    fullName: string;
    fullNameEn: string;
    identityType: OwnerIdentityType;
    identityNumber: string;
    nationality: string;
    dateOfBirth: string;
    ownershipPercent: string;
    role: OwnerRole;
    pepDeclared: boolean;
}

export interface MerchantOwnerRecord {
    id: string;
    fullNameAr: string;
    fullNameEn: string | null;
    role: string;
    ownershipPercent: string | null;
    nationality: string;
    pepDeclared: boolean;
    screeningStatus: string;
    active: boolean;
    validFrom?: string | null;
    validTo?: string | null;
    dateOfBirth?: string | null;
}

export const emptyOwnerForm = (): OwnerForm => ({
    fullName: "",
    fullNameEn: "",
    identityType: "NATIONAL_ID",
    identityNumber: "",
    nationality: "LY",
    dateOfBirth: "",
    ownershipPercent: "",
    role: "OWNER",
    pepDeclared: false,
});

export const ownerFormFrom = (owner: MerchantOwnerRecord): OwnerForm => ({
    fullName: owner.fullNameAr,
    fullNameEn: owner.fullNameEn ?? "",
    identityType: "NATIONAL_ID",
    // Never echoed back: the server does not return it.
    identityNumber: "",
    nationality: owner.nationality,
    dateOfBirth: owner.dateOfBirth?.slice(0, 10) ?? "",
    ownershipPercent: owner.ownershipPercent ?? "",
    role: (OWNER_ROLES.includes(owner.role as OwnerRole) ? owner.role : "OWNER") as OwnerRole,
    pepDeclared: owner.pepDeclared,
});

const clean = (value: string): string | undefined => (value.trim().length > 0 ? value.trim() : undefined);

export type OwnerFormErrors = Partial<Record<"fullName" | "fullNameEn" | "identityNumber" | "nationality" | "dateOfBirth" | "ownershipPercent", string>>;

const PERCENT = /^\d{1,3}(?:\.\d{1,2})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Error values are English message keys; an empty object means the form is valid. */
export const validateOwnerForm = (form: OwnerForm, editing: boolean): OwnerFormErrors => {
    const errors: OwnerFormErrors = {};
    const name = form.fullName.trim();
    if (name.length < 2) errors.fullName = "The owner name is required";
    else if (name.length > 160) errors.fullName = "The name is limited to 160 characters";
    const nameEn = form.fullNameEn.trim();
    if (nameEn.length > 0 && (nameEn.length < 2 || nameEn.length > 160)) errors.fullNameEn = "The English name must be 2 to 160 characters";
    const identity = form.identityNumber.trim();
    if (!editing && identity.length < 4) errors.identityNumber = "The owner identity number is required";
    else if (identity.length > 0 && (identity.length < 4 || identity.length > 32)) errors.identityNumber = "The identity number must be 4 to 32 characters";
    const nationality = form.nationality.trim();
    if (nationality.length > 0 && nationality.length !== 2) errors.nationality = "Use a two-letter country code";
    const dob = form.dateOfBirth.trim();
    if (dob.length > 0 && (!DATE.test(dob) || Number.isNaN(Date.parse(dob)))) errors.dateOfBirth = "Use the format YYYY-MM-DD";
    const percent = form.ownershipPercent.trim();
    if (percent.length > 0) {
        if (!PERCENT.test(percent)) errors.ownershipPercent = "Use a percentage with up to two decimals";
        else if (Number(percent) > 100) errors.ownershipPercent = "The ownership percentage cannot exceed 100";
    }
    return errors;
};

/**
 * Request body. On create the identity type and number are always sent; on an
 * edit they are sent only when a new identity number was typed (so the stored
 * one is replaced), otherwise the server keeps the encrypted value.
 */
export const buildOwnerBody = (form: OwnerForm, editing: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
        fullName: form.fullName.trim(),
        fullNameEn: clean(form.fullNameEn),
        nationality: clean(form.nationality)?.toUpperCase(),
        dateOfBirth: clean(form.dateOfBirth),
        ownershipPercent: clean(form.ownershipPercent),
        role: form.role,
        pepDeclared: form.pepDeclared,
    };
    const identity = form.identityNumber.trim();
    if (!editing || identity.length > 0) {
        body.identityType = form.identityType;
        body.identityNumber = identity;
    }
    for (const key of Object.keys(body)) if (body[key] === undefined) delete body[key];
    return body;
};

/** Sum of the ownership percentages of the active owners (client-side hint; the server enforces <= 100). */
export const activeOwnershipTotal = (
    owners: ReadonlyArray<Pick<MerchantOwnerRecord, "id" | "active" | "ownershipPercent">>,
    excludeId?: string,
): number =>
    owners
        .filter((owner) => owner.active && owner.id !== excludeId)
        .reduce((sum, owner) => sum + (owner.ownershipPercent ? Number(owner.ownershipPercent) : 0), 0);
