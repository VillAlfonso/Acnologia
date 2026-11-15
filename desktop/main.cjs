const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.setName('BrowserAuto');
let mainWindow, backend, monitorProcess, monitorPid, monitorLogPath, monitorScriptPath, quitting = false;

function openMonitor() {
  if (process.env.BROWSERAUTO_MONITOR_DISABLED === '1' || process.platform !== 'win32') return;
  if (monitorPid) { try { process.kill(monitorPid, 0); return; } catch { monitorPid = null; } }
  if (monitorProcess && monitorProcess.exitCode === null) return;
  const quote = value => "'" + value.replaceAll("'", "''") + "'";
  const args = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', `"${monitorScriptPath}"`, '-LogPath', `"${monitorLogPath}"`, '-ParentProcessId', String(process.pid)];
  const command = `(Start-Process -FilePath powershell.exe -ArgumentList @(${args.map(quote).join(',')}) -WindowStyle Normal -PassThru).Id`;
  monitorProcess = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  monitorProcess.stdout.on('data', chunk => { output += chunk; });
  monitorProcess.stderr.on('data', chunk => fs.appendFileSync(monitorLogPath, `${new Date().toISOString()} [ERROR] [monitor] ${chunk.toString().replace(/[\r\n]+/g, ' ')}\n`));
  monitorProcess.once('exit', () => { const pid = Number(output.trim()); if (Number.isInteger(pid) && pid > 0) monitorPid = pid; });
  monitorProcess.on('error', error => { fs.appendFileSync(monitorLogPath, `${new Date().toISOString()} [ERROR] [desktop] Monitor could not open: ${error.message}\n`); });
  monitorProcess.unref();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); openMonitor(); } });
  app.whenReady().then(start).catch(error => { dialog.showErrorBox('BrowserAuto could not start', error.message); app.quit(); });
}
async function start() {
  const root = path.resolve(__dirname, '..');
  const dataDir = process.env.BROWSERAUTO_DATA_DIR || (app.isPackaged ? path.join(app.getPath('userData'), 'data') : path.join(root, 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  monitorLogPath = path.join(dataDir, 'monitor.log');
  monitorScriptPath = path.join(dataDir, 'monitor.ps1');
  fs.writeFileSync(monitorScriptPath, fs.readFileSync(path.join(__dirname, 'monitor.ps1')));
  fs.appendFileSync(monitorLogPath, `${new Date().toISOString()} [INFO] [desktop] Starting BrowserAuto\n`);
  openMonitor();
  const log = fs.createWriteStream(path.join(dataDir, 'desktop-backend.log'), { flags: 'a' });
  backend = fork(path.join(root, 'server.js'), [], { cwd: app.isPackaged ? path.dirname(app.getPath('exe')) : root, silent: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: '0', BROWSERAUTO_DATA_DIR: dataDir } });
  backend.stdout.pipe(log); backend.stderr.pipe(log);
  backend.stderr.on('data', chunk => {
    const message = chunk.toString().replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/[\r\n]+/g, ' ').slice(0, 2500);
    fs.appendFileSync(monitorLogPath, `${new Date().toISOString()} [ERROR] [backend] ${message}\n`);
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The backend did not start within 20 seconds. See desktop-backend.log.')), 20000);
    backend.once('error', error => { clearTimeout(timeout); reject(error); });
    backend.once('exit', code => { clearTimeout(timeout); reject(new Error(`Backend exited (${code}). See desktop-backend.log in ${dataDir}.`)); });
    backend.on('message', message => { if (message?.type === 'ready') { clearTimeout(timeout); resolve(message.baseUrl); } });
  });
  mainWindow = new BrowserWindow({ title: 'BrowserAuto — Capture Builder', width: 1250, height: 850, minWidth: 900, minHeight: 600, backgroundColor: '#f0f0f0', show: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  const command = name => mainWindow?.webContents.send('menu-command', name);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'New workflow', accelerator: 'CmdOrCtrl+N', click: () => command('new') },
      { label: 'Save workflow', accelerator: 'CmdOrCtrl+S', click: () => command('save') },
      { type: 'separator' }, { label: 'Import JSON…', accelerator: 'CmdOrCtrl+O', click: () => command('import') },
      { label: 'Export JSON…', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('export') },
      { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Capture', submenu: [
      { label: 'Start recording…', accelerator: 'CmdOrCtrl+R', click: () => command('record') },
      { label: 'Pause / resume', accelerator: 'F8', click: () => command('pause') },
      { label: 'Stop and save', accelerator: 'CmdOrCtrl+Shift+R', click: () => command('stop') },
    ] },
    { label: 'View', submenu: [ { label: 'Builder', click: () => command('builder') }, { label: 'Run history', click: () => command('runs') }, { label: 'Live monitor', click: openMonitor }, { type: 'separator' }, { role: 'toggleDevTools' } ] },
    { label: 'Help', submenu: [ { label: 'Quick start', click: () => command('help') }, { label: 'Open data folder', click: () => shell.openPath(dataDir) } ] },
  ]));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${baseUrl}/`)) { event.preventDefault(); openExternal(url); } });
  mainWindow.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(false));
  ipcMain.on('renderer-ready', event => { if (event.sender === mainWindow?.webContents) mainWindow.show(); });
  backend.on('exit', code => { fs.appendFileSync(monitorLogPath, `${new Date().toISOString()} [INFO] [desktop] Backend exited (${code})\n`); if (!quitting) { dialog.showErrorBox('Automation backend stopped', `The backend exited (${code}). Close and reopen BrowserAuto to restart it.`); app.quit(); } });
  await mainWindow.loadURL(baseUrl);
  mainWindow.show();
}
function openExternal(url) { try { if (['http:', 'https:'].includes(new URL(url).protocol)) shell.openExternal(url); } catch {} }
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting || !backend || backend.exitCode !== null) return;
  event.preventDefault(); quitting = true;
  const timeout = setTimeout(() => { backend.kill(); app.quit(); }, 6000);
  backend.once('exit', () => { clearTimeout(timeout); app.quit(); });
  if (backend.connected) backend.send({ type: 'shutdown' }); else backend.kill();
});
