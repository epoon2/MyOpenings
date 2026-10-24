"""Offline, synthetic tests: no Google/Radius access or student information."""
from __future__ import annotations

import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'nf_cloud'))

from pk_print_live_rules import assess_grid, parse_report_rows, resolve_student, validate_target
from pk_print_live_preview import build_target, preflight_targets, _preflight_reason

class FakeSheets:
    """Answers values().get().execute() with one fixed grid; counts reads."""

    def __init__(self, values):
        self.data, self.reads = values, 0

    def spreadsheets(self):
        return self

    def values(self):
        return self

    def get(self, **kwargs):
        return self

    def execute(self):
        self.reads += 1
        return {'values': self.data}


HEADERS = [
    'Flag', 'Student', 'LP', 'PKs assigned (G)', 'PKs left in LP (I - H)',
    'Skills mastered (H)', 'Total skills (I)', 'Status in LP Summary',
    'Active LPs', 'Enrollment status', 'Student Active LPs row'
]
LP_HEADERS = ['Student', 'LP Name', 'Skills Currently Assigned', 'Enrollment Status']


class PrintPreviewRules(unittest.TestCase):
    def grid(self, labels):
        return {'found_grid': True, 'table_data_rows': 15,
                'pagination_controls_visible': False, 'ambiguous_pk_rows': 0,
                'unreadable_pk_rows': 0, 'incomplete_pk_labels': labels,
                'ignored_archived_rows': 1, 'unrecognized_disabled_rows': 0}

    def test_manual_nf_rows_correct_undercount(self):
        outcome = assess_grid(self.grid(['PK - NF26', 'PK - NF27', 'PK - NF28',
                                         'PK - OA01', 'PK - OA02']), 2)
        self.assertEqual(outcome['radius_unmastered'], 5)
        self.assertEqual(outcome['nf26_to_28_incomplete'], 3)
        self.assertEqual(outcome['classification'], 'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND')
        self.assertFalse(outcome['assignment_column_found'])

    def test_regular_export_match(self):
        self.assertEqual(assess_grid(self.grid(['PK - NF26', 'PK - NF27']), 2)['classification'], 'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND')

    def test_export_overcount(self):
        self.assertEqual(assess_grid(self.grid(['PK - NF28']), 3)['classification'], 'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND')

    def test_explicit_assignment_column_is_only_diagnostic(self):
        grid=self.grid(['PK - NF26', 'PK - NF27', 'PK - NF28'])
        grid.update(assignment_column_found=True, assignment_marked_true=4,
                    assignment_marked_false=42, assignment_marked_unknown=0, pk_rows_seen=46)
        outcome=assess_grid(grid, 1)
        self.assertEqual(outcome['assignment_marked_true'], 4)
        self.assertEqual(outcome['classification'], 'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND')

    def test_unchecked_mastery_does_not_prove_assignment(self):
        grid=self.grid([f'PK - SKILL{i}' for i in range(43)])
        outcome=assess_grid(grid, 1)
        self.assertEqual(outcome['radius_unmastered'],43)
        self.assertIsNone(outcome['assignment_marked_true'])
        self.assertEqual(outcome['classification'],'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND')

    def test_duplicate_assigned_pk_labels_require_review(self):
        grid=self.live_dates(['PK - NF26', 'pk - NF26'], unmastered=['PK - NF26', 'pk - NF26'])
        with self.assertRaises(ValueError):
            assess_grid(grid, 2)

    def live_dates(self, assigned, unmastered=None):
        grid = self.grid(unmastered if unmastered is not None else assigned)
        grid.update(date_columns_found=True, date_assigned_column_found=True,
                    date_completed_column_found=True, pk_rows_seen=43,
                    ignored_archived_rows=0, assigned_date_rows=len(assigned),
                    no_assignment_date_rows=43-len(assigned),
                    assigned_not_mastered_labels=assigned, unknown_date_value_rows=0)
        return grid

    def test_manual_assignment_case_43_unmastered_but_only_4_assigned(self):
        # The four currently assigned rows are synthetic; never store real labels.
        assigned=['PK - NF26','PK - NF27','PK - NF28','PK - OA01']
        grid=self.live_dates(assigned, unmastered=[f'PK - OA{i:02}' for i in range(40)] + assigned[:3])
        outcome=assess_grid(grid,1)
        self.assertEqual(outcome['radius_unmastered'],43)
        self.assertEqual(outcome['radius_assigned_not_mastered'],4)
        self.assertEqual(outcome['classification'],'EXPORT_UNDERCOUNTS')
        self.assertEqual(outcome['nf26_to_28_assigned_not_mastered'],3)

    def test_export_matches_verified_live_dates(self):
        grid=self.live_dates(['PK - NF26','PK - NF27','PK - NF28'])
        self.assertEqual(assess_grid(grid,3)['classification'],'ASSIGNMENT_MATCH')

    def test_export_overcounts_verified_dates(self):
        grid=self.live_dates(['PK - NF26', 'PK - NF27'])
        self.assertEqual(assess_grid(grid,3)['classification'],'EXPORT_OVERCOUNTS')

    def test_missing_date_columns_never_generate_live_count(self):
        outcome=assess_grid(self.grid(['PK - NF26']*43),1)
        self.assertIsNone(outcome['radius_assigned_not_mastered'])
        self.assertEqual(outcome['classification'],'ASSIGNMENT_DATE_COLUMNS_NOT_FOUND')

    def test_unknown_date_format_fails_closed(self):
        grid=self.live_dates(['PK - NF26'])
        grid['unknown_date_value_rows']=1
        with self.assertRaises(ValueError): assess_grid(grid,1)

    def test_non_reconciled_date_rows_fail(self):
        grid=self.live_dates(['PK - NF26'])
        grid['no_assignment_date_rows']=40
        with self.assertRaises(ValueError): assess_grid(grid,1)

    def test_unknown_status_must_fail(self):
        source = self.grid(['PK - NF26'])
        source['unreadable_pk_rows'] = 1
        with self.assertRaises(ValueError):
            assess_grid(source, 1)

    def test_paginated_grid_must_fail(self):
        source = self.grid(['PK - NF26'])
        source['pagination_controls_visible'] = True
        with self.assertRaises(ValueError):
            assess_grid(source, 1)

    def test_non_pk_label_rejected(self):
        with self.assertRaises(ValueError):
            assess_grid(self.grid(['Question - NF26']), 0)

    def test_strict_student_compound_last_name(self):
        roster = [['First Name', 'Last Name'], ['First', 'De La Cruz'], ['Other', 'Last']]
        self.assertEqual(resolve_student('First De La Cruz', roster), ('First', 'De La Cruz'))

    def test_star_matters(self):
        roster = [['First Name', 'Last Name'], ['Alex', 'Lee'], ['Alex', 'Lee *']]
        self.assertEqual(resolve_student('Alex Lee *', roster), ('Alex', 'Lee *'))
        self.assertEqual(resolve_student('Alex Lee', roster), ('Alex', 'Lee'))

    def test_multiple_exact_records_ambiguous(self):
        with self.assertRaises(ValueError):
            resolve_student('Alex Lee', [['First Name', 'Last Name'], ['Alex', 'Lee'], ['Alex', 'Lee']])

    def test_row_parse(self):
        self.assertEqual(parse_report_rows('2, 4,12'), [2,4,12])
        self.assertEqual(parse_report_rows('2,27,32,39,49'), [2,27,32,39,49])
        self.assertEqual(parse_report_rows('2-5, 9'), [2,3,4,5,9])
        self.assertEqual(len(parse_report_rows('2-51')), 50)
        for value in ('1', '2,2', '2, a', '2-52', '5-2', '2-4,3', '', '2-3000000000'):
            with self.assertRaises(ValueError):
                parse_report_rows(value)

    def test_source_report_identity_gate(self):
        source = ['Casey Example', 'Learning Plan A', 2, 'Enrolled']
        report = ['Needs new PKs printed', 'Casey Example', 'Learning Plan A', 2,
                  5, 0, 5, '', 1, 'Enrolled', 2]
        self.assertEqual(validate_target(report, source, LP_HEADERS)['export_assigned'], 2)
        with self.assertRaises(ValueError):
            validate_target(report, ['Casey Example', 'Learning Plan B', 2, 'Enrolled'], LP_HEADERS)
        with self.assertRaises(ValueError):
            validate_target(report, ['Casey Example', 'Learning Plan A', 4, 'Enrolled'], LP_HEADERS)

    def test_not_eligible_post_flag_is_not_modified(self):
        with self.assertRaises(ValueError):
            validate_target(['Needs POST printed instead of PKs', 'Casey Example', 'LP', 2, 2, 0, 2,
                             '', 1, 'Enrolled', 2], ['Casey Example','LP',2,'Enrolled'], LP_HEADERS)

    def test_build_target_uses_source_row_and_exact_roster(self):
        report = [HEADERS, ['Needs new PKs printed', 'Casey Example', 'Learning Plan A', 2,
                            5,0,5,'',1,'Enrolled',2]]
        source = [LP_HEADERS, ['Casey Example', 'Learning Plan A', 2, 'Enrolled']]
        roster = [['First Name','Last Name'], ['Casey','Example']]
        self.assertEqual(build_target(report,source,roster,2)['first'], 'Casey')

    def test_report_header_mismatch_stops(self):
        with self.assertRaises(ValueError):
            build_target([['bad'], ['a']], [LP_HEADERS], [['First Name','Last Name']], 2)


    def test_batch_preflight_reports_each_problem_without_leaking_names(self):
        from contextlib import redirect_stdout
        from io import StringIO
        # Two valid synthetic students. The second has two active plans whose
        # names have no Checkup number: no longer a reason to block.
        roster = [['First Name', 'Last Name'], ['Sample', 'One'], ['Sample', 'Two']]
        report = [HEADERS,
            ['Needs new PKs printed', 'Sample One', 'Checkup #4 (Full)', 1, 11, 0, 11, '', 1, 'Enrolled', 2],
            ['Needs new PKs printed, has 2 active LPs', 'Sample Two', 'Geometry', 2, 9, 0, 9, 'In Progress', 2, 'Enrolled', 3]]
        lps = [LP_HEADERS, ['Sample One', 'Checkup #4 (Full)', 1, 'Enrolled'],
               ['Sample Two', 'Geometry', 2, 'Enrolled'], ['Sample Two', 'Algebra', 2, 'Enrolled']]
        directory = [[''], ['', ''], ['First Name', 'Last Name', 'Status'],
                     ['Sample', 'One', 'In Progress']]  # 'Sample Two' missing on purpose
        output = StringIO()
        with redirect_stdout(output):
            ready = preflight_targets(FakeSheets(directory), report, lps, roster, [2, 3])
        log = output.getvalue()
        self.assertEqual([t['report_row'] for t in ready], [2, 3])
        self.assertIn('row=2: PASSED; lp_summary=in_progress', log)
        self.assertIn('row=3: PASSED; lp_summary=unknown(LP_SUMMARY_STUDENT_NOT_UNIQUE)', log)
        self.assertNotIn('LP_TITLES_NOT_NUMBERED', log)
        self.assertNotIn('Sample', log)
        self.assertNotIn('Geometry', log)

    def test_batch_preflight_still_blocks_stale_rows_without_leaking_names(self):
        from contextlib import redirect_stdout
        from io import StringIO
        roster = [['First Name', 'Last Name'], ['Sample', 'One']]
        report = [HEADERS,
            ['Needs new PKs printed', 'Sample One', 'Checkup #4 (Full)', 3, 11, 0, 11, '', 1, 'Enrolled', 2]]
        lps = [LP_HEADERS, ['Sample One', 'Checkup #4 (Full)', 1, 'Enrolled']]
        output = StringIO()
        with redirect_stdout(output), self.assertRaises(ValueError):
            preflight_targets(None, report, lps, roster, [2])
        log = output.getvalue()
        self.assertIn('row=2: BLOCKED; stage=TARGET; reason=REPORT_COUNT_STALE', log)
        self.assertIn('no Radius browser opened', log)
        self.assertNotIn('Sample', log)

    def test_preflight_reason_unknown_is_sanitized(self):
        self.assertEqual(_preflight_reason(ValueError('Student: Sensitive Name')),
                         'UNCLASSIFIED_VALIDATION_FAILURE')

    def test_preflight_post_summary_stage_is_distinct(self):
        from contextlib import redirect_stdout
        from io import StringIO
        from unittest.mock import patch
        report = [HEADERS,
                  ['POST waits for their other LP, has 2 active LPs', 'Sample Student',
                   'Checkup #3 (Full)', 0, 2, 10, 12, 'In Progress', 2, 'Enrolled', 2]]
        lps = [LP_HEADERS,
               ['Sample Student', 'Checkup #3 (Full)', 0, 'Enrolled'],
               ['Sample Student', 'Checkup #4 (Full)', 2, 'Enrolled']]
        roster = [['First Name', 'Last Name'], ['Sample', 'Student']]
        output = StringIO()
        with patch('pk_print_live_preview.checked_lp_summary_status',
                   side_effect=ValueError('LP Summary directory headers missing')):
            with redirect_stdout(output), self.assertRaises(ValueError):
                preflight_targets(None, report, lps, roster, [2])
        self.assertIn('stage=LP_SUMMARY; reason=LP_SUMMARY_HEADERS_MISSING',
                      output.getvalue())



