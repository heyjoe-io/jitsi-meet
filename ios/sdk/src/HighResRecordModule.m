#import "HighResRecordModule.h"
#import <react-native-webrtc/HeyJoeVideoCapturer.h>
#import <React/RCTLog.h>
#import <React/RCTBridge.h>

@interface HighResRecordModule ()

@property (nonatomic, strong) NSString *currentFilePath;
@property (nonatomic, strong) dispatch_queue_t recordingQueue;
@property (nonatomic, strong) NSLock *stateLock;

@end

@implementation HighResRecordModule

RCT_EXPORT_MODULE(HighResRecorder);

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        _recordingQueue = dispatch_queue_create("com.heyjoe.highres.recording", DISPATCH_QUEUE_SERIAL);
        _stateLock = [[NSLock alloc] init];
    }
    return self;
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
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    RCTLogInfo(@"[HighResRecorder] startRecording called with fileName: %@", fileName);

    dispatch_async(self.recordingQueue, ^{
        // Get the shared HeyJoeVideoCapturer instance
        HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

        if (!capturer) {
            RCTLogError(@"[HighResRecorder] No active capturer found. Is WebRTC video running?");
            dispatch_async(dispatch_get_main_queue(), ^{
                reject(@"no_capturer", @"No active video capturer. Start a video call first.", nil);
            });
            return;
        }

        if (capturer.isRecording) {
            dispatch_async(dispatch_get_main_queue(), ^{
                reject(@"already_recording", @"Recording is already in progress", nil);
            });
            return;
        }

        NSString *safeFileName = [self sanitizeFileName:fileName];
        NSError *error = nil;

        // Setup file path
        NSString *fileNameWithExt = [safeFileName stringByAppendingPathExtension:@"mp4"];
        NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
        NSString *documentsDirectory = [paths firstObject];
        NSString *recordingsDirectory = [documentsDirectory stringByAppendingPathComponent:@"recordings"];

        NSFileManager *fileManager = [NSFileManager defaultManager];
        if (![fileManager fileExistsAtPath:recordingsDirectory]) {
            [fileManager createDirectoryAtPath:recordingsDirectory withIntermediateDirectories:YES attributes:nil error:&error];
            if (error) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    reject(@"file_error", @"Could not create recordings directory", error);
                });
                return;
            }
        }

        // Check available disk space (require at least 100MB)
        NSDictionary *fsAttributes = [fileManager attributesOfFileSystemForPath:documentsDirectory error:nil];
        unsigned long long freeSpace = [[fsAttributes objectForKey:NSFileSystemFreeSize] unsignedLongLongValue];
        if (freeSpace < 100 * 1024 * 1024) {
            dispatch_async(dispatch_get_main_queue(), ^{
                reject(@"disk_space", @"Insufficient disk space for recording", nil);
            });
            return;
        }

        [self.stateLock lock];
        self.currentFilePath = [recordingsDirectory stringByAppendingPathComponent:fileNameWithExt];
        [self.stateLock unlock];

        // Delete existing file if present
        if ([fileManager fileExistsAtPath:self.currentFilePath]) {
            [fileManager removeItemAtPath:self.currentFilePath error:nil];
        }

        NSURL *outputURL = [NSURL fileURLWithPath:self.currentFilePath];

        // Start recording via the shared capturer
        [capturer startRecordingToURL:outputURL completionHandler:^(NSError *recordError) {
            if (recordError) {
                RCTLogError(@"[HighResRecorder] Failed to start recording: %@", recordError);
                dispatch_async(dispatch_get_main_queue(), ^{
                    reject(@"recording_error", recordError.localizedDescription, recordError);
                });
            } else {
                RCTLogInfo(@"[HighResRecorder] Recording started at %dx%d", capturer.videoWidth, capturer.videoHeight);
                dispatch_async(dispatch_get_main_queue(), ^{
                    resolve(@{
                        @"filePath": self.currentFilePath,
                        @"width": @(capturer.videoWidth),
                        @"height": @(capturer.videoHeight)
                    });
                });
            }
        }];
    });
}

RCT_EXPORT_METHOD(stopRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    RCTLogInfo(@"[HighResRecorder] stopRecording called");

    dispatch_async(self.recordingQueue, ^{
        HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

        if (!capturer) {
            dispatch_async(dispatch_get_main_queue(), ^{
                reject(@"no_capturer", @"No active video capturer", nil);
            });
            return;
        }

        if (!capturer.isRecording) {
            dispatch_async(dispatch_get_main_queue(), ^{
                reject(@"not_recording", @"No recording in progress", nil);
            });
            return;
        }

        [capturer stopRecordingWithCompletionHandler:^(NSURL *fileURL, NSError *error) {
            if (error) {
                RCTLogError(@"[HighResRecorder] Failed to stop recording: %@", error);
                dispatch_async(dispatch_get_main_queue(), ^{
                    reject(@"recording_error", error.localizedDescription, error);
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

            dispatch_async(dispatch_get_main_queue(), ^{
                resolve(@{
                    @"filePath": fileURL.path,
                    @"fileSize": formattedSize,
                    @"width": @(capturer.videoWidth),
                    @"height": @(capturer.videoHeight)
                });
            });
        }];
    });
}

RCT_EXPORT_METHOD(getRecordingCapabilities:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {

    dispatch_async(self.recordingQueue, ^{
        HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];

        int width = 1280;
        int height = 720;
        BOOL isRecording = NO;

        if (capturer) {
            width = capturer.videoWidth;
            height = capturer.videoHeight;
            isRecording = capturer.isRecording;
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
            @"capturerActive": @(capturer != nil)
        };

        dispatch_async(dispatch_get_main_queue(), ^{
            resolve(capabilities);
        });
    });
}

#pragma mark - Helper Methods

- (BOOL)isRecording {
    HeyJoeVideoCapturer *capturer = [HeyJoeVideoCapturer sharedInstance];
    return capturer && capturer.isRecording;
}

- (NSString *)currentFilePath {
    [self.stateLock lock];
    NSString *path = _currentFilePath;
    [self.stateLock unlock];
    return path;
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
