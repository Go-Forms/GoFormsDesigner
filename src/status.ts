// status.ts - the "is there a project here" context key and the status bar
// entry that follows from it.
//
// Two things need to know whether this window holds a GoForms project. The
// welcome view in the Explorer shows its "Create GoForms Project" button only
// when there is none, and the status bar's Run entry is meaningless when there
// is nothing to run. Both read one context key, `goforms.hasProject`, kept in
// step with the go.mod files on disk here.
//
// The key is deliberately *absent* rather than false until the extension has
// looked, so a window the extension never activates in still shows the button
// - the case where it is most wanted is exactly the case where nothing has
// asked the extension to wake up.
import * as vscode from 'vscode';
import { buildFor, resolveProject, Target } from './build';

export function registerStatus(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	item.command = 'goforms.run';
	item.text = '$(play) GoForms';
	item.tooltip = 'Build and run this GoForms project - pick desktop, browser or Android';

	const refresh = async () => {
		const found = await hasGoProject();
		await vscode.commands.executeCommand('setContext', 'goforms.hasProject', found);
		if (found) {
			item.show();
		} else {
			item.hide();
		}
	};

	// A go.mod appearing or disappearing is the whole signal: it is what makes
	// a folder a Go project, and `Create Project` creates one.
	const watcher = vscode.workspace.createFileSystemWatcher('**/go.mod');
	watcher.onDidCreate(refresh);
	watcher.onDidDelete(refresh);

	context.subscriptions.push(
		item,
		watcher,
		vscode.workspace.onDidChangeWorkspaceFolders(refresh),
		vscode.commands.registerCommand('goforms.run', () => run(context))
	);

	void refresh();
}

/** True when a go.mod exists in the open folders. Only the first match is
 * needed, so this stops at one rather than walking the whole tree. */
async function hasGoProject(): Promise<boolean> {
	if (!vscode.workspace.workspaceFolders?.length) {
		return false;
	}
	const found = await vscode.workspace.findFiles('**/go.mod', '**/{node_modules,build,vendor}/**', 1);
	return found.length > 0;
}

/** One Run that asks where. The individual commands stay in the palette for
 * anyone who knows which one they want; this is for the status bar, where a
 * single entry that asks beats three that compete for room. */
async function run(context: vscode.ExtensionContext): Promise<void> {
	const project = await resolveProject();
	if (!project) {
		return;
	}
	const pick = await vscode.window.showQuickPick(
		[
			{ label: '$(device-desktop) Desktop', description: 'go run . - the fastest way to see the form', target: 'desktop' as Target },
			{ label: '$(globe) Browser', description: 'WebAssembly build, served locally and opened', target: 'wasm' as Target },
			{ label: '$(device-mobile) Android', description: 'package an APK (needs the NDK) and offer to install it', target: 'android' as Target },
		],
		{ title: `GoForms: run ${project.name} on...` }
	);
	if (!pick) {
		return;
	}
	if (pick.target === 'desktop') {
		await vscode.commands.executeCommand('goforms.runDesktop');
		return;
	}
	if (pick.target === 'wasm') {
		await vscode.commands.executeCommand('goforms.runWasm');
		return;
	}
	await buildFor(context, project, pick.target);
}
