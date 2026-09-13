// Where the extension looks for the Android toolchain.
//
// This is the one part of the build that fails on a machine nobody tested
// on: the NDK and adb are wherever the person who installed Android Studio
// told it to put them, and "not found" is a dead end the user cannot debug -
// they can see the tool on disk, and the extension says it is missing. So
// the search is checked here against directory trees a test builds, rather
// than against whatever happens to be installed on the machine running it.
//
// tools.ts imports `vscode`, which only exists inside the extension host, so
// it is bundled with a stub for it (testlib/vscodeShim.js) and loaded from
// memory. That also means these tests exercise the real module, not a copy
// of its logic.
//
// Run with: node --test
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');

const { settings } = require('../testlib/vscodeShim');

const root = path.join(__dirname, '..');
const win = process.platform === 'win32';

/** Bundles src/tools.ts against the vscode stub and loads it. */
function loadTools() {
	const built = esbuild.buildSync({
		entryPoints: [path.join(root, 'src', 'tools.ts')],
		bundle: true,
		write: false,
		format: 'cjs',
		platform: 'node',
		target: 'node18',
		alias: { vscode: path.join(root, 'testlib', 'vscodeShim.js') },
	});
	const filename = path.join(root, 'src', 'tools.bundle.js');
	const mod = new Module(filename);
	mod.filename = filename;
	mod.paths = Module._nodeModulePaths(path.dirname(filename));
	mod._compile(built.outputFiles[0].text, filename);
	return mod.exports;
}

const tools = loadTools();

/** The error `fn` threw, for asserting on its fields. */
function thrown(fn) {
	try {
		fn();
	} catch (err) {
		return err;
	}
	assert.fail('expected a throw');
}

/** A directory that looks like an NDK to looksLikeNdk: the llvm toolchain
 * the Go Android build calls, plus the version file. */
function makeNdk(dir) {
	fs.mkdirSync(path.join(dir, 'toolchains', 'llvm', 'prebuilt'), { recursive: true });
	fs.writeFileSync(path.join(dir, 'source.properties'), 'Pkg.Revision = 27.0.12077973\n');
	return dir;
}

/** Runs `fn` with a temporary directory and an environment of its own, then
 * puts the environment back. Every search reads process.env and os.homedir()
 * when it is called, and homedir() is USERPROFILE/HOME, so an env swap is
 * enough to move the whole search onto a tree the test built. */
