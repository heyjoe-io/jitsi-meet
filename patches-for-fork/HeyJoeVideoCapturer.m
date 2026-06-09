#import "HeyJoeVideoCapturer.h"
#import <WebRTC/RTCCVPixelBuffer.h>
#import <WebRTC/RTCVideoFrameBuffer.h>
#import <VideoToolbox/VideoToolbox.h>
#import <UIKit/UIKit.h>

static HeyJoeVideoCapturer *_sharedInstance = nil;

// Forward declaration for compression callback
static void compressionOutputCallback(void *outputCallbackRefCon,
                                       void *sourceFrameRefCon,
                                       OSStatus status,
                                       VTEncodeInfoFlags infoFlags,
                                       CMSampleBufferRef sampleBuffer);

@interface HeyJoeVideoCapturer () <AVCaptureAudioDataOutputSampleBufferDelegate>

@property (nonatomic, strong) AVCaptureSession *captureSession;
@property (nonatomic, strong) AVCaptureDeviceInput *videoInput;
@property (nonatomic, strong) AVCaptureDeviceInput *audioInput;
@property (nonatomic, strong) AVCaptureVideoDataOutput *videoDataOutput;
@property (nonatomic, strong) AVCaptureAudioDataOutput *audioDataOutput;

// Recording with bitrate control (20 Mbps H.265)
@property (nonatomic, strong) AVAssetWriter *assetWriter;
@property (nonatomic, strong) AVAssetWriterInput *videoWriterInput;
@property (nonatomic, strong) AVAssetWriterInput *audioWriterInput;
@property (nonatomic) VTCompressionSessionRef compressionSession;
@property (nonatomic, strong) NSURL *recordingURL;
@property (nonatomic, assign) BOOL hasWrittenFirstVideoFrame;
@property (nonatomic, assign) CMTime recordingStartTime;

@property (nonatomic, strong) dispatch_queue_t sessionQueue;
@property (nonatomic, strong) dispatch_queue_t videoQueue;
@property (nonatomic, strong) dispatch_queue_t audioQueue;
@property (nonatomic, strong) dispatch_queue_t writerQueue;

@property (nonatomic, assign) BOOL isRecording;
@property (nonatomic, assign) BOOL isCapturing;
@property (nonatomic, assign) BOOL needsWriterSetup;
@property (nonatomic, assign) int videoWidth;
@property (nonatomic, assign) int videoHeight;

@property (nonatomic, copy, nullable) void (^recordingCompletionHandler)(NSURL * _Nullable, NSError * _Nullable);

// Per-session counters (replaces statics to avoid cross-session confusion)
@property (nonatomic, assign) int encodedFrameCount;
@property (nonatomic, assign) int compressedCallbackCount;

@end

@implementation HeyJoeVideoCapturer

#pragma mark - Shared Instance

+ (instancetype)sharedInstance {
    return _sharedInstance;
}

+ (void)setSharedInstance:(HeyJoeVideoCapturer *)instance {
    _sharedInstance = instance;
}

#pragma mark - Initialization

- (instancetype)initWithDelegate:(id<RTCVideoCapturerDelegate>)delegate {
    self = [super initWithDelegate:delegate];
    if (self) {
        _sessionQueue = dispatch_queue_create("com.heyjoe.capturer.session", DISPATCH_QUEUE_SERIAL);
        _videoQueue = dispatch_queue_create("com.heyjoe.capturer.video", DISPATCH_QUEUE_SERIAL);
        _audioQueue = dispatch_queue_create("com.heyjoe.capturer.audio", DISPATCH_QUEUE_SERIAL);
        _writerQueue = dispatch_queue_create("com.heyjoe.capturer.writer", DISPATCH_QUEUE_SERIAL);
        _isRecording = NO;
        _isCapturing = NO;
        _needsWriterSetup = NO;
        _videoWidth = 1280;
        _videoHeight = 720;
        _hasWrittenFirstVideoFrame = NO;
        _recordingStartTime = kCMTimeInvalid;
        _recordingTargetResolution = HeyJoeRecordingResolution1080p;
        _encodedFrameCount = 0;
        _compressedCallbackCount = 0;

        // Set as shared instance
        [HeyJoeVideoCapturer setSharedInstance:self];

        NSLog(@"[HeyJoeCapturer] Initialized with recording quality support (default: 1080p)");
    }
    return self;
}

- (void)dealloc {
    // Synchronous cleanup to ensure all resources are released before dealloc completes
    // Must dispatch_sync to sessionQueue to ensure proper ordering
    if (self.sessionQueue) {
        dispatch_sync(self.sessionQueue, ^{
            if (self.isRecording) {
                // Quick cleanup without waiting for finalization
                self.isRecording = NO;
                if (self.compressionSession) {
                    VTCompressionSessionInvalidate(self.compressionSession);
                    CFRelease(self.compressionSession);
                    self.compressionSession = NULL;
                }
                // Cancel asset writer - file may be incomplete but we're deallocating
                if (self.assetWriter) {
                    [self.assetWriter cancelWriting];
                }
            }
            if (self.captureSession && self.captureSession.isRunning) {
                [self.captureSession stopRunning];
            }
        });
    }

    if (_sharedInstance == self) {
        _sharedInstance = nil;
    }
    NSLog(@"[HeyJoeCapturer] Deallocated");
}

#pragma mark - Orientation Handling

- (UIDeviceOrientation)currentDeviceOrientation {
    // Get device orientation - must be called on main thread
    __block UIDeviceOrientation deviceOrientation;
    if ([NSThread isMainThread]) {
        deviceOrientation = [UIDevice currentDevice].orientation;
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            deviceOrientation = [UIDevice currentDevice].orientation;
        });
    }
    return deviceOrientation;
}

