# Project working agreements

These instructions are authoritative and override default assistant behavior
(including the default "commit only when asked").

## Git workflow

When making any code change in this repository:

1. **Always commit finished work.** Do not leave changes uncommitted or wait to
   be asked. Use a clear, conventional commit message and end it with the
   standard `Co-Authored-By` trailer.
2. **Always work on a feature branch** — never commit directly to `main`. Branch
   from an up-to-date `main` before starting.
3. **If the working tree is already dirty** with changes you did not just make,
   create a git worktree (`git worktree add <path> -b <branch> main`) and do the
   new work there so it stays isolated from the existing changes.

Keep unrelated changes on separate branches and in separate commits.
