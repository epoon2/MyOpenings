"""Read-only Radius readers for Needs PKs Printed.

1. JS_PLAN_LIST reads the student profile's Learning Plans table: each row's
   Active checkbox, its cell text (Created Date is read from it), and the
   same in-memory row identity the NF audit uses to reopen a plan safely.
2. JS_PK_GRID reads the opened LP's grid: Date Assigned and completion
   evidence for every PK row.

Nothing here clicks Save or edits Radius. Cell text stays in memory only and
is never printed or written anywhere.
"""
from __future__ import annotations

import re

# The row filtering and stable_target below are deliberately identical to
# nf_lp_plan_pilot.PLAN_TABLE_JS, so _ident() and _wait_snapshot() positions
# line up with this listing.
JS_PLAN_LIST = r'''() => {
  const visible = e => !!e && !!e.getClientRects().length &&
    getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  for (const [tableIndex, table] of [...document.querySelectorAll('table')].entries()) {
    if (!visible(table)) continue;
    const rows = [...table.querySelectorAll('tr')].filter(visible);
    const headerIndex = rows.findIndex(r =>
      [...r.children].some(c => (c.innerText || '').trim().toLowerCase() === 'active'));
    if (headerIndex < 0) continue;
    const headers = [...rows[headerIndex].children]
      .map(c => (c.innerText || '').trim().toLowerCase());
    const headerSpans = [...rows[headerIndex].children].map(c => Number(c.colSpan || 1));
    const activeIndex = headers.indexOf('active');
    if (activeIndex < 0) continue;
    const plans = [];
    for (const row of rows.slice(headerIndex + 1)) {
      const cells = [...row.children].filter(c => c.tagName === 'TD');
      if (!cells.length || !cells[activeIndex]) continue;
      const box = cells[activeIndex].querySelector('input[type=checkbox],[role=checkbox]');
      const edits = [...row.querySelectorAll('a,button,input[type=button]')]
        .filter(visible)
        .filter(e => /^edit$/i.test((e.innerText || e.value || '').trim()));
      const edit = edits.length === 1 ? edits[0] : null;
      const href = edit?.getAttribute('href') || '';
      const rowText = cells.map(c => (c.innerText || '').trim()).join('|');
      const stableTarget = href && href !== '#' && !href.startsWith('javascript:')
        ? 'href:' + href
        : 'text:' + rowText;
      plans.push({
        active: box ? (box.matches('input') ? !!box.checked : box.getAttribute('aria-checked') === 'true') : null,
        edit_count: edits.length,
        stable_target: stableTarget,
        cells: cells.map(c => (c.innerText || '').replace(/ /g, ' ').trim())
      });
    }
    if (plans.some(p => p.edit_count)) {
      // A Kendo pager ("1 - 5 of 7 items") means some plans are on another
      // page. Read the info text even if a narrow layout hides it; otherwise
      // count the page-number buttons.
      let pagerTotal = null, pagerPages = 0;
      const grid = table.closest('.k-grid');
      if (grid) {
        for (const info of grid.querySelectorAll('.k-pager-info')) {
          const m = /of\s+(\d+)/i.exec(info.textContent || '');
          if (m) { pagerTotal = Number(m[1]); break; }
        }
        const labels = new Set([...grid.querySelectorAll(
          '.k-pager-numbers a, .k-pager-numbers button, .k-pager-numbers span, .k-pager-numbers option')]
          .map(e => (e.textContent || '').trim()).filter(t => /^\d+$/.test(t)));
        pagerPages = labels.size;
      }
      return {table_index: tableIndex, headers, header_spans: headerSpans, plans,
              pager_total: pagerTotal, pager_pages: pagerPages};
    }
  }
  return null;
}'''


def read_plan_list(page) -> dict | None:
    """Learning Plans table with Active state and cell text (in memory only)."""
    return page.evaluate(JS_PLAN_LIST)


# Rebuilds, for the exact Edit element about to be clicked, the same
# stable_target JS_PLAN_LIST computed for its row.
JS_EDIT_TARGET = r'''(e) => {
  const edit = e.closest('a,button,input[type=button]') || e;
  const href = edit.getAttribute('href') || '';
  const row = edit.closest('tr');
  const cells = row ? [...row.children].filter(c => c.tagName === 'TD') : [];
  const rowText = cells.map(c => (c.innerText || '').trim()).join('|');
  return href && href !== '#' && !href.startsWith('javascript:') ? 'href:' + href : 'text:' + rowText;
}'''


