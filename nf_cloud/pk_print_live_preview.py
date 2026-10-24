"""GitHub Actions READ-ONLY pilot: live outstanding-PK counts for Needs PKs Printed.

For each selected Needs PKs Printed report row:
  1. Preflight (no browser): the report row still matches Student Active LPs,
     the student matches exactly one All_Students record, and POST-waits rows
     are still In Progress in LP Summary.
  2. Radius (read-only): open the student's profile with the NF audit's
     proven search, read every Learning Plan's Active box and Created Date,
     select the active LP with the most recent Created Date, open it, and
     count PKs with a Date Assigned and no completion/mastery evidence.
  3. Print counts, fixed reason codes and a proposed flag. Ambiguous students
     are marked REVIEW; the other students are still checked.

No Google Sheets writes, no Radius Save, and no student names, LP titles or
URLs in logs, artifacts or checked-in files. POST production rules are not
changed. The live count needs human validation before Apps Script uses it.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import sys
import tempfile
import time

from nf_student_match import parse_student_name
from pk_print_live_rules import (EXPORT_MASTERED_IX, EXPORT_TOTAL_IX, choose_current_plan,
                                 evaluate_student, lp_summary_code, parse_report_rows,
                                 resolve_student, validate_target, whole_number)
from pk_print_policy import NeedsReview
from pk_print_radius_grid import safe_headers

ROOT = Path(__file__).resolve().parent
MASTER_ID = '1ssG8wRhtTwuvHWg1vDn1gx05RaeTR2cLl-VVcWNWKwE'
REPORT = 'Needs PKs Printed'
SHEET_LPS = 'Student Active LPs'
ROSTER = 'All_Students'
LP_SUMMARY_ID = '1aGIACG6Hm9MKlL0VgeznrecKiovN-ydNnDZdeF_RO3M'
LP_DIRECTORY = 'All Students Directory'
BASE = 'https://radius.mathnasium.com/'
REPORT_HEADERS = [
    'Flag', 'Student', 'LP', 'PKs assigned (G)', 'PKs left in LP (I - H)',
    'Skills mastered (H)', 'Total skills (I)', 'Status in LP Summary',
    'Active LPs', 'Enrollment status', 'Student Active LPs row'
]
MAX_CONSECUTIVE_ERRORS = 3


def secret_bytes(name: str) -> bytes:
    value = os.environ.get(name, '').strip()
    if not value:
        raise ValueError('Missing required GitHub secret')
    result = base64.b64decode(value, validate=True)
    payload = json.loads(result)
    if not isinstance(payload, dict):
        raise ValueError('Malformed GitHub secret JSON')
    if name == 'RADIUS_STORAGE_STATE_JSON_B64' and not (
            isinstance(payload.get('cookies'), list) and isinstance(payload.get('origins'), list)):
        raise ValueError('Invalid saved Radius browser state')
    return result


def fetch_tab(service, title, end, book_id=MASTER_ID, render='UNFORMATTED_VALUE'):
    quote = title.replace("'", "''")
    response = service.spreadsheets().values().get(
        spreadsheetId=book_id, range=f"'{quote}'!A1:{end}",
        valueRenderOption=render).execute()
    return response.get('values') or []


def checked_lp_summary_status(service, first: str, last: str, cache: dict | None = None) -> str:
    """Fresh read of LP Summary, never trust a stale report status.

    ``cache`` lets one preflight reuse a single read for every selected row;
    the post-run recheck passes no cache so it always reads again.
    """
    if cache is not None and 'values' in cache:
        values = cache['values']
    else:
        values = fetch_tab(service, LP_DIRECTORY, 'AZ2000', book_id=LP_SUMMARY_ID,
                           render='FORMATTED_VALUE')
        if cache is not None:
            cache['values'] = values
    if not values:
        raise ValueError('LP Summary directory not readable')
    # The Apps Script POST check refuses to run if Name Search B2 is filled.
    if len(values) > 1 and len(values[1]) > 1 and str(values[1][1] or '').strip():
        raise ValueError('LP Summary directory is filtered; clear Name Search B2')
    h = None
    for i, row in enumerate(values[:10]):
        headers = [' '.join(str(x).casefold().split()) for x in row]
        if 'first name' in headers and 'last name' in headers:
            if 'status' not in headers:
                raise ValueError('LP Summary missing Status column')
            h = (i, headers.index('first name'), headers.index('last name'),
                 headers.index('status'))
            break
    if h is None:
        raise ValueError('LP Summary directory headers missing')
    hi, f, l, status = h
    expected = (parse_student_name(first).base, parse_student_name(last).base)
    matches = []
    for row in values[hi + 1:]:
        if max(f, l, status) >= len(row):
            continue
        observed = (parse_student_name(str(row[f])).base, parse_student_name(str(row[l])).base)
        if observed == expected:
            matches.append(str(row[status] or '').strip())
    if len(matches) != 1:
        raise ValueError('LP Summary status did not have one exact student match')
    return matches[0]


def student_export_rows(lps: list[list], student_key) -> list[dict]:
    """Every Student Active LPs row for one student (any LP, in sheet order)."""
    h = [str(x).strip() for x in lps[0]]
    name_ix, lp_ix = h.index('Student'), h.index('LP Name')
    assigned_ix, enrollment_ix = h.index('Skills Currently Assigned'), h.index('Enrollment Status')
    rows = []
    for k, values in enumerate(lps[1:], 2):
        if max(name_ix, lp_ix, enrollment_ix, assigned_ix) >= len(values):
            continue
        if parse_student_name(str(values[name_ix])) == student_key:
            rows.append({'row': k, 'lp_name': str(values[lp_ix]).strip(),
                         'enrollment': str(values[enrollment_ix]).strip(),
                         'assigned': values[assigned_ix], 'data': list(values)})
    return rows


def build_target(report: list[list], lps: list[list], roster: list[list], row: int) -> dict:
    """Validate one report row against its sources. Does NOT choose an LP:
    the current LP is chosen later from live Radius Active + Created Date."""
    if not report or report[0][:11] != REPORT_HEADERS:
        raise ValueError('Unexpected Needs PKs Printed report format')
    if not lps:
        raise ValueError('Missing source Student Active LPs')
    if row > len(report):
        raise ValueError('Selected report row does not exist')
    raw = report[row - 1]
    if len(raw) < 11:
        raise ValueError('Report source row reference is missing')
    try:
        source_row_number = int(raw[10])
        if str(raw[10]).strip() not in (str(source_row_number), str(float(source_row_number))):
            raise ValueError('Report source row must be an integer')
    except (TypeError, ValueError) as exc:
        raise ValueError('Report source row reference is missing') from exc
    if source_row_number < 2 or source_row_number > len(lps):
        raise ValueError('Report points outside source sheet')
    source = lps[source_row_number - 1]
    details = validate_target(raw, source, [str(x).strip() for x in lps[0]])
    first, last = resolve_student(details['name'], roster)
    key = parse_student_name(details['name'])
    export_rows = student_export_rows(lps, key)
    active_count = whole_number(raw[8])
    if not active_count or len(export_rows) != active_count:
        raise ValueError('LP roster changed or active LP count is ambiguous')
    # The report's H/I values come from the export's H/I columns. Confirm that
    # on this row before using H/I for whichever LP Radius says is current.
    verified = (len(source) > EXPORT_TOTAL_IX and
                whole_number(source[EXPORT_MASTERED_IX]) is not None and
                whole_number(source[EXPORT_MASTERED_IX]) == whole_number(raw[5]) and
                whole_number(source[EXPORT_TOTAL_IX]) == whole_number(raw[6]))
    return {'report_row': row, 'source_row': source_row_number,
            'first': first, 'last': last, 'student_key': key,
            'report_lp': details['lp_name'],
            'report_assigned': details['export_assigned'],
            'report_left': raw[4],
            'export_rows': export_rows,
            'export_progress_columns_verified': verified,
            'flag_is_post_wait': str(raw[0]).startswith('POST waits for their other LP'),
            'source_snapshot': list(source), 'report_snapshot': list(raw)}


def inspect_one(ctx, management, target):
    """Open the student's current LP in Radius (read-only); return (choice, grid)."""
    from nf_auto_profile_audit import navigate_to_profile
    from nf_enrollment_control import set_enrollment_filter
    from nf_lp_plan_pilot import _wait_snapshot, _ident, _edit_link, _read_manager
    from pk_print_radius_grid import edit_link_target, extract_print_pk_grid, read_plan_list

    profile = None
    try:
        set_enrollment_filter(management, 'Enrolled')
        profile, match = navigate_to_profile(ctx, management, target['first'], target['last'])
        if profile is None or match.get('status') != 'UNIQUE_EXACT_MATCH':
            raise NeedsReview('STUDENT_LOOKUP_NOT_UNIQUE')
        try:
            snap, _ = _wait_snapshot(profile, timeout=40)
        except RuntimeError:
            # Rows without exactly one Edit link, or duplicate rows: this
            # student's plan list needs a person, not a retry.
            raise NeedsReview('LP_LIST_UNSETTLED') from None
        choice = choose_current_plan(snap, read_plan_list(profile), _ident)
        expected = {'identity': choice['identity'], 'active': True}
        confirmed, index = _wait_snapshot(profile, expected=expected, timeout=40)
        # Re-read right before clicking: the same LP must still be the choice.
        again = choose_current_plan(confirmed, read_plan_list(profile), _ident)
        if again['identity'] != choice['identity']:
            raise NeedsReview('LP_LIST_CHANGED')
        try:
            link = _edit_link(profile, confirmed, index)
        except RuntimeError:
            raise NeedsReview('LP_ROW_MISMATCH') from None
        # The Edit link must belong to the chosen row. A non-plan row in the
        # table could otherwise shift positions and open a different LP.
        if edit_link_target(link) != choice['stable_target']:
            raise NeedsReview('LP_ROW_MISMATCH')
        before = list(ctx.pages)
        link.click(timeout=20000)
        manager, settled = _read_manager(ctx, profile, before, timeout=65)
        if settled.get('pagination_controls_visible'):
            raise NeedsReview('LP_GRID_PAGINATED')
        return choice, extract_print_pk_grid(manager)
    finally:
        if profile is not None and profile is not management and not profile.is_closed():
            profile.close()
        for page in list(ctx.pages):
            if page is not management and not page.is_closed():
                page.close()


