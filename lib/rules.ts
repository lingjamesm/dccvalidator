// Rule library types and labels, shared by server pages and client forms.

export type RuleSet = {
  id: string;
  number: number;
  status: "draft" | "published" | "retired";
  notes: string;
  created_at: string;
  published_at: string | null;
  origin: "starter" | "manual" | "import";
  title: string;
  as_of: string | null;
  file_name: string | null;
  document: RulesetDocument | null;
};

// Everything an imported JSON file carries apart from its rules. Each list is
// shown as a table in the admin view, whatever columns it has.
export type RulesetDocument = {
  metadata?: Record<string, unknown>;
  engine_notes?: Record<string, unknown>;
  environments?: Record<string, string>;
  sources?: Record<string, string>;
  change_log?: Record<string, unknown>[];
  gaps_and_open_issues?: Record<string, unknown>[];
  review_log?: Record<string, unknown>[];
  citation_check?: Record<string, unknown>[];
  [key: string]: unknown;
};

export type Rule = {
  id: string;
  rule_set_id: string;
  code: string;
  scheme: "visa" | "mastercard";
  environments: string[];
  excluded_environments: string[];
  rule_type: "MUST" | "MUST_NOT" | "SHOULD" | "MAY" | "INFO";
  domain: string;
  evaluates: string;
  effective: string;
  rule_status: "ACTIVE" | "FUTURE" | "EXPIRED" | "EXPIRED_PARTIAL";
  valid_from: string | null;
  valid_to: string | null;
  region_scope: string;
  group_code: string | null;
  source_notes: string;
  basis: string;
  title: string;
  requirement: string;
  source_reference: string;
  check_type: "fact" | "judgement";
  fact_key: string | null;
  expected: "yes" | "no" | "at_least" | "at_most" | null;
  threshold: number | null;
  severity: "critical" | "major" | "minor";
  weight: number;
  verified: boolean;
  active: boolean;
  notes: string;
  sort: number;
};

export type Fact = {
  key: string;
  document: "choice_screen" | "receipt" | "any";
  question: string;
  kind: "yes_no" | "number";
  sort: number;
};

export const DOCUMENTS = { choice_screen: "Choice screen", receipt: "Receipt", any: "Any document" } as const;
export const SEVERITIES = { critical: "Critical", major: "Major", minor: "Minor" } as const;
export const EXPECTED = { yes: "Yes", no: "No", at_least: "At least", at_most: "At most" } as const;

// Environments the ruleset distinguishes. ALL means every environment.
export const ENVIRONMENTS = {
  ALL: "All environments",
  POS_ATTENDED: "Attended POS",
  POS_UNATTENDED: "Unattended terminal",
  ATM: "ATM",
  BRANCH: "Bank branch",
  ECOM: "E-commerce",
  MAIL: "Mail order",
  PHONE: "Telephone order",
  PRIORITY: "Priority check-out",
  STORED: "Stored credential",
} as const;

export const RULE_STATUS = {
  ACTIVE: "In force",
  FUTURE: "Future",
  EXPIRED: "Expired",
  EXPIRED_PARTIAL: "Partly expired",
} as const;

export const ORIGINS = { starter: "Starter rules", manual: "Edited in the app", import: "Imported file" } as const;

// What uploads can show (mirrors the worker's engine.CHECKABLE).
const CHECKABLE = ["SCREEN", "RECEIPT", "FLOW", "AGREEMENT", "CLASSIFICATION", "SCRIPT"];
export const checkableFromUploads = (evaluates: string) =>
  (evaluates || "SCREEN")
    .split("/")
    .map((p) => p.trim().toUpperCase())
    .some((p) => CHECKABLE.some((c) => p.startsWith(c)));

export const environmentsLabel = (envs: string[]) =>
  envs.includes("ALL")
    ? "All"
    : envs.map((e) => ENVIRONMENTS[e as keyof typeof ENVIRONMENTS] ?? e).join(", ");
