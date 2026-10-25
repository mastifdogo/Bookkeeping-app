// The two background processes behind the window: a private PostgreSQL
// cluster (binaries from the embedded-postgres packages, run with pg_ctl) and
// the Ledger server. Nothing here imports Electron, so it can be exercised
// with plain Node (scripts/check.mjs).
//
// The database is set up the way deploy/setup-db.sh does it on a server:
//   postgres      superuser; only this app uses it, to create and migrate
//   ledger_owner  NOLOGIN; owns every table, trigger and function
//   ledger_app    LOGIN; Ledger connects as this role. It can read and
//                 append, but cannot alter tables or disable triggers.

import pg from "pg";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, promises as fsp } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DB_NAME = "ledger";
const OWNER_ROLE = "ledger_owner";
const APP_ROLE = "ledger_app";
const SUPERUSER = "postgres";

// Sized for a desktop: the same limits as the server's postgresql-lowmem.conf.
const PG_SETTINGS = {
	listen_addresses: "127.0.0.1",
	unix_socket_directories: "",
	max_connections: "20",
	shared_buffers: "64MB",
	effective_cache_size: "192MB",
	work_mem: "4MB",
	maintenance_work_mem: "32MB",
	max_wal_size: "256MB",
	min_wal_size: "64MB",
	synchronous_commit: "on",
	fsync: "on",
};

/** A free TCP port on 127.0.0.1, preferring `wanted` when it is free. */
export async function freePort(wanted = 0) {
	const tryPort = (port) =>
		new Promise((resolve) => {
			const srv = net.createServer();
			srv.once("error", () => resolve(0));
			srv.listen({ host: "127.0.0.1", port }, () => {
				const { port: got } = srv.address();
				srv.close(() => resolve(got));
			});
		});
	if (wanted) {
		const got = await tryPort(wanted);
		if (got) return got;
	}
	return tryPort(0);
}

/** Appends to a log file, keeping only the last run once it passes 5 MB. */
export async function openLog(file) {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const st = await fsp.stat(file).catch(() => undefined);
	const stream = createWriteStream(file, { flags: st && st.size > 5 * 1024 * 1024 ? "w" : "a" });
	const write = (text) => {
		for (const line of String(text).split(/\r?\n/)) {
			if (line.trim()) stream.write(`${new Date().toISOString()} ${line}\n`);
		}
	};
	write.close = () => new Promise((resolve) => stream.end(resolve));
	return write;
}

/**
 * The app's private settings: generated passwords and the ports it last used.
 * Readable by the user only.
 */
export async function loadSettings(file) {
	let s = {};
	try {
		s = JSON.parse(await fsp.readFile(file, "utf8"));
	} catch (err) {
		if (err.code !== "ENOENT") throw new Error(`read ${file}: ${err.message}`);
	}
	const fresh = !s.superPassword || !s.appPassword;
	s.superPassword ||= randomBytes(24).toString("hex");
	s.appPassword ||= randomBytes(24).toString("hex");
	if (fresh) await saveSettings(file, s);
	return s;
}

export async function saveSettings(file, s) {
	await fsp.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(s, null, "\t") + "\n", { mode: 0o600 });
	await fsp.rename(tmp, file);
}

/** Whether dir holds a PostgreSQL cluster. */
export function isCluster(dir) {
	return existsSync(path.join(dir, "PG_VERSION"));
}

const ident = (name) => `"${name.replace(/"/g, '""')}"`;
const literal = (s) => `'${s.replace(/'/g, "''")}'`;

/** initdb, pg_ctl and postgres for this platform, from the @embedded-postgres/<platform> package. */
async function pgBinaries() {
	const pkg = { win32: "windows-x64", linux: `linux-${os.arch()}`, darwin: `darwin-${os.arch()}` }[os.platform()];
	if (!pkg) throw new Error(`unsupported platform ${os.platform()}`);
	return import(`@embedded-postgres/${pkg}`);
}

/** Runs a PostgreSQL program; resolves with its exit code and output. */
function runPg(file, args, env = {}) {
	return new Promise((resolve, reject) => {
		const p = spawn(file, args, {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
			env: { ...process.env, LC_ALL: "C", LC_MESSAGES: "C", ...env },
		});
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("error", reject);
		// "exit", not "close": a server started by pg_ctl may keep the pipes open.
		p.on("exit", (code) => resolve({ code, out: out.trim() }));
	});
}

const CONF_FILE = "bookkeeping.conf";

