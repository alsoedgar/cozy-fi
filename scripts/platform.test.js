const assert = require('node:assert/strict');
const path = require('node:path');
const {
  APP_NAME,
  parseTarget,
  binaryName,
  buildDirectory,
  resourcesDirectory,
  packagedExecutable,
  requireNativeHost
} = require('./platform');

const projectRoot = path.resolve('cozy-fi-platform-test');
const cases = [
  { platform: 'win32', arch: 'x64', binary: 'librespot.exe' },
  { platform: 'darwin', arch: 'x64', binary: 'librespot' },
  { platform: 'darwin', arch: 'arm64', binary: 'librespot' },
  { platform: 'linux', arch: 'x64', binary: 'librespot' }
];

for (const expected of cases) {
  const target = parseTarget([
    '--platform', expected.platform,
    `--arch=${expected.arch}`
  ]);
  assert.deepEqual(target, {
    platform: expected.platform,
    arch: expected.arch,
    key: `${expected.platform}-${expected.arch}`
  });
  assert.equal(binaryName(target.platform), expected.binary);
  assert.equal(
    path.basename(buildDirectory(projectRoot, target)),
    `${APP_NAME}-${target.platform}-${target.arch}`
  );

  const resources = resourcesDirectory(projectRoot, target);
  const executable = packagedExecutable(projectRoot, target);
  if (target.platform === 'darwin') {
    assert.equal(path.basename(resources), 'Resources');
    assert.equal(path.basename(path.dirname(resources)), 'Contents');
    assert.equal(path.basename(executable), APP_NAME);
    assert.equal(path.basename(path.dirname(path.dirname(executable))), 'Contents');
  } else {
    assert.equal(path.basename(resources), 'resources');
    assert.equal(path.basename(executable), target.platform === 'win32' ? `${APP_NAME}.exe` : APP_NAME);
  }
}

assert.throws(() => parseTarget(['--platform=plan9']), /Unsupported platform/);
assert.throws(() => parseTarget(['--arch=ia32']), /Unsupported architecture/);
requireNativeHost({ platform: process.platform, arch: process.arch, key: `${process.platform}-${process.arch}` });
const foreignPlatform = process.platform === 'linux' ? 'win32' : 'linux';
assert.throws(
  () => requireNativeHost({ platform: foreignPlatform, arch: process.arch, key: `${foreignPlatform}-${process.arch}` }),
  /matching/
);

console.log(`Platform path checks passed on ${process.platform}-${process.arch}.`);
