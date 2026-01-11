package org.jitsi.meet.sdk;

import android.media.MediaCodec;
import android.os.Environment;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.media.MediaMetadataRetriever;
import android.media.MediaMuxer;
import android.media.MediaRecorder;
import android.media.AudioRecord;
import android.media.AudioFormat;
import android.net.Uri;
import android.opengl.GLES20;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.view.Surface;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.module.annotations.ReactModule;

import org.webrtc.CapturerObserver;
import org.webrtc.EglBase;
import org.webrtc.GlRectDrawer;
import org.webrtc.RendererCommon;
import org.webrtc.SurfaceTextureHelper;
import org.webrtc.VideoCapturer;
import org.webrtc.VideoFrame;
import org.webrtc.VideoFrameDrawer;
import org.webrtc.VideoSink;
import org.webrtc.VideoTrack;

import com.oney.WebRTCModule.EglUtils;
import com.oney.WebRTCModule.WebRTCModule;

import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;

/**
 * Recording module V5 with proper structure
 */
@ReactModule(name = RecordModule.NAME)
public class RecordModule extends ReactContextBaseJavaModule {
    public static final String NAME = "Recorder";
    private static final String TAG = "RecordModule";

    // Video parameters
    private int encoderWidth = 1280;
    private int encoderHeight = 720;
    private int requestedWidth = 0;
    private int requestedHeight = 0;
    private int videoBitrate = 4000000;
    private static final int VIDEO_FPS = 30;
    private static final int IFRAME_INTERVAL = 1;

    private final ReactApplicationContext reactContext;

    // Recording state
    private volatile boolean isRecording = false;
    private volatile boolean isStoppingRecording = false;
    private String filePath;

    // Video components
    private VideoTrack videoTrack;
    private VideoSink videoSink;

    // Encoding components
    private MediaCodec videoEncoder;
    private MediaCodec audioEncoder;
    private MediaMuxer mediaMuxer;
    private Surface inputSurface;
    private int videoTrackIndex = -1;
    private int audioTrackIndex = -1;
    private boolean muxerStarted = false;

    // Synchronization
    private final Object muxerLock = new Object();

    // Video frame buffering
    private final List<EncodedFrame> bufferedVideoFrames = new ArrayList<>();

    // Threading
    private HandlerThread encoderThread;
    private Handler encoderHandler;
    private Thread videoDrainThread;
    private Thread audioDrainThread;
    private volatile boolean isVideoDrainRunning = false;
    private volatile boolean isAudioDrainRunning = false;

    // WebRTC rendering
    private EglBase recordingEglBase;
    private VideoFrameDrawer frameDrawer;
    private GlRectDrawer drawer;

    // Frame tracking
    private long frameCount = 0;
    private volatile long globalStartTimeNs = -1;

    // Audio components
    private Thread audioCaptureThread;
    private AudioCapture audioCapture;

    // Static instance
    private static RecordModule instance;

    // Helper class for buffering
    private static class EncodedFrame {
        ByteBuffer data;
        MediaCodec.BufferInfo info;

        EncodedFrame(ByteBuffer data, MediaCodec.BufferInfo info) {
            this.data = ByteBuffer.allocate(data.remaining());
            this.data.put(data);
            this.data.flip();
            this.info = new MediaCodec.BufferInfo();
            this.info.set(info.offset, info.size, info.presentationTimeUs, info.flags);
        }
    }

    public RecordModule(ReactApplicationContext context) {
        super(context);
        reactContext = context;
        instance = this;
    }

    @Override
    public String getName() {
        return NAME;
    }

    // Capturer wrapper class
    public static class RecordingCapturerWrapper implements VideoCapturer {
        private final VideoCapturer wrappedCapturer;

        public RecordingCapturerWrapper(VideoCapturer capturer) {
            this.wrappedCapturer = capturer;
            Log.d(TAG, "RecordingCapturerWrapper created");
        }

