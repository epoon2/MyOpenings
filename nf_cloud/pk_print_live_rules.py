"""Read-only rules for the Needs PKs Printed live pilot. No production writes.

Outstanding PK = a populated Date Assigned AND no completion evidence (Date
Completed, a checked Mastered box, or green mastered styling). An unchecked
Mastered box alone never proves a PK is assigned.

The LP is chosen from live Radius data (Active + newest Created Date, see
pk_print_policy.select_current_lp), never from titles or export order. The
Student Active LPs export count is kept only as a comparison.
"""
from __future__ import annotations

import re
from collections import Counter

from nf_student_match import parse_student_name
from pk_print_policy import (NeedsReview, decision_is_stable, printing_decision,
                             select_current_lp)

# PK rows are explicitly labeled PK by Radius. Never infer PKs from skill
# descriptions, numbers, pre-requisite cells, or a 'Global Sort Order'.
PK_LABEL = re.compile(r'^\s*PK(?:\s*[-–—:]\s*|\s+)(?=\S)', re.I)
NF_CODE = re.compile(r'\bNF\s*[- ]?\s*(0?[1-9]|1\d|2[0-8])\b', re.I)

CREATED_HEADERS = frozenset({'created date', 'date created', 'created', 'created on',
                             'creation date', 'create date'})
MAX_REPORT_ROWS = 50
# Student Active LPs columns behind the report's "Skills mastered (H)" and
# "Total skills (I)". Only used after build_target confirms they match.
EXPORT_MASTERED_IX, EXPORT_TOTAL_IX = 7, 8


def parse_report_rows(value: str) -> list[int]:
    """'2,27,32' or ranges like '2-46'; at most 50 distinct rows, in order."""
    rows = []
    for piece in str(value or '').split(','):
        m = re.fullmatch(r'\s*(\d+)\s*(?:-\s*(\d+)\s*)?', piece)
        if not m:
            raise ValueError('Select comma-separated report rows or ranges, e.g. 2,27 or 2-46')
        start, end = int(m.group(1)), int(m.group(2) or m.group(1))
        if end < start:
            raise ValueError('Report row ranges must go from low to high')
        if len(rows) + (end - start + 1) > MAX_REPORT_ROWS:
            raise ValueError(f'Select 1-{MAX_REPORT_ROWS} report rows')
        rows.extend(range(start, end + 1))
    if not 1 <= len(rows) <= MAX_REPORT_ROWS:
        raise ValueError(f'Select 1-{MAX_REPORT_ROWS} report rows')
    if any(row < 2 or row > 1000 for row in rows) or len(set(rows)) != len(rows):
        raise ValueError('Report rows must be distinct, between 2 and 1000')
    return rows


def normalize_lp(value: object) -> str:
    return ' '.join(str(value or '').casefold().split())


def whole_number(value) -> int | None:
    """Nonnegative whole number from a Sheets value, else None."""
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return int(number) if number >= 0 and number.is_integer() else None


def resolve_student(exported_name: str, roster: list[list[str]]) -> tuple[str, str]:
    """Never guess compound surnames: use exact split fields from All_Students."""
    if not roster:
        raise ValueError('Empty All_Students source')
    headers = [str(x).strip() for x in roster[0]]
    for field in ('First Name', 'Last Name'):
        if field not in headers:
            raise ValueError('Missing roster first/last name header')
    first_idx, last_idx = headers.index('First Name'), headers.index('Last Name')
    exported = parse_student_name(exported_name)
    if not exported.base:
        raise ValueError('Empty or unreadable reported student')
    matches = []
    for row in roster[1:]:
        first = str(row[first_idx] if first_idx < len(row) else '').strip()
        last = str(row[last_idx] if last_idx < len(row) else '').strip()
        first_part, last_part = parse_student_name(first), parse_student_name(last)
        starred = first_part.starred or last_part.starred
        if (first_part.base and last_part.base and starred == exported.starred and
                exported.base in (f'{first_part.base} {last_part.base}',
                                  f'{last_part.base} {first_part.base}')):
            matches.append((first, last))
    if len(matches) != 1:
        raise ValueError('Unable to identify one exact, uniquely matched roster student')
    return matches[0]