# --- Live LP selection (Active + newest Created Date) and counting ---------

from contextlib import redirect_stdout
from io import StringIO

from pk_print_live_rules import choose_current_plan, evaluate_student
from pk_print_live_preview import format_outcome, run_live, summary_line
from pk_print_policy import NeedsReview

RADIUS_EXAMPLE = [('Checkup #4 (Full)', '9/3/2026', True),
                  ('Checkup #3 (Full)', '2/12/2026', False),
                  ('WOB', '8/20/2025', False),
                  ('Mathnasium Checkup #2', '8/20/2025', False)]


def ident(plan):
    return plan['stable_target']


def listing(rows, headers=('name', 'created date', 'active', ''), pager_total=None):
    plans = [{'active': active, 'edit_count': 1,
              'stable_target': f'href:/LearningPlan/Edit/{i}',
              'cells': [name, created, '', 'Edit']}
             for i, (name, created, active) in enumerate(rows)]
    return {'table_index': 0, 'headers': list(headers), 'header_spans': [1] * len(headers),
            'plans': plans, 'pager_total': pager_total, 'pager_pages': 1}


def snapshot(lst):
    return {'table_index': 0, 'plans': [dict(p) for p in lst['plans']]}


def live_grid(outstanding, unchecked=None, conflicts=0, assigned_mastered=None,
              pk_rows=46, archived=0, dates=True):
    assigned_mastered = conflicts if assigned_mastered is None else assigned_mastered
    active = [f'PK - SKILL{i:02}' for i in range(outstanding)]
    unchecked = outstanding if unchecked is None else unchecked
    assigned_rows = outstanding + assigned_mastered
    return {'found_grid': True, 'table_data_rows': pk_rows + 2, 'headers':
            ['description', 'mastered', 'date assigned', 'date completed'] if dates
            else ['description', 'mastered'],
            'pagination_controls_visible': False, 'ambiguous_pk_rows': 0,
            'unreadable_pk_rows': 0, 'unrecognized_disabled_rows': 0,
            'incomplete_pk_labels': active + [f'PK - OTHER{i:02}' for i in range(unchecked - outstanding)],
            'mastered_pk_count': pk_rows - archived - unchecked, 'pk_rows_seen': pk_rows,
            'ignored_archived_rows': archived, 'date_columns_found': dates,
            'date_assigned_column_found': dates, 'date_completed_column_found': dates,
            'assigned_date_rows': assigned_rows if dates else 0,
            'completed_date_rows': 0,
            'no_assignment_date_rows': (pk_rows - archived - assigned_rows) if dates else 0,
            'assigned_not_mastered_labels': active if dates else [],
            'unknown_date_value_rows': 0, 'assigned_conflict_rows': conflicts if dates else 0,
            'green_mastered_rows': 0}


