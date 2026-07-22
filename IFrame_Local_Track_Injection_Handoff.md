# IFrame API: embedder-supplied local MediaStreamTrack — handoff

Lets a **same-origin** embedder publish a local video/audio track it owns and
processes itself (e.g. one `getUserMedia` → `<canvas>` zoom/crop →
`canvas.captureStream()` → fed to **both** the Jitsi call and a local
`MediaRecorder`). One camera, consistent processing, synced device selection.

---

## 1. What changed in jitsi-meet (this repo)

Two new External API methods, returning a `Promise`:

```js
api.setLocalVideoTrack(track);   // track: MediaStreamTrack | null
api.setLocalAudioTrack(track);
```

They route the supplied track into lib-jitsi-meet's existing
`replaceTrack` pipeline (the same path desktop-share uses), via
`JitsiMeetJS.createLocalTracksFromMediaStreams(...)`.

**Files:**
- `modules/API/external/external_api.js` — adds `setLocalVideoTrack` /
  `setLocalAudioTrack` / private `_injectLocalTrack`.
- `modules/API/API.js` — adds `injectLocalTrack()` and installs the hook
  `window._jitsiMeetInjectLocalTrack` during `API.init()`.

### The one hard constraint: SAME ORIGIN
A `MediaStreamTrack` is **not structured-cloneable**, so it cannot be sent over
the External API's `postMessage` transport. Instead, the embedder method calls
the hook **directly** on `iframe.contentWindow` — which the browser only permits
when the iframe is **same-origin** with the embedding page. A cross-origin embed
gets a clear rejected Promise telling you to fix the origin. (This is why the
deploy step below exists.)

### Build / deploy
- `external_api.js` is a webpack bundle: rebuild it so embedders pick up the new
  methods → `make` (produces `build/external_api.min.js`). The wrapper app must
  load the **rebuilt** `external_api.js`.
- `API.js` ships inside the web app: rebuild + redeploy the web bundle, served
  same-origin (see §2).

---

## 2. Docker / reverse-proxy: serve the embed same-origin (YOUR infra)

Today: wrapper `casting.heyjoe.io`, embed `meet.heyjoe.io` → **different origins**
→ direct track hand-off is blocked.

Fix: serve the meet **web UI** under a path on the casting origin, e.g.
`https://casting.heyjoe.io/meet/…`, and point the `<iframe src>` there. Nothing
about the **conference backend** changes — the web UI still connects its
signaling/media to `meet.heyjoe.io`; only the document origin moves. **Mobile apps
are unaffected** (they talk to the backend, not the iframe).

> The genuinely fiddly bit: Jitsi web assumes root-relative asset paths
> (`/libs`, `/css`, …). To serve under `/meet`, set the web container's base/
> public URL so assets resolve under `/meet` (docker-jitsi-meet `web` image:
> `PUBLIC_URL=https://casting.heyjoe.io/meet`), then proxy the subpath to it.
> Validate asset loading after wiring the proxy.

**nginx (on the `casting.heyjoe.io` server):**
```nginx
location /meet/ {
    proxy_pass         http://JITSI_WEB_CONTAINER:80/;   # trailing / strips /meet
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;   # colibri/xmpp websocket
    proxy_set_header   Connection        "upgrade";
}
```

**Traefik (labels on the jitsi `web` service):**
```yaml
labels:
  - "traefik.http.routers.meet.rule=Host(`casting.heyjoe.io`) && PathPrefix(`/meet`)"
  - "traefik.http.middlewares.meet-strip.stripprefix.prefixes=/meet"
  - "traefik.http.routers.meet.middlewares=meet-strip"
```

Confirm the final iframe URL is `https://casting.heyjoe.io/meet/<room>` (same
origin as the wrapper). If `api.setLocalVideoTrack()` rejects with the
"SAME ORIGIN" error, the origin isn't right yet.

---

## 3. CASTING REPO — paste this into the wrapper work

> Goal: one camera capture, processed once (digital zoom/crop), driving **both**
> the Jitsi call and the local `MediaRecorder`.

### 3a. Point the embed at the same-origin path
```js
// JitsiMeetExternalAPI must load from + create the iframe on casting.heyjoe.io
// (the /meet route from §2), NOT meet.heyjoe.io.
const api = new JitsiMeetExternalAPI('casting.heyjoe.io', {
    // ...existing options; configure so the iframe resolves to
    // https://casting.heyjoe.io/meet/<room>
});
```

