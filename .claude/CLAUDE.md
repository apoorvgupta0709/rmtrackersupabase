# TVSM Operations Dashboard — session context

Read `.claude/context/memory.md` first. It carries the operational knowledge that must
survive a session clear: what this project is, how it runs day to day, the open
threads, and the decisions already made — so none of them are re-litigated or
rediscovered from scratch.

The deeper material lives where it belongs and is not duplicated here:

| Need | Read |
| --- | --- |
| Session memory: state, open items, decisions, preferences | `.claude/context/memory.md` |
| **The TypeScript port of the pipeline: state, traps, how to check** | `progress.md` |
| Daily workflow, business rules, sign-in and admin model | `.claude/skills/refresh-tvsm-dashboard/SKILL.md` |
| Full data logic, defect history, per-view specifications | `.claude/skills/refresh-tvsm-dashboard/references/data_contract.md` |
| Governed constants the code is tested against | `.claude/skills/refresh-tvsm-dashboard/config/pipeline.json` |
| How the app is built and shipped to either host | `Dockerfile`, `deploy/`, `.github/workflows/deploy.yml` |

## Working rules

- Keep `.claude/context/memory.md` current: when a session produces a durable fact — a new
  rule, a resolved defect, a changed preference, a new open item — record it there
  in the matching section, commit and push. Prune entries that stop being true
  rather than piling on; the file is a working memory, not a log.
- The owner has authorized direct publication to `main`.
- **A refresh publishes a build into Supabase, not a file into the repo.** `index.html`,
  `data.json` and `access.json` at the root are the previous static dashboard's
  artefacts: kept as test oracles, served by nothing, and never to be updated as
  though they were still the product.
- **Every push to `main` deploys twice** — Vercel, and a container on the VPS at
  `rmtracker.thecuriouspandas.cloud`. After touching `next.config.ts`, the `Dockerfile`
  or anything in `.github/workflows/`, confirm *both* went green
  (`gh run list --workflow=deploy.yml`, `vercel ls --scope apoorvgupta0709s-projects`).
  A build option that suits one host can fail the other on its last line while every
  local check passes; `output: "standalone"` did exactly that.
- **Never commit secrets.** Not because this file is reachable — it is excluded from
  both deployments — but because that protection is three ignore lists deep
  (`.gitignore`, `.vercelignore`, `.dockerignore`) and one unanchored pattern from being
  wrong, in front of two public deployments of contract prices. The AgentMail key lives
  in the scheduled Routine's prompt and in the owner's hands, not in this repository.
- Verify sync claims by clean clone and rebuild, not by `git status` alone.
