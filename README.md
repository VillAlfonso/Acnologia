# BrowserAuto — Desktop Capture Builder

A Windows desktop application with a compact, Windows Forms–style interface. The Electron front end starts a separate Node.js automation backend; recording opens a real installed browser. There is no hosted website or cloud service.

## Open the app

Double-click **`BrowserAuto.exe`** in the newest `C:\BrowserAuto\dist\build-…\BrowserAuto-win32-x64\` folder. Keep the accompanying files in that folder together. Each build gets a new folder so updates never overwrite a running application. This build does not require a separately installed Node.js runtime.

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
3. Type or paste a URL into **Start URL**. After one second without typing, a valid URL automatically opens the selected browser and starts recording in a fresh session. Press Enter to start immediately. Bare domains use HTTPS. Incomplete URLs do not launch a browser. Alternatively, use **Start capture**. The URL field stays editable during capture. Edits are kept as a draft without interrupting the active browser; stop and save (or discard), then press Enter to record the new URL. You can also type a URL when there are no workflows; a new workflow is created automatically.
4. Click buttons, enter text, and select options in that browser. Actions appear live in the app.
5. Select an action to inspect its **selector, element HTML, tag, page URL, and capture time**. This is DOM information like the Elements panel in F12; opening DevTools is optional. Markup is shown as text, never executed in the app.
6. Use **Pause / Resume**, then **Stop & save**. Saving replaces that workflow’s existing actions. Edit the recorded actions after stopping, then run or export them as JSON.

Native menus provide File, Capture, View, and Help commands. Shortcuts: Ctrl+N new, Ctrl+S save, Ctrl+R capture, F8 pause/resume, Ctrl+Shift+R stop and save.

Browser capture opens a separate app-managed browser window. It does not attach to your already-open personal browser or copy its cookies. You can log in manually in the recording window. Each subsequent run starts a fresh session; record the login steps if playback needs them.

## Browsers

The app detects Chromium, Brave, Opera, Opera GX, Chrome, and Edge. Brave/Opera support uses their actual Chromium-based executable through Playwright; compatibility can vary with browser versions. This machine has Chrome and Edge installed; Chrome capture has been tested. Brave and Opera have not been tested on this machine because they are not installed.

For nonstandard install locations, set an environment variable before launching:

```powershell
$env:BROWSERAUTO_BRAVE_PATH = 'D:\Apps\Brave\Application\brave.exe'
$env:BROWSERAUTO_OPERA_PATH = 'D:\Apps\Opera\VERSION\opera.exe'
npm start
```

Other supported overrides: `BROWSERAUTO_OPERA_GX_PATH`, `BROWSERAUTO_CHROME_PATH`, `BROWSERAUTO_EDGE_PATH`. Opera’s actual `opera.exe` is usually inside a version-number directory; the update launcher is not the browser binary.

## Playback

### Variables and a generator for each recording

Typing or pasting into an input, textarea, or contenteditable field records a **Fill text** action using a variable such as `{{name}}`, `{{email}}`, or `{{password}}`. It records the value to fill, not a separate action for every character. Enter and Tab are recorded as key actions. The original typed text stays in the recording browser; field HTML has input values and editable text removed.

After **Stop & save**, open **Variables & generator…**. Fields appear in the order first typed. Review the inferred type, email domain, password length, or fixed text. Confirm-password fields reuse the earlier password. **Preview new values** shows a sample without starting a run. **Save generator** stores the recipe with that recording, including in workflow JSON exports.

Existing captured forms without a generator are converted automatically for each run, including recordings that fail with `Missing profile variable: password`. No separate generation step is required: press **Run** and playback fills that run's answers. Opening **Variables & generator…** lets you review and save the inferred rules. **Detect added fields** incorporates Fill text steps added later. Field types are inferred from labels and HTML; review ambiguous fields or use **Fixed value** for site-specific requirements.

With the generator enabled, each run creates one set of values and uses it consistently across all steps and tabs. Runs always start with a fresh browser context. Profiles and saved-login reuse are removed from the app. Existing profile data is left on disk but is not used.

**Run history → Values used in this run** retains the generated values, with passwords hidden until **Reveal passwords**. **Export values…** saves that run's values, including passwords, as JSON. These are input records, not confirmation that an account exists; add an Assert text step for the site's success message. Generation does not create an email inbox. The default email domain is `example.test`; choose **Fixed value** for an existing inbox you control.

### Stealth and proxy checks

Public proxy feeds: [IPLocate](https://github.com/iplocate/free-proxy-list), [ProxyScrape](https://proxyscrape.com/free-proxy-list), [Monosans](https://github.com/monosans/proxy-list), [Proxifly](https://github.com/proxifly/free-proxy-list), [Geonode](https://geonode.com/free-proxy-list), and [MADEVAL](https://github.com/MADEVAL/free-proxy-list). The app loads their HTTP lists, filters invalid/private endpoints, deduplicates across feeds, and interleaves source candidates so a large list cannot dominate. An unavailable feed does not disable the others. Geonode uses its first 500 HTTP results per refresh; text parsing is capped at 8 MB per feed. The monitor reports feed counts and the sources of passing candidates.

Run a live comparison with `node scripts/check-proxies.js https://example.com/`. It tests up to 24 candidates per source with the same 2-second IP and 6-second page limits, stops early for a source when a candidate passes, and writes a timestamped JSON report to `test-results/`. This is a sampled, point-in-time check, not a claim about every proxy in a source. It only requests the public starting page and sampled scripts through proxies; it does not log in or submit forms.