def target(report_lp='Checkup #4 (Full)', export=(('Checkup #4 (Full)', 1, 10, 12),),
           report_left=2, status='In Progress', verified=True, row=2):
    export_rows = [{'row': i + 2, 'lp_name': name, 'assigned': assigned, 'enrollment': 'Enrolled',
                    'data': ['Sample Student', name, assigned, 'Enrolled', '', '', assigned,
                             mastered, total]}
                   for i, (name, assigned, mastered, total) in enumerate(export)]
    source = [r['row'] for r in export_rows if r['lp_name'] == report_lp]
    return {'report_row': row, 'first': 'Sample', 'last': 'Student',
            'source_row': source[0] if source else None,
            'report_lp': report_lp, 'report_assigned': export[0][1] if export else 0,
            'report_left': report_left, 'export_rows': export_rows,
            'export_progress_columns_verified': verified, 'lp_summary_status': status,
            'flag_is_post_wait': False}


class ChooseCurrentPlan(unittest.TestCase):
    def test_radius_example_selects_newest_active_plan(self):
        lst = listing(RADIUS_EXAMPLE)
        choice = choose_current_plan(snapshot(lst), lst, ident)
        self.assertEqual(choice['identity'], 'href:/LearningPlan/Edit/0')
        self.assertEqual(choice['selection'].rule, 'ONLY_ACTIVE')
        self.assertEqual(choice['selection'].created, '2026-09-03')

    def test_two_active_plans_choose_latest_created_date_not_title(self):
        lst = listing([('Checkup #9 (Full)', '2/12/2026', True),
                       ('Geometry', '9/3/2026', True),
                       ('Checkup #10', '10/1/2026', False)])
        choice = choose_current_plan(snapshot(lst), lst, ident)
        self.assertEqual(choice['identity'], 'href:/LearningPlan/Edit/1')
        self.assertEqual(choice['selection'].rule, 'NEWEST_ACTIVE')
        self.assertEqual(choice['selection'].active_count, 2)

    def test_created_date_header_variants(self):
        for header in ('Created Date', 'date created', 'Created', 'Created On'):
            with self.subTest(header=header):
                lst = listing([('A', '2/12/2026', True), ('B', '9/3/2026', True)],
                              headers=('name', header, 'active', ''))
                self.assertEqual(choose_current_plan(snapshot(lst), lst, ident)['identity'],
                                 'href:/LearningPlan/Edit/1')

    def test_missing_created_column_only_matters_with_two_active_plans(self):
        one = listing(RADIUS_EXAMPLE, headers=('name', 'start', 'active', ''))
        self.assertEqual(choose_current_plan(snapshot(one), one, ident)['selection'].created, None)
        two = listing([('A', '2/12/2026', True), ('B', '9/3/2026', True)],
                      headers=('name', 'start', 'active', ''))
        with self.assertRaises(NeedsReview) as caught:
            choose_current_plan(snapshot(two), two, ident)
        self.assertEqual(caught.exception.code, 'CREATED_DATE_COLUMN_NOT_FOUND')
        self.assertEqual(caught.exception.headers, ['name', 'start', 'active', ''])
        self.assertEqual(caught.exception.lp_counts, (2, 0))

    def test_tie_review_carries_lp_counts(self):
        lst = listing([('A', '9/3/2026', True), ('B', '9/3/2026', True), ('C', '1/1/2026', False)])
        with self.assertRaises(NeedsReview) as caught:
            choose_current_plan(snapshot(lst), lst, ident)
        self.assertEqual(caught.exception.code, 'LATEST_ACTIVE_LP_TIE')
        self.assertEqual(caught.exception.lp_counts, (2, 1))

    def test_listing_must_match_the_settled_snapshot(self):
        lst = listing(RADIUS_EXAMPLE)
        moved = snapshot(lst)
        moved['plans'].reverse()
        for snap, lst2, code in (
                (moved, lst, 'LP_LIST_CHANGED'),
                (snapshot(lst), listing(RADIUS_EXAMPLE, pager_total=6), 'LP_LIST_PAGINATED'),
                (snapshot(lst), None, 'LP_LIST_UNREADABLE')):
            with self.subTest(code=code), self.assertRaises(NeedsReview) as caught:
                choose_current_plan(snap, lst2, ident)
            self.assertEqual(caught.exception.code, code)
        bad = listing(RADIUS_EXAMPLE)
        bad['plans'][1]['edit_count'] = 2
        with self.assertRaises(NeedsReview) as caught:
            choose_current_plan(snapshot(bad), bad, ident)
        self.assertEqual(caught.exception.code, 'LP_LIST_ROWS_NOT_UNIQUE')


