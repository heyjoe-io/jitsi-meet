# Remote Gimbal Control V1 — Handoff

**Branch:** `feat/gimbal-control` (off `feat/chunked-upload`; the gimbal feature is the
tip commit, `bb2453dd4`). iOS only. Target hardware: Insta360 Flow (DockKit).

**Scope (V1):** seven commands — `start_tracking`, `stop_tracking`, `recenter`,
`pan_left`, `pan_right`, `tilt_up`, `tilt_down`. **No zoom** (stays in the remote
camera system). **No orientation/portrait-landscape** controls yet.

## What's built (phone side, done)

- `ios/sdk/src/GimbalController.swift` — DockKit control, iOS 17+ (`@available`-gated;
  reports `supported:false` below 17). Maps: tracking → `setSystemTrackingEnabled`,
  pan/tilt → `setAngularVelocity` nudges (tracking off), recenter → `setOrientation`
  neutral. Observes `accessoryStateChanges` and posts `HJGimbalStatusDidChange`.
- `ios/sdk/src/GimbalModule.{h,m}` — RN module `GimbalControl` (ObjC `RCTEventEmitter`,
  same pattern as `HighResRecordModule`): `getStatus`, `executeCommand`, `onGimbalStatus`
  event. Bridges to the Swift controller.
- `react/features/base/media/components/native/RemoteGimbalControl.tsx` — headless,
  mounted in `Conference.tsx`. Handles `admin.gimbal.command`, runs it natively, replies
  `device.gimbal.command_result`, pushes `device.gimbal.status`.

## WS contract (already implemented on the phone)

Same asymmetric rooms as remote camera control. **CD → phone** to `talent-${talentId}`:
```json
{ "type":"admin.gimbal.command", "sessionId":"…", "targetParticipantId":"<talentId>",
  "command":"start_tracking", "requestId":"<uuid>" }
```
**Phone → CD** on `talent-session-${sessionId}`:
```json
{ "type":"device.gimbal.command_result", "requestId":"<uuid>", "ok":true,
  "status":{ "connected":true, "tracking":true } }
{ "type":"device.gimbal.command_result", "requestId":"<uuid>", "ok":false, "error":"Gimbal not connected" }
{ "type":"device.gimbal.status", "talentId":"…", "supported":true, "connected":true, "tracking":false }
```

---

## iOS integration checklist (Yasith)

The Swift/ObjC logic is written; these are the build-config + verification steps I
can't do without Xcode and the physical gimbal. Please do this **today/tomorrow** so a
device test happens before Wednesday — the native + hardware is where the schedule risk is.

1. **Add the 3 files to the JitsiMeetSDK target** (they won't compile in otherwise):
   `GimbalController.swift`, `GimbalModule.h`, `GimbalModule.m`. Confirm `.swift` is in
   *Compile Sources* and the SDK's bridging/`-Swift.h` generation is on (it already is —
   PiP is Swift).
2. **Confirm the Swift header import** in `GimbalModule.m`:
   `#import <JitsiMeetSDK/JitsiMeetSDK-Swift.h>` (guarded with `__has_include`). If the
   product module name differs, fix the import. This is the first ObjC→Swift `-Swift.h`
   consumer in the SDK, so verify it resolves.
3. **DockKit signatures — corrected (round 2).** Resolved from the integrator's
   compiler feedback: all DockKit-typed members are now inside `#if canImport(DockKit)`
   (fixes the simulator "cannot find type 'DockAccessory'" — DockKit isn't in the sim
   SDK); `accessoryStateChanges` uses `for try await`; motor APIs use Spatial
   `Vector3D` / `Rotation3D.identity` (not simd). Two spots still only verifiable with
   the device SDK in front of you: (a) the `accessoryStateChanges` element shape
   (`change.state == .docked` / `change.accessory`), and (b) whether `setOrientation`
   needs explicit `duration`/reference args (the identity rotation alone should satisfy
   its defaulted params). Both isolated to `GimbalController.swift`.
4. **Tune on the physical gimbal** (in `GimbalController.swift`): `nudgeRate` (step
   speed) and `nudgeNanos` (step duration), and the pan/tilt **axis signs** — confirm
   `pan_left` actually goes left and `tilt_up` up. The axis convention (x=pitch, y=yaw)
   needs hardware to confirm.
5. **iOS 17+ test device** with the Insta360 Flow docked. On <17 the module reports
   `supported:false` and the CD controls stay disabled — verify that path too.
6. **Build + TestFlight.** Given the week's pattern: after archiving, confirm the build
   actually contains the new native (don't reuse a cached SDK framework), and confirm the
   JS bundle is current if you OTA.

**Verify end-to-end** (no special tooling): with the gimbal docked, the CD panel should
enable (phone sends `device.gimbal.status {supported:true, connected:true}`); each button
should move the gimbal and the CD should show success + updated tracking state; undock →
controls disable.

---

## Casting Admin scope (web app — separate repo)

Build a gimbal panel in the live/back-office session view. Mirrors `RemoteCameraPanel` +
the `wsMessageHandler` `case 'message'` inner switch.

**Capability gate:** enable controls only when the latest `device.gimbal.status` for the
talent has `supported === true && connected === true`. No status / false → disabled.
Old app builds never send it → stay disabled (graceful).

**Store** `gimbalStatusByTalent[talentId]` from `device.gimbal.status` (new case in the
inner switch, beside `camera-state`).

**Layout:**
```
[Start Tracking] [Stop Tracking] [Recenter]
              [Tilt Up]
[Pan Left]              [Pan Right]
             [Tilt Down]
```

**Each button:** generate a `requestId` (uuid) → `sendRoomMessage(\`talent-${talentId}\`,
{ type:'admin.gimbal.command', sessionId, targetParticipantId: talentId, command, requestId })`
→ pending until the matching `device.gimbal.command_result` (correlate by `requestId`) or
a ~5s timeout.

**On `command_result`:** clear pending; if `ok`, apply `status.{connected,tracking}` to the
stored state (e.g. highlight Start Tracking while `tracking`); if `!ok`, surface `error`.
Never send a command in reaction to a status/result (no echo loop).

**Acceptance:**
- [ ] All seven commands send and the talent's gimbal responds.
- [ ] Controls disabled when no compatible/connected gimbal is reported.
- [ ] Each command shows success/failure from `command_result`.
- [ ] Panel reflects updated connected/tracking after each result.
- [ ] No zoom controls; no orientation controls.
