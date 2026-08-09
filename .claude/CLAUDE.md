# TVSM Operations Dashboard — session context

Read `.claude/context/memory.md` first. It carries the operational knowledge that must
survive a session clear: what this project is, how it runs day to day, the open
threads, and the decisions already made — so none of them are re-litigated or
rediscovered from scratch.

The deeper material lives where it belongs and is not duplicated here:

| Need | Read |
| --- | --- |
| Session memory: state, open items, decisions, preferences | `.claude/context/memory.md` |
| Daily workflow, business rules, sign-in and admin model | `.claude/skills/refresh-tvsm-dashboard/SKILL.md` |
| Full data logic, defect history, per-view specifications | `.claude/skills/refresh-tvsm-dashboard/references/data_contract.md` |
| Governed constants the code is tested against | `.claude/skills/refresh-tvsm-dashboard/config/pipeline.json` |

## Working rules

- Keep `.claude/context/memory.md` current: when a session produces a durable fact — a new
  rule, a resolved defect, a changed preference, a new open item — record it there
  in the matching section, commit and push. Prune entries that stop being true
  rather than piling on; the file is a working memory, not a log.
- The owner has authorized direct publication to `main`. Published artefacts are
  `index.html`, `data.json` and (only when grants change) `access.json`.
- **Never commit secrets.** This repo is served publicly through Vercel, so every
  committed file — including everything under `.claude/` — is fetchable by URL.
  The AgentMail key lives in the scheduled Routine's prompt and in the owner's
  hands, not in this repository.
- Verify sync claims by clean clone and rebuild, not by `git status` alone; the
  pipeline must reproduce the published `index.html` byte-identically.
