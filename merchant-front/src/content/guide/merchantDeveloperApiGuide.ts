import type { DeveloperChapter } from "./types";

export const MERCHANT_DEVELOPER_CHAPTERS: DeveloperChapter[] = [
    {
        "id": "D-01",
        "number": "D-01",
        "titleEn": "How the API Works From Zero (For Beginners & Architects)",
        "bodyEn": "If your company has an online store, mobile app, hospital billing system, or ERP (like Odoo, WooCommerce, Laravel, or a custom Node/Python app), you can automate payment link creation and payment verification so no human has to click buttons in the portal:\n\n```text\n1. Customer clicks \"Checkout (150.000 LYD)\" on Your Website\n       │\n       ▼\n2. Your Backend Server calls:  POST https://merchant.<domain>/api/v1/external/links\n   (Using your secret `pg_live_...` Bearer Token + Amount: \"150.000\")\n       │\n       ▼\n3. Our Platform returns:       { \"key\": \"lnk_01J...\", \"checkoutUrl\": \"https://pay.<domain>/pay/lnk_01J...\" }\n       │\n       ▼\n4. Your Website sends the Customer to `checkoutUrl` (where they pay with Sadad, Edfali, Moamalat, LYPay, etc.)\n       │\n       ▼\n5. When the Customer finishes, Your Backend Server verifies the truth by calling:\n   GET https://merchant.<domain>/api/v1/external/links/lnk_01J...\n   (or GET /api/v1/external/payments/:reference) — and ONLY marks the order paid when `state === \"COMPLETED\"` / `status === \"SUCCEEDED\"`!\n```\n\n---",
        "tags": [
            "api",
            "works",
            "zero",
            "beginners",
            "architects",
            "company",
            "online",
            "store",
            "mobile",
            "app",
            "hospital",
            "billing",
            "system",
            "erp"
        ]
    },
    {
        "id": "D-02",
        "number": "D-02",
        "titleEn": "Authentication (`pg_live_` Bearer Tokens) & IP CIDR Allowlists (`/developers/tokens`)",
        "bodyEn": "#### 1. Creating Your API Access Token\n1. In the Merchant Portal, open **Developers -> API Tokens (`/developers/tokens`)** and click **Create Token**.\n2. Select the **Application** this token will belong to, and select the minimum required **Scopes** (`links:create`, `links:read`, `links:cancel`, `payments:read`).\n3. Copy your token immediately (it starts with **`pg_live_`** followed by 32 random base64url bytes).\n   - **Why can't I view the token again later?** For your security, our database never stores your plaintext token—it stores only a one-way `SHA-256` hash (`token_hash`) and the last 4 characters (`last_four`). If you lose the token, revoke it and create a new one.\n4. **NEVER put a `pg_live_` token inside frontend browser JavaScript, a React/Vue bundle, or a mobile APK!** `pg_live_` tokens must only be called from your own backend server.\n\n#### 2. Locking Your Token to Your Server's IP Address (`ip_whitelist_enabled`)\nTo make a stolen token useless to an attacker, enable **IP Whitelist (`ip_whitelist_enabled = true`)** and add your backend server's static public IP in CIDR notation:\n- Single server IP example: `203.0.113.45/32`\n- Subnet example: `203.0.113.0/24`\nIf any request arrives with your token from an IP address outside your CIDR list, our edge and core guards reject it immediately with `403 IP_NOT_ALLOWLISTED`.\n\n---",
        "tags": [
            "authentication",
            "live",
            "bearer",
            "tokens",
            "cidr",
            "allowlists",
            "developers",
            "creating",
            "api",
            "access",
            "token",
            "merchant",
            "portal",
            "open"
        ]
    },
    {
        "id": "D-03",
        "number": "D-03",
        "titleEn": "Money Precision Rules & Redirect Allowlists (Avoid These 3 Common Mistakes)",
        "bodyEn": "1. **Always Send Amounts as Decimal Strings (Never Floats!):**\n   - Libyan Dinars have **3 decimal places (Dirhams)**, and our ledger uses `DECIMAL(18,4)`.\n   - Always pass amounts as strings like `\"150.000\"` or `\"76.255\"`, **never** JavaScript floats like `150.00000000000003`.\n2. **`redirectUrl` Rules:**\n   - A custom `redirectUrl` is permitted **only on Single-Use links** (`infiniteUse: false, useCount: 1`).\n   - The hostname of `redirectUrl` (e.g., `https://shop.yourcompany.ly/orders/4092/return`) **must** be pre-registered in your Application's `redirect_domain_allowlist` in `/applications`, otherwise link creation will fail with `400 REDIRECT_DOMAIN_NOT_ALLOWED`.\n3. **Never Trust the Browser Return Alone:**\n   - When the customer's browser lands back on your `redirectUrl`, treat that page load only as a trigger for your backend server to call `GET /api/v1/external/links/:key` (or `GET /api/v1/external/payments/:reference`). Only fulfill the order when our API returns `state: \"COMPLETED\"` and the attempt `status: \"SUCCEEDED\"`.\n\n---",
        "tags": [
            "money",
            "precision",
            "rules",
            "redirect",
            "allowlists",
            "avoid",
            "these",
            "common",
            "mistakes",
            "always",
            "send",
            "amounts",
            "decimal",
            "strings"
        ]
    },
    {
        "id": "D-04",
        "number": "D-04",
        "titleEn": "Complete Endpoint Reference (`/api/v1/external/*`)",
        "bodyEn": "#### Endpoint 1: Create a Payment Link — `POST /api/v1/external/links`\n- **Required Header:** `Authorization: Bearer pg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`\n- **Request Body Schema:**\n```json\n{\n  \"applicationId\": \"0192d4a0-7c10-7000-8000-000000000001\",\n  \"amount\": \"150.000\",\n  \"currency\": \"LYD\",\n  \"feeBearer\": \"MERCHANT_ABSORBS\",\n  \"infiniteUse\": false,\n  \"useCount\": 1,\n  \"redirectUrl\": \"https://shop.yourcompany.ly/checkout/return?orderId=ORD-9012\",\n  \"railWhitelist\": null,\n  \"expiresAt\": \"2026-11-01T18:00:00.000Z\"\n}\n```\n- **Success Response (`201 Created`):**\n```json\n{\n  \"id\": \"0192d8f0-1122-7000-8000-000000000099\",\n  \"key\": \"lnk_0192d8f0112270008000000000000099\",\n  \"checkoutUrl\": \"https://pay.yourdomain.ly/pay/lnk_0192d8f0112270008000000000000099\",\n  \"amount\": \"150.0000\",\n  \"currency\": \"LYD\",\n  \"feeBearer\": \"MERCHANT_ABSORBS\",\n  \"state\": \"PENDING\",\n  \"confirmedCount\": 0,\n  \"activeLockedCount\": 0,\n  \"expiresAt\": \"2026-11-01T18:00:00.000Z\"\n}\n```\n\n#### Endpoint 2: Get Link & Attempts Status — `GET /api/v1/external/links/:key`\n- Returns the current link `state` (`PENDING | COMPLETED | EXPIRED | CANCELLED`), slot counters (`confirmedCount`, `activeLockedCount`), and the array of attempts with their `reference`, `status`, `railCode`, `requestedAmount`, `surchargeAmount`, `totalChargedAmount`, `platformCommissionAmount`, `netMerchantAmount`, and `terminalAt`.\n\n#### Endpoint 3: Get Single Payment Attempt by Reference — `GET /api/v1/external/payments/:reference`\n- Looks up a specific attempt by its unique platform reference (`reference`) and returns its authoritative status and settlement breakdown.\n\n#### Endpoint 4: Cancel an Unpaid Payment Link — `POST /api/v1/external/links/:key/cancel`\n- Cancels a `PENDING` link as long as no attempt is currently past the point of no return.\n\n---",
        "tags": [
            "complete",
            "endpoint",
            "reference",
            "api",
            "external",
            "create",
            "payment",
            "link",
            "post",
            "links",
            "required",
            "header",
            "authorization",
            "bearer"
        ]
    },
    {
        "id": "D-05",
        "number": "D-05",
        "titleEn": "Copy-Pasteable Production Code Templates (Interactive Code Generator)",
        "bodyEn": "The interactive widget in `/guide/developers` pre-fills your selected `applicationId` and generates ready-to-run code in 4 languages:\n\n#### 1. TypeScript / Node.js / Bun\n```ts\nconst PG_BASE_URL = \"https://merchant.yourdomain.ly/api/v1/external\";\nconst PG_API_TOKEN = process.env.PG_LIVE_TOKEN!; // pg_live_...\n\nexport async function createCheckoutLink(orderId: string, amountLyd: string) {\n  const response = await fetch(`${PG_BASE_URL}/links`, {\n    method: \"POST\",\n    headers: {\n      \"Authorization\": `Bearer ${PG_API_TOKEN}`,\n      \"Content-Type\": \"application/json\",\n    },\n    body: JSON.stringify({\n      applicationId: process.env.PG_APPLICATION_ID!,\n      amount: amountLyd, // Always pass a decimal string, e.g. \"150.000\"\n      currency: \"LYD\",\n      feeBearer: \"MERCHANT_ABSORBS\",\n      infiniteUse: false,\n      useCount: 1,\n      redirectUrl: `https://shop.yourcompany.ly/orders/${encodeURIComponent(orderId)}/verify`,\n    }),\n  });\n\n  if (!response.ok) {\n    const err = await response.json();\n    throw new Error(`Payment Gateway Error [${err.code}]: ${err.message}`);\n  }\n  return (await response.json()) as { key: string; checkoutUrl: string; state: string };\n}\n\nexport async function isLinkPaidAndConfirmed(linkKey: string): Promise<boolean> {\n  const response = await fetch(`${PG_BASE_URL}/links/${encodeURIComponent(linkKey)}`, {\n    headers: { \"Authorization\": `Bearer ${PG_API_TOKEN}` },\n  });\n  if (!response.ok) return false;\n  const link = await response.json();\n  return link.state === \"COMPLETED\" && Number(link.confirmedCount) >= 1;\n}\n```\n\n#### 2. PHP (Laravel / Guzzle)\n```php\n<?php\nuse Illuminate\\Support\\Facades\\Http;\n\nclass PaymentGatewayClient {\n    public function createSingleUseLink(string $orderId, string $amountLyd): array {\n        $response = Http::withToken(config('services.payment_gateway.token'))\n            ->acceptJson()\n            ->post(config('services.payment_gateway.base_url') . '/links', [\n                'applicationId' => config('services.payment_gateway.app_id'),\n                'amount'        => $amountLyd, // e.g. \"150.000\"\n                'currency'      => 'LYD',\n                'feeBearer'     => 'MERCHANT_ABSORBS',\n                'infiniteUse'   => false,\n                'useCount'      => 1,\n                'redirectUrl'   => route('checkout.verify', ['orderId' => $orderId]),\n            ]);\n\n        $response->throw();\n        return $response->json();\n    }\n}\n```\n\n#### 3. Python (`httpx` / FastAPI / Django)\n```python\nimport os\nimport httpx\n\nPG_BASE_URL = \"https://merchant.yourdomain.ly/api/v1/external\"\nPG_TOKEN = os.environ[\"PG_LIVE_TOKEN\"]\n\nasync def create_payment_link(order_id: str, amount_lyd: str) -> dict:\n    async with httpx.AsyncClient(timeout=15.0) as client:\n        res = await client.post(\n            f\"{PG_BASE_URL}/links\",\n            headers={\"Authorization\": f\"Bearer {PG_TOKEN}\"},\n            json={\n                \"applicationId\": os.environ[\"PG_APPLICATION_ID\"],\n                \"amount\": amount_lyd,\n                \"currency\": \"LYD\",\n                \"feeBearer\": \"MERCHANT_ABSORBS\",\n                \"infiniteUse\": False,\n                \"useCount\": 1,\n                \"redirectUrl\": f\"https://shop.yourcompany.ly/orders/{order_id}/verify\",\n            },\n        )\n        res.raise_for_status()\n        return res.json()\n```\n\n---",
        "tags": [
            "copy-pasteable",
            "production",
            "code",
            "templates",
            "interactive",
            "generator",
            "widget",
            "guide",
            "developers",
            "pre-fills",
            "selected",
            "applicationid",
            "generates",
            "ready-to-run"
        ],
        "codeTemplates": {
            "typescript": "const PG_BASE_URL = \"https://merchant.yourdomain.ly/api/v1/external\";\nconst PG_API_TOKEN = process.env.PG_LIVE_TOKEN!; // pg_live_...\n\nexport async function createCheckoutLink(orderId: string, amountLyd: string) {\n  const response = await fetch(`${PG_BASE_URL}/links`, {\n    method: \"POST\",\n    headers: {\n      \"Authorization\": `Bearer ${PG_API_TOKEN}`,\n      \"Content-Type\": \"application/json\",\n    },\n    body: JSON.stringify({\n      applicationId: process.env.PG_APPLICATION_ID!,\n      amount: amountLyd, // Always pass a decimal string, e.g. \"150.000\"\n      currency: \"LYD\",\n      feeBearer: \"MERCHANT_ABSORBS\",\n      infiniteUse: false,\n      useCount: 1,\n      redirectUrl: `https://shop.yourcompany.ly/orders/${encodeURIComponent(orderId)}/verify`,\n    }),\n  });\n\n  if (!response.ok) {\n    const err = await response.json();\n    throw new Error(`Payment Gateway Error [${err.code}]: ${err.message}`);\n  }\n  return (await response.json()) as { key: string; checkoutUrl: string; state: string };\n}\n\nexport async function isLinkPaidAndConfirmed(linkKey: string): Promise<boolean> {\n  const response = await fetch(`${PG_BASE_URL}/links/${encodeURIComponent(linkKey)}`, {\n    headers: { \"Authorization\": `Bearer ${PG_API_TOKEN}` },\n  });\n  if (!response.ok) return false;\n  const link = await response.json();\n  return link.state === \"COMPLETED\" && Number(link.confirmedCount) >= 1;\n}\n",
            "php": "<?php\nuse Illuminate\\Support\\Facades\\Http;\n\nclass PaymentGatewayClient {\n    public function createSingleUseLink(string $orderId, string $amountLyd): array {\n        $response = Http::withToken(config('services.payment_gateway.token'))\n            ->acceptJson()\n            ->post(config('services.payment_gateway.base_url') . '/links', [\n                'applicationId' => config('services.payment_gateway.app_id'),\n                'amount'        => $amountLyd, // e.g. \"150.000\"\n                'currency'      => 'LYD',\n                'feeBearer'     => 'MERCHANT_ABSORBS',\n                'infiniteUse'   => false,\n                'useCount'      => 1,\n                'redirectUrl'   => route('checkout.verify', ['orderId' => $orderId]),\n            ]);\n\n        $response->throw();\n        return $response->json();\n    }\n}\n",
            "python": "import os\nimport httpx\n\nPG_BASE_URL = \"https://merchant.yourdomain.ly/api/v1/external\"\nPG_TOKEN = os.environ[\"PG_LIVE_TOKEN\"]\n\nasync def create_payment_link(order_id: str, amount_lyd: str) -> dict:\n    async with httpx.AsyncClient(timeout=15.0) as client:\n        res = await client.post(\n            f\"{PG_BASE_URL}/links\",\n            headers={\"Authorization\": f\"Bearer {PG_TOKEN}\"},\n            json={\n                \"applicationId\": os.environ[\"PG_APPLICATION_ID\"],\n                \"amount\": amount_lyd,\n                \"currency\": \"LYD\",\n                \"feeBearer\": \"MERCHANT_ABSORBS\",\n                \"infiniteUse\": False,\n                \"useCount\": 1,\n                \"redirectUrl\": f\"https://shop.yourcompany.ly/orders/{order_id}/verify\",\n            },\n        )\n        res.raise_for_status()\n        return res.json()\n",
            "curl": "curl -X POST \"https://merchant.yourdomain.ly/api/v1/external/links\" \\\n  -H \"Authorization: Bearer pg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\n    \"applicationId\": \"0192d4a0-7c10-7000-8000-000000000001\",\n    \"amount\": \"150.000\",\n    \"currency\": \"LYD\",\n    \"feeBearer\": \"MERCHANT_ABSORBS\",\n    \"infiniteUse\": false,\n    \"useCount\": 1,\n    \"redirectUrl\": \"https://shop.yourcompany.ly/orders/ORD-9012/verify\"\n  }'\n\ncurl \"https://merchant.yourdomain.ly/api/v1/external/links/lnk_0192d8f0112270008000000000000099\" \\\n  -H \"Authorization: Bearer pg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\"\n\ncurl \"https://merchant.yourdomain.ly/api/v1/external/payments/PAY-REF-1001\" \\\n  -H \"Authorization: Bearer pg_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\""
        }
    }
];
