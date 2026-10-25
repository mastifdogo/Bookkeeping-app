// Bookkeeping desktop app: starts a private PostgreSQL and the Ledger server
// on 127.0.0.1, then shows Ledger's web UI in a window.
//
// Everything lives in the per-user app data folder (Settings → "Show data folder"):
//   pgdata/        the database cluster
//   snapshots/     a copy of pgdata taken once a day at startup (last 7 kept)
//   state/         Ledger's update/module state directories
//   logs/          app.log, postgres.log (setup), postgres-server.log, ledger.log
//   settings.json  generated database passwords and the ports last used
// CSV imports and exports go to Documents/Bookkeeping.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { existsSync, promises as fsp } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyCluster, dailySnapshot, Database, isCluster, LedgerServer, loadSettings, openLog, saveSettings } from "./services.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const ledgerDir = app.isPackaged ? path.join(process.resourcesPath, "ledger") : path.join(here, "..", "ledger");

const dataRoot = app.getPath("userData");
const paths = {
	pgdata: path.join(dataRoot, "pgdata"),
	snapshots: path.join(dataRoot, "snapshots"),
	state: path.join(dataRoot, "state"),
	logs: path.join(dataRoot, "logs"),
	settings: path.join(dataRoot, "settings.json"),
	csv: path.join(app.getPath("documents"), "Bookkeeping"),
};
const SNAPSHOTS_KEPT = 7;

/** @type {BrowserWindow | undefined} */
let win;
/** @type {Database | undefined} */
let db;
/** @type {LedgerServer | undefined} */
let server;
let settings;
let origin = "";
let logs = {};
let busy = false; // a backup or restore is stopping and restarting the services
let quitting = false;

if (!app.requestSingleInstanceLock()) {
	// A second copy would start a second PostgreSQL on the same data folder.
	app.quit();
} else {
	app.on("second-instance", () => {
		if (win) {
			if (win.isMinimized()) win.restore();
			win.focus();
		}
	});
	app.whenReady().then(boot);
}

async function boot() {
	logs = {
		app: await openLog(path.join(paths.logs, "app.log")),
		postgres: await openLog(path.join(paths.logs, "postgres.log")),
		ledger: await openLog(path.join(paths.logs, "ledger.log")),
	};
	logs.app(`starting ${app.getName()} ${app.getVersion()}, Ledger ${await ledgerVersion()}`);
	Menu.setApplicationMenu(buildMenu());
	createWindow();
	try {
		await showStatus("Starting…");
		settings = await loadSettings(paths.settings);
		await showStatus("Taking today's snapshot…");
		await dailySnapshot(paths.pgdata, paths.snapshots, SNAPSHOTS_KEPT, logs.app).catch((err) => {
			logs.app(`[ERROR] snapshot failed: ${err.message}`); // never block opening the books
		});
		await startServices();
		await openLedger();
	} catch (err) {
		await fail("Bookkeeping could not start", err);
	}
}

function createWindow() {
	win = new BrowserWindow({
		width: 1280,
		height: 860,
		minWidth: 720,
		minHeight: 480,
		title: "Bookkeeping",
		icon: path.join(here, "..", "resources", "icon.png"),
		backgroundColor: "#ffffff",
		webPreferences: {
			preload: path.join(here, "preload.cjs"),
			contextIsolation: true,
			sandbox: true,
			nodeIntegration: false,
			spellcheck: true,
		},
	});
	const wc = win.webContents;
	// Ledger's own pages stay in the window; any other link opens in the browser.
	wc.setWindowOpenHandler(({ url }) => {
		if (isLedgerUrl(url)) return { action: "allow" };
		openExternal(url);
		return { action: "deny" };
	});
	wc.on("will-navigate", (event, url) => {
		if (isLedgerUrl(url) || url.startsWith("file:")) return;
		event.preventDefault();
		openExternal(url);
	});
	wc.on("render-process-gone", (_e, d) => logs.app(`[ERROR] renderer gone: ${d.reason}`));
	win.on("closed", () => (win = undefined));
}

