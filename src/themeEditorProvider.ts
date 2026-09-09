// themeEditorProvider.ts implements the theme editor: a CustomTextEditorProvider
// for `*-styles.go`, the file holding a project's single goforms.Theme literal.
//
// It is the designer's architecture at a smaller scale, and deliberately so -
// the Go file stays the source of truth, this module owns no Go-parsing logic,
// and every edit goes out to the helper CLI and comes back as a fresh model.
import * as fs from 'fs';
import * as vscode from 'vscode';
import { GoFormsTool, ThemeModel, ThemeOp } from './goTool';

/** Messages sent FROM the webview TO this provider. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'apply'; ops: ThemeOp[] };

/** Messages sent FROM this provider TO the webview. */
type OutboundMessage =
	| { type: 'model'; model: ThemeModel }
	| { type: 'error'; message: string }
	| { type: 'parseError'; message: string };

class ThemeDocumentSession {
	/**
	 * The file content as this session last left it on disk.
	 *
	 * The helper writes the file directly, so VS Code notices and fires
	 * onDidChangeTextDocument with our own edit coming back at us. Reloading
	 * for that would rebuild the panel under the pointer after every colour
	 * change; only a change that does not match what we wrote is a real
	 * outside edit.
	 */
	private lastWrittenText: string | undefined;

	constructor(
		private readonly tool: GoFormsTool,
		private readonly document: vscode.TextDocument,
		private readonly panel: vscode.WebviewPanel
	) {}

	private post(message: OutboundMessage): void {
		this.panel.webview.postMessage(message);
	}

	isSelfWrite(text: string): boolean {
		return this.lastWrittenText !== undefined && text === this.lastWrittenText;
	}

	private noteWritten(filePath: string): void {
		try {
			this.lastWrittenText = fs.readFileSync(filePath, 'utf8');
		} catch {
			// Unreadable: treat the next change as external. A redundant
			// refresh is better than a stale panel.
			this.lastWrittenText = undefined;
		}
	}

	async sendModel(): Promise<void> {
		const filePath = this.document.uri.fsPath;
		try {
			this.post({ type: 'model', model: await this.tool.themeParse(filePath) });
		} catch (err) {
			this.post({ type: 'parseError', message: describeError(err) });
		}
	}

	async handleMessage(message: InboundMessage): Promise<void> {
		if (message.type === 'ready') {
			await this.sendModel();
			return;
		}
		const filePath = this.document.uri.fsPath;
		try {
			const model = await this.tool.themeApply(filePath, message.ops);
			this.noteWritten(filePath);
			this.post({ type: 'model', model });
		} catch (err) {
			// The apply rolled itself back, so the panel still describes the
			// file - re-sending the model would only make it flicker.
			this.post({ type: 'error', message: describeError(err) });
		}
	}
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class GoFormsThemeEditorProvider implements vscode.CustomTextEditorProvider {
	public static readonly viewType = 'goforms.themeEditor';

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

		const session = new ThemeDocumentSession(new GoFormsTool(this.context), document, webviewPanel);

		const messageSub = webviewPanel.webview.onDidReceiveMessage((message: InboundMessage) => {
			void session.handleMessage(message);
		});

		// Hand-edits to the file in a text tab open beside this one should
		// show up here, or the panel silently drifts from what is on disk.
		const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
			if (e.document.uri.toString() !== document.uri.toString()) return;
			if (session.isSelfWrite(e.document.getText())) return;
			void session.sendModel();
		});

		webviewPanel.onDidDispose(() => {
			messageSub.dispose();
			changeSub.dispose();
		});
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'theme.js'));
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'theme.css'));
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
	<title>GoForms Theme</title>
</head>
<body>
	<div id="app">
		<div id="fields"></div>
		<div id="preview"></div>
	</div>
	<div id="toast-stack"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}

/** Registers the theme editor and the two commands that open it. */
export function register(context: vscode.ExtensionContext): vscode.Disposable[] {
	const provider = new GoFormsThemeEditorProvider(context);
	const providerReg = vscode.window.registerCustomEditorProvider(
		GoFormsThemeEditorProvider.viewType,
		provider,
		{ webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }
	);

	// The styles file is one per project and easy to lose track of, so this
	// finds it rather than asking where it is.
	const editThemeReg = vscode.commands.registerCommand('goforms.editTheme', async (uri?: vscode.Uri) => {
		const target = uri ?? (await findStylesFile());
		if (!target) {
			vscode.window.showWarningMessage(
				'GoForms: no *-styles.go found in this workspace. Create a project with a theme, or add the file yourself - it needs one goforms.Theme{...} literal.'
			);
			return;
		}
		await vscode.commands.executeCommand('vscode.openWith', target, GoFormsThemeEditorProvider.viewType);
	});

	const openAsTextReg = vscode.commands.registerCommand('goforms.openThemeAsText', async (uri?: vscode.Uri) => {
		const target = uri ?? (await findStylesFile());
		if (!target) {
			vscode.window.showWarningMessage('GoForms: no *-styles.go found in this workspace.');
			return;
		}
		await vscode.commands.executeCommand('vscode.openWith', target, 'default');
	});

	context.subscriptions.push(providerReg, editThemeReg, openAsTextReg);
	return [providerReg, editThemeReg, openAsTextReg];
}

/** Locates the workspace's styles file, asking only when there is more than
 * one - a project has one theme, so a prompt is normally just in the way. */
async function findStylesFile(): Promise<vscode.Uri | undefined> {
	const found = await vscode.workspace.findFiles('**/*-styles.go', '**/{node_modules,vendor}/**', 20);
	if (found.length === 0) {
		return undefined;
	}
	if (found.length === 1) {
		return found[0];
	}
	const picked = await vscode.window.showQuickPick(
		found.map((uri) => ({ label: vscode.workspace.asRelativePath(uri), uri })),
		{ title: 'GoForms: which theme?' }
	);
	return picked?.uri;
}