class EvaluateStudent(unittest.TestCase):
    def choice(self, rows=RADIUS_EXAMPLE):
        lst = listing(rows)
        return choose_current_plan(snapshot(lst), lst, ident)

    def test_manual_assignment_case_counts_only_dated_unmastered_pks(self):
        # 43 unchecked mastery boxes, but only 4 PKs have a Date Assigned.
        outcome = evaluate_student(target(), self.choice(), live_grid(4, unchecked=43))
        self.assertEqual(outcome['status'], 'LIVE_COUNT')
        self.assertEqual(outcome['outstanding'], 4)
        self.assertEqual(outcome['proposed'], 'NO_NEW_PKS_NEEDED')
        self.assertEqual(outcome['grid']['classification'], 'EXPORT_UNDERCOUNTS')
        self.assertEqual(outcome['export_assigned'], 1)
        self.assertTrue(outcome['report_lp_selected'])

    def test_low_count_keeps_existing_printing_and_post_rules(self):
        self.assertEqual(evaluate_student(target(export=(('Checkup #4 (Full)', 2, 2, 12),)),
                                          self.choice(), live_grid(2))['proposed'],
                         'NEEDS_NEW_PKS_PRINTED')
        post = evaluate_student(target(export=(('Checkup #4 (Full)', 3, 10, 12),)),
                                self.choice(), live_grid(3))
        self.assertEqual(post['skills_left'], 2)
        self.assertEqual(post['proposed'], 'NEEDS_POST_PRINTED')

    def test_older_active_lp_is_never_used(self):
        # The report row points at the OLDER active LP; Radius says the newer one is current.
        rows = [('Checkup #3 (Full)', '2/12/2026', True), ('Checkup #4 (Full)', '9/3/2026', True)]
        t = target(report_lp='Checkup #3 (Full)',
                   export=(('Checkup #3 (Full)', 0, 10, 12), ('Checkup #4 (Full)', 2, 1, 12)))
        outcome = evaluate_student(t, self.choice(rows), live_grid(6))
        self.assertFalse(outcome['report_lp_selected'])
        self.assertEqual(outcome['export_assigned'], 2, 'export count from the newest LP only')
        self.assertEqual(outcome['skills_left'], 11)
        self.assertEqual(outcome['outstanding'], 6)
        self.assertEqual(outcome['proposed'], 'NO_NEW_PKS_NEEDED')

    def test_unverified_export_progress_falls_back_to_report_lp_only(self):
        t = target(verified=False, report_left=2, export=(('Checkup #4 (Full)', 3, 0, 40),))
        self.assertEqual(evaluate_student(t, self.choice(), live_grid(3))['skills_left'], 2)
        rows = [('Checkup #3 (Full)', '2/12/2026', True), ('Checkup #4 (Full)', '9/3/2026', True)]
        t = target(report_lp='Checkup #3 (Full)', verified=False,
                   export=(('Checkup #3 (Full)', 0, 10, 12), ('Checkup #4 (Full)', 2, 1, 12)))
        outcome = evaluate_student(t, self.choice(rows), live_grid(2))
        self.assertIsNone(outcome['skills_left'])
        self.assertEqual(outcome['proposed'], 'REVIEW_LP_PROGRESS_UNVERIFIED')

    def test_lp_missing_from_export_still_gets_a_live_count(self):
        outcome = evaluate_student(target(export=(('Other LP', 0, 0, 10),), report_lp='Other LP'),
                                   self.choice(), live_grid(4))
        self.assertEqual(outcome['export_match'], 'NONE')
        self.assertEqual(outcome['grid']['classification'], 'EXPORT_ROW_NOT_MATCHED')
        self.assertEqual(outcome['outstanding'], 4)

    def test_conflicting_evidence_reviewed_only_if_it_changes_the_decision(self):
        risky = evaluate_student(target(), self.choice(), live_grid(3, conflicts=1))
        self.assertEqual(risky['status'], 'REVIEW')
        self.assertEqual(risky['reason'], 'CONFLICTING_COMPLETION_EVIDENCE')
        self.assertEqual(risky['outstanding'], 3)
        harmless = evaluate_student(target(), self.choice(), live_grid(5, conflicts=2))
        self.assertEqual(harmless['status'], 'LIVE_COUNT')
        self.assertEqual(harmless['grid']['outstanding_if_conflicts_counted'], 7)

    def test_missing_date_columns_is_a_review_with_column_titles(self):
        outcome = evaluate_student(target(), self.choice(), live_grid(4, unchecked=43, dates=False))
        self.assertEqual(outcome['reason'], 'DATE_COLUMNS_NOT_FOUND')
        self.assertEqual(outcome['headers'], ['description', 'mastered'])

    def test_unreadable_grid_is_a_review(self):
        grid = live_grid(4)
        grid['unknown_date_value_rows'] = 1
        outcome = evaluate_student(target(), self.choice(), grid)
        self.assertEqual((outcome['status'], outcome['reason']), ('REVIEW', 'DATE_VALUE_UNREADABLE'))


