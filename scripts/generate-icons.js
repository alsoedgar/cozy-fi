const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const logoPath = path.join(projectRoot, 'logo.png');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with code ${result.status}.`);
}

function safeRemoveIconDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('cozy-fi-icon-')) {
    throw new Error(`Refusing to remove unexpected icon directory: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

if (!fs.existsSync(logoPath)) throw new Error(`Missing icon source: ${logoPath}`);

if (process.platform === 'win32') {
  run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', path.join('scripts', 'generate-icon.ps1'),
    '-Source', 'logo.png',
    '-Output', 'app-icon.ico'
  ]);
} else if (process.platform === 'darwin') {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cozy-fi-icon-'));
  const iconsetPath = path.join(tempRoot, 'app.iconset');
  try {
    fs.mkdirSync(iconsetPath);
    const variants = [
      ['icon_16x16.png', 16], ['icon_16x16@2x.png', 32],
      ['icon_32x32.png', 32], ['icon_32x32@2x.png', 64],
      ['icon_128x128.png', 128], ['icon_128x128@2x.png', 256],
      ['icon_256x256.png', 256], ['icon_256x256@2x.png', 512],
      ['icon_512x512.png', 512], ['icon_512x512@2x.png', 1024]
    ];
    for (const [fileName, size] of variants) {
      run('sips', ['-z', String(size), String(size), logoPath, '--out', path.join(iconsetPath, fileName)]);
    }
    run('iconutil', ['-c', 'icns', iconsetPath, '-o', path.join(projectRoot, 'app-icon.icns')]);
  } finally {
    safeRemoveIconDirectory(tempRoot);
  }
} else if (process.platform === 'linux') {
  console.log('Linux uses logo.png directly for BrowserWindow and dock/task-list icons.');
} else {
  throw new Error(`Unsupported icon platform: ${process.platform}`);
}
