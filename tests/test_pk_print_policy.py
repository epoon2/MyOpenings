"""Tests use synthetic records; no real student data is checked into GitHub."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'nf_cloud'))

from pk_print_policy import (NeedsReview, decision_is_stable, parse_created_date,
                             printing_decision, select_current_lp)
from pk_print_live_preview import build_target
from pk_print_live_rules import validate_target

HEADERS = ['Flag', 'Student', 'LP', 'PKs assigned (G)', 'PKs left in LP (I - H)',
           'Skills mastered (H)', 'Total skills (I)', 'Status in LP Summary',
           'Active LPs', 'Enrollment status', 'Student Active LPs row']
LP = ['Student','LP Name','Skills Currently Assigned','Enrollment Status']
# Same first four columns plus G/H/I positions, like the real export's letters.
LP_HI = ['Student', 'LP Name', 'Skills Currently Assigned', 'Enrollment Status',
         'E', 'F', 'G', 'Skills Mastered', 'Total Skills']
ROSTER = [['First Name','Last Name'], ['Sample','Student']]


def plan(created, active, name='Any title'):
    return {'created': created, 'active': active, 'name': name}


class CurrentLPSelection(unittest.TestCase):
    def assertReview(self, code, plans):
        with self.assertRaises(NeedsReview) as caught:
            select_current_lp(plans)
        self.assertEqual(caught.exception.code, code)

    def test_example_from_radius_selects_the_only_active_lp(self):
        # Checkup #4 (9/3/2026, active), #3 (2/12/2026), WOB and #2 (8/20/2025).
        plans = [plan('9/3/2026', True, 'Checkup #4 (Full)'),
                 plan('2/12/2026', False, 'Checkup #3 (Full)'),
                 plan('8/20/2025', False, 'WOB'),
                 plan('8/20/2025', False, 'Mathnasium Checkup #2')]
        choice = select_current_lp(plans)
        self.assertEqual(choice.index, 0)
        self.assertEqual(choice.rule, 'ONLY_ACTIVE')
        self.assertEqual((choice.active_count, choice.inactive_count), (1, 3))
        self.assertEqual(choice.created, '2026-09-03')

    def test_single_active_lp_is_chosen_whatever_its_name_or_date(self):
        for created in ('9/3/2026', '', 'not a date'):
            with self.subTest(created=created):
                choice = select_current_lp([plan('1/1/2027', False, 'Checkup #9'),
                                            plan(created, True, 'Geometry')])
                self.assertEqual(choice.index, 1)
                self.assertEqual(choice.rule, 'ONLY_ACTIVE')

    def test_two_active_lps_choose_newest_created_date(self):
        plans = [plan('2/12/2026', True, 'Checkup #9'), plan('9/3/2026', True, 'Algebra')]
        choice = select_current_lp(plans)
        self.assertEqual(choice.index, 1)
        self.assertEqual(choice.rule, 'NEWEST_ACTIVE')
        self.assertEqual(choice.created, '2026-09-03')
        # Order on the page never matters.
        self.assertEqual(select_current_lp(plans[::-1]).index, 0)

    def test_newer_inactive_lp_is_ignored(self):
        plans = [plan('2/12/2026', True), plan('10/1/2026', False), plan('1/5/2026', True)]
        self.assertEqual(select_current_lp(plans).index, 0)

    def test_no_active_lp_needs_review(self):
        self.assertReview('NO_ACTIVE_LP', [plan('9/3/2026', False), plan('2/12/2026', False)])
        self.assertReview('NO_LEARNING_PLANS', [])
        self.assertReview('ACTIVE_STATE_UNREADABLE', [plan('9/3/2026', None)])

    def test_same_latest_date_needs_review(self):
        self.assertReview('LATEST_ACTIVE_LP_TIE',
                          [plan('9/3/2026', True), plan('09/03/2026', True), plan('1/1/2026', True)])
        self.assertReview('LATEST_ACTIVE_LP_TIE',
                          [plan('9/3/2026 3:00 PM', True), plan('9/3/2026', True)])
        self.assertReview('LATEST_ACTIVE_LP_TIE',
                          [plan('9/3/2026 3:00 PM', True), plan('9/3/2026 3:00 PM', True)])

    def test_distinct_times_break_a_same_day_tie(self):
        choice = select_current_lp([plan('9/3/2026 3:00 PM', True), plan('9/3/2026 4:15 PM', True)])
        self.assertEqual(choice.index, 1)

    def test_unreadable_competing_date_needs_review(self):
        self.assertReview('CREATED_DATE_UNREADABLE', [plan('9/3/2026', True), plan('', True)])
        # An unreadable date on an inactive LP does not matter.
        self.assertEqual(select_current_lp([plan('', False), plan('9/3/2026', True),
                                            plan('2/1/2026', True)]).index, 1)

    def test_date_formats(self):
        for text in ('9/3/2026', '09/03/2026', '9/3/26', '2026-09-03', 'Sep 3, 2026',
                     'September 3 2026', '9/3/2026 3:45 PM', '2026-09-03T14:05:00'):
            with self.subTest(text=text):
                self.assertEqual(parse_created_date(text)[0].isoformat(), '2026-09-03')
        for text in ('', '-', '13/40/2026', 'Checkup #4', '9/3/2026 later', '9/3/20261'):
            with self.subTest(text=text), self.assertRaises(NeedsReview):
                parse_created_date(text)


class PrintingRules(unittest.TestCase):
    def test_newest_lp_status_and_count_only(self):
        self.assertEqual(printing_decision(assigned_not_mastered=5, skills_left=1,
                                         lp_summary_status='In Progress'),'NO_NEW_PKS_NEEDED')
        self.assertEqual(printing_decision(assigned_not_mastered=2, skills_left=12,
                                         lp_summary_status='In Progress'),'NEEDS_NEW_PKS_PRINTED')
        self.assertEqual(printing_decision(assigned_not_mastered=3, skills_left=2,
                                         lp_summary_status='In Progress'),'NEEDS_POST_PRINTED')
        self.assertEqual(printing_decision(assigned_not_mastered=3, skills_left=2,
                                         lp_summary_status='POST'),'POST_ALREADY_PRINTED')
        self.assertEqual(printing_decision(assigned_not_mastered=3, skills_left=2,
                                         lp_summary_status='Update'),'POST_DUE_OTHER_ASSESSMENT_PRINTED')
        self.assertEqual(printing_decision(assigned_not_mastered=2, skills_left=None,
                                         lp_summary_status='In Progress'),'REVIEW_LP_PROGRESS_UNVERIFIED')
        self.assertEqual(printing_decision(assigned_not_mastered=None, skills_left=2,
                                         lp_summary_status='In Progress'),'REVIEW_ASSIGNMENT_UNVERIFIED')

    def test_conflicts_only_matter_when_they_cross_the_threshold(self):
        self.assertTrue(decision_is_stable(5, 7))
        self.assertTrue(decision_is_stable(1, 3))
        self.assertFalse(decision_is_stable(3, 4))
        self.assertFalse(decision_is_stable(2, 6))

    def test_manual_review_distribution(self):
        # These are count frequencies supplied by the user, without identities.
        counts = [2] + [3]*7 + [4]*12 + [5]*7 + [6]*18
        self.assertEqual(len(counts),45)
        self.assertEqual(sum(v>3 for v in counts),37)
        self.assertEqual(sum(v<=3 for v in counts),8)


class BuildTarget(unittest.TestCase):
    def test_post_waits_flag_can_enter_pilot(self):
        flag=['POST waits for their other LP, has 2 active LPs','Sample Student',
              'Checkup #3 (Full)',2, 2, 10,12,'In Progress',2,'Enrolled',2]
        source=['Sample Student','Checkup #3 (Full)',2,'Enrolled']
        self.assertEqual(validate_target(flag,source,LP)['export_assigned'],2)

    def test_unnumbered_titles_are_no_longer_blocked(self):
        flags=[HEADERS, ['Needs new PKs printed, has 2 active LPs','Sample Student',
                        'Geometry',2,8,3,11,'In Progress',2,'Enrolled',2]]
        source=[LP, ['Sample Student','Geometry',2,'Enrolled'],
                ['Sample Student','WOB',1,'Enrolled']]
        t=build_target(flags,source,ROSTER,2)
        self.assertEqual([r['lp_name'] for r in t['export_rows']], ['Geometry', 'WOB'])
        self.assertEqual([r['row'] for r in t['export_rows']], [2, 3])
        self.assertEqual(t['report_lp'], 'Geometry')
        self.assertNotIn('lp_name', t, 'the LP is chosen from live Radius, not here')

    def test_progress_columns_verified_only_when_h_and_i_match(self):
        flags=[HEADERS, ['Needs new PKs printed','Sample Student','Checkup #4 (Full)',
                         1,10,2,12,'In Progress',1,'Enrolled',2]]
        good=[LP_HI, ['Sample Student','Checkup #4 (Full)',1,'Enrolled','','',1,2,12]]
        self.assertTrue(build_target(flags,good,ROSTER,2)['export_progress_columns_verified'])
        bad=[LP_HI, ['Sample Student','Checkup #4 (Full)',1,'Enrolled','','',1,5,40]]
        self.assertFalse(build_target(flags,bad,ROSTER,2)['export_progress_columns_verified'])
        short=[LP, ['Sample Student','Checkup #4 (Full)',1,'Enrolled']]
        self.assertFalse(build_target(flags,short,ROSTER,2)['export_progress_columns_verified'])

    def test_active_lp_count_must_match_export(self):
        flags=[HEADERS, ['Needs new PKs printed','Sample Student','Checkup #4 (Full)',
                         1,10,0,10,'In Progress',2,'Enrolled',2]]
        source=[LP, ['Sample Student','Checkup #4 (Full)',1,'Enrolled']]
        with self.assertRaises(ValueError):
            build_target(flags,source,ROSTER,2)


class SummaryReadSafety(unittest.TestCase):
    class _Service:
        def __init__(self, values):
            self.data = values
            self.reads = 0
        def spreadsheets(self):
            return self
        def values(self):
            return self
        def get(self, **kwargs):
            return self
        def execute(self):
            self.reads += 1
            return {'values': self.data}

    def test_exact_in_progress_status(self):
        from pk_print_live_preview import checked_lp_summary_status
        sheet=[[''],['',''],['First Name','Last Name','Status'],
               ['Example','Student','In Progress'],['Other','Person','POST']]
        self.assertEqual(checked_lp_summary_status(self._Service(sheet), 'Example', 'Student'),
                         'In Progress')

    def test_cache_reads_the_directory_once(self):
        from pk_print_live_preview import checked_lp_summary_status
        sheet=[[''],['',''],['First Name','Last Name','Status'],
               ['Example','Student','In Progress'],['Other','Person','POST']]
        service, cache = self._Service(sheet), {}
        self.assertEqual(checked_lp_summary_status(service,'Example','Student',cache),'In Progress')
        self.assertEqual(checked_lp_summary_status(service,'Other','Person',cache),'POST')
        self.assertEqual(service.reads, 1)

    def test_ambiguous_directory_is_not_accepted(self):
        from pk_print_live_preview import checked_lp_summary_status
        sheet=[['First Name','Last Name','Status'],
               ['Example','Student','In Progress'],
               ['Example','Student','POST']]
        with self.assertRaises(ValueError):
            checked_lp_summary_status(self._Service(sheet),'Example','Student')

    def test_filtered_directory_stops(self):
        from pk_print_live_preview import checked_lp_summary_status
        sheet=[[''],['','A name'],['First Name','Last Name','Status'],
               ['Example','Student','In Progress']]
        with self.assertRaises(ValueError):
            checked_lp_summary_status(self._Service(sheet),'Example','Student')


if __name__=='__main__':
    unittest.main()
