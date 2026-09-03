// goTool.ts is the ONLY file that talks to the bundled goformsdesigner Go
// CLI (see ../tool/*.go). Both the scaffolding commands (extension.ts) and
// the visual designer webview provider (designerEditorProvider.ts) go
// through this module - keep its public surface stable, since it is the
// contract the rest of the extension is built against.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ByteRange {
	start: number;
	end: number;
}

/** One entry of a control's editable item list - a ToolStrip button, a tab
 * title, a tree node. Which fields carry meaning is decided by the type's
 * CollectionDesc. */
export interface CollectionItem {
	text: string;
	/** "separator" for a ToolStrip separator; absent for a normal item. */
	kind?: string;
	/** Method name wired to this item's click (ToolStrip buttons). */
	handler?: string;
	/** Nesting level for tree-shaped collections; 0 or absent is a root. */
	depth?: number;
}

export interface ControlSpec {
	id: string;
	type: string;
	parent: string;
	/** Which part of `parent` holds this control ("Panel1"/"Panel2"), for
	 * containers whose halves are reached through an accessor. */
	parentSlot?: string;
	x: number;
	y: number;
	w: number;
	h: number;
	text?: string;
	items?: string[];
	collection?: CollectionItem[];
	/** Set when the file's own add calls contain something the tool can't
	 * regenerate, so the list is shown but not editable. */
	collectionReadOnly?: boolean;
	props?: Record<string, string>;
	events?: Record<string, string>;
	group?: string;
	supported: boolean;
	range: ByteRange;
}

export interface RadioGroupSpec {
	id: string;
	members: string[];
	range: ByteRange;
}

export interface FormModel {
	package: string;
	receiverType: string;
	recvVar: string;
	formTitle: string;
	formWidth: number;
	formHeight: number;
	controls: ControlSpec[];
	radioGroups?: RadioGroupSpec[];
	structRange: ByteRange;
	initRange: ByteRange;
	note?: string;
}

export interface Op {
	op:
		| 'setBounds'
		| 'setText'
		| 'setItems'
		| 'setCollection'
		| 'setProp'
		| 'setEvent'
		| 'add'
		| 'remove'
		| 'setParent'
		| 'setForm'
		| 'rename';
	/** Unused (pass "") for "setForm", which resizes the Form itself rather
	 * than a specific control. */
	id: string;
	type?: string;
	parent?: string;
	parentSlot?: string;
	x?: number;
	y?: number;
	w?: number;
	h?: number;
	text?: string;
	items?: string[];
	/** The complete new item list for "setCollection" - it replaces the
	 * control's existing one rather than merging. */
	collection?: CollectionItem[];
	prop?: string;
	value?: string;
	event?: string;
	handler?: string;
}

/** What `tidy` dropped from a designer file. Mirrors the Go TidyResult
 * (tool/tidy.go). */
export interface TidyResult {
	file: string;
	changed: boolean;
	/** Redundant calls dropped: superseded setters, stacked event wirings. */
	statements: number;
	/** Duplicate struct field declarations dropped. */
	fields: number;
	/** Commented-out generated statements dropped. */
	comments: number;
	/** The removed source lines, trimmed, for reporting back to the user. */
	removed: string[] | null;
}

export interface EnsureHandlerResult {
	file: string;
	method: string;
	created: boolean;
	fileCreated: boolean;
	alreadyExisted: boolean;
	line: number;
}

/** Describes a control type's editable item list; absent for the types that
 * have none. Mirrors the Go CollectionDesc (tool/catalog.go). */
export interface CollectionDesc {
	Label: string;
	Method: string;
	Handler?: boolean;
	Separator?: boolean;
	Tree?: boolean;
	Default?: CollectionItem[];
}

export interface ControlDesc {
	Type: string;
	/** Toolbox group this type belongs to, e.g. "Containers". */
	Category?: string;
	Ctors: string[];
	DefaultW: number;
	DefaultH: number;
	IsContainer: boolean;
	/** Sub-containers reached through an accessor (SplitContainer's
	 * Panel1/Panel2). A type with slots takes children only through one. */
	Slots?: string[];
	Setters: Record<string, string>;
	Events: string[];
	Collection?: CollectionDesc;
}