# Only these fixed, non-identifying messages may be converted into actionable
# log codes. Never log exception text, names, plan names or spreadsheet values.
_PREFLIGHT_REASONS = {
    'Unexpected Needs PKs Printed report format': 'REPORT_HEADER_CHANGED',
    'Missing source Student Active LPs': 'SOURCE_LP_TAB_MISSING',
    'Selected report row does not exist': 'REPORT_ROW_NOT_FOUND',
    'Report source row reference is missing': 'SOURCE_ROW_REFERENCE_MISSING',
    'Report points outside source sheet': 'SOURCE_ROW_OUT_OF_BOUNDS',
    'LP roster changed or active LP count is ambiguous': 'ACTIVE_LP_COUNT_MISMATCH',
    'Needs PKs Printed row is incomplete': 'REPORT_ROW_INCOMPLETE',
    'Flag/student/LP report fields are blank': 'REPORT_FIELDS_BLANK',
    'Select a Needs new PKs or counts-missing row for this pilot': 'FLAG_NOT_IN_PILOT_SCOPE',
    'Source row has missing fields': 'SOURCE_ROW_INCOMPLETE',
    'Inactive source LP is not eligible for this pilot': 'SOURCE_LP_INACTIVE',
    'Invalid exported assigned count': 'EXPORT_COUNT_INVALID',
    'Exported assigned count is not a nonnegative integer': 'EXPORT_COUNT_INVALID',
    'Reported assigned count is invalid': 'REPORT_COUNT_INVALID',
    'Empty or unreadable reported student': 'REPORT_STUDENT_BLANK',
    'Missing roster first/last name header': 'ROSTER_NAME_HEADERS_MISSING',
    'Empty All_Students source': 'ROSTER_EMPTY',
    'Unable to identify one exact, uniquely matched roster student': 'ROSTER_STUDENT_NOT_UNIQUE',
    'Report no longer matches source LP row; rerun Apps Script': 'REPORT_SOURCE_MISMATCH',
    'Report assigned count differs from source': 'REPORT_COUNT_STALE',
    'Student Active LPs missing an expected column': 'SOURCE_LP_HEADERS_MISSING',
    'LP Summary directory not readable': 'LP_SUMMARY_EMPTY',
    'LP Summary directory is filtered; clear Name Search B2': 'LP_SUMMARY_FILTER_ACTIVE',
    'LP Summary directory headers missing': 'LP_SUMMARY_HEADERS_MISSING',
    'LP Summary missing Status column': 'LP_SUMMARY_STATUS_COLUMN_MISSING',
    'LP Summary status did not have one exact student match': 'LP_SUMMARY_STUDENT_NOT_UNIQUE',
    'POST-waits student LP Summary status is not In Progress': 'POST_WAITS_STATUS_NOT_IN_PROGRESS',
}


