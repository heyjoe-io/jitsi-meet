# Setting Up react-native-webrtc Fork for HeyJoe

## Step 1: Fork on GitHub
1. Go to https://github.com/react-native-webrtc/react-native-webrtc
2. Click "Fork"
3. Select **heyjoe-io** organization
4. Keep name as `react-native-webrtc`

Result: `github.com/heyjoe-io/react-native-webrtc`

## Step 2: Clone Your Fork
```bash
cd /Users/yasith/Dev/HeyJoe
git clone git@github.com:heyjoe-io/react-native-webrtc.git react-native-webrtc-fork
cd react-native-webrtc-fork
```

## Step 3: Create Branch and Copy Files
```bash
# Create branch based on v124.0.4 (current version used by jitsi-meet)
git checkout -b heyjoe-recording v124.0.4

# Copy the modified files
cp /Users/yasith/Dev/HeyJoe/jitsi-meet/patches-for-fork/HeyJoeVideoCapturer.h ios/RCTWebRTC/
cp /Users/yasith/Dev/HeyJoe/jitsi-meet/patches-for-fork/HeyJoeVideoCapturer.m ios/RCTWebRTC/
cp /Users/yasith/Dev/HeyJoe/jitsi-meet/patches-for-fork/VideoCaptureController.h ios/RCTWebRTC/
cp /Users/yasith/Dev/HeyJoe/jitsi-meet/patches-for-fork/VideoCaptureController.m ios/RCTWebRTC/
```

## Step 4: Commit and Push
```bash
git add .
git commit -m "Add HeyJoeVideoCapturer for native resolution iOS recording

- Add HeyJoeVideoCapturer.h/m for unified capture session
- Modify VideoCaptureController to use HeyJoeVideoCapturer
- Supports 4K/native resolution recording with H.265/HEVC
- Single session architecture avoids iOS camera conflicts"

git push -u origin heyjoe-recording
```

## Step 5: Install in jitsi-meet
package.json has already been updated. Run:
```bash
cd /Users/yasith/Dev/HeyJoe/jitsi-meet
rm -rf node_modules/react-native-webrtc
npm install
cd ios && pod install
```

## What Changed in package.json

**Dependencies:**
```json
"react-native-webrtc": "github:heyjoe-io/react-native-webrtc#heyjoe-recording"
```

**Overrides (ensures fork is used even after Jitsi updates):**
```json
"overrides": {
  "react-native-webrtc": "github:heyjoe-io/react-native-webrtc#heyjoe-recording"
}
```

---

## Future Maintenance

### Updating from Upstream react-native-webrtc
When react-native-webrtc releases a new version:
```bash
cd /Users/yasith/Dev/HeyJoe/react-native-webrtc-fork
git remote add upstream https://github.com/react-native-webrtc/react-native-webrtc.git
git fetch upstream --tags
git checkout heyjoe-recording
git merge v125.0.0  # new version tag
# Resolve conflicts if any (usually none)
git push origin heyjoe-recording
```

Then in jitsi-meet:
```bash
rm -rf node_modules/react-native-webrtc
npm install
cd ios && pod install
```

### After Pulling Jitsi Updates
The `overrides` section ensures your fork is always used, even if Jitsi changes their package.json.

---

## Files in This Directory
- `HeyJoeVideoCapturer.h` - Header for unified video capturer
- `HeyJoeVideoCapturer.m` - Implementation (single AVCaptureSession for WebRTC + recording)
- `VideoCaptureController.h` - Modified header (exposes heyJoeCapturer)
- `VideoCaptureController.m` - Modified to use HeyJoeVideoCapturer
