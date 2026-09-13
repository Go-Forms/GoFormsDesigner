// tools.ts - finds the external programs a build needs beyond Go itself:
// the fyne CLI (Android packaging), the Android NDK, and adb.
//
// Nothing here downloads anything. A GUI editor cannot install an NDK for
// the user, and would not be trusted to; what it can do is look everywhere
// a normal install puts one, say where it looked, and open the guide that
// explains where to put it. That guide ships with the extension, so the
// whole path from "not found" to "found" works with no network at all.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { findGo } from './goTool';

/** Where a program was found, or everywhere it was looked for. */
export interface Found {
	path: string;
	searched: string[];
}

export class ToolNotFoundError extends Error {
	constructor(
		public readonly tool: 'fyne' | 'ndk' | 'adb',
		public readonly searched: string[],
		message: string
	) {
		super(message);
	}
}

function exe(name: string): string {
	return process.platform === 'win32' ? `${name}.exe` : name;
}

function isFile(p: string): boolean {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/** Runs `<bin> <args>` and reports whether it exited cleanly - the test for
 * "this is a working program" rather than "a file with that name exists". */
function runsOk(bin: string, args: string[]): boolean {
	try {
		cp.execFileSync(bin, args, { stdio: 'ignore', timeout: 15000 });
		return true;
	} catch {
		return false;
	}
}

/** `go env GOPATH`, for the bin directory `go install` writes to. */
export function goPathBin(): string | undefined {
	try {
		const { go } = findGo();
		const out = cp.execFileSync(go, ['env', 'GOPATH'], { encoding: 'utf8', timeout: 15000 }).trim();
		// GOPATH may list several directories; go install uses the first.
		const first = out.split(path.delimiter)[0];
		return first ? path.join(first, 'bin') : undefined;
	} catch {
		return undefined;
	}
}

/** `go env GOROOT`, for wasm_exec.js. */
export function goRoot(): string | undefined {
	try {
		const { go } = findGo();
		return cp.execFileSync(go, ['env', 'GOROOT'], { encoding: 'utf8', timeout: 15000 }).trim() || undefined;
	} catch {
		return undefined;
	}
}

/** Where the Go distribution keeps wasm_exec.js: lib/wasm since Go 1.24,
 * misc/wasm before that. */
export function findWasmExec(): Found {
	const searched: string[] = [];
	const root = goRoot();
	if (!root) {
		throw new Error('Could not run `go env GOROOT` to locate wasm_exec.js.');
	}
	for (const rel of ['lib/wasm/wasm_exec.js', 'misc/wasm/wasm_exec.js']) {
		const candidate = path.join(root, ...rel.split('/'));
		searched.push(candidate);
		if (isFile(candidate)) {
			return { path: candidate, searched };
		}
	}
	throw new Error(
		`wasm_exec.js was not found in the Go installation (looked in ${searched.join(', ')}). ` +
		'It ships with every Go release; a distribution package that strips it needs the official tarball instead.'
	);
}

// ---------------------------------------------------------------------------
// fyne CLI
// ---------------------------------------------------------------------------

/** Locates the fyne command-line tool (fyne.io/tools/cmd/fyne), which does
 * the Android packaging. The order mirrors findGo: an explicit setting, then
 * PATH, then where `go install` puts it. */
export function findFyne(): Found {
	const searched: string[] = [];
	const name = exe('fyne');

	const configured = vscode.workspace.getConfiguration('goforms').get<string>('fynePath')?.trim();
	if (configured) {
		searched.push(`the goforms.fynePath setting (${configured})`);
		if (isFile(configured) && runsOk(configured, ['version'])) {
			return { path: configured, searched };
		}
	}

	searched.push('PATH');
	if (runsOk(name, ['version'])) {
		return { path: name, searched };
	}

	const dirs = [goPathBin(), path.join(os.homedir(), 'go', 'bin')].filter((d): d is string => !!d);
	for (const dir of dirs) {
		const candidate = path.join(dir, name);
		if (searched.includes(candidate)) {
			continue;
		}
		searched.push(candidate);
		if (isFile(candidate) && runsOk(candidate, ['version'])) {
			return { path: candidate, searched };
		}
	}

	throw new ToolNotFoundError(
		'fyne',
		searched,
		'The fyne command-line tool is needed to package an Android app, and was not found.\n\n' +
		'Looked in: ' + searched.join(', ') + '.'
	);
}

// ---------------------------------------------------------------------------
// Android NDK
// ---------------------------------------------------------------------------

/** True for a directory that is an NDK root: it has the toolchain the Go
 * Android build calls, not just the name. */
export function looksLikeNdk(dir: string): boolean {
	return isDir(dir) && isDir(path.join(dir, 'toolchains', 'llvm', 'prebuilt')) && isFile(path.join(dir, 'source.properties'));
}

/** Lists `dir/<child>` for every child matching the pattern, newest version
 * first, so an SDK-managed `ndk/` folder with several versions yields the
 * latest. */
function versionedChildren(dir: string, pattern: RegExp): string[] {
	if (!isDir(dir)) {
		return [];
	}
	let names: string[];
	try {
		names = fs.readdirSync(dir).filter((n) => pattern.test(n));
	} catch {
		return [];
	}
	// Version-ish sort: split on non-digits and compare numerically, so
	// 27.0.12077973 sorts above 26.3.11579264 and r27d above r26b.
	const key = (n: string) => n.split(/[^0-9]+/).filter(Boolean).map(Number);
	names.sort((a, b) => {
		const ka = key(a), kb = key(b);
		for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
			const d = (kb[i] ?? -1) - (ka[i] ?? -1);
			if (d !== 0) return d;
		}
		return b.localeCompare(a);
	});
	return names.map((n) => path.join(dir, n));
}