- (RTCVideoRotation)rtcVideoRotationForCurrentDeviceOrientation {
    UIDeviceOrientation deviceOrientation = [self currentDeviceOrientation];

    // Convert device orientation to RTCVideoRotation
    // Note: AVCaptureConnection.videoOrientation is set to Portrait, so pixel buffer
    // is already in portrait orientation. RTCVideoRotation tells WebRTC how to
    // display the frame based on current device orientation.
    switch (deviceOrientation) {
        case UIDeviceOrientationPortrait:
            return RTCVideoRotation_0;
        case UIDeviceOrientationPortraitUpsideDown:
            return RTCVideoRotation_180;
        case UIDeviceOrientationLandscapeLeft:
            // Device rotated left = screen shows landscape right
            return RTCVideoRotation_270;
        case UIDeviceOrientationLandscapeRight:
            // Device rotated right = screen shows landscape left
            return RTCVideoRotation_90;
        default:
            // Face up, face down, or unknown - default to no rotation
            return RTCVideoRotation_0;
    }
}

- (CGAffineTransform)videoTransformForCurrentDeviceOrientation {
    UIDeviceOrientation deviceOrientation = [self currentDeviceOrientation];

    // The pixel buffer is in portrait orientation (due to videoConnection.videoOrientation = Portrait)
    // We need to apply a transform so the recorded video displays correctly based on how the user
    // is holding the device.
    switch (deviceOrientation) {
        case UIDeviceOrientationPortrait:
            return CGAffineTransformIdentity;
        case UIDeviceOrientationPortraitUpsideDown:
            return CGAffineTransformMakeRotation(M_PI);
        case UIDeviceOrientationLandscapeLeft:
            // Device rotated left = rotate video 90 degrees counter-clockwise
            return CGAffineTransformMakeRotation(-M_PI_2);
        case UIDeviceOrientationLandscapeRight:
            // Device rotated right = rotate video 90 degrees clockwise
            return CGAffineTransformMakeRotation(M_PI_2);
        default:
            // Face up, face down, or unknown - default to no rotation
            return CGAffineTransformIdentity;
    }
}

#pragma mark - Capture Control

- (void)startCaptureWithDevice:(AVCaptureDevice *)device
                        format:(AVCaptureDeviceFormat *)format
                           fps:(NSInteger)fps
             completionHandler:(void (^)(NSError *))completionHandler {

    dispatch_async(self.sessionQueue, ^{
        if (self.isCapturing) {
            NSLog(@"[HeyJoeCapturer] Already capturing, ignoring start request");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(nil);
                });
            }
            return;
        }

        NSError *error = nil;

        // Create capture session
        self.captureSession = [[AVCaptureSession alloc] init];
        [self.captureSession beginConfiguration];

        // Add video input
        self.videoInput = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
        if (error || !self.videoInput) {
            [self.captureSession commitConfiguration];
            NSLog(@"[HeyJoeCapturer] Failed to create video input: %@", error);
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(error ?: [NSError errorWithDomain:@"HeyJoeCapturer" code:1 userInfo:@{NSLocalizedDescriptionKey: @"Failed to create video input"}]);
                });
            }
            return;
        }

        if ([self.captureSession canAddInput:self.videoInput]) {
            [self.captureSession addInput:self.videoInput];
        } else {
            [self.captureSession commitConfiguration];
            NSLog(@"[HeyJoeCapturer] Cannot add video input to session");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler([NSError errorWithDomain:@"HeyJoeCapturer" code:2 userInfo:@{NSLocalizedDescriptionKey: @"Cannot add video input"}]);
                });
            }
            return;
        }

        // Configure camera format and frame rate
        if ([device lockForConfiguration:&error]) {
            device.activeFormat = format;

            CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
            self.videoWidth = dims.width;
            self.videoHeight = dims.height;

            // Set frame rate
            CMTime frameDuration = CMTimeMake(1, (int32_t)fps);
            device.activeVideoMinFrameDuration = frameDuration;
            device.activeVideoMaxFrameDuration = frameDuration;

            // Enable continuous autofocus and exposure
            if ([device isFocusModeSupported:AVCaptureFocusModeContinuousAutoFocus]) {
                device.focusMode = AVCaptureFocusModeContinuousAutoFocus;
            }
            if ([device isExposureModeSupported:AVCaptureExposureModeContinuousAutoExposure]) {
                device.exposureMode = AVCaptureExposureModeContinuousAutoExposure;
            }

            [device unlockForConfiguration];
            NSLog(@"[HeyJoeCapturer] Camera configured: %dx%d @ %ldfps", self.videoWidth, self.videoHeight, (long)fps);
        } else {
            NSLog(@"[HeyJoeCapturer] Could not lock camera for configuration: %@", error);
        }

        // Add audio input for recording
        AVCaptureDevice *audioDevice = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeAudio];
        if (audioDevice) {
            NSError *audioError = nil;
            self.audioInput = [AVCaptureDeviceInput deviceInputWithDevice:audioDevice error:&audioError];
            if (self.audioInput && [self.captureSession canAddInput:self.audioInput]) {
                [self.captureSession addInput:self.audioInput];
                NSLog(@"[HeyJoeCapturer] Audio input added");
            }
        }

        // Add video data output for WebRTC
        self.videoDataOutput = [[AVCaptureVideoDataOutput alloc] init];
        self.videoDataOutput.alwaysDiscardsLateVideoFrames = YES;
        self.videoDataOutput.videoSettings = @{
            (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        };
        [self.videoDataOutput setSampleBufferDelegate:self queue:self.videoQueue];

        if ([self.captureSession canAddOutput:self.videoDataOutput]) {
            [self.captureSession addOutput:self.videoDataOutput];

            // Configure video connection
            AVCaptureConnection *videoConnection = [self.videoDataOutput connectionWithMediaType:AVMediaTypeVideo];
            if (videoConnection) {
                if ([videoConnection isVideoOrientationSupported]) {
                    videoConnection.videoOrientation = AVCaptureVideoOrientationPortrait;
                }
                // Mirror front camera
                if (device.position == AVCaptureDevicePositionFront && [videoConnection isVideoMirroringSupported]) {
                    videoConnection.videoMirrored = YES;
                }

                // Smooth out handheld shake, which is most noticeable on the rear camera.
                // The active format must support the chosen mode; if it doesn't, this is
                // silently ignored and activeVideoStabilizationMode stays Off (no harm).
                if (videoConnection.supportsVideoStabilization) {
                    if (@available(iOS 13.0, *)) {
                        videoConnection.preferredVideoStabilizationMode = AVCaptureVideoStabilizationModeCinematicExtended;
                    } else {
                        videoConnection.preferredVideoStabilizationMode = AVCaptureVideoStabilizationModeCinematic;
                    }
                    NSLog(@"[HeyJoeCapturer] Video stabilization requested (mode=%ld), active=%ld",
                          (long)videoConnection.preferredVideoStabilizationMode,
                          (long)videoConnection.activeVideoStabilizationMode);
                }
            }
        } else {
            NSLog(@"[HeyJoeCapturer] Cannot add video data output");
        }

        // Add audio data output for recording with bitrate control
        self.audioDataOutput = [[AVCaptureAudioDataOutput alloc] init];
        [self.audioDataOutput setSampleBufferDelegate:self queue:self.audioQueue];

        if ([self.captureSession canAddOutput:self.audioDataOutput]) {
            [self.captureSession addOutput:self.audioDataOutput];
            NSLog(@"[HeyJoeCapturer] Audio data output added for recording");
        } else {
            NSLog(@"[HeyJoeCapturer] Cannot add audio data output");
        }

        [self.captureSession commitConfiguration];

        // Start the session
        [self.captureSession startRunning];
        self.isCapturing = YES;

        NSLog(@"[HeyJoeCapturer] Capture session started at %dx%d", self.videoWidth, self.videoHeight);

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(nil);
            });
        }
    });
}

