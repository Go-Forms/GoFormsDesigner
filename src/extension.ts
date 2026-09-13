// extension.ts - activation entry point for GoForms Designer.
//
// It owns the commands that act on files from the outside (scaffolding a
// project or a form, tidying a designer file) and delegates the visual
// designer itself to designerEditorProvider.ts.
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
/** The framework's published module path, and the import every generated
 * file uses. It is one constant because it appears in three places that must
 * agree: the scaffolded go.mod, the generated designer file's import, and the
 * handler stubs the Go helper writes (see tool/ensurehandler.go). */
export const GOFORMS_MODULE = 'github.com/Go-Forms/GoForms';

import {
	computeReplacePath,
	projectTemplates,
	themeChoices,
	themeTokens,
	copyTemplateDir,
	copyTemplateFile,
	generateLogicFile,
	pathExists,
	resolveFrameworkPath,
	validateGoIdentifier,
	validateModuleName,
} from './scaffold';
import { registerBuildCommands, resolveProject } from './build';
import { registerDebugCommands } from './debug';
import { registerNavigation } from './navigate';
import { stopAllServers } from './serve';
import { registerStatus } from './status';
import { describeTools } from './tools';

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('goforms.createProject', () => createProject(context)),
		vscode.commands.registerCommand('goforms.newForm', (folderUri?: vscode.Uri) => newForm(folderUri)),
		vscode.commands.registerCommand('goforms.newTheme', (folderUri?: vscode.Uri) => newTheme(context, folderUri)),
		vscode.commands.registerCommand('goforms.setFrameworkPath', () => setFrameworkPath()),
		vscode.commands.registerCommand('goforms.tidyDesignerFile', (uri?: vscode.Uri) => tidyDesignerFile(context, uri)),
		vscode.commands.registerCommand('goforms.checkSetup', () => checkSetup(context))
	);

	registerBuildCommands(context);
	registerDebugCommands(context);
	registerNavigation(context);
	registerStatus(context);
	registerDesignerEditorIfAvailable(context);
	registerThemeEditor(context);
}

export function deactivate(): void {
	// Commands are disposed via context.subscriptions and the bundled Go CLI
	// is a short-lived child process per invocation (see goTool.ts). The one
	// long-lived thing is the local server for a WebAssembly build.
	stopAllServers();
}

/** Registers the custom editor provider, tolerating its absence.
 *
 * The dynamic require keeps a failure in the designer half - a bad bundle, a
 * module that fails to load - from taking activation down with it, so the
 * scaffolding commands stay available either way. The module is expected to
 * export `register(context)`; `activate` and a default export are accepted
 * as aliases. */
function registerDesignerEditorIfAvailable(context: vscode.ExtensionContext): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const mod = require('./designerEditorProvider');
		const register = mod?.register ?? mod?.activate ?? mod?.default;
		if (typeof register === 'function') {
			register(context);
		} else {
			console.warn('[GoForms Designer] designerEditorProvider module found but exports no register()/activate() function.');
		}
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === 'MODULE_NOT_FOUND') {
			console.warn('[GoForms Designer] designerEditorProvider not found yet - visual designer disabled, scaffolding commands still active.');
		} else {
			console.error('[GoForms Designer] Failed to register the visual designer editor provider:', err);
		}
	}
}

/** Registers the theme editor. Loaded the same defensive way as the designer:
 * a failure in one editor should not take the commands down with it. */
function registerThemeEditor(context: vscode.ExtensionContext): void {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		require('./themeEditorProvider').register(context);
	} catch (err) {
		console.error('[GoForms Designer] Failed to register the theme editor:', err);
	}
}

// ---------------------------------------------------------------------------
// goforms.createProject
// ---------------------------------------------------------------------------

