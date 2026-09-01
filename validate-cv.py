#!/usr/bin/env python3
"""
CV/Cover Letter validator for career-ops HTML output.

Wraps career-agent's text-level checks with HTML-aware extraction.
Blocks PDF generation if banned words, AI patterns, or structural issues are found.

Usage:
    python3 validate-cv.py <cv.html>              # CV validation
    python3 validate-cv.py <cover.html> --cover   # Cover letter validation

Exit 0 = all checks passed, PDF generation proceeds
Exit 1 = issues found, PDF generation blocked
"""

import sys
import os
import re

# ── Locate career-agent and import its text checks ──────────────────────────
_HERE = os.path.dirname(os.path.abspath(__file__))

_AGENT_CANDIDATES = [
    os.path.join(_HERE, '..', 'career-agent'),
    os.path.join(_HERE, '..', 'career-agent-main'),
]

_AGENT_ROOT = next((p for p in _AGENT_CANDIDATES if os.path.isdir(p)), None)

if _AGENT_ROOT:
    sys.path.insert(0, os.path.abspath(_AGENT_ROOT))
    try:
        from career_agent.validation.document import (
            check_banned_words,
            check_banned_phrases,
            check_banned_transitions,
            check_permanent_rules,
            check_em_dashes,
            check_no_contractions,
        )
        _AGENT_LOADED = True
    except ImportError as e:
        _AGENT_LOADED = False
        _AGENT_LOAD_ERROR = str(e)
else:
    _AGENT_LOADED = False
    _AGENT_LOAD_ERROR = "career-agent not found at ../career-agent or ../career-agent-main"


# ── Fallback: inline copies of the checks (if career-agent unavailable) ──────
# These mirror the logic in career-agent/career_agent/validation/document.py
# so the validator works even without the external repo.

_BANNED_WORDS = {
    "delve", "tapestry", "realm", "landscape", "embark", "multifaceted",
    "nuanced", "pivotal", "underscore", "meticulous", "vibrant", "whimsical",
    "gossamer", "labyrinth", "indelible", "leverage", "synergies", "facilitate",
    "utilize", "optimize", "robust", "comprehensive", "seamless", "cutting-edge",
    "revolutionary", "transformative", "illuminate", "elucidate", "commence",
    "endeavor", "intersection", "incredibly", "passionate", "excited", "thrilled",
    "spearheaded", "testament", "nestled", "bolster", "cornerstone", "fostering",
    "harnessing", "intricate", "paradigm", "unprecedented", "elevate", "poised",
    "reshape",
}

_BANNED_PHRASES = [
    "aligns perfectly", "resonated deeply", "i was particularly drawn to",
    "i'd love to explore", "unique combination", "well-positioned",
    "it's worth noting", "i'm confident that", "i'm reaching out because",
    "this role is a perfect fit", "i bring a unique blend",
    "thrilled at the opportunity", "i believe my experience",
    "i am writing to express", "i would welcome the opportunity",
    "in today's ever-evolving", "enabled non technical stakeholders",
    "aligns with my", "proven track record", "results-oriented",
    "best regards", "sincerely,", "warm regards", "kind regards",
]

_BANNED_TRANSITIONS = [
    "moreover,", "furthermore,", "additionally,", "subsequently,",
    "nonetheless,", "it's worth noting that", "it is important to note",
    "that being said", "in conclusion,", "in summary,",
]

def _fallback_check_banned_words(text):
    issues = []
    words = set(re.findall(r'\b[a-z]+(?:-[a-z]+)*\b', text.lower()))
    for word in _BANNED_WORDS:
        if word in words:
            issues.append(f"BANNED WORD: '{word}'")
    return issues

def _fallback_check_banned_phrases(text):
    issues = []
    t = text.lower()
    for phrase in _BANNED_PHRASES:
        if phrase in t:
            issues.append(f"BANNED PHRASE: '{phrase}'")
    return issues

def _fallback_check_banned_transitions(text):
    issues = []
    t = text.lower()
    for trans in _BANNED_TRANSITIONS:
        if trans in t:
            issues.append(f"BANNED TRANSITION: '{trans}'")
    return issues

def _fallback_check_em_dashes(text):
    count = text.count("\u2014") + text.count("\u2013")
    prose = len(re.findall(r'(?<=[a-zA-Z]) ?-- ?(?=[a-zA-Z])', text))
    total = count + prose
    if total > 1:
        return [f"EM DASH ABUSE: {total} em dashes found (max 1 per document)"]
    return []

