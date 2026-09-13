// build.ts - builds a GoForms project for the desktop, the browser
// (WebAssembly) or Android from inside the editor.
//
// Every build is a sequence of plain processes shown in a terminal panel, so
// what the extension does is exactly what the README says to do by hand -
// there is no hidden step, and a failure is the compiler's own message with
// a clickable file:line. Processes are spawned without a shell, so a path
// with a space or a `$` in it means the same thing on Windows and Linux.
//
// Nothing here needs the network. The WebAssembly loader page ships with the
// extension, wasm_exec.js is taken from the Go installation, and the Android
// packaging is the fyne CLI plus an NDK that are both looked for locally and
// explained by a bundled guide when missing (see tools.ts). The only thing
// that has to have happened online, once, is fetching the modules go.mod
// names - `go mod download` - which is true of any Go project.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findGo, GoNotFoundError } from './goTool';
import { findAdb, findFyne, findNdk, findWasmExec, looksLikeNdk, ToolNotFoundError } from './tools';
import { serveDirectory } from './serve';

export type Target = 'desktop' | 'wasm' | 'android';

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

export interface Project {
	/** The directory holding go.mod. */
	root: string;
	/** The `module` line of go.mod. */
	module: string;
	/** The last path element of the module: what the binary is called. */
	name: string;
	/** Reverse-DNS id for Android and the web manifest. */
	appId: string;
	/** Human name for the launcher and the page title. */
	displayName: string;
	/** The icon FyneApp.toml names, if any, relative to root. */
	icon?: string;
	hasFyneToml: boolean;
}

