// designerEditorProvider.ts implements the visual drag-and-drop designer:
// a CustomTextEditorProvider for `*-designer.go` files. It renders a
// WinForms-designer-like canvas in a webview (media/designer.js +
// media/designer.css) and talks to the Go side exclusively through
// goTool.ts (GoFormsTool). This file owns no Go-parsing logic of its own -
// it is purely: load model -> send to webview -> receive user actions ->
// call GoFormsTool -> send fresh model back.
import * as fs from 'fs';
import * as vscode from 'vscode';
import { GoFormsTool, FormModel, ControlDesc } from './goTool';

/** Messages sent FROM the webview TO this provider. */
type InboundMessage =
	| { type: 'ready' }
	// `handlers` names stub methods the ops are about to reference (a
	// ToolStrip button's click, say, which is written straight into the add
	// call rather than through setEvent). They are created first, so the file
	// never spends a moment referencing a method that doesn't exist.
	| { type: 'apply'; ops: import('./goTool').Op[]; handlers?: { method: string; paramType: string }[] }
	| { type: 'wireEvent'; id: string; event: string; handler: string; paramType?: string }
	| { type: 'undo' }
	| { type: 'redo' }
	| { type: 'gotoHandler'; id: string; event: string; handler: string };

/** Messages sent FROM this provider TO the webview. */
type OutboundMessage =
	| { type: 'init'; model: FormModel; catalog: Record<string, ControlDesc>; categories: string[] }
	| { type: 'model'; model: FormModel }
	| { type: 'error'; message: string }
	| { type: 'info'; message: string }
	| { type: 'parseError'; message: string }
	| { type: 'handlerWired'; result: import('./goTool').EnsureHandlerResult; model: FormModel };

class DesignerDocumentSession {
	private lastModel: FormModel | undefined;
	/**
	 * The file content as this session last left it on disk.
	 *
	 * The Go tool writes the file directly, so VS Code notices the change and
	 * reloads the TextDocument, which fires onDidChangeTextDocument - our own
	 * edit coming back at us. Re-initializing the webview for that is not
	 * merely wasteful: a full init resets the canvas, so the control the user
	 * had selected was deselected after every single property change. Only a
	 * change that does *not* match what we wrote is a real outside edit.
	 */
	private lastWrittenText: string | undefined;

	constructor(
		private readonly tool: GoFormsTool,
		private readonly document: vscode.TextDocument,
		private readonly webviewPanel: vscode.WebviewPanel
	) {}

	private post(message: OutboundMessage): void {
		this.webviewPanel.webview.postMessage(message);
	}

	/** True when a document change is just this session's own write echoing
	 * back through the file watcher. */
	isSelfWrite(text: string): boolean {
		return this.lastWrittenText !== undefined && text === this.lastWrittenText;
	}

	/** Records the on-disk state after anything this session wrote. */
	private noteWritten(filePath: string): void {
		try {
			this.lastWrittenText = fs.readFileSync(filePath, 'utf8');
		} catch {
			// If it can't be read back, fall through to treating the next
			// change as external - a redundant refresh beats a stale guard.
			this.lastWrittenText = undefined;
		}
	}

	async sendInit(): Promise<void> {
		const filePath = this.document.uri.fsPath;
		let catalog: Record<string, ControlDesc>;
		let categories: string[];
		try {
			catalog = await this.tool.catalog();
			categories = await this.tool.categories();
		} catch (err) {
			this.post({ type: 'parseError', message: describeError(err) });
			return;
		}

		try {
			const model = await this.tool.parse(filePath);
			this.lastModel = model;
			this.post({ type: 'init', model, catalog, categories });
		} catch (err) {
			this.post({ type: 'parseError', message: describeError(err) });
		}
	}

	async handleMessage(message: InboundMessage): Promise<void> {
		const filePath = this.document.uri.fsPath;
		switch (message.type) {
			case 'ready':
				await this.sendInit();
				return;

			case 'apply':
				try {
					// Snapshot before mutating: the Go tool rewrites the file
					// on disk rather than through a TextDocument edit, so
					// VS Code's own undo stack never sees these changes.
					this.pushUndo(filePath);
					await this.ensureStubs(filePath, message.handlers);
					const model = await this.tool.apply(filePath, message.ops);
					this.lastModel = model;
					this.noteWritten(filePath);
					this.post({ type: 'model', model });
				} catch (err) {
					// The apply was atomic and rolled itself back, so the
					// snapshot we just pushed describes a state that never
					// changed - drop it rather than making the user undo a
					// no-op.
					this.undoStack.pop();
					this.post({ type: 'error', message: describeError(err) });
				}
				return;

			case 'undo':
				await this.stepHistory(filePath, this.undoStack, this.redoStack, 'Nothing to undo');
				return;

			case 'redo':
				await this.stepHistory(filePath, this.redoStack, this.undoStack, 'Nothing to redo');
				return;

			case 'wireEvent':
				await this.handleWireEvent(message);
				return;

			case 'gotoHandler':
				await this.handleGotoHandler(message);
				return;
		}
	}

