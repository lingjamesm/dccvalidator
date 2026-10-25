export const CHANNELS = {
  pos: "POS terminal",
  atm: "ATM",
  ecommerce: "E-commerce",
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

export const OUTCOMES = { pass: "Pass", fail: "Fail", needs_review: "Needs review" } as const;

export type SchemeScore = {
  score: number | null;
  verdict: keyof typeof VERDICTS;
  passed: number;
  failed: number;
  needs_review: number;
  rules: number;
  unverified_rules: number;
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
  outcome: keyof typeof OUTCOMES;
  evidence: string;
  document: number | null;
};

export type ValidationResult = {
  error?: string;
  validated_at?: string;
  rule_set?: { number: number };
  overview?: string;
  documents?: { file_id: string; name: string; kind: string; description: string }[];
  schemes?: Partial<Record<keyof typeof SCHEMES, SchemeScore>>;
  findings?: Finding[];
};

export const scoreLine = (s: SchemeScore) =>
  `${VERDICTS[s.verdict]}${s.score === null ? "" : ` · ${s.score}%`}`;