- (void)stopCaptureWithCompletionHandler:(void (^)(void))completionHandler {
    dispatch_async(self.sessionQueue, ^{
        if (!self.isCapturing) {
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler();
                });
            }
            return;
        }

        // Stop recording first if active - must properly finalize to avoid corrupted files
        if (self.isRecording) {
            NSLog(@"[HeyJoeCapturer] Recording was active during capture stop - cleaning up and notifying JS");

            // Set isRecording to NO FIRST to stop accepting new frames
            self.isRecording = NO;

            // NOW flush pending frames - this blocks until all pending frames are processed
            if (self.compressionSession) {
                VTCompressionSessionCompleteFrames(self.compressionSession, kCMTimeInvalid);
            }

            // Clean up compression session
            if (self.compressionSession) {
                VTCompressionSessionInvalidate(self.compressionSession);
                CFRelease(self.compressionSession);
                self.compressionSession = NULL;
            }

            // Properly finalize asset writer to ensure file is playable
            if (self.assetWriter && self.assetWriter.status == AVAssetWriterStatusWriting) {
                [self.videoWriterInput markAsFinished];
                [self.audioWriterInput markAsFinished];
                // Use synchronous finalization since we're stopping capture
                dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
                [self.assetWriter finishWritingWithCompletionHandler:^{
                    dispatch_semaphore_signal(semaphore);
                }];
                dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, 5 * NSEC_PER_SEC));
                NSLog(@"[HeyJoeCapturer] Recording finalized during capture stop");
            }

            self.assetWriter = nil;
            self.videoWriterInput = nil;
            self.audioWriterInput = nil;
            self.recordingURL = nil;
            self.needsWriterSetup = NO;
            self.hasWrittenFirstVideoFrame = NO;
            self.recordingStartTime = kCMTimeInvalid;

            // Notify bridge module so it can sync JS recording state
            dispatch_async(dispatch_get_main_queue(), ^{
                [[NSNotificationCenter defaultCenter]
                    postNotificationName:@"HeyJoeRecordingInterruptedDuringCaptureStop"
                    object:nil];
            });
        }

        [self.captureSession stopRunning];
        self.isCapturing = NO;

        self.captureSession = nil;
        self.videoInput = nil;
        self.audioInput = nil;
        self.videoDataOutput = nil;
        self.audioDataOutput = nil;

        NSLog(@"[HeyJoeCapturer] Capture session stopped");

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler();
            });
        }
    });
}

#pragma mark - Recording Control

- (BOOL)setupCompressionSessionWithWidth:(int)width height:(int)height bitrate:(int)bitrate {
    // HEVC encoding requires iOS 11.0+
    if (@available(iOS 11.0, *)) {
        // iOS 11+ - use HEVC
    } else {
        NSLog(@"[HeyJoeCapturer] HEVC encoding requires iOS 11.0 or later");
        return NO;
    }

    OSStatus status = VTCompressionSessionCreate(
        kCFAllocatorDefault,
        width,
        height,
        kCMVideoCodecType_HEVC,
        NULL,
        NULL,
        NULL,
        compressionOutputCallback,
        (__bridge void *)self,
        &_compressionSession
    );

    if (status != noErr) {
        NSLog(@"[HeyJoeCapturer] Failed to create compression session: %d", (int)status);
        return NO;
    }

    // Set bitrate for recording quality
    VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_AverageBitRate,
                         (__bridge CFNumberRef)@(bitrate));

    // Limit data rate to prevent spikes (1.5x average)
    NSArray *dataRateLimits = @[@(bitrate * 1.5), @1.0];
    VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_DataRateLimits,
                         (__bridge CFArrayRef)dataRateLimits);

    // Real-time encoding for live recording
    VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue);

    // Expected frame rate (30 fps)
    VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_ExpectedFrameRate,
                         (__bridge CFNumberRef)@(30));

    // Keyframe interval (every 2 seconds = 60 frames at 30fps)
    VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_MaxKeyFrameInterval,
                         (__bridge CFNumberRef)@(60));

    // Profile (Main for good compatibility)
    if (@available(iOS 11.0, *)) {
        VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_ProfileLevel,
                             kVTProfileLevel_HEVC_Main_AutoLevel);
    }

    // Allow frame reordering for better compression (B-frames)
    VTSessionSetProperty(_compressionSession, kVTCompressionPropertyKey_AllowFrameReordering,
                         kCFBooleanTrue);

    VTCompressionSessionPrepareToEncodeFrames(_compressionSession);

    NSLog(@"[HeyJoeCapturer] Compression session created: %dx%d @ %d Mbps H.265", width, height, bitrate / 1000000);
    return YES;
}

