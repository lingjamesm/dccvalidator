// Rule library types and labels, shared by server pages and client forms.

export type RuleSet = {
  id: string;
  number: number;
  status: "draft" | "published" | "retired";
  notes: string;
  created_at: string;
  published_at: string | null;
};

export type Rule = {
  id: string;
  rule_set_id: string;
  code: string;
  scheme: "visa" | "mastercard";
  channels: ("pos" | "atm" | "ecommerce")[];
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