        @Override
        public void initialize(SurfaceTextureHelper surfaceTextureHelper, android.content.Context context, CapturerObserver capturerObserver) {
            CapturerObserver interceptingObserver = new CapturerObserver() {
                @Override
                public void onCapturerStarted(boolean success) {
                    capturerObserver.onCapturerStarted(success);
                }

                @Override
                public void onCapturerStopped() {
                    capturerObserver.onCapturerStopped();
                }

                @Override
                public void onFrameCaptured(VideoFrame frame) {
                    if (instance != null && instance.isRecording && instance.videoSink != null) {
                        instance.videoSink.onFrame(frame);
                    }
                    capturerObserver.onFrameCaptured(frame);
                }
            };

            wrappedCapturer.initialize(surfaceTextureHelper, context, interceptingObserver);
        }

        @Override
        public void startCapture(int width, int height, int framerate) {
            wrappedCapturer.startCapture(width, height, framerate);
        }

        @Override
        public void stopCapture() throws InterruptedException {
            wrappedCapturer.stopCapture();
        }

        @Override
        public void changeCaptureFormat(int width, int height, int framerate) {
            wrappedCapturer.changeCaptureFormat(width, height, framerate);
        }

        @Override
        public void dispose() {
            wrappedCapturer.dispose();
        }

        @Override
        public boolean isScreencast() {
            return wrappedCapturer.isScreencast();
        }
    }

    public static VideoCapturer wrapVideoCapturer(VideoCapturer capturer) {
        return new RecordingCapturerWrapper(capturer);
    }

    // Video sink implementation
    private class RecordingVideoSink implements VideoSink {
        private boolean firstFrame = true;

        @Override
        public void onFrame(VideoFrame frame) {
            if (!isRecording || inputSurface == null) {
                return;
            }

            if (firstFrame) {
                firstFrame = false;
                int frameWidth = frame.getBuffer().getWidth();
                int frameHeight = frame.getBuffer().getHeight();
                int rotation = frame.getRotation();

                Log.d(TAG, "First frame: " + frameWidth + "x" + frameHeight + ", rotation: " + rotation);
            }

            frameCount++;

            if (globalStartTimeNs == -1) {
                globalStartTimeNs = frame.getTimestampNs();
                Log.d(TAG, "Global start time set from first video frame: " + globalStartTimeNs);
            }

            final VideoFrame frameCopy = new VideoFrame(
                frame.getBuffer(),
                frame.getRotation(),
                frame.getTimestampNs()
            );
            frameCopy.retain();

            encoderHandler.post(() -> {
                if (!isRecording) {
                    frameCopy.release();
                    return;
                }

                try {
                    recordingEglBase.makeCurrent();
                    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
                    frameDrawer.drawFrame(frameCopy, drawer, null, 0, 0, encoderWidth, encoderHeight);

                    long presentationTimeNs = frameCopy.getTimestampNs() - globalStartTimeNs;
                    recordingEglBase.swapBuffers(presentationTimeNs);

                    if (frameCount % 30 == 0) {
                        Log.d(TAG, "Rendered " + frameCount + " frames");
                    }
                } catch (Exception e) {
                    Log.e(TAG, "Error rendering frame", e);
                } finally {
                    frameCopy.release();
                }
            });
        }
    }

    @ReactMethod
    public void startRecording(String trackId, int width, int height, int rate,
                               boolean mirror, String name, Promise promise) {
        startRecording(trackId, width, height, rate, mirror, name, true, promise);
    }