- (BOOL)setupAssetWriterWithSampleBuffer:(CMSampleBufferRef)sampleBuffer {
    // Extract format description from the compressed sample buffer
    // This is the key fix - we need the format description for passthrough mode
    CMFormatDescriptionRef formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer);
    if (!formatDesc) {
        NSLog(@"[HeyJoeCapturer] Failed to get format description from sample buffer");
        return NO;
    }

    NSError *error = nil;

    self.assetWriter = [[AVAssetWriter alloc] initWithURL:self.recordingURL
                                                 fileType:AVFileTypeMPEG4
                                                    error:&error];
    if (error) {
        NSLog(@"[HeyJoeCapturer] Failed to create asset writer: %@", error);
        return NO;
    }

    // Video input - passthrough mode with sourceFormatHint (already compressed by VTCompressionSession)
    // The sourceFormatHint tells AVAssetWriter what format to expect, allowing canAddInput to succeed
    self.videoWriterInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                               outputSettings:nil
                                                             sourceFormatHint:formatDesc];
    self.videoWriterInput.expectsMediaDataInRealTime = YES;

    // Apply rotation transform based on current device orientation
    // The pixel buffer is always in portrait orientation (due to videoConnection.videoOrientation = Portrait)
    // but we need to rotate the recorded video to match how the user is holding the device
    CGAffineTransform videoTransform = [self videoTransformForCurrentDeviceOrientation];
    self.videoWriterInput.transform = videoTransform;
    NSLog(@"[HeyJoeCapturer] Video writer transform set for device orientation");

    // Audio input - encode to AAC
    AudioChannelLayout acl;
    memset(&acl, 0, sizeof(acl));
    acl.mChannelLayoutTag = kAudioChannelLayoutTag_Mono;

    NSDictionary *audioSettings = @{
        AVFormatIDKey: @(kAudioFormatMPEG4AAC),
        AVSampleRateKey: @(44100),
        AVNumberOfChannelsKey: @(1),
        AVEncoderBitRateKey: @(128000),
        AVChannelLayoutKey: [NSData dataWithBytes:&acl length:sizeof(acl)]
    };

    self.audioWriterInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                                               outputSettings:audioSettings];
    self.audioWriterInput.expectsMediaDataInRealTime = YES;

    if ([self.assetWriter canAddInput:self.videoWriterInput]) {
        [self.assetWriter addInput:self.videoWriterInput];
    } else {
        NSLog(@"[HeyJoeCapturer] Cannot add video writer input - canAddInput returned NO");
        NSLog(@"[HeyJoeCapturer] Asset writer error: %@", self.assetWriter.error);
        return NO;
    }

    if ([self.assetWriter canAddInput:self.audioWriterInput]) {
        [self.assetWriter addInput:self.audioWriterInput];
    } else {
        NSLog(@"[HeyJoeCapturer] Cannot add audio writer input");
        // Continue without audio - video is more important
    }

    NSLog(@"[HeyJoeCapturer] Asset writer created with format hint for: %@", self.recordingURL.path);
    return YES;
}

- (void)handleCompressedFrame:(CMSampleBufferRef)sampleBuffer {
    if (!self.isRecording) return;

    // Deferred setup: create AVAssetWriter on first compressed frame
    // This is needed because passthrough mode requires the format description
    // from an actual compressed sample buffer
    if (self.needsWriterSetup) {
        NSLog(@"[HeyJoeCapturer] Performing deferred asset writer setup...");
        if (![self setupAssetWriterWithSampleBuffer:sampleBuffer]) {
            NSLog(@"[HeyJoeCapturer] Deferred asset writer setup failed - stopping recording");
            self.isRecording = NO;
            self.needsWriterSetup = NO;
            // Cleanup compression session
            if (self.compressionSession) {
                VTCompressionSessionInvalidate(self.compressionSession);
                CFRelease(self.compressionSession);
                self.compressionSession = NULL;
            }
            return;
        }
        self.needsWriterSetup = NO;
        NSLog(@"[HeyJoeCapturer] Deferred asset writer setup completed successfully");
    }

    if (!self.assetWriter) return;

    dispatch_sync(self.writerQueue, ^{
        if (self.assetWriter.status == AVAssetWriterStatusUnknown) {
            CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
            if ([self.assetWriter startWriting]) {
                [self.assetWriter startSessionAtSourceTime:timestamp];
                self.recordingStartTime = timestamp;
                NSLog(@"[HeyJoeCapturer] Asset writer started at time: %.3f", CMTimeGetSeconds(timestamp));
            } else {
                NSLog(@"[HeyJoeCapturer] Failed to start asset writer: %@", self.assetWriter.error);
                return;
            }
        }

        if (self.assetWriter.status == AVAssetWriterStatusWriting) {
            if (self.videoWriterInput.readyForMoreMediaData) {
                if ([self.videoWriterInput appendSampleBuffer:sampleBuffer]) {
                    self.hasWrittenFirstVideoFrame = YES;
                } else {
                    NSLog(@"[HeyJoeCapturer] Failed to append video sample: %@", self.assetWriter.error);
                }
            }
        } else if (self.assetWriter.status == AVAssetWriterStatusFailed) {
            NSLog(@"[HeyJoeCapturer] Asset writer failed: %@", self.assetWriter.error);
        }
    });
}

- (void)cleanupRecordingResources {
    self.isRecording = NO;
    self.needsWriterSetup = NO;
    self.hasWrittenFirstVideoFrame = NO;
    self.recordingStartTime = kCMTimeInvalid;

    // Cleanup compression session
    if (self.compressionSession) {
        VTCompressionSessionCompleteFrames(self.compressionSession, kCMTimeInvalid);
        VTCompressionSessionInvalidate(self.compressionSession);
        CFRelease(self.compressionSession);
        self.compressionSession = NULL;
    }

    self.assetWriter = nil;
    self.videoWriterInput = nil;
    self.audioWriterInput = nil;
    self.recordingURL = nil;
}

- (void)startRecordingToURL:(NSURL *)outputURL
          completionHandler:(void (^)(NSError *))completionHandler {

    dispatch_async(self.sessionQueue, ^{
        if (!self.isCapturing) {
            NSLog(@"[HeyJoeCapturer] Cannot start recording - not capturing");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler([NSError errorWithDomain:@"HeyJoeCapturer" code:3 userInfo:@{NSLocalizedDescriptionKey: @"Not capturing"}]);
                });
            }
            return;
        }

        if (self.isRecording) {
            NSLog(@"[HeyJoeCapturer] Already recording");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler([NSError errorWithDomain:@"HeyJoeCapturer" code:4 userInfo:@{NSLocalizedDescriptionKey: @"Already recording"}]);
                });
            }
            return;
        }

        // Pre-recording cleanup: force-clean any stale resources from a previous
        // session that was interrupted by a room transition
        if (self.compressionSession) {
            NSLog(@"[HeyJoeCapturer] Cleaning up stale compression session before new recording");
            VTCompressionSessionInvalidate(self.compressionSession);
            CFRelease(self.compressionSession);
            self.compressionSession = NULL;
        }
        if (self.assetWriter) {
            NSLog(@"[HeyJoeCapturer] Cleaning up stale asset writer before new recording (status=%ld)",
                  (long)self.assetWriter.status);
            [self.assetWriter cancelWriting];
            self.assetWriter = nil;
            self.videoWriterInput = nil;
            self.audioWriterInput = nil;
        }
        self.needsWriterSetup = NO;
        self.hasWrittenFirstVideoFrame = NO;
        self.recordingStartTime = kCMTimeInvalid;

        // Delete existing file if present
        NSFileManager *fileManager = [NSFileManager defaultManager];
        if ([fileManager fileExistsAtPath:outputURL.path]) {
            [fileManager removeItemAtURL:outputURL error:nil];
        }

        self.recordingURL = outputURL;
        self.hasWrittenFirstVideoFrame = NO;
        self.recordingStartTime = kCMTimeInvalid;
        self.encodedFrameCount = 0;
        self.compressedCallbackCount = 0;

        // Defer BOTH compression session AND asset writer setup until first pixel buffer
        // This ensures we use the actual pixel buffer dimensions (which may be rotated
        // based on videoOrientation setting) rather than camera format dimensions
        self.needsWriterSetup = YES;

        self.isRecording = YES;
        NSLog(@"[HeyJoeCapturer] Recording started (target: %s) to: %@ (writer setup deferred)",
              self.recordingTargetResolution == HeyJoeRecordingResolution4K ? "4K" : "1080p",
              outputURL.path);

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(nil);
            });
        }
    });
}

