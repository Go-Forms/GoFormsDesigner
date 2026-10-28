// updates.ts - "Check for Updates", as the NetForms designer has it: the
// GoForms framework each project of the workspace uses, the Go toolchain,
// and this extension, in one list; what is ticked is updated.
//
// Everything here asks Go, never the network directly: `go list -m -u` and
// `go list -m -versions golang.org/toolchain` go through the module proxy Go is
// configured with, which is the one connection a Go project already makes.
// The extension's own update comes from the marketplace it was installed
// from, so that is VS Code's to check. With goforms.build.offline on,
// nothing is asked at all.
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { goEnv, readProject, runInProjectTerminal } from './build';
import { findGo } from './goTool';

/** The framework's module path, as go.mod requires it. */
const FRAMEWORK = 'github.com/Go-Forms/GoForms';

/** How long the daily check waits between two runs. */
const DAY_MS = 24 * 60 * 60 * 1000;

export function registerUpdates(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('goforms.checkForUpdates', () => checkForUpdates(context, false))
	);
	const config = vscode.workspace.getConfiguration('goforms');
	if (config.get<boolean>('checkForUpdates') && !config.get<boolean>('build.offline')) {
		const last = context.globalState.get<number>('goforms.lastUpdateCheck') ?? 0;
		if (Date.now() - last > DAY_MS) {
			// Quietly, and after startup has settled: it only speaks when
			// there is something to update.
			setTimeout(() => void checkForUpdates(context, true), 15000);
		}
	}
}

/** One thing the list offers to update. */
interface UpdateItem extends vscode.QuickPickItem {
	apply: () => Thenable<unknown> | Promise<unknown>;
}

/** requiresFramework reports whether a go.mod depends on the published
 * framework (not a local checkout put in its place with replace, which is
 * the developer's to move). */
export function requiresFramework(goMod: string): boolean {
	const requires = new RegExp(`^\\s*(require\\s+)?${escape(FRAMEWORK)}\\s+v\\S+`, 'm').test(goMod);
	const replaced = new RegExp(`^\\s*(replace\\s+)?${escape(FRAMEWORK)}(\\s+v\\S+)?\\s*=>\\s*\\.{0,2}[/\\\\]`, 'm').test(goMod);
	return requires && !replaced;
}