export class Database {
	/**
	 * @param {object} o
	 * @param {string} o.dataDir   the cluster's data directory
	 * @param {string} o.sqlDir    Ledger's db/ (schema.sql, grants.sql, migrations/)
	 * @param {{superPassword: string, appPassword: string}} o.settings
	 * @param {(text: string) => void} o.log
	 * @param {string} [o.serverLog]  where PostgreSQL itself logs (default: next to the data directory)
	 */
	constructor({ dataDir, sqlDir, settings, log, serverLog }) {
		this.dataDir = dataDir;
		this.sqlDir = sqlDir;
		this.settings = settings;
		this.log = log;
		this.serverLog = serverLog ?? `${dataDir}.log`;
		this.port = 0;
		this.started = false;
	}

	async #pgCtl(args) {
		const { pg_ctl } = await pgBinaries();
		return runPg(pg_ctl, ["-D", this.dataDir, ...args]);
	}

	/**
	 * Creates the cluster on first run, starts it with pg_ctl (which also
	 * drops administrator rights on Windows, as PostgreSQL requires), then
	 * sets up or migrates the ledger database.
	 */
	async start(preferredPort = 0) {
		if (!isCluster(this.dataDir)) await this.#initialise();
		const status = await this.#pgCtl(["status"]);
		if (status.code === 0) {
			// Left running by an earlier run that didn't shut down (a crash, a kill).
			this.log("PostgreSQL from an earlier run is still running; stopping it");
			await this.#pgCtl(["stop", "-m", "fast", "-w", "-t", "60"]);
		}
		this.port = await freePort(preferredPort);
		await this.#writeConf();
		await fsp.mkdir(path.dirname(this.serverLog), { recursive: true });
		const r = await this.#pgCtl(["start", "-w", "-t", "120", "-l", this.serverLog]);
		if (r.code !== 0) throw new Error(`PostgreSQL did not start: ${r.out}\nSee ${this.serverLog}`);
		this.started = true;
		this.log(`PostgreSQL started on port ${this.port}`);
		await this.#provision();
	}

	/** initdb into a scratch directory, then move it into place, so a failed run leaves nothing half-made. */
	async #initialise() {
		const { initdb } = await pgBinaries();
		const tmp = `${this.dataDir}.init`;
		await fsp.rm(tmp, { recursive: true, force: true });
		await fsp.mkdir(path.dirname(this.dataDir), { recursive: true });
		const pwDir = await fsp.mkdtemp(path.join(os.tmpdir(), "bookkeeping-"));
		const pwFile = path.join(pwDir, "pw");
		this.log(`creating a new database cluster in ${this.dataDir}`);
		try {
			await fsp.writeFile(pwFile, `${this.settings.superPassword}\n`, { mode: 0o600 });
			// The C locale sorts and behaves the same on every platform.
			const r = await runPg(initdb, [
				`--pgdata=${tmp}`,
				`--username=${SUPERUSER}`,
				`--pwfile=${pwFile}`,
				"--auth=scram-sha-256",
				"--encoding=UTF8",
				"--locale=C",
			]);
			this.log(r.out);
			if (r.code !== 0) throw new Error(`initdb failed: ${r.out}`);
		} finally {
			await fsp.rm(pwDir, { recursive: true, force: true });
		}
		const conf = path.join(tmp, "postgresql.conf");
		await fsp.appendFile(conf, `\n# Bookkeeping's settings (rewritten at every start)\ninclude_if_exists = '${CONF_FILE}'\n`);
		if (existsSync(this.dataDir)) {
			// An empty or broken leftover (no PG_VERSION): keep it aside, never delete data.
			await fsp.rename(this.dataDir, `${this.dataDir}.broken-${Date.now()}`);
		}
		await fsp.rename(tmp, this.dataDir);
	}

	async #writeConf() {
		const lines = Object.entries({ ...PG_SETTINGS, port: String(this.port) }).map(
			([k, v]) => `${k} = ${/^[0-9]+$/.test(v) ? v : `'${v}'`}`,
		);
		await fsp.writeFile(
			path.join(this.dataDir, CONF_FILE),
			`# Written by Bookkeeping at every start; changes here are overwritten.\n${lines.join("\n")}\n`,
		);
	}

	async #client(database) {
		const c = new pg.Client({
			host: "127.0.0.1",
			port: this.port,
			user: SUPERUSER,
			password: this.settings.superPassword,
			database,
		});
		c.on("error", (err) => this.log(`[ERROR] ${err.message}`));
		await c.connect();
		return c;
	}

	async #provision() {
		const { appPassword } = this.settings;
		let c = await this.#client("postgres");
		try {
			const roles = await c.query(`SELECT rolname FROM pg_roles WHERE rolname = ANY($1)`, [[OWNER_ROLE, APP_ROLE]]);
			const have = new Set(roles.rows.map((r) => r.rolname));
			if (!have.has(OWNER_ROLE)) await c.query(`CREATE ROLE ${ident(OWNER_ROLE)} NOLOGIN`);
			if (!have.has(APP_ROLE)) await c.query(`CREATE ROLE ${ident(APP_ROLE)} LOGIN PASSWORD ${literal(appPassword)}`);
			else await c.query(`ALTER ROLE ${ident(APP_ROLE)} PASSWORD ${literal(appPassword)}`);
			const db = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [DB_NAME]);
			if (db.rowCount === 0) {
				this.log("creating the ledger database");
				await c.query(`CREATE DATABASE ${ident(DB_NAME)} OWNER ${ident(OWNER_ROLE)} ENCODING 'UTF8' TEMPLATE template0`);
			}
		} finally {
			await c.end();
		}

		c = await this.#client(DB_NAME);
		try {
			await c.query(`
				REVOKE ALL ON DATABASE ${ident(DB_NAME)} FROM PUBLIC;
				GRANT CONNECT ON DATABASE ${ident(DB_NAME)} TO ${ident(APP_ROLE)};
				ALTER SCHEMA public OWNER TO ${ident(OWNER_ROLE)};
				REVOKE CREATE ON SCHEMA public FROM PUBLIC;
			`);
			const has = await c.query(`SELECT to_regclass('public.journal_entries') IS NOT NULL AS ok`);
			if (!has.rows[0].ok) {
				this.log("applying schema.sql");
				// schema.sql runs its own BEGIN ... COMMIT.
				const schema = await fsp.readFile(path.join(this.sqlDir, "schema.sql"), "utf8");
				await c.query(`SET ROLE ${ident(OWNER_ROLE)};\n${schema}\n;RESET ROLE;`);
			}
			await this.#migrate(c);
		} finally {
			await c.end();
		}
	}

	/** db/migrations/NNN_*.sql not applied yet, in order, each in its own transaction; then the grants. */
	async #migrate(c) {
		await c.query(`
			SET client_min_messages = warning;
			SET ROLE ${ident(OWNER_ROLE)};
			CREATE TABLE IF NOT EXISTS public.schema_migrations (
				name       TEXT        PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
			RESET ROLE;
			RESET client_min_messages;
		`);
		const applied = new Set((await c.query(`SELECT name FROM public.schema_migrations`)).rows.map((r) => r.name));
		const dir = path.join(this.sqlDir, "migrations");
		const files = (await fsp.readdir(dir)).filter((f) => /^[0-9][A-Za-z0-9_.-]*\.sql$/.test(f)).sort();
		for (const name of files) {
			if (applied.has(name)) continue;
			this.log(`applying migration ${name}`);
			const sql = await fsp.readFile(path.join(dir, name), "utf8");
			try {
				await c.query(
					`BEGIN; SET LOCAL ROLE ${ident(OWNER_ROLE)};\n${sql}\n;INSERT INTO public.schema_migrations (name) VALUES (${literal(name)}); COMMIT;`,
				);
			} catch (err) {
				await c.query("ROLLBACK").catch(() => {});
				throw new Error(`migration ${name}: ${err.message}`);
			}
		}
		const grants = (await fsp.readFile(path.join(this.sqlDir, "grants.sql"), "utf8")).replaceAll(':"app_role"', ident(APP_ROLE));
		await c.query(`SET ROLE ${ident(OWNER_ROLE)};\n${grants}\n;RESET ROLE;`);
	}

	/** The connection string Ledger uses (as the restricted app role). */
	get url() {
		return `postgres://${APP_ROLE}:${this.settings.appPassword}@127.0.0.1:${this.port}/${DB_NAME}?sslmode=disable`;
	}

	async hasActiveUsers() {
		const c = await this.#client(DB_NAME);
		try {
			const r = await c.query(`SELECT count(*)::int AS n FROM users WHERE is_active`);
			return r.rows[0].n > 0;
		} finally {
			await c.end();
		}
	}

	/** Fast shutdown: open transactions roll back, everything committed is on disk. */
	async stop() {
		if (!this.started) return;
		this.started = false;
		const r = await this.#pgCtl(["stop", "-m", "fast", "-w", "-t", "60"]);
		if (r.code !== 0) {
			this.log(`[ERROR] fast shutdown failed (${r.out}); stopping immediately`);
			await this.#pgCtl(["stop", "-m", "immediate", "-w", "-t", "30"]);
		}
		this.log("PostgreSQL stopped");
	}
}

