# Repository Rules

- Treat `origin` (`https://github.com/NightSquawk/cdn-nightsquawk-tech.git`) as the only push target for this repository.
- Treat `upstream` (`https://github.com/kotx/render.git`) as read-only. Never push, publish, or open release changes to `upstream`.
- When pulling upstream work, inspect and apply it locally while preserving NightSquawk-specific configuration and source changes.
- Before any push, verify the target remote is `origin`.
