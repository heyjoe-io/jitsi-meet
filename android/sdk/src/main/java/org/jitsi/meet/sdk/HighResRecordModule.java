package org.jitsi.meet.sdk;

import android.net.Uri;
import android.os.StatFs;
import android.util.Log;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.UiThreadUtil;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import com.oney.WebRTCModule.HeyJoeVideoCapturer;

import java.io.File;
import java.io.IOException;

/**
 * React Native bridge module for high-resolution local recording on Android.
 * Mirrors the iOS HighResRecordModule — registered as NativeModules.HighResRecorder
 * so the same JS code works on both platforms.
 *
 * Uses HeyJoeVideoCapturer (which wraps Camera2Capturer) to record at 1080p or 4K
 * directly from the camera, independent of WebRTC's negotiated resolution.
 */
@ReactModule(name = HighResRecordModule.NAME)
public class HighResRecordModule extends ReactContextBaseJavaModule {
    public static final String NAME = "HighResRecorder";
    private static final String TAG = "HighResRecordModule";

    private static final long MIN_FREE_SPACE_BYTES = 100 * 1024 * 1024; // 100 MB

    private final ReactApplicationContext reactContext;
    private String currentFilePath;

    public HighResRecordModule(ReactApplicationContext context) {
        super(context);
        this.reactContext = context;
    }

    @Override
    public String getName() {
        return NAME;
    }

    /**
     * Start recording at high resolution.
     * Promise is resolved only after the native pipeline is fully set up (or rejected on error).
     *
     * @param trackId   WebRTC video track ID (for compatibility with iOS API; not used on Android
     *                  since HeyJoeVideoCapturer intercepts at the source)
     * @param fileName  Base file name (without extension)
     * @param enable4K  true for 4K, false for 1080p
     * @param promise   Returns {filePath, width, height}
     */
    @ReactMethod
    public void startRecording(String trackId, String fileName, boolean enable4K, Promise promise) {
        Log.d(TAG, "startRecording called: fileName=" + fileName + ", enable4K=" + enable4K);

        HeyJoeVideoCapturer capturer = HeyJoeVideoCapturer.getInstance();

        if (!capturer.isCapturing()) {
            Log.e(TAG, "No active capturer. Is WebRTC video running?");
            promise.reject("no_capturer", "No active video capturer. Start a video call first.");
            return;
        }

        if (capturer.isRecording() || capturer.isStartingOrRecording()) {
            promise.reject("already_recording", "Recording is already in progress");
            return;
        }

        // Sanitize file name
        String safeFileName = sanitizeFileName(fileName);

        // Setup recordings directory (app-internal storage)
        File recordingsDir = new File(reactContext.getFilesDir(), "recordings");
        if (!recordingsDir.exists()) {
            if (!recordingsDir.mkdirs()) {
                promise.reject("file_error", "Could not create recordings directory");
                return;
            }
        }

        // Check disk space
        StatFs stat = new StatFs(recordingsDir.getAbsolutePath());
        long freeSpace = stat.getAvailableBytes();
        if (freeSpace < MIN_FREE_SPACE_BYTES) {
            promise.reject("disk_space", "Insufficient disk space for recording (need 100MB, have "
                    + (freeSpace / 1024 / 1024) + "MB)");
            return;
        }

        currentFilePath = recordingsDir.getAbsolutePath() + "/" + safeFileName + ".mp4";

        // Delete existing file if present
        File existing = new File(currentFilePath);
        if (existing.exists()) {
            existing.delete();
        }

        Log.d(TAG, "Starting recording to: " + currentFilePath);

        final String savedFilePath = currentFilePath;

        // Start recording with callback — promise resolved only after pipeline is ready
        capturer.startRecording(currentFilePath, enable4K, (width, height, error) -> {
            UiThreadUtil.runOnUiThread(() -> {
                if (error != null) {
                    Log.e(TAG, "Failed to start recording: " + error);
                    promise.reject("recording_error", "Could not start recording: " + error);
                } else {
                    WritableMap result = Arguments.createMap();
                    result.putString("filePath", savedFilePath);
                    result.putInt("width", width);
                    result.putInt("height", height);
                    promise.resolve(result);
                }
            });
        });
    }

    /**
     * Stop recording.
     *
     * @param promise Returns {filePath, fileSize, width, height}
     */
    @ReactMethod
    public void stopRecording(Promise promise) {
        Log.d(TAG, "stopRecording called");

        HeyJoeVideoCapturer capturer = HeyJoeVideoCapturer.getInstance();

        if (!capturer.isRecording()) {
            promise.reject("not_recording", "No recording in progress");
            return;
        }

        capturer.stopRecording((filePath, fileSize, width, height, error) -> {
            // Callback fires on encoder thread — must dispatch to UI thread for RN promise
            UiThreadUtil.runOnUiThread(() -> {
                if (error != null) {
                    Log.e(TAG, "Error stopping recording: " + error);
                    promise.reject("recording_error", error);
                    return;
                }

                String formattedSize = formatFileSize(fileSize);
                Log.d(TAG, "Recording stopped. Size: " + formattedSize
                        + ", Resolution: " + width + "x" + height);

                WritableMap result = Arguments.createMap();
                result.putString("filePath", filePath != null ? filePath : "");
                result.putString("fileSize", formattedSize);
                result.putInt("width", width);
                result.putInt("height", height);
                promise.resolve(result);
            });
        });
    }