def _preflight_reason(exc: Exception) -> str:
    # Exact match only: no user-supplied text is ever emitted in the log.
    return _PREFLIGHT_REASONS.get(str(exc), 'UNCLASSIFIED_VALIDATION_FAILURE')


def preflight_targets(api, report: list[list], lps: list[list],
                      roster: list[list], selected: list[int]) -> list[dict]:
    """Validate every selected report row before opening any Radius browser.

    Log only public-safe row numbers and enum-like reasons. If one row is
    stale or ambiguous, refuse the entire run (no partial or stale counts).
    Titles are no longer ranked here: an un-numbered LP is not a problem.
    """
    ready = []
    failures = 0
    summary_cache = {}
    for report_row in selected:
        try:
            target = build_target(report, lps, roster, report_row)
        except Exception as exc:
            failures += 1
            print(f'NEEDS PKS PREFLIGHT row={report_row}: BLOCKED; '
                  f'stage=TARGET; reason={_preflight_reason(exc)}', flush=True)
            continue
        summary_note = ''
        try:
            status = checked_lp_summary_status(api, target['first'], target['last'], summary_cache)
        except Exception as exc:
            code = _preflight_reason(exc)
            if code == 'UNCLASSIFIED_VALIDATION_FAILURE':
                code = 'LP_SUMMARY_READ_ERROR'
            if target['flag_is_post_wait'] or not isinstance(exc, ValueError):
                failures += 1
                print(f'NEEDS PKS PREFLIGHT row={report_row}: BLOCKED; '
                      f'stage=LP_SUMMARY; reason={code}', flush=True)
                continue
            # Only POST decisions need the status; without it they show REVIEW.
            status, summary_note = None, f'({code})'
        if target['flag_is_post_wait'] and lp_summary_code(status) != 'in_progress':
            failures += 1
            print(f'NEEDS PKS PREFLIGHT row={report_row}: BLOCKED; stage=LP_SUMMARY; '
                  f'reason=POST_WAITS_STATUS_NOT_IN_PROGRESS', flush=True)
            continue
        target['lp_summary_status'] = status
        ready.append(target)
        print(f'NEEDS PKS PREFLIGHT row={report_row}: PASSED; '
              f'lp_summary={lp_summary_code(status)}{summary_note}', flush=True)
    if failures:
        print(f'NEEDS PKS PREFLIGHT: BLOCKED; {failures}/{len(selected)} '
              f'row(s) need review; no Radius browser opened.', flush=True)
        raise ValueError('Preflight rejected one or more selected rows')
    return ready


