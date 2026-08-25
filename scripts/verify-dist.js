const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');
const {
  parseTarget,
  binaryName,
  buildDirectory,
  resourcesDirectory,
  packagedExecutable,
  sourceBinary,
  readLibrespotManifest,
  requireNativeHost
} = require('./platform');

const projectRoot = path.resolve(__dirname, '..');
const target = parseTarget();
requireNativeHost(target);
const buildRoot = buildDirectory(projectRoot, target);
const resourcesRoot = resourcesDirectory(projectRoot, target);
const asarPath = path.join(resourcesRoot, 'app.asar');
const packagedLibrespot = path.join(resourcesRoot, 'app.asar.unpacked', binaryName(target.platform));
const sourceLibrespot = sourceBinary(projectRoot, target);
const packagedApp = packagedExecutable(projectRoot, target);
const { manifest } = readLibrespotManifest(projectRoot);
const expectedLibrespotSha256 = manifest.targets[target.key];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

(async () => {
  assert(/^[A-F0-9]{64}$/.test(expectedLibrespotSha256 || ''), `No checksum is registered for ${target.key}.`);
  for (const requiredPath of [buildRoot, packagedApp, asarPath, sourceLibrespot, packagedLibrespot]) {
    assert(fs.existsSync(requiredPath), `Missing release file: ${requiredPath}`);
  }
  if (target.platform !== 'win32') {
    fs.accessSync(packagedApp, fs.constants.X_OK);
    fs.accessSync(packagedLibrespot, fs.constants.X_OK);
  }

  const sourceHash = sha256(sourceLibrespot);
  const packagedHash = sha256(packagedLibrespot);
  assert(sourceHash === expectedLibrespotSha256, `Source ${target.key} librespot checksum is not registered.`);
  assert(packagedHash === sourceHash, 'Packaged librespot differs from the verified source binary.');

  const packagerEntry = require.resolve('@electron/packager');
  const asarModulePath = require.resolve('@electron/asar', { paths: [path.dirname(packagerEntry)] });
  const asar = await import(pathToFileURL(asarModulePath).href);
  const entries = asar.listPackage(asarPath).map(entry => entry.replaceAll('\\', '/'));
  for (const forbidden of [
    '/.chrome_profile/', '/.github/', '/scripts/', '/patches/', '/task.md',
    '/walkthrough.md', '/styles.css', '/dist/', '/package-lock.json'
  ]) {
    assert(!entries.some(entry => entry.includes(forbidden)), `Forbidden release content found: ${forbidden}`);
  }
  for (const required of [
    '/main.js', '/preload.js', '/mini-player.html', '/mini-player.css',
    '/js/mini-player.js', '/js/playback-context.js', '/js/lyrics.js', '/librespot-checksums.json', '/README.md',
    '/PRIVACY.md', '/THIRD_PARTY_NOTICES.md'
  ]) {
    assert(entries.includes(required), `Required packaged file missing: ${required}`);
  }
  const packagedMainHash = crypto.createHash('sha256').update(asar.extractFile(asarPath, 'main.js')).digest('hex');
  assert(packagedMainHash === sha256(path.join(projectRoot, 'main.js')).toLowerCase(), 'Packaged main.js is stale.');
  const packagedManifest = JSON.parse(asar.extractFile(asarPath, 'librespot-checksums.json').toString('utf8'));
  assert(packagedManifest.targets?.[target.key] === expectedLibrespotSha256, 'Packaged playback checksum manifest is stale.');

  const librespotVersion = spawnSync(packagedLibrespot, ['--version'], {
    cwd: path.dirname(packagedLibrespot),
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true
  });
  assert(librespotVersion.status === 0, `Packaged librespot failed to start: ${librespotVersion.error || librespotVersion.stderr}`);
  assert(`${librespotVersion.stdout}${librespotVersion.stderr}`.includes('librespot 0.8.0'), 'Unexpected librespot version.');

  const smokeArgs = ['--smoke-test'];
  if (target.platform === 'linux') smokeArgs.unshift('--no-sandbox');
  const smoke = spawnSync(packagedApp, smokeArgs, {
    cwd: path.dirname(packagedApp),
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true
  });
  assert(smoke.status === 0, `Packaged Cozy-Fi smoke test failed: ${smoke.error || smoke.stderr || smoke.stdout || smoke.status}`);

  console.log(JSON.stringify({
    ok: true,
    target: target.key,
    packagedApp,
    librespotVersion: `${librespotVersion.stdout}${librespotVersion.stderr}`.trim(),
    librespotSha256: packagedHash,
    asarEntries: entries.length
  }));
})().catch(error => {
  console.error(`DIST_VERIFY_ERROR ${error.message}`);
  process.exitCode = 1;
});
