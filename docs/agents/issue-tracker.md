# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues. Use the `gh` CLI for all issue-tracker operations.

- **Repository:** `nplongx/runalith`
- **Create an issue:** `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue:** `gh issue view <number> --comments` and include labels when needed.
- **List issues:** `gh issue list --state open --json number,title,body,labels,comments` with appropriate filters.
- **Comment:** `gh issue comment <number> --body "..."`.
- **Apply/remove labels:** `gh issue edit <number> --add-label "..."` / `--remove-label "..."`.
- **Close:** `gh issue close <number> --comment "..."`.

Infer the repository from the Git remote when running `gh` inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** External pull requests are not included in the issue-triage workflow.

## Skill conventions

- When a skill says to publish to the issue tracker, create a GitHub issue.
- When a skill says to fetch a relevant ticket, run `gh issue view <number> --comments`.
- Use GitHub native issue dependencies for blocking relationships when available. Use an explicit `Blocked by: #...` reference as a fallback.

## Operational boundaries

Do not close, relabel, assign, or otherwise mutate issues unless the task explicitly calls for that action. Creating an issue or changing tracker state requires authorization appropriate to that task.
