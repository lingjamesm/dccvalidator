export const CHANNELS = {
  pos: "Attended POS terminal",
  pos_unattended: "Unattended terminal (kiosk, fuel pump)",
  atm: "ATM",
  branch: "Bank branch",
  ecommerce: "E-commerce",
  mail: "Mail order",
  phone: "Telephone order",
  priority: "Priority check-out (hotel, car rental, cruise)",
  stored: "Stored credential or recurring",
} as const;

export const SCHEMES = {
  visa: "Visa",
  mastercard: "Mastercard",
} as const;

export const STATUS = {
  draft: "Draft",
  uploaded: "Awaiting validation",
  processing: "Validating",
  complete: "Complete",
  failed: "Failed",
} as const;

export type Submission = {
  id: string;
  owner_id: string;
  entry_id: string;
  version: number;
  title: string;
  channel: keyof typeof CHANNELS;
  merchant_country?: string | null;
  schemes: (keyof typeof SCHEMES)[];
  status: keyof typeof STATUS;
  created_at: string;
  scores?: ValidationResult["schemes"] | null;
};

export const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

export const VERDICTS = {
  compliant: "Compliant",
  not_compliant: "Not compliant",
  needs_review: "Needs review",
  no_rules: "No rules apply",
} as const;

export const OUTCOMES = {
  pass: "Pass",
  fail: "Fail",
  needs_review: "Needs review",
  not_applicable: "Not applicable",
} as const;

export const RULE_TYPES = {
  MUST: "Must",
  MUST_NOT: "Must not",
  SHOULD: "Should (advisory)",
  MAY: "May (permitted option)",
  INFO: "Information",
} as const;

export type SchemeScore = {
  score: number | null;
  verdict: keyof typeof VERDICTS;
  passed: number;
  failed: number;
  needs_review: number;
  rules: number;
  unverified_rules: number;
  advisory_failed?: number;
  not_applicable?: number;
  not_checked?: number;
};

export type NotChecked = {
  code: string;
  scheme: keyof typeof SCHEMES;
  title: string;
  rule_type: keyof typeof RULE_TYPES;
  evaluates: string;
  source: string;
};

export type Finding = {
  rule_id: string;
  code: string;
  scheme: keyof typeof SCHEMES;
  title: string;
  requirement: string;
  source: string;
  severity: "critical" | "major" | "minor";
  weight: number;
  verified: boolean;
  check_type: "fact" | "judgement";
  rule_type?: keyof typeof RULE_TYPES;
  domain?: string;
  sort?: number;
  outcome: keyof typeof OUTCOMES;
  evidence: string;
  document: number | null;
};

export type ValidationResult = {
  error?: string;
  validated_at?: string;
  rule_set?: { number: number; title?: string; as_of?: string | null };
  overview?: string;
  documents?: { file_id: string; name: string; kind: string; description: string }[];
  schemes?: Partial<Record<keyof typeof SCHEMES, SchemeScore>>;
  findings?: Finding[];
  not_checked?: NotChecked[];
};

export const scoreLine = (s: SchemeScore) =>
  `${VERDICTS[s.verdict]}${s.score === null ? "" : ` · ${s.score}%`}`;
