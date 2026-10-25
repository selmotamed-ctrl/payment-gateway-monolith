import z from "zod";

export const passportRegex = /^[A-Z0-9a-z]{8}$/;
export const nationalIdRegex = /^[12][0-9]{11}$/;
export const phoneRegex = /^(?:(?:(?:00|\+)?218)|0)?([9][1-5][0-9]{7})$/;

export const zPhone = z
  .string()
  .regex(phoneRegex, {
    error: "Phone Invalid",
  })
  .transform((val) => {
    const match = val.match(phoneRegex)!;
    return match[1]!;
  });

export const zNationalId = z.string().regex(nationalIdRegex, {
  error: "invalid national id",
});

export const zPassportNumber = z.string().regex(passportRegex, {
  error: "invalid passport number",
});