/** Thrown when no `go` executable could be found. The message names every
 * place that was looked, because on Linux and macOS the usual cause is not a
 * missing toolchain but an invisible one - see findGo. */
export class GoNotFoundError extends Error {
	constructor(searched: string[]) {
		super(
			'GoForms Designer needs the Go toolchain once, to build its helper tool, and could not find it.\n\n' +
			'Looked in: ' + searched.join(', ') + '.\n\n' +
			'If Go is installed somewhere else, set "goforms.goPath" to the full path of the go executable ' +
			'(for example /usr/local/go/bin/go), or launch the editor from a shell that has go on its PATH.'
		);
	}
}

/** Directories worth checking for a Go install, per platform.
 *
 * A GUI editor does not run a login shell, so on Linux and macOS it inherits
 * the desktop session's PATH - not the one `.bashrc` or `.zshrc` builds. The
 * official Go tarball tells you to add /usr/local/go/bin in exactly those
 * files, and every version manager works the same way, so "go works in my
 * terminal but the extension cannot find it" is the normal first experience
 * rather than an unusual one. These are the places it actually lives. */
function goCandidateDirs(): string[] {
	const home = os.homedir();
	if (process.platform === 'win32') {
		return [
			'C:\\Program Files\\Go\\bin',
			'C:\\Go\\bin',
			path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Go', 'bin'),
			path.join(home, 'go', 'bin'),
		];
	}
	return [
		'/usr/local/go/bin',          // the official tarball's own instructions
		'/usr/lib/go/bin',            // distribution packages
		'/usr/local/bin',
		'/opt/homebrew/bin',          // Homebrew on Apple silicon
		'/opt/go/bin',
		'/snap/bin',                  // Ubuntu's snap
		path.join(home, 'go', 'bin'),
		path.join(home, '.local', 'bin'),
		path.join(home, '.asdf', 'shims'),
		path.join(home, '.local', 'share', 'mise', 'shims'),
	];
}

/** Locates a usable `go`, and reports everywhere it looked if it fails.
 *
 * The order is deliberate: an explicit setting wins over everything, then the
 * Go extension's own GOROOT (if the user has that installed, it is already
 * correct), then the environment, then PATH, and only then the guesses. */
export function findGo(): { go: string; searched: string[] } {
	const exe = process.platform === 'win32' ? 'go.exe' : 'go';
	const searched: string[] = [];

	const configured = vscode.workspace.getConfiguration('goforms').get<string>('goPath')?.trim();
	if (configured) {
		searched.push(`the goforms.goPath setting (${configured})`);
		if (isExecutable(configured)) {
			return { go: configured, searched };
		}
	}

	// golang.go stores the toolchain it manages here, and a user who has that
	// extension has a working Go however it was installed.
	const goroots = [
		vscode.workspace.getConfiguration('go').get<string>('goroot')?.trim(),
		process.env.GOROOT,
	];
	for (const root of goroots) {
		if (!root) {
			continue;
		}
		const candidate = path.join(root, 'bin', exe);
		searched.push(candidate);
		if (isExecutable(candidate)) {
			return { go: candidate, searched };
		}
	}

	searched.push('PATH');
	if (canRun(exe)) {
		return { go: exe, searched };
	}

	for (const dir of goCandidateDirs()) {
		if (!dir) {
			continue;
		}
		const candidate = path.join(dir, exe);
		searched.push(candidate);
		if (isExecutable(candidate)) {
			return { go: candidate, searched };
		}
	}

	throw new GoNotFoundError(searched);
}

function isExecutable(p: string): boolean {
	try {
		return fs.statSync(p).isFile() && canRun(p);
	} catch {
		return false;
	}
}

/** Runs `<go> version` to prove the file is a working toolchain rather than
 * a broken symlink or a version-manager shim with nothing behind it. */
function canRun(goPath: string): boolean {
	try {
		cp.execFileSync(goPath, ['version'], { stdio: 'ignore', timeout: 15000 });
		return true;
	} catch {
		return false;
	}
}

