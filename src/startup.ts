// startup.ts - "Set as Startup Form", as in Visual Studio: points the
// goforms.Run call in the project's main.go at another form.
//
// The rewrite itself is the Go helper's (tool/startup.go): it is an edit of
// Go source - the Run argument, the new form's import, the old one's import
// when nothing else uses it - and nothing in src/ writes Go.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findGoModUp } from './build';
import { GoFormsTool } from './goTool';

export function registerStartup(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('goforms.setStartupForm', (uri?: vscode.Uri) => setStartupForm(context, uri))
	);
}

/** The file that runs the app: main.go beside go.mod, or failing that the
 * first .go file there that calls goforms.Run. */
export function findMainFile(root: string): string | undefined {
	const main = path.join(root, 'main.go');
	if (fs.existsSync(main)) return main;
	let names: string[] = [];
	try {
		names = fs.readdirSync(root).filter((n) => n.endsWith('.go') && !n.endsWith('_test.go')).sort();
	} catch {
		return undefined;
	}
	for (const n of names) {
		const p = path.join(root, n);
		try {
			if (/\bgoforms\.Run\(/.test(fs.readFileSync(p, 'utf8'))) return p;
		} catch {
			// unreadable: not the one
		}
	}
	return undefined;
}

/** The designer file a command is about: the one it was invoked on, the
 * designer in front, or the text editor's when that is one. */
function targetDesigner(uri?: vscode.Uri): string | undefined {
	if (uri?.fsPath.endsWith('-designer.go')) return uri.fsPath;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const active: vscode.Uri | undefined = require('./designerEditorProvider')?.activeDesignerUri?.();
		if (active?.fsPath.endsWith('-designer.go')) return active.fsPath;
	} catch {
		// the designer is not loaded; fall through
	}
	const text = vscode.window.activeTextEditor?.document.uri.fsPath;
	return text?.endsWith('-designer.go') ? text : undefined;
}

async function setStartupForm(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
	const designer = targetDesigner(uri);
	if (!designer) {
		vscode.window.showErrorMessage('GoForms: open a form (a *-designer.go file) to make it the startup form.');
		return;
	}
	const root = findGoModUp(designer);
	const main = root && findMainFile(root);
	if (!main) {
		vscode.window.showErrorMessage(`GoForms: no main.go calling goforms.Run was found${root ? ' in ' + root : ''}.`);
		return;
	}
	// The tool writes main.go on disk; an editor holding unsaved changes to
	// it would otherwise put them back over the rewrite on its next save.
	const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === main);
	if (open?.isDirty) await open.save();
	try {
		const result = await new GoFormsTool(context).setStartup(main, designer);
		const form = path.basename(designer, '-designer.go');
		vscode.window.showInformationMessage(
			result.changed
				? `GoForms: ${path.basename(main)} now starts ${form}.`
				: `GoForms: ${form} is already the startup form.`
		);
	} catch (err) {
		vscode.window.showErrorMessage(`GoForms: ${err instanceof Error ? err.message : String(err)}`);
	}
}
