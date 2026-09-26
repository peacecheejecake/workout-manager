# EXT-OIDC local stack (WIP, not a product script)

Copied from the session scratchpad so the handoff keeps it. It reads the git-ignored
`/Users/minjiwon/workout-manager/.env` and never prints its values. Paths inside still point to the
session scratchpad state directory (`state/`, PostgreSQL socket `/tmp/wm-ext-oidc-sock`); adjust them
before reuse. See `docs/implementation/progress/EXT-OIDC.md` for the checklist.