Free-proxy selection now checks speed before each recording/run. Candidates must pass two HTTPS IP checks (at most 2 seconds each), keep the same unused exit IP, and load the starting page plus up to two same-origin script files within 6 seconds. The fastest passing candidate in each batch is selected; slow or failed candidates are skipped and avoided for 10 minutes. The monitor shows timings and rejection messages. Selection checks at most 24 candidates with a 45-second candidate-check budget, in addition to list loading and the direct-IP baseline check. It stops if none qualify; it never falls back to a direct site connection.

Adjust `maxLatencyMs` (250–10000) and `maxPageLoadMs` (1000–15000) in `proxy.json`, for example `{ "mode": "free", "maxLatencyMs": 2000, "maxPageLoadMs": 6000 }`. Local practice pages skip the remote-site check. The page check reads HTML and a small script sample without executing JavaScript or submitting forms. It cannot guarantee later performance, test every resource/subdomain, or detect every site restriction. Selection happens before recording/playback; an existing session is not silently restarted on another proxy.

Browser sessions use Playwright Extra with the stealth plugin. Public-proxy mode uses `{ "mode": "free" }` in the data folder's `proxy.json`; custom HTTP(S) proxy endpoints and credentials remain supported. Free mode checks public lists for an unused exit IP, and Run history shows checks from the actual browser at the start and end of playback. If verification fails, the run fails. Public proxies are not guaranteed residential, and start/end checks are not continuous monitoring. Use `{ "mode": "direct" }` for local diagnostics without a proxy. The desktop data folder is available under **Help → Open data folder**.

Mouse movement is captured automatically in the recording page, sampled at up to 20 points per second and grouped into Mouse movement actions. Select one to see its cursor trail. Button presses create Click actions with the button's selector, HTML, and relative click position. The tracker does not capture the OS desktop, browser toolbar, or drag gestures.

Resize handling: recorded movement uses normalized viewport coordinates; playback scales each point to the current viewport. The last hover can re-anchor to its recorded element, and clicks resolve the target selector at replay time, preserving the relative position inside the target. Visible browsers follow their actual window size; headless runs use the viewport width/height in the Run dialog. A red marker shows playback position. Movement replay and the marker can each be disabled. Idle gaps between samples are capped at 250 ms.

Responsive layouts may hide or replace buttons or add mobile menus. Scaling a trail cannot infer these new interactions; update the selector or add a menu-opening action when needed. Canvas, drag-and-drop, and pixel-perfect drawing are not supported.

