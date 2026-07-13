import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

const buildResult = await build({
	entryPoints: ['src/services/settings-coordinator.ts'],
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node20',
	write: false,
});
const bundledSource = buildResult.outputFiles[0]?.text;
if (!bundledSource) throw new Error('Settings coordinator test bundle was not generated.');
const bundleUrl = `data:text/javascript;base64,${Buffer.from(bundledSource).toString('base64')}`;
const { SettingsCoordinator } = await import(bundleUrl);

const timerWindow = {
	setTimeout: (...args) => setTimeout(...args),
	clearTimeout: (timer) => clearTimeout(timer),
};

function deferred() {
	let resolve;
	const promise = new Promise((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

test('coalesces a burst into the latest settings snapshot', async () => {
	const persisted = [];
	const applied = [];
	const coordinator = new SettingsCoordinator(
		10_000,
		async (value) => persisted.push(value),
		async (value) => applied.push(value),
		() => assert.fail('Unexpected settings error'),
		timerWindow,
	);

	coordinator.schedule({ heading: 's' });
	coordinator.schedule({ heading: 'so' });
	coordinator.schedule({ heading: 'soliloquy' });
	await coordinator.flush();

	assert.deepEqual(persisted, [{ heading: 'soliloquy' }]);
	assert.deepEqual(applied, [{ heading: 'soliloquy' }]);
});

test('serializes writes and skips applying a stale saved snapshot', async () => {
	const firstWrite = deferred();
	const persisted = [];
	const applied = [];
	let activeWrites = 0;
	let maximumActiveWrites = 0;
	const coordinator = new SettingsCoordinator(
		10_000,
		async (value) => {
			activeWrites += 1;
			maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
			persisted.push(value);
			if (value.heading === 'first') await firstWrite.promise;
			activeWrites -= 1;
		},
		async (value) => applied.push(value),
		() => assert.fail('Unexpected settings error'),
		timerWindow,
	);

	coordinator.schedule({ heading: 'first' });
	const firstFlush = coordinator.flush();
	await Promise.resolve();
	coordinator.schedule({ heading: 'latest' });
	const latestFlush = coordinator.flush();
	firstWrite.resolve();
	await Promise.all([firstFlush, latestFlush]);

	assert.equal(maximumActiveWrites, 1);
	assert.deepEqual(persisted, [{ heading: 'first' }, { heading: 'latest' }]);
	assert.deepEqual(applied, [{ heading: 'latest' }]);
});
