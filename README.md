# BrowserAuto — Desktop Capture Builder

A Windows desktop application with a compact, Windows Forms–style interface. The Electron front end starts a separate Node.js automation backend; recording opens a real installed browser. There is no hosted website or cloud service.

## Open the app

Double-click **`BrowserAuto.exe`** in the newest `dist/build-…/BrowserAuto-win32-x64/` folder. Keep the accompanying files in that folder together. Each build gets a new folder so updates never overwrite a running application. This build does not require a separately installed Node.js runtime.

For development, double-click **`Start-BrowserAuto.cmd`**, or run:

```sh
npm install
npm run browsers
npm start
```

Development requires Node.js 22.12 or newer. `npm run browsers` installs bundled Chromium; an installed Chrome, Edge, Brave, or Opera can also be used. `npm run package` rebuilds the Windows application.

## Capture browser actions

1. Create a workflow using **+** beside Workflows, and enter its starting URL.
2. Choose a browser from the **Browser** dropdown. Installed browsers are enabled; **Refresh** detects newly installed browsers.
3. Type or paste a URL into **Start URL**. After one second without typing, a valid URL automatically opens the selected browser and starts recording with the first profile. Press Enter to start immediately. Bare domains use HTTPS. Incomplete URLs do not launch a browser. Alternatively, **Start capture** lets you choose a specific profile. The URL field is locked during capture; stop before starting another recording.
4. Click buttons, enter text, and select options in that browser. Actions appear live in the app.
5. Select an action to inspect its **selector, element HTML, tag, page URL, and capture time**. This is DOM information like the Elements panel in F12; opening DevTools is optional. Markup is shown as text, never executed in the app.
6. Use **Pause / Resume**, then **Stop & save**. Saving replaces that workflow’s existing actions. Edit the recorded actions after stopping, then run or export them as JSON.

Native menus provide File, Capture, View, and Help commands. Shortcuts: Ctrl+N new, Ctrl+S save, Ctrl+R capture, F8 pause/resume, Ctrl+Shift+R stop and save.

Browser capture opens a separate app-managed browser window. It does not attach to your already-open personal browser or copy its cookies. You can log in manually in the recording window; the saved session is reused by this app.

## Browsers

The app detects Chromium, Brave, Opera, Opera GX, Chrome, and Edge. Brave/Opera support uses their actual Chromium-based executable through Playwright; compatibility can vary with browser versions. This machine has Chrome and Edge installed; Chrome capture has been tested. Brave and Opera have not been tested on this machine because they are not installed.

For nonstandard install locations, set an environment variable before launching:

```powershell
$env:BROWSERAUTO_BRAVE_PATH = 'D:\Apps\Brave\Application\brave.exe'
$env:BROWSERAUTO_OPERA_PATH = 'D:\Apps\Opera\VERSION\opera.exe'
npm start
```

Other supported overrides: `BROWSERAUTO_OPERA_GX_PATH`, `BROWSERAUTO_CHROME_PATH`, `BROWSERAUTO_EDGE_PATH`. Opera’s actual `opera.exe` is usually inside a version-number directory; the update launcher is not the browser binary.

## Playback and profiles

Mouse movement is captured automatically in the recording page, sampled at up to 20 points per second and grouped into Mouse movement actions. Select one to see its cursor trail. Button presses create Click actions with the button's selector, HTML, and relative click position. The tracker does not capture the OS desktop, browser toolbar, or drag gestures.

Resize handling: recorded movement uses normalized viewport coordinates; playback scales each point to the current viewport. The last hover can re-anchor to its recorded element, and clicks resolve the target selector at replay time, preserving the relative position inside the target. Visible browsers follow their actual window size; headless runs use the viewport width/height in the Run dialog. A red marker shows playback position. Movement replay and the marker can each be disabled. Idle gaps between samples are capped at 250 ms.

Responsive layouts may hide or replace buttons or add mobile menus. Scaling a trail cannot infer these new interactions; update the selector or add a menu-opening action when needed. Canvas, drag-and-drop, and pixel-perfect drawing are not supported.

The included **Welcome aboard** workflow fills the local practice page. Choose **Run**, select one or more profiles, and inspect the result in **Run history**.

Profiles hold string variables such as `name` and `email`. Reference them in steps with `{{name}}`. Playback uses the browser selected in the builder, with up to eight concurrent browser sessions. Runs sharing one profile are serialized so session writes do not conflict. Pause takes effect between actions; cancel closes the browser.

Actions: Navigate, Click, Fill text, Select option, Check/uncheck, Press key, Wait, Assert text, and Screenshot. CSS and [Playwright selectors](https://playwright.dev/docs/locators) are supported. Workflows can be edited, duplicated, deleted, imported, and exported.

## Backend / command-line mode

The desktop app owns its backend process and shuts it down when the app closes. The backend can also run independently:

```sh
npm run backend
npm run record -- --browser chrome --url https://example.com --name "My capture"
```

Run those commands in separate terminals. The command-line recorder prints new actions. Enter `save` (or just Enter), `pause`, `resume`, or `discard`. Workflows are saved in the backend’s data directory. Use `--server http://127.0.0.1:PORT` to connect to a different local backend; the desktop backend’s ephemeral address is written to `desktop-backend.log`.

Do not run two backends against the same data directory. For a separate command-line instance, set `BROWSERAUTO_DATA_DIR` to a separate directory. The packaged desktop app stores its data separately from the source checkout.

## Storage

- Packaged app: `data` inside Electron’s per-user BrowserAuto application-data directory. **Help → Open data folder** shows the exact location.
- Development / standalone backend: `data/` in the source checkout, unless `BROWSERAUTO_DATA_DIR` overrides it.
- `store.json`: workflows, captured element HTML, profile variables, and run history.
- `sessions/`: cookies, local storage, and IndexedDB session state.
- `screenshots/`: run screenshots.

Data is stored locally, unencrypted. Captured HTML and screenshots can contain private page content. Password input values become `{{password}}`, and password/hidden input value attributes are removed from captured HTML. Provide the password variable in the profile if replay needs it. Exported workflows include captured element HTML but exclude profile variables and browser sessions.

## Current scope

- Recording covers the original tab’s main frame. Popups, iframes, uploads, downloads, canvas actions, and drag-and-drop are not recorded.
- Manual address-bar navigation must be added as a Navigate action. Site navigation caused by recorded clicks is replayed by those clicks.
- Captures store the interacted element’s HTML (up to 12,000 characters), not the entire page, network traffic, or DevTools UI.
- Selector calibration checks uniqueness and visibility. It does not infer a website’s login or registration procedure.
- Uses standard browser automation without stealth plugins, fingerprint spoofing, or CAPTCHA bypass.
- Saved sessions are cookies/local storage/IndexedDB, not full browser profiles. Extensions and session storage are not persisted.
- Unfinished runs become interrupted after restart; no scheduling service is included.

## Verification

```sh
npm test
```

Tests cover real browser recording/replay, installed-browser capture, captured HTML, password redaction, pause/resume, parallel profiles, session serialization, failure screenshots, run controls, persistence, responsive UI, and the real Electron application’s startup, native menu commands, and backend shutdown. Tests use temporary storage; backend integration tests use port 4311. Screenshots go to `test-results/`.

The desktop renderer has Node integration disabled, context isolation enabled, and sandboxing enabled. The local API checks host, origin, and a per-process mutation token. Browser launching follows [Playwright’s BrowserType API](https://playwright.dev/docs/api/class-browsertype); desktop process separation follows [Electron’s process model](https://www.electronjs.org/docs/latest/tutorial/process-model).
