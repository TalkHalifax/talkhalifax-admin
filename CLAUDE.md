# Working on talkhalifax-admin

The TalkHalifax admin site (`admin.talkhalifax.ca`): the editor's control panel for the live service. A Cloudflare
Worker with no database of its own. It reads platform data only through `PLATFORM`, a service binding to the main
Worker's `AdminApi` entrypoint in the public [talkhalifax](https://github.com/TalkHalifax/talkhalifax) repo, which
owns every table and the contract.

Agents here are the Admin team (`.claude/agents/`), plus outside reviewers from Infrastructure & Continuity and Trust &
Safety for `admin/` branches. The agent guard (`.claude/hooks/agent-guard.mjs`) is a byte-for-byte copy of the main
repo's; CI fails if it drifts.

## Rules

- **Every push to `main` deploys** once the `production` environment is set up. Commit or push only when the editor
  asks.
- **`main` is protected:** every change goes through a pull request that passes `check` and the editor's review; no
  direct or force pushes. `.claude/`, `.github/`, `wrangler.jsonc` and `package.json` are the editor's to approve.
- **The panel refuses every request when no sign-in is configured** (neither the username and password nor Cloudflare
  Access). Never weaken that, and never weaken a check on the platform side to make the panel work: ask the owning
  team through the orchestrator.
- **Secrets never pass through an agent.** The editor sets them (`ADMIN_USER`, `ADMIN_PASSWORD`, later
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`) with `npx wrangler secret put <NAME>`, and the deploy token only as the
  `production` environment secret. Don't read, print or write tokens.
- **This repo is public.** Nothing personal leaves the panel or goes in the repo: no member emails, IPs, local paths or
  Notion links in code, logs, commits or pull requests.
- **AdminApi changes start in the main repo** (Platform Core), and a write power also needs Trust & Safety's review and
  Cloudflare Access first.
- **Test before asking to merge:** `npm test`, `npx tsc --noEmit` and `node --check public/admin.js`, then exercise the
  change with `npx wrangler dev`. Never test with accounts or posts on the live site.
- Commit messages end with the Co-Authored-By line given in the session, and nothing after it. No `Claude-Session:`
  lines or session links in commits or pull request bodies.

## Line endings

Every file is LF, enforced by `.gitattributes` (`* text=auto eol=lf`).