- (void)stopRecordingWithCompletionHandler:(void (^)(NSURL *, NSError *))completionHandler {
    dispatch_async(self.sessionQueue, ^{
        if (!self.isRecording) {
            NSLog(@"[HeyJoeCapturer] Not recording, nothing to stop");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(nil, [NSError errorWithDomain:@"HeyJoeCapturer" code:7 userInfo:@{NSLocalizedDescriptionKey: @"Not recording"}]);
                });
            }
            return;
        }

        NSURL *outputURL = self.recordingURL;

        NSLog(@"[HeyJoeCapturer] Stopping recording - state: needsWriterSetup=%d, assetWriter=%@, compressionSession=%@",
              self.needsWriterSetup,
              self.assetWriter ? @"exists" : @"nil",
              self.compressionSession ? @"exists" : @"nil");

        // Set isRecording to NO FIRST to stop accepting new frames
        // This prevents a deadlock where VTCompressionSessionCompleteFrames blocks
        // while new frames keep being added from captureOutput:
        self.isRecording = NO;
        NSLog(@"[HeyJoeCapturer] isRecording set to NO - no more frames will be encoded");

        // NOW flush the compression session - this will block until all pending frames are processed
        if (self.compressionSession) {
            NSLog(@"[HeyJoeCapturer] Flushing compression session...");
            VTCompressionSessionCompleteFrames(self.compressionSession, kCMTimeInvalid);
            NSLog(@"[HeyJoeCapturer] Compression session flushed");
        }

        // Clean up compression session
        if (self.compressionSession) {
            VTCompressionSessionInvalidate(self.compressionSession);
            CFRelease(self.compressionSession);
            self.compressionSession = NULL;
        }

        // Finish asset writer
        NSLog(@"[HeyJoeCapturer] Asset writer status check: assetWriter=%@, status=%ld",
              self.assetWriter ? @"exists" : @"nil",
              (long)(self.assetWriter ? self.assetWriter.status : -1));

        // Handle case where recording stopped before any frames were written
        if (self.needsWriterSetup || !self.assetWriter) {
            NSLog(@"[HeyJoeCapturer] Recording stopped before any frames were processed");
            [self cleanupRecordingResources];

            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    // Return nil URL but no error - recording was just too short
                    completionHandler(nil, nil);
                });
            }
            return;
        }

        AVAssetWriterStatus status = self.assetWriter.status;

        if (status == AVAssetWriterStatusWriting) {
            NSLog(@"[HeyJoeCapturer] Finishing asset writer...");
            [self.videoWriterInput markAsFinished];
            [self.audioWriterInput markAsFinished];

            [self.assetWriter finishWritingWithCompletionHandler:^{
                NSLog(@"[HeyJoeCapturer] Recording finished: %@", outputURL.path);

                // Get file size for logging
                NSError *error = nil;
                NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:outputURL.path error:&error];
                if (attrs) {
                    unsigned long long fileSize = [attrs fileSize];
                    NSLog(@"[HeyJoeCapturer] File size: %.2f MB", fileSize / (1024.0 * 1024.0));
                }

                self.assetWriter = nil;
                self.videoWriterInput = nil;
                self.audioWriterInput = nil;
                self.recordingURL = nil;
                self.needsWriterSetup = NO;
                self.hasWrittenFirstVideoFrame = NO;
                self.recordingStartTime = kCMTimeInvalid;

                if (completionHandler) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        completionHandler(outputURL, nil);
                    });
                }
            }];
        } else if (status == AVAssetWriterStatusCompleted) {
            // Already completed - this can happen in edge cases
            NSLog(@"[HeyJoeCapturer] Asset writer already completed");
            [self cleanupRecordingResources];

            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(outputURL, nil);
                });
            }
        } else {
            // Capture error BEFORE cleanup nils the assetWriter
            NSError *writerError = self.assetWriter.error;
            AVAssetWriterStatus writerStatus = status;
            NSLog(@"[HeyJoeCapturer] Asset writer in unexpected state: %ld, error=%@",
                  (long)writerStatus, writerError);

            [self cleanupRecordingResources];

            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (writerError) {
                        completionHandler(nil, writerError);
                    } else {
                        NSString *desc = [NSString stringWithFormat:
                            @"Recording failed - writer in state %ld (0=Unknown,3=Failed,4=Cancelled)",
                            (long)writerStatus];
                        completionHandler(nil, [NSError errorWithDomain:@"HeyJoeCapturer" code:8 userInfo:@{NSLocalizedDescriptionKey: desc}]);
                    }
                });
            }
        }
    });
}

#pragma mark - AVCaptureVideoDataOutputSampleBufferDelegate

- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {

    if (!self.isCapturing) return;

    // Handle video frames
    if (output == self.videoDataOutput) {
        CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (!pixelBuffer) return;

        CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
        int64_t timeStampNs = CMTimeGetSeconds(timestamp) * NSEC_PER_SEC;

        // Feed to WebRTC at 720p (always, regardless of recording)
        // Camera stays at native resolution for local recording, but WebRTC
        // only needs 720p. RTCCVPixelBuffer handles the scaling efficiently.
        RTCVideoRotation rotation = [self rtcVideoRotationForCurrentDeviceOrientation];

        int pbWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
        int pbHeight = (int)CVPixelBufferGetHeight(pixelBuffer);

        // Target 720p for WebRTC: 1280x720 landscape, 720x1280 portrait
        int adaptedWidth, adaptedHeight;
        if (pbWidth > pbHeight) {
            adaptedWidth = MIN(pbWidth, 1280);
            adaptedHeight = MIN(pbHeight, 720);
        } else {
            adaptedWidth = MIN(pbWidth, 720);
            adaptedHeight = MIN(pbHeight, 1280);
        }

        RTCCVPixelBuffer *rtcPixelBuffer = [[RTCCVPixelBuffer alloc]
            initWithPixelBuffer:pixelBuffer
                   adaptedWidth:adaptedWidth
                  adaptedHeight:adaptedHeight
                      cropWidth:pbWidth
                     cropHeight:pbHeight
                          cropX:0
                          cropY:0];
        RTCVideoFrame *videoFrame = [[RTCVideoFrame alloc] initWithBuffer:rtcPixelBuffer
                                                                 rotation:rotation
                                                              timeStampNs:timeStampNs];
        [self.delegate capturer:self didCaptureVideoFrame:videoFrame];

        // If recording, encode frame with VTCompressionSession
        if (self.isRecording) {
            // Deferred compression session setup - use actual pixel buffer dimensions
            // Apply resolution cap based on recordingTargetResolution setting
            if (self.needsWriterSetup && !self.compressionSession) {
                int actualWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
                int actualHeight = (int)CVPixelBufferGetHeight(pixelBuffer);
                NSLog(@"[HeyJoeCapturer] Actual pixel buffer dimensions: %dx%d", actualWidth, actualHeight);

                int targetWidth = actualWidth;
                int targetHeight = actualHeight;
                int bitrate = 20000000; // 20 Mbps for 4K

                if (self.recordingTargetResolution == HeyJoeRecordingResolution1080p) {
                    if (actualWidth > actualHeight) {
                        // Landscape
                        targetWidth = MIN(actualWidth, 1920);
                        targetHeight = MIN(actualHeight, 1080);
                    } else {
                        // Portrait
                        targetWidth = MIN(actualWidth, 1080);
                        targetHeight = MIN(actualHeight, 1920);
                    }
                    bitrate = 8000000; // 8 Mbps for 1080p
                }

                NSLog(@"[HeyJoeCapturer] Setting up compression session: %dx%d @ %d Mbps (target: %s)",
                      targetWidth, targetHeight, bitrate / 1000000,
                      self.recordingTargetResolution == HeyJoeRecordingResolution4K ? "4K" : "1080p");

                if (![self setupCompressionSessionWithWidth:targetWidth height:targetHeight bitrate:bitrate]) {
                    NSLog(@"[HeyJoeCapturer] Failed to setup compression session");
                    self.isRecording = NO;
                    self.needsWriterSetup = NO;
                    return;
                }
            }

            if (self.compressionSession) {
                self.encodedFrameCount++;
                if (self.encodedFrameCount <= 3) {
                    size_t pbWidth = CVPixelBufferGetWidth(pixelBuffer);
                    size_t pbHeight = CVPixelBufferGetHeight(pixelBuffer);
                    NSLog(@"[HeyJoeCapturer] Frame #%d - PixelBuffer: %zux%zu", self.encodedFrameCount, pbWidth, pbHeight);
                } else if (self.encodedFrameCount % 30 == 0) {
                    NSLog(@"[HeyJoeCapturer] Encoding video frame #%d", self.encodedFrameCount);
                }
                OSStatus status = VTCompressionSessionEncodeFrame(
                    self.compressionSession,
                    pixelBuffer,
                    timestamp,
                    kCMTimeInvalid,
                    NULL,
                    NULL,
                    NULL
                );
                if (status != noErr) {
                    NSLog(@"[HeyJoeCapturer] VTCompressionSessionEncodeFrame failed with status: %d", (int)status);
                }
            }
        }
    }
    // Handle audio frames
    else if (output == self.audioDataOutput) {
        if (self.isRecording && self.hasWrittenFirstVideoFrame) {
            dispatch_sync(self.writerQueue, ^{
                if (self.assetWriter.status == AVAssetWriterStatusWriting &&
                    self.audioWriterInput.readyForMoreMediaData) {
                    if (![self.audioWriterInput appendSampleBuffer:sampleBuffer]) {
                        NSLog(@"[HeyJoeCapturer] Failed to append audio sample: %@", self.assetWriter.error);
                    }
                }
            });
        }
    }
}