def assess_grid(grid: dict, export_assigned: int | None) -> dict:
    """Count DATE ASSIGNED AND NOT MASTERED PKs; fail closed for uncertain grids.

    Date Completed, green mastery highlighting, and a checked Mastered box
    are all positive completion evidence. An unchecked mastery box alone
    does NOT prove assignment. ``export_assigned`` is only compared, never
    used as the count; None means the export has no matching LP row.
    """
    if export_assigned is not None and (type(export_assigned) is not int or export_assigned < 0):
        raise ValueError('Invalid exported assigned-PK count')
    if not grid.get('found_grid') or grid.get('table_data_rows', 0) < 1:
        raise NeedsReview('LP_GRID_NOT_LOADED')
    if grid.get('pagination_controls_visible'):
        raise NeedsReview('LP_GRID_PAGINATED')
    if grid.get('unrecognized_disabled_rows'):
        raise NeedsReview('LP_GRID_DISABLED_ROWS_UNREADABLE')
    if grid.get('ambiguous_pk_rows') or grid.get('unreadable_pk_rows'):
        raise NeedsReview('LP_GRID_PK_ROWS_UNREADABLE')

    unmastered = grid.get('incomplete_pk_labels')
    if not isinstance(unmastered, list) or any(
            not isinstance(x, str) or not PK_LABEL.search(x) for x in unmastered):
        raise NeedsReview('LP_GRID_INVALID_PK_LABELS')
    codes = {f'NF{int(m.group(1)):02d}' for label in unmastered
             for m in [NF_CODE.search(label)] if m}
    date_headers_found = grid.get('date_columns_found') is True
    live_assigned = None
    conflicts = None
    class_name = 'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND'
    assigned_codes = set()
    if date_headers_found:
        if grid.get('unknown_date_value_rows', 0):
            raise NeedsReview('DATE_VALUE_UNREADABLE')
        active = grid.get('assigned_not_mastered_labels')
        if not isinstance(active, list) or any(
                not isinstance(x, str) or not PK_LABEL.search(x) for x in active):
            raise NeedsReview('LP_GRID_INVALID_PK_LABELS')
        if type(grid.get('assigned_date_rows')) is not int:
            raise NeedsReview('DATE_COUNTS_INCOMPLETE')
        if grid['assigned_date_rows'] < len(active):
            raise NeedsReview('DATE_COUNTS_DO_NOT_RECONCILE')
        if grid['assigned_date_rows'] + grid.get('no_assignment_date_rows', 0) != (
                grid.get('pk_rows_seen', 0) - grid.get('ignored_archived_rows', 0)):
            raise NeedsReview('DATE_COUNTS_DO_NOT_RECONCILE')
        conflicts = grid.get('assigned_conflict_rows', 0)
        if type(conflicts) is not int or conflicts < 0 or (
                conflicts + len(active) > grid['assigned_date_rows']):
            raise NeedsReview('DATE_COUNTS_DO_NOT_RECONCILE')
        duplicates = [label for label, count in Counter(normalize_lp(x) for x in active).items()
                      if count > 1]
        if duplicates:
            raise NeedsReview('DUPLICATE_ASSIGNED_PK')
        live_assigned = len(active)
        assigned_codes = {f'NF{int(m.group(1)):02d}' for label in active
                          for m in [NF_CODE.search(label)] if m}
        class_name = ('EXPORT_ROW_NOT_MATCHED' if export_assigned is None
                      else 'EXPORT_UNDERCOUNTS' if live_assigned > export_assigned
                      else 'EXPORT_OVERCOUNTS' if live_assigned < export_assigned
                      else 'ASSIGNMENT_MATCH')

    assignment_column = grid.get('assignment_column_found') is True
    return {
        'export_assigned': export_assigned,
        'radius_assigned_not_mastered': live_assigned,
        'assigned_conflict_rows': conflicts,
        'outstanding_if_conflicts_counted': (None if live_assigned is None
                                             else live_assigned + conflicts),
        'radius_unmastered': len(unmastered),
        'radius_mastered': grid.get('mastered_pk_count', 0),
        'pk_rows_seen': grid.get('pk_rows_seen', 0),
        'date_columns_found': date_headers_found,
        'date_assigned_column_found': grid.get('date_assigned_column_found') is True,
        'date_completed_column_found': grid.get('date_completed_column_found') is True,
        'assigned_date_rows': grid.get('assigned_date_rows', 0),
        'completed_date_rows': grid.get('completed_date_rows', 0),
        'green_mastered_rows': grid.get('green_mastered_rows', 0),
        'assignment_column_found': assignment_column,
        'assignment_marked_true': grid.get('assignment_marked_true', 0) if assignment_column else None,
        'explicitly_assigned_not_mastered': (grid.get('explicitly_assigned_not_mastered')
                if assignment_column and grid.get('assignment_marked_unknown', 0) == 0
                and not grid.get('unrecognized_disabled_rows') else None),
        'assignment_marked_false': grid.get('assignment_marked_false', 0) if assignment_column else None,
        'assignment_marked_unknown': grid.get('assignment_marked_unknown', 0) if assignment_column else None,
        'selected_pk_rows': grid.get('selected_pk_rows', 0),
        'classification': class_name,
        'nf26_to_28_incomplete': len(codes.intersection({'NF26', 'NF27', 'NF28'})),
        'nf26_to_28_assigned_not_mastered': len(assigned_codes.intersection({'NF26', 'NF27', 'NF28'})),
        'unrecognized_disabled_rows': grid.get('unrecognized_disabled_rows', 0),
        'ignored_archived_rows': grid.get('ignored_archived_rows', 0),
    }


