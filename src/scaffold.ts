// scaffold.ts - shared helpers for the project/form scaffolding commands
// (goforms.createProject, goforms.newForm, goforms.setFrameworkPath).
//
// This is plain Node file-system work: template files under ../templates
// are copied to a target location with a handful of `{{TOKEN}}` markers
// substituted. No dependency on goTool.ts / the bundled Go CLI is needed
// here - scaffolding is just text-templated file copying.
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Tokens substituted into template files at copy time. */
export interface TemplateTokens {
	MODULE: string;
	FRAMEWORK_PATH: string;
}

function substitute(content: string, tokens: TemplateTokens): string {
	return content
		.split('{{MODULE}}').join(tokens.MODULE)
		.split('{{FRAMEWORK_PATH}}').join(tokens.FRAMEWORK_PATH);
}

/** Recursively copies every file under srcDir into destDir, substituting
 * `{{MODULE}}` / `{{FRAMEWORK_PATH}}` tokens in each file's text content.
 * All template files are plain text (Go source, go.mod, README.md), so
 * reading everything as utf8 is safe. */
export async function copyTemplateDir(srcDir: string, destDir: string, tokens: TemplateTokens): Promise<void> {
	await fs.mkdir(destDir, { recursive: true });
	const entries = await fs.readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(srcDir, entry.name);
		const destPath = path.join(destDir, entry.name);
		if (entry.isDirectory()) {
			await copyTemplateDir(srcPath, destPath, tokens);
		} else {
			const content = await fs.readFile(srcPath, 'utf8');
			await fs.writeFile(destPath, substitute(content, tokens), 'utf8');
		}
	}
}

/** Validates a string as a reasonable Go module name AND folder name:
 * lowercase letters/digits/hyphen/underscore, starting with a letter. */
export function validateModuleName(name: string): string | undefined {
	if (!name || !name.trim()) {
		return 'Project name cannot be empty.';
	}
	if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
		return 'Use lowercase letters, digits, hyphen or underscore, starting with a letter (e.g. "myapp", "invoice-tool").';
	}
	return undefined;
}

/** Validates a string as a Go exported identifier suitable for a form name
 * (used as both the struct/type name and the new folder name). PascalCase
 * is recommended (via the input box's placeholder) but not enforced. */
export function validateGoIdentifier(name: string): string | undefined {
	if (!name || !name.trim()) {
		return 'Form name cannot be empty.';
	}
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		return 'Use a valid Go identifier: letters, digits or underscore, not starting with a digit (e.g. "SettingsForm").';
	}
	return undefined;
}

/** Returns true if `dir/go.mod` exists and declares `module goforms`. */
async function isGoFormsCheckout(dir: string): Promise<boolean> {
	try {
		const modPath = path.join(dir, 'go.mod');
		const content = await fs.readFile(modPath, 'utf8');
		return /^module\s+goforms\s*$/m.test(content);
	} catch {
		return false;
	}
}

/** Resolves the local GoForms framework checkout to use for the new
 * project's `replace goforms => ...` directive.
 *
 * Order of preference:
 *   1. The `goforms.frameworkPath` setting, if set and it looks valid.
 *   2. A handful of generic candidate locations near the chosen parent
 *      folder (e.g. a sibling folder literally named "GoForms").
 *   3. Prompt the user with a folder picker, then persist their choice to
 *      the setting (Global scope) so they aren't asked again.
 *
 * Returns undefined if the user cancels the picker. */
export async function resolveFrameworkPath(parentFolder: string): Promise<string | undefined> {
	const config = vscode.workspace.getConfiguration('goforms');
	const configured = config.get<string>('frameworkPath');
	if (configured && configured.trim()) {
		if (await isGoFormsCheckout(configured)) {
			return configured;
		}
		// Configured but doesn't look right (moved/typo'd) - fall through to
		// auto-detect / re-prompt rather than silently using a bad path.
	}

	const candidates = [
		path.join(parentFolder, 'GoForms'),
		path.join(path.dirname(parentFolder), 'GoForms'),
	];
	for (const candidate of candidates) {
		if (await isGoFormsCheckout(candidate)) {
			await config.update('frameworkPath', candidate, vscode.ConfigurationTarget.Global);
			return candidate;
		}
	}

	const picked = await vscode.window.showOpenDialog({
		canSelectFolders: true,
		canSelectFiles: false,
		canSelectMany: false,
		title: 'Select your GoForms framework folder (containing go.mod)',
	});
	if (!picked || picked.length === 0) {
		return undefined;
	}
	const chosen = picked[0].fsPath;
	await config.update('frameworkPath', chosen, vscode.ConfigurationTarget.Global);
	return chosen;
}

/** Computes the value to put after `replace goforms => ` in a new project's
 * go.mod: a relative path (Go module replace directives always use forward
 * slashes, even on Windows) from the new project's go.mod location (the
 * project root) to the framework checkout. */
export function computeReplacePath(projectRoot: string, frameworkPath: string): string {
	let rel = path.relative(projectRoot, frameworkPath);
	rel = rel.split(path.sep).join('/');
	if (!rel.startsWith('.')) {
		rel = './' + rel;
	}
	return rel;
}

export function pathExists(p: string): boolean {
	return fsSync.existsSync(p);
}