    /**
     * Get recording capabilities and current state.
     *
     * @param promise Returns {maxWidth, maxHeight, quality, isRecording, capturerActive, isCapturing}
     */
    @ReactMethod
    public void getRecordingCapabilities(Promise promise) {
        HeyJoeVideoCapturer capturer = HeyJoeVideoCapturer.getInstance();

        int width = 1280;
        int height = 720;
        boolean isRecording = false;
        boolean isCapturing = false;

        if (capturer != null) {
            width = capturer.getVideoWidth();
            height = capturer.getVideoHeight();
            isRecording = capturer.isRecording();
            isCapturing = capturer.isCapturing();
        }

        String quality = "720p";
        if (width >= 3840 || height >= 2160) {
            quality = "4K";
        } else if (width >= 1920 || height >= 1080) {
            quality = "1080p";
        }

        WritableMap capabilities = Arguments.createMap();
        capabilities.putInt("maxWidth", width);
        capabilities.putInt("maxHeight", height);
        capabilities.putString("quality", quality);
        capabilities.putBoolean("isRecording", isRecording);
        capabilities.putBoolean("capturerActive", capturer != null);
        capabilities.putBoolean("isCapturing", isCapturing);

        promise.resolve(capabilities);
    }

    /**
     * Force reset recording state — cleanup after room transitions.
     *
     * @param promise Returns {wasRecording, isRecordingNow}
     */
    @ReactMethod
    public void forceResetRecordingState(Promise promise) {
        Log.d(TAG, "forceResetRecordingState called");

        HeyJoeVideoCapturer capturer = HeyJoeVideoCapturer.getInstance();

        boolean wasRecording = false;
        if (capturer != null) {
            wasRecording = capturer.forceResetRecordingState();
        }

        WritableMap result = Arguments.createMap();
        result.putBoolean("wasRecording", wasRecording);
        result.putBoolean("isRecordingNow", capturer != null && capturer.isRecording());
        promise.resolve(result);
    }

    /**
     * Get file URI for a recording (for playback / sharing).
     */
    @ReactMethod
    public void getFileUri(String fileName, Promise promise) {
        try {
            File file = resolveRecordingFile(fileName);

            if (file != null && file.exists()) {
                String uri = Uri.fromFile(file).toString();
                promise.resolve(uri);
            } else {
                promise.reject("FILE_NOT_FOUND", "Recording file not found");
            }
        } catch (Exception e) {
            promise.reject("ERROR", e.getMessage());
        }
    }

    /**
     * Get recording file info (for video playback metadata).
     */
    @ReactMethod
    public void getRecordingInfo(String fileName, Promise promise) {
        try {
            File file = resolveRecordingFile(fileName);

            if (file == null || !file.exists()) {
                promise.reject("FILE_NOT_FOUND", "Recording file not found: " + fileName);
                return;
            }

            WritableMap info = Arguments.createMap();
            info.putString("path", file.getAbsolutePath());
            info.putString("uri", Uri.fromFile(file).toString());
            info.putDouble("size", file.length());
            info.putString("name", file.getName());
            info.putString("fileName", file.getName());

            try {
                android.media.MediaMetadataRetriever retriever = new android.media.MediaMetadataRetriever();
                retriever.setDataSource(file.getAbsolutePath());

                String rotation = retriever.extractMetadata(
                        android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                String width = retriever.extractMetadata(
                        android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
                String height = retriever.extractMetadata(
                        android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
                String duration = retriever.extractMetadata(
                        android.media.MediaMetadataRetriever.METADATA_KEY_DURATION);

                info.putString("rotation", rotation != null ? rotation : "0");
                info.putString("videoWidth", width != null ? width : "0");
                info.putString("videoHeight", height != null ? height : "0");
                info.putString("duration", duration != null ? duration : "0");

                retriever.release();
            } catch (Exception e) {
                Log.e(TAG, "Error reading video metadata: " + e.getMessage());
                info.putString("rotation", "0");
                info.putString("videoWidth", "0");
                info.putString("videoHeight", "0");
                info.putString("duration", "0");
            }

            promise.resolve(info);
        } catch (Exception e) {
            Log.e(TAG, "Error in getRecordingInfo: " + e.getMessage());
            promise.reject("ERROR", e.getMessage());
        }
    }

    // --- Helper methods ---

    /**
     * Resolve a recording file name to a File, with path traversal protection.
     * Returns null if the resolved path escapes the recordings directory.
     */
    private File resolveRecordingFile(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return null;
        }

        File recordingsDir = new File(reactContext.getFilesDir(), "recordings");
        File file = new File(recordingsDir, fileName);

        // Path traversal protection: ensure resolved path stays inside recordings dir
        try {
            String canonicalDir = recordingsDir.getCanonicalPath();
            String canonicalFile = file.getCanonicalPath();
            if (!canonicalFile.startsWith(canonicalDir + File.separator)
                    && !canonicalFile.equals(canonicalDir)) {
                Log.e(TAG, "Path traversal attempt blocked: " + fileName);
                return null;
            }
        } catch (IOException e) {
            Log.e(TAG, "Error resolving canonical path: " + e.getMessage());
            return null;
        }

        return file;
    }

    private void sendEvent(String eventName, WritableMap params) {
        try {
            reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit(eventName, params);
        } catch (Exception e) {
            Log.e(TAG, "Error sending event " + eventName + ": " + e.getMessage());
        }
    }

    private String sanitizeFileName(String fileName) {
        if (fileName == null || fileName.isEmpty()) {
            return "recording_" + System.currentTimeMillis();
        }

        // Remove path separators and invalid characters
        String sanitized = fileName.replaceAll("[/\\\\:*?\"<>|]", "_");

        if (sanitized.isEmpty()) {
            return "recording_" + System.currentTimeMillis();
        }

        if (sanitized.length() > 200) {
            sanitized = sanitized.substring(0, 200);
        }

        return sanitized;
    }

    private String formatFileSize(long sizeBytes) {
        double size = sizeBytes;
        String[] units = {"B", "KB", "MB", "GB", "TB"};
        int unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return String.format("%.2f %s", size, units[unitIndex]);
    }
}