def _fallback_check_no_contractions(text):
    issues = []
    formal = [
        (r'\bI am\b', "I'm"), (r'\bI have\b', "I've"),
        (r'\bdid not\b', "didn't"), (r'\bdo not\b', "don't"),
        (r'\bI will\b', "I'll"), (r'\bcannot\b', "can't"),
    ]
    for pattern, contraction in formal:
        if re.search(pattern, text):
            issues.append(f"USE CONTRACTION: Found formal form — use '{contraction}'")
    return issues

# ── Resolve which implementation to use ──────────────────────────────────────

if _AGENT_LOADED:
    _run_banned_words      = check_banned_words
    _run_banned_phrases    = check_banned_phrases
    _run_banned_transitions = check_banned_transitions
    _run_em_dashes         = check_em_dashes
    _run_no_contractions   = check_no_contractions

    def _run_permanent_rules(text):
        try:
            return check_permanent_rules(text)
        except Exception:
            return []
else:
    _run_banned_words      = _fallback_check_banned_words
    _run_banned_phrases    = _fallback_check_banned_phrases
    _run_banned_transitions = _fallback_check_banned_transitions
    _run_em_dashes         = _fallback_check_em_dashes
    _run_no_contractions   = _fallback_check_no_contractions

    def _run_permanent_rules(text):
        return []


# ── HTML extraction ───────────────────────────────────────────────────────────

def read_html(html_path):
    """Read file once, return (raw_html, plain_text). Called by all checks."""
    with open(html_path, 'r', encoding='utf-8') as f:
        raw = f.read()

    # Drop <style> and <script> blocks before extracting text
    stripped = re.sub(
        r'<(style|script)\b[^>]*>.*?</\1>',
        '', raw, flags=re.DOTALL | re.IGNORECASE
    )
    text = re.sub(r'<[^>]+>', ' ', stripped)

    entities = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>',
        '&nbsp;': ' ', '&#39;': "'", '&quot;': '"',
        '&mdash;': '\u2014', '&ndash;': '\u2013',
        '&lsquo;': '\u2018', '&rsquo;': '\u2019',
        '&ldquo;': '\u201C', '&rdquo;': '\u201D',
    }
    for entity, char in entities.items():
        text = text.replace(entity, char)

    text = re.sub(r'\s+', ' ', text).strip()
    return raw, text


# ── HTML structure checks ─────────────────────────────────────────────────────

def check_html_structure(raw_html, is_cover=False):
    """Check required sections and bullet density. Takes already-read HTML string."""
    if is_cover:
        return []

    issues = []
    html_upper = raw_html.upper()

    for section in ['EXPERIENCE', 'EDUCATION']:
        if section not in html_upper:
            issues.append(f"MISSING SECTION: '{section}' not found in CV")

    bullet_count = len(re.findall(r'<li\b', raw_html, re.IGNORECASE))
    if bullet_count < 8:
        issues.append(
            f"THIN CONTENT: {bullet_count} bullet points found — expect 8+ for a complete CV"
        )

    return issues


# ── Main validation runner ────────────────────────────────────────────────────

def validate_html(html_path, is_cover=False):
    """Read file once, run all applicable checks. Returns list of issue strings."""
    raw, text = read_html(html_path)

    issues = []
    issues.extend(_run_banned_words(text))
    issues.extend(_run_banned_phrases(text))
    issues.extend(_run_banned_transitions(text))
    issues.extend(_run_permanent_rules(text))
    issues.extend(_run_em_dashes(text))
    issues.extend(check_html_structure(raw, is_cover=is_cover))

    # Contractions matter for cover letters (conversational tone)
    # CV bullets are terse — skip contraction enforcement
    if is_cover:
        issues.extend(_run_no_contractions(text))

    return issues


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 validate-cv.py <file.html> [--cover]")
        sys.exit(1)

    html_path = sys.argv[1]
    is_cover  = '--cover' in sys.argv

    if not os.path.exists(html_path):
        print(f"File not found: {html_path}")
        sys.exit(1)

    source_label = "career-agent" if _AGENT_LOADED else "built-in fallback"
    if not _AGENT_LOADED:
        print(f"  note: career-agent not loaded ({_AGENT_LOAD_ERROR}); using {source_label} checks")

    issues = validate_html(html_path, is_cover=is_cover)
    filename = os.path.basename(html_path)
    doc_type = "cover letter" if is_cover else "CV"

    if not issues:
        print(f"VALIDATION PASSED: {filename} ({doc_type}, {source_label}) — 0 issues")
        sys.exit(0)

    print(f"VALIDATION FAILED: {filename} ({doc_type}, {source_label}) — {len(issues)} issue(s)")
    print("Fix these before the PDF is generated:")
    for i, issue in enumerate(issues, 1):
        print(f"  {i}. {issue}")
    sys.exit(1)


if __name__ == '__main__':
    main()