function isLedgerUrl(url) {
	return origin !== "" && (url === origin || url.startsWith(`${origin}/`));
}

function openExternal(url) {
	if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

async function showStatus(message) {
	if (!win) return;
	await win.loadFile(path.join(here, "status.html"), { query: { message } });
}

async function startServices() {
	await fsp.mkdir(paths.csv, { recursive: true }).catch(() => {});
	await showStatus(isCluster(paths.pgdata) ? "Starting the database…" : "Creating your database (first run)…");
	db = new Database({
		dataDir: paths.pgdata,
		sqlDir: path.join(ledgerDir, "db"),
		settings,
		log: logs.postgres,
		serverLog: path.join(paths.logs, "postgres-server.log"),
	});
	await db.start(settings.dbPort);
	server = new LedgerServer({
		ledgerDir,
		node: process.execPath,
		env: {
			CSV_DIR: paths.csv,
			UPDATE_CONFIG_DIR: path.join(paths.state, "update-config"),
			UPDATE_STATUS_DIR: path.join(paths.state, "update-status"),
			MODULES_DIR: path.join(paths.state, "modules"),
		},
		log: logs.ledger,
	});
	await showStatus("Starting Ledger…");
	// Same port as last time, so the browser storage (panes, layout) stays with the same origin.
	origin = await server.start(db.url, settings.httpPort);
	server.onExit = () => {
		if (!quitting && !busy) void fail("Ledger stopped unexpectedly", new Error("See ledger.log in the logs folder."));
	};
	if (settings.dbPort !== db.port || settings.httpPort !== server.port) {
		settings.dbPort = db.port;
		settings.httpPort = server.port;
		await saveSettings(paths.settings, settings);
	}
	logs.app(`Ledger at ${origin}, PostgreSQL on port ${db.port}`);
}

async function stopServices() {
	await server?.stop();
	server = undefined;
	await db?.stop();
	db = undefined;
	origin = "";
}

/** Ledger's login page, or the first-run page that creates the first user. */
async function openLedger() {
	if (!win) createWindow();
	if (await db.hasActiveUsers()) await win.loadURL(`${origin}/`);
	else await win.loadFile(path.join(here, "setup.html"));
}

ipcMain.handle("setup:create-user", async (event, username, password) => {
	if (!db || !server || event.sender !== win?.webContents) throw new Error("not ready");
	if (typeof username !== "string" || typeof password !== "string") throw new Error("invalid input");
	if (/[\r\n]/.test(password)) throw new Error("The password cannot contain line breaks.");
	await server.runUserCommand(db.url, ["add", username.trim(), "--password-stdin"], `${password}\n`);
	logs.app(`created user ${username.trim()}`);
	await win.loadURL(`${origin}/`);
});

async function fail(title, err) {
	logs.app?.(`[ERROR] ${title}: ${err?.stack ?? err}`);
	if (quitting) return;
	const { response } = await dialog.showMessageBox({
		type: "error",
		title,
		message: title,
		detail: `${err?.message ?? err}\n\nLogs: ${paths.logs}`,
		buttons: ["Quit", "Open logs folder"],
		defaultId: 0,
	});
	if (response === 1) await shell.openPath(paths.logs);
	app.quit();
}

/** Stops the services, runs fn (which copies data folders), starts them again. */
async function withServicesStopped(label, fn) {
	if (busy || !db) return;
	busy = true;
	try {
		await showStatus(label);
		await stopServices();
		await fn();
	} finally {
		try {
			await startServices();
			await openLedger();
		} catch (err) {
			busy = false;
			await fail("Bookkeeping could not restart", err);
		}
		busy = false;
	}
}

async function backUp() {
	const r = await dialog.showOpenDialog(win, {
		title: "Choose a folder for the backup",
		buttonLabel: "Back up here",
		properties: ["openDirectory", "createDirectory"],
	});
	if (r.canceled || !r.filePaths[0]) return;
	const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
	const dest = path.join(r.filePaths[0], `bookkeeping-backup-${stamp}`);
	let error;
	await withServicesStopped("Backing up…", async () => {
		await copyCluster(paths.pgdata, dest).catch((err) => (error = err));
	});
	if (error) dialog.showErrorBox("Backup failed", error.message);
	else await dialog.showMessageBox(win, { type: "info", message: "Backup complete", detail: dest });
}

async function restore() {
	const r = await dialog.showOpenDialog(win, {
		title: "Choose a backup folder (bookkeeping-backup-… or a daily snapshot)",
		buttonLabel: "Restore",
		defaultPath: paths.snapshots,
		properties: ["openDirectory"],
	});
	const from = r.filePaths[0];
	if (r.canceled || !from) return;
	if (!isCluster(from)) {
		dialog.showErrorBox("Not a backup", `${from} doesn't contain a Bookkeeping database (no PG_VERSION file).`);
		return;
	}
	const { response } = await dialog.showMessageBox(win, {
		type: "warning",
		message: "Replace your books with this backup?",
		detail: `Everything posted since that backup will be replaced. Your current data is kept in ${paths.pgdata}.before-restore-… in case you need it.`,
		buttons: ["Cancel", "Restore"],
		defaultId: 0,
		cancelId: 0,
	});
	if (response !== 1) return;
	let error;
	await withServicesStopped("Restoring…", async () => {
		const aside = `${paths.pgdata}.before-restore-${Date.now()}`;
		try {
			await fsp.rename(paths.pgdata, aside);
			await copyCluster(from, paths.pgdata);
		} catch (err) {
			error = err;
			if (!isCluster(paths.pgdata) && existsSync(aside)) {
				await fsp.rm(paths.pgdata, { recursive: true, force: true });
				await fsp.rename(aside, paths.pgdata);
			}
		}
	});
	if (error) dialog.showErrorBox("Restore failed", `${error.message}\n\nYour books were left as they were.`);
}

async function ledgerVersion() {
	return (await fsp.readFile(path.join(ledgerDir, "VERSION"), "utf8").catch(() => "unknown")).trim();
}

function buildMenu() {
	const isMac = process.platform === "darwin";
	return Menu.buildFromTemplate([
		...(isMac ? [{ role: "appMenu" }] : []),
		{
			label: "&File",
			submenu: [
				{ label: "Open CSV Folder", click: () => shell.openPath(paths.csv) },
				{ type: "separator" },
				{ label: "Back Up…", click: () => void backUp() },
				{ label: "Restore From Backup…", click: () => void restore() },
				{ type: "separator" },
				{ label: "Show Data Folder", click: () => shell.openPath(dataRoot) },
				{ label: "Show Logs", click: () => shell.openPath(paths.logs) },
				{ type: "separator" },
				isMac ? { role: "close" } : { role: "quit" },
			],
		},
		{ role: "editMenu" },
		{
			label: "&View",
			submenu: [
				{ role: "reload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "&Help",
			submenu: [
				{
					label: "About Bookkeeping",
					click: async () =>
						dialog.showMessageBox(win, {
							type: "info",
							title: "About Bookkeeping",
							message: `Bookkeeping ${app.getVersion()}`,
							detail: `Ledger ${await ledgerVersion()}\nElectron ${process.versions.electron}, Node.js ${process.versions.node}\n\nData: ${dataRoot}\nCSV files: ${paths.csv}`,
						}),
				},
				{ label: "Project Page", click: () => openExternal("https://github.com/mastifdogo/bookkeeping-app") },
			],
		},
	]);
}

// Stop Ledger and PostgreSQL cleanly before exiting.
app.on("before-quit", (event) => {
	if (quitting === "done") return;
	event.preventDefault();
	if (quitting) return;
	quitting = true;
	logs.app?.("shutting down");
	stopServices()
		.catch((err) => logs.app?.(`[ERROR] shutdown: ${err.message}`))
		.finally(() => {
			quitting = "done";
			app.quit();
		});
});

app.on("window-all-closed", () => {
	if (!busy) app.quit();
});