    @ReactMethod
    public void startRecording(String trackId, int width, int height, int rate,
                               boolean mirror, String name, boolean enable1080p, Promise promise) {
        Log.d(TAG, "startRecording called - requested dimensions: " + width + "x" + height + ", enable1080p: " + enable1080p);

        if (isRecording) {
            promise.reject("ALREADY_RECORDING", "Recording already in progress");
            return;
        }

        cleanup();

        requestedWidth = width;
        requestedHeight = height;

        if (enable1080p) {
            if (requestedHeight > requestedWidth) {
                encoderWidth = 1080;
                encoderHeight = 1920;
            } else {
                encoderWidth = 1920;
                encoderHeight = 1080;
            }
            Log.d(TAG, "1080p enabled - using dimensions: " + encoderWidth + "x" + encoderHeight);
        } else {
            if (requestedHeight > requestedWidth) {
                encoderWidth = 720;
                encoderHeight = 1280;
            } else {
                encoderWidth = 1280;
                encoderHeight = 720;
            }
            Log.d(TAG, "720p mode - using dimensions: " + encoderWidth + "x" + encoderHeight);
        }

        WebRTCModule module = reactContext.getNativeModule(WebRTCModule.class);
        videoTrack = (VideoTrack) module.getTrack(-1, trackId);

        if (videoTrack == null) {
            Log.e(TAG, "Video track is null");
            promise.reject("TRACK_NOT_FOUND", "Video track not found");
            return;
        }

        // Use public storage directory for Android
        File recordingsDir;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            recordingsDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "HeyJoe");
        } else {
            recordingsDir = new File(Environment.getExternalStorageDirectory(), "Movies/HeyJoe");
        }

        if (!recordingsDir.exists()) {
            recordingsDir.mkdirs();
        }
        filePath = recordingsDir.getAbsolutePath() + "/" + name + ".mp4";
        Log.d(TAG, "Recording will be saved to: " + filePath);

        encoderThread = new HandlerThread("VideoEncoder");
        encoderThread.start();
        encoderHandler = new Handler(encoderThread.getLooper());

        encoderHandler.post(() -> {
            try {
                setupEncoder();
                videoSink = new RecordingVideoSink();

                // Add the sink to the video track to receive frames
                videoTrack.addSink(videoSink);
                Log.d(TAG, "VideoSink added to VideoTrack");

                isRecording = true;
                startDrainThread();
                startAudioDrainThread();
                promise.resolve(filePath);
            } catch (Exception e) {
                Log.e(TAG, "Failed to start recording", e);
                cleanup();
                promise.reject("SETUP_ERROR", e.getMessage());
            }
        });
    }

    private void setupEncoder() throws IOException {
        videoTrackIndex = -1;
        audioTrackIndex = -1;
        muxerStarted = false;

        if (encoderWidth >= 1920 || encoderHeight >= 1920) {
            videoBitrate = 15000000;
        } else {
            videoBitrate = 8000000;
        }
        Log.d(TAG, "Using video bitrate: " + videoBitrate);

        mediaMuxer = new MediaMuxer(filePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4);
        // Note: Don't set rotation hint - VideoFrameDrawer handles frame rotation
        // and the encoder dimensions already match the output orientation

        MediaFormat videoFormat = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, encoderWidth, encoderHeight);
        videoFormat.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        videoFormat.setInteger(MediaFormat.KEY_BIT_RATE, videoBitrate);
        videoFormat.setInteger(MediaFormat.KEY_FRAME_RATE, VIDEO_FPS);
        videoFormat.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, IFRAME_INTERVAL);

        videoEncoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        videoEncoder.configure(videoFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        inputSurface = videoEncoder.createInputSurface();
        videoEncoder.start();

        MediaFormat audioFormat = MediaFormat.createAudioFormat(
            MediaFormat.MIMETYPE_AUDIO_AAC,
            44100,
            2
        );
        audioFormat.setInteger(MediaFormat.KEY_BIT_RATE, 192000);
        audioFormat.setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC);
        audioFormat.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384);

        audioEncoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC);
        audioEncoder.configure(audioFormat, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        audioEncoder.start();

        EglBase.Context sharedContext = EglUtils.getRootEglBaseContext();
        recordingEglBase = EglBase.create(sharedContext, EglBase.CONFIG_RECORDABLE);
        recordingEglBase.createSurface(inputSurface);
        recordingEglBase.makeCurrent();

        frameDrawer = new VideoFrameDrawer();
        drawer = new GlRectDrawer();

        audioCapture = new AudioCapture();
        audioCaptureThread = new Thread(audioCapture, "AudioCaptureThread");
        audioCaptureThread.start();

        Log.d(TAG, "Encoder setup complete with audio");
    }

    private void attemptStartMuxer() {
        synchronized (muxerLock) {
            if (!muxerStarted && videoTrackIndex != -1 && audioTrackIndex != -1) {
                try {
                    mediaMuxer.start();
                    muxerStarted = true;
                    Log.i(TAG, "MediaMuxer started with both video and audio tracks.");

                    if (!bufferedVideoFrames.isEmpty()) {
                        Log.d(TAG, "Writing " + bufferedVideoFrames.size() + " buffered video frames");
                        for (EncodedFrame frame : bufferedVideoFrames) {
                            mediaMuxer.writeSampleData(videoTrackIndex, frame.data, frame.info);
                        }
                        bufferedVideoFrames.clear();
                    }
                } catch (IllegalStateException e) {
                    Log.e(TAG, "Failed to start MediaMuxer: " + e.getMessage(), e);
                    isRecording = false;
                }
            }
        }
    }

    private void startDrainThread() {
        isVideoDrainRunning = true;
        videoDrainThread = new Thread(() -> {
            MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();

            while (isVideoDrainRunning || bufferInfo.flags != MediaCodec.BUFFER_FLAG_END_OF_STREAM) {
                int outputBufferIndex = videoEncoder.dequeueOutputBuffer(bufferInfo, 10000);

                if (outputBufferIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat newFormat = videoEncoder.getOutputFormat();
                    Log.d(TAG, "Video output format changed: " + newFormat);

                    synchronized (muxerLock) {
                        if (videoTrackIndex == -1) {
                            videoTrackIndex = mediaMuxer.addTrack(newFormat);
                            Log.d(TAG, "Video track added to muxer, index: " + videoTrackIndex);
                        }
                    }
                    attemptStartMuxer();
                } else if (outputBufferIndex >= 0) {
                    ByteBuffer outputBuffer = videoEncoder.getOutputBuffer(outputBufferIndex);

                    if (bufferInfo.size > 0) {
                        outputBuffer.position(bufferInfo.offset);
                        outputBuffer.limit(bufferInfo.offset + bufferInfo.size);

                        synchronized (muxerLock) {
                            if (muxerStarted) {
                                mediaMuxer.writeSampleData(videoTrackIndex, outputBuffer, bufferInfo);
                            } else {
                                bufferedVideoFrames.add(new EncodedFrame(outputBuffer, bufferInfo));
                                if (bufferedVideoFrames.size() % 30 == 0) {
                                    Log.d(TAG, "Buffered " + bufferedVideoFrames.size() + " video frames");
                                }
                            }
                        }
                    }

                    videoEncoder.releaseOutputBuffer(outputBufferIndex, false);

                    if ((bufferInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                        Log.d(TAG, "Video end of stream reached");
                        break;
                    }
                }
            }

            Log.d(TAG, "Video drain thread finished");
        }, "VideoDrain");
        videoDrainThread.start();
    }

    private void startAudioDrainThread() {
        isAudioDrainRunning = true;
        audioDrainThread = new Thread(() -> {
            while (isAudioDrainRunning) {
                try {
                    drainAudioEncoder(false);
                    Thread.sleep(10);
                } catch (InterruptedException e) {
                    break;
                } catch (Exception e) {
                    if (isAudioDrainRunning) {
                        Log.e(TAG, "Error in audio drain thread: " + e.getMessage());
                    }
                    break;
                }
            }

            Log.d(TAG, "Audio drain thread finished");
        }, "AudioDrain");
        audioDrainThread.start();
    }

    private void encodeAudioFrame(byte[] audioData, long presentationTimeUs) {
        if (!isRecording || isStoppingRecording || audioEncoder == null) {
            return;
        }

        try {
            int inputBufferIndex = audioEncoder.dequeueInputBuffer(10000);
            if (inputBufferIndex >= 0) {
                ByteBuffer inputBuffer = audioEncoder.getInputBuffer(inputBufferIndex);
                if (inputBuffer != null) {
                    inputBuffer.clear();
                    inputBuffer.put(audioData);

                    audioEncoder.queueInputBuffer(
                        inputBufferIndex,
                        0,
                        audioData.length,
                        presentationTimeUs,
                        0
                    );
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error encoding audio frame: " + e.getMessage());
        }
    }

    private void drainAudioEncoder(boolean endOfStream) {
        if (audioEncoder == null || isStoppingRecording) {
            return;
        }

        if (endOfStream) {
            try {
                int inputBufferIndex = audioEncoder.dequeueInputBuffer(10000);
                if (inputBufferIndex >= 0) {
                    audioEncoder.queueInputBuffer(inputBufferIndex, 0, 0, 0,
                        MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                    Log.d(TAG, "Sent END_OF_STREAM to audio encoder");
                }
            } catch (Exception e) {
                Log.e(TAG, "Error sending END_OF_STREAM to audio: " + e.getMessage());
            }
        }

        MediaCodec.BufferInfo bufferInfo = new MediaCodec.BufferInfo();
        int outputBufferIndex;

        try {
            while ((outputBufferIndex = audioEncoder.dequeueOutputBuffer(bufferInfo, 0)) >= 0) {
                ByteBuffer outputBuffer = audioEncoder.getOutputBuffer(outputBufferIndex);

                if (outputBuffer != null && bufferInfo.size > 0) {
                    outputBuffer.position(bufferInfo.offset);
                    outputBuffer.limit(bufferInfo.offset + bufferInfo.size);

                    synchronized (muxerLock) {
                        if (muxerStarted && audioTrackIndex != -1) {
                            mediaMuxer.writeSampleData(audioTrackIndex, outputBuffer, bufferInfo);
                        }
                    }
                }

                audioEncoder.releaseOutputBuffer(outputBufferIndex, false);

                if ((bufferInfo.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
                    Log.d(TAG, "Reached audio END_OF_STREAM");
                    break;
                }
            }

            if (outputBufferIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                MediaFormat newFormat = audioEncoder.getOutputFormat();
                Log.d(TAG, "Audio output format changed: " + newFormat);

                synchronized (muxerLock) {
                    if (audioTrackIndex == -1) {
                        audioTrackIndex = mediaMuxer.addTrack(newFormat);
                        Log.d(TAG, "Audio track added to muxer, index: " + audioTrackIndex);
                    }
                }
                attemptStartMuxer();
            }
        } catch (IllegalStateException e) {
            if (!isStoppingRecording) {
                Log.e(TAG, "Illegal state in audio drain: " + e.getMessage());
            }
        }
    }

    @ReactMethod
    public void stopRecording(Promise promise) {
        Log.d(TAG, "stopRecording called");

        if (!isRecording) {
            promise.resolve("No recording in progress");
            return;
        }

        isRecording = false;
        isStoppingRecording = true;
        isVideoDrainRunning = false;
        isAudioDrainRunning = false;

        // Remove the sink from the video track
        if (videoTrack != null && videoSink != null) {
            try {
                videoTrack.removeSink(videoSink);
                Log.d(TAG, "VideoSink removed from VideoTrack");
            } catch (Exception e) {
                Log.e(TAG, "Error removing VideoSink: " + e.getMessage());
            }
        }

        if (audioCapture != null) {
            audioCapture.stop();
            if (audioCaptureThread != null) {
                try {
                    audioCaptureThread.join(1000);
                } catch (InterruptedException e) {
                    Log.e(TAG, "Error waiting for audio thread");
                }
            }
        }

        if (audioDrainThread != null) {
            try {
                audioDrainThread.join(1000);
            } catch (InterruptedException e) {
                Log.e(TAG, "Error waiting for audio drain thread");
            }
        }

        encoderHandler.post(() -> {
            try {
                if (audioEncoder != null) {
                    drainAudioEncoder(true);
                    Thread.sleep(100);
                }

                videoEncoder.signalEndOfInputStream();

                if (videoDrainThread != null) {
                    try {
                        videoDrainThread.join(2000);
                    } catch (InterruptedException e) {
                        Log.e(TAG, "Error waiting for video drain thread");
                    }
                }

                if (videoEncoder != null) {
                    videoEncoder.stop();
                    videoEncoder.release();
                }

                if (audioEncoder != null) {
                    audioEncoder.stop();
                    audioEncoder.release();
                }

                synchronized (muxerLock) {
                    if (muxerStarted) {
                        mediaMuxer.stop();
                    }
                    mediaMuxer.release();
                }

                String fileSize = getFileSizeInHumanReadableFormat();
                Log.d(TAG, "Recording complete. File size: " + fileSize);

                cleanup();
                promise.resolve(fileSize);
            } catch (Exception e) {
                Log.e(TAG, "Error stopping recording", e);
                cleanup();
                promise.resolve("Error: " + e.getMessage());
            }
        });
    }

    private void cleanup() {
        try {
            if (frameDrawer != null) {
                frameDrawer.release();
                frameDrawer = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing frameDrawer", e);
        }

        try {
            if (drawer != null) {
                drawer.release();
                drawer = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing drawer", e);
        }

        try {
            if (recordingEglBase != null) {
                recordingEglBase.release();
                recordingEglBase = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error releasing EGL base", e);
        }

        try {
            if (encoderThread != null) {
                encoderThread.quitSafely();
                encoderThread = null;
                encoderHandler = null;
            }
        } catch (Exception e) {
            Log.e(TAG, "Error stopping encoder thread", e);
        }

        videoSink = null;
        videoTrack = null;
        audioCapture = null;
        audioCaptureThread = null;
        audioDrainThread = null;
        audioEncoder = null;
        videoEncoder = null;
        inputSurface = null;
        frameCount = 0;
        globalStartTimeNs = -1;
        muxerStarted = false;
        videoTrackIndex = -1;
        audioTrackIndex = -1;
        isStoppingRecording = false;
        isVideoDrainRunning = false;
        isAudioDrainRunning = false;
        videoDrainThread = null;
        bufferedVideoFrames.clear();

        Log.d(TAG, "Cleanup completed");
    }

    @ReactMethod
    public void getFileUri(String fileName, Promise promise) {
        try {
            File recordingsDir;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                recordingsDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "HeyJoe");
            } else {
                recordingsDir = new File(Environment.getExternalStorageDirectory(), "Movies/HeyJoe");
            }
            File file = new File(recordingsDir, fileName);

            if (file.exists()) {
                String uri = Uri.fromFile(file).toString();
                promise.resolve(uri);
            } else {
                promise.reject("FILE_NOT_FOUND", "Recording file not found");
            }
        } catch (Exception e) {
            promise.reject("ERROR", e.getMessage());
        }
    }

    @ReactMethod
    public void getRecordingInfo(String fileName, Promise promise) {
        try {
            Log.d(TAG, "getRecordingInfo called for: " + fileName);

            // Use public storage directory for Android
            File recordingsDir;
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
                recordingsDir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MOVIES), "HeyJoe");
            } else {
                recordingsDir = new File(Environment.getExternalStorageDirectory(), "Movies/HeyJoe");
            }
            File file = new File(recordingsDir, fileName);

            if (file.exists()) {
                WritableMap info = Arguments.createMap();
                info.putString("path", file.getAbsolutePath());
                info.putString("uri", Uri.fromFile(file).toString());
                info.putDouble("size", file.length());
                info.putString("name", file.getName());
                info.putString("fileName", file.getName());

                // Get rotation metadata from video file
                try {
                    MediaMetadataRetriever retriever = new MediaMetadataRetriever();
                    retriever.setDataSource(file.getAbsolutePath());

                    String rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                    String width = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
                    String height = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
                    String duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);

                    // Ensure rotation is not null
                    if (rotation == null) {
                        rotation = "0";
                    }

                    info.putString("rotation", rotation);
                    info.putString("videoWidth", width != null ? width : "0");
                    info.putString("videoHeight", height != null ? height : "0");
                    info.putString("duration", duration != null ? duration : "0");

                    // Debug logging
                    Log.d(TAG, "Video info for " + file.getName() + ":");
                    Log.d(TAG, "  - File exists: " + file.exists());
                    Log.d(TAG, "  - File path: " + file.getAbsolutePath());
                    Log.d(TAG, "  - Rotation: " + rotation + " degrees");
                    Log.d(TAG, "  - Dimensions: " + width + "x" + height);
                    Log.d(TAG, "  - Duration: " + duration + "ms");
                    Log.d(TAG, "  - File size: " + file.length() + " bytes");

                    retriever.release();

                    promise.resolve(info);
                } catch (Exception e) {
                    Log.e(TAG, "Error reading video metadata: " + e.getMessage(), e);
                    info.putString("rotation", "0");
                    info.putString("videoWidth", "0");
                    info.putString("videoHeight", "0");
                    info.putString("duration", "0");
                    promise.resolve(info);
                }
            } else {
                // Try the old location as fallback for existing recordings
                File oldRecordingsDir = new File(reactContext.getExternalFilesDir(null), "recordings");
                File oldFile = new File(oldRecordingsDir, fileName);

                if (oldFile.exists()) {
                    Log.d(TAG, "File found in old location, using that");
                    WritableMap info = Arguments.createMap();
                    info.putString("path", oldFile.getAbsolutePath());
                    info.putString("uri", Uri.fromFile(oldFile).toString());
                    info.putDouble("size", oldFile.length());
                    info.putString("name", oldFile.getName());
                    info.putString("fileName", oldFile.getName());
                    info.putString("rotation", "0");
                    info.putString("videoWidth", "0");
                    info.putString("videoHeight", "0");
                    info.putString("duration", "0");
                    promise.resolve(info);
                } else {
                    Log.e(TAG, "File not found in either location: " + file.getAbsolutePath());
                    promise.reject("FILE_NOT_FOUND", "Recording file not found: " + fileName);
                }
            }
        } catch (Exception e) {
            Log.e(TAG, "Error in getRecordingInfo: " + e.getMessage(), e);
            promise.reject("ERROR", e.getMessage());
        }
    }

    private String getFileSizeInHumanReadableFormat() {
        if (filePath == null) {
            return "No file path";
        }

        File file = new File(filePath);
        if (!file.exists()) {
            return "File not found";
        }

        long fileSizeInBytes = file.length();
        double size = fileSizeInBytes;
        String[] units = {"B", "KB", "MB", "GB", "TB"};
        int unitIndex = 0;

        while (size >= 1024 && unitIndex < units.length - 1) {
            size /= 1024;
            unitIndex++;
        }

        return String.format("%.2f %s", size, units[unitIndex]);
    }

    // Audio capture inner class
    private class AudioCapture implements Runnable {
        private static final int SAMPLE_RATE = 44100;
        private static final int CHANNEL_CONFIG = AudioFormat.CHANNEL_IN_STEREO;
        private static final int AUDIO_FORMAT = AudioFormat.ENCODING_PCM_16BIT;
        private final int bufferSize;
        private volatile boolean running = true;

        public AudioCapture() {
            this.bufferSize = AudioRecord.getMinBufferSize(
                SAMPLE_RATE, CHANNEL_CONFIG, AUDIO_FORMAT) * 2;
        }

        @Override
        public void run() {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_AUDIO);

            try {
                AudioRecord audioRecord = new AudioRecord(
                    MediaRecorder.AudioSource.DEFAULT,
                    SAMPLE_RATE,
                    CHANNEL_CONFIG,
                    AUDIO_FORMAT,
                    bufferSize
                );

                if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
                    Log.e(TAG, "AudioRecord failed to initialize");
                    return;
                }

                audioRecord.startRecording();
                Log.d(TAG, "Audio recording started");

                short[] audioBuffer = new short[bufferSize / 2];
                boolean firstAudioFrame = true;

                while (running && !isStoppingRecording) {
                    int samplesRead = audioRecord.read(audioBuffer, 0, audioBuffer.length);

                    if (samplesRead > 0) {
                        if (globalStartTimeNs == -1 && firstAudioFrame) {
                            globalStartTimeNs = System.nanoTime();
                            Log.d(TAG, "Global start time set from first audio frame: " + globalStartTimeNs);
                        }

                        firstAudioFrame = false;

                        long currentTimeNs = System.nanoTime();
                        long presentationTimeUs = (currentTimeNs - globalStartTimeNs) / 1000;

                        if (presentationTimeUs < 0) {
                            presentationTimeUs = 0;
                        }

                        ByteBuffer byteBuffer = ByteBuffer.allocate(samplesRead * 2);
                        byteBuffer.order(ByteOrder.nativeOrder());
                        byteBuffer.asShortBuffer().put(audioBuffer, 0, samplesRead);

                        RecordModule.this.encodeAudioFrame(byteBuffer.array(), presentationTimeUs);
                    }
                }

                audioRecord.stop();
                audioRecord.release();
                Log.d(TAG, "Audio recording stopped");

            } catch (Exception e) {
                Log.e(TAG, "Audio capture error: " + e.getMessage(), e);
            }
        }

        public void stop() {
            running = false;
        }
    }
}