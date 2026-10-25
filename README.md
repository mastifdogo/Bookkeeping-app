# Bookkeeping (desktop)

[Ledger](https://github.com/mastifdogo/Bookeeping), the double-entry bookkeeping
web app, packaged as a desktop app for **Windows** and **Linux**. It needs no
server, no Docker and no separately installed database: the installer contains
the app, the Ledger server and a private PostgreSQL that only this app uses.

Ledger's double-entry rules are enforced exactly as they are on a server. The
same PostgreSQL triggers and constraints apply, and Ledger connects as a
restricted role that cannot alter tables or edit posted entries.

## Install

Download the file for your system from the latest
[release](https://github.com/mastifdogo/bookkeeping-app/releases):

| System | File | |
|--------|------|-|
| Windows 10/11, 64-bit | `Bookkeeping-Setup-<version>-x64.exe` | Run it. Windows SmartScreen may warn that the app is unrecognised (it isn't code-signed): **More info → Run anyway**. |
| Debian, Ubuntu, Mint… | `Bookkeeping-<version>-amd64.deb` | `sudo apt install ./Bookkeeping-<version>-amd64.deb` |
| Any other Linux | `Bookkeeping-<version>-x86_64.AppImage` | `chmod +x Bookkeeping-*.AppImage && ./Bookkeeping-*.AppImage` |

On Ubuntu 24.04 and later the AppImage may refuse to start because of the
system's sandbox restrictions on unprivileged namespaces. Use the `.deb`
there, or start the AppImage with `--no-sandbox`.

## First run

The first start creates your database, which takes a few seconds. You are
then asked to choose a username and password. That login is the first
Ledger user. Every later start goes straight to Ledger's login page.

From there, Ledger works as described in
[its README](https://github.com/mastifdogo/Bookeeping#readme): chart of
accounts, journal entries, reports, CSV import and export, and the dashboard.

## Your data

| What | Windows | Linux |
|------|---------|-------|
| Database, snapshots, logs | `%APPDATA%\Bookkeeping` | `~/.config/Bookkeeping` |
| CSV imports and exports | `Documents\Bookkeeping` | `~/Documents/Bookkeeping` |

**File → Show Data Folder**, **Show Logs** and **Open CSV Folder** open these
folders. Uninstalling the app leaves your data in place.

### Backups

- **Automatic:** once a day, when the app starts, it saves a copy of the
  database in `snapshots/` and keeps the last 7.
- **Manual:** use **File → Back Up…** and choose a folder, for example an
  external drive or a synced folder. The app pauses for a moment, copies the
  database to `bookkeeping-backup-<date-time>` and carries on.
- **Restore:** use **File → Restore From Backup…** and choose a backup
  folder or a daily snapshot. Your current database is kept beside it as
  `pgdata.before-restore-…`, so a restore can be undone.

A backup is a copy of the PostgreSQL data folder. Restore it with this app on
the same kind of system (Windows or Linux). To move your books elsewhere, or
to keep a portable copy, also export the General Ledger as CSV from Ledger's
**Files** page.

## Differences from a server install

- **Automatic updates and modules are off.** Ledger's **Settings → Updates**
  and **Settings → Modules** pages need the root services of a server install,
  which a desktop app doesn't have. Changes there have no effect. To update,
  install the newer release over the old one; the database is migrated on the
  next start.
- **One computer, one login.** The server listens on `127.0.0.1` only, so
  other devices on your network can't connect. Ledger has no page for adding
  users (on a server that's done with `ledger user add`), so the desktop app
  has the one login you create on first run. Change its password under
  **Settings → Account**.

## How it works

```
Electron window ──HTTP──▶ Ledger server (ledger.mjs, run by Electron's Node.js)
                                │ ledger_app role
                                ▼
                         PostgreSQL 18 (pg_ctl, 127.0.0.1, random free port)
                         data: <app data>/pgdata
```

- `src/main.js`: the Electron main process. It handles the window, menus,
  the first-run setup, backup and restore, and shutdown.
- `src/services.js`: starts PostgreSQL (`initdb`/`pg_ctl` from the
  [embedded-postgres](https://github.com/leinelissen/embedded-postgres)
  binary packages) and Ledger. It also sets up the database the way Ledger's
  `deploy/setup-db.sh` does: an owner role, a restricted app role, the schema,
  migrations and grants. It does not depend on Electron.
- `scripts/fetch-ledger.mjs`: builds Ledger at the commit pinned in
  `ledger.json` into `ledger/`, which is shipped inside the app.
- `scripts/check.mjs`: a smoke test of `services.js` with plain Node. It
  creates a cluster, adds a user, posts entries, checks that the app role
  can't bypass the rules, and tests restart and restore.

## Development

Needs Node.js 22.18 or newer and git.

```sh
npm install
npm run ledger      # build Ledger into ledger/ (or LEDGER_SRC=../Bookeeping npm run ledger)
npm run check       # smoke test; run it as a normal user, PostgreSQL refuses to run as root
npm start           # run the app
npm run dist        # installers for this OS into dist/
```

To ship a newer Ledger, change `ref` in `ledger.json` to the Ledger commit or
tag you want, then run `npm run ledger` again.

## Releasing

Push a version tag (or use **Actions → Build → Run workflow** and enter one). GitHub Actions (`.github/workflows/build.yml`) builds
Ledger, runs the smoke test on Windows and Linux, builds the installers and
attaches them, with `SHA256SUMS`, to a GitHub Release:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

The tag sets the app's version. Tags with a suffix (`v0.1.0-rc.1`) are
published as pre-releases. Every push and pull request also builds the
installers; they can be downloaded from the run's **Artifacts**.
