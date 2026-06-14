# Optical Zoom — Handoff

**Branch:** `feat/optical-zoom` (this repo) + `heyjoe-recording` on
[heyjoe-io/react-native-webrtc](https://github.com/heyjoe-io/react-native-webrtc)
(pinned at `da4d7ab` in `package-lock.json`).

**Status:** code complete, builds locally. Needs the on-device validation pass
below before TestFlight. iOS only — Android is unaffected.

## What it does

On the rear camera, we now open the iPhone's **virtual multi-camera**
(`builtInTripleCamera`, falling back to `builtInDualCamera`) instead of the bare
wide lens. Zooming therefore crosses real lens switch-over points (ultra-wide →
wide → telephoto) — true optical 2x/5x rather than digital crop. Because there is
a single capture pipeline, the live WebRTC feed **and** the local recording both
reflect the zoom, same as the existing pinch-to-zoom.

A zoom pill (`CameraZoomBar`) sits just above the toolbar whenever the live camera
offers zoom. On a multi-lens rear camera it's **1x/2x/5x** mapping to real glass; on
the front camera it's **1x/2x/3x** digital zoom (great for virtual slates). Tap a
stop for a smooth ramp; press and slide across the pill for continuous zoom. It hides
itself when video is muted, on Android, and on a single-lens rear camera (we
deliberately don't offer digital-only zoom where users expect optical reach).

## Where the code lives

### Fork (heyjoe-io/react-native-webrtc, branch `heyjoe-recording`)

- `ios/RCTWebRTC/VideoCaptureController.m` — `preferredBackVirtualCamera`
  selects a telephoto-capable virtual device via `AVCaptureDeviceDiscoverySession`;
  front camera / no-telephoto devices fall back to the old wide-lens path.
- `ios/RCTWebRTC/HeyJoeVideoCapturer.m` —
  - starts the virtual device at the **wide base** zoom factor so the preview
    doesn't open on the ultra-wide (raw factor 1.0 == 0.5x on a triple camera);
  - `setZoomFactorImmediate:` (no ramp, for slider tracking) and
    `getZoomConfigWithCompletionHandler:` (wide base, min/max, isMultiLens,
    switch-over factors) alongside the existing ramped `setZoomFactor`;
  - format selection tie-breaks toward formats that support **Standard** video
    stabilization;
  - logs constituent lenses + switch-over factors on camera start (see
    validation below).

`patches-for-fork/` in this repo holds source-of-truth copies of those files —
they are byte-identical to fork HEAD `da4d7ab` as of this handoff.

### App side (this repo)

- `react/features/base/media/components/native/CameraZoomBar.tsx` — the pill.
  Redux-driven: shows when `facingMode === 'environment'` and video isn't muted.
  Polls `getZoomConfig` with retries after a camera flip because the native
  switch completes after redux updates. UI stops are expressed relative to the
  wide lens (`wideBaseZoomFactor` maps UI 1x to the right raw factor).
- `react/features/conference/components/native/Conference.tsx` — mounts the bar
  as a flex child **directly above `<Toolbox />`** (both filmstrip and tile-view
  branches), so it can never be covered by the toolbar.
- `ios/sdk/src/HighResRecordModule.m` — exports `setZoomFactorImmediate` /
  `getZoomConfig` to JS.

## Gotchas / history

1. **Latency:** the first cut used `CinematicExtended` video stabilization,
   which buffers frames in the capture pipeline and added **~1.5–2s** of
   glass-to-glass delay. Fixed in fork commit `da4d7ab` — we only ever request
   **Standard** now. If you see big latency again, check
   `preferredVideoStabilizationMode` first.
2. **Stale npm pin:** `npm install` will NOT pick up new fork commits — the SHA
   is pinned in `package-lock.json`. After any fork change:
   `npm cache clean --force && npm update react-native-webrtc && cd ios && pod install`,
   then verify with the grep in `CLAUDE.md`. This has shipped stale builds before.
3. **Don't edit `node_modules` and stop there** — always land changes on the
   fork branch and bump the pin, or the next install silently reverts them.

## Remote camera control (CD → talent)

`RemoteCameraControl` (headless, mounted in `Conference.tsx`) listens on the phone's
websocket. **Rooms are asymmetric** — the phone only ever JOINS `talent-${talentId}`
(see `initWebsocket` in `react/features/onboard/functions.js`), so CD→phone commands
must be sent to that room (same as `start-local-recording`). The phone SENDS its
reports to `talent-session-${sessionId}`, which the CD joins. Contract for the CD
web app:

**CD → phone** (send to room `talent-${talentId}`)

| message | effect |
| --- | --- |
| `{ type: 'flip-camera', facingMode?: 'user' \| 'environment' }` | Flip the camera. With `facingMode` it acts as "switch to" (no-op when already there). Works on iOS and Android; safe mid-recording. |
| `{ type: 'set-camera-zoom', uiZoom: 2 }` | Zoom as a wide-lens multiple (the pill's 1x/2x/5x scale, fractional values fine). Clamped to the device range; ignored when there's no optical zoom. |
| `{ type: 'set-recording-quality', quality: '1080p' \| '4K' }` | Resolution for the **next** recording (can't change a take already rolling). "Session-wide" = the CD sends this to every talent's room in the group. Note: 4K (25 Mbps) outpaces chunked upload on most uplinks. |
| `{ type: 'get-camera-state' }` | Request a `camera-state` report. |

**Phone → CD** (reported on room `talent-session-${sessionId}`)

`{ type: 'camera-state', talentId, facingMode, videoMuted, zoom, recordingQuality,
isRecording }` where `zoom` is
`{ currentUiZoom, maxUiZoom, stops, optical, warnAboveUiZoom }` or `null` when zoom
can't be offered (single-lens REAR camera, muted video, Android). `recordingQuality`
is `'1080p'|'4K'`; `isRecording` lets the CD disable the quality toggle mid-take (a
change wouldn't apply until the next recording). The front camera
reports digital zoom (`optical: false`, `stops: [1, 2, 3]`, `warnAboveUiZoom: 2`) —
invaluable for virtual slates; 3x only mildly upscales the 1080p recording and keeps
slate text legible. **Show a quality warning (e.g. ⚠️) when `currentUiZoom >
warnAboveUiZoom`** — the talent's pill does this; `warnAboveUiZoom: null` means
optical zoom that never warns. Sent on mount, after
every flip/mute change, after a remote zoom is applied, and (debounced 300ms) when
the talent moves the zoom locally. Drive the CD UI from these reports — render the
zoom control only when `zoom` is non-null, and use `stops`/`maxUiZoom` rather than
hardcoding 1/2/5.

Shared zoom helpers (stops list, UI↔raw conversion, change events) live in
`react/features/base/media/components/native/cameraZoom.ts`.

## Build

```bash
npm install            # lockfile already pins da4d7ab
cd ios && pod install
# open ios/jitsi-meet.xcworkspace, build/archive as usual
```

## On-device validation (before TestFlight)

Needs a physical multi-lens iPhone (Pro model ideally, for the 5x telephoto).

1. **Bar placement/visibility:** join a call, flip to the rear camera. The
   1x/2x/5x pill should appear just above the toolbar within ~1–2s — without
   pinning the self-view. Flip to front: pill switches to 1x/2x/3x (digital).
   Mute video: pill disappears.
2. **Optical switch-over:** watch the Xcode console for
   `[HeyJoeCapturer] Device ... switch-over zoom factors: (...)`. Tapping 2x/5x
   should cross those factors — confirm visually that the image quality jumps
   (lens hand-off) rather than just cropping. If the log shows
   `switch-over zoom factors: ()` on the back camera, the chosen format
   collapsed the virtual device to one lens and the format chooser in
   `bestFormatForDevice:` needs revisiting for that device.
3. **Latency:** wave a hand in front of the camera — remote side and local
   preview should track with normal call latency (well under half a second).
   Console should log `Video stabilization requested (mode=1)` (Standard).
4. **Recording:** record a clip while zoomed; the zoom level must be present in
   the uploaded file.
5. **Pinch-to-zoom regression:** pinch on the pinned self-view still works and
   the pill's active stop follows the pinch the next time the config is read.
6. **Front digital zoom (virtual slates):** on the front camera the pill shows
   1x/2x/3x and pinch caps at 3x. Hold a slate/ID at arm's length and zoom to
   3x — the text must stay clearly legible in both the live feed and the
   recording. Past 2x the active label gains a ⚠️ (quality-loss warning,
   `FRONT_WARN_ABOVE_UI_ZOOM`); at/below 2x there's none. If 3x looks too soft
   (or you want more reach), change the last value of `FRONT_UI_STOPS` in
   `cameraZoom.ts` — it drives the stops, the pill, the pinch cap, and the
   remote-control range together.
