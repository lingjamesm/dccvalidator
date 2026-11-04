// Checks an uploaded ruleset JSON file before it is imported, and rebuilds the
// same shape for download. The database repeats the essential checks.

import { ENVIRONMENTS, type Rule, type RuleSet } from "@/lib/rules";

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_RULES = 5000;
const NETWORKS = ["VISA", "MC"];
const TYPES = ["MUST", "MUST_NOT", "SHOULD", "MAY", "INFO"];
const STATUSES = ["ACTIVE", "FUTURE", "EXPIRED", "EXPIRED_PARTIAL"];
const CODE = /^[A-Z0-9][A-Z0-9.-]{0,39}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type FileCheck = {
  doc?: Record<string, unknown> & { rules: Record<string, unknown>[] };
  errors: string[];
  warnings: string[];
};

const isList = (v: unknown): v is unknown[] => Array.isArray(v);
const isText = (v: unknown) => typeof v === "string";
const optionalText = (v: unknown) => v === undefined || v === null || typeof v === "string";

export function checkRulesetFile(text: string): FileCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { errors: [`The file is not valid JSON: ${(e as Error).message}`], warnings };
  }
  if (!parsed || typeof parsed !== "object" || isList(parsed)) {
    return { errors: ["The file should hold one JSON object with a \"rules\" list."], warnings };
  }
  const doc = parsed as Record<string, unknown>;
  const rules = doc.rules;
  if (!isList(rules) || rules.length === 0) return { errors: ["The file has no \"rules\" list."], warnings };
  if (rules.length > MAX_RULES) return { errors: [`The file has more than ${MAX_RULES} rules.`], warnings };

  const known = new Set(Object.keys(ENVIRONMENTS));
  const fromFile = doc.environments;
  if (fromFile && typeof fromFile === "object" && !isList(fromFile)) {
    const extra = Object.keys(fromFile).filter((e) => !known.has(e));
    if (extra.length) {
      errors.push(
        `The file defines environments the app does not know yet: ${extra.join(", ")}. Ask for the app to be updated first.`,
      );
    }
  }

  const seen = new Set<string>();
  rules.forEach((raw, i) => {
    const where = `Rule ${i + 1}`;
    if (!raw || typeof raw !== "object" || isList(raw)) {
      errors.push(`${where} is not an object.`);
      return;
    }
    const r = raw as Record<string, unknown>;
    const id = isText(r.id) ? (r.id as string) : "";
    const name = id ? `${where} (${id})` : where;
    const problems: string[] = [];

    if (!id) problems.push("has no id");
    else if (!CODE.test(id)) problems.push("has an id that is not capital letters, digits, dots and dashes (40 at most)");
    else if (seen.has(id)) problems.push("repeats an id used earlier in the file");
    seen.add(id);

    if (!NETWORKS.includes(r.network as string)) problems.push(`has network ${JSON.stringify(r.network)} (expected VISA or MC)`);
    if (!TYPES.includes(r.type as string)) problems.push(`has type ${JSON.stringify(r.type)} (expected ${TYPES.join(", ")})`);
    const assertion = isText(r.assertion) ? (r.assertion as string).trim() : "";
    if (assertion.length < 5) problems.push("has no assertion");
    else if (assertion.length > 2000) problems.push("has an assertion longer than 2000 characters");

    for (const key of ["environments", "excluded_environments"] as const) {
      const v = r[key];
      if (key === "excluded_environments" && (v === undefined || v === null)) continue;
      if (!isList(v) || !v.every(isText)) {
        problems.push(`has ${key} that is not a list of codes`);
        continue;
      }
      if (key === "environments" && v.length === 0) problems.push("has an empty environments list");
      const unknown = (v as string[]).filter((e) => !known.has(e));
      if (unknown.length) problems.push(`names unknown ${key.replace("_", " ")} ${unknown.join(", ")}`);
    }
    if (r.status !== undefined && r.status !== null && r.status !== "" && !STATUSES.includes(r.status as string)) {
      problems.push(`has status ${JSON.stringify(r.status)} (expected ${STATUSES.join(", ")})`);
    }
    for (const key of ["valid_from", "valid_to"] as const) {
      const v = r[key];
      if (v !== undefined && v !== null && v !== "" && !(isText(v) && DAY.test(v as string))) {
        problems.push(`has ${key} ${JSON.stringify(v)} (expected YYYY-MM-DD)`);
      }
    }
    if (r.status === "FUTURE" && !r.valid_from) problems.push("is FUTURE but has no valid_from date");
    for (const key of ["domain", "evaluates", "source", "effective", "notes", "region_scope", "group", "basis"]) {
      if (!optionalText(r[key])) problems.push(`has ${key} that is not text`);
    }
    if (problems.length) errors.push(`${name} ${problems.join("; ")}.`);
  });

  const meta = doc.metadata as Record<string, unknown> | undefined;
  if (!meta || typeof meta.title !== "string") warnings.push("The file has no metadata title; it will be called \"Imported ruleset\".");
  if (meta && meta.rule_count !== undefined && meta.rule_count !== rules.length) {
    warnings.push(`The metadata says ${meta.rule_count} rules but the file has ${rules.length}.`);
  }
  if (meta && meta.as_of !== undefined && !(isText(meta.as_of) && DAY.test(meta.as_of as string))) {
    warnings.push("The metadata as_of date is not in YYYY-MM-DD form, so it is not shown.");
  }

  if (errors.length > 50) {
    const more = errors.length - 50;
    errors.splice(50, errors.length, `…and ${more} more problems.`);
  }
  return { doc: errors.length ? undefined : (doc as FileCheck["doc"]), errors, warnings };
}

// The imported file as it now stands: the kept document plus the rule set's
// rules, with admin-only settings (severity, weight, verified) left out.
// The database does not keep key order, so the usual sections come first.
const ORDER = ["metadata", "engine_notes", "environments", "sources", "rules", "change_log",
  "gaps_and_open_issues", "review_log", "citation_check"];

export function rebuildRulesetFile(set: RuleSet, rules: Rule[]) {
  const kept = (set.document ?? {}) as Record<string, unknown>;
  const list = rules.map((r) => ({
    id: r.code,
    network: r.scheme === "visa" ? "VISA" : "MC",
    domain: r.domain,
    environments: r.environments,
    type: r.rule_type,
    assertion: r.requirement,
    evaluates: r.evaluates,
    source: r.source_reference,
    effective: r.effective,
    notes: r.source_notes,
    status: r.rule_status,
    valid_from: r.valid_from,
    valid_to: r.valid_to,
    basis: r.basis,
    excluded_environments: r.excluded_environments,
    region_scope: r.region_scope,
    group: r.group_code,
  }));
  const all: Record<string, unknown> = { ...kept, rules: list };
  const keys = [...ORDER.filter((k) => k in all), ...Object.keys(all).filter((k) => !ORDER.includes(k))];
  return Object.fromEntries(keys.map((k) => [k, all[k]]));
}
