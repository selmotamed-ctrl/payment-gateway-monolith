import { beforeEach, describe, expect, test } from "vitest";
import {
  clientSearchRegistry,
  filterAndNormalizeServerGroups,
  isRouteAccessibleToUser,
  type FrontendAccessContext,
} from "@/components/search/targets";
import {
  searchLocalGuides,
  searchLocalPages,
} from "@/components/search/localCommands";
import {
  clearRecentSearchQueries,
  getRecentSearchQueries,
  removeRecentSearchQuery,
  saveRecentSearchQuery,
} from "@/components/search/recents";
import { splitHighlightSegments } from "@/components/search/highlight";
import type { SearchResultGroup } from "@/components/search/types";

const access: FrontendAccessContext = {
  role: "SUPPORT",
  authorities: new Set(["merchants.read", "support.read_merchant"]),
  visibleRouteNames: new Set(["Merchants", "Dashboard"]),
  routesAuthorities: {
    Merchants: ["merchants.read", "support.read_merchant"],
    MerchantDetail: ["merchants.read", "support.read_merchant"],
    AmlCases: ["aml.read_confidential"],
  },
  routesRoles: {
    AmlCases: ["COMPLIANCE", "MLRO"],
  },
};

describe("client search target registry", () => {
  test("registers every built-in target with unique order", () => {
    const targets = clientSearchRegistry.getAllOrdered();
    expect(targets).toHaveLength(20);
    expect(new Set(targets.map((target) => target.type)).size).toBe(20);
    expect(new Set(targets.map((target) => target.order)).size).toBe(20);
  });

  test("resolves real route names and attempt deep links", () => {
    expect(clientSearchRegistry.get("merchant")?.primaryRouteName).toBe("MerchantDetail");
    const attempt = clientSearchRegistry.get("payment_attempt")?.resolveTarget(
      { id: "attempt-1", title: "TX-1", merchantId: "merchant-1", reference: "TX-1" },
      "TX-1",
    );
    expect(attempt).toMatchObject({
      name: "MerchantDetail",
      params: { id: "merchant-1" },
      query: { tab: "transactions", reference: "TX-1" },
    });
  });

  test("filters inaccessible groups and keeps visible targets", () => {
    const groups: SearchResultGroup[] = [
      {
        type: "merchant",
        truncated: false,
        items: [
          {
            id: "merchant-1",
            title: "Acme",
            reference: "merchant-1",
            merchantId: "merchant-1",
          },
        ],
      },
      {
        type: "aml_case",
        truncated: false,
        items: [{ id: "case-1", title: "Confidential", reference: "case-1" }],
      },
    ];

    const filtered = filterAndNormalizeServerGroups(groups, "acme", access);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.plugin.type).toBe("merchant");
    expect(filtered[0]?.items[0]?.target).toMatchObject({
      name: "MerchantDetail",
      params: { id: "merchant-1" },
    });
  });

  test("respects role and parent route visibility", () => {
    expect(isRouteAccessibleToUser("MerchantDetail", access)).toBe(true);
    expect(isRouteAccessibleToUser("AmlCases", access)).toBe(false);
    expect(
      isRouteAccessibleToUser("AmlCases", {
        ...access,
        role: "COMPLIANCE",
        authorities: new Set(["aml.read_confidential"]),
        visibleRouteNames: new Set(["AmlCases"]),
      }),
    ).toBe(true);
  });
});

describe("local search commands", () => {
  const navigation = [
    {
      title: "Onboarding",
      routes: [
        {
          title: "Merchants",
          routeName: "Merchants",
          icon: "mdi-storefront-outline",
          sectionTitle: "Onboarding",
        },
        {
          title: "KYB Review",
          routeName: "KybReview",
          icon: "mdi-file-certificate-outline",
          sectionTitle: "Onboarding",
        },
      ],
    },
    {
      title: "Operations",
      routes: [
        {
          title: "Operator Cases",
          routeName: "OperatorCases",
          icon: "mdi-lifebuoy",
          sectionTitle: "Operations",
        },
      ],
    },
  ];

  test("matches pages by title, route and section and returns quick links", () => {
    expect(searchLocalPages(navigation, "merch", "en")[0]?.title).toBe("Merchants");
    expect(searchLocalPages(navigation, "operator", "en")[0]?.title).toBe("Operator Cases");
    expect(searchLocalPages(navigation, "", "en")).toHaveLength(3);
  });

  test("maps guide entries to the guide route without injecting HTML", () => {
    const results = searchLocalGuides(
      () => [
        {
          id: "chapter-1",
          kind: "chapter",
          titleEn: "Dispute lifecycle",
          titleAr: "دورة حياة النزاع",
          bodyEn: "<script>alert(1)</script>",
          bodyAr: "",
          bookNumber: 1,
          tags: [],
        },
      ],
      "dispute",
      "en",
    );
    expect(results[0]?.target).toEqual({
      name: "AdminGuide",
      query: { entry: "chapter-1" },
    });
    expect(results[0]?.title).toBe("Dispute lifecycle");
    expect(results[0]?.subtitle).toContain("<script>");
  });
});

describe("recent search storage", () => {
  beforeEach(() => {
    clearRecentSearchQueries();
  });

  test("stores only query strings, deduplicates and caps at eight", () => {
    for (let index = 0; index < 10; index += 1) {
      saveRecentSearchQuery(`query-${index}`);
    }
    expect(getRecentSearchQueries()).toHaveLength(8);
    expect(getRecentSearchQueries()[0]).toBe("query-9");

    saveRecentSearchQuery("QUERY-9");
    expect(getRecentSearchQueries()).toHaveLength(8);
    expect(getRecentSearchQueries()[0]).toBe("QUERY-9");

    removeRecentSearchQuery("query-9");
    expect(getRecentSearchQueries()).not.toContain("QUERY-9");
  });

  test("ignores one-character queries", () => {
    saveRecentSearchQuery("a");
    expect(getRecentSearchQueries()).toEqual([]);
  });
});

describe("safe highlighting", () => {
  test("splits text into plain and highlighted segments without HTML parsing", () => {
    const segments = splitHighlightSegments("<script>alert(1)</script>", "script");
    expect(segments.map((segment) => segment.text).join("")).toBe(
      "<script>alert(1)</script>",
    );
    expect(segments.filter((segment) => segment.highlighted)).toHaveLength(2);
  });
});