#pragma mark - Helper Methods

- (CGAffineTransform)currentVideoTransform {
    // Get the current device orientation
    // Must be called on main thread to access UIDevice
    __block UIDeviceOrientation deviceOrientation;
    if ([NSThread isMainThread]) {
        deviceOrientation = [UIDevice currentDevice].orientation;
    } else {
        dispatch_sync(dispatch_get_main_queue(), ^{
            deviceOrientation = [UIDevice currentDevice].orientation;
        });
    }

    // Determine if we're using front camera (for mirroring consideration)
    BOOL isFrontCamera = (self.videoInput.device.position == AVCaptureDevicePositionFront);

    // Calculate the appropriate rotation based on device orientation
    // The camera sensor is in landscape orientation, so we need to rotate for proper playback
    CGAffineTransform transform;

    switch (deviceOrientation) {
        case UIDeviceOrientationPortrait:
            // Phone held normally (home button at bottom)
            transform = CGAffineTransformMakeRotation(-M_PI_2);  // 90° counter-clockwise
            break;

        case UIDeviceOrientationPortraitUpsideDown:
            // Phone upside down (home button at top)
            transform = CGAffineTransformMakeRotation(M_PI_2);  // 90° clockwise
            break;

        case UIDeviceOrientationLandscapeLeft:
            // Phone rotated left (home button on right)
            transform = CGAffineTransformIdentity;  // No rotation
            break;

        case UIDeviceOrientationLandscapeRight:
            // Phone rotated right (home button on left)
            transform = CGAffineTransformMakeRotation(M_PI);  // 180°
            break;

        case UIDeviceOrientationFaceUp:
        case UIDeviceOrientationFaceDown:
        case UIDeviceOrientationUnknown:
        default:
            // Default to portrait if orientation is unclear
            transform = CGAffineTransformMakeRotation(-M_PI_2);
            break;
    }

    NSLog(@"[HeyJoeCapturer] Video transform for orientation %ld (front camera: %d)",
          (long)deviceOrientation, isFrontCamera);

    return transform;
}

+ (BOOL)formatSupportsPreferredStabilization:(AVCaptureDeviceFormat *)format {
    if (!format) return NO;
    if (@available(iOS 13.0, *)) {
        if ([format isVideoStabilizationModeSupported:AVCaptureVideoStabilizationModeCinematicExtended]) {
            return YES;
        }
    }
    return [format isVideoStabilizationModeSupported:AVCaptureVideoStabilizationModeCinematic] ||
           [format isVideoStabilizationModeSupported:AVCaptureVideoStabilizationModeStandard];
}

+ (AVCaptureDeviceFormat *)bestFormatForDevice:(AVCaptureDevice *)device
                               targetFrameRate:(NSInteger)fps {
    if (!device) return nil;

    AVCaptureDeviceFormat *bestFormat = nil;
    int32_t bestPixelCount = 0;

    // Cap at 4K resolution (3840x2160) to keep file sizes reasonable
    // 4K = 8,294,400 pixels, but we use slightly higher to allow for minor variations
    const int32_t maxPixelCount = 3840 * 2160;

    for (AVCaptureDeviceFormat *format in device.formats) {
        CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        int32_t pixelCount = dims.width * dims.height;

        // Skip formats larger than 4K
        if (pixelCount > maxPixelCount) {
            continue;
        }

        // Check if format supports target frame rate
        BOOL supportsTargetFps = NO;
        for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
            if (range.maxFrameRate >= fps) {
                supportsTargetFps = YES;
                break;
            }
        }

        if (!supportsTargetFps) continue;

        // Prefer biplanar formats
        FourCharCode pixelFormat = CMFormatDescriptionGetMediaSubType(format.formatDescription);
        BOOL isBiplanar = (pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
                          pixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);

        if (pixelCount > bestPixelCount) {
            bestFormat = format;
            bestPixelCount = pixelCount;
        } else if (pixelCount == bestPixelCount && bestFormat) {
            // Same resolution: break ties by (1) stabilization support, then (2) biplanar
            // pixel format. Stabilization wins because the highest-res format isn't always
            // the one that supports smoothing, and shake removal matters more than the
            // marginal pixel-format preference.
            BOOL bestStab = [self formatSupportsPreferredStabilization:bestFormat];
            BOOL thisStab = [self formatSupportsPreferredStabilization:format];
            FourCharCode bestPixelFormat = CMFormatDescriptionGetMediaSubType(bestFormat.formatDescription);
            BOOL bestBiplanar = (bestPixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange ||
                                 bestPixelFormat == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange);
            if (thisStab != bestStab) {
                if (thisStab) bestFormat = format;
            } else if (isBiplanar && !bestBiplanar) {
                bestFormat = format;
            }
        }
    }

    if (bestFormat) {
        CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(bestFormat.formatDescription);
        NSLog(@"[HeyJoeCapturer] Best format for device (capped at 4K): %dx%d", dims.width, dims.height);
    }

    return bestFormat;
}

