import type { MetricSpec } from "./semantic-schema";

export type MetricCapability = "direct" | "derivable" | "unsupported";

export type DirectMetricName =
  | "revenue"
  | "net_income"
  | "assets"
  | "liabilities"
  | "equity"
  | "cash"
  | "debt"
  | "eps";

export type MetricFactRequirement = {
  metric: DirectMetricName;
  /** Alternatives accepted for this fact; at least one must be returned. */
  secConcepts: readonly string[];
  minimumObservations: 1 | 2;
};

export type MetricDerivation = {
  kind: "ratio" | "absolute_change" | "percentage_change" | "growth";
  formula: string;
};

export type MetricCapabilityResolution = {
  metricId: string;
  requestedName: string;
  normalizedName: string;
  canonicalName?: string;
  capability: MetricCapability;
  /**
   * SEC concepts the planner should request. For a fact requirement containing
   * alternatives, the provider only needs to return one of those alternatives.
   */
  requiredConcepts: readonly string[];
  factRequirements: readonly MetricFactRequirement[];
  derivation?: MetricDerivation;
  reason?: string;
};

type DirectMetricDefinition = {
  aliases: readonly string[];
  secConcepts: readonly string[];
};

const DIRECT_METRICS: Readonly<
  Record<DirectMetricName, DirectMetricDefinition>
> = {
  revenue: {
    aliases: ["revenue", "revenues", "sales", "net sales", "total revenue"],
    secConcepts: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
    ],
  },
  net_income: {
    aliases: [
      "net income",
      "net earnings",
      "net profit",
      "profit",
      "earnings",
    ],
    secConcepts: ["NetIncomeLoss", "ProfitLoss"],
  },
  assets: {
    aliases: ["assets", "total assets"],
    secConcepts: ["Assets"],
  },
  liabilities: {
    aliases: ["liabilities", "total liabilities"],
    secConcepts: ["Liabilities"],
  },
  equity: {
    aliases: [
      "equity",
      "book equity",
      "shareholder equity",
      "shareholders equity",
      "stockholder equity",
      "stockholders equity",
      "total equity",
    ],
    secConcepts: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
  },
  cash: {
    aliases: [
      "cash",
      "cash equivalents",
      "cash and cash equivalents",
      "cash position",
    ],
    secConcepts: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
  },
  debt: {
    aliases: [
      "debt",
      "borrowings",
      "long term debt",
      "total borrowings",
      "total debt",
    ],
    secConcepts: [
      "LongTermDebt",
      "LongTermDebtCurrent",
      "LongTermDebtNoncurrent",
      "ShortTermBorrowings",
      "ShortTermDebt",
    ],
  },
  eps: {
    aliases: [
      "basic earnings per share",
      "basic eps",
      "diluted earnings per share",
      "diluted eps",
      "earnings per share",
      "eps",
    ],
    secConcepts: ["EarningsPerShareBasic", "EarningsPerShareDiluted"],
  },
};

type RatioDefinition = {
  aliases: readonly string[];
  canonicalName: string;
  numerator: DirectMetricName;
  denominator: DirectMetricName;
};

const RATIOS: readonly RatioDefinition[] = [
  {
    aliases: ["debt equity ratio", "debt to equity", "debt to equity ratio"],
    canonicalName: "debt_to_equity",
    numerator: "debt",
    denominator: "equity",
  },
  {
    aliases: [
      "liabilities assets ratio",
      "liabilities to assets",
      "liabilities to assets ratio",
      "liability to asset ratio",
    ],
    canonicalName: "liabilities_to_assets",
    numerator: "liabilities",
    denominator: "assets",
  },
  {
    aliases: ["net margin", "net profit margin", "profit margin"],
    canonicalName: "net_margin",
    numerator: "net_income",
    denominator: "revenue",
  },
];

const DIRECT_ALIAS_INDEX = new Map<string, DirectMetricName>(
  Object.entries(DIRECT_METRICS).flatMap(([metric, definition]) =>
    definition.aliases.map((alias) => [alias, metric as DirectMetricName])
  )
);

const RATIO_ALIAS_INDEX = new Map<string, RatioDefinition>(
  RATIOS.flatMap((definition) =>
    definition.aliases.map((alias) => [alias, definition])
  )
);

/**
 * Normalizes model-produced metric labels without fuzzy substring matching.
 * Exact aliases are intentional so custom scores cannot silently become SEC
 * fundamentals just because their labels contain words such as "revenue".
 */
