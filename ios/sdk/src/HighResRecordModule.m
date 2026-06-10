#import "HighResRecordModule.h"
#import <react-native-webrtc/HeyJoeVideoCapturer.h>
#import <React/RCTLog.h>
#import <React/RCTBridge.h>

@interface HighResRecordModule ()

@property (nonatomic, strong) NSString *currentFilePath;
@property (nonatomic, assign) BOOL hasListeners;

@end

@implementation HighResRecordModule

RCT_EXPORT_MODULE(HighResRecorder);

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _hasListeners = NO;

        // Listen for recording interruptions caused by capture stop (room transitions)
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleRecordingInterrupted:)
                                                     name:@"HeyJoeRecordingInterruptedDuringCaptureStop"
                                                   object:nil];

        // Listen for mid-stream recording failures (writer setup/append failures)
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleRecordingFailed:)
                                                     name:@"HeyJoeRecordingFailedMidStream"
                                                   object:nil];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

#pragma mark - RCTEventEmitter

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onRecordingInterrupted", @"onRecordingFailed"];
}

- (void)startObserving {
    self.hasListeners = YES;
}

- (void)stopObserving {
    self.hasListeners = NO;
}

- (void)handleRecordingInterrupted:(NSNotification *)notification {
    RCTLogInfo(@"[HighResRecorder] Recording interrupted during capture stop (room transition)");
    if (self.hasListeners) {
        [self sendEventWithName:@"onRecordingInterrupted" body:@{@"reason": @"captureStop"}];
    }
}

- (void)handleRecordingFailed:(NSNotification *)notification {
    NSString *errorMsg = notification.userInfo[@"error"] ?: @"Unknown error";
    RCTLogInfo(@"[HighResRecorder] Recording failed mid-stream: %@ (point=%@, domain=%@, code=%@)",
               errorMsg,
               notification.userInfo[@"failurePoint"] ?: @"unknown",
               notification.userInfo[@"domain"] ?: @"",
               notification.userInfo[@"code"] ?: @0);
    if (self.hasListeners) {
        NSMutableDictionary *body = [NSMutableDictionary dictionary];
        body[@"reason"] = @"writerFailed";
        body[@"error"] = notification.userInfo[@"error"] ?: @"Unknown error";
        body[@"domain"] = notification.userInfo[@"domain"] ?: @"";
        body[@"code"] = notification.userInfo[@"code"] ?: @0;
        body[@"underlyingError"] = notification.userInfo[@"underlyingError"] ?: @"";
        body[@"failurePoint"] = notification.userInfo[@"failurePoint"] ?: @"unknown";
        [self sendEventWithName:@"onRecordingFailed" body:body];
    }
}

#pragma mark - Input Sanitization

- (NSString *)sanitizeFileName:(NSString *)fileName {
    if (!fileName || fileName.length == 0) {
        NSTimeInterval timestamp = [[NSDate date] timeIntervalSince1970];
        return [NSString stringWithFormat:@"recording_%lld", (long long)timestamp];
    }

    NSString *sanitized = [fileName lastPathComponent];
    NSCharacterSet *invalidChars = [NSCharacterSet characterSetWithCharactersInString:@"/\\:*?\"<>|"];
    sanitized = [[sanitized componentsSeparatedByCharactersInSet:invalidChars] componentsJoinedByString:@"_"];

    if (sanitized.length == 0) {
        NSTimeInterval timestamp = [[NSDate date] timeIntervalSince1970];
        return [NSString stringWithFormat:@"recording_%lld", (long long)timestamp];
    }

    if (sanitized.length > 200) {
        sanitized = [sanitized substringToIndex:200];
    }

    return sanitized;
}

#pragma mark - Public Methods (React Native Bridge)

