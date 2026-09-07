const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWindowsInstaller } = require('electron-winstaller');
const {
  APP_NAME,
  parseTarget,
  buildDirectory,
  packagedExecutable,
  requireNativeHost
} = require('./platform');

const projectRoot = path.resolve(__dirname, '..');
const target = parseTarget();
if (target.platform !== 'win32') throw new Error('The Windows installer can only be built for win32 targets.');
requireNativeHost(target);

const appDirectory = buildDirectory(projectRoot, target);
const appExecutable = packagedExecutable(projectRoot, target);
const outputDirectory = path.join(projectRoot, 'dist', `installer-${target.platform}-${target.arch}`);
const iconPath = path.join(projectRoot, 'app-icon.ico');
const installerPackage = path.join(projectRoot, 'node_modules', 'electron-winstaller');
const vendorDirectory = path.join(installerPackage, 'vendor');
const hostArch = os.arch() === 'arm64' ? 'arm64' : 'x64';

function ensureSevenZip() {
  for (const extension of ['exe', 'dll']) {
    const selected = path.join(vendorDirectory, `7z-${hostArch}.${extension}`);
    const destination = path.join(vendorDirectory, `7z.${extension}`);
    if (!fs.existsSync(selected)) throw new Error(`electron-winstaller is missing vendor/7z-${hostArch}.${extension}. Run npm ci again.`);
    fs.copyFileSync(selected, destination);
  }
}

if (!fs.existsSync(appExecutable)) {
  throw new Error(`Missing packaged app: ${appExecutable}. Run npm run dist:windows first.`);
}
if (!fs.existsSync(iconPath)) throw new Error(`Missing ${iconPath}. Run npm run icon first.`);
ensureSevenZip();

(async () => {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
  await createWindowsInstaller({
    appDirectory,
    outputDirectory,
    authors: 'Cozy-Fi contributors',
    owners: 'Cozy-Fi contributors',
    exe: `${APP_NAME}.exe`,
    name: 'cozy-fi',
    title: APP_NAME,
    description: 'A cross-platform retro-cozy companion player for Spotify Premium.',
    setupExe: 'Cozy-Fi-Setup.exe',
    setupIcon: iconPath,
    iconUrl: 'https://raw.githubusercontent.com/alsoedgar/cozy-fi/main/app-icon.ico',
    noMsi: true,
    noDelta: true,
    fixUpPaths: true,
    skipUpdateIcon: true
  });
  const setupPath = path.join(outputDirectory, 'Cozy-Fi-Setup.exe');
  if (!fs.existsSync(setupPath)) throw new Error(`Installer generation did not create ${setupPath}.`);
  console.log(JSON.stringify({ ok: true, target: target.key, setupPath }));
})().catch(error => {
  console.error(`INSTALLER_ERROR ${error.message}`);
  process.exitCode = 1;
});