/** Walks up from a file or folder to the nearest go.mod. */
function findGoModUp(from: string): string | undefined {
	let dir = from;
	try {
		if (fs.statSync(dir).isFile()) {
			dir = path.dirname(dir);
		}
	} catch {
		return undefined;
	}
	for (;;) {
		if (fs.existsSync(path.join(dir, 'go.mod'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

/** Resolves which project a build command means: the one containing the
 * active file, else the single workspace folder, else a pick among them. */
export async function resolveProject(uri?: vscode.Uri): Promise<Project | undefined> {
	const candidates: string[] = [];
	const add = (root: string | undefined) => {
		if (root && !candidates.includes(root)) {
			candidates.push(root);
		}
	};

	if (uri) {
		add(findGoModUp(uri.fsPath));
	}
	const active = vscode.window.activeTextEditor?.document.uri;
	if (active?.scheme === 'file') {
		add(findGoModUp(active.fsPath));
	}
	for (const folder of vscode.workspace.workspaceFolders ?? []) {
		add(findGoModUp(folder.uri.fsPath));
		// A workspace opened one level above the project, as a parent folder
		// of several apps, has the go.mod files one level down.
		try {
			for (const entry of fs.readdirSync(folder.uri.fsPath, { withFileTypes: true })) {
				if (entry.isDirectory() && fs.existsSync(path.join(folder.uri.fsPath, entry.name, 'go.mod'))) {
					add(path.join(folder.uri.fsPath, entry.name));
				}
			}
		} catch {
			// unreadable folder: nothing to add
		}
	}

	let root: string | undefined;
	if (candidates.length === 0) {
		vscode.window.showErrorMessage('GoForms: no go.mod found. Open a GoForms project folder first.');
		return undefined;
	} else if (candidates.length === 1) {
		root = candidates[0];
	} else {
		const pick = await vscode.window.showQuickPick(
			candidates.map((c) => ({ label: path.basename(c), description: c, root: c })),
			{ title: 'GoForms: which project?' }
		);
		root = pick?.root;
	}
	if (!root) {
		return undefined;
	}
	return readProject(root);
}

export function readProject(root: string): Project {
	const goMod = fs.readFileSync(path.join(root, 'go.mod'), 'utf8');
	const module = /^module\s+(\S+)/m.exec(goMod)?.[1] ?? path.basename(root);
	const name = module.split('/').pop() ?? module;

	const project: Project = {
		root,
		module,
		name,
		appId: `com.example.${name.replace(/[^A-Za-z0-9_]/g, '_')}`,
		displayName: name,
		hasFyneToml: false,
	};

	// FyneApp.toml is what the fyne CLI reads; the same values name the app
	// everywhere else too, so a project that has one is believed.
	const tomlPath = path.join(root, 'FyneApp.toml');
	if (fs.existsSync(tomlPath)) {
		project.hasFyneToml = true;
		const toml = fs.readFileSync(tomlPath, 'utf8');
		const get = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(toml)?.[1];
		project.appId = get('ID') ?? project.appId;
		project.displayName = get('Name') ?? project.displayName;
		project.icon = get('Icon');
	}
	if (!project.icon && fs.existsSync(path.join(root, 'Icon.png'))) {
		project.icon = 'Icon.png';
	}
	return project;
}

// ---------------------------------------------------------------------------
// The terminal the build runs in
// ---------------------------------------------------------------------------

interface Step {
	/** Printed before the command, e.g. "Compiling for js/wasm". */
	label: string;
	/** The program and its arguments, or a function doing the work here. */
	cmd?: string;
	args?: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	run?: (write: (line: string) => void) => Promise<void>;
}

/** A pseudoterminal that runs steps one after another and shows their
 * output. One terminal per project is kept and reused, so repeated builds
 * do not pile up tabs. */
class BuildTerminal implements vscode.Pseudoterminal {
	private readonly writeEmitter = new vscode.EventEmitter<string>();
	private readonly closeEmitter = new vscode.EventEmitter<number | void>();
	readonly onDidWrite = this.writeEmitter.event;
	readonly onDidClose = this.closeEmitter.event;

	private child: cp.ChildProcess | undefined;
	private opened = false;
	private queue: Promise<void> = Promise.resolve();

	open(): void {
		this.opened = true;
	}

	close(): void {
		this.opened = false;
		this.child?.kill();
	}

	handleInput(data: string): void {
		// Ctrl+C in the terminal stops the running step.
		if (data === '\x03') {
			this.child?.kill();
		}
	}

	write(text: string): void {
		this.writeEmitter.fire(text.replace(/\r?\n/g, '\r\n'));
	}

	/** Runs the steps after any already queued, reporting the first failure. */
	run(title: string, steps: Step[]): Promise<boolean> {
		const job = this.queue.then(() => this.runNow(title, steps));
		this.queue = job.then(() => undefined, () => undefined);
		return job;
	}

	private async runNow(title: string, steps: Step[]): Promise<boolean> {
		this.write(`\x1b[1m== ${title}\x1b[0m\n`);
		const started = Date.now();
		for (const step of steps) {
			this.write(`\x1b[36m-- ${step.label}\x1b[0m\n`);
			try {
				if (step.run) {
					await step.run((line) => this.write(line + '\n'));
				} else if (step.cmd) {
					const code = await this.spawn(step);
					if (code !== 0) {
						this.write(`\x1b[31m${path.basename(step.cmd)} exited with code ${code}\x1b[0m\n`);
						this.write(`\x1b[31m== ${title}: FAILED\x1b[0m\n\n`);
						return false;
					}
				}
			} catch (err) {
				this.write(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m\n`);
				this.write(`\x1b[31m== ${title}: FAILED\x1b[0m\n\n`);
				return false;
			}
		}
		const secs = ((Date.now() - started) / 1000).toFixed(1);
		this.write(`\x1b[32m== ${title}: done in ${secs}s\x1b[0m\n\n`);
		return true;
	}

	private spawn(step: Step): Promise<number> {
		const cmd = step.cmd as string;
		const args = step.args ?? [];
		this.write(`$ ${[cmd, ...args].map(quoteForDisplay).join(' ')}\n`);
		return new Promise((resolve, reject) => {
			const child = cp.spawn(cmd, args, {
				cwd: step.cwd,
				env: { ...process.env, ...step.env },
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
			this.child = child;
			child.stdout?.on('data', (d: Buffer) => this.write(d.toString()));
			child.stderr?.on('data', (d: Buffer) => this.write(d.toString()));
			child.on('error', (err) => {
				this.child = undefined;
				reject(err);
			});
			child.on('close', (code, signal) => {
				this.child = undefined;
				if (signal) {
					this.write(`(stopped by ${signal})\n`);
				}
				resolve(code ?? 1);
			});
		});
	}
}

function quoteForDisplay(s: string): string {
	return /[\s"']/.test(s) ? JSON.stringify(s) : s;
}

const terminals = new Map<string, { terminal: vscode.Terminal; pty: BuildTerminal }>();

function terminalFor(project: Project): BuildTerminal {
	const existing = terminals.get(project.root);
	if (existing && vscode.window.terminals.includes(existing.terminal)) {
		existing.terminal.show(true);
		return existing.pty;
	}
	const pty = new BuildTerminal();
	const terminal = vscode.window.createTerminal({ name: `GoForms: ${project.name}`, pty });
	terminals.set(project.root, { terminal, pty });
	terminal.show(true);
	return pty;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

/** The environment every Go build step runs under. GOFLAGS is cleared for
 * the same reason as in goTool.ts: a stray -mod=vendor from the user's shell
 * must not turn this into a different kind of build. */
function goEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const offline = vscode.workspace.getConfiguration('goforms').get<boolean>('build.offline') ?? false;
	const env: NodeJS.ProcessEnv = { GO111MODULE: 'on', GOFLAGS: '', ...extra };
	if (offline) {
		// With GOPROXY=off a module missing from the cache is an immediate
		// error naming it, instead of a download attempt that hangs.
		env.GOPROXY = 'off';
	}
	return env;
}

function buildDir(project: Project, target: Target): string {
	return path.join(project.root, 'build', target);
}

/** Builds the desktop binary into build/desktop/. */
export async function buildDesktop(project: Project): Promise<boolean> {
	const { go } = findGo();
	const out = path.join(buildDir(project, 'desktop'), process.platform === 'win32' ? `${project.name}.exe` : project.name);
	fs.mkdirSync(path.dirname(out), { recursive: true });
	return terminalFor(project).run(`Build ${project.name} for desktop`, [
		{ label: `Compiling for ${process.platform}`, cmd: go, args: ['build', '-o', out, '.'], cwd: project.root, env: goEnv() },
		{ label: 'Output', run: async (w) => w(out) },
	]);
}

/** `go run .` - the quickest way to see a form. */
export async function runDesktop(project: Project): Promise<boolean> {
	const { go } = findGo();
	return terminalFor(project).run(`Run ${project.name}`, [
		{ label: 'go run', cmd: go, args: ['run', '.'], cwd: project.root, env: goEnv() },
	]);
}

/** Builds the WebAssembly bundle into build/wasm/: the .wasm, Go's own
 * wasm_exec.js, and a loader page. The page comes from the project's wasm/
 * folder when it has one (a new project does), else from the extension. */
export async function buildWasm(context: vscode.ExtensionContext, project: Project): Promise<boolean> {
	const { go } = findGo();
	const outDir = buildDir(project, 'wasm');
	const wasmName = `${project.name}.wasm`;
	fs.mkdirSync(outDir, { recursive: true });

	const ok = await terminalFor(project).run(`Build ${project.name} for WebAssembly`, [
		{
			label: 'Compiling for js/wasm',
			cmd: go,
			// -s -w: no symbol table or DWARF, which is a third of the file the
			// browser would otherwise have to download.
			args: ['build', '-ldflags=-s -w', '-o', path.join(outDir, wasmName), '.'],
			cwd: project.root,
			env: goEnv({ GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' }),
		},
		{
			label: 'Assembling the page',
			run: async (write) => {
				const wasmExec = findWasmExec();
				fs.copyFileSync(wasmExec.path, path.join(outDir, 'wasm_exec.js'));
				write(`wasm_exec.js <- ${wasmExec.path}`);

				// The project's own wasm/ folder is the page; the bundled one
				// is the fallback for a project created before there was one.
				const projectWeb = path.join(project.root, 'wasm');
				const source = fs.existsSync(path.join(projectWeb, 'index.html'))
					? projectWeb
					: path.join(context.extensionPath, 'templates', 'common', 'wasm');
				const tokens: Record<string, string> = {
					MODULE: project.name,
					APP_NAME: project.displayName,
					APP_ID: project.appId,
					WASM_FILE: wasmName,
				};
				for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
					if (!entry.isFile()) continue;
					const from = path.join(source, entry.name);
					const to = path.join(outDir, entry.name);
					if (/\.(html|css|js|json|webmanifest|txt)$/i.test(entry.name)) {
						let text = fs.readFileSync(from, 'utf8');
						for (const [k, v] of Object.entries(tokens)) {
							text = text.split(`{{${k}}}`).join(v);
						}
						fs.writeFileSync(to, text, 'utf8');
					} else {
						fs.copyFileSync(from, to);
					}
					write(`${entry.name} <- ${from}`);
				}
				if (project.icon && !fs.existsSync(path.join(outDir, 'icon.png'))) {
					const iconPath = path.join(project.root, project.icon);
					if (fs.existsSync(iconPath)) {
						fs.copyFileSync(iconPath, path.join(outDir, 'icon.png'));
						write(`icon.png <- ${iconPath}`);
					}
				}
				const size = fs.statSync(path.join(outDir, wasmName)).size;
				write(`${wasmName}: ${(size / 1024 / 1024).toFixed(1)} MB`);
				write(`Output: ${outDir}`);
			},
		},
	]);

	if (ok) {
		const choice = await vscode.window.showInformationMessage(
			`WebAssembly build of ${project.name} is in build/wasm. A page loaded from disk cannot run it - browsers refuse .wasm over file:// - so it needs a server.`,
			'Serve and open in browser'
		);
		if (choice) {
			await serveWasm(context, project);
		}
	}
	return ok;
}

/** Serves build/wasm on a local port and opens it. Offline by nature: it is
 * a static file server for a directory on this machine. */
export async function serveWasm(context: vscode.ExtensionContext, project: Project): Promise<void> {
	const dir = buildDir(project, 'wasm');
	if (!fs.existsSync(path.join(dir, 'index.html'))) {
		const choice = await vscode.window.showWarningMessage(
			`There is no WebAssembly build of ${project.name} yet.`,
			'Build it'
		);
		if (choice) {
			await buildWasm(context, project);
		}
		return;
	}
	const url = await serveDirectory(dir);
	await vscode.env.openExternal(vscode.Uri.parse(url));
}

/** Packages an Android APK into build/android/ with the fyne CLI. */
export async function buildAndroid(context: vscode.ExtensionContext, project: Project): Promise<boolean> {
	let fyne: string;
	let ndk: string;
	try {
		fyne = findFyne().path;
		ndk = findNdk().path;
	} catch (err) {
		await offerSetup(context, err);
		return false;
	}

	const config = vscode.workspace.getConfiguration('goforms');
	const target = config.get<string>('android.target') || 'android/arm64';
	const outDir = buildDir(project, 'android');
	fs.mkdirSync(outDir, { recursive: true });

	// fyne package needs an id and an icon. A project with FyneApp.toml has
	// both there; an older one is given them on the command line, and a
	// placeholder icon if it has none at all - the CLI refuses to package
	// without one.
	const args = ['package', '--os', target];
	if (!project.hasFyneToml) {
		args.push('--app-id', project.appId, '--name', project.displayName);
	}
	let icon = project.icon ? path.join(project.root, project.icon) : undefined;
	if (!icon || !fs.existsSync(icon)) {
		icon = path.join(project.root, 'Icon.png');
		if (!fs.existsSync(icon)) {
			fs.copyFileSync(path.join(context.extensionPath, 'templates', 'common', 'Icon.png'), icon);
			vscode.window.showInformationMessage(
				`GoForms: wrote a placeholder Icon.png into ${project.name} - Android needs a launcher icon. Replace it with your own.`
			);
		}
	}
	if (!project.hasFyneToml || !project.icon) {
		args.push('--icon', icon);
	}

	const startedAt = Date.now();
	const ok = await terminalFor(project).run(`Build ${project.name} for Android (${target})`, [
		{
			label: `Packaging with ${fyne}`,
			cmd: fyne,
			args,
			cwd: project.root,
			env: goEnv({ ANDROID_NDK_HOME: ndk, ANDROID_NDK_ROOT: ndk, CGO_ENABLED: '1' }),
		},
		{
			label: 'Collecting the APK',
			run: async (write) => {
				// fyne writes <name>.apk beside go.mod; anything that new is ours.
				const apks = fs
					.readdirSync(project.root)
					.filter((f) => f.toLowerCase().endsWith('.apk'))
					.map((f) => path.join(project.root, f))
					.filter((f) => fs.statSync(f).mtimeMs >= startedAt - 1000);
				if (apks.length === 0) {
					throw new Error('fyne package finished but no .apk appeared in the project folder.');
				}
				for (const apk of apks) {
					const dest = path.join(outDir, path.basename(apk));
					fs.renameSync(apk, dest);
					const size = fs.statSync(dest).size;
					write(`${dest} (${(size / 1024 / 1024).toFixed(1)} MB)`);
				}
			},
		},
	]);

	if (ok) {
		const choice = await vscode.window.showInformationMessage(
			`Android build of ${project.name} is in build/android.`,
			'Install on connected device'
		);
		if (choice) {
			await installAndroid(context, project);
		}
	}
	return ok;
}

/** `adb install -r` of the newest APK in build/android. */
export async function installAndroid(context: vscode.ExtensionContext, project: Project): Promise<boolean> {
	let adb: string;
	try {
		adb = findAdb().path;
	} catch (err) {
		await offerSetup(context, err);
		return false;
	}
	const dir = buildDir(project, 'android');
	const apks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.apk')) : [];
	if (apks.length === 0) {
		vscode.window.showWarningMessage(`There is no Android build of ${project.name} yet - build one first.`);
		return false;
	}
	apks.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
	const apk = path.join(dir, apks[0]);
	return terminalFor(project).run(`Install ${path.basename(apk)}`, [
		{ label: 'Devices', cmd: adb, args: ['devices'] },
		{ label: 'Installing (USB debugging must be enabled on the phone)', cmd: adb, args: ['install', '-r', apk] },
	]);
}

// ---------------------------------------------------------------------------
// Setup guides
// ---------------------------------------------------------------------------

export type Guide = 'android' | 'fyne' | 'wasm';

/** Opens one of the bundled guides in the Markdown preview. They live in
 * docs/ inside the extension, so they open with no network - which is when
 * they are needed, since "download the NDK" is the one step that cannot be
 * done offline and the guide's job is to make it the only one. */
export async function openGuide(context: vscode.ExtensionContext, guide: Guide): Promise<void> {
	const lang = vscode.env.language.toLowerCase().startsWith('ru') ? '.ru' : '';
	const candidates = [`setup-${guide}${lang}.md`, `setup-${guide}.md`];
	for (const name of candidates) {
		const uri = vscode.Uri.joinPath(context.extensionUri, 'docs', name);
		if (fs.existsSync(uri.fsPath)) {
			await vscode.commands.executeCommand('markdown.showPreview', uri);
			return;
		}
	}
	vscode.window.showErrorMessage(`GoForms: the ${guide} setup guide is missing from the extension.`);
}

/** Turns a missing tool into the choices that fix it: open the guide, or
 * point the setting at an install the search did not cover. */
async function offerSetup(context: vscode.ExtensionContext, err: unknown): Promise<void> {
	if (err instanceof GoNotFoundError) {
		vscode.window.showErrorMessage(err.message);
		return;
	}
	if (!(err instanceof ToolNotFoundError)) {
		vscode.window.showErrorMessage(`GoForms: ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	const guide: Guide = err.tool === 'fyne' ? 'fyne' : 'android';
	const setPath = err.tool === 'fyne' ? 'Set fyne path...' : err.tool === 'ndk' ? 'Set NDK path...' : undefined;
	const summary =
		err.tool === 'fyne'
			? 'The fyne command-line tool is not installed (or not visible to the editor). It packages the Android app.'
			: err.tool === 'ndk'
				? 'The Android NDK is not installed (or not where the extension looks). It holds the compiler an Android build needs.'
				: 'adb is not installed (or not visible to the editor). It is how an APK gets onto a phone.';

	const choices = ['Open setup guide', 'Where did it look?'];
	if (setPath) {
		choices.splice(1, 0, setPath);
	}
	const choice = await vscode.window.showErrorMessage(`GoForms: ${summary}`, { modal: true }, ...choices);
	if (choice === 'Open setup guide') {
		await openGuide(context, guide);
	} else if (choice === 'Where did it look?') {
		const channel = vscode.window.createOutputChannel('GoForms');
		context.subscriptions.push(channel);
		channel.clear();
		channel.appendLine(err.message);
		channel.show(true);
	} else if (choice === setPath) {
		if (err.tool === 'fyne') {
			await setFynePath();
		} else {
			await setNdkPath();
		}
	}
}

export async function setNdkPath(): Promise<void> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Select the Android NDK folder (the one containing source.properties and toolchains/)',
	});
	if (!picked?.length) {
		return;
	}
	const chosen = picked[0].fsPath;
	if (!looksLikeNdk(chosen)) {
		const go = await vscode.window.showWarningMessage(
			`${chosen} does not look like an NDK root (no toolchains/llvm/prebuilt inside). Use it anyway?`,
			'Use it',
			'Cancel'
		);
		if (go !== 'Use it') {
			return;
		}
	}
	await vscode.workspace.getConfiguration('goforms').update('androidNdkPath', chosen, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`GoForms: Android NDK path set to ${chosen}.`);
}

export async function setFynePath(): Promise<void> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFolders: false,
		canSelectFiles: true,
		canSelectMany: false,
		title: 'Select the fyne executable',
	});
	if (!picked?.length) {
		return;
	}
	await vscode.workspace.getConfiguration('goforms').update('fynePath', picked[0].fsPath, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`GoForms: fyne path set to ${picked[0].fsPath}.`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function registerBuildCommands(context: vscode.ExtensionContext): void {
	const withProject = (fn: (p: Project) => Promise<unknown>) => async (uri?: vscode.Uri) => {
		try {
			const project = await resolveProject(uri);
			if (project) {
				await fn(project);
			}
		} catch (err) {
			await offerSetup(context, err);
		}
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('goforms.build', withProject(async (project) => {
			const pick = await vscode.window.showQuickPick(
				[
					{ label: '$(device-desktop) Desktop', description: `go build for ${process.platform}`, target: 'desktop' as Target },
					{ label: '$(globe) WebAssembly', description: 'GOOS=js GOARCH=wasm, plus the loader page', target: 'wasm' as Target },
					{ label: '$(device-mobile) Android', description: 'fyne package -os android (needs the NDK)', target: 'android' as Target },
				],
				{ title: `GoForms: build ${project.name} for...` }
			);
			if (!pick) return;
			await buildFor(context, project, pick.target);
		})),
		vscode.commands.registerCommand('goforms.buildDesktop', withProject((p) => buildDesktop(p))),
		vscode.commands.registerCommand('goforms.runDesktop', withProject((p) => runDesktop(p))),
		vscode.commands.registerCommand('goforms.buildWasm', withProject((p) => buildWasm(context, p))),
		vscode.commands.registerCommand('goforms.serveWasm', withProject((p) => serveWasm(context, p))),
		vscode.commands.registerCommand('goforms.buildAndroid', withProject((p) => buildAndroid(context, p))),
		vscode.commands.registerCommand('goforms.installAndroid', withProject((p) => installAndroid(context, p))),
		vscode.commands.registerCommand('goforms.setAndroidNdkPath', () => setNdkPath()),
		vscode.commands.registerCommand('goforms.setFynePath', () => setFynePath()),
		vscode.commands.registerCommand('goforms.openSetupGuide', async (guide?: Guide) => {
			if (!guide) {
				const pick = await vscode.window.showQuickPick(
					[
						{ label: 'Android: NDK and fyne CLI', guide: 'android' as Guide },
						{ label: 'fyne CLI', guide: 'fyne' as Guide },
						{ label: 'WebAssembly', guide: 'wasm' as Guide },
					],
					{ title: 'GoForms: which setup guide?' }
				);
				if (!pick) return;
				guide = pick.guide;
			}
			await openGuide(context, guide);
		})
	);
}

export function buildFor(context: vscode.ExtensionContext, project: Project, target: Target): Promise<boolean> {
	switch (target) {
		case 'desktop':
			return buildDesktop(project);
		case 'wasm':
			return buildWasm(context, project);
		case 'android':
			return buildAndroid(context, project);
	}
}
