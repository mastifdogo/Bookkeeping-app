// Builds Ledger (the server bundle, web UI and SQL) into ledger/, which the
// app runs and electron-builder ships as a resource.
//
//   npm run ledger                     the repo and commit pinned in ledger.json
//   LEDGER_SRC=../Bookeeping npm run ledger   a local checkout instead
//
// ledger/ holds:
//   ledger.mjs   the server, bundled with its dependencies
//   web/         the SvelteKit static site
//   db/          schema.sql, grants.sql and migrations/
//   VERSION      the Ledger version the app reports

import { execSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pin = JSON.parse(readFileSync(path.join(root, "ledger.json"), "utf8"));
const out = path.join(root, "ledger");

function run(cmd, cwd) {
	console.log(`$ ${cmd}  (in ${path.relative(root, cwd) || "."})`);
	execSync(cmd, { cwd, stdio: "inherit" });
}

let src = process.env.LEDGER_SRC ? path.resolve(process.env.LEDGER_SRC) : "";
if (!src) {
	src = path.join(root, ".cache", "Bookeeping");
	if (!existsSync(path.join(src, ".git"))) {
		mkdirSync(src, { recursive: true });
		run("git init -q", src);
		run(`git remote add origin ${pin.repo}`, src);
	}
	run(`git fetch -q --depth 1 origin ${pin.ref}`, src);
	run("git checkout -q --force FETCH_HEAD", src);
}

for (const dir of ["frontend", "backend"]) {
	run("npm ci --no-audit --no-fund", path.join(src, dir));
	run("npm run build", path.join(src, dir));
}

let version;
try {
	version = execSync("git describe --tags --always", { cwd: src, encoding: "utf8" }).trim();
} catch {
	version = "dev";
}

rmSync(out, { recursive: true, force: true });
mkdirSync(path.join(out, "db"), { recursive: true });
cpSync(path.join(src, "backend", "dist", "ledger.mjs"), path.join(out, "ledger.mjs"));
cpSync(path.join(src, "frontend", "build"), path.join(out, "web"), { recursive: true });
for (const f of ["schema.sql", "grants.sql", "migrations"]) {
	cpSync(path.join(src, "db", f), path.join(out, "db", f), { recursive: true });
}
writeFileSync(path.join(out, "VERSION"), `${version}\n`);
console.log(`Ledger ${version} built into ${path.relative(root, out)}/`);