export class GoFormsTool {
	private binaryPath: string | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	/** Builds (once, cached in globalStorage) and returns the path to the
	 * goformsdesigner helper binary, rebuilding if the bundled source is
	 * newer than the cached binary (e.g. after an extension update). */
	async ensureBinary(): Promise<string> {
		if (this.binaryPath && fs.existsSync(this.binaryPath)) {
			return this.binaryPath;
		}

		const toolSrcDir = path.join(this.context.extensionPath, 'tool');
		const storageDir = this.context.globalStorageUri.fsPath;
		fs.mkdirSync(storageDir, { recursive: true });
		const exeName = process.platform === 'win32' ? 'goformsdesigner.exe' : 'goformsdesigner';
		const dest = path.join(storageDir, exeName);

		const needsBuild = !fs.existsSync(dest) || isSourceNewer(toolSrcDir, dest);
		if (needsBuild) {
			await this.build(toolSrcDir, dest);
		}
		this.binaryPath = dest;
		return dest;
	}

	private build(toolSrcDir: string, dest: string): Promise<void> {
		const { go } = findGo();
		return new Promise((resolve, reject) => {
			// GOFLAGS and GO111MODULE from the user's environment can turn this
			// into a vendored or GOPATH-mode build of a module that is neither,
			// and GOCACHE has to be somewhere writable - a sandboxed editor may
			// have no HOME that Go would pick by default.
			const env = {
				...process.env,
				GO111MODULE: 'on',
				GOFLAGS: '',
				GOCACHE: process.env.GOCACHE || path.join(path.dirname(dest), 'gocache'),
			};
			cp.execFile(go, ['build', '-o', dest, '.'], { cwd: toolSrcDir, env }, (err, _stdout, stderr) => {
				if (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
						reject(new GoNotFoundError([go]));
					} else {
						reject(new Error(`go build failed (using ${go}): ${stderr || err.message}`));
					}
					return;
				}
				try {
					// go build sets the executable bit itself, but a helper left
					// behind by an interrupted build, or restored from an archive
					// that drops modes, would be unrunnable with no clear reason.
					fs.chmodSync(dest, 0o755);
				} catch {
					// Windows has no mode to set, and a failure here shows up
					// immediately as an exec error with a better message.
				}
				resolve();
			});
		});
	}

	private async run(args: string[], stdin?: string): Promise<string> {
		const bin = await this.ensureBinary();
		return new Promise((resolve, reject) => {
			const child = cp.execFile(bin, args, { maxBuffer: 1024 * 1024 * 16 }, (err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr?.trim() || err.message));
					return;
				}
				resolve(stdout);
			});
			if (stdin !== undefined) {
				child.stdin?.end(stdin);
			}
		});
	}

	async parse(designerPath: string): Promise<FormModel> {
		return JSON.parse(await this.run(['parse', designerPath]));
	}

	async apply(designerPath: string, ops: Op[]): Promise<FormModel> {
		return JSON.parse(await this.run(['apply', designerPath], JSON.stringify(ops)));
	}

	/** paramType is the event-argument type of the generated stub, or the
	 * literal "none" for the parameterless `func()` shape a ToolStrip button
	 * callback needs (see noParams in tool/ensurehandler.go). */
	async ensureHandler(
		designerPath: string,
		receiverType: string,
		recvVar: string,
		method: string,
		paramType?: string
	): Promise<EnsureHandlerResult> {
		const args = ['ensure-handler', designerPath, receiverType, recvVar, method];
		if (paramType) {
			args.push(paramType);
		}
		return JSON.parse(await this.run(args));
	}

	/** Removes the redundancy an editing session leaves in a designer file
	 * (see tool/tidy.go). `apply` already runs this itself, so this is for
	 * the explicit command and for files edited outside the designer. */
	async tidy(designerPath: string): Promise<TidyResult> {
		return JSON.parse(await this.run(['tidy', designerPath]));
	}

	async catalog(): Promise<Record<string, ControlDesc>> {
		return JSON.parse(await this.run(['catalog']));
	}

	/** Toolbox group names in the order the Controls tab should show them. */
	async categories(): Promise<string[]> {
		return JSON.parse(await this.run(['categories']));
	}
}

function isSourceNewer(srcDir: string, binPath: string): boolean {
	const binMtime = fs.statSync(binPath).mtimeMs;
	for (const f of fs.readdirSync(srcDir)) {
		if (!f.endsWith('.go') && f !== 'go.mod') {
			continue;
		}
		if (fs.statSync(path.join(srcDir, f)).mtimeMs > binMtime) {
			return true;
		}
	}
	return false;
}