async function createProject(context: vscode.ExtensionContext): Promise<void> {
	const kindPick = await vscode.window.showQuickPick(projectTemplates, {
		title: 'GoForms: Create New Project',
		placeHolder: 'Choose a project template',
	});
	if (!kindPick) {
		return;
	}

	const parentPicked = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Choose a parent folder for the new project',
	});
	if (!parentPicked || parentPicked.length === 0) {
		return;
	}
	const parentFolder = parentPicked[0].fsPath;

	const projectName = await vscode.window.showInputBox({
		title: 'GoForms: Create New Project',
		prompt: 'Project name (used as the Go module name and folder name)',
		placeHolder: 'myapp',
		validateInput: validateModuleName,
	});
	if (!projectName) {
		return;
	}

	const projectRoot = path.join(parentFolder, projectName);
	if (pathExists(projectRoot)) {
		vscode.window.showErrorMessage(`"${projectRoot}" already exists. Choose a different project name or parent folder.`);
		return;
	}

	// The framework is a published module, so the default project depends on
	// the released version and needs nothing local. A `replace` is for working
	// against a checkout - useful when developing the framework itself, wrong
	// as a default, because it pins every new project to one machine's layout
	// and breaks the moment the project is cloned anywhere else.
	const sourcePick = await vscode.window.showQuickPick(
		[
			{
				label: 'Use the published module',
				description: `require ${GOFORMS_MODULE}`,
				detail: 'Recommended. go build fetches it; the project is self-contained and clones anywhere.',
				local: false,
			},
			{
				label: 'Use a local checkout',
				description: 'adds a replace directive',
				detail: 'For working on the framework itself. Ties the project to a path on this machine.',
				local: true,
			},
		],
		{ title: 'GoForms: where should this project get the framework?' }
	);
	if (!sourcePick) {
		return;
	}

	let replaceBlock = '';
	if (sourcePick.local) {
		const frameworkPath = await resolveFrameworkPath(parentFolder);
		if (!frameworkPath) {
			// The picker was cancelled; there is nothing sane to scaffold.
			return;
		}
		replaceBlock = `\nreplace ${GOFORMS_MODULE} => ${computeReplacePath(projectRoot, frameworkPath)}\n`;
	}

	const themePick = await vscode.window.showQuickPick(
		themeChoices.map((c) => ({ ...c, description: c.description.replace('<project>', projectName) })),
		{ title: 'GoForms: how should this project look?' }
	);
	if (!themePick) {
		return;
	}

	const templateDir = path.join(context.extensionPath, 'templates', kindPick.template);
	const tokens = {
		MODULE: projectName,
		APP_ID: `com.example.${projectName.replace(/[^A-Za-z0-9_]/g, '_')}`,
		APP_NAME: projectName,
		REPLACE_BLOCK: replaceBlock,
		...themeTokens(themePick),
	};

	try {
		// Every project gets the files a build for the web or Android needs
		// (FyneApp.toml, an icon, the loader page, the editor's tasks) before
		// the template's own files, so a template may override any of them.
		await copyTemplateDir(path.join(context.extensionPath, 'templates', 'common'), projectRoot, tokens);
		await copyTemplateDir(templateDir, projectRoot, tokens);
		if (themePick.styles) {
			// The styles file is generated rather than living in each
			// template, because a template file cannot decline to be written
			// and most projects will not want one.
			await copyTemplateDir(path.join(context.extensionPath, 'templates', 'styles'), projectRoot, tokens);
		}
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to create project: ${(err as Error).message}`);
		return;
	}

	vscode.window.showInformationMessage(`GoForms project "${projectName}" created at ${projectRoot}.`);
	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(projectRoot), { forceNewWindow: false });
}

// ---------------------------------------------------------------------------
// goforms.newForm
// ---------------------------------------------------------------------------

async function newForm(folderUri?: vscode.Uri): Promise<void> {
	const targetFolder = await resolveTargetFolder(folderUri);
	if (!targetFolder) {
		return;
	}

	const formName = await vscode.window.showInputBox({
		title: 'GoForms: New Form',
		prompt: 'Form name (PascalCase recommended)',
		placeHolder: 'SettingsForm',
		validateInput: validateGoIdentifier,
	});
	if (!formName) {
		return;
	}

	const formDir = path.join(targetFolder, formName);
	if (pathExists(formDir)) {
		vscode.window.showErrorMessage(`"${formDir}" already exists. Choose a different form name.`);
		return;
	}

	const packageName = formName.toLowerCase();
	const designerPath = path.join(formDir, `${formName}-designer.go`);
	const logicPath = path.join(formDir, `${formName}.go`);

	try {
		await fs.mkdir(formDir, { recursive: true });
		await fs.writeFile(designerPath, generateDesignerFile(formName, packageName), 'utf8');
		await fs.writeFile(logicPath, generateLogicFile(formName, packageName), 'utf8');
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to create form: ${(err as Error).message}`);
		return;
	}

	await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(designerPath));
}

