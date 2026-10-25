// Smoke test of what the app does behind its window, with plain Node and no
// Electron: create a cluster, set up the database, add a user, start Ledger,
// post through the API, check the database rules hold, restart (migrations
// re-run as no-ops), back up, then shut everything down.
//
//   npm run ledger && npm run check
//
// PostgreSQL refuses to run as root, so run it as an ordinary user.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { copyCluster, Database, isCluster, LedgerServer, loadSettings, dailySnapshot } from "../src/services.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ledgerDir = path.join(root, "ledger");
const work = mkdtempSync(path.join(os.tmpdir(), "bookkeeping-check-"));
const log = (prefix) => (text) => {
	if (process.env.VERBOSE) for (const l of String(text).split(/\r?\n/)) if (l.trim()) console.log(`  [${prefix}] ${l}`);
};
const step = (s) => console.log(`- ${s}`);

const settings = await loadSettings(path.join(work, "settings.json"));
const dataDir = path.join(work, "pgdata");
const db = new Database({ dataDir, sqlDir: path.join(ledgerDir, "db"), settings, log: log("postgres") });
const env = {
	CSV_DIR: path.join(work, "csv"),
	UPDATE_CONFIG_DIR: path.join(work, "state", "update-config"),
	UPDATE_STATUS_DIR: path.join(work, "state", "update-status"),
	MODULES_DIR: path.join(work, "state", "modules"),
};
const server = new LedgerServer({ ledgerDir, node: process.execPath, env, log: log("ledger") });

async function api(origin, cookie, method, p, body) {
	const r = await fetch(`${origin}/api/v1${p}`, {
		method,
		headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await r.text();
	return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
}

try {
	step("first start: initdb, roles, schema, migrations, grants");
	await db.start();
	assert.ok(isCluster(dataDir));
	assert.equal(await db.hasActiveUsers(), false);

	step("ledger user add");
	await server.runUserCommand(db.url, ["add", "alice", "--password-stdin"], "correct horse battery\n");
	assert.equal(await db.hasActiveUsers(), true);
	await assert.rejects(server.runUserCommand(db.url, ["add", "alice", "--password-stdin"], "another password\n"));

	step("Ledger server answers /health");
	let origin = await server.start(db.url);

	step("log in and post a balanced entry");
	const login = await api(origin, "", "POST", "/auth/login", { username: "alice", password: "correct horse battery" });
	assert.equal(login.status, 200, JSON.stringify(login.body));
	const cookie = login.headers.get("set-cookie").split(";")[0];
	for (const [code, name, type] of [
		["1000", "Bank CAD", "asset"],
		["4000", "Sales CAD", "revenue"],
	]) {
		const r = await api(origin, cookie, "POST", "/accounts", { code, name, type, currency: "CAD" });
		assert.equal(r.status, 201, JSON.stringify(r.body));
	}
	const entry = {
		entry_date: "2026-10-01",
		description: "Cash sale",
		lines: [
			{ account_code: "1000", debit_cents: 25000, credit_cents: 0 },
			{ account_code: "4000", debit_cents: 0, credit_cents: 25000 },
		],
	};
	assert.equal((await api(origin, cookie, "POST", "/journal-entries", entry)).status, 201);
	const unbalanced = { ...entry, lines: [entry.lines[0], { ...entry.lines[1], credit_cents: 100 }] };
	assert.equal((await api(origin, cookie, "POST", "/journal-entries", unbalanced)).status >= 400, true);

	step("the app role cannot change posted entries or drop tables");
	const app = new pg.Client({ connectionString: db.url });
	await app.connect();
	await assert.rejects(app.query("UPDATE transactions SET amount = 1"));
	await assert.rejects(app.query("DROP TABLE journal_entries"));
	await assert.rejects(app.query("ALTER TABLE transactions DISABLE TRIGGER ALL"));
	await app.end();

	step("a new run takes over a PostgreSQL left running by a crashed one");
	await server.stop();
	const orphan = db.port;
	db.started = false; // forget it, as a crashed app would
	await db.start();
	assert.ok(db.started);
	origin = await server.start(db.url);
	assert.equal((await api(origin, cookie, "GET", "/auth/me")).status, 200, `orphan on ${orphan} replaced`);

	step("stop, snapshot, start again (no schema changes)");
	await server.stop();
	await db.stop();
	await dailySnapshot(dataDir, path.join(work, "snapshots"), 3, log("snapshot"));
	assert.ok(isCluster(path.join(work, "snapshots", new Date().toISOString().slice(0, 10))));
	await db.start();
	origin = await server.start(db.url);
	const tb = await api(origin, cookie, "GET", "/reports/trial-balance");
	assert.equal(tb.status, 200, JSON.stringify(tb.body));

	step("restore the snapshot into a second cluster and read it");
	await server.stop();
	await db.stop();
	await copyCluster(dataDir, path.join(work, "restored"));
	const restored = new Database({ dataDir: path.join(work, "restored"), sqlDir: path.join(ledgerDir, "db"), settings, log: log("restored") });
	await restored.start();
	assert.equal(await restored.hasActiveUsers(), true);
	await restored.stop();

	console.log("ok");
} finally {
	await server.stop().catch(() => {});
	await db.stop().catch(() => {});
	if (!process.env.KEEP) rmSync(work, { recursive: true, force: true });
}
