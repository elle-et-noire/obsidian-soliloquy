import { readFile } from 'node:fs/promises';

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const expectedVersion = process.argv[2];
const [packageJson, packageLock, manifest, versions] = await Promise.all([
	readJson('package.json'),
	readJson('package-lock.json'),
	readJson('manifest.json'),
	readJson('versions.json'),
]);

const packageVersion = packageJson.version;
const manifestVersion = manifest.version;
const lockVersion = packageLock.version;
const lockPackageVersion = packageLock.packages?.['']?.version;
const minAppVersion = manifest.minAppVersion;
const errors = [];

checkSemver('package.json version', packageVersion, errors);
checkSemver('manifest.json minAppVersion', minAppVersion, errors);
checkEqual('manifest.json version', manifestVersion, packageVersion, errors);
checkEqual('package-lock.json version', lockVersion, packageVersion, errors);
checkEqual('package-lock.json root package version', lockPackageVersion, packageVersion, errors);

if (typeof packageVersion === 'string') {
	if (!Object.hasOwn(versions, packageVersion)) {
		errors.push(`versions.json does not contain an entry for ${packageVersion}.`);
	} else {
		checkEqual(
			`versions.json[${JSON.stringify(packageVersion)}]`,
			versions[packageVersion],
			minAppVersion,
			errors,
		);
	}
}

for (const [version, minimumVersion] of Object.entries(versions)) {
	checkSemver(`versions.json key ${JSON.stringify(version)}`, version, errors);
	checkSemver(`versions.json value for ${JSON.stringify(version)}`, minimumVersion, errors);
}

if (expectedVersion !== undefined) {
	checkSemver('release tag', expectedVersion, errors);
	checkEqual('release tag', expectedVersion, packageVersion, errors);
}

if (errors.length > 0) {
	process.stderr.write(`Release version validation failed:\n${errors.map((error) => `- ${error}`).join('\n')}\n`);
	process.exitCode = 1;
} else {
	const tagMessage = expectedVersion === undefined ? '' : ` and release tag ${expectedVersion}`;
	process.stdout.write(`Validated release metadata for ${packageVersion}${tagMessage}.\n`);
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, 'utf8'));
	} catch (error) {
		throw new Error(`Could not read ${path}.`, { cause: error });
	}
}

function checkSemver(label, value, errors) {
	if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
		errors.push(`${label} must be a valid Semantic Version without a leading "v"; received ${JSON.stringify(value)}.`);
	}
}

function checkEqual(label, actual, expected, errors) {
	if (actual !== expected) {
		errors.push(`${label} must be ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}.`);
	}
}