RCT_EXPORT_METHOD(startRecording:(NSString *)trackId
                  fileName:(NSString *)fileName
                  enable4K:(BOOL)enable4K
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    RCTLogInfo(@"[HighResRecorder] startRecording called with fileName: %@, enable4K: %d", fileName, enable4K);

    // Get the shared HeyJoeVideoCapturer instance
    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    if (!capturer) {
        RCTLogError(@"[HighResRecorder] No active capturer found. Is WebRTC video running?");
        reject(@"no_capturer", @"No active video capturer. Start a video call first.", nil);
        return;
    }

    // Fast atomic check — both flags are atomic, safe to read from any thread.
    // recordingActive is NO during Starting phase, so also check recordingStarting
    // to prevent double-start when JS calls startRecording twice rapidly.
    if (capturer.recordingActive || capturer.recordingStarting) {
        reject(@"already_recording", @"Recording is already in progress", nil);
        return;
    }

    NSString *safeFileName = [self sanitizeFileName:fileName];
    NSError *error = nil;

    // Setup file path
    NSString *fileNameWithExt = [safeFileName stringByAppendingPathExtension:@"mov"];
    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *documentsDirectory = [paths firstObject];
    NSString *recordingsDirectory = [documentsDirectory stringByAppendingPathComponent:@"recordings"];

    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:recordingsDirectory]) {
        [fileManager createDirectoryAtPath:recordingsDirectory withIntermediateDirectories:YES attributes:nil error:&error];
        if (error) {
            reject(@"file_error", @"Could not create recordings directory", error);
            return;
        }
    }

    // Check available disk space (require at least 100MB)
    NSDictionary *fsAttributes = [fileManager attributesOfFileSystemForPath:documentsDirectory error:nil];
    unsigned long long freeSpace = [[fsAttributes objectForKey:NSFileSystemFreeSize] unsignedLongLongValue];
    if (freeSpace < 100 * 1024 * 1024) {
        reject(@"disk_space", @"Insufficient disk space for recording", nil);
        return;
    }

    self.currentFilePath = [recordingsDirectory stringByAppendingPathComponent:fileNameWithExt];

    // Delete existing file if present
    if ([fileManager fileExistsAtPath:self.currentFilePath]) {
        [fileManager removeItemAtPath:self.currentFilePath error:nil];
    }

    NSURL *outputURL = [NSURL fileURLWithPath:self.currentFilePath];

    // Set recording resolution based on enable4K flag
    capturer.recordingTargetResolution = enable4K
        ? HeyJoeRecordingResolution4K
        : HeyJoeRecordingResolution1080p;
    RCTLogInfo(@"[HighResRecorder] Recording resolution set to: %s", enable4K ? "4K" : "1080p");

    // Start recording via the shared capturer (async, dispatches to recordingQueue)
    [capturer startRecordingToURL:outputURL completionHandler:^(NSError *recordError) {
        if (recordError) {
            RCTLogError(@"[HighResRecorder] Failed to start recording: %@", recordError);
            reject(@"recording_error", recordError.localizedDescription, recordError);
        } else {
            RCTLogInfo(@"[HighResRecorder] Recording started at %dx%d", capturer.videoWidth, capturer.videoHeight);
            resolve(@{
                @"filePath": self.currentFilePath,
                @"width": @(capturer.videoWidth),
                @"height": @(capturer.videoHeight)
            });
        }
    }];
}

RCT_EXPORT_METHOD(stopRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    RCTLogInfo(@"[HighResRecorder] stopRecording called");

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    if (!capturer) {
        reject(@"no_capturer", @"No active video capturer", nil);
        return;
    }

    // Fast atomic check — only read recordingActive (atomic).
    // Don't read recordingState here: it's nonatomic and queue-confined to recordingQueue.
    // If recordingActive is NO, stopRecording will handle the "not recording" case internally.
    if (!capturer.recordingActive) {
        reject(@"not_recording", @"No recording in progress", nil);
        return;
    }

    [capturer stopRecordingWithCompletionHandler:^(NSURL *fileURL, NSError *error) {
        if (error) {
            RCTLogError(@"[HighResRecorder] Failed to stop recording: %@", error);
            reject(@"recording_error", error.localizedDescription, error);
            return;
        }

        // Handle case where recording stopped before any frames were written
        if (!fileURL) {
            RCTLogInfo(@"[HighResRecorder] Recording stopped before any frames were captured");
            resolve(@{
                @"filePath": @"",
                @"fileSize": @"0 B",
                @"width": @(capturer.videoWidth),
                @"height": @(capturer.videoHeight)
            });
            return;
        }

        // Get file info
        NSError *fileError = nil;
        NSDictionary *fileAttributes = [[NSFileManager defaultManager]
                                        attributesOfItemAtPath:fileURL.path
                                        error:&fileError];

        NSString *formattedSize = @"0 B";
        if (fileAttributes && !fileError) {
            NSNumber *fileSize = fileAttributes[NSFileSize];
            if (fileSize) {
                formattedSize = [self formatFileSize:[fileSize unsignedLongLongValue]];
            }
        }

        RCTLogInfo(@"[HighResRecorder] Recording complete. Size: %@, Resolution: %dx%d",
                   formattedSize, capturer.videoWidth, capturer.videoHeight);

        resolve(@{
            @"filePath": fileURL.path,
            @"fileSize": formattedSize,
            @"width": @(capturer.videoWidth),
            @"height": @(capturer.videoHeight)
        });
    }];
}

