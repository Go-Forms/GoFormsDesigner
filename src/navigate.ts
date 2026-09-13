// navigate.ts - F7 / Shift+F7, the WinForms pair.
//
// A form is two files: `X-designer.go` holds the layout the designer writes,
// `X.go` holds the handlers you write. Visual Studio binds F7 to "View Code"
// and Shift+F7 to "View Designer" and people who have used it reach for those
// keys without thinking. Doing it through the Explorer instead means finding
// a file whose name differs from the open one by eleven characters, which is
// the kind of small friction that makes the split feel like a chore rather
// than a convention.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { generateLogicFile, pathExists } from './scaffold';

const DESIGNER_SUFFIX = '-designer.go';

export function registerNavigation(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('goforms.viewCode', () => viewCode()),
		vscode.commands.registerCommand('goforms.viewDesigner', () => viewDesigner())
	);
}

/** The file the keystroke is about: the text editor's, or the designer
 * webview's when a webview has focus - `activeTextEditor` cannot see custom
 * editors, and the designer is one. */
function activeFile(): string | undefined {
	const text = vscode.window.activeTextEditor?.document.uri;
	if (text?.scheme === 'file') {
		return text.fsPath;
	}
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('./designerEditorProvider')?.activeDesignerUri?.()?.fsPath;
	} catch {
		return undefined;
	}
}

/** Opens the code-behind for the form in front of you, writing the stub if
 * the file does not exist - the alternative is an error message about a file
 * the user never chose not to have. */
async function viewCode(): Promise<void> {
	const current = activeFile();
	if (!current) {
		vscode.window.showErrorMessage('GoForms: open a form first.');
		return;
	}
	if (!current.endsWith(DESIGNER_SUFFIX)) {
		// Already on the code side. F7 twice should be a no-op, not an error.
		if (current.endsWith('.go')) {
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(current));
			return;
		}
		vscode.window.showErrorMessage(`${path.basename(current)} is not a GoForms form.`);
		return;
	}

	const logicPath = current.slice(0, -DESIGNER_SUFFIX.length) + '.go';
	if (!pathExists(logicPath)) {
		const formName = path.basename(current, DESIGNER_SUFFIX);
		try {
			await fs.writeFile(logicPath, generateLogicFile(formName, formName.toLowerCase()), { encoding: 'utf8', flag: 'wx' });
		} catch (err) {
			vscode.window.showErrorMessage(`GoForms: could not create ${path.basename(logicPath)} - ${(err as Error).message}`);
			return;
		}
	}
	// Explicitly as text: the .go half has no custom editor, but saying so
	// keeps this working if one is ever registered for it.
	await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(logicPath), 'default');
}

/** Opens the designer for the code-behind in front of you. */
async function viewDesigner(): Promise<void> {
	const current = activeFile();
	if (!current || !current.endsWith('.go')) {
		vscode.window.showErrorMessage('GoForms: open a form first.');
		return;
	}
	const designerPath = current.endsWith(DESIGNER_SUFFIX)
		? current
		: current.slice(0, -'.go'.length) + DESIGNER_SUFFIX;
	if (!pathExists(designerPath)) {
		vscode.window.showErrorMessage(
			`GoForms: there is no ${path.basename(designerPath)} beside ${path.basename(current)}.`
		);
		return;
	}
	await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(designerPath), 'goforms.designer');
}
