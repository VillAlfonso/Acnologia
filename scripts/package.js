import { packager } from '@electron/packager';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = await packager({
  dir: root, name: 'BrowserAuto', platform: 'win32', arch: 'x64',
  // Never overwrite a running app; each build gets its own launchable folder.
  out: path.join(root, 'dist', `build-${new Date().toISOString().replace(/[:.]/g, '-')}`), overwrite: false, asar: true,
  ignore: [/^\/(data|dist|test|test-results|scripts|\.git)(\/|$)/, /\.lnk$/],
});
for (const folder of output) console.log(`Desktop application: ${path.join(folder, 'BrowserAuto.exe')}`);
