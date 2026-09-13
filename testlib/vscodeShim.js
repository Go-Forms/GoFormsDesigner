// A stand-in for the `vscode` module, so extension-host code can be loaded
// by `node --test`.
//
// Only the surface the module under test actually touches is here: reading a
// setting. Tests set one with `settings.set('goforms.androidNdkPath', ...)`.
//
// The map hangs off globalThis because the code under test is bundled with
// this file inlined, which makes the bundle's copy a different module
// instance from the one a test requires. One map behind both copies is what
// lets a test set a value the bundle then reads.
const settings = (globalThis.__vscodeShimSettings ??= new Map());

function getConfiguration(section) {
	return {
		get(key, fallback) {
			const value = settings.get(`${section}.${key}`);
			return value === undefined ? fallback : value;
		},
	};
}

module.exports = {
	settings,
	workspace: { getConfiguration },
};