### 3b. Capture once, process in a canvas, fan out to both consumers
```js
// 1) ONE getUserMedia for the chosen devices
const raw = await navigator.mediaDevices.getUserMedia({
    video: { deviceId: cameraId ? { exact: cameraId } : undefined, width: 1920, height: 1080 },
    audio: { deviceId: micId ? { exact: micId } : undefined }
});

// 2) draw the camera into a canvas, applying the digital zoom/crop
const video = Object.assign(document.createElement('video'),
    { srcObject: new MediaStream(raw.getVideoTracks()), muted: true });
await video.play();

const canvas = Object.assign(document.createElement('canvas'), { width: 1920, height: 1080 });
const ctx = canvas.getContext('2d');

let zoom = 1;                       // your PTZ/zoom state
(function draw() {
    const sw = video.videoWidth / zoom;
    const sh = video.videoHeight / zoom;
    const sx = (video.videoWidth - sw) / 2;
    const sy = (video.videoHeight - sh) / 2;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    requestAnimationFrame(draw);
})();

const processed = canvas.captureStream(30);
const processedVideoTrack = processed.getVideoTracks()[0];

// 3) hand the SAME processed track to Jitsi (AFTER join — required)
api.addListener('videoConferenceJoined', async () => {
    try {
        await api.setLocalVideoTrack(processedVideoTrack);
        // audio is unprocessed; inject it too only if you want device sync there:
        // await api.setLocalAudioTrack(raw.getAudioTracks()[0]);
    } catch (e) {
        console.error('setLocalVideoTrack failed (same-origin embed required):', e);
    }
});

// 4) feed the SAME processed video (+ original audio) to the local recorder
const recordStream = new MediaStream([ processedVideoTrack, ...raw.getAudioTracks() ]);
const recorder = new MediaRecorder(recordStream, { mimeType: 'video/webm;codecs=vp9,opus' });
recorder.start(1000);
```

### Notes for the casting work
- **Call `setLocalVideoTrack` after `videoConferenceJoined`** — before that the
  in-iframe hook may not exist (the method rejects with a clear message if so).
- **Device selection lives in your `getUserMedia`** now; you no longer need
  `setVideoInputDevice` on the iframe for the injected source (they'd both fight
  over the camera). Keep one source of truth.
- Changing zoom = just change the `zoom` var; both the call and the recording
  reflect it because they share `processedVideoTrack`.
- Switching cameras = stop `raw`, re-`getUserMedia` the new device, repoint
  `video.srcObject`; the canvas track (and thus both consumers) stays stable.
- `setLocalVideoTrack(null)` clears the injected source.

---

## Deploying to the running web (VERIFIED 2026-06-17)

The prod web is **not** auto-deployed from a master push. Verified on the box:
- Build host: EC2 `i-0d837fa451e0861b7` ("prod-1-jitsi-meet", us-west-1).
- Build dir: **`/opt/jitsi-meet`**, on branch **`master`**, remote `heyjoe-io/jitsi-meet`,
  clean (no hand-edited source). Was at `634823eaf` — **71 commits behind** GitHub
  master, all 71 web-only (filmstrip/participants/follow-me/recording/toolbox…).
- Build script `/usr/local/bin/update-jitsi-ui.sh`: **`git pull` is commented out** —
  it `make`s whatever is checked out in `/opt/jitsi-meet`, copies the built
  `*.html/*.js/libs/css/...` into `/opt/jitsi-meet-play/web-custom/`, then
  `docker-compose up -d`. So **deploys are manual.**

This feature touches only `modules/API/API.js` + `external_api.js`, which are
**identical between `634823eaf` and master** — so the feature commit cherry-picks
cleanly onto the running commit. To ship it:

```bash
# on the EC2 box, in /opt/jitsi-meet:
sudo git fetch origin
# Option A (surgical — prod gets ONLY this feature):
sudo git cherry-pick <FEATURE_COMMIT_SHA>
# Option B (also catch up to master — pulls the 71 web-only commits too):
# sudo git pull origin master
sudo /usr/local/bin/update-jitsi-ui.sh
```
Then the embed must be served **same-origin** (`casting.heyjoe.io/meet`, §2) or
`setLocalVideoTrack` rejects.

## Status
- jitsi-meet code: **done, lint-clean** (`modules/API/API.js`,
  `modules/API/external/external_api.js`), on branch **`feat/iframe-local-track-injection`**
  off `master`. Needs `make` (external_api) on the build host as part of the deploy above.
- Docker/proxy: §2 config; subpath base-URL is the bit to validate.
- Casting repo: §3 is the work to implement there.