/**
 * Runs Ledger's server bundle with a Node.js runtime: Electron's own (with
 * ELECTRON_RUN_AS_NODE=1), or `node` when testing outside Electron.
 */
export class LedgerServer {
	/**
	 * @param {object} o
	 * @param {string} o.ledgerDir  ledger/ (ledger.mjs, web/, VERSION)
	 * @param {string} o.node       the Node.js (or Electron) executable
	 * @param {Record<string, string>} o.env  extra environment (CSV_DIR, MODULES_DIR, ...)
	 * @param {(text: string) => void} o.log
	 */
	constructor({ ledgerDir, node, env, log }) {
		this.ledgerDir = ledgerDir;
		this.node = node;
		this.env = env;
		this.log = log;
		this.proc = undefined;
		this.port = 0;
		this.onExit = undefined;
	}

	#spawn(args, extraEnv, stdio) {
		return spawn(
			this.node,
			["--max-old-space-size=512", "--disallow-code-generation-from-strings", path.join(this.ledgerDir, "ledger.mjs"), ...args],
			{
				env: { ...process.env, ...this.env, ...extraEnv, ELECTRON_RUN_AS_NODE: "1" },
				stdio,
				windowsHide: true,
			},
		);
	}

	/** Starts the server on 127.0.0.1 and waits until /api/v1/health answers. Returns its origin. */
	async start(databaseUrl, preferredPort = 0) {
		this.port = await freePort(preferredPort);
		const proc = this.#spawn([], { DATABASE_URL: databaseUrl, HTTP_ADDR: `127.0.0.1:${this.port}`, COOKIE_SECURE: "false" }, [
			"ignore",
			"pipe",
			"pipe",
		]);
		this.proc = proc;
		proc.stdout.on("data", (d) => this.log(d));
		proc.stderr.on("data", (d) => this.log(d));
		let exited = false;
		proc.on("exit", (code, signal) => {
			exited = true;
			this.log(`ledger exited (code ${code}, signal ${signal})`);
			if (this.proc === proc) {
				this.proc = undefined;
				this.onExit?.(code, signal);
			}
		});
		proc.on("error", (err) => this.log(`[ERROR] ${err.message}`));

		const origin = `http://127.0.0.1:${this.port}`;
		const deadline = Date.now() + 60_000;
		for (;;) {
			if (exited) throw new Error("Ledger stopped while starting; see ledger.log");
			try {
				const r = await fetch(`${origin}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
				if (r.ok) return origin;
			} catch {
				// not listening yet
			}
			if (Date.now() > deadline) throw new Error("Ledger did not start within 60s; see ledger.log");
			await new Promise((r) => setTimeout(r, 200));
		}
	}

	/** `ledger user ...` against the same database. Resolves with its output, rejects with its error. */
	runUserCommand(databaseUrl, args, stdinText = "") {
		return new Promise((resolve, reject) => {
			const p = this.#spawn(["user", ...args], { DATABASE_URL: databaseUrl }, ["pipe", "pipe", "pipe"]);
			let out = "";
			p.stdout.on("data", (d) => (out += d));
			p.stderr.on("data", (d) => (out += d));
			p.on("error", reject);
			p.on("exit", (code) => {
				const text = out.trim();
				if (code === 0) resolve(text);
				else reject(new Error(text.replace(/^error:\s*/, "") || `ledger user exited with code ${code}`));
			});
			p.stdin.end(stdinText);
		});
	}

	async stop() {
		const proc = this.proc;
		if (!proc) return;
		this.proc = undefined;
		const exited = new Promise((resolve) => proc.once("exit", resolve));
		proc.kill("SIGTERM"); // Windows: terminates it; PostgreSQL rolls back anything unfinished
		const timeout = new Promise((resolve) => setTimeout(resolve, 20_000, "timeout"));
		if ((await Promise.race([exited, timeout])) === "timeout") {
			proc.kill("SIGKILL");
			await exited;
		}
	}
}

/**
 * Copies a stopped cluster's data directory. A copy of a cleanly stopped
 * cluster is a complete backup, usable by the same PostgreSQL major version.
 */
export async function copyCluster(from, to) {
	if (!isCluster(from)) throw new Error(`${from} is not a database folder (no PG_VERSION)`);
	await fsp.mkdir(path.dirname(to), { recursive: true });
	const tmp = `${to}.partial`;
	await fsp.rm(tmp, { recursive: true, force: true });
	await fsp.cp(from, tmp, {
		recursive: true,
		// postmaster.pid of a running cluster must not travel with a copy.
		filter: (src) => path.basename(src) !== "postmaster.pid" && path.basename(src) !== "postmaster.opts",
	});
	await fsp.rename(tmp, to);
}

/** Keeps a dated copy in dir at most once a day, and only the newest `keep` copies. */
export async function dailySnapshot(dataDir, dir, keep, log) {
	if (!isCluster(dataDir)) return;
	await fsp.mkdir(dir, { recursive: true });
	const today = new Date().toISOString().slice(0, 10);
	const names = (await fsp.readdir(dir)).filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
	if (!names.includes(today)) {
		log(`daily snapshot to ${path.join(dir, today)}`);
		await copyCluster(dataDir, path.join(dir, today));
		names.push(today);
	}
	for (const old of names.slice(0, Math.max(0, names.length - keep))) {
		await fsp.rm(path.join(dir, old), { recursive: true, force: true });
	}
}