	/** Creates any handler stubs an apply is about to reference. A ToolStrip
	 * button names its callback inside the add call itself, so unlike a
	 * setEvent wiring there is no separate step that would create it - without
	 * this the generated file would reference a method that doesn't exist and
	 * stop compiling. */
	private async ensureStubs(
		filePath: string,
		handlers: { method: string; paramType: string }[] | undefined
	): Promise<void> {
		if (!handlers?.length || !this.lastModel) {
			return;
		}
		const { receiverType, recvVar } = this.lastModel;
		const created: string[] = [];
		for (const h of handlers) {
			const result = await this.tool.ensureHandler(filePath, receiverType, recvVar, h.method, h.paramType);
			if (result.created) {
				created.push(`${result.method} in ${result.file.split(/[\\/]/).pop()}`);
			}
		}
		if (created.length) {
			this.post({ type: 'info', message: `Created ${created.join(', ')}` });
		}
	}

	/**
	 * File snapshots taken before each apply. The designer edits the file
	 * through the Go tool, which writes it directly, so the editor's normal
	 * undo does not cover designer actions - this is the designer's own
	 * history.
	 */
	private undoStack: string[] = [];
	private redoStack: string[] = [];
	private static readonly maxHistory = 100;

	private pushUndo(filePath: string): void {
		try {
			this.undoStack.push(fs.readFileSync(filePath, 'utf8'));
			if (this.undoStack.length > DesignerDocumentSession.maxHistory) {
				this.undoStack.shift();
			}
			// Any new edit invalidates the redo branch, as in every editor.
			this.redoStack.length = 0;
		} catch {
			// A file that cannot be read will fail the apply that follows,
			// with a message naming the real problem. Reporting the missing
			// history entry here would only bury it.
		}
	}

	/** Moves one step between two history stacks, restoring the file. */
	private async stepHistory(
		filePath: string,
		from: string[],
		to: string[],
		emptyMessage: string
	): Promise<void> {
		const snapshot = from.pop();
		if (snapshot === undefined) {
			this.post({ type: 'error', message: emptyMessage });
			return;
		}
		try {
			to.push(fs.readFileSync(filePath, 'utf8'));
			fs.writeFileSync(filePath, snapshot, 'utf8');
			const model = await this.tool.parse(filePath);
			this.lastModel = model;
			this.noteWritten(filePath);
			this.post({ type: 'model', model });
		} catch (err) {
			this.post({ type: 'error', message: describeError(err) });
		}
	}

	/** Jumps straight to an already-wired event handler's method definition,
	 * in whichever file ensureHandler resolves it to (the paired hand-written
	 * file, or its documented fallback) - reuses ensureHandler rather than
	 * duplicating its file-resolution/fallback logic, since for an existing
	 * handler it's a no-op lookup (alreadyExisted: true) that just returns
	 * the file + line to jump to. */
	private async handleGotoHandler(message: { id: string; event: string; handler: string }): Promise<void> {
		const filePath = this.document.uri.fsPath;
		if (!this.lastModel) {
			this.post({ type: 'error', message: 'Cannot jump to handler before the form model has loaded.' });
			return;
		}
		const { receiverType, recvVar } = this.lastModel;
		try {
			const result = await this.tool.ensureHandler(filePath, receiverType, recvVar, message.handler);
			const doc = await vscode.workspace.openTextDocument(result.file);
			const line = Math.max(0, result.line - 1);
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			const pos = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
		} catch (err) {
			this.post({ type: 'error', message: describeError(err) });
		}
	}

	private async handleWireEvent(message: { id: string; event: string; handler: string; paramType?: string }): Promise<void> {
		const filePath = this.document.uri.fsPath;
		if (!this.lastModel) {
			this.post({ type: 'error', message: 'Cannot wire event before the form model has loaded.' });
			return;
		}
		const { receiverType, recvVar } = this.lastModel;
		try {
			const result = await this.tool.ensureHandler(filePath, receiverType, recvVar, message.handler, message.paramType);
			const model = await this.tool.apply(filePath, [
				{ op: 'setEvent', id: message.id, event: message.event, handler: message.handler },
			]);
			this.lastModel = model;
			this.noteWritten(filePath);
			this.post({ type: 'handlerWired', result, model });
		} catch (err) {
			this.post({ type: 'error', message: describeError(err) });
		}
	}
}

function describeError(err: unknown): string {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}