function inSandbox(fn) {
	const saved = { ...process.env };
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goforms-tools-'));
	const empty = path.join(dir, 'empty');
	fs.mkdirSync(empty);
	try {
		// A home with nothing in it, no Android environment variables, and a
		// PATH with no tools on it: whatever this machine has installed must
		// not decide the result.
		for (const name of [
			'ANDROID_NDK_HOME', 'ANDROID_NDK_ROOT', 'ANDROID_NDK', 'NDK_HOME',
			'ANDROID_HOME', 'ANDROID_SDK_ROOT',
		]) {
			delete process.env[name];
		}
		process.env.HOME = path.join(dir, 'home');
		process.env.USERPROFILE = path.join(dir, 'home');
		process.env.LOCALAPPDATA = path.join(dir, 'home', 'AppData', 'Local');
		process.env.PATH = empty;
		// The drive-root locations are relative to SystemDrive, which lets a
		// test put one under its own temporary directory.
		process.env.SystemDrive = dir;
		fs.mkdirSync(process.env.HOME, { recursive: true });
		settings.clear();
		return fn(dir);
	} finally {
		settings.clear();
		for (const key of Object.keys(process.env)) {
			delete process.env[key];
		}
		Object.assign(process.env, saved);
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------------------
// looksLikeNdk
// ---------------------------------------------------------------------------

test('looksLikeNdk wants the toolchain, not just the name', () => {
	inSandbox((dir) => {
		assert.equal(tools.looksLikeNdk(makeNdk(path.join(dir, 'android-ndk-r27d'))), true);

		// The zip half-unpacked, or the wrong folder picked in the dialog.
		const shallow = path.join(dir, 'half');
		fs.mkdirSync(shallow);
		fs.writeFileSync(path.join(shallow, 'source.properties'), 'Pkg.Revision = 27\n');
		assert.equal(tools.looksLikeNdk(shallow), false);

		// The parent of the NDK rather than the NDK.
		assert.equal(tools.looksLikeNdk(dir), false);
		assert.equal(tools.looksLikeNdk(path.join(dir, 'nothing-here')), false);
	});
});

// ---------------------------------------------------------------------------
// sdkRoots
// ---------------------------------------------------------------------------

test('sdkRoots covers an SDK off the drive root, not only the profile', () => {
	inSandbox((dir) => {
		const roots = tools.sdkRoots();
		if (win) {
			// The regression this guards: Android Studio asks where to put
			// the SDK, and C:\Android\Sdk is a common answer - a profile
			// under OneDrive is a bad home for gigabytes of toolchain.
			assert.ok(
				roots.includes(path.join(dir, 'Android', 'Sdk')),
				`drive-root SDK missing from ${roots.join(', ')}`
			);
			assert.ok(roots.includes(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk')));
		} else {
			assert.ok(roots.includes('/opt/android-sdk'), `/opt/android-sdk missing from ${roots.join(', ')}`);
		}
		assert.ok(roots.includes(path.join(process.env.HOME, 'Android', 'Sdk')));
	});
});

test('sdkRoots drops blanks and lists one root once', () => {
	inSandbox((dir) => {
		const sdk = path.join(dir, 'sdk');
		process.env.ANDROID_HOME = sdk;
		process.env.ANDROID_SDK_ROOT = sdk;
		const roots = tools.sdkRoots();
		assert.equal(roots.filter((r) => r === sdk).length, 1);
		assert.ok(!roots.some((r) => r.trim() === ''));
	});
});

// ---------------------------------------------------------------------------
// findNdk
// ---------------------------------------------------------------------------

test('findNdk takes the newest version under an SDK', () => {
	inSandbox((dir) => {
		const sdk = path.join(dir, 'sdk');
		makeNdk(path.join(sdk, 'ndk', '26.3.11579264'));
		const newest = makeNdk(path.join(sdk, 'ndk', '27.0.12077973'));
		// 9 would win a plain string sort; it must not.
		makeNdk(path.join(sdk, 'ndk', '9.0.0'));
		process.env.ANDROID_HOME = sdk;

		assert.equal(tools.findNdk().path, newest);
	});
});

test('findNdk finds an SDK installed off the drive root', { skip: win ? false : 'Windows-only layout' }, () => {
	inSandbox((dir) => {
		const ndk = makeNdk(path.join(dir, 'Android', 'Sdk', 'ndk', '27.0.12077973'));
		assert.equal(tools.findNdk().path, ndk);
	});
});

test('findNdk finds a hand-unpacked download beside the profile', () => {
	inSandbox((dir) => {
		const ndk = makeNdk(path.join(process.env.HOME, 'Android', 'android-ndk-r27d'));
		assert.equal(tools.findNdk().path, ndk);
	});
});

test('findNdk prefers the setting, then the environment, then the SDK', () => {
	inSandbox((dir) => {
		const sdk = path.join(dir, 'sdk');
		makeNdk(path.join(sdk, 'ndk', '27.0.12077973'));
		process.env.ANDROID_HOME = sdk;
		const fromEnv = makeNdk(path.join(dir, 'env-ndk'));
		process.env.ANDROID_NDK_HOME = fromEnv;
		const configured = makeNdk(path.join(dir, 'configured-ndk'));

		assert.equal(tools.findNdk().path, fromEnv);

		settings.set('goforms.androidNdkPath', configured);
		assert.equal(tools.findNdk().path, configured);

		// A setting pointing at something that is not an NDK is not fatal:
		// the search carries on, and says it tried.
		settings.set('goforms.androidNdkPath', path.join(dir, 'gone'));
		const found = tools.findNdk();
		assert.equal(found.path, fromEnv);
		assert.ok(found.searched.some((s) => s.includes('goforms.androidNdkPath')));
	});
});

test('findNdk reports where it looked when there is nothing to find', () => {
	inSandbox((dir) => {
		const sdk = path.join(dir, 'sdk');
		fs.mkdirSync(sdk, { recursive: true });
		process.env.ANDROID_HOME = sdk;

		const err = thrown(() => tools.findNdk());
		assert.ok(err instanceof tools.ToolNotFoundError);
		assert.equal(err.tool, 'ndk');
		assert.ok(err.searched.length > 0);
		assert.ok(
			err.searched.some((s) => s.includes(path.join(sdk, 'ndk'))),
			`the SDK was not named in: ${err.searched.join(', ')}`
		);
		// The message is what the user is shown; it has to carry the list.
		assert.ok(err.message.includes(path.join(sdk, 'ndk')));
	});
});

// ---------------------------------------------------------------------------
// findAdb
// ---------------------------------------------------------------------------

test('findAdb looks under platform-tools of every SDK root', () => {
	inSandbox((dir) => {
		const err = thrown(() => tools.findAdb());
		assert.ok(err instanceof tools.ToolNotFoundError);
		assert.equal(err.tool, 'adb');
		assert.equal(err.searched[0], 'PATH');
		const adb = win ? 'adb.exe' : 'adb';
		const expected = win
			? path.join(dir, 'Android', 'Sdk', 'platform-tools', adb)
			: path.join('/opt/android-sdk', 'platform-tools', adb);
		assert.ok(
			err.searched.includes(expected),
			`${expected} was not searched; looked in ${err.searched.join(', ')}`
		);
	});
});
