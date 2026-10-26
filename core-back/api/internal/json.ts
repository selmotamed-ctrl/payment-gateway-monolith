import { Prisma } from "../../generated/prisma/client";

export const json = (value: unknown): Prisma.InputJsonValue =>
  value as unknown as Prisma.InputJsonValue;

export const jsonOptional = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : json(value);
