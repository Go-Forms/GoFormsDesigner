// debug.ts - making F5 do something in a GoForms project.
//
// A new project got a tasks.json and no launch.json, so F5 in a fresh window
// opened the "select a debugger" quick pick and, if you picked wrong, wrote a
// configuration for something else. Debugging a GUI app is where a debugger
// earns its keep - a breakpoint in a Click handler stops with the form still
// on screen - so it should be the key it is everywhere else, not a setup step.
//
// New projects get the file from templates/common. This is for the ones that
// already exist, and for a project whose launch.json someone else wrote.
import * as vscode from 'vscode';
import { resolveProject } from './build';

/** The configurations a GoForms project wants. Kept here rather than only in
 * the template so an existing project can be brought up to date, and so the
 * two can be compared by name. */
function configurations(): Record<string, unknown>[] {
	return [
		{
			name: 'GoForms: debug',
			type: 'go',
			request: 'launch',
			mode: 'debug',
			program: '${workspaceFolder}',
			cwd: '${workspaceFolder}',
		},
		{
			name: 'GoForms: run',
			type: 'go',
			request: 'launch',
			mode: 'debug',
			program: '${workspaceFolder}',
			cwd: '${workspaceFolder}',
			noDebug: true,
		},
	];
}

export function registerDebugCommands(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('goforms.addDebugConfig', () => addDebugConfig()),
		vscode.commands.registerCommand('goforms.debug', () => startDebugging())
	);
}

/** Adds the launch configurations to this workspace folder.
 *
 * It goes through the `launch` configuration rather than writing the file, so
 * VS Code creates or merges launch.json itself - including keeping whatever
 * comments and other configurations are already in it, which a rewrite here
 * would throw away. */
async function addDebugConfig(): Promise<void> {
	const folder = await debugFolder();
	if (!folder) {
		return;
	}

	const launch = vscode.workspace.getConfiguration('launch', folder);
	const existing = launch.get<Record<string, unknown>[]>('configurations') ?? [];
	const wanted = configurations();
	const missing = wanted.filter((w) => !existing.some((e) => e.name === w.name));

	if (missing.length === 0) {
		vscode.window.showInformationMessage('GoForms: this project already has its debug configurations. Press F5.');
		return;
	}

	try {
		await launch.update('configurations', [...existing, ...missing], vscode.ConfigurationTarget.WorkspaceFolder);
	} catch (err) {
		vscode.window.showErrorMessage(`GoForms: could not write the debug configuration - ${(err as Error).message}`);
		return;
	}
	await warnIfNoGoExtension();
	vscode.window.showInformationMessage(
		`GoForms: added ${missing.map((m) => m.name).join(' and ')} to launch.json. F5 now debugs this project.`
	);
}

/** Starts a debug session, adding the configuration first if the project has
 * none. "Debug" that answers by writing a config file and stopping would be a
 * command that does not do what it says. */
async function startDebugging(): Promise<void> {
	const folder = await debugFolder();
	if (!folder) {
		return;
	}
	if (!(await warnIfNoGoExtension())) {
		return;
	}

	const launch = vscode.workspace.getConfiguration('launch', folder);
	const existing = launch.get<Record<string, unknown>[]>('configurations') ?? [];
	if (!existing.some((e) => e.name === 'GoForms: debug')) {
		// Start from the configuration rather than the file: a project opened
		// straight from a template already has one, and one that does not can
		// be debugged without writing anything at all.
		await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(folder), configurations()[0] as vscode.DebugConfiguration);
		return;
	}
	await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(folder), 'GoForms: debug');
}

/** The workspace folder to debug: the one holding the project's go.mod. */
async function debugFolder(): Promise<vscode.Uri | undefined> {
	const project = await resolveProject();
	if (!project) {
		return undefined;
	}
	const uri = vscode.Uri.file(project.root);
	if (!vscode.workspace.getWorkspaceFolder(uri)) {
		// A launch configuration is stored per workspace folder; a project
		// reached from outside the open folders has nowhere to put one.
		vscode.window.showErrorMessage(
			`GoForms: ${project.name} is not inside an open folder, so there is nowhere to store a debug configuration. Open its folder first.`
		);
		return undefined;
	}
	return uri;
}

/** Reports whether the Go extension is installed, and says what is missing if
 * not: `"type": "go"` means nothing without it, and F5 would fail with an
 * error about an unknown debug type rather than about the real problem. */
async function warnIfNoGoExtension(): Promise<boolean> {
	if (vscode.extensions.getExtension('golang.go')) {
		return true;
	}
	const choice = await vscode.window.showWarningMessage(
		'GoForms: debugging needs the Go extension (golang.go), which provides the debugger itself. It is not installed.',
		'Install it',
		'Continue anyway'
	);
	if (choice === 'Install it') {
		await vscode.commands.executeCommand('workbench.extensions.search', 'golang.go');
		return false;
	}
	return choice === 'Continue anyway';
}
