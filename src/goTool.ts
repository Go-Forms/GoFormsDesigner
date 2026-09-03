// goTool.ts is the ONLY file that talks to the bundled goformsdesigner Go
// CLI (see ../tool/*.go). Both the scaffolding commands (extension.ts) and
// the visual designer webview provider (designerEditorProvider.ts) go
// through this module - keep its public surface stable, since it is the
// contract the rest of the extension is built against.
import * as cp from 'child_process';
import * as fs from 'fs';
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

/** Thrown when a `go` toolchain can't be found on PATH; callers should show
 * a friendly, actionable error message rather than a raw stack trace. */
export class GoNotFoundError extends Error {
	constructor() {
		super('The Go toolchain ("go") was not found on PATH. GoForms Designer needs it once to build its helper tool.');
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
		return new Promise((resolve, reject) => {
			cp.execFile('go', ['build', '-o', dest, '.'], { cwd: toolSrcDir }, (err, _stdout, stderr) => {
				if (err) {
					if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
						reject(new GoNotFoundError());
					} else {
						reject(new Error(`go build failed: ${stderr || err.message}`));
					}
					return;
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
