# CLAUDE.md — jitsi-meet (HeyJoe fork)

## Overview

This is HeyJoe's fork of Jitsi Meet, customized for the casting platform's video calling and local recording features. It builds iOS and Android apps that are distributed via TestFlight / App Store / direct APK.

## Development Commands

```bash
npm install                # Install JS dependencies
cd ios && pod install      # Install iOS native dependencies
```

Build and archive via Xcode (`ios/jitsi-meet.xcworkspace`), then upload to TestFlight.

## Key Forked Dependencies

### react-native-webrtc

**Source:** `github:heyjoe-io/react-native-webrtc#heyjoe-recording`

This is a HeyJoe fork of react-native-webrtc with custom iOS local recording via `HeyJoeVideoCapturer.m`. It contains critical fixes not in upstream.

**When updating or reinstalling this dependency, always verify the lockfile resolves to the latest commit on the fork branch:**

```bash
# 1. Check what the remote branch HEAD is
git ls-remote git@github.com:heyjoe-io/react-native-webrtc.git heyjoe-recording

# 2. Check what package-lock.json has pinned
grep -A3 '"react-native-webrtc":' package-lock.json | grep "version"

# 3. If they don't match, npm is using a stale cached version. Fix with:
npm cache clean --force
rm -rf node_modules/react-native-webrtc
npm update react-native-webrtc

# 4. Then update iOS pods
cd ios && pod install
```

**Why this matters:** `npm install` resolves GitHub branch references to a specific commit SHA and pins it in `package-lock.json`. If the fork branch gets new commits, `npm install` will NOT pick them up — it uses the pinned SHA. You must run `npm update react-native-webrtc` (and often `npm cache clean --force`) to pull the latest commit. This has caused production bugs where fixes existed in the fork but were missing from the build.

## Project Structure

- `ios/` — Xcode project, Podfile, native iOS code
- `android/` — Gradle project, native Android code
- `react/` — React Native JS source (Jitsi Meet UI + HeyJoe customizations)
- `node_modules/react-native-webrtc/ios/RCTWebRTC/HeyJoeVideoCapturer.m` — Custom iOS recording implementation (from fork)
- `node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/HeyJoeVideoCapturer.java` — Custom Android recording implementation (from fork)
- `android/sdk/src/main/java/org/jitsi/meet/sdk/HighResRecordModule.java` — Android RN bridge for high-res recording

## Version Bumping

iOS app version: update `MARKETING_VERSION` and `CURRENT_PROJECT_VERSION` (both Debug and Release) in `ios/app/app.xcodeproj/project.pbxproj`.

## Build & Deploy

### iOS (TestFlight / App Store)

1. Ensure `package-lock.json` points to the latest fork commits (see above)
2. Run `npm install` then `cd ios && pod install`
3. Build and archive in Xcode (`ios/jitsi-meet.xcworkspace`)
4. Upload to TestFlight

### Android (APK)

1. Ensure `package-lock.json` points to the latest fork commits (see above)
2. Run `npm install`
3. Rebuild the JS bundle (required after any JS changes):
   ```bash
   npx react-native bundle --platform android --dev false \
     --entry-file index.android.js \
     --bundle-output android/app/src/main/assets/index.android.bundle \
     --assets-dest android/app/src/main/res/
   ```
4. Build the release APK:
   ```bash
   cd android && ./gradlew assembleRelease
   ```
5. Output APK: `android/app/build/outputs/apk/release/app-release.apk`
6. Install via USB (requires USB debugging enabled):
   ```bash
   ~/Library/Android/sdk/platform-tools/adb install -r android/app/build/outputs/apk/release/app-release.apk
   ```

**Important:** The Android JS bundle at `android/app/src/main/assets/index.android.bundle` is NOT auto-rebuilt by Gradle. You must run the `npx react-native bundle` command manually after any JS/React changes, otherwise the APK will contain a stale bundle.

### Signing

- Release keystore: `android/keystores/release.keystore`
- Config: `android/keystores/release.keystore.properties`

### Verify fork is included

```bash
# iOS: check recording implementation is present. Marker current as of fork
# HEAD 2fb74e7f (2026-07). If it comes back 0, don't assume a stale install —
# the log wording changes over time; md5-compare the file against the fork's
# raw GitHub copy at the SHA pinned in package-lock.json before "fixing".
grep "Skipping stale teardown" node_modules/react-native-webrtc/ios/RCTWebRTC/HeyJoeVideoCapturer.m

# Android: check HeyJoeVideoCapturer is present
ls node_modules/react-native-webrtc/android/src/main/java/com/oney/WebRTCModule/HeyJoeVideoCapturer.java
```
