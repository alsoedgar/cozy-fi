const fs = require('fs');
const path = require('path');

const APP_NAME = 'Cozy-Fi';
const SUPPORTED_PLATFORMS = new Set(['win32', 'darwin', 'linux']);
const SUPPORTED_ARCHITECTURES = new Set(['x64', 'arm64']);

function readOption(args, name, fallback) {
  const equalsPrefix = `--${name}=`;
  const equalsValue = args.find(argument => argument.startsWith(equalsPrefix));
  if (equalsValue) return equalsValue.slice(equalsPrefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function parseTarget(args = process.argv.slice(2), defaults = {}) {
  const platform = readOption(args, 'platform', defaults.platform || process.platform);
  const arch = readOption(args, 'arch', defaults.arch || process.arch);
  if (!SUPPORTED_PLATFORMS.has(platform)) {
    throw new Error(`Unsupported platform "${platform}". Use win32, darwin, or linux.`);
  }
  if (!SUPPORTED_ARCHITECTURES.has(arch)) {
    throw new Error(`Unsupported architecture "${arch}". Use x64 or arm64.`);
  }
  return { platform, arch, key: `${platform}-${arch}` };
}

function binaryName(platform) {
  return platform === 'win32' ? 'librespot.exe' : 'librespot';
}

function buildDirectory(projectRoot, target) {
  return path.join(projectRoot, 'dist', `${APP_NAME}-${target.platform}-${target.arch}`);
}

function resourcesDirectory(projectRoot, target) {
  const root = buildDirectory(projectRoot, target);
  return target.platform === 'darwin'
    ? path.join(root, `${APP_NAME}.app`, 'Contents', 'Resources')
    : path.join(root, 'resources');
}

function packagedExecutable(projectRoot, target) {
  const root = buildDirectory(projectRoot, target);
  if (target.platform === 'win32') return path.join(root, `${APP_NAME}.exe`);
  if (target.platform === 'darwin') return path.join(root, `${APP_NAME}.app`, 'Contents', 'MacOS', APP_NAME);
  return path.join(root, APP_NAME);
}

function sourceBinary(projectRoot, target) {
  return path.join(projectRoot, binaryName(target.platform));
}

function readLibrespotManifest(projectRoot) {
  const manifestPath = path.join(projectRoot, 'librespot-checksums.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || typeof manifest.targets !== 'object') {
    throw new Error('Invalid librespot-checksums.json manifest.');
  }
  return { manifest, manifestPath };
}

function requireNativeHost(target) {
  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error(
      `Cozy-Fi packages a native playback engine. Build ${target.key} on a matching ${target.platform}/${target.arch} host ` +
      `(current host: ${process.platform}-${process.arch}).`
    );
  }
}

module.exports = {
  APP_NAME,
  SUPPORTED_PLATFORMS,
  SUPPORTED_ARCHITECTURES,
  parseTarget,
  binaryName,
  buildDirectory,
  resourcesDirectory,
  packagedExecutable,
  sourceBinary,
  readLibrespotManifest,
  requireNativeHost
};
