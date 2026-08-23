const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  parseTarget,
  binaryName,
  sourceBinary,
  readLibrespotManifest,
  requireNativeHost
} = require('./platform');

const EXPECTED_COMMIT = 'd36f9f1907e8cc9d68a93f8ebc6b627b1bf7267d';
const SOURCE_DATE_EPOCH = '1762793321';
const LIBRESPOT_TAG = 'v0.8.0';
const projectRoot = path.resolve(__dirname, '..');
const target = parseTarget();
requireNativeHost(target);

function readArgument(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.slice(2).find(argument => argument.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || projectRoot,
    env: options.env || process.env,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
    throw new Error(`${command} exited with code ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? `${result.stdout || ''}${result.stderr || ''}`.trim() : '';
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function safeRemoveBuildDirectory(buildRoot) {
  if (!fs.existsSync(buildRoot)) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(buildRoot);
  const validParent = path.dirname(resolved) === tempRoot;
  const validName = path.basename(resolved).startsWith('cozy-fi-librespot-build-');
  if (!validParent || !validName) {
    throw new Error(`Refusing to remove unexpected build directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function updateChecksumManifest(outputPath, hash) {
  const defaultOutput = path.resolve(sourceBinary(projectRoot, target));
  if (path.resolve(outputPath) !== defaultOutput) return;
  const { manifest, manifestPath } = readLibrespotManifest(projectRoot);
  if (manifest.sourceCommit !== EXPECTED_COMMIT || manifest.librespotVersion !== '0.8.0') {
    throw new Error('The playback checksum manifest does not match the pinned librespot source.');
  }
  manifest.targets[target.key] = hash;
  manifest.targets = Object.fromEntries(Object.entries(manifest.targets).sort(([left], [right]) => left.localeCompare(right)));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

const requestedOutput = readArgument('output');
const outputPath = path.resolve(requestedOutput || sourceBinary(projectRoot, target));
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cozy-fi-librespot-build-'));

try {
  run('git', ['clone', '--quiet', '--depth', '1', '--branch', LIBRESPOT_TAG, 'https://github.com/librespot-org/librespot.git', buildRoot]);
  const actualCommit = run('git', ['-C', buildRoot, 'rev-parse', 'HEAD'], { capture: true });
  if (actualCommit !== EXPECTED_COMMIT) throw new Error(`Unexpected ${LIBRESPOT_TAG} commit: ${actualCommit}`);
  const actualCommitEpoch = run('git', ['-C', buildRoot, 'show', '-s', '--format=%ct', 'HEAD'], { capture: true });
  if (actualCommitEpoch !== SOURCE_DATE_EPOCH) throw new Error(`Unexpected source timestamp: ${actualCommitEpoch}`);

  const patchPath = path.join(projectRoot, 'patches', 'librespot-cozy-fi.patch');
  run('git', ['-C', buildRoot, 'apply', '--check', patchPath]);
  run('git', ['-C', buildRoot, 'apply', patchPath]);

  const buildEnvironment = { ...process.env, SOURCE_DATE_EPOCH };
  delete buildEnvironment.CARGO_BUILD_TARGET;
  run('cargo', ['build', '--manifest-path', path.join(buildRoot, 'Cargo.toml'), '--release', '--locked'], {
    cwd: buildRoot,
    env: buildEnvironment
  });

  const builtBinary = path.join(buildRoot, 'target', 'release', binaryName(target.platform));
  if (!fs.existsSync(builtBinary)) throw new Error(`Cargo did not produce ${builtBinary}.`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.copyFileSync(builtBinary, outputPath);
  if (target.platform !== 'win32') fs.chmodSync(outputPath, 0o755);

  const versionOutput = run(outputPath, ['--version'], { capture: true, cwd: path.dirname(outputPath) });
  if (!versionOutput.includes('librespot 0.8.0')) throw new Error(`Unexpected playback engine version: ${versionOutput}`);
  const hash = sha256(outputPath);
  updateChecksumManifest(outputPath, hash);
  console.log(JSON.stringify({ ok: true, target: target.key, outputPath, version: versionOutput, sha256: hash }));
} finally {
  safeRemoveBuildDirectory(buildRoot);
}