class RunLive(unittest.TestCase):
    def run_pilot(self, results):
        results = list(results)
        targets = [target(row=r) for r in range(2, 2 + len(results))]
        lst = listing(RADIUS_EXAMPLE)

        def inspect(ctx, management, t):
            item = results.pop(0)
            if isinstance(item, BaseException):
                raise item
            return choose_current_plan(snapshot(lst), lst, ident), item

        out = StringIO()
        with redirect_stdout(out):
            try:
                outcomes = run_live(None, None, targets, inspect=inspect, back=lambda m: m)
            except RuntimeError:
                outcomes = None
        return targets, outcomes, out.getvalue()

    def test_reviews_and_errors_do_not_stop_other_students(self):
        tie = NeedsReview('LATEST_ACTIVE_LP_TIE')
        tie.lp_counts = (2, 1)
        targets, outcomes, log = self.run_pilot(
            [live_grid(4, unchecked=43), tie, TimeoutError('Sample Student'), live_grid(2)])
        self.assertEqual([o['status'] for o in outcomes],
                         ['LIVE_COUNT', 'REVIEW', 'REVIEW', 'LIVE_COUNT'])
        self.assertIn('Report row 3: REVIEW reason=LATEST_ACTIVE_LP_TIE', log)
        self.assertIn('active_lps=2; inactive_lps=1', log)
        self.assertIn('Report row 4: REVIEW reason=RADIUS_ERROR_TimeoutError', log)
        self.assertIn('Report row 2: LIVE_COUNT outstanding=4; proposed=NO_NEW_PKS_NEEDED', log)
        self.assertIn('selected_created=2026-09-03', log)
        summary = summary_line(targets, outcomes)
        self.assertTrue(summary.endswith('2=4, 3=REVIEW(LATEST_ACTIVE_LP_TIE), '
                                         '4=REVIEW(RADIUS_ERROR_TimeoutError), 5=2'))
        for private in ('Sample', 'Student', 'Checkup', 'WOB', 'LearningPlan', 'SKILL'):
            self.assertNotIn(private, log + summary)

    def test_three_unexpected_errors_in_a_row_stop(self):
        _, outcomes, log = self.run_pilot([TimeoutError(), RuntimeError(), TimeoutError(),
                                           live_grid(4)])
        self.assertIsNone(outcomes)
        self.assertIn('3 unexpected Radius errors in a row', log)

    def test_layout_reviews_print_column_titles_only(self):
        lines = format_outcome(target(), {'status': 'REVIEW', 'reason': 'DATE_COLUMNS_NOT_FOUND',
                                          'headers': ['Description', 'Mastered', 'Assigned On']}, 1.0)
        self.assertEqual(lines[-1], 'Report row 2 grid columns: description|mastered|assigned on')