The included **Welcome aboard** workflow fills the local practice page. Choose **Run**, choose the number of runs, and inspect the result in **Run history**.

Playback uses the selected browser, with up to eight concurrent independent sessions. Pause takes effect between actions; cancel closes the browser. Visible browsers stay open after a run by default so you can inspect results or errors; use **Close browser** in Run history or close the browser window. Uncheck **Keep visible browsers open after the run** to close them automatically.

Actions: Navigate, Click, Fill text, Select option, Check/uncheck, Press key, Wait, Assert text, and Screenshot. CSS and [Playwright selectors](https://playwright.dev/docs/locators) are supported. Workflows can be edited, duplicated, deleted, imported, and exported.

## Live terminal monitor

A separate **BrowserAuto - Live Monitor** PowerShell window opens automatically with the desktop app. It shows UTC timestamps for startup, API actions, recording events, proxy selection/checks, navigation, failed HTTP requests, page error notices, each run step and its duration, screenshots, controls, and completion/errors. It reads the persistent monitor log and updates about four times per second. Close it independently or reopen it from **View → Live monitor**. It exits when the app exits.

The monitor is an execution trace, not a dump of every browser byte: typed/generated answers, passwords, cookies, request bodies, and raw page-console contents are omitted. Query strings and URL credentials are removed. Generated answers remain available separately in Run history.

A start-page load failure keeps a visible recording browser open and displays the error. Initial proxy verification uses the run's existing tab instead of opening and closing a temporary window. A failed visible run stays open with its error in Run history and the monitor. Proxy selection can still fail before any browser opens; the monitor explains why, and the app does not silently retry without the proxy.

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
- `store.json`: workflows, captured element HTML, generated values, and run history.
- `sessions/`: old saved sessions retained on disk; no longer loaded or written.
- `monitor.log`: live event history; files larger than 10 MB are archived on backend startup.
- `screenshots/`: run screenshots.

Data is stored locally, unencrypted. Captured HTML and screenshots can contain private page content. Newly recorded text inputs become variables, and input values/editable text are removed from captured HTML. Generated run values (including generated passwords) are saved in `store.json`; hiding passwords in the interface does not encrypt them. Workflow exports contain generator recipes and captured HTML, but do not include generated run values, profile variables, or browser sessions. Fixed values in generator recipes are included in workflow exports.

## Current scope

- Recording follows tabs and popup windows opened by the site, including links with `target="_blank"`. Every action stores its tab number; playback waits for that tab and switches back when needed. Start at the page containing the opening link so playback can reproduce it. Manually opened tabs without a recorded opening action, iframes, uploads, downloads, canvas actions, and drag-and-drop are not supported.
- Manual address-bar navigation must be added as a Navigate action. Site navigation caused by recorded clicks is replayed by those clicks.
- Captures store the interacted element’s HTML (up to 12,000 characters), not the entire page, network traffic, or DevTools UI.
- Selector calibration checks uniqueness and visibility. It does not infer a website’s login or registration procedure.
- Uses Playwright with the stealth plugin; this does not guarantee undetectability or bypass CAPTCHAs.
- Every capture and run uses a fresh browser context. Old profiles and saved sessions are not used.
- Unfinished runs become interrupted after restart; no scheduling service is included.

## Verification

```sh
npm test
```

Tests cover real browser recording/replay, installed-browser capture, captured HTML, password redaction, pause/resume, parallel independent runs, monitor logs, browser retention, failure screenshots, run controls, persistence, responsive UI, and the real Electron application’s startup, native menu commands, and backend shutdown. Tests use temporary storage; backend integration tests use port 4311. Screenshots go to `test-results/`.

The desktop renderer has Node integration disabled, context isolation enabled, and sandboxing enabled. The local API checks host, origin, and a per-process mutation token. Browser launching follows [Playwright’s BrowserType API](https://playwright.dev/docs/api/class-browsertype); desktop process separation follows [Electron’s process model](https://www.electronjs.org/docs/latest/tutorial/process-model).

