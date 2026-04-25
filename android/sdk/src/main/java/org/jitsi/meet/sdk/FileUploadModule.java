package org.jitsi.meet.sdk;

import android.util.Log;

import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.facebook.react.module.annotations.ReactModule;

import java.io.File;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

import javax.annotation.Nonnull;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okio.Buffer;
import okio.BufferedSink;
import okio.ForwardingSink;
import okio.Okio;
import okio.Sink;

/**
 * Native module for uploading files via pure OkHttp, bypassing React Native's
 * networking layer which has issues with large multipart uploads on RN 0.79.
 */
@ReactModule(name = FileUploadModule.NAME)
class FileUploadModule extends ReactContextBaseJavaModule {
    public static final String NAME = "FileUploadModule";
    private static final String TAG = "FileUploadModule";

    private final OkHttpClient client;

    public FileUploadModule(@Nonnull ReactApplicationContext reactContext) {
        super(reactContext);
        client = new OkHttpClient.Builder()
                .connectTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(300, TimeUnit.SECONDS)
                .readTimeout(120, TimeUnit.SECONDS)
                .build();
    }

    @Override
    public String getName() {
        return NAME;
    }

    @ReactMethod
    public void uploadFile(String url, String filePath, String token,
                           String sessionId, String groupId, String upKey,
                           Promise promise) {
        // Strip file:// prefix if present
        String cleanPath = filePath.replaceFirst("^file://", "");
        File file = new File(cleanPath);

        Log.w(TAG, "Starting upload: " + file.getName() + " (" + file.length() + " bytes)");

        if (!file.exists()) {
            promise.reject("FILE_NOT_FOUND", "File not found: " + cleanPath);
            return;
        }

        // Run upload with retries on a background thread
        new Thread(() -> {
            int maxAttempts = 3;
            for (int attempt = 1; attempt <= maxAttempts; attempt++) {
                Log.w(TAG, "Attempt " + attempt + "/" + maxAttempts);
                sendProgress(0);

                try {
                    // Build a fresh OkHttp client per attempt with shorter read timeout
                    // to detect stalled connections faster
                    OkHttpClient attemptClient = client.newBuilder()
                            .readTimeout(30, TimeUnit.SECONDS)
                            .build();

                    MultipartBody.Builder bodyBuilder = new MultipartBody.Builder()
                            .setType(MultipartBody.FORM)
                            .addFormDataPart("file", file.getName(),
                                    RequestBody.create(MediaType.parse("video/mp4"), file))
                            .addFormDataPart("session", sessionId)
                            .addFormDataPart("group", groupId);

                    if (upKey != null && !upKey.isEmpty()) {
                        bodyBuilder.addFormDataPart("upKey", upKey);
                    }

                    RequestBody requestBody = bodyBuilder.build();
                    long totalBytes = file.length();

                    // Wrap with progress tracking
                    RequestBody progressBody = new RequestBody() {
                        @Override public MediaType contentType() { return requestBody.contentType(); }
                        @Override public long contentLength() throws IOException { return requestBody.contentLength(); }
                        @Override public void writeTo(@Nonnull BufferedSink sink) throws IOException {
                            BufferedSink bufferedSink = Okio.buffer(new ForwardingSink(sink) {
                                long bytesWritten = 0;
                                int lastProgress = -1;
                                @Override public void write(@Nonnull Buffer source, long byteCount) throws IOException {
                                    super.write(source, byteCount);
                                    bytesWritten += byteCount;
                                    int progress = (int) (100 * bytesWritten / totalBytes);
                                    if (progress != lastProgress) {
                                        lastProgress = progress;
                                        sendProgress(Math.min(progress, 100));
                                    }
                                }
                            });
                            requestBody.writeTo(bufferedSink);
                            bufferedSink.flush();
                        }
                    };

                    Request request = new Request.Builder()
                            .url(url)
                            .addHeader("Accept", "application/json")
                            .addHeader("Authorization", "Bearer " + token)
                            .post(progressBody)
                            .build();

                    // Synchronous call on this background thread
                    Response response = attemptClient.newCall(request).execute();
                    String body = response.body() != null ? response.body().string() : "";
                    Log.w(TAG, "Response: " + response.code());

                    if (response.isSuccessful()) {
                        promise.resolve(body);
                        return;
                    } else {
                        Log.w(TAG, "Server error: " + response.code() + " " + body.substring(0, Math.min(body.length(), 200)));
                        if (attempt == maxAttempts) {
                            promise.reject("HTTP_ERROR", "HTTP " + response.code() + ": " + body);
                            return;
                        }
                    }
                } catch (IOException e) {
                    Log.w(TAG, "Attempt " + attempt + " failed: " + e.getMessage());
                    if (attempt == maxAttempts) {
                        promise.reject("UPLOAD_FAILED", e.getMessage(), e);
                        return;
                    }
                }

                // Wait before retry
                try { Thread.sleep(2000); } catch (InterruptedException ignored) {}
            }
        }).start();
    }

    private void sendProgress(int progress) {
        ReactApplicationContext ctx = getReactApplicationContext();
        if (ctx.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putInt("progress", progress);
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("FileUploadProgress", params);
        }
    }
}