#pragma mark - Zoom Control

- (void)setZoomFactor:(CGFloat)zoomFactor
    completionHandler:(nullable void (^)(CGFloat actualZoom, CGFloat minZoom, CGFloat maxZoom, NSError * _Nullable error))completionHandler {

    // Validate input - reject NaN, Infinity, or negative values
    if (isnan(zoomFactor) || isinf(zoomFactor) || zoomFactor < 0) {
        NSLog(@"[HeyJoeCapturer] setZoomFactor: Invalid zoom value: %f", zoomFactor);
        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(1.0, 1.0, 1.0, [NSError errorWithDomain:@"HeyJoeCapturer"
                                                                     code:10
                                                                 userInfo:@{NSLocalizedDescriptionKey: @"Invalid zoom factor"}]);
            });
        }
        return;
    }

    dispatch_async(self.sessionQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        if (!device) {
            NSLog(@"[HeyJoeCapturer] setZoomFactor: No device available");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(1.0, 1.0, 1.0, [NSError errorWithDomain:@"HeyJoeCapturer"
                                                                         code:11
                                                                     userInfo:@{NSLocalizedDescriptionKey: @"No device available"}]);
                });
            }
            return;
        }

        NSError *error = nil;
        if ([device lockForConfiguration:&error]) {
            CGFloat minZoom = device.minAvailableVideoZoomFactor;
            CGFloat maxZoom = device.maxAvailableVideoZoomFactor;
            CGFloat clampedZoom = MAX(minZoom, MIN(zoomFactor, maxZoom));

            // Use smooth zoom animation (rate = zoom change per second)
            // Rate of 4.0 means 4x zoom change per second
            [device rampToVideoZoomFactor:clampedZoom withRate:4.0];

            [device unlockForConfiguration];
            NSLog(@"[HeyJoeCapturer] Zoom set to %.2f (range: %.2f-%.2f)", clampedZoom, minZoom, maxZoom);

            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(clampedZoom, minZoom, maxZoom, nil);
                });
            }
        } else {
            NSLog(@"[HeyJoeCapturer] Failed to lock device for zoom: %@", error);
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(1.0, 1.0, 1.0, error);
                });
            }
        }
    });
}

- (void)getZoomInfoWithCompletionHandler:(void (^)(CGFloat currentZoom, CGFloat minZoom, CGFloat maxZoom))completionHandler {
    dispatch_async(self.sessionQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        CGFloat currentZoom = 1.0;
        CGFloat minZoom = 1.0;
        CGFloat maxZoom = 1.0;

        if (device) {
            currentZoom = device.videoZoomFactor;
            minZoom = device.minAvailableVideoZoomFactor;
            maxZoom = device.maxAvailableVideoZoomFactor;
        }

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(currentZoom, minZoom, maxZoom);
            });
        }
    });
}

// Legacy sync getters - use with caution, prefer async versions
- (CGFloat)currentZoomFactor {
    __block CGFloat result = 1.0;
    dispatch_sync(self.sessionQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        if (device) {
            result = device.videoZoomFactor;
        }
    });
    return result;
}

- (CGFloat)minZoomFactor {
    __block CGFloat result = 1.0;
    dispatch_sync(self.sessionQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        if (device) {
            result = device.minAvailableVideoZoomFactor;
        }
    });
    return result;
}

- (CGFloat)maxZoomFactor {
    __block CGFloat result = 1.0;
    dispatch_sync(self.sessionQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        if (device) {
            result = device.maxAvailableVideoZoomFactor;
        }
    });
    return result;
}

@end

#pragma mark - VTCompressionSession Callback

static void compressionOutputCallback(void *outputCallbackRefCon,
                                       void *sourceFrameRefCon,
                                       OSStatus status,
                                       VTEncodeInfoFlags infoFlags,
                                       CMSampleBufferRef sampleBuffer) {
    if (!outputCallbackRefCon) return;
    HeyJoeVideoCapturer *capturer = (__bridge HeyJoeVideoCapturer *)outputCallbackRefCon;
    capturer.compressedCallbackCount++;
    if (capturer.compressedCallbackCount <= 3 || capturer.compressedCallbackCount % 30 == 0) {
        NSLog(@"[HeyJoeCapturer] Compression callback #%d, status=%d", capturer.compressedCallbackCount, (int)status);
    }

    if (status != noErr) {
        NSLog(@"[HeyJoeCapturer] Compression error: %d", (int)status);
        return;
    }

    if (!sampleBuffer) {
        NSLog(@"[HeyJoeCapturer] Compression callback: sampleBuffer is NULL");
        return;
    }

    // Retain sample buffer for async handling
    CFRetain(sampleBuffer);

    [capturer handleCompressedFrame:sampleBuffer];

    CFRelease(sampleBuffer);
}