RCT_EXPORT_METHOD(getRecordingCapabilities:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    int width = 1280;
    int height = 720;
    BOOL isRecording = NO;

    if (capturer) {
        width = capturer.videoWidth;
        height = capturer.videoHeight;
        isRecording = capturer.recordingActive;
    }

    NSString *quality = @"720p";
    if (width >= 3840 || height >= 2160) {
        quality = @"4K";
    } else if (width >= 1920 || height >= 1080) {
        quality = @"1080p";
    }

    NSDictionary *capabilities = @{
        @"maxWidth": @(width),
        @"maxHeight": @(height),
        @"quality": quality,
        @"codec": @"H.265/HEVC",
        @"supportsHEVC": @(YES),
        @"isRecording": @(isRecording),
        @"capturerActive": @(capturer != nil),
        @"isCapturing": @(capturer != nil && capturer.isCapturing)
    };

    resolve(capabilities);
}

#pragma mark - Recording State Reset

RCT_EXPORT_METHOD(forceResetRecordingState:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    RCTLogInfo(@"[HighResRecorder] forceResetRecordingState called");

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    // Fast atomic check — no locks needed
    if (capturer && capturer.recordingActive) {
        RCTLogInfo(@"[HighResRecorder] Force-stopping stale native recording");
        [capturer stopRecordingWithCompletionHandler:^(NSURL *fileURL, NSError *error) {
            if (error) {
                RCTLogInfo(@"[HighResRecorder] Force-stop completed with error (expected): %@", error);
            } else {
                RCTLogInfo(@"[HighResRecorder] Force-stop completed, file: %@", fileURL);
            }
            resolve(@{
                @"wasRecording": @(YES),
                @"isRecordingNow": @(capturer.recordingActive)
            });
        }];
    } else {
        resolve(@{
            @"wasRecording": @(NO),
            @"isRecordingNow": @(NO)
        });
    }
}

#pragma mark - Zoom Control

RCT_EXPORT_METHOD(setZoomFactor:(double)zoomFactor
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    RCTLogInfo(@"[HighResRecorder] setZoomFactor called with: %.2f", zoomFactor);

    if (isnan(zoomFactor) || isinf(zoomFactor)) {
        reject(@"invalid_input", @"Zoom factor must be a valid number", nil);
        return;
    }

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    if (!capturer) {
        reject(@"no_capturer", @"No active video capturer. Start a video call first.", nil);
        return;
    }

    [capturer setZoomFactor:(CGFloat)zoomFactor
          completionHandler:^(CGFloat actualZoom, CGFloat minZoom, CGFloat maxZoom, NSError *error) {
        if (error) {
            reject(@"zoom_error", error.localizedDescription, error);
        } else {
            resolve(@{
                @"zoomFactor": @(actualZoom),
                @"minZoom": @(minZoom),
                @"maxZoom": @(maxZoom)
            });
        }
    }];
}

RCT_EXPORT_METHOD(getZoomInfo:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    if (!capturer) {
        reject(@"no_capturer", @"No active video capturer. Start a video call first.", nil);
        return;
    }

    [capturer getZoomInfoWithCompletionHandler:^(CGFloat currentZoom, CGFloat minZoom, CGFloat maxZoom) {
        resolve(@{
            @"currentZoom": @(currentZoom),
            @"minZoom": @(minZoom),
            @"maxZoom": @(maxZoom)
        });
    }];
}

RCT_EXPORT_METHOD(setZoomFactorImmediate:(double)zoomFactor) {
    if (isnan(zoomFactor) || isinf(zoomFactor)) {
        return;
    }

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    if (!capturer) {
        return;
    }

    // Fire-and-forget direct set for slider/drag tracking (no promise to keep it cheap).
    [capturer setZoomFactorImmediate:(CGFloat)zoomFactor];
}

RCT_EXPORT_METHOD(getZoomConfig:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

    if (!capturer) {
        reject(@"no_capturer", @"No active video capturer. Start a video call first.", nil);
        return;
    }

    [capturer getZoomConfigWithCompletionHandler:^(NSDictionary *config) {
        resolve(config);
    }];
}

#pragma mark - Helper Methods

- (BOOL)isRecording {
    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];
    return capturer && capturer.recordingActive;
}

- (NSString *)formatFileSize:(unsigned long long)size {
    NSArray *units = @[@"B", @"KB", @"MB", @"GB", @"TB"];
    double convertedSize = (double)size;
    int unitIndex = 0;

    while (convertedSize >= 1024 && unitIndex < units.count - 1) {
        convertedSize /= 1024;
        unitIndex++;
    }

    return [NSString stringWithFormat:@"%.2f %@", convertedSize, units[unitIndex]];
}

@end
