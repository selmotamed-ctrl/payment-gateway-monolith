export type SeederProfile = "COMPACT" | "STANDARD" | "STRESS";

export interface ProfileVolumes {
  merchants: number;
  joinRequests: number;
  kybDocuments: number;
  beneficialOwners: number;
  users: number;
  wallets: number;
  applications: number;
  paymentLinks: number;
  paymentAttempts: number;
  reconciliationRuns: number;
  reconciliationItems: number;
  disputes: number;
  adjustments: number;
  cashouts: number;
  amlScreenings: number;
  amlCases: number;
  operatorCases: number;
  approvalRequests: number;
  yearsSpan: number;
}

export const PROFILES: Record<SeederProfile, ProfileVolumes> = {
  COMPACT: {
    merchants: 65,
    joinRequests: 80,
    kybDocuments: 420,
    beneficialOwners: 150,
    users: 160,
    wallets: 95,
    applications: 130,
    paymentLinks: 8500,
    paymentAttempts: 15000,
    reconciliationRuns: 180,
    reconciliationItems: 12000,
    disputes: 120,
    adjustments: 230,
    cashouts: 160,
    amlScreenings: 600,
    amlCases: 95,
    operatorCases: 450,
    approvalRequests: 160,
    yearsSpan: 3.5,
  },
  STANDARD: {
    merchants: 250,
    joinRequests: 310,
    kybDocuments: 1650,
    beneficialOwners: 580,
    users: 640,
    wallets: 380,
    applications: 520,
    paymentLinks: 65000,
    paymentAttempts: 120000,
    reconciliationRuns: 720,
    reconciliationItems: 95000,
    disputes: 900,
    adjustments: 1500,
    cashouts: 900,
    amlScreenings: 2800,
    amlCases: 420,
    operatorCases: 2900,
    approvalRequests: 900,
    yearsSpan: 3.5,
  },
  STRESS: {
    merchants: 1200,
    joinRequests: 1500,
    kybDocuments: 7800,
    beneficialOwners: 2800,
    users: 3000,
    wallets: 1800,
    applications: 2500,
    paymentLinks: 280000,
    paymentAttempts: 500000,
    reconciliationRuns: 1460,
    reconciliationItems: 400000,
    disputes: 4000,
    adjustments: 6000,
    cashouts: 3500,
    amlScreenings: 12000,
    amlCases: 1800,
    operatorCases: 11500,
    approvalRequests: 4000,
    yearsSpan: 4.0,
  },
};

export interface SeederConfig {
  profile: SeederProfile;
  seedKey: string;
  namespace: string;
  volumes: ProfileVolumes;
  now: Date;
}

export const loadSeederConfig = (now = new Date()): SeederConfig => {
  const rawProfile = (process.env.SYNTHETIC_SEED_PROFILE ?? process.env.SYNTHETIC_DATA_PROFILE ?? "STANDARD").toUpperCase();
  const profile: SeederProfile = rawProfile === "COMPACT" || rawProfile === "STRESS" ? rawProfile : "STANDARD";
  const volumes = { ...PROFILES[profile] };
  const years = Number(process.env.SYNTHETIC_YEARS_SPAN ?? process.env.SYNTHETIC_DATA_YEARS ?? volumes.yearsSpan);
  if (Number.isFinite(years) && years > 0) {
    volumes.yearsSpan = years;
  }
  return {
    profile,
    seedKey: process.env.SYNTHETIC_SEED_KEY ?? process.env.SYNTHETIC_DATA_SEED ?? "libya-pg-2023-2026",
    namespace: process.env.SYNTHETIC_DATA_NAMESPACE ?? "synthv1",
    volumes,
    now,
  };
};