function escape(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** frameworkUpdate reads `go list -m -u -json` output: the version in use
 * and the newer one, or undefined when it is current. */
export function frameworkUpdate(json: string): { current: string; latest: string } | undefined {
	try {
		const m = JSON.parse(json) as { Version?: string; Update?: { Version?: string } };
		if (m.Version && m.Update?.Version) return { current: m.Version, latest: m.Update.Version };
	} catch {
		// not JSON: nothing to report
	}
	return undefined;
}

/** latestToolchain picks the newest release out of `go list -m -versions
 * golang.org/toolchain` - versions like "v0.0.1-go1.25.3.linux-amd64", one
 * per release and platform. Release candidates and betas are not offered.
 * (`@latest` is no use here: the proxy orders these versions as semver, by
 * their prerelease suffix, so it answers with go1.9rc2.) */
export function latestToolchain(versionsLine: string): string | undefined {
	let best: string | undefined;
	for (const v of versionsLine.split(/\s+/)) {
		const m = /^v0\.0\.1-(go\d+\.\d+(?:\.\d+)?)\.[a-z0-9]+-[a-z0-9]+$/.exec(v);
		if (m && (!best || compareGo(m[1], best) > 0)) best = m[1];
	}
	return best;
}

/** compareGo orders two "goX.Y[.Z]" versions; release candidates are not
 * offered, so only numbers are compared. */
export function compareGo(a: string, b: string): number {
	const n = (v: string) => v.replace(/^go/, '').split('.').map((x) => parseInt(x, 10) || 0);
	const x = n(a), y = n(b);
	for (let i = 0; i < Math.max(x.length, y.length); i++) {
		const d = (x[i] ?? 0) - (y[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

function goOutput(go: string, args: string[], cwd?: string): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile(go, args, { cwd, env: { ...process.env, ...goEnv() }, timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
			if (err) reject(new Error(stderr.trim() || err.message));
			else resolve(stdout);
		});
	});
}

/** The workspace's projects that use the published framework. */
async function frameworkProjects(): Promise<string[]> {
	const mods = await vscode.workspace.findFiles('**/go.mod', '**/{node_modules,vendor,.git}/**', 50);
	const roots: string[] = [];
	for (const m of mods) {
		try {
			if (requiresFramework(fs.readFileSync(m.fsPath, 'utf8'))) roots.push(path.dirname(m.fsPath));
		} catch {
			// unreadable go.mod: not one to update
		}
	}
	return roots;
}

async function checkForUpdates(context: vscode.ExtensionContext, quiet: boolean): Promise<void> {
	if (vscode.workspace.getConfiguration('goforms').get<boolean>('build.offline')) {
		if (!quiet) {
			vscode.window.showInformationMessage('GoForms: goforms.build.offline is on, so nothing was checked - turn it off to look for updates.');
		}
		return;
	}
	let go: string;
	try {
		go = findGo().go;
	} catch (err) {
		if (!quiet) vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
		return;
	}
	await context.globalState.update('goforms.lastUpdateCheck', Date.now());

	const items: UpdateItem[] = [];
	const problems: string[] = [];
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Window, title: 'GoForms: checking for updates' },
		async () => {
			for (const root of await frameworkProjects()) {
				try {
					const up = frameworkUpdate(await goOutput(go, ['list', '-m', '-u', '-json', FRAMEWORK], root));
					if (!up) continue;
					const project = readProject(root);
					items.push({
						label: `GoForms ${up.latest}`,
						description: `${project.name}: now ${up.current}`,
						detail: `go get ${FRAMEWORK}@${up.latest}, then go mod tidy`,
						picked: true,
						apply: () =>
							runInProjectTerminal(project, `Update GoForms to ${up.latest}`, [
								{ label: 'Updating the framework', cmd: go, args: ['get', `${FRAMEWORK}@${up.latest}`], cwd: root, env: goEnv() },
								{ label: 'Tidying go.mod', cmd: go, args: ['mod', 'tidy'], cwd: root, env: goEnv() },
							]),
					});
				} catch (err) {
					problems.push(`${path.basename(root)}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
			try {
				const current = (await goOutput(go, ['env', 'GOVERSION'])).trim();
				const latest = latestToolchain(await goOutput(go, ['list', '-m', '-versions', 'golang.org/toolchain']));
				if (latest && /^go\d/.test(current) && compareGo(latest, current) > 0) {
					const command = `go install golang.org/dl/${latest}@latest && ${latest} download`;
					items.push({
						label: `Go ${latest}`,
						description: `now ${current}`,
						detail: 'Types the install command into a terminal, for you to check and run',
						picked: false,
						apply: async () => {
							const t = vscode.window.createTerminal({ name: 'GoForms: Go update' });
							t.show();
							t.sendText(command, false);
						},
					});
				}
			} catch (err) {
				problems.push(`Go toolchain: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	);

	if (!items.length) {
		if (!quiet) {
			const extra = problems.length ? ` (could not check: ${problems.join('; ')})` : '';
			const pick = await vscode.window.showInformationMessage(
				`GoForms: the framework and Go are up to date${extra}.`,
				'Check the extension too'
			);
			if (pick) await vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates');
		}
		return;
	}
	if (quiet) {
		const pick = await vscode.window.showInformationMessage(
			`GoForms: ${items.map((i) => i.label).join(', ')} available.`,
			'Show Updates'
		);
		if (!pick) return;
	}
	items.push({
		label: 'GoForms Designer extension',
		description: 'ask VS Code to check the marketplace',
		picked: false,
		apply: () => vscode.commands.executeCommand('workbench.extensions.action.checkForUpdates'),
	});
	const chosen = await vscode.window.showQuickPick(items, {
		title: 'GoForms: Check for Updates',
		placeHolder: 'Tick what to update',
		canPickMany: true,
	});
	for (const item of chosen ?? []) {
		await item.apply();
	}
}