export class GoFormsDesignerEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'goforms.designer';

	/** The document URI of whichever designer webview last had focus - custom
	 * editors aren't `vscode.TextEditor`s, so `window.activeTextEditor` can't
	 * find them; `goforms.openAsText` needs this to know what to reopen when
	 * invoked with no explicit URI (e.g. from the editor/title button while
	 * the designer webview, not a text editor, is the active tab). */
	public activeUri: vscode.Uri | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};

		webviewPanel.webview.html = this.buildHtml(webviewPanel.webview);

		const tool = new GoFormsTool(this.context);
		const session = new DesignerDocumentSession(tool, document, webviewPanel);

		if (webviewPanel.active) {
			this.activeUri = document.uri;
		}
		const viewStateSub = webviewPanel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active) {
				this.activeUri = document.uri;
			}
		});

		const messageSub = webviewPanel.webview.onDidReceiveMessage((message: InboundMessage) => {
			void session.handleMessage(message);
		});

		// If the underlying file changes on disk from outside the webview
		// (e.g. the user hand-edits the -designer.go file in a text editor
		// tab open side-by-side), re-parse and push a fresh model so the
		// canvas doesn't silently drift from the file on disk.
		//
		// Our own writes come back through here too, and re-initializing for
		// those threw away the user's selection on every edit - see
		// isSelfWrite.
		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() !== document.uri.toString()) return;
			if (session.isSelfWrite(e.document.getText())) return;
			void session.sendInit();
		});

		webviewPanel.onDidDispose(() => {
			messageSub.dispose();
			changeSub.dispose();
			viewStateSub.dispose();
			if (this.activeUri?.toString() === document.uri.toString()) {
				this.activeUri = undefined;
			}
		});
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'designer.js'));
		// gridLayout.js (DataGridView sizing) and renderPlan.js (the canvas
		// diff) must load first; designer.js reads both off the global.
		const gridLayoutUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'gridLayout.js')
		);
		const renderPlanUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'renderPlan.js')
		);
		// dockLayout.js is the port of GoForms' docking, so the canvas can
		// place a docked control where the running form will.
		const dockLayoutUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.context.extensionUri, 'media', 'dockLayout.js')
		);
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'designer.css'));
		const csp = [
			`default-src 'none'`,
			`img-src ${webview.cspSource} data:`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
			`font-src ${webview.cspSource}`,
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link href="${styleUri}" rel="stylesheet" />
	<title>GoForms Designer</title>
</head>
<body>
	<div id="app">
		<div id="main">
			<div id="canvas-wrap">
				<div id="canvas-scroll">
					<div id="form-canvas"></div>
				</div>
			</div>
			<!-- One side panel with two tabs, as in the Visual Studio designer:
			     the toolbox and the properties of whatever is selected. -->
			<div id="side-panel">
				<div id="side-tabs" role="tablist">
					<button class="side-tab" data-tab="controls" role="tab">Controls</button>
					<button class="side-tab active" data-tab="properties" role="tab">Properties</button>
				</div>
				<div id="controls-panel" class="side-body" role="tabpanel" hidden></div>
				<div id="properties-panel" class="side-body" role="tabpanel"></div>
			</div>
		</div>
		<div id="toast-stack"></div>
	</div>
	<script nonce="${nonce}" src="${gridLayoutUri}"></script>
	<script nonce="${nonce}" src="${renderPlanUri}"></script>
	<script nonce="${nonce}" src="${dockLayoutUri}"></script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/** The designer file a webview currently has focus on, for commands that run
 * while a custom editor - not a text editor - is the active tab. */
let focusedProvider: GoFormsDesignerEditorProvider | undefined;

export function activeDesignerUri(): vscode.Uri | undefined {
	return focusedProvider?.activeUri;
}

/** Entry point the extension host calls to register the custom editor, plus
 * the two commands that only make sense alongside it: `goforms.openDesigner`
 * reveals the designer for a `*-designer.go` file, and `goforms.openAsText`
 * is its inverse. The file-level commands are registered in extension.ts. */
export function register(context: vscode.ExtensionContext): vscode.Disposable[] {
	const provider = new GoFormsDesignerEditorProvider(context);
	focusedProvider = provider;
	const providerReg = vscode.window.registerCustomEditorProvider(GoFormsDesignerEditorProvider.viewType, provider, {
		webviewOptions: { retainContextWhenHidden: true },
		supportsMultipleEditorsPerDocument: false,
	});

	const openDesignerReg = vscode.commands.registerCommand('goforms.openDesigner', async (uri?: vscode.Uri) => {
		const target = uri ?? vscode.window.activeTextEditor?.document.uri;
		if (!target) {
			vscode.window.showWarningMessage('GoForms: open a *-designer.go file first.');
			return;
		}
		await vscode.commands.executeCommand('vscode.openWith', target, GoFormsDesignerEditorProvider.viewType);
	});

	// The companion toggle: jump from the visual designer back to the plain
	// Go source. Custom editors aren't `vscode.TextEditor`s, so when this is
	// invoked with no explicit `uri` (e.g. the editor/title button while the
	// designer webview is the active tab) `window.activeTextEditor` is
	// undefined - fall back to `provider.activeUri`, which the provider keeps
	// up to date via `onDidChangeViewState` (see resolveCustomTextEditor).
	const openAsTextReg = vscode.commands.registerCommand('goforms.openAsText', async (uri?: vscode.Uri) => {
		const target = uri ?? provider.activeUri ?? vscode.window.activeTextEditor?.document.uri;
		if (!target) {
			vscode.window.showWarningMessage('GoForms: open a *-designer.go file first.');
			return;
		}
		await vscode.commands.executeCommand('vscode.openWith', target, 'default');
	});

	context.subscriptions.push(providerReg, openDesignerReg, openAsTextReg);
	return [providerReg, openDesignerReg, openAsTextReg];
}
