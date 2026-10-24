"""Fail-closed policy helpers for Needs PKs Printed review.

Current LP rule (replaces the old Checkup-number title ranking completely):
  1. Read every Learning Plan's Active checkbox and Created Date in Radius.
  2. Ignore inactive LPs.
  3. One active LP: select it, whatever its name.
  4. Two or more active LPs: select the one with the most recent Created Date.
  5. No active LP, an unreadable Created Date on a competing active LP, or a
     tie for the most recent date: manual review. Never guess, never combine.
LP names, Checkup numbers and export row order are never used to choose.

Only a positively verified *assigned AND not mastered* count can be used.
Old LPs are not evidence for the newest LP's PK balance/POST readiness.
No Radius or Sheets writes are performed here.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, time
import re

MAX_ASSIGNED = 3
POST_MAX_LEFT = 3


class NeedsReview(ValueError):
    """A known reason one student needs manual review.

    ``code`` is a fixed, privacy-safe label (never names, titles or URLs), so
    it is the only part of the exception the pilot ever prints.
    """

    def __init__(self, code: str, headers=None):
        super().__init__(code)
        self.code = code
        # Optional Radius column titles (never cell values) for layout reviews.
        self.headers = headers


_MONTHS = {name: number for number, names in enumerate((
    ('jan', 'january'), ('feb', 'february'), ('mar', 'march'), ('apr', 'april'),
    ('may',), ('jun', 'june'), ('jul', 'july'), ('aug', 'august'),
    ('sep', 'sept', 'september'), ('oct', 'october'), ('nov', 'november'),
    ('dec', 'december')), 1) for name in names}
_MDY = re.compile(r'(\d{1,2})/(\d{1,2})/(\d{4}|\d{2})(?!\d)')
_ISO = re.compile(r'(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)')
_MON = re.compile(r'([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})(?!\d)')
_TIME = re.compile(r'(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp])\.?\s*[Mm]\.?')
_TIME24 = re.compile(r'(\d{1,2}):(\d{2})(?::(\d{2}))?')


def parse_created_date(text) -> tuple[date, time | None]:
    """Parse a Radius Created Date such as 9/3/2026 (optionally with a time).

    Anything that is not clearly a date (plus an optional clock time) is
    unreadable: it is never guessed or partially used.
    """
    raw = ' '.join(str(text or '').replace(' ', ' ').split())
    try:
        day, rest = None, ''
        if m := _MDY.match(raw):
            year = int(m.group(3))
            year += 2000 if year < 100 else 0
            day = date(year, int(m.group(1)), int(m.group(2)))
        elif m := _ISO.match(raw):
            day = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        elif m := _MON.match(raw):
            month = _MONTHS.get(m.group(1).casefold())
            if month is None:
                raise ValueError
            day = date(int(m.group(3)), month, int(m.group(2)))
        if day is None:
            raise ValueError
        rest = raw[m.end():].lstrip(' ,T')
        if not rest:
            return day, None
        if t := _TIME.fullmatch(rest):
            hour = int(t.group(1))
            if not 1 <= hour <= 12:
                raise ValueError
            hour = hour % 12 + (12 if t.group(4).casefold() == 'p' else 0)
            return day, time(hour, int(t.group(2)), int(t.group(3) or 0))
        if t := _TIME24.fullmatch(rest):
            return day, time(int(t.group(1)), int(t.group(2)), int(t.group(3) or 0))
        raise ValueError
    except ValueError:
        raise NeedsReview('CREATED_DATE_UNREADABLE') from None


@dataclass(frozen=True)
class LPSelection:
    index: int              # position in the plans list that was passed in
    rule: str               # ONLY_ACTIVE or NEWEST_ACTIVE
    active_count: int
    inactive_count: int
    created: str | None     # ISO date of the selected LP, when readable


def select_current_lp(plans: list[dict]) -> LPSelection:
    """Choose the current LP from ``[{'active': bool, 'created': str}, ...]``.

    ``created`` is only required for active LPs that compete with another
    active LP. Inactive LPs are ignored even if they are newer.
    """
    if not plans:
        raise NeedsReview('NO_LEARNING_PLANS')
    if any(p.get('active') not in (True, False) for p in plans):
        raise NeedsReview('ACTIVE_STATE_UNREADABLE')
    active = [i for i, p in enumerate(plans) if p['active'] is True]
    inactive = len(plans) - len(active)
    if not active:
        raise NeedsReview('NO_ACTIVE_LP')

    def created_iso(i):
        try:
            return parse_created_date(plans[i].get('created'))[0].isoformat()
        except NeedsReview:
            return None

    if len(active) == 1:
        return LPSelection(active[0], 'ONLY_ACTIVE', 1, inactive, created_iso(active[0]))
    dated = [(parse_created_date(plans[i].get('created')), i) for i in active]
    newest_day = max(day for (day, _), _ in dated)
    top = [(clock, i) for (day, clock), i in dated if day == newest_day]
    if len(top) > 1:
        clocks = [clock for clock, _ in top]
        # Same Created Date: only an explicit, distinct time can break the tie.
        if any(clock is None for clock in clocks) or len(set(clocks)) != len(clocks):
            raise NeedsReview('LATEST_ACTIVE_LP_TIE')
        top = [max(top)]
    chosen = top[0][1]
    return LPSelection(chosen, 'NEWEST_ACTIVE', len(active), inactive, newest_day.isoformat())


def decision_is_stable(outstanding: int, outstanding_if_conflicts: int,
                       max_assigned: int = MAX_ASSIGNED) -> bool:
    """True if reading conflicting completion evidence either way gives the
    same side of the 3-PK printing threshold."""
    return (outstanding > max_assigned) == (outstanding_if_conflicts > max_assigned)


def printing_decision(*, assigned_not_mastered: int | None, skills_left: int | None,
                      lp_summary_status: str, max_assigned: int = MAX_ASSIGNED,
                      post_max_left: int = POST_MAX_LEFT) -> str:
    """Read-only decision for the latest LP; never references an old LP.

    If more than 3 PKs are assigned but unmastered, no new packet is due.
    Otherwise the existing PK/POST boundary is preserved, requiring verified
    progress and a known LP Summary status before a POST recommendation.
    """
    if type(assigned_not_mastered) is not int or assigned_not_mastered < 0:
        return 'REVIEW_ASSIGNMENT_UNVERIFIED'
    if assigned_not_mastered > max_assigned:
        return 'NO_NEW_PKS_NEEDED'
    if type(skills_left) is not int or skills_left < 0:
        return 'REVIEW_LP_PROGRESS_UNVERIFIED'
    if skills_left > post_max_left:
        return 'NEEDS_NEW_PKS_PRINTED'
    status = ' '.join((lp_summary_status or '').casefold().split())
    if status == 'post':
        return 'POST_ALREADY_PRINTED'
    if status in {'pre', 'update'}:
        return 'POST_DUE_OTHER_ASSESSMENT_PRINTED'
    if status == 'in progress':
        return 'NEEDS_POST_PRINTED'
    return 'REVIEW_LP_SUMMARY_STATUS'
