# EXT-OIDC local stack (not a product script)

Run `scripts/ext-oidc-local/stack.sh` from this checkout. The script resolves the app and probe files
from its own location, and the stack keeps its local PostgreSQL data and logs in a checkout-specific
temporary directory. It reads the git-ignored `.env` in this checkout by default. Set
`WORKOUT_OIDC_ENV_FILE` to an absolute path when using an ignored `.env` from another checkout.
Neither the environment values nor the OIDC error descriptions are printed by the probes. See
`docs/implementation/progress/EXT-OIDC.md` for the checklist and evidence limitations.