def choose_current_plan(snap: dict, listing: dict, ident) -> dict:
    """Pick the current LP from the live Learning Plans table.

    ``snap`` is the settled nf_lp_plan_pilot._wait_snapshot() result and
    ``listing`` the pk_print_radius_grid.read_plan_list() result for the same
    page; their rows must be the same plans in the same order. ``ident`` is
    nf_lp_plan_pilot._ident (passed in so this stays testable offline).
    """
    if not isinstance(listing, dict) or not listing.get('plans'):
        raise NeedsReview('LP_LIST_UNREADABLE')
    plans = listing['plans']
    total = listing.get('pager_total')
    if total is not None and total != len(plans):
        raise NeedsReview('LP_LIST_PAGINATED')
    if total is None and (listing.get('pager_pages') or 0) > 1:
        raise NeedsReview('LP_LIST_PAGINATED')
    ids = [ident(p) for p in plans]
    if ids != [ident(p) for p in (snap or {}).get('plans') or []]:
        raise NeedsReview('LP_LIST_CHANGED')
    if len(set(ids)) != len(ids) or any(p.get('edit_count') != 1 for p in plans):
        raise NeedsReview('LP_LIST_ROWS_NOT_UNIQUE')
    headers = [normalize_lp(h) for h in listing.get('headers') or []]
    created_columns = [i for i, h in enumerate(headers) if h in CREATED_HEADERS]
    column = created_columns[0] if len(created_columns) == 1 else None
    rows = []
    for plan in plans:
        cells = plan.get('cells') or []
        rows.append({'active': plan.get('active'),
                     'created': cells[column] if column is not None and column < len(cells) else None})
    active = sum(r['active'] is True for r in rows)
    try:
        if active > 1:
            # Created Date is only needed to rank 2+ active LPs; one active LP
            # is chosen regardless. Its column must then be unambiguous: one
            # header cell per data cell, no merged (colspan) headers.
            if column is None:
                raise NeedsReview('CREATED_DATE_COLUMN_NOT_FOUND', headers=listing.get('headers'))
            spans = listing.get('header_spans') or []
            if (len(spans) != len(headers) or any(span != 1 for span in spans) or
                    any(len(plan.get('cells') or []) != len(headers) for plan in plans)):
                raise NeedsReview('LP_LIST_LAYOUT_UNVERIFIED', headers=listing.get('headers'))
        selection = select_current_lp(rows)
    except NeedsReview as exc:
        exc.lp_counts = (active, len(rows) - active)  # counts only, for the log
        raise
    chosen = plans[selection.index]
    return {'identity': ids[selection.index], 'selection': selection,
            # In memory only: lets the caller confirm the Edit link it is
            # about to click belongs to this exact row. Never printed.
            'stable_target': chosen.get('stable_target'),
            'cells': [str(c) for c in chosen.get('cells') or []],
            'other_cells': [{normalize_lp(c) for c in plan.get('cells') or [] if normalize_lp(c)}
                            for i, plan in enumerate(plans) if i != selection.index]}


def match_export_rows(selected_cells: list[str], export_rows: list[dict]) -> list[dict]:
    """Export rows whose LP Name equals a cell of the selected Radius LP row."""
    cells = {normalize_lp(c) for c in selected_cells if normalize_lp(c)}
    return [row for row in export_rows if normalize_lp(row.get('lp_name')) in cells]


def lp_summary_code(status) -> str:
    text = ' '.join(str(status or '').casefold().split())
    if not text:
        return 'unknown'
    return {'in progress': 'in_progress', 'post': 'post', 'pre': 'pre',
            'update': 'update'}.get(text, 'other')


