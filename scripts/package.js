const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { packager } = require('@electron/packager');
const {
  APP_NAME,
  parseTarget,
  binaryName,
  buildDirectory,
  sourceBinary,
  readLibrespotManifest,
  requireNativeHost
} = require('./platform');

const projectRoot = path.resolve(__dirname, '..');
const target = parseTarget();
requireNativeHost(target);

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function verifyNativePlaybackEngine() {
  const binaryPath = sourceBinary(projectRoot, target);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`Missing ${target.key} playback engine: ${binaryPath}. Run npm run build:librespot on this host.`);
  }
  if (target.platform !== 'win32') fs.accessSync(binaryPath, fs.constants.X_OK);
  const { manifest } = readLibrespotManifest(projectRoot);
  const expectedHash = manifest.targets[target.key];
  if (!/^[A-F0-9]{64}$/.test(expectedHash || '')) {
    throw new Error(`No checksum is registered for ${target.key}. Run npm run build:librespot.`);
  }
  const actualHash = sha256(binaryPath);
  if (actualHash !== expectedHash) {
    throw new Error(`The ${target.key} playback engine does not match librespot-checksums.json.`);
  }
  const version = spawnSync(binaryPath, ['--version'], {
    cwd: path.dirname(binaryPath),
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true
  });
  if (version.error || version.status !== 0 || !`${version.stdout}${version.stderr}`.includes('librespot 0.8.0')) {
    throw new Error(`The ${target.key} playback engine failed its version check.`);
  }
  return { binaryPath, expectedHash };
}

function platformIcon() {
  if (target.platform === 'linux') return undefined;
  const iconPath = path.join(projectRoot, target.platform === 'win32' ? 'app-icon.ico' : 'app-icon.icns');
  if (!fs.existsSync(iconPath)) {
    throw new Error(`Missing ${path.basename(iconPath)}. Run npm run icon on ${target.platform}.`);
  }
  return iconPath;
}

(async () => {
  const playback = verifyNativePlaybackEngine();
  const nativeBinaryName = binaryName(target.platform);
  const ignoredSourceBinary = target.platform === 'win32' ? /^\/librespot$/ : /^\/librespot\.exe$/;
  const outputRoot = buildDirectory(projectRoot, target);
  const outputPaths = await packager({
    dir: projectRoot,
    name: APP_NAME,
    executableName: APP_NAME,
    platform: target.platform,
    arch: target.arch,
    out: path.join(projectRoot, 'dist'),
    overwrite: true,
    prune: true,
    icon: platformIcon(),
    appBundleId: 'io.github.cozyfi.desktop',
    appCategoryType: target.platform === 'darwin' ? 'public.app-category.music' : undefined,
    darwinDarkModeSupport: target.platform === 'darwin',
    win32metadata: target.platform === 'win32' ? {
      CompanyName: 'Cozy-Fi contributors',
      FileDescription: 'Cozy-Fi desktop music companion',
      ProductName: APP_NAME,
      InternalName: APP_NAME,
      OriginalFilename: `${APP_NAME}.exe`,
      'requested-execution-level': 'asInvoker'
    } : undefined,
    asar: { unpack: `**/${nativeBinaryName}` },
    ignore: [
      /^\/(?:dist|\.chrome_profile|\.github|scripts|patches)(?:\/|$)/,
      /^\/(?:task\.md|walkthrough\.md|styles\.css|package-lock\.json)$/,
      /^\/app-icon\.(?:ico|icns)$/,
      ignoredSourceBinary
    ]
  });

  if (!outputPaths.includes(outputRoot) || !fs.existsSync(outputRoot)) {
    throw new Error(`Packager did not create the expected output: ${outputRoot}`);
  }
  console.log(JSON.stringify({
    ok: true,
    target: target.key,
    outputRoot,
    playbackSha256: playback.expectedHash
  }));
})().catch(error => {
  console.error(`PACKAGE_ERROR ${error.message}`);
  process.exitCode = 1;
});