/** Adds a theme to a project that was created without one.
 *
 * A project answers "how should this look" once, when it is created, and a
 * project that answered "the default" had no way back: the theme editor edits
 * `<name>-styles.go`, and there was nothing to open. This writes that file,
 * from the same starting points the project wizard offers, and adds the
 * SetTheme call to main() - without which the file is written and ignored,
 * which is worse than not having it.
 */
async function newTheme(context: vscode.ExtensionContext, folderUri?: vscode.Uri): Promise<void> {
	const project = await resolveProject(folderUri);
	if (!project) {
		return;
	}

	const stylesPath = path.join(project.root, `${project.name}-styles.go`);
	if (pathExists(stylesPath)) {
		const open = await vscode.window.showWarningMessage(
			`${path.basename(stylesPath)} already exists - this project has a theme.`,
			'Open it'
		);
		if (open) {
			await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(stylesPath));
		}
		return;
	}

	const choice = await vscode.window.showQuickPick(
		themeChoices.filter((t) => t.styles).map((t) => ({ label: t.label, detail: t.detail, choice: t })),
		{ title: `GoForms: theme for ${project.name}`, matchOnDetail: true }
	);
	if (!choice) {
		return;
	}

	try {
		const template = path.join(context.extensionPath, 'templates', 'styles', '{{MODULE}}-styles.go');
		const tokens = { MODULE: project.name, ...themeTokens(choice.choice) };
		await copyTemplateFile(template, stylesPath, tokens);
	} catch (err) {
		vscode.window.showErrorMessage(`Failed to write the theme: ${(err as Error).message}`);
		return;
	}

	const wired = await wireSetTheme(path.join(project.root, 'main.go'));
	await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(stylesPath));
	vscode.window.showInformationMessage(
		wired
			? `GoForms: added ${path.basename(stylesPath)} and called SetTheme in main.go.`
			: `GoForms: added ${path.basename(stylesPath)}. Call goforms.SetTheme(Theme()) before the first form is created.`
	);
}

/** Adds `goforms.SetTheme(Theme())` to main(), before the first form is
 * created - a theme applied afterwards leaves the form already built with the
 * old one. Reports false if the file is not shaped the way the templates
 * write it, rather than guessing at an edit. */
async function wireSetTheme(mainPath: string): Promise<boolean> {
	let source: string;
	try {
		source = await fs.readFile(mainPath, 'utf8');
	} catch {
		return false;
	}
	if (/SetTheme\s*\(/.test(source)) {
		return true;
	}

	const lines = source.split('\n');
	const mainLine = lines.findIndex((l) => /^func\s+main\s*\(\s*\)\s*{/.test(l));
	if (mainLine < 0) {
		return false;
	}
	lines.splice(mainLine + 1, 0, '\tgoforms.SetTheme(Theme())');
	try {
		await fs.writeFile(mainPath, lines.join('\n'), 'utf8');
		return true;
	} catch {
		return false;
	}
}

async function resolveTargetFolder(folderUri?: vscode.Uri): Promise<string | undefined> {
	if (folderUri) {
		return folderUri.fsPath;
	}
	const defaultUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	const picked = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Choose a folder to create the new form in',
		defaultUri,
	});
	return picked?.[0]?.fsPath;
}

function generateDesignerFile(formName: string, packageName: string): string {
	return `package ${packageName}

import "github.com/Go-Forms/GoForms"

// ${formName}-designer.go is the generated-looking half of the WinForms-style
// partial-class split: field declarations and initializeComponent() live
// here. Hand-written logic and event handler bodies belong in ${formName}.go.
// The GoForms Designer regenerates only this file.
type ${formName} struct {
	*goforms.Form
}

// New${formName} mirrors "new ${formName}()" - allocate, then initializeComponent.
func New${formName}() *${formName} {
	f := &${formName}{Form: goforms.NewForm("${formName}", 500, 350)}
	f.initializeComponent()
	return f
}

// initializeComponent mirrors the WinForms designer's InitializeComponent():
// pure layout, no business logic.
func (f *${formName}) initializeComponent() {
	f.SetClientSize(500, 350)
	f.CenterOnScreen()
}
`;
}

// ---------------------------------------------------------------------------
// goforms.setFrameworkPath
// ---------------------------------------------------------------------------

async function setFrameworkPath(): Promise<void> {
	const picked = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Select your GoForms framework folder (containing go.mod)',
	});
	if (!picked || picked.length === 0) {
		return;
	}
	const chosen = picked[0].fsPath;
	await vscode.workspace.getConfiguration('goforms').update('frameworkPath', chosen, vscode.ConfigurationTarget.Global);
	vscode.window.showInformationMessage(`GoForms framework path set to ${chosen}.`);
}