export function normalizeSemanticMetricName(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function factRequirement(
  metric: DirectMetricName,
  minimumObservations: 1 | 2
): MetricFactRequirement {
  return {
    metric,
    secConcepts: DIRECT_METRICS[metric].secConcepts,
    minimumObservations,
  };
}

function requiredConcepts(
  requirements: readonly MetricFactRequirement[]
): string[] {
  return [
    ...new Set(requirements.flatMap((requirement) => requirement.secConcepts)),
  ];
}

function unsupported(
  metric: Pick<MetricSpec, "id" | "name">,
  normalizedName: string,
  reason: string
): MetricCapabilityResolution {
  return {
    metricId: metric.id,
    requestedName: metric.name,
    normalizedName,
    capability: "unsupported",
    requiredConcepts: [],
    factRequirements: [],
    reason,
  };
}

function direct(
  metric: Pick<MetricSpec, "id" | "name">,
  normalizedName: string,
  canonicalName: DirectMetricName
): MetricCapabilityResolution {
  const factRequirements = [factRequirement(canonicalName, 1)];
  return {
    metricId: metric.id,
    requestedName: metric.name,
    normalizedName,
    canonicalName,
    capability: "direct",
    requiredConcepts: requiredConcepts(factRequirements),
    factRequirements,
  };
}

function derived(
  metric: Pick<MetricSpec, "id" | "name">,
  normalizedName: string,
  canonicalName: string,
  derivation: MetricDerivation,
  factRequirements: readonly MetricFactRequirement[]
): MetricCapabilityResolution {
  if (
    factRequirements.length === 0 ||
    factRequirements.some((requirement) => requirement.secConcepts.length === 0)
  ) {
    return unsupported(
      metric,
      normalizedName,
      "The required structured facts are not fetchable."
    );
  }
  return {
    metricId: metric.id,
    requestedName: metric.name,
    normalizedName,
    canonicalName,
    capability: "derivable",
    requiredConcepts: requiredConcepts(factRequirements),
    factRequirements,
    derivation,
  };
}

function growthBaseName(normalizedName: string): string {
  return normalizedName.replace(
    /\s+(?:absolute change|percentage change|percent change|growth rate|growth|change)$/,
    ""
  );
}

/**
 * Resolves provider capability only. A derivable result means the planner can
 * request every required fact; callers must still verify that the issuer
 * returned compatible observations before computing or publishing a value.
 */
export function resolveMetricCapability(
  metric: Pick<MetricSpec, "id" | "name" | "operation">
): MetricCapabilityResolution {
  const normalizedName = normalizeSemanticMetricName(metric.name);
  const ratio = RATIO_ALIAS_INDEX.get(normalizedName);
  if (ratio) {
    return derived(
      metric,
      normalizedName,
      ratio.canonicalName,
      {
        kind: "ratio",
        formula: `${ratio.numerator} / ${ratio.denominator}`,
      },
      [
        factRequirement(ratio.numerator, 1),
        factRequirement(ratio.denominator, 1),
      ]
    );
  }

  const baseName =
    metric.operation === "growth" ||
    metric.operation === "percentage_change" ||
    metric.operation === "absolute_change"
      ? growthBaseName(normalizedName)
      : normalizedName;
  const directMetric = DIRECT_ALIAS_INDEX.get(baseName);
  if (!directMetric) {
    return unsupported(
      metric,
      normalizedName,
      "No current structured provider mapping exists for this metric."
    );
  }

  if (
    metric.operation === "growth" ||
    metric.operation === "percentage_change" ||
    metric.operation === "absolute_change"
  ) {
    const kind = metric.operation;
    return derived(
      metric,
      normalizedName,
      `${directMetric}_${kind}`,
      {
        kind,
        formula:
          kind === "absolute_change"
            ? "current - prior"
            : kind === "growth"
              ? "(current - prior) / prior"
              : "(current - prior) / prior * 100",
      },
      [factRequirement(directMetric, 2)]
    );
  }

  if (metric.operation !== "level") {
    return unsupported(
      metric,
      normalizedName,
      `The ${metric.operation} operation is not supported for this metric.`
    );
  }
  return direct(metric, normalizedName, directMetric);
}

export function resolveMetricCapabilities(
  metrics: readonly Pick<MetricSpec, "id" | "name" | "operation">[]
): MetricCapabilityResolution[] {
  return metrics.map(resolveMetricCapability);
}

/** Used only for a general fundamentals need with no explicit metric. */
export const DEFAULT_SEC_FACT_CONCEPTS: readonly string[] = requiredConcepts([
  factRequirement("revenue", 1),
  factRequirement("net_income", 1),
  factRequirement("assets", 1),
  factRequirement("liabilities", 1),
]);
