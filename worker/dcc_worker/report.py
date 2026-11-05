"""The downloadable PDF validation report."""

from __future__ import annotations

import io
from datetime import datetime
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

SCHEMES = {"visa": "Visa", "mastercard": "Mastercard"}
CHANNELS = {
    "pos": "Attended POS",
    "pos_unattended": "Unattended POS",
    "atm": "ATM",
    "branch": "Bank branch",
    "ecommerce": "E-commerce",
    "mail": "Mail order",
    "phone": "Telephone order",
    "priority": "Priority check-out / express return",
    "stored": "Stored credential / recurring",
}
VERDICTS = {
    "compliant": "Compliant",
    "not_compliant": "Not compliant",
    "needs_review": "Needs review",
    "no_rules": "No rules apply",
}
OUTCOMES = {"pass": "Pass", "fail": "Fail", "needs_review": "Needs review", "not_applicable": "Not applicable"}
OUTCOME_COLOURS = {
    "pass": colors.HexColor("#1b7f3b"),
    "fail": colors.HexColor("#b42318"),
    "needs_review": colors.HexColor("#9a6700"),
    "not_applicable": colors.HexColor("#555555"),
}
TYPES = {"MUST": "Must", "MUST_NOT": "Must not", "SHOULD": "Should"}


def rule_text(f: dict) -> str:
    """Imported rules' titles are the start of their wording: show it once."""
    title = f["title"].rstrip("…")
    return f["requirement"] if f["requirement"].startswith(title) else f"{f['title']}. {f['requirement']}"
KINDS = {"choice_screen": "Currency choice screen", "receipt": "Receipt", "other": "Other"}


def _p(text: str, style) -> Paragraph:
    return Paragraph(escape(text or ""), style)


def build(submission: dict, result: dict) -> bytes:
    styles = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=styles["BodyText"], fontSize=9, leading=12)
    small = ParagraphStyle("small", parent=body, fontSize=8, leading=10, textColor=colors.HexColor("#555555"))
    warn = ParagraphStyle("warn", parent=body, textColor=colors.HexColor("#9a6700"))
    h1, h2 = styles["Title"], styles["Heading2"]

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
        title=f"DCC validation report: {submission['title']}",
    )
    validated = datetime.fromisoformat(result["validated_at"]).strftime("%d %b %Y %H:%M UTC")
    rule_set = result["rule_set"]
    story = [
        _p("DCC validation report", h1),
        _p(f"{submission['title']} (version {submission['version']})", styles["Heading3"]),
        _p(
            f"{CHANNELS[submission['channel']]} · "
            + ", ".join(SCHEMES[s] for s in submission["schemes"])
            + (f" · merchant country {submission['merchant_country']}" if submission.get("merchant_country") else "")
            + f" · validated {validated} against rule set v{rule_set['number']}"
            + (f" ({rule_set['title']}, as of {rule_set['as_of']})" if rule_set.get("as_of") else ""),
            body,
        ),
        Spacer(1, 4 * mm),
    ]
    unverified = sum(1 for f in result["findings"] if not f["verified"])
    if unverified:
        story.append(
            _p(
                f"Draft rules: {unverified} of the {len(result['findings'])} rules used have not yet been verified "
                "against the official scheme documents. Treat this report as indicative only.",
                warn,
            )
        )
        story.append(Spacer(1, 3 * mm))

    rows = [["Scheme", "Result", "Score", "Pass", "Fail", "Needs review"]]
    for scheme in submission["schemes"]:
        s = result["schemes"][scheme]
        score = "–" if s["score"] is None else f"{s['score']}%"
        rows.append([SCHEMES[scheme], VERDICTS[s["verdict"]], score, s["passed"], s["failed"], s["needs_review"]])
    table = Table(rows, hAlign="LEFT", colWidths=[32 * mm, 34 * mm, 20 * mm, 18 * mm, 18 * mm, 26 * mm])
    table.setStyle(
        TableStyle(
            [
                ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 9),
                ("FONT", (0, 1), (-1, -1), "Helvetica", 9),
                ("LINEBELOW", (0, 0), (-1, 0), 0.5, colors.grey),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]
        )
    )
    story += [table, Spacer(1, 4 * mm)]
    if result.get("overview"):
        story += [_p("Summary", h2), _p(result["overview"], body)]

    story.append(_p("Documents reviewed", h2))
    for i, d in enumerate(result["documents"], start=1):
        story.append(_p(f"{i}. {d['name']} ({KINDS.get(d['kind'], 'Other')}): {d['description']}", body))

    order = {"fail": 0, "needs_review": 1, "pass": 2, "not_applicable": 3}

    def findings_table(findings: list[dict]) -> Table:
        rows = [["Rule", "Result", "Requirement and evidence"]]
        for f in findings:
            evidence = f["evidence"] or ""
            if f["document"] is not None:
                evidence = f"{evidence} (document {f['document'] + 1})".strip()
            source = f["source"] + ("" if f["verified"] else " · not yet verified")
            kind = TYPES.get(f.get("rule_type", "MUST"), "")
            cell = [
                _p(rule_text(f), body),
                _p(f"Evidence: {evidence}", small),
                _p(f"Source: {source} · {kind} · severity {f['severity']}", small),
            ]
            colour = OUTCOME_COLOURS[f["outcome"]].hexval()[2:]
            outcome = Paragraph(f'<font color="#{colour}"><b>{OUTCOMES[f["outcome"]]}</b></font>', body)
            rows.append([_p(f["code"], body), outcome, cell])
        t = Table(rows, colWidths=[24 * mm, 22 * mm, 132 * mm], repeatRows=1)
        t.setStyle(
            TableStyle(
                [
                    ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#dddddd")),
                ]
            )
        )
        return t

    for scheme in submission["schemes"]:
        mine = sorted(
            (f for f in result["findings"] if f["scheme"] == scheme),
            key=lambda f: (order[f["outcome"]], f.get("sort", 0), f["code"]),
        )
        required = [f for f in mine if f.get("rule_type", "MUST") in ("MUST", "MUST_NOT") and f["outcome"] != "not_applicable"]
        advisory = [f for f in mine if f.get("rule_type") == "SHOULD" and f["outcome"] != "not_applicable"]
        not_applicable = [f["code"] for f in mine if f["outcome"] == "not_applicable"]
        not_checked = [r for r in result.get("not_checked", []) if r["scheme"] == scheme]
        if required:
            story += [_p(f"{SCHEMES[scheme]}: required rules", h2), findings_table(required)]
        if advisory:
            story += [_p(f"{SCHEMES[scheme]}: advisory rules (not scored)", h2), findings_table(advisory)]
        if not_applicable:
            story.append(_p(f"Not applicable to this submission: {', '.join(not_applicable)}.", small))
        if not_checked:
            story.append(
                _p(
                    f"{len(not_checked)} {SCHEMES[scheme]} rules apply but cannot be checked from screens and "
                    "receipts (registration, certification, message data or dispute evidence): "
                    + ", ".join(r["code"] for r in not_checked) + ".",
                    small,
                )
            )

    story += [
        Spacer(1, 6 * mm),
        _p(
            "How this report is produced: an AI model reads the masked files and judges each rule of the published "
            "rule set that applies to this scheme, environment and date, quoting what it sees. Must and must-not "
            "rules are scored; a failed critical rule makes a scheme not compliant. The score is the weighted share "
            "of scored rules that passed. Advisory rules are reported but not scored. This report supports, and "
            "does not replace, review against the official scheme rules.",
            small,
        ),
    ]
    doc.build(story)
    return buf.getvalue()