def edit_link_target(link) -> str | None:
    """stable_target of the row that owns this Edit link (in memory only)."""
    return link.evaluate(JS_EDIT_TARGET)


JS_PK_GRID = r'''() => {
  const visible = e => !!e && !!e.getClientRects().length &&
    getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none';
  const canonical = v => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const pkRe = /^\s*PK(?:\s*[-–—:]\s*|\s+)(?=\S)/i;
  const result = {found_grid:false, table_data_rows:0, headers:[],
    pagination_controls_visible:false, ambiguous_pk_rows:0, unreadable_pk_rows:0,
    unrecognized_disabled_rows:0, ignored_archived_rows:0, incomplete_pk_labels:[],
    mastered_pk_count:0, pk_rows_seen:0, selected_pk_rows:0,
    assignment_column_found:false, assignment_marked_true:0,
    assignment_marked_false:0, assignment_marked_unknown:0,
    explicitly_assigned_not_mastered:0,
    date_assigned_column_found:false, date_completed_column_found:false,
    date_columns_found:false, assigned_date_rows:0, completed_date_rows:0,
    assigned_not_mastered_labels:[], green_mastered_rows:0,
    no_assignment_date_rows:0, unknown_date_value_rows:0,
    assigned_conflict_rows:0};
  const gray = cell => {
    const style=getComputedStyle(cell).backgroundColor.replace(/\s+/g,'').toLowerCase();
    return style === 'rgb(211,211,211)' || style === 'rgba(211,211,211,1)';
  };
  const green = cell => {
    if (!cell) return false;
    const color=getComputedStyle(cell).backgroundColor;
    const m=/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(color);
    if (!m || (m[4] !== undefined && Number(m[4]) < 0.75)) return false;
    const r=Number(m[1]), g=Number(m[2]), b=Number(m[3]);
    return g >= 110 && g-r >= 18 && g-b >= 12;
  };
  const cellText = cell => {
    if (!cell) return '';
    const text=(cell.innerText || '').replace(/ /g,' ').trim();
    if (text) return text;
    const input=cell.querySelector('input:not([type="checkbox"])');
    return input ? String(input.value || '').trim() : '';
  };
  const dateValue = cell => {
    const raw=cellText(cell);
    if (!raw || ['-','—','–'].includes(raw)) return false;
    // Be permissive about the date's display format, but reject non-date status text.
    if (/^(?:\d{1,4}[\/-]\d{1,2}[\/-]\d{1,4}|[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4})(?:[\sT]+.*)?$/.test(raw)) return true;
    return null;
  };
  for (const table of document.querySelectorAll('table')) {
    if (!visible(table)) continue;
    const rows = [...table.querySelectorAll('tr')].filter(visible);
    const head = rows.find(r => {
      const h = [...r.children].map(c=>canonical(c.innerText));
      return h.includes('description') && h.includes('mastered');
    });
    if (!head) continue;
    result.found_grid = true;
    const h = [...head.children].map(c=>canonical(c.innerText));
    result.headers = h;
    const d = h.indexOf('description'), m = h.indexOf('mastered');
    const a = h.findIndex(name => /^(currently assigned|skills currently assigned|assigned|is assigned)$/.test(name));
    const da = h.findIndex(name => /^(date assigned|assigned date|assigned on|date assigned on)$/.test(name));
    const dc = h.findIndex(name => /^(date completed|completed date|completed on|completion date|date mastered|mastered date|mastered on)$/.test(name));
    result.assignment_column_found = a >= 0;
    result.date_assigned_column_found = da >= 0;
    result.date_completed_column_found = dc >= 0;
    result.date_columns_found = da >= 0 && dc >= 0;
    result.pagination_controls_visible = [...document.querySelectorAll('.k-pager-wrap,.k-pager-info,.k-pager-nav')].some(visible);
    for (const tr of rows.slice(rows.indexOf(head)+1)) {
      const cells = [...tr.children].filter(c => c.tagName === 'TD');
      if (cells.length <= Math.max(d,m)) continue;
      result.table_data_rows++;
      const desc = cellText(cells[d]);
      if (!pkRe.test(desc)) {
        if (/\bPK\b/i.test(desc)) result.ambiguous_pk_rows++;
        continue;
      }
      result.pk_rows_seen++;
      if (tr.matches('.k-state-selected,.k-selected,[aria-selected="true"]')) result.selected_pk_rows++;
      let assignment = null;
      if (a >= 0 && cells.length > a) {
        const assignmentCell = cells[a];
        const mark = assignmentCell.querySelector('input[type="checkbox"], [role="checkbox"]');
        if (mark) {
          assignment = mark.matches('input') ? mark.checked :
            (mark.getAttribute('aria-checked') === 'true' ? true :
             mark.getAttribute('aria-checked') === 'false' ? false : null);
        } else {
          const value=canonical(assignmentCell.innerText);
          assignment = ['yes','true','assigned'].includes(value) ? true :
            (['no','false','unassigned','not assigned'].includes(value) ? false : null);
        }
        if (assignment === true) result.assignment_marked_true++;
        else if (assignment === false) result.assignment_marked_false++;
        else result.assignment_marked_unknown++;
      }
      const checkbox = cells[m].querySelector('input.masterCheck[type="checkbox"],input[type="checkbox"],[role="checkbox"]');
      if (!checkbox) {result.unreadable_pk_rows++;continue;}
      const input = checkbox.matches('input');
      const checked = input ? checkbox.checked : checkbox.getAttribute('aria-checked') === 'true';
      const disabled = input ? checkbox.disabled : checkbox.getAttribute('aria-disabled') === 'true';
      // Same archived-row rule as the NF audit: disabled, unchecked, grey.
      if (disabled && !checked && gray(cells[d]) && gray(cells[m])) {
        result.ignored_archived_rows++;
        continue;
      }
      if (disabled) {result.unrecognized_disabled_rows++;result.unreadable_pk_rows++;continue;}
      const assignedDate = result.date_columns_found && cells.length > Math.max(da,dc) ? dateValue(cells[da]) : null;
      const completedDate = result.date_columns_found && cells.length > Math.max(da,dc) ? dateValue(cells[dc]) : null;
      if (result.date_columns_found && (assignedDate === null || completedDate === null)) {
        result.unknown_date_value_rows++;
      }
      const isGreen = green(tr) || green(cells[d]) || green(cells[m]) || (dc >= 0 && green(cells[dc]));
      if (isGreen) result.green_mastered_rows++;
      const completed = completedDate === true;
      // Any one completion signal means mastered (not outstanding).
      const mastered = checked || completed || isGreen;
      if (mastered) result.mastered_pk_count++;
      else result.incomplete_pk_labels.push(desc);
      if (assignedDate === true) result.assigned_date_rows++;
      if (completed) result.completed_date_rows++;
      if (result.date_columns_found && assignedDate === false) result.no_assignment_date_rows++;
      if (assignedDate === true && !mastered) {
        result.assigned_not_mastered_labels.push(desc);
        if (assignment === true) result.explicitly_assigned_not_mastered++;
      }
      // Conflicting evidence: some completion signal, but the Mastered box and
      // Date Completed do not both confirm it. Counted, never silently resolved.
      if (assignedDate === true && mastered && !(checked && completed)) {
        result.assigned_conflict_rows++;
      }
    }
    return result;
  }
  return result;
}'''


def extract_print_pk_grid(page):
    return page.evaluate(JS_PK_GRID)


_UNSAFE_HEADER_CHARS = re.compile(r'[^a-z0-9 #()/&.+-]')


def safe_headers(headers) -> str:
    """Column titles only (e.g. 'description|mastered'), for diagnosing layout.

    Header labels are Radius UI text, not student data; they are still
    restricted to plain characters and truncated before printing.
    """
    if not isinstance(headers, list):
        return 'unreadable'
    cleaned = [_UNSAFE_HEADER_CHARS.sub('', ' '.join(str(h).casefold().split()))[:30]
               for h in headers[:25]]
    return '|'.join(cleaned) or 'none'
