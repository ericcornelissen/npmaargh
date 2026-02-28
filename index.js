#!/usr/bin/env node

/// Copyright (C) 2026  Eric Cornelissen
///
/// This program is free software: you can redistribute it and/or modify
/// it under the terms of the GNU Affero General Public License as published by
/// the Free Software Foundation, either version 3 of the License, or
/// (at your option) any later version.
///
/// This program is distributed in the hope that it will be useful,
/// but WITHOUT ANY WARRANTY; without even the implied warranty of
/// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
/// GNU Affero General Public License for more details.
///
/// You should have received a copy of the GNU Affero General Public License
/// along with this program.  If not, see <https://www.gnu.org/licenses/>.

import { exec as _exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { argv, exit, stdout } from "node:process";
import { promisify } from "node:util";

import * as semver from "semver";

const exec = promisify(_exec);

/* -------------------------------------------------------------------------- */

const args = argv.filter(arg => !arg.startsWith("--"));
const flags = argv.filter(arg => arg.startsWith("--"));

const argi = argv[0].endsWith("node") ? 2 : 1;
const target = args[argi] ? args[argi] : path.resolve(".");
const wd = path.resolve(target);

const optHelp = flags.includes("--help");
const optCompact = flags.includes("--compact");
const optIncludePrereleases = flags.includes("--prereleases");

const unknownFlags = flags.filter(flag => !["--help", "--compact", "--prereleases"].includes(flag));
if (unknownFlags.length !== 0) {
	console.warn(`unknown flags: '${unknownFlags.join("', '")}'\n`);
}

if (optHelp) {
	console.info(`npm audit assistant

Usage:

  npx npmaargh [flags...] [target]

Where the target is optional, defaults to the current directory.
Flags are optional, available flags are listed below.

Flags:

  --help         Show this help message.
  --compact      Only show what requires manual action.
  --prereleases  Consider prereleases for upgrading.
`);
	exit(0);
}

/* -------------------------------------------------------------------------- */

const npmListCache = new Map();
async function npmList(subject) {
	if (!npmListCache.has(subject)) {
		async function fetch() {
			const { stdout } = await exec(`npm list ${subject} --json`, { cwd: wd });
			return JSON.parse(stdout);
		}

		npmListCache.set(subject, fetch());
	}

	return await npmListCache.get(subject);
}

const npmViewCache = new Map();
async function npmView(name, version) {
	const subject = name === SELF
		? SELF
		: version ? `${name}@${version}` : name;

	if (!npmViewCache.has(subject)) {
		async function fetch() {
			if (subject === SELF) {
				const manifestPath = path.resolve(wd, "package.json");
				const manifestContent = await readFile(manifestPath, { encoding: "utf-8" });
				const manifest = JSON.parse(manifestContent);
				manifest.versions = [];
				return manifest;
			} else {
				const { stdout } = await exec(`npm view ${subject} --json`, { cwd: wd });
				return JSON.parse(stdout);
			}
		}

		npmViewCache.set(subject, fetch());
	}

	return await npmViewCache.get(subject);
}

function prerelease(version) {
	if (optIncludePrereleases) {
		return true;
	}

	return semver.prerelease(version) === null;
}

/* -------------------------------------------------------------------------- */

console.info("=== npm audit assistant ===");
console.info(`I'm here to help audit '${path.basename(target)}'.`);
console.info("");

console.info("=== setup ===");

/* -------------------------------------------------------------------------- */

stdout.write("Initializing...");

// Install or re-install dependencies so that `npm ls` works.
try {
	await exec("npm clean-install --ignore-scripts", { cwd: wd });
} catch {
	try {
		await exec("npm install --ignore-scripts", { cwd: wd });
	} catch (error) {
		console.error("Failed to (re)install dependencies:", error);
		exit(1);
	}
}

stdout.write("\rInitialized.   \n");

/* -------------------------------------------------------------------------- */

stdout.write("Obtaining audit report...");

let npmAuditReport;
try {
	await exec("npm audit --json", { cwd: wd });
	console.info("Nothing to audit.");
	exit(0);
} catch (error) {
	npmAuditReport = JSON.parse(error.stdout);
}

const reportVersion = npmAuditReport.auditReportVersion;
if (reportVersion !== 2) {
	console.error("Unknown audit report version:", reportVersion);
}

stdout.write("\rObtained audit report.   \n");

/* -------------------------------------------------------------------------- */

stdout.write("Analyzing audit report...");

const vulnerabilities = new Map();
for (const [, info] of Object.entries(npmAuditReport.vulnerabilities)) {
	if (typeof info.via[0] === "string") {
		// This entry is not about a vulnerable package.
		continue;
	}

	for (const vulnerability of info.via) {
		const id = vulnerability.url;
		if (vulnerabilities.has(id)) {
			vulnerabilities.get(id).ranges.add(vulnerability.range);
		} else {
			vulnerabilities.set(id, {
				id,
				pkg: vulnerability.name,
				description: vulnerability.title,
				url: vulnerability.url,
				ranges: new Set([vulnerability.range]),
			});
		}
	}
}

stdout.write("\rAnalyzed audit report.   \n");

/* -------------------------------------------------------------------------- */

const SELF = `<${path.basename(target)}>`;

class Nothing {
	toString() {
		return "n/a";
	}

	update(to) {
		return to;
	}
}
class Need {
	#blocker;
	#reasons;

	constructor(version, reason) {
		this.version = version;

		if (Array.isArray(reason)) {
			this.#reasons = reason;
		} else if (reason) {
			this.#reasons = [reason];
		} else {
			this.#reasons = [];
		}
	}

	toString() {
		let msg = `Need ${this.version}`;

		if (this.#reasons.length !== 0) {
			msg += ` (for ${this.#reasons.join(", ")})`;
		}
		if (this.#blocker) {
			msg + ` | ${this.#blocker}`;
		}

		return msg;
	}

	update(to) {
		switch (true) {
		case to instanceof Nothing:
			return this;
		case to instanceof Need:
			// Heuristic
			const need = semver.compare(this.version, to.version) === 1 ? this : to;
			return new Need(need.version, this.#reasons.concat(to.#reasons));
		case to instanceof Blocker:
			if (this.#blocker) {
				this.#blocker = this.#blocker.upgrade(to);
			}	else {
				this.#blocker = to;
			}

			return this;
		default:
			throw new Error(`unexpected new state: ${to}`);
		}
	}
}
class Blocker {
	#changes;

	constructor(changes) {
		if (Array.isArray(changes)) {
			this.#changes = changes;
		} else {
			this.#changes = [changes];
		}
	}

	toString() {
		const comment = this.#changes
			.map(change => {
				let comment = `${change.name}@${change.from}->${change.to}`;
				if (change.report) {
					comment += ` (${change.report})`;
				}

				return comment;
			})
			.join("; ");

		return `Blocker [${comment}]`;
	}

	update(to) {
		switch (true) {
		case to instanceof Nothing:
			return this;
		case to instanceof Need:
			return to.upgrade(this);
		case to instanceof Blocker:
			return new Blocker(this.#changes.concat(to.#changes));
		default:
			throw new Error(`unexpected new state: ${to}`);
		}
	}
}
class Safe {
	toString() {
		return "n/a (safe version of affected package)";
	}

	update() {
		throw new Error("A 'safe' state should never be updated");
	}
}
class Upgradable {
	constructor(version) {
		this.version = version;
	}

	toString() {
		return `Upgradable (need ${this.version})`;
	}

	update() {
		throw new Error("An 'upgradable' state should never be updated");
	}
}
class Hopeless {
	toString() {
		return "Vulnerable, no fix available";
	}

	update() {
		throw new Error("A 'hopeless' state should never be updated");
	}
}
class Unexpected {
	#msg;

	constructor(msg) {
		this.#msg = msg;
	}

	toString() {
		return `Error: ${this.#msg}`;
	}

	update() {
		throw new Error("A 'hopeless' state should never be updated");
	}
}

async function analyze(vuln, hierarchy, nodeName) {
	const node = { name: nodeName, version: hierarchy.version };
	node.metadata = await npmView(node.name, node.version);

	/* LEAF */

	if (!Object.hasOwn(hierarchy, "dependencies")) {
		const candidates = node.metadata.versions.filter(prerelease);

		const latest = candidates[candidates.length - 1];
		if (Array.from(vuln.ranges).some(range => semver.satisfies(latest, range))) {
			return { ...node, state: new Hopeless() };
		}

		if (Array.from(vuln.ranges).some(range => semver.satisfies(node.version, range))) {
			let target = node.version;
			while (Array.from(vuln.ranges).some(range => semver.satisfies(target, range))) {
				const range = Array.from(vuln.ranges).find(range => semver.satisfies(target, range));
				const latestAffected = semver.maxSatisfying(candidates, range);
				const fixedVersions = candidates.slice(candidates.indexOf(latestAffected) + 1);
				target = fixedVersions[0];
			}

			return { ...node, state: new Need(target) };
		}

		return { ...node, state: new Safe() };
	}

	/* NODE */

	const promises = [];
	for (const [id, info] of Object.entries(hierarchy.dependencies)) {
		const tmp = (node.metadata.dependencies || {})[id]
			|| (node.name === SELF ? (node.metadata.devDependencies || {})[id] : null)
			|| (node.metadata.peerDependencies || {})[id];
		const name = tmp.startsWith("npm:")
			? tmp.replace(/^npm:|@\d.*$/g, "")
			: id;

		promises.push(
			(async function () {
				try {
					return await analyze(vuln, info, name);
				} catch (error) {
					return {
						name,
						version: info.version,
						state: new Unexpected(error.message.split(/\n/)[0]),
					};
				}
			})()
		);
	}

	const result = { ...node, state: new Nothing(), deps: {} };
	for (const entry of await Promise.all(promises)) {
		const id = `${entry.name}@${entry.version}`
		result.deps[id] = entry;

		switch (true) {
		case entry.state instanceof Need: {
			const rangeForChild = (node.metadata.dependencies || {})[entry.name]
				|| (node.name === SELF ? (node.metadata.devDependencies || {})[entry.name] : null)
				|| (node.metadata.peerDependencies || {})[entry.name];

			if (semver.satisfies(entry.state.version, rangeForChild)) {
				result.deps[id].state = new Upgradable(entry.state.version);
			} else {
				const parentVersions = node.metadata.versions;
				const laterVersions = parentVersions.filter(prerelease).filter(version => semver.gt(version, node.version));

				// binary search over earliest parent versions that supports the needed
				// child version
				let left = 0, right = laterVersions.length;
				while (left < right) {
					const mid = left + ((right - left) >> 1);

					const candidateMetadata = await npmView(node.name, laterVersions[mid]);
					const rangeForChild = (candidateMetadata.dependencies || {})[entry.name]
						|| (candidateMetadata.peerDependencies || {})[entry.name];

					const works = rangeForChild === undefined
						|| semver.satisfies(entry.state.version, rangeForChild)
						|| semver.gt(semver.minVersion(rangeForChild), entry.state.version);

					if (works) {
						right = mid;
					} else {
						left = mid + 1;
					}
				}

				if (left < laterVersions.length) {
					result.state = result.state.update(
						new Need(laterVersions[left], `${entry.name}@${entry.state.version}`)
					);
				} else {
					result.state = result.state.update(
						new Blocker({
							name: entry.name,
							from: entry.version,
							to: entry.state.version,
							report: node.name !== SELF ? node.metadata.bugs?.url : null,
							checked: [node.version, ...laterVersions],
						})
					);
				}
			}

			break;
		}

		// These never affects the state of parent.
		case entry.state instanceof Safe:
		case entry.state instanceof Hopeless:
		case entry.state instanceof Blocker:
		case entry.state instanceof Nothing:
		case entry.state instanceof Unexpected:
			break;

		default: throw new Error("unsupported");
		}
	}

	return result;
}

function pruneNoops(result) {
	if (!result.deps) {
		return result.state instanceof Safe || result.state instanceof Upgradable;
	}

	let prune = true;
	for (const [k, dep] of Object.entries(result.deps)) {
		if (pruneNoops(dep)) {
			delete result.deps[k];
		} else {
			prune = false;
		}
	}

	return prune;
}

function print(result, gutter, level) {
	if (!level) {
		function depth(obj, lvl) {
			const length = obj.name.length + obj.version.length + lvl;
			if (!obj.deps) {
				return length;
			}

			const depths = Object.values(obj.deps).map(dep => depth(dep, lvl+1));
			return Math.max(length, ...depths);
		}

		gutter = depth(result, 0);
		level = 0;
	}

	console.info(
		" ".repeat(level),
		`${result.name}@${result.version}`,
		" ".repeat(gutter - level - result.name.length - result.version.length),
		" #",
		result.state.toString(),
	);

	for (const dep of Object.values(result.deps || {})) {
		print(dep, gutter, level + 1);
	}
}

for (const vulnerability of vulnerabilities.values()) {
	console.info(`\n=== ${vulnerability.id} ===`);
	stdout.write("evaluating...");

	try {
		const hierarchy = await npmList(vulnerability.pkg);
		const result = await analyze(vulnerability, hierarchy, SELF);
		if (optCompact && pruneNoops(result)) {
			console.info("\r just run `npm audit fix`");
		} else {
			stdout.write("\r");
			print(result);
		}
	} catch (error) {
		console.warn("\r", error);
	}
}