// ---------------------------------------------------------------------------
// goforms.tidyDesignerFile
// ---------------------------------------------------------------------------

/** Runs the designer file's garbage collector (see tool/tidy.go) over one
 * file on demand.
 *
 * The designer already tidies after every edit it makes, so this is for the
 * cases it never sees: a file edited by hand, merged from a branch, or
 * generated by an older release. */
async function tidyDesignerFile(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
	const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? activeDesignerUri();
	if (!target) {
		vscode.window.showErrorMessage('Open a *-designer.go file first.');
		return;
	}
	if (!target.fsPath.endsWith('-designer.go')) {
		vscode.window.showErrorMessage(`${path.basename(target.fsPath)} is not a GoForms designer file.`);
		return;
	}

	// The tool writes the file directly, so an editor holding unsaved changes
	// for it would overwrite the tidied version on its next save.
	const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === target.fsPath);
	if (open?.isDirty) {
		await open.save();
	}

	try {
		const { GoFormsTool } = require('./goTool');
		const result = await new GoFormsTool(context).tidy(target.fsPath);
		if (!result.changed) {
			vscode.window.showInformationMessage(`${path.basename(target.fsPath)} is already clean.`);
			return;
		}
		const parts = [
			result.statements && `${result.statements} redundant call(s)`,
			result.fields && `${result.fields} duplicate field(s)`,
			result.comments && `${result.comments} commented-out statement(s)`,
		].filter(Boolean);
		vscode.window.showInformationMessage(`Tidied ${path.basename(target.fsPath)}: removed ${parts.join(', ')}.`);
	} catch (err) {
		vscode.window.showErrorMessage(`GoForms: tidy failed - ${err instanceof Error ? err.message : String(err)}`);
	}
}

/** The designer webview's document, when a webview rather than a text editor
 * is what has focus - `window.activeTextEditor` cannot see custom editors. */
function activeDesignerUri(): vscode.Uri | undefined {
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		return require('./designerEditorProvider')?.activeDesignerUri?.();
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// goforms.checkSetup
// ---------------------------------------------------------------------------

/** Reports whether the extension can actually do its job here: which `go` it
 * found, whether the helper CLI builds and answers, and where the framework
 * checkout is.
 *
 * Without this, a Go the editor cannot see looks the same as no Go at all,
 * and the only symptom is the designer failing to open a file. */
async function checkSetup(context: vscode.ExtensionContext): Promise<void> {
	const { GoFormsTool, findGo } = require('./goTool');
	const lines: string[] = [`Platform: ${process.platform} ${process.arch}`];

	let goFound = false;
	try {
		const { go, searched } = findGo();
		lines.push(`Go: ${go}`);
		lines.push(`  searched: ${searched.join(', ')}`);
		goFound = true;
	} catch (err) {
		lines.push(`Go: NOT FOUND`);
		lines.push(`  ${err instanceof Error ? err.message.replace(/\n+/g, ' ') : String(err)}`);
	}

	if (goFound) {
		try {
			const tool = new GoFormsTool(context);
			const binary = await tool.ensureBinary();
			const catalog = await tool.catalog();
			lines.push(`Helper CLI: ${binary}`);
			lines.push(`  built and answering - ${Object.keys(catalog).length} control types`);
		} catch (err) {
			lines.push(`Helper CLI: FAILED`);
			lines.push(`  ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	const framework = vscode.workspace.getConfiguration('goforms').get<string>('frameworkPath');
	lines.push(`Framework path: ${framework?.trim() || '(not set - will be asked for, or auto-detected)'}`);

	// The build targets. Only Go is needed for the desktop and the browser;
	// Android adds the fyne CLI and an NDK, and adb to install the result.
	lines.push('');
	lines.push('Build targets:');
	lines.push('  Desktop: needs only Go');
	lines.push('  WebAssembly: needs only Go (wasm_exec.js below comes with it)');
	lines.push('  Android: needs the fyne CLI and the Android NDK; adb to install');
	for (const line of describeTools()) {
		lines.push('  ' + line);
	}
	lines.push('');
	lines.push('Missing something? Run "GoForms: Open Setup Guide" - the guides are bundled and work offline.');

	const channel = vscode.window.createOutputChannel('GoForms');
	context.subscriptions.push(channel);
    channel.clear();
	channel.appendLine(lines.join('\n'));
	channel.show(true);
}
