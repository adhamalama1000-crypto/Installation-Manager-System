# OR VIP — Windows desktop launcher

Double-click the **OR VIP** icon on the desktop. The launcher checks the computer, starts Docker
Desktop and the database, prepares the program, starts the application server and opens OR VIP in
the browser. Nobody has to type commands.

اضغط مرتين على أيقونة **OR VIP** على سطح المكتب: يتم فحص الجهاز وتشغيل Docker وقاعدة البيانات
وتجهيز البرنامج وتشغيل الخادم وفتح النظام في المتصفح تلقائيًا، بدون كتابة أي أوامر.

---

## 1. Install (once per computer)

You need **Windows 10 version 2004 (build 19041) or newer, or Windows 11**, and an internet
connection for the first setup.

1. Put the OR VIP program folder somewhere permanent, for example `C:\OR VIP\Installation-Manager-System`.
   Do not move or rename it later (the shortcuts and the database volume belong to this folder;
   see [Moving the folder](#moving-the-folder)).
2. Open the folder, then `scripts\windows`, and double-click **`Setup OR VIP.cmd`**.
3. Answer the questions. Setup:
   - checks Windows, **Node.js LTS** and **Docker Desktop**, and offers to install what is missing
     with Windows Package Manager (winget), or opens the download page;
   - creates the `.env` configuration (an existing `.env` is never replaced unless you type `YES`,
     and it is backed up first);
   - starts the database, installs the program components and prepares the database
     (forward-only updates; **existing data is never deleted, reset or replaced by demo data**);
   - asks for the first **Admin account** if the database has none;
   - builds the program, creates the **OR VIP** desktop icon and an **OR VIP** Start-menu folder;
   - starts OR VIP once to prove that everything works.

If Docker Desktop or Node.js was just installed, Windows may ask you to restart. Restart, open
Docker Desktop once (accept its terms), and run `Setup OR VIP.cmd` again — it continues where it
stopped and skips what is already done.

Setup can be run again at any time to check or repair an installation. It never deletes data.

## 2. Daily use

| What | How |
|---|---|
| Start OR VIP | Double-click **OR VIP** on the desktop |
| Open it again | Double-click the icon again (it opens the running system; it never starts a second copy) |
| Stop | Start menu → OR VIP → **Stop OR VIP**, or the **Stop** button in the OR VIP window |
| Restart | Start menu → OR VIP → **Restart OR VIP**, or the **Restart** button |
| Logs | Start menu → OR VIP → **OR VIP logs**, or the **Logs** button |
| Check / repair | Start menu → OR VIP → **OR VIP setup** |

The OR VIP window shows each step with its status (English and Arabic):

1. Checking system requirements — فحص متطلبات النظام
2. Starting Docker — تشغيل Docker
3. Starting PostgreSQL — تشغيل قاعدة البيانات
4. Checking dependencies — فحص مكونات البرنامج
5. Preparing database — تجهيز قاعدة البيانات
6. Starting application server — تشغيل خادم النظام
7. Application running — النظام يعمل

When it shows **Application running**, OR VIP opens at <http://localhost:3000>. You can close the
window; OR VIP keeps running until you stop it or shut down Windows.

**First start after installing or updating** takes a few minutes (components and the production
build are prepared once). A normal start takes seconds: nothing is reinstalled or rebuilt unless
the program actually changed.

**After a Windows restart** just double-click the icon again. Docker Desktop is started and waited
for automatically; old process records from before the restart are recognised and discarded.
To start OR VIP automatically when you sign in, run setup with `-StartWithWindows`
(or `create-desktop-shortcut.ps1 -StartWithWindows`).

## 3. When something goes wrong

Every problem is shown in English and Arabic with what to do, and written to the log. Click
**Logs** to open the folder (`.orvip\logs` in the program folder).

| Message | What to do |
|---|---|
| Node.js is not installed / too old | Install Node.js LTS from <https://nodejs.org>, then start again |
| Docker Desktop is not installed | Install it from <https://www.docker.com/products/docker-desktop/>, restart Windows if asked |
| Docker Desktop did not become ready | Open Docker Desktop, wait for "Engine running", click **Try again** |
| Docker is using Windows containers | Docker icon near the clock → *Switch to Linux containers* |
| Port 5433 is already used | Another PostgreSQL is running; close it, or change `IMS_DB_PORT` and `DATABASE_URL` together |
| The configuration file (.env) is missing / not valid | Run **OR VIP setup** |
| The database refused the user name or password | `DATABASE_URL` in `.env` is wrong (the password is never shown on screen or in logs) |
| The database did not answer | Check Docker Desktop, or your own PostgreSQL server |
| Port 3000 is already used by another program (name) | Close that program, or set another `appPort` (see §5) |
| The application server stopped while starting | Send `.orvip\logs\server.log` to support |
| Updating the database failed / needs a manual check | Nothing was deleted; send the logs to support |

`check-prerequisites.ps1` prints a read-only report of everything OR VIP needs.

## 4. What the launcher guarantees

- **Your data is never deleted.** The launcher never runs `db:reset`, `prisma migrate reset`,
  `SEED_FORCE`, `db:seed`, `docker compose down` or anything that removes a volume. Database
  updates use `prisma migrate deploy` (forward-only) **only when updates are pending**, and only
  after a backup (`.orvip\backups\before-migrate-*.dump`, the last ten are kept). If the backup
  fails, the update is not applied.
- **Stopping never touches the database.** Stop ends only the application server. The database
  container keeps running (it has `restart: unless-stopped`); `stop-or-vip.ps1 -StopDatabase`
  stops it (never removes it).
- **Only its own processes.** The launcher records the process id **and start time** of the server
  it started (`.orvip\server.json`) and stops only that process tree. Other Node.js programs,
  Docker containers, or an OR VIP server started some other way are never stopped. A process id
  re-used after a Windows restart is recognised by its different start time and left alone.
- **No duplicates.** A second double-click while OR VIP runs just opens the browser. Two launches
  at the same moment are serialised (the second waits for the first).
- **No endless waiting.** Every wait has a limit (Docker 240 s, database 90 s, server 120 s,
  installs and builds their own limits) and then shows a clear message.
- **No secrets on screen or in logs.** Connection strings are shown as
  `postgresql://ims:****@localhost:5433/installation_manager`; every log line is masked. Shortcuts
  and scripts contain no passwords. A new Admin password goes to the one process that creates the
  account, never to disk.
- **No reinstall on every start.** `npm ci` runs only when `node_modules` is missing or
  `package-lock.json` / the Node.js major version changed; `npm audit fix --force` is never run.
  The production build runs only when the code changed.

## 5. Configuration

`.env` is the application's own configuration (created by setup from `.env.example`). With the
bundled database, setup takes the database user, password, name and port from
`docker-compose.yml` (the default port is **5433**).

`.orvip\config.json` (optional, created by setup) holds launcher settings:

| Setting | Default | Meaning |
|---|---|---|
| `databaseMode` | `auto` | `docker` (bundled PostgreSQL in Docker Desktop), `external` (your own PostgreSQL server; Docker is not needed), `auto` (docker when `DATABASE_URL` points to this computer) |
| `appPort` | `3000` | Port of OR VIP (keep `APP_URL` in `.env` the same) |
| `listenOnNetwork` | `false` | `true` lets other computers on the network open OR VIP at `http://<this-pc>:3000` (Windows Firewall will ask once) |
| `dockerTimeoutSec`, `databaseTimeoutSec`, `serverTimeoutSec` | 240, 90, 120 | How long to wait before showing an error |
| `composeProject` | folder name | Remembered on first start so the same database volume is always used |

### Moving the folder

Docker names the database volume after the Compose project (`<project>_pgdata`). The launcher
remembers the project name in `.orvip\config.json`, so if you move the whole folder **including
`.orvip`**, the same data is used. Run **OR VIP setup** afterwards to recreate the shortcuts.

## 6. Files

```
scripts/windows/
  Setup OR VIP.cmd            double-click: first-time setup / repair
  Start OR VIP.cmd            double-click: same as the desktop icon
  Stop OR VIP.cmd             double-click: stop the application server
  setup-or-vip.ps1            first-time setup (also -NonInteractive for automation)
  start-or-vip.ps1            the OR VIP window and start sequence (-NoGui, -NoBrowser)
  stop-or-vip.ps1             stop the server (-StopDatabase to also stop the container)
  restart-or-vip.ps1          stop + start
  check-prerequisites.ps1     read-only report
  create-desktop-shortcut.ps1 desktop icon + Start menu (-StartWithWindows)
  OrVip.psm1                  shared logic
  messages.json               every message in English and Arabic
  assets/or-vip.ico           icon made from the OR VIP emblem (16-256 px)
  lib/count-admins.mjs        setup helper (read-only)
  tests/                      Pester unit tests and end-to-end scenarios
.orvip/                       per computer, not in Git: logs, backups, server record, settings
src/app/api/health/route.ts   GET /api/health: {"app":"or-vip-erp","status":"ok","database":"ok"}
```

Everything runs with **Windows PowerShell 5.1**, which is part of Windows 10 and 11; no extra
software is needed beyond Node.js and Docker Desktop. The shortcuts run the scripts with
`-ExecutionPolicy Bypass` for that one process only; the computer's policy is not changed.

Exit codes of `start-or-vip.ps1 -NoGui`: 0 running, 10 requirements, 11 `.env`, 20 Docker,
30 database, 40 components, 50 database update, 60 build, 70 port in use, 71 server stopped while
starting, 72 server did not answer, 73 server cannot reach the database, 80 busy, 90 unexpected.

## 7. Uninstall

Delete the desktop icon and the *OR VIP* Start-menu folder (and `OR VIP.lnk` in the Startup folder
if you enabled start with Windows). The data stays in the Docker volume until you remove it in
Docker Desktop yourself.

## 8. Testing

**Automated, on a real Windows machine** — `.github/workflows/windows-launcher.yml` runs on every
change to the launcher:

- every script parses under Windows PowerShell 5.1 and is plain ASCII; PSScriptAnalyzer (errors);
- Pester unit tests (`tests/OrVip.Tests.ps1`): connection-string parsing and masking, `.env`
  parsing, migration-state classification, messages in both languages, timeouts, process-id
  re-use protection, port detection;
- end-to-end scenarios (`tests/Invoke-LauncherScenarios.ps1`) against a real PostgreSQL server:
  missing `.env`, invalid `.env`, first launch with no `node_modules` and an empty database
  (non-interactive setup, Admin account, build, desktop and Start-menu shortcuts), launching while
  already running, two launches at once, stop, stop twice, a normal launch that skips install and
  build, restart, recovery after a "Windows restart" with a re-used process id, port 3000 taken by
  another program, an OR VIP server started by hand, a wrong database password, the database
  service stopped, an application that crashes on start, deleted dependencies, the prerequisite
  report, the OR VIP window (rendered to `launcher-window.png` in the logs artifact), no secret in
  any log, and the row counts unchanged throughout.

**Manual, on a Windows PC with Docker Desktop** (the hosted Windows runners cannot run Docker
Desktop, so these steps need a real PC once):

1. Docker Desktop quit → double-click **OR VIP**: Docker Desktop starts, the window waits, OR VIP opens.
2. Docker Desktop already running, database container already running → opens within seconds.
3. Docker Desktop not installed → the window explains how to install it.
4. Another PostgreSQL on port 5433 → "Port 5433 is already used".
5. Restart Windows → double-click **OR VIP** → it recovers and opens.
6. Stop → `docker ps` still shows the database container; data still there after the next start.
7. With a pending migration (after an update) → a file appears in `.orvip\backups` before it is applied.
