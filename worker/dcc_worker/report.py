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
CHANNELS = {"pos": "POS terminal", "atm": "ATM", "ecommerce": "E-commerce"}
VERDICTS = {
    "compliant": "Compliant",
    "not_compliant": "Not compliant",
    "needs_review": "Needs review",
    "no_rules": "No rules apply",
}
OUTCOMES = {"pass": "Pass", "fail": "Fail", "needs_review": "Needs review"}
OUTCOME_COLOURS = {"pass": colors.HexColor("#1b7f3b"), "fail": colors.HexColor("#b42318"), "needs_review": colors.HexColor("#9a6700")}
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
            + f" · validated {validated} against rule set v{rule_set['number']}",
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

    order = {"fail": 0, "needs_review": 1, "pass": 2}
    for scheme in submission["schemes"]:
        findings = sorted(
            (f for f in result["findings"] if f["scheme"] == scheme),
            key=lambda f: (order[f["outcome"]], f["code"]),
        )
        if not findings:
            continue
        story.append(_p(f"{SCHEMES[scheme]} findings", h2))
        rows = [["Rule", "Result", "Requirement and evidence"]]
        styles_cmds = [
            ("FONT", (0, 0), (-1, 0), "Helvetica-Bold", 8),
            ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ("LINEBELOW", (0, 0), (-1, -1), 0.25, colors.HexColor("#dddddd")),
        ]
        for f in findings:
            evidence = f["evidence"] or ""
            if f["document"] is not None:
                evidence = f"{evidence} (document {f['document'] + 1})".strip()
            source = f["source"] + ("" if f["verified"] else " · not yet verified")
            cell = [
                _p(f"{f['title']}. {f['requirement']}", body),
                _p(f"Evidence: {evidence}", small),
                _p(f"Source: {source} · severity {f['severity']}", small),
            ]
            colour = OUTCOME_COLOURS[f["outcome"]].hexval()[2:]
            outcome = Paragraph(f'<font color="#{colour}"><b>{OUTCOMES[f["outcome"]]}</b></font>', body)
            rows.append([_p(f["code"], body), outcome, cell])
        t = Table(rows, colWidths=[18 * mm, 24 * mm, 136 * mm], repeatRows=1)
        t.setStyle(TableStyle(styles_cmds))
        story.append(t)

    story += [
        Spacer(1, 6 * mm),
        _p(
            "How this report is produced: an AI model reads the masked files and answers fixed questions about "
            "them; the pass or fail decisions are then made by the published rule set. A critical rule that fails "
            "makes a scheme not compliant. The score is the weighted share of applicable rules that passed. This "
            "report supports, and does not replace, review against the official scheme rules.",
            small,
        ),
    ]
    doc.build(story)
    return buf.getvalue()
