# Repository Rules

- Treat `origin` (`https://github.com/NightSquawk/cdn-nightsquawk-tech.git`) as the only push target for this repository.
- Treat `upstream` (`https://github.com/kotx/render.git`) as read-only. Never push, publish, or open release changes to `upstream`.
- When pulling upstream work, inspect and apply it locally while preserving NightSquawk-specific configuration and source changes.
- Before any push, verify the target remote is `origin`.


## In-the-Moment Activity Logging (Billing)

cdn-nightsquawk-tech is an NST-internal repo: work here defaults to **NST-internal** (`kimai_candidate: no`) but must still be logged - the NST master activity log is also the future-search index. If a task is a deliverable for a paying client or tenant, tag that client instead and set `kimai_candidate: yes`. **`{host}` is not optional and is not a label to leave literal** - determine it yourself before naming the file: run `hostname` (Linux/macOS) or `$env:COMPUTERNAME` (Windows PowerShell) / `echo %COMPUTERNAME%` (cmd), lowercase the result, keep only the part before the first dot, and replace anything that isn't `[a-z0-9_-]` with a dash. This applies even though this repo lives outside the NST vault - the inbox is shared across all NightSquawk repos and machines, and a stub filename with no host segment is itself a defect. Canonical SOP: `C:\Users\reyes\NightSquawk Tech\in-the-moment-logging-sop.md` (NST Rule 11).

Substantive = a feature, fix, refactor, build or packaging pass, release, deployment, or significant debugging session. Skip pure Q&A and code reading.

- **At task start:** spawn a **background** logging subagent (never block the real work) that writes a stub entry - one file per task - to `$NST_ACTIVITY_INBOX/YYYY-MM-DD-HHMM-{host}-{slug}.md` (Linux `/mnt/data/work/.activity-log-inbox/`; Windows `<data-drive>:\work\.activity-log-inbox\`) with frontmatter `client: NST-internal`, `status: stub`, `kimai_candidate: no`.
- **At task end:** complete the entry (`status: complete`): what was done, commit hashes + subjects, branch, VERSION or changelog bump if any, build artifacts, deploys, and any endpoints or systems touched.
- **Single write** to the NST inbox only. Never create activity-log files inside this repo, and never append `activity-log-YYYY-MM.md` directly - the single-writer consolidation pass owns the monthly logs.
- Automatic breadcrumbs are only a safety net: Claude writes `breadcrumbs-YYYY-MM.log` via the global `SessionEnd` hook; Codex writes `codex-breadcrumbs-YYYY-MM.log` via the global `Stop` hook. The subagent entry is what makes the work readable for billing. Short tasks may skip the stub and write one complete entry at the end.
