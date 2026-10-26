import { Decimal } from "decimal.js";
import type { DecimalInput } from "../ledger/LedgerPoster";

export type AdapterAttemptStatus =
  | "CREATED"
  | "INITIATING"
  | "AWAITING_CUSTOMER"
  | "AUTHORIZING"
  | "VERIFYING"
  | "UNKNOWN"
  | "SUCCEEDED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | "BLOCKED"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "DISPUTED";

export interface AdapterAttempt {
  id: string;
  reference?: string;
  gatewayReference?: string;
  status: AdapterAttemptStatus;
  mode?: string;
  subMode?: string;
  env: string;
  currency: string;
  requestedAmount: DecimalInput;
  surchargeAmount?: DecimalInput;
  totalChargedAmount: DecimalInput;
  gatewayAmountWire?: string;
  settledAmount?: DecimalInput;
  gatewayFeeAmount?: DecimalInput;
  providerReference?: string;
  networkReference?: string;
  otpAttempts?: number;
  maxOtpAttempts?: number;
  pointOfNoReturn?: boolean;
  expiresAt?: Date;
  context?: Record<string, unknown>;
}

export interface AdapterFormData {
  [key: string]: unknown;
}

export interface AdapterEvidence {
  [key: string]: unknown;
}

export interface AdapterClientAction {
  type:
    | "SHOW_OTP_FORM"
    | "HTTP_REDIRECT"
    | "RENDER_EMBEDDED"
    | "SHOW_QR_OR_CODE"
    | "SHOW_PUSH_OR_TRANSFER";
  payload: Record<string, unknown>;
}

export interface AdapterStepResult {
  status: AdapterAttemptStatus;
  substatus?: string;
  canonicalError?: string;
  response?: unknown;
  rawText?: string;
  outputs: {
    state: Record<string, unknown>;
    public: Record<string, unknown>;
    settledAmount?: DecimalInput;
    providerFee?: DecimalInput;
    providerReference?: string;
    networkReference?: string;
  };
  logs?: readonly Record<string, unknown>[];
}

export interface AdapterEngineResult {
  attempt: AdapterAttempt;
  status: AdapterAttemptStatus;
  substatus?: string;
  canonicalError?: string;
  clientAction?: AdapterClientAction;
  outputs: Record<string, unknown>;
}

export interface NativeAdapter {
  preInitiate(attempt: AdapterAttempt, formData: AdapterFormData): Promise<AdapterEngineResult>;
  initiate(attempt: AdapterAttempt, formData: AdapterFormData): Promise<AdapterEngineResult>;
  confirm(attempt: AdapterAttempt, evidence: AdapterEvidence): Promise<AdapterEngineResult>;
  verifyCallback(channel: string, rawRequest: unknown): Promise<AdapterEngineResult>;
  inquire(attempt: AdapterAttempt): Promise<AdapterEngineResult>;
  refund(attempt: AdapterAttempt, amount: DecimalInput, adjustmentId: string): Promise<AdapterEngineResult>;
}

export class NativeAdapterRegistry {
  private readonly adapters = new Map<string, NativeAdapter>();

  register(code: string, adapter: NativeAdapter): () => void {
    if (!code) {
      throw new Error("Native adapter code is required");
    }
    this.adapters.set(code, adapter);
    return () => {
      if (this.adapters.get(code) === adapter) {
        this.adapters.delete(code);
      }
    };
  }

  unregister(code: string): boolean {
    return this.adapters.delete(code);
  }

  get(code: string): NativeAdapter | undefined {
    return this.adapters.get(code);
  }

  require(code: string): NativeAdapter {
    const adapter = this.adapters.get(code);
    if (!adapter) {
      throw new Error(`Native adapter '${code}' is not registered`);
    }
    return adapter;
  }

  has(code: string): boolean {
    return this.adapters.has(code);
  }

  list(): string[] {
    return [...this.adapters.keys()].sort();
  }

  clear(): void {
    this.adapters.clear();
  }
}

export function decimalToString(value: DecimalInput): string {
  return new Decimal(value.toString()).toFixed(4);
}
