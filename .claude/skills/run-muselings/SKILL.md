---
name: run-muselings
description: Build, run, and drive Muselings (時空守護者) — a static WebAR museum-collection game (MindAR + A-Frame, no build step). Use when asked to start the app, take a screenshot of its pages, test the AR capture loop, or verify a change to ar.html/dex.html/js/ar-game.js/js/save.js.
---

Pure static HTML/JS/CSS, no build step, no root `package.json`. Serve it with
any static file server, then drive it with the `mcp__claude-in-chrome__*`
browser tools (this repo's dev machine has no `chromium-cli`, so the Chrome
extension tools are the harness — see "Run (agent path)" below). All paths
below are relative to the repo root.

## Prerequisites

Nothing to install — Python 3 and Node are already on this machine and either
works as the static server:

```bash
python --version   # verified: Python 3.14.3
node --version      # verified: v24.14.1
```

## Build

None. No `npm install`, no bundler. (`tools/` has its own `package.json` for
the optional GLB-compression pipeline described in README.md — unrelated to
running the app.)

## Run (agent path)

1. Start a static server in the repo root and poll until it responds — don't
   `sleep` blindly:

```bash
(python -m http.server 8000 > /tmp/nmns-server.log 2>&1 &)
timeout 15 bash -c 'until curl -sf http://localhost:8000/index.html >/dev/null; do sleep 1; done'
```

   Stop it when done (find the two listening PIDs and kill them — verified
   `kill <pid>` from Git Bash does NOT reach these native Windows python
   processes; use PowerShell):

```powershell
netstat -ano | Select-String ":8000.*LISTENING"   # read the PIDs in the last column
Stop-Process -Id <pid1>,<pid2> -Force
```

