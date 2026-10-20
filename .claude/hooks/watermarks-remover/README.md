# watermarks-remover PostToolUse hook (vendored)

Stdlib-only subset of `service/scripts/` from
https://github.com/guillaumemeyer/watermarks-remover (v0.7.0, MIT), enough to
run `hook_written_file.py` without the HTTP service.

Wired from `.claude/settings.json` as a `PostToolUse` hook on
`Write|Edit|MultiEdit|NotebookEdit`. Default mode is `check` (report only).
Set `WATERMARKS_HOOK_MODE=clean` to strip marks in place instead.
