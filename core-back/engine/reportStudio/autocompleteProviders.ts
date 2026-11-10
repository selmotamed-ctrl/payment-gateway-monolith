import type {
  AutocompleteItem,
  AutocompleteProvider,
  ReadOnlyDatabasePort,
  ReportActorContext,
} from "../../lib/reportEngineSdk/types/hostConfig";

const like = (query: string): string => `%${query.trim().replace(/[%_]/g, "")}%`;

const hasConfidentialAmlAccess = (actor: ReportActorContext): boolean =>
  actor.role === "MLRO" ||
  actor.role === "COMPLIANCE" ||
  (actor.authorities.includes("aml:read") && actor.authorities.includes("compliance:read"));

export function buildPaymentGatewayAutocompleteProviders(
  dbReadOnly: ReadOnlyDatabasePort,
): Record<string, AutocompleteProvider> {
  return {
    merchants: {
      sourceKey: "merchants",
      description: "Search merchants by legal/trade name",
      valueType: "uuid",
      requiredAuthority: "merchant:read",
      search: async ({ query, limit }) => {
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          legal_name: string;
          trade_name: string;
          status: string;
        }>({
          sql: `SELECT id, legal_name, trade_name, status FROM merchants
                WHERE legal_name ILIKE $1 OR trade_name ILIKE $1
                ORDER BY trade_name ASC LIMIT $2`,
          values: [like(query), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_merchants",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: r.trade_name || r.legal_name,
          sublabel: r.legal_name,
          badge: r.status,
        }));
      },
    },

    applications: {
      sourceKey: "applications",
      description: "Search merchant applications/channels",
      valueType: "uuid",
      requiredAuthority: "merchant:read",
      search: async ({ query, limit, dependentValues }) => {
        const merchantId = typeof dependentValues?.merchantId === "string" ? dependentValues.merchantId : null;
        const values: unknown[] = [like(query)];
        let sql = `SELECT id, name, merchant_id, status FROM applications WHERE name ILIKE $1`;
        if (merchantId) {
          values.push(merchantId);
          sql += ` AND merchant_id = $${values.length}::uuid`;
        }
        values.push(Math.min(limit, 50));
        sql += ` ORDER BY name ASC LIMIT $${values.length}`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          name: string;
          merchant_id: string;
          status: string;
        }>({
          sql,
          values,
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_applications",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: r.name,
          sublabel: r.merchant_id,
          badge: r.status,
        }));
      },
    },

    payment_links: {
      sourceKey: "payment_links",
      description: "Search payment links by key",
      valueType: "uuid",
      requiredAuthority: "merchant:read",
      search: async ({ query, limit, dependentValues }) => {
        const merchantId = typeof dependentValues?.merchantId === "string" ? dependentValues.merchantId : null;
        const values: unknown[] = [like(query)];
        let sql = `SELECT pl.id, pl.key, a.merchant_id, pl.state FROM payment_links pl
                   JOIN applications a ON a.id = pl.application_id WHERE pl.key ILIKE $1`;
        if (merchantId) {
          values.push(merchantId);
          sql += ` AND a.merchant_id = $${values.length}::uuid`;
        }
        values.push(Math.min(limit, 50));
        sql += ` ORDER BY pl.created_at DESC LIMIT $${values.length}`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          key: string;
          merchant_id: string;
          state: string;
        }>({
          sql,
          values,
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_payment_links",
        });
        return res.rows.map((row) => ({
          value: row.id,
          label: row.key,
          sublabel: row.merchant_id,
          badge: row.state,
        }));
      },
    },

    pos_terminals: {
      sourceKey: "pos_terminals",
      description: "Search POS terminals by name",
      valueType: "uuid",
      requiredAuthority: "merchant:read",
      search: async ({ query, limit, dependentValues }) => {
        const merchantId = typeof dependentValues?.merchantId === "string" ? dependentValues.merchantId : null;
        const values: unknown[] = [like(query)];
        let sql = `SELECT pt.id, pt.name, a.merchant_id, pt.status FROM pos_terminals pt
                   JOIN applications a ON a.id = pt.application_id WHERE pt.name ILIKE $1`;
        if (merchantId) {
          values.push(merchantId);
          sql += ` AND a.merchant_id = $${values.length}::uuid`;
        }
        values.push(Math.min(limit, 50));
        sql += ` ORDER BY pt.name ASC LIMIT $${values.length}`;
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          name: string;
          merchant_id: string;
          status: string;
        }>({
          sql,
          values,
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_pos_terminals",
        });
        return res.rows.map((row) => ({
          value: row.id,
          label: row.name,
          sublabel: row.merchant_id,
          badge: row.status,
        }));
      },
    },

    gateways: {
      sourceKey: "gateways",
      description: "Search configured payment gateways by code or name",
      valueType: "uuid",
      requiredAuthority: "gateway:read",
      search: async ({ query, limit }) => {
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          code: string;
          name: string;
          status: string;
        }>({
          sql: `SELECT id, code, name, status FROM gateways
                WHERE code ILIKE $1 OR name ILIKE $1
                ORDER BY name ASC LIMIT $2`,
          values: [like(query), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_gateways",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `${r.name} (${r.code})`,
          badge: r.status,
        }));
      },
    },

    payment_rails: {
      sourceKey: "payment_rails",
      description: "Search payment rails by code or display name",
      valueType: "uuid",
      requiredAuthority: "gateway:read",
      search: async ({ query, limit }) => {
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          code: string;
          name_en: string;
          name_ar: string;
          collection_mode: string;
        }>({
          sql: `SELECT id, code, name_en, name_ar, collection_mode FROM rails
                WHERE code ILIKE $1 OR name_en ILIKE $1 OR name_ar ILIKE $1
                ORDER BY code ASC LIMIT $2`,
          values: [like(query), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_payment_rails",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `${r.name_en} (${r.code})`,
          sublabel: r.name_ar,
          badge: r.collection_mode,
        }));
      },
    },

    gl_accounts: {
      sourceKey: "gl_accounts",
      description: "Search GL accounts by account type, owner or currency",
      valueType: "uuid",
      requiredAuthority: "finance:read",
      search: async ({ query, limit }) => {
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          account_type: string;
          owner_id: string | null;
          currency: string;
        }>({
          sql: `SELECT id, account_type, owner_id, currency FROM gl_accounts
                WHERE account_type::text ILIKE $1 OR owner_id::text ILIKE $1 OR id::text ILIKE $1
                ORDER BY account_type ASC LIMIT $2`,
          values: [like(query), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_gl_accounts",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `${r.account_type} — ${r.id.slice(0, 8)}`,
          sublabel: r.owner_id ?? "",
          badge: r.currency,
        }));
      },
    },

    currencies: {
      sourceKey: "currencies",
      description: "Supported ISO-4217 currency codes",
      valueType: "string",
      requiredAuthority: "finance:read",
      search: async (): Promise<AutocompleteItem[]> => [
        { value: "LYD", label: "LYD — Libyan Dinar (1000 Dirhams)", badge: "DEFAULT" },
        { value: "USD", label: "USD — US Dollar", badge: "FX" },
        { value: "EUR", label: "EUR — Euro", badge: "FX" },
      ],
    },

    staff_users: {
      sourceKey: "staff_users",
      description: "Search internal backoffice staff users by email or role",
      valueType: "uuid",
      requiredAuthority: "security:read",
      search: async ({ query, limit }) => {
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          email: string;
          role: string;
        }>({
          sql: `SELECT id, email, role FROM users
                WHERE merchant_id IS NULL AND email ILIKE $1
                ORDER BY email ASC LIMIT $2`,
          values: [like(query), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_staff_users",
        });
        return res.rows.map((r) => ({ value: r.id, label: r.email, badge: r.role }));
      },
    },

    aml_cases: {
      sourceKey: "aml_cases",
      description: "Search confidential AML cases (MLRO / Compliance only)",
      valueType: "uuid",
      requiredAuthority: "aml:read",
      search: async ({ query, limit, actor }) => {
        if (!hasConfidentialAmlAccess(actor)) {
          return [];
        }
        const res = await dbReadOnly.executeReadOnlyQuery<{
          id: string;
          subject_type: string;
          severity: string;
          status: string;
        }>({
          sql: `SELECT id, subject_type, severity, status FROM aml_cases
                WHERE id::text ILIKE $1
                ORDER BY created_at DESC LIMIT $2`,
          values: [like(query), Math.min(limit, 50)],
          timeoutMs: 3_000,
          maxRows: 50,
          queryLabel: "autocomplete_aml_cases",
        });
        return res.rows.map((r) => ({
          value: r.id,
          label: `Case ${r.id.slice(0, 8)} (${r.subject_type})`,
          sublabel: r.severity,
          badge: r.status,
        }));
      },
    },
  };
}
