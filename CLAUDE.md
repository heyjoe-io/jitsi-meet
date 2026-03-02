# CLAUDE.md — jitsi-meet (HeyJoe fork)

## Overview

This is HeyJoe's fork of Jitsi Meet, customized for the casting platform's video calling and local recording features. It builds iOS and Android apps that are distributed via TestFlight / App Store.

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

## Build & Deploy Checklist

Before building for TestFlight:

1. Ensure `package-lock.json` points to the latest fork commits (see above)
2. Run `npm install` then `cd ios && pod install`
3. Build and archive in Xcode
4. After uploading, verify the fix is in the installed module:
   ```bash
   # Example: check that the recording cleanup fix is present
   grep "Cleaning up stale compression session" node_modules/react-native-webrtc/ios/RCTWebRTC/HeyJoeVideoCapturer.m
   ```