class ReviewFixes(unittest.TestCase):
    """Cases found in code review: shared titles, hidden pagination, layout,
    Edit-link ownership, and POST status rechecks."""

    def choice(self, rows):
        lst = listing(rows)
        return choose_current_plan(snapshot(lst), lst, ident)

    def test_two_active_plans_with_the_same_title_never_borrow_numbers(self):
        rows = [('Checkup #4 (Full)', '2/12/2026', True), ('Checkup #4 (Full)', '9/3/2026', True)]
        for export in ((('Checkup #4 (Full)', 0, 10, 12), ('Checkup #4 (Full)', 2, 0, 30)),
                       (('Checkup #4 (Full)', 0, 10, 12),)):
            for verified in (True, False):
                with self.subTest(export_rows=len(export), verified=verified):
                    t = target(report_lp='Checkup #4 (Full)', export=export, report_left=2,
                               verified=verified)
                    outcome = evaluate_student(t, self.choice(rows), live_grid(3))
                    self.assertEqual(outcome['export_match'], 'TITLE_SHARED')
                    self.assertIsNone(outcome['export_assigned'])
                    self.assertIsNone(outcome['report_lp_selected'])
                    self.assertIsNone(outcome['skills_left'])
                    self.assertEqual(outcome['outstanding'], 3)
                    self.assertEqual(outcome['proposed'], 'REVIEW_LP_PROGRESS_UNVERIFIED')

    def test_shared_title_with_an_inactive_plan_is_also_untrusted(self):
        rows = [('Checkup #4 (Full)', '9/3/2026', True), ('Checkup #4 (Full)', '2/12/2026', False)]
        outcome = evaluate_student(target(), self.choice(rows), live_grid(5))
        self.assertEqual(outcome['export_match'], 'TITLE_SHARED')
        self.assertEqual(outcome['proposed'], 'NO_NEW_PKS_NEEDED', 'count is still live')

    def test_choice_keeps_row_identity_for_the_click_check(self):
        choice = self.choice(RADIUS_EXAMPLE)
        self.assertEqual(choice['stable_target'], 'href:/LearningPlan/Edit/0')
        self.assertEqual(len(choice['other_cells']), 3)

    def test_page_buttons_without_readable_total_mean_paginated(self):
        lst = listing(RADIUS_EXAMPLE)
        lst['pager_pages'] = 2
        with self.assertRaises(NeedsReview) as caught:
            choose_current_plan(snapshot(lst), lst, ident)
        self.assertEqual(caught.exception.code, 'LP_LIST_PAGINATED')

    def test_merged_or_uneven_columns_block_date_ranking(self):
        rows = [('A', '2/12/2026', True), ('B', '9/3/2026', True)]
        merged = listing(rows)
        merged['header_spans'] = [1, 1, 2, 1]
        uneven = listing(rows)
        uneven['plans'][0]['cells'].append('extra')
        for lst in (merged, uneven):
            with self.assertRaises(NeedsReview) as caught:
                choose_current_plan(snapshot(lst), lst, ident)
            self.assertEqual(caught.exception.code, 'LP_LIST_LAYOUT_UNVERIFIED')
        # A single active plan does not depend on the date column at all.
        single = listing(RADIUS_EXAMPLE)
        single['header_spans'] = [1, 1, 2, 1]
        self.assertEqual(choose_current_plan(snapshot(single), single, ident)['selection'].index, 0)

    def test_post_proposal_status_is_rechecked_after_browsing(self):
        from pk_print_live_preview import verify_sources_unchanged
        t = target(export=(('Checkup #4 (Full)', 3, 10, 12),), status='In Progress')
        t.update(student_key=__import__('nf_student_match').parse_student_name('Sample Student'),
                 report_snapshot=['r'], source_snapshot=['Sample Student', 'Checkup #4 (Full)', 3,
                                                         'Enrolled', '', '', 3, 10, 12])

        class Api:
            def __init__(self, status):
                self.status = status
            def spreadsheets(self):
                return self
            def values(self):
                return self
            def get(self, spreadsheetId=None, range=None, valueRenderOption=None):
                self.range = range
                return self
            def execute(self):
                if 'Needs PKs Printed' in self.range:
                    return {'values': [HEADERS, ['r']]}
                if 'Student Active LPs' in self.range:
                    return {'values': [LP_HEADERS, t['source_snapshot']]}
                return {'values': [[''], ['', ''], ['First Name', 'Last Name', 'Status'],
                                   ['Sample', 'Student', self.status]]}

        outcome = {'proposed': 'NEEDS_POST_PRINTED'}
        verify_sources_unchanged(Api('In Progress'), [t], [outcome])
        with self.assertRaises(ValueError):
            verify_sources_unchanged(Api('POST'), [t], [outcome])
        verify_sources_unchanged(Api('POST'), [t], [{'proposed': 'NO_NEW_PKS_NEEDED'}])

if __name__ == '__main__':
    unittest.main()

# Further test cases live in tests/test_pk_print_policy.py.
