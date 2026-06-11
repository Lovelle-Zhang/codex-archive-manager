# Changelog

## 0.1.2 - 2026-06-11

- Added macOS LaunchAgent install/uninstall scripts for a stable local background service.
- Documented `npm run service:install` and `npm run service:uninstall`.

## 0.1.1 - 2026-06-10

- Changed the default server mode to read-only.
- Added explicit write mode via `npm run start:write` / `CODEX_ARCHIVE_MANAGER_WRITE=1`.
- Disabled restore and hid delete/cleanup actions unless write mode is enabled.
- Added a server-side guard so restore/delete/cleanup API routes are blocked in read-only mode.
- Documented that the local web page is available only while the Node process is running.

## 0.1.0 - 2026-06-10

- Added archive listing for archived, current, unlisted, and missing-file Codex session records.
- Added conversation preview, project folder opening, and record file reveal.
- Added archive restore back to the Codex sidebar with local backups.
- Added deletion flows for archived records and unlisted local records.
- Added missing-file cleanup for broken database/sidebar references.
- Added action prioritization with `Preview`, `Restore`, and a low-frequency `More` menu.
- Added an in-app action guide explaining each available operation.
- Added a local-only safety notice.
- Added a diagnostics panel for Codex storage paths.
- Documented dry-run and backup behavior for destructive actions.
- Added demo mode for screenshots and safe UI review.