def evaluate_student(target: dict, choice: dict, grid: dict) -> dict:
    """Combine the live LP choice and grid into one read-only outcome.

    Returns status LIVE_COUNT, or REVIEW with a fixed reason code. Counts are
    included whenever the grid was readable, so reviews can still be checked.
    """
    selection = choice['selection']
    cells = {normalize_lp(c) for c in choice['cells']}
    others = set().union(*choice.get('other_cells', []))
    matches = match_export_rows(choice['cells'], target['export_rows'])
    # Export rows are tied to the selected LP only by title. If another Radius
    # LP has the same title, the export row could be either one: use none.
    shared = any(normalize_lp(row['lp_name']) in others for row in matches)
    export = matches[0] if len(matches) == 1 and not shared else None
    export_assigned = whole_number(export['assigned']) if export else None
    report_lp = normalize_lp(target['report_lp'])
    outcome = {
        'status': 'REVIEW', 'reason': None, 'outstanding': None,
        'proposed': None, 'selection': selection,
        'export_match': ('TITLE_SHARED' if shared else 'ONE' if export
                         else 'NONE' if not matches else 'MULTIPLE'),
        'export_assigned': export_assigned,
        'report_lp_selected': (None if report_lp in cells and report_lp in others
                               else report_lp in cells),
        'skills_left': None, 'grid': None,
    }
    try:
        assessed = assess_grid(grid, export_assigned)
    except NeedsReview as exc:
        outcome['reason'] = exc.code
        return outcome
    outcome['grid'] = assessed
    live = assessed['radius_assigned_not_mastered']
    if live is None:
        outcome['reason'] = 'DATE_COLUMNS_NOT_FOUND'
        outcome['headers'] = grid.get('headers')
        return outcome
    outcome['outstanding'] = live
    if not decision_is_stable(live, assessed['outstanding_if_conflicts_counted']):
        outcome['reason'] = 'CONFLICTING_COMPLETION_EVIDENCE'
        return outcome

    # Progress (skills left) for the POST rule comes ONLY from the export row
    # that uniquely belongs to the selected LP; otherwise it stays unverified.
    if export is not None and target.get('export_progress_columns_verified'):
        data = export['data']
        mastered = whole_number(data[EXPORT_MASTERED_IX]) if len(data) > EXPORT_TOTAL_IX else None
        total = whole_number(data[EXPORT_TOTAL_IX]) if len(data) > EXPORT_TOTAL_IX else None
        if mastered is not None and total is not None and total >= mastered:
            outcome['skills_left'] = total - mastered
    elif export is not None and export['row'] == target.get('source_row'):
        outcome['skills_left'] = whole_number(target.get('report_left'))
    outcome['proposed'] = printing_decision(
        assigned_not_mastered=live, skills_left=outcome['skills_left'],
        lp_summary_status=target.get('lp_summary_status') or '')
    outcome['status'] = 'LIVE_COUNT'
    return outcome


def validate_target(report_row: list, source_row: list, source_headers: list) -> dict:
    required = ('Student', 'LP Name', 'Skills Currently Assigned', 'Enrollment Status')
    if any(label not in source_headers for label in required):
        raise ValueError('Student Active LPs missing an expected column')
    if len(report_row) < 11:
        raise ValueError('Needs PKs Printed row is incomplete')
    flag, name, lp = [str(v or '').strip() for v in report_row[:3]]
    if not flag or not name or not lp:
        raise ValueError('Flag/student/LP report fields are blank')
    if not (flag.startswith('Needs new PKs printed') or
            flag.startswith('POST waits for their other LP') or
            flag == 'Counts missing from export - verify in Radius'):
        raise ValueError('Select a Needs new PKs or counts-missing row for this pilot')
    idx = {label: source_headers.index(label) for label in required}
    if any(idx[label] >= len(source_row) for label in required):
        raise ValueError('Source row has missing fields')
    if (parse_student_name(name) != parse_student_name(source_row[idx['Student']]) or
            normalize_lp(lp) != normalize_lp(source_row[idx['LP Name']])):
        raise ValueError('Report no longer matches source LP row; rerun Apps Script')
    if str(source_row[idx['Enrollment Status']]).strip().casefold() == 'inactive':
        raise ValueError('Inactive source LP is not eligible for this pilot')
    assigned = source_row[idx['Skills Currently Assigned']]
    try:
        val = float(assigned)
    except (TypeError, ValueError) as exc:
        raise ValueError('Invalid exported assigned count') from exc
    if val < 0 or not val.is_integer():
        raise ValueError('Exported assigned count is not a nonnegative integer')
    try:
        reported = float(report_row[3])
    except (TypeError, ValueError) as exc:
        raise ValueError('Reported assigned count is invalid') from exc
    if val != reported:
        raise ValueError('Report assigned count differs from source')
    return {'name': name, 'lp_name': lp, 'export_assigned': int(val)}