2. Load the browser tools once per session (they're deferred):

```
ToolSearch: select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__browser_batch,mcp__claude-in-chrome__javascript_tool,mcp__claude-in-chrome__read_console_messages
```

3. Get a tab, then drive pages with `browser_batch` (navigate → wait →
   screenshot, batched in one call). Verified this session:

| Page | What it proves | Verified result |
|---|---|---|
| `index.html` | Landing page renders, links to ar/dex/marker | ✅ renders, 3 nav buttons |
| `dex.html` | Registry-driven cards from `data/muselings.json`, live 3D model thumbnail, 「📸 放出來玩」 release button on unlocked cards | ✅ cards render from registry, fox model live, release button navigates to photo.html |
| `photo.html?spirit=red_fox&nocam` | Release-pet AR photo page in headless-testable mode (gradient bg instead of camera) | ✅ model renders, gestures work, shutter produces composite (see §5) |
| `marker.html` | Displays the printable/second-device marker image | ✅ renders marker PNG |
| `test-model.html` | Dev-only model/animation viewer (idle/pet/capture clip buttons) | ✅ fox loads, clip switch works on click |
| `ar.html?spirit=<id>` | Full AR scene, spirit picked from `data/muselings.json` (`red_fox` default). `comingSoon` spirits (raptor_kid) are gated — the page shows the 沉睡中 message instead of running the flow. **Requires real camera permission** — headless shows the compass-error fallback text plus a 重新載入 retry button on data-load failure | ✅ graceful degradation, per-spirit title/script load, unknown id shows error + retry, comingSoon id blocked |

   Example batch (adjust `tabId` from `tabs_context_mcp`):

```json
{"actions": [
  {"name": "navigate", "input": {"url": "http://localhost:8000/index.html", "tabId": TAB_ID}},
  {"name": "computer", "input": {"action": "screenshot", "tabId": TAB_ID}}
]}
```

4. **Testing the AR capture loop without a camera.** `ar.html`'s state
   machine (`js/ar-game.js`) listens for a `targetFound` event on
   `#anchor` and click events on `#spirit` — both can be dispatched
   directly, bypassing MindAR/camera entirely. This is the verified way to
   exercise intro → pet → knowledge → quiz → capture → localStorage write
   end-to-end in this environment:

```js
// via mcp__claude-in-chrome__javascript_tool, action: "javascript_exec"
window.MuselingSave.reset();
document.getElementById('anchor').emit('targetFound');   // triggers intro dialog
```

   Then click the dialog box (`{"action":"left_click","coordinate":[783,700]}`,
   the dialog sits bottom-center) to advance each line. Once in the "pet"
   phase (hint text "輕點小茜，摸摸牠的毛！"), pet by emitting `click` on the
   spirit directly (real click coordinates don't work — the 3D model isn't
   visually placed correctly since MindAR's tracking matrix never
   initialized without a camera):

```js
document.getElementById('spirit').emit('click');  // repeat data.petCount (3) times
```

   Continue clicking the dialog through the knowledge lines, then answer the
   quiz. **Options are shuffled every time** — find the correct button by
   text, not index (for red_fox it's 「保暖和保持平衡」):
   `[...document.querySelectorAll('.quiz-btn')].find(b => b.textContent === '保暖和保持平衡').click()`.
   Two consecutive wrong answers replay the knowledge dialog before re-asking.
   A correct answer produces the `✨ 收服成功！` panel and writes to
   `localStorage`:

```js
window.MuselingSave.load()
// → { dex: { red_fox: { affinity: 3, unlocked: true, name: "小茜", ... } }, ... }
```

   Seed/reset save data directly (any page that loads `js/save.js`, i.e.
   `ar.html`/`dex.html`) instead of replaying the whole flow:

```js
window.MuselingSave.reset();
window.MuselingSave.unlock('red_fox', { affinity: 3, name: '小茜', species: '赤狐', zone: '哺乳動物區' });
```

   **Testing the marker-lost float / re-anchor logic** (the zoom-in bug fix)
   without a camera — verified: parent swaps and transforms stay finite even
   though MindAR's anchor matrix is a zero matrix headless (the `safeReparent`
   guard in `js/ar-game.js` handles the NaN case):

```js
const anchor = document.getElementById('anchor');
const s = document.getElementById('spirit');
anchor.emit('targetLost');   // → s.object3D.parent === a-camera's object3D, drift mode 'camera'
anchor.emit('targetFound');  // → parent back to anchor.object3D, drift mode 'anchor'
// inspect: s.components['float-drift'].mode, s.object3D.position/scale (must be finite)
```

   Note: drift lerp convergence can't be observed headless — MindAR's arError
   freezes A-Frame's render loop (scene.time stays ~60ms), so `tick` never
   runs. State transitions are testable; smooth motion needs a real device.

5. **Testing photo.html (release-pet AR photo page).** Use `?nocam` to skip
   the camera-permission overlay and render on a gradient background:

   - **The spirit must be unlocked in localStorage first** (page gates on
     `MuselingSave.isUnlocked`) — seed it from any page on the origin:
     `window.MuselingSave.unlock('red_fox', { affinity: 3 })`.
   - `http://localhost:8000/photo.html?spirit=red_fox&nocam` — wait ~3s for
     the GLB; first screenshot may catch it mid-load, take a second one.
   - Gestures (all verified via `computer` tool `left_click_drag`):
     drag starting **on the fox** moves it (check
     `document.getElementById('pet-holder').style.transform`); drag on
     **empty space** rotates it (check
     `document.getElementById('pet-viewer').cameraOrbit` — theta free,
     phi clamped 65–95°).
   - Click the shutter button (bottom center) → preview overlay appears
     with the composite (gradient/camera frame + fox at its dragged spot),
     blob URL in `#preview-img`, download filename `<id>_photo.jpg`.
   - Without `?nocam` the start overlay offers 開啟相機 / 不用相機直接放出
     / 回圖鑑 — the no-camera path uses the same gradient fallback.

## Run (human path)

Open `http://localhost:8000` in a real browser with a webcam, allow camera
permission, click "開始任務", point the camera at `assets/targets/demo-marker.png`
(shown via `marker.html` on a second device, or printed). Ctrl+C the server
to stop.

## Test

No automated test suite exists in this repo (no `package.json` at root, no
`tests/` dir). Verification is manual/visual via the driver above.

---

## Gotchas

- **`ar.html` needs a real camera; there is no headless/software fallback.**
  Without camera permission, MindAR fires `arError` and the custom loading
  overlay (`#loading-layer`) never gets its `off` class — it stays covering
  the whole screen, and everything under it becomes invisible even though
  the game state machine is still running underneath. To see the UI after
  simulating `targetFound`, force-hide it:
  `document.getElementById('loading-layer').classList.add('off')`.
- **The `?uidebug` query param on `ar.html` only reveals the scan-layer
  visuals** (compass/seeker UI) without opening the camera — it does not
  bypass MindAR's camera request, and it does not help reach the intro
  dialog. Use the `targetFound` emit trick above for that instead.
- **The 3D fox model is not visible during a no-camera `targetFound` test** —
  the scene renders solid black (no camera passthrough texture) and the
  anchor's world transform never updates from MindAR's default (since
  tracking never started), so the model ends up off the visible area. Only
  the 2D HTML UI overlay (dialog/hearts/quiz/captured panel) is visible.
  This is enough to verify the state machine and the `localStorage` write;
  it does not verify the 3D presentation — for that, use `test-model.html`
  instead, which has no camera/marker dependency at all and renders the
  model directly on a plain A-Frame scene.
- **`localStorage` persists across navigations on the same origin** — `dex.html`
  read data seeded from `ar.html` in the same session without a page
  refresh workaround; just `navigate` and it picks up the latest save.
- **Existing player data may already be in `localStorage`** from a prior
  session on this Chrome profile (this repo's dex already had one fox
  logged before this session started) — call `MuselingSave.reset()` first
  if you need a clean-slate test.