def _flag(value) -> str:
    return 'n/a' if value is None else str(value).lower() if isinstance(value, bool) else str(value)


def format_outcome(target: dict, outcome: dict, seconds: float) -> list[str]:
    """Privacy-safe log lines: row numbers, counts, dates and fixed codes only."""
    row = target['report_row']
    selection = outcome.get('selection')
    counts = outcome.get('lp_counts')
    if selection:
        lp = (f"lp_rule={selection.rule}; active_lps={selection.active_count}; "
              f"inactive_lps={selection.inactive_count}; selected_created={_flag(selection.created)}")
    elif counts:
        lp = f"lp_rule=n/a; active_lps={counts[0]}; inactive_lps={counts[1]}"
    else:
        lp = 'lp_rule=n/a'
    if outcome['status'] == 'LIVE_COUNT':
        head = (f"Report row {row}: LIVE_COUNT outstanding={outcome['outstanding']}; "
                f"proposed={outcome['proposed']}")
    else:
        head = (f"Report row {row}: REVIEW reason={outcome['reason']}; "
                f"outstanding={_flag(outcome.get('outstanding'))}")
    lines = [f"{head}; {lp}; report_lp_selected={_flag(outcome.get('report_lp_selected'))}; "
             f"export_match={_flag(outcome.get('export_match'))}; "
             f"export_assigned={_flag(outcome.get('export_assigned'))}; "
             f"report_assigned={target['report_assigned']}; "
             f"skills_left={_flag(outcome.get('skills_left'))}; "
             f"lp_summary={lp_summary_code(target.get('lp_summary_status'))}; "
             f"seconds={seconds:.1f}"]
    grid = outcome.get('grid')
    if grid:
        lines.append(
            f"Report row {row} grid: export_vs_live={grid['classification']}; "
            f"pk_rows={grid['pk_rows_seen']}; archived_rows={grid['ignored_archived_rows']}; "
            f"date_assigned_rows={grid['assigned_date_rows']}; "
            f"date_completed_rows={grid['completed_date_rows']}; "
            f"mastered_rows={grid['radius_mastered']}; green_rows={grid['green_mastered_rows']}; "
            f"unchecked_rows={grid['radius_unmastered']}; "
            f"conflicting_completion_rows={_flag(grid['assigned_conflict_rows'])}; "
            f"outstanding_if_conflicts_counted={_flag(grid['outstanding_if_conflicts_counted'])}; "
            f"nf26_28_outstanding={grid['nf26_to_28_assigned_not_mastered']}")
    if outcome.get('headers') is not None:
        lines.append(f"Report row {row} grid columns: {safe_headers(outcome['headers'])}")
    return lines


