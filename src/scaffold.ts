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

/** Tokens substituted into template files at copy time.
 *
 * REPLACE_BLOCK is the whole `replace ... => ...` line including its
 * surrounding blank line, or empty. It is a block rather than just a path
 * because the common project has no replace directive at all, and a template
 * cannot omit a line it has already written. */
export interface TemplateTokens {
	MODULE: string;
	/** Reverse-DNS application id, for FyneApp.toml and the Android package. */
	APP_ID: string;
	/** The name shown on a launcher or a browser tab. */
	APP_NAME: string;
	REPLACE_BLOCK: string;
	/** The line main() calls to apply a theme, or empty for the default look. */
	THEME_CALL: string;
	/** The body of the goforms.Theme literal in the styles file. */
	THEME_BODY: string;
}

function substitute(content: string, tokens: TemplateTokens): string {
	let out = content;
	for (const [key, value] of Object.entries(tokens)) {
		out = out.split(`{{${key}}}`).join(value);
	}
	return out;
}

/** One entry of the Create New Project picker. `template` names a folder
 * under templates/; templates/common is copied under every one of them. */
export interface ProjectTemplate extends vscode.QuickPickItem {
	template: 'empty' | 'example' | 'android' | 'web';
}

export const projectTemplates: ProjectTemplate[] = [
	{ label: 'Empty project', description: 'Minimal GoForms app with a single blank form', template: 'empty' },
	{ label: 'Example project', description: 'Sample forms + most of the control catalog wired up', template: 'example' },
	{
		label: 'Android app',
		description: 'A phone-sized main form, FyneApp.toml and the Android build task ready',
		detail: 'Builds with GoForms: Build for Android (needs the fyne CLI and the NDK - the setup guide is bundled).',
		template: 'android',
	},
	{
		label: 'Web app (WebAssembly)',
		description: 'A main form that fills the browser tab, with the loader page in wasm/',
		detail: 'Builds with GoForms: Build for WebAssembly; only Go is needed.',
		template: 'web',
	},
];

/** Template files that are copied byte for byte rather than substituted. */
const binaryExtensions = new Set(['.png', '.ico', '.jpg', '.jpeg', '.gif', '.woff', '.woff2', '.ttf']);


/** One of the looks offered when a project is created.
 *
 * `body` is the literal the styles file starts from. It is a starting point,
 * not a fixed set: the editor can add or remove any field afterwards, and a
 * field left out keeps Fyne's default for it. */
export interface ThemeChoice {
	label: string;
	description: string;
	detail: string;
	/** false for the look you get by writing no theme at all. */
	styles: boolean;
	body?: string;
}

export const themeChoices: ThemeChoice[] = [
	{
		label: 'Default look',
		description: 'no styles file',
		detail: "Fyne's own theme, which follows the operating system's light/dark setting.",
		styles: false,
	},
	{
		label: 'Light',
		description: '<project>-styles.go, editable',
		detail: 'A plain light scheme to start from.',
		styles: true,
		body: [
			'\t\tName:            "Light",',
			'\t\tBackground:      goforms.RGB(0xF5, 0xF5, 0xF7),',
			'\t\tForeground:      goforms.RGB(0x1A, 0x1A, 0x1E),',
			'\t\tPrimary:         goforms.RGB(0x2E, 0x7D, 0xE0),',
			'\t\tInputBackground: goforms.RGB(0xFF, 0xFF, 0xFF),',
			'\t\tButtonColor:     goforms.RGB(0xE4, 0xE6, 0xEB),',
			'\t\tBorder:          goforms.RGB(0xC2, 0xC6, 0xCE),',
			'\t\tPlaceholder:     goforms.RGB(0x8A, 0x8F, 0x98),',
			'',
		].join('\n'),
	},
	{
		label: 'Dark',
		description: '<project>-styles.go, editable',
		detail: 'A plain dark scheme to start from.',
		styles: true,
		body: [
			'\t\tName:            "Dark",',
			'\t\tDark:            true,',
			'\t\tBackground:      goforms.RGB(0x1E, 0x1F, 0x22),',
			'\t\tForeground:      goforms.RGB(0xE6, 0xE7, 0xEA),',
			'\t\tPrimary:         goforms.RGB(0x4C, 0x97, 0xFF),',
			'\t\tInputBackground: goforms.RGB(0x2A, 0x2C, 0x31),',
			'\t\tButtonColor:     goforms.RGB(0x34, 0x37, 0x3D),',
			'\t\tBorder:          goforms.RGB(0x4A, 0x4E, 0x56),',
			'\t\tPlaceholder:     goforms.RGB(0x8A, 0x8F, 0x98),',
			'',
		].join('\n'),
	},
	{
		label: 'Empty theme',
		description: '<project>-styles.go, nothing set',
		detail: 'A styles file with no fields, so every choice is yours and the editor starts blank.',
		styles: true,
		body: '',
	},
];

/** tokensFor turns a theme choice into the two substitutions the templates
 * need. A project with no styles file gets no call in main() rather than a
 * commented-out one: dead code in a generated file is something to delete,
 * not something to read. */
export function themeTokens(choice: ThemeChoice): Pick<TemplateTokens, 'THEME_CALL' | 'THEME_BODY'> {
	if (!choice.styles) {
		return { THEME_CALL: '', THEME_BODY: '' };
	}
	return {
		THEME_CALL: '\tgoforms.SetTheme(Theme())\n',
		THEME_BODY: choice.body ?? '',
	};
}

/** Recursively copies every file under srcDir into destDir, substituting the
 * `{{TOKEN}}` markers in each file's content *and* in its name - the styles
 * file is called `{{MODULE}}-styles.go`, so the name carries a token like the
 * content does.
 *
 * Template files are plain text (Go source, go.mod, README.md) except the
 * icon and the like, which are copied as they are. */
export async function copyTemplateFile(
	srcPath: string,
	destPath: string,
	tokens: Partial<TemplateTokens>,
): Promise<void> {
	const content = await fs.readFile(srcPath, 'utf8');
	await fs.mkdir(path.dirname(destPath), { recursive: true });
	await fs.writeFile(destPath, substitute(content, tokens as TemplateTokens), 'utf8');
}

export async function copyTemplateDir(srcDir: string, destDir: string, tokens: TemplateTokens): Promise<void> {
	await fs.mkdir(destDir, { recursive: true });
	const entries = await fs.readdir(srcDir, { withFileTypes: true });
	for (const entry of entries) {
		const srcPath = path.join(srcDir, entry.name);
		const destPath = path.join(destDir, substitute(entry.name, tokens));
		if (entry.isDirectory()) {
			await copyTemplateDir(srcPath, destPath, tokens);
		} else if (binaryExtensions.has(path.extname(entry.name).toLowerCase())) {
			await fs.copyFile(srcPath, destPath);
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

/** Resolves a local GoForms checkout, for the projects that opt into building
 * against one instead of the published module.
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

/** The hand-written half of the partial-class split. It lives here rather
 * than next to `New Form` because two commands write it: creating a form, and
 * `GoForms: View Code` on a form whose code-behind was never written (a file
 * generated by an older release, or deleted). */
export function generateLogicFile(formName: string, packageName: string): string {
	return `package ${packageName}

// ${formName}.go is the hand-written half of the partial-class split: event
// handlers and business logic go here. Layout lives in ${formName}-designer.go.
`;
}