/** Every Android SDK root worth looking in, in the order to prefer them.
 * Both the NDK (under `ndk/<version>`) and adb (under `platform-tools`) live
 * inside one of these, so the list is shared.
 *
 * The default locations are only defaults: Android Studio asks where to put
 * the SDK, and a common answer on Windows is a short path off the drive root
 * rather than the profile - a profile under OneDrive makes the default a bad
 * place for gigabytes of toolchain. */
export function sdkRoots(): string[] {
	const home = os.homedir();
	const env = process.env;
	const roots = [
		env.ANDROID_HOME,
		env.ANDROID_SDK_ROOT,
		path.join(home, 'Android', 'Sdk'),
		path.join(home, 'Library', 'Android', 'sdk'),
	];
	if (process.platform === 'win32') {
		const systemDrive = env.SystemDrive || 'C:';
		roots.push(
			path.join(env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
			path.join(systemDrive, '\\', 'Android', 'Sdk'),
			// What the standalone SDK installer used before Android Studio
			// bundled it.
			path.join(env['ProgramFiles(x86)'] ?? '', 'Android', 'android-sdk'),
		);
	} else {
		roots.push('/opt/android-sdk', '/usr/lib/android-sdk', '/usr/local/android-sdk');
	}
	// A blank environment variable is not a root, and the same root reached
	// two ways is one place to look, not two.
	const seen = new Set<string>();
	return roots.filter((r): r is string => {
		if (!r || r.trim() === '') {
			return false;
		}
		const key = process.platform === 'win32' ? r.toLowerCase() : r;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

/** Everywhere an NDK is normally found, in the order to prefer them. Each
 * entry is either a directory that should itself be the NDK, or a parent
 * whose versioned children are. */
function ndkCandidates(): { label: string; dirs: string[] }[] {
	const home = os.homedir();
	const env = process.env;
	const out: { label: string; dirs: string[] }[] = [];

	for (const name of ['ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_NDK', 'NDK_HOME']) {
		if (env[name]) {
			out.push({ label: `$${name}`, dirs: [env[name] as string] });
		}
	}

	// An SDK install (Android Studio, sdkmanager) keeps NDKs under ndk/<version>.
	for (const sdk of sdkRoots()) {
		out.push({ label: `${sdk}/ndk/*`, dirs: versionedChildren(path.join(sdk, 'ndk'), /^\d+\./) });
		out.push({ label: `${sdk}/ndk-bundle`, dirs: [path.join(sdk, 'ndk-bundle')] });
	}

	// A standalone download unpacked somewhere obvious.
	const drive = env.SystemDrive || 'C:';
	const unpackParents =
		process.platform === 'win32'
			? [
				home,
				path.join(home, 'Android'),
				path.join(drive, '\\'),
				path.join(drive, '\\', 'Android'),
				path.join(env.LOCALAPPDATA ?? '', 'Android'),
			]
			: [home, path.join(home, 'Android'), path.join(home, 'android'), '/opt', '/usr/local', '/usr/lib', '/usr/local/lib'];
	for (const parent of unpackParents) {
		if (!parent) continue;
		out.push({ label: `${parent}/android-ndk-*`, dirs: versionedChildren(parent, /^android-ndk/i) });
	}
	out.push({ label: '/usr/lib/android-ndk', dirs: ['/usr/lib/android-ndk', '/usr/local/lib/android-ndk'] });

	return out;
}

/** Locates the Android NDK. The setting wins, then the environment, then an
 * SDK's ndk/ folder, then the places a hand-unpacked download ends up. */
export function findNdk(): Found {
	const searched: string[] = [];

	const configured = vscode.workspace.getConfiguration('goforms').get<string>('androidNdkPath')?.trim();
	if (configured) {
		searched.push(`the goforms.androidNdkPath setting (${configured})`);
		if (looksLikeNdk(configured)) {
			return { path: configured, searched };
		}
	}

	for (const { label, dirs } of ndkCandidates()) {
		if (dirs.length === 0) {
			searched.push(label);
			continue;
		}
		for (const dir of dirs) {
			searched.push(dir);
			if (looksLikeNdk(dir)) {
				return { path: dir, searched };
			}
		}
	}

	throw new ToolNotFoundError(
		'ndk',
		searched,
		'The Android NDK is needed to build an Android app, and was not found.\n\n' +
		'Looked in: ' + searched.join(', ') + '.'
	);
}

// ---------------------------------------------------------------------------
// adb
// ---------------------------------------------------------------------------

export function findAdb(): Found {
	const searched: string[] = [];
	const name = exe('adb');

	searched.push('PATH');
	if (runsOk(name, ['version'])) {
		return { path: name, searched };
	}

	for (const sdk of sdkRoots()) {
		const candidate = path.join(sdk, 'platform-tools', name);
		searched.push(candidate);
		if (isFile(candidate) && runsOk(candidate, ['version'])) {
			return { path: candidate, searched };
		}
	}

	throw new ToolNotFoundError(
		'adb',
		searched,
		'adb (Android platform-tools) was not found, so the APK cannot be installed from here.\n\n' +
		'Looked in: ' + searched.join(', ') + '.'
	);
}

/** A short line per tool for `GoForms: Check Setup`. */
export function describeTools(): string[] {
	const lines: string[] = [];
	const report = (label: string, find: () => Found) => {
		try {
			const { path: p } = find();
			lines.push(`${label}: ${p}`);
		} catch (err) {
			lines.push(`${label}: NOT FOUND`);
			if (err instanceof ToolNotFoundError) {
				lines.push(`  searched: ${err.searched.join(', ')}`);
			} else {
				lines.push(`  ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	};
	report('wasm_exec.js', findWasmExec);
	report('fyne CLI', findFyne);
	report('Android NDK', findNdk);
	report('adb', findAdb);
	return lines;
}