def review_outcome(code: str, selection=None) -> dict:
    return {'status': 'REVIEW', 'reason': code, 'selection': selection}


def run_live(ctx, management, targets, inspect=inspect_one, back=None):
    """Inspect each target; a known ambiguity becomes REVIEW for that student
    only. Unexpected errors also become REVIEW, but three in a row stop."""
    outcomes = []
    consecutive_errors = 0
    for idx, target in enumerate(targets):
        started = time.monotonic()
        try:
            if idx and back is not None:
                management = back(management)
            choice, grid = inspect(ctx, management, target)
            outcome = evaluate_student(target, choice, grid)
            consecutive_errors = 0
        except NeedsReview as exc:
            outcome = review_outcome(exc.code)
            if exc.headers is not None:
                outcome['headers'] = exc.headers
            if getattr(exc, 'lp_counts', None):
                outcome['lp_counts'] = exc.lp_counts
            consecutive_errors = 0
        except Exception as exc:
            # Exception text can contain names or URLs: print the class only.
            outcome = review_outcome(f'RADIUS_ERROR_{type(exc).__name__}')
            consecutive_errors += 1
        outcomes.append(outcome)
        for line in format_outcome(target, outcome, time.monotonic() - started):
            print(line, flush=True)
        if consecutive_errors >= MAX_CONSECUTIVE_ERRORS:
            print(f'NEEDS PKS PRINTED PILOT: {MAX_CONSECUTIVE_ERRORS} unexpected Radius errors '
                  'in a row; stopping the remaining students.', flush=True)
            raise RuntimeError('Repeated Radius errors')
    return outcomes


def summary_line(targets, outcomes) -> str:
    parts = []
    for target, outcome in zip(targets, outcomes):
        value = (outcome['outstanding'] if outcome['status'] == 'LIVE_COUNT'
                 else f"REVIEW({outcome['reason']})")
        parts.append(f"{target['report_row']}={value}")
    return 'NEEDS PKS PRINTED LIVE COUNTS (report row=outstanding PKs): ' + ', '.join(parts)


POST_PROPOSALS = ('NEEDS_POST_PRINTED', 'POST_ALREADY_PRINTED', 'POST_DUE_OTHER_ASSESSMENT_PRINTED')


