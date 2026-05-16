Cross-package source of truth. Pure `.ts`, no runtime deps.

Each package's build/dev script copies this directory into `src/_shared/`
(gitignored) via a `predev` / `prebuild` step in package.json. Source code
imports from `'./_shared/<file>.js'` (or `'@/_shared/<file>'` for frontend).

**Edit files here, not in the copies.** The copies are regenerated on every
build and dev start.