def verify_sources_unchanged(api, targets, outcomes):
    """Fail if the report, export or a status a decision used changed while browsing."""
    recheck = {}  # one fresh LP Summary read, shared by this recheck only
    later_report = fetch_tab(api, REPORT, 'K1000')
    later_lps = fetch_tab(api, SHEET_LPS, 'AZ2500')
    for target in targets:
        if (target['report_row'] > len(later_report) or
                target['source_row'] > len(later_lps) or
                later_report[target['report_row'] - 1] != target['report_snapshot'] or
                later_lps[target['source_row'] - 1] != target['source_snapshot']):
            raise ValueError('Flag report or source LP changed during the pilot')
        later_rows = student_export_rows(later_lps, target['student_key'])
        if [(r['row'], r['data']) for r in later_rows] != [
                (r['row'], r['data']) for r in target['export_rows']]:
            raise ValueError('Student Active LPs changed during the pilot')
    for target, outcome in zip(targets, outcomes):
        if target['flag_is_post_wait'] or outcome.get('proposed') in POST_PROPOSALS:
            later_status = checked_lp_summary_status(api, target['first'], target['last'], recheck)
            if target['flag_is_post_wait'] and lp_summary_code(later_status) != 'in_progress':
                raise ValueError('LP Summary status changed during POST-waits verification')
            if lp_summary_code(later_status) != lp_summary_code(target.get('lp_summary_status')):
                raise ValueError('LP Summary status changed during the pilot')


def main():
    parser = argparse.ArgumentParser(description='Verify Needs PKs Printed candidate rows against live Radius (read-only)')
    parser.add_argument('--report-rows', required=True,
                        help='Up to 50 report sheet rows, e.g. 2,27,32 or 2-46')
    args = parser.parse_args()
    selected = parse_report_rows(args.report_rows)

    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from playwright.sync_api import sync_playwright
    from nf_batch_audit_pilot import select_management_page, return_to_management

    with tempfile.TemporaryDirectory(prefix='needs-pk-readonly-') as temporary:
        private = Path(temporary)
        private.chmod(0o700)
        account = private / 'google.json'
        state = private / 'radius_state.json'
        account.write_bytes(secret_bytes('GOOGLE_SERVICE_ACCOUNT_JSON_B64'))
        state.write_bytes(secret_bytes('RADIUS_STORAGE_STATE_JSON_B64'))
        account.chmod(0o600)
        state.chmod(0o600)
        credentials = service_account.Credentials.from_service_account_file(
            str(account), scopes=['https://www.googleapis.com/auth/spreadsheets.readonly'])
        api = build('sheets', 'v4', credentials=credentials, cache_discovery=False)
        report = fetch_tab(api, REPORT, 'K1000')
        lps = fetch_tab(api, SHEET_LPS, 'AZ2500')
        roster = fetch_tab(api, ROSTER, 'AZ3000')
        targets = preflight_targets(api, report, lps, roster, selected)
        print(f'NEEDS PKS PRINTED PILOT: {len(targets)} report row(s); LP = newest active by '
              'Created Date; read-only.', flush=True)
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                ctx = browser.new_context(storage_state=str(state), viewport={'width': 1650, 'height': 900})
                management = ctx.new_page()
                management.goto(BASE + 'Student', wait_until='domcontentloaded', timeout=45000)
                management.locator('#StudentNameSearch:visible').wait_for(state='visible', timeout=30000)
                management = select_management_page(ctx)
                outcomes = run_live(ctx, management, targets, back=return_to_management)
            finally:
                browser.close()
        verify_sources_unchanged(api, targets, outcomes)
        print(summary_line(targets, outcomes), flush=True)
        live = sum(o['status'] == 'LIVE_COUNT' for o in outcomes)
        print(f'NEEDS PKS PRINTED READ-ONLY DIAGNOSTIC: COMPLETED; rows={len(outcomes)}; '
              f'live_counts={live}; review={len(outcomes) - live}.', flush=True)
        print('No changes to Radius, Google Sheets, Apps Script, POST rules or reports.', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        # Never print exception messages: they may include student names/URLs.
        print(f'NEEDS PKS PRINTED PILOT: STOPPED SAFE ({type(exc).__name__}). No writes.',
              file=sys.stderr, flush=True)
        raise SystemExit(1)
