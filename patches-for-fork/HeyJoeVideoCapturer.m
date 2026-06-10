#import "HeyJoeVideoCapturer.h"
#import <WebRTC/RTCCVPixelBuffer.h>
#import <WebRTC/RTCVideoFrameBuffer.h>
#import <UIKit/UIKit.h>
#import <Accelerate/Accelerate.h>

static HeyJoeVideoCapturer *_sharedInstance = nil;

// Queue-specific keys for detecting current queue in dealloc
static void *kCaptureQueueSpecificKey = &kCaptureQueueSpecificKey;
static void *kRecordingQueueSpecificKey = &kRecordingQueueSpecificKey;

#pragma mark - HeyJoeVideoCapturer Private Interface

@interface HeyJoeVideoCapturer () <AVCaptureAudioDataOutputSampleBufferDelegate>

// captureQueue owns these
@property (nonatomic, strong) AVCaptureSession *captureSession;
@property (nonatomic, strong) AVCaptureDeviceInput *videoInput;
@property (nonatomic, strong) AVCaptureDeviceInput *audioInput;
@property (nonatomic, strong) AVCaptureVideoDataOutput *videoDataOutput;
@property (nonatomic, strong) AVCaptureAudioDataOutput *audioDataOutput;

// recordingQueue owns these
@property (nonatomic, strong) AVAssetWriter *assetWriter;
@property (nonatomic, strong) AVAssetWriterInput *videoWriterInput;
@property (nonatomic, strong) AVAssetWriterInput *audioWriterInput;
@property (nonatomic, strong) AVAssetWriterInputPixelBufferAdaptor *pixelBufferAdaptor;
@property (nonatomic, strong) NSURL *recordingURL;
@property (nonatomic, assign) BOOL hasWrittenFirstVideoFrame;
@property (nonatomic, assign) CMTime recordingStartTime;
@property (nonatomic, assign) BOOL audioWriterInputAdded;
@property (nonatomic, strong, nullable) NSError *recordingSetupError;
@property (nonatomic, assign) int encodedFrameCount;
@property (nonatomic, assign) int audioFrameCount;
@property (nonatomic) CVPixelBufferPoolRef scaleBufferPool;
@property (nonatomic, assign) int writerTargetWidth;
@property (nonatomic, assign) int writerTargetHeight;

// Queues
@property (nonatomic, strong) dispatch_queue_t captureQueue;
@property (nonatomic, strong) dispatch_queue_t recordingQueue;
@property (nonatomic, strong) dispatch_queue_t videoOutputQueue;
@property (nonatomic, strong) dispatch_queue_t audioOutputQueue;

// Atomic properties (redeclared readwrite internally)
@property (atomic, assign) BOOL recordingActive;
@property (atomic, assign) BOOL isCapturing;
@property (atomic, assign) int videoWidth;
@property (atomic, assign) int videoHeight;
@property (atomic, assign) BOOL recordingStarting;

// Recording state (readwrite internally, only on recordingQueue)
@property (nonatomic, assign) HJRecordingState recordingState;

// Generation counter for capture sessions — incremented on every startCapture.
// _teardownCaptureSession checks this to avoid destroying a newer session.
@property (nonatomic, assign) NSUInteger captureGeneration;

// Completion handler for pending stop recording
@property (nonatomic, copy, nullable) void (^recordingCompletionHandler)(NSURL * _Nullable, NSError * _Nullable);

// Cached device orientation — updated via notification instead of per-frame dispatch_sync.
// Atomic because it's written on main queue but read on recordingQueue.
@property (atomic, assign) UIDeviceOrientation cachedDeviceOrientation;

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
        _captureQueue = dispatch_queue_create("com.heyjoe.capturer.capture", DISPATCH_QUEUE_SERIAL);
        _recordingQueue = dispatch_queue_create("com.heyjoe.capturer.recording", DISPATCH_QUEUE_SERIAL);
        _videoOutputQueue = dispatch_queue_create("com.heyjoe.capturer.videoOutput", DISPATCH_QUEUE_SERIAL);
        _audioOutputQueue = dispatch_queue_create("com.heyjoe.capturer.audioOutput", DISPATCH_QUEUE_SERIAL);

        // Set queue-specific keys so dealloc can detect if it's already on the target queue
        dispatch_queue_set_specific(_captureQueue, kCaptureQueueSpecificKey, kCaptureQueueSpecificKey, NULL);
        dispatch_queue_set_specific(_recordingQueue, kRecordingQueueSpecificKey, kRecordingQueueSpecificKey, NULL);

        _recordingState = HJRecordingStateIdle;
        _recordingActive = NO;
        _recordingStarting = NO;
        _isCapturing = NO;
        _videoWidth = 1280;
        _videoHeight = 720;
        _hasWrittenFirstVideoFrame = NO;
        _recordingStartTime = kCMTimeInvalid;
        _recordingTargetResolution = HeyJoeRecordingResolution1080p;
        _encodedFrameCount = 0;
        _audioFrameCount = 0;

        // Cache device orientation — avoids dispatch_sync to main queue at 30fps
        _cachedDeviceOrientation = UIDeviceOrientationPortrait;
        [[UIDevice currentDevice] beginGeneratingDeviceOrientationNotifications];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(deviceOrientationDidChange:)
                                                     name:UIDeviceOrientationDidChangeNotification
                                                   object:nil];

        // Stop recording gracefully on memory pressure
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleMemoryWarning:)
                                                     name:UIApplicationDidReceiveMemoryWarningNotification
                                                   object:nil];

        // Set as shared instance
        [HeyJoeVideoCapturer setSharedInstance:self];

        NSLog(@"[HeyJoeCapturer] Initialized with 4-queue architecture (captureQueue + recordingQueue + videoOutput + audioOutput)");
    }
    return self;
}

- (void)updateDelegate:(id<RTCVideoCapturerDelegate>)delegate {
    if (self.isCapturing) {
        NSLog(@"WARNING: updateDelegate called while still capturing — call stopCapture first");
    }
    // RTCVideoCapturer stores the delegate as a weak reference — thread-safe assignment
    self.delegate = delegate;
    NSLog(@"[HeyJoeCapturer] Delegate updated for new WebRTC session");
}

- (void)dealloc {
    // Capture session teardown — use queue-specific key to avoid deadlock if last
    // retain was released from within captureQueue itself
    void (^captureCleanup)(void) = ^{
        if (self.captureSession && self.captureSession.isRunning) {
            [self.captureSession stopRunning];
        }
    };
    if (dispatch_get_specific(kCaptureQueueSpecificKey)) {
        captureCleanup();
    } else if (self.captureQueue) {
        dispatch_sync(self.captureQueue, captureCleanup);
    }

    // Recording teardown — same pattern
    void (^recordingCleanup)(void) = ^{
        self.recordingActive = NO;
        self.recordingStarting = NO;
        self.recordingState = HJRecordingStateIdle;
        if (self.assetWriter) {
            [self.assetWriter cancelWriting];
        }
        self.pixelBufferAdaptor = nil;
        if (self.scaleBufferPool) {
            CVPixelBufferPoolRelease(self.scaleBufferPool);
            self.scaleBufferPool = NULL;
        }
    };
    if (dispatch_get_specific(kRecordingQueueSpecificKey)) {
        recordingCleanup();
    } else if (self.recordingQueue) {
        dispatch_sync(self.recordingQueue, recordingCleanup);
    }

    [[NSNotificationCenter defaultCenter] removeObserver:self];
    [[UIDevice currentDevice] endGeneratingDeviceOrientationNotifications];

    if (_sharedInstance == self) {
        _sharedInstance = nil;
    }
    NSLog(@"[HeyJoeCapturer] Deallocated");
}

#pragma mark - Orientation Handling

- (void)deviceOrientationDidChange:(NSNotification *)notification {
    self.cachedDeviceOrientation = [UIDevice currentDevice].orientation;
}

- (void)handleMemoryWarning:(NSNotification *)notification {
    NSLog(@"[HeyJoeCapturer] MEMORY WARNING received");
    if (self.recordingActive) {
        NSLog(@"[HeyJoeCapturer] Stopping recording due to memory pressure");
        dispatch_async(self.recordingQueue, ^{
            if (self.recordingState == HJRecordingStateRecording) {
                self.lastRecordingFailurePoint = @"memoryWarning";
                [self _failRecordingWithError:[NSError errorWithDomain:@"HeyJoeCapturer" code:20
                    userInfo:@{NSLocalizedDescriptionKey: @"Recording stopped due to low memory"}]];
            }
        });
    }
}

- (UIDeviceOrientation)currentDeviceOrientation {
    return self.cachedDeviceOrientation;
}

- (RTCVideoRotation)rtcVideoRotationForCurrentDeviceOrientation {
    UIDeviceOrientation deviceOrientation = [self currentDeviceOrientation];

    switch (deviceOrientation) {
        case UIDeviceOrientationPortrait:
            return RTCVideoRotation_0;
        case UIDeviceOrientationPortraitUpsideDown:
            return RTCVideoRotation_180;
        case UIDeviceOrientationLandscapeLeft:
            return RTCVideoRotation_270;
        case UIDeviceOrientationLandscapeRight:
            return RTCVideoRotation_90;
        default:
            return RTCVideoRotation_0;
    }
}

- (CGAffineTransform)videoTransformForCurrentDeviceOrientation {
    UIDeviceOrientation deviceOrientation = [self currentDeviceOrientation];

    switch (deviceOrientation) {
        case UIDeviceOrientationPortrait:
            return CGAffineTransformIdentity;
        case UIDeviceOrientationPortraitUpsideDown:
            return CGAffineTransformMakeRotation(M_PI);
        case UIDeviceOrientationLandscapeLeft:
            return CGAffineTransformMakeRotation(-M_PI_2);
        case UIDeviceOrientationLandscapeRight:
            return CGAffineTransformMakeRotation(M_PI_2);
        default:
            return CGAffineTransformIdentity;
    }
}

#pragma mark - Capture Control

- (void)startCaptureWithDevice:(AVCaptureDevice *)device
                        format:(AVCaptureDeviceFormat *)format
                           fps:(NSInteger)fps
             completionHandler:(void (^)(NSError *))completionHandler {

    dispatch_async(self.captureQueue, ^{
        if (self.isCapturing) {
            NSLog(@"[HeyJoeCapturer] Already capturing, ignoring start request");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(nil);
                });
            }
            return;
        }

        // Increment generation so any in-flight teardown from a previous stop
        // won't destroy this new session
        self.captureGeneration++;

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

            CMTime frameDuration = CMTimeMake(1, (int32_t)fps);
            device.activeVideoMinFrameDuration = frameDuration;
            device.activeVideoMaxFrameDuration = frameDuration;

            if ([device isFocusModeSupported:AVCaptureFocusModeContinuousAutoFocus]) {
                device.focusMode = AVCaptureFocusModeContinuousAutoFocus;
            }
            if ([device isExposureModeSupported:AVCaptureExposureModeContinuousAutoExposure]) {
                device.exposureMode = AVCaptureExposureModeContinuousAutoExposure;
            }

            // On a virtual multi-camera that includes the ultra-wide (e.g. the triple
            // camera), videoZoomFactor 1.0 is the ULTRA-WIDE (0.5x) lens — so without
            // this the preview would open zoomed out. Start at the wide lens so the
            // talent sees a normal 1x framing; zoom then ramps up toward the telephoto.
            if (@available(iOS 13.0, *)) {
                NSArray<AVCaptureDevice *> *constituents = device.constituentDevices;
                NSArray<NSNumber *> *switchOver = device.virtualDeviceSwitchOverVideoZoomFactors;
                if (constituents.count > 1) {
                    NSInteger wideIndex = -1;
                    for (NSInteger i = 0; i < (NSInteger)constituents.count; i++) {
                        if ([constituents[i].deviceType isEqualToString:AVCaptureDeviceTypeBuiltInWideAngleCamera]) {
                            wideIndex = i;
                            break;
                        }
                    }
                    if (wideIndex > 0 && (NSInteger)switchOver.count >= wideIndex) {
                        CGFloat wideBase = [switchOver[wideIndex - 1] doubleValue];
                        device.videoZoomFactor = MAX(device.minAvailableVideoZoomFactor,
                                                     MIN(wideBase, device.maxAvailableVideoZoomFactor));
                        NSLog(@"[HeyJoeCapturer] Initial zoom set to wide base %.2f (virtual multi-camera)", wideBase);
                    }
                }
            }

            [device unlockForConfiguration];
            NSLog(@"[HeyJoeCapturer] Camera configured: %dx%d @ %ldfps", self.videoWidth, self.videoHeight, (long)fps);

            // Log optical-zoom capability for the chosen device/format. If switch-over
            // factors are empty on the back camera, the selected format collapsed the
            // virtual device to a single lens — zoom would be digital-only and the
            // format chooser needs revisiting for this device.
            if (@available(iOS 13.0, *)) {
                NSArray<NSNumber *> *switchOver = device.virtualDeviceSwitchOverVideoZoomFactors;
                NSLog(@"[HeyJoeCapturer] Device %@ — constituents: %lu, switch-over zoom factors: %@, maxZoom: %.2f",
                      device.localizedName,
                      (unsigned long)device.constituentDevices.count,
                      switchOver,
                      device.maxAvailableVideoZoomFactor);
            }
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

        // Add video data output — delivered on videoOutputQueue
        self.videoDataOutput = [[AVCaptureVideoDataOutput alloc] init];
        self.videoDataOutput.alwaysDiscardsLateVideoFrames = YES;
        self.videoDataOutput.videoSettings = @{
            (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
        };
        [self.videoDataOutput setSampleBufferDelegate:self queue:self.videoOutputQueue];

        if ([self.captureSession canAddOutput:self.videoDataOutput]) {
            [self.captureSession addOutput:self.videoDataOutput];

            AVCaptureConnection *videoConnection = [self.videoDataOutput connectionWithMediaType:AVMediaTypeVideo];
            if (videoConnection) {
                if ([videoConnection isVideoOrientationSupported]) {
                    videoConnection.videoOrientation = AVCaptureVideoOrientationPortrait;
                }
                if (device.position == AVCaptureDevicePositionFront && [videoConnection isVideoMirroringSupported]) {
                    videoConnection.videoMirrored = YES;
                }

                // Smooth out handheld shake with the low-latency stabilizer only. The
                // cinematic modes buffer frames inside the capture pipeline and add
                // 1-2s of glass-to-glass delay — unacceptable on a live call. Standard
                // costs roughly one frame. If the active format doesn't support it,
                // this is silently ignored and activeVideoStabilizationMode stays Off.
                if (videoConnection.supportsVideoStabilization) {
                    videoConnection.preferredVideoStabilizationMode = AVCaptureVideoStabilizationModeStandard;
                    NSLog(@"[HeyJoeCapturer] Video stabilization requested (mode=%ld), active=%ld",
                          (long)videoConnection.preferredVideoStabilizationMode,
                          (long)videoConnection.activeVideoStabilizationMode);
                }
            }
        } else {
            NSLog(@"[HeyJoeCapturer] Cannot add video data output");
        }

        // Add audio data output — delivered on audioOutputQueue
        self.audioDataOutput = [[AVCaptureAudioDataOutput alloc] init];
        [self.audioDataOutput setSampleBufferDelegate:self queue:self.audioOutputQueue];

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
    NSLog(@"[HeyJoeCapturer] stopCaptureWithCompletionHandler: isCapturing=%d, recordingActive=%d, recordingStarting=%d",
          self.isCapturing, self.recordingActive, self.recordingStarting);
    dispatch_async(self.captureQueue, ^{
        if (!self.isCapturing) {
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler();
                });
            }
            return;
        }

        // Set isCapturing to NO immediately — callback queues will early-return
        self.isCapturing = NO;

        // Capture the current generation so the deferred teardown won't destroy
        // a session that was created by a subsequent startCapture call
        NSUInteger generationAtStop = self.captureGeneration;

        // Always dispatch to recordingQueue to check if ANY recording work is pending.
        // We can't rely solely on recordingActive because it's NO during Starting state
        // (before the first frame sets up compression). recordingState is queue-confined
        // to recordingQueue, so we must check it there.
        dispatch_async(self.recordingQueue, ^{
            if (self.recordingState != HJRecordingStateIdle) {
                // Recording in some state — stop it first, then stop capture in completion
                NSLog(@"[HeyJoeCapturer] Recording state=%ld during capture stop — stopping recording first",
                      (long)self.recordingState);
                [self _stopRecordingInternalWithCompletionHandler:^(NSURL *url, NSError *error) {
                    // Recording stopped, now notify JS of interruption and stop capture
                    dispatch_async(dispatch_get_main_queue(), ^{
                        [[NSNotificationCenter defaultCenter]
                            postNotificationName:@"HeyJoeRecordingInterruptedDuringCaptureStop"
                            object:nil];
                    });

                    // Now stop the capture session on captureQueue
                    dispatch_async(self.captureQueue, ^{
                        [self _teardownCaptureSessionForGeneration:generationAtStop];
                        if (completionHandler) {
                            dispatch_async(dispatch_get_main_queue(), ^{
                                completionHandler();
                            });
                        }
                    });
                }];
            } else {
                // No recording — just tear down capture on captureQueue
                dispatch_async(self.captureQueue, ^{
                    [self _teardownCaptureSessionForGeneration:generationAtStop];
                    if (completionHandler) {
                        dispatch_async(dispatch_get_main_queue(), ^{
                            completionHandler();
                        });
                    }
                });
            }
        });
    });
}

/// Must be called on captureQueue.
/// Checks generation counter to avoid destroying a session created by a newer startCapture.
- (void)_teardownCaptureSessionForGeneration:(NSUInteger)generation {
    if (generation != self.captureGeneration) {
        NSLog(@"[HeyJoeCapturer] Skipping stale teardown (gen %lu vs current %lu) — a new session was started",
              (unsigned long)generation, (unsigned long)self.captureGeneration);
        return;
    }
    if (self.captureSession && self.captureSession.isRunning) {
        [self.captureSession stopRunning];
    }
    self.captureSession = nil;
    self.videoInput = nil;
    self.audioInput = nil;
    self.videoDataOutput = nil;
    self.audioDataOutput = nil;
    NSLog(@"[HeyJoeCapturer] Capture session stopped and torn down (gen %lu)", (unsigned long)generation);
}

#pragma mark - Recording Control

- (BOOL)_setupAssetWriterWithWidth:(int)width height:(int)height bitrate:(int)bitrate {
    // Must be called on recordingQueue

    NSLog(@"[HeyJoeCapturer] _setupAssetWriterWithWidth: %dx%d @ %d Mbps H.264, URL=%@",
          width, height, bitrate / 1000000, self.recordingURL.path);

    NSError *error = nil;

    NSFileManager *fm = [NSFileManager defaultManager];
    if ([fm fileExistsAtPath:self.recordingURL.path]) {
        NSLog(@"[HeyJoeCapturer] WARNING: File already exists at recording URL during deferred setup - deleting");
        [fm removeItemAtURL:self.recordingURL error:nil];
    }

    self.assetWriter = [[AVAssetWriter alloc] initWithURL:self.recordingURL
                                                 fileType:AVFileTypeQuickTimeMovie
                                                    error:&error];
    if (error) {
        NSLog(@"[HeyJoeCapturer] RECORDING FAILURE at assetWriterCreate: domain=%@ code=%ld desc=%@ underlying=%@",
              error.domain, (long)error.code, error.localizedDescription, error.userInfo[NSUnderlyingErrorKey]);
        self.lastRecordingFailurePoint = @"assetWriterCreate";
        return NO;
    }

    // H.264 output settings — more reliable than HEVC for repeated start/stop cycles.
    // The hardware HEVC encoder can malfunction (-12780) after room transitions
    // tear down and recreate the capture pipeline. H.264 is robust against this.
    NSDictionary *videoSettings = @{
        AVVideoCodecKey: AVVideoCodecTypeH264,
        AVVideoWidthKey: @(width),
        AVVideoHeightKey: @(height),
        AVVideoCompressionPropertiesKey: @{
            AVVideoAverageBitRateKey: @(bitrate),
            AVVideoMaxKeyFrameIntervalKey: @(60),
            AVVideoExpectedSourceFrameRateKey: @(30),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
        }
    };

    self.videoWriterInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                              outputSettings:videoSettings];
    self.videoWriterInput.expectsMediaDataInRealTime = YES;

    CGAffineTransform videoTransform = [self videoTransformForCurrentDeviceOrientation];
    self.videoWriterInput.transform = videoTransform;
    NSLog(@"[HeyJoeCapturer] Video writer transform set for device orientation");

    // Create pixel buffer adaptor — only declare pixel format, not dimensions.
    // Callers scale pixel buffers to match output dimensions via vImage before
    // appending, so the adaptor's pool doesn't need dimension constraints.
    NSDictionary *sourcePixelBufferAttributes = @{
        (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    };
    self.pixelBufferAdaptor = [AVAssetWriterInputPixelBufferAdaptor
        assetWriterInputPixelBufferAdaptorWithAssetWriterInput:self.videoWriterInput
                                   sourcePixelBufferAttributes:sourcePixelBufferAttributes];

    // Audio output settings — hardcoded stereo 48kHz.
    // iOS WebRTC always provides 48kHz audio. Multi-mic arrays give 4 channels,
    // single-mic gives 1 channel — AAC handles both 4→2 downmix and 1→2 upmix.
    // Hardcoding avoids a race condition where the audio format detection code
    // hasn't run yet when the writer is configured (video frame arrives first).
    int outSampleRate = 48000;
    int outChannels = 2;
    int audioBitrate = 128000;

    AudioChannelLayout acl;
    memset(&acl, 0, sizeof(acl));
    acl.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo;

    NSDictionary *audioSettings = @{
        AVFormatIDKey: @(kAudioFormatMPEG4AAC),
        AVSampleRateKey: @(outSampleRate),
        AVNumberOfChannelsKey: @(outChannels),
        AVEncoderBitRateKey: @(audioBitrate),
        AVChannelLayoutKey: [NSData dataWithBytes:&acl length:sizeof(acl)]
    };

    NSLog(@"[HeyJoeCapturer] Audio settings: %dHz %dch stereo AAC @ %dkbps",
          outSampleRate, outChannels, audioBitrate / 1000);

    self.audioWriterInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio
                                                               outputSettings:audioSettings];
    self.audioWriterInput.expectsMediaDataInRealTime = YES;

    if ([self.assetWriter canAddInput:self.videoWriterInput]) {
        [self.assetWriter addInput:self.videoWriterInput];
    } else {
        NSLog(@"[HeyJoeCapturer] Cannot add video writer input - canAddInput returned NO, error=%@", self.assetWriter.error);
        self.lastRecordingFailurePoint = @"videoInputAdd";
        [self.assetWriter cancelWriting];
        self.assetWriter = nil;
        self.pixelBufferAdaptor = nil;
        return NO;
    }

    if ([self.assetWriter canAddInput:self.audioWriterInput]) {
        [self.assetWriter addInput:self.audioWriterInput];
        self.audioWriterInputAdded = YES;
    } else {
        NSLog(@"[HeyJoeCapturer] Cannot add audio writer input — continuing without audio");
        self.audioWriterInputAdded = NO;
    }

    NSLog(@"[HeyJoeCapturer] Asset writer created: video=added (H.264 %dx%d), audio=%s, URL=%@",
          width, height,
          self.audioWriterInputAdded ? "added" : "NO",
          self.recordingURL.path);
    return YES;
}

/// Downmixes a multi-channel interleaved PCM sample buffer to stereo by extracting
/// the first 2 channels. Returns NULL if already ≤2ch or on error.
/// Caller must CFRelease the returned buffer.
- (CMSampleBufferRef)_stereoBufferFromMultiChannel:(CMSampleBufferRef)sampleBuffer {
    CMFormatDescriptionRef fmt = CMSampleBufferGetFormatDescription(sampleBuffer);
    const AudioStreamBasicDescription *asbd = CMAudioFormatDescriptionGetStreamBasicDescription(fmt);
    if (!asbd || asbd->mChannelsPerFrame <= 2) return NULL;

    UInt32 bytesPerSample = asbd->mBitsPerChannel / 8;
    UInt32 inBPF = bytesPerSample * asbd->mChannelsPerFrame;
    UInt32 outBPF = bytesPerSample * 2;
    CMItemCount numFrames = CMSampleBufferGetNumSamples(sampleBuffer);
    size_t outLen = (size_t)numFrames * outBPF;

    CMBlockBufferRef srcBlock = CMSampleBufferGetDataBuffer(sampleBuffer);
    if (!srcBlock) return NULL;
    size_t srcLen;
    char *srcPtr;
    if (CMBlockBufferGetDataPointer(srcBlock, 0, NULL, &srcLen, &srcPtr) != noErr) return NULL;

    // Take first 2 channels from each interleaved frame
    void *outData = malloc(outLen);
    if (!outData) return NULL;
    for (CMItemCount i = 0; i < numFrames; i++) {
        memcpy((uint8_t *)outData + i * outBPF,
               (uint8_t *)srcPtr + i * inBPF, outBPF);
    }

    // Wrap in CMBlockBuffer (kCFAllocatorMalloc will free outData)
    CMBlockBufferRef outBlock = NULL;
    OSStatus st = CMBlockBufferCreateWithMemoryBlock(
        kCFAllocatorDefault, outData, outLen,
        kCFAllocatorMalloc, NULL, 0, outLen, 0, &outBlock);
    if (st != noErr) { free(outData); return NULL; }

    // Stereo format description
    AudioStreamBasicDescription stereoASBD = *asbd;
    stereoASBD.mChannelsPerFrame = 2;
    stereoASBD.mBytesPerFrame = outBPF;
    stereoASBD.mBytesPerPacket = outBPF;

    AudioChannelLayout acl;
    memset(&acl, 0, sizeof(acl));
    acl.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo;

    CMAudioFormatDescriptionRef stereoFmt = NULL;
    st = CMAudioFormatDescriptionCreate(kCFAllocatorDefault, &stereoASBD,
                                        sizeof(acl), &acl, 0, NULL, NULL, &stereoFmt);
    if (st != noErr) { CFRelease(outBlock); return NULL; }

    // New sample buffer
    CMSampleTimingInfo timing;
    CMSampleBufferGetSampleTimingInfo(sampleBuffer, 0, &timing);

    CMSampleBufferRef stereoBuf = NULL;
    st = CMAudioSampleBufferCreateWithPacketDescriptions(
        kCFAllocatorDefault, outBlock, true, NULL, NULL,
        stereoFmt, numFrames, timing.presentationTimeStamp, NULL, &stereoBuf);

    CFRelease(outBlock);
    CFRelease(stereoFmt);
    return (st == noErr) ? stereoBuf : NULL;
}

/// Must be called on recordingQueue. Handles audio sample from audioOutputQueue.
- (void)_handleAudioSample:(CMSampleBufferRef)sampleBuffer {
    if (self.recordingState != HJRecordingStateRecording) {
        CFRelease(sampleBuffer);
        return;
    }

    if (!self.hasWrittenFirstVideoFrame) {
        CFRelease(sampleBuffer);
        return;
    }

    // Drop audio samples with PTS before the recording session start time.
    CMTime audioPTS = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    if (CMTIME_IS_VALID(self.recordingStartTime) &&
        CMTimeCompare(audioPTS, self.recordingStartTime) < 0) {
        if (self.audioFrameCount == 0) {
            NSLog(@"[HeyJoeCapturer] Dropping audio sample with PTS %.3f < session start %.3f",
                  CMTimeGetSeconds(audioPTS), CMTimeGetSeconds(self.recordingStartTime));
        }
        CFRelease(sampleBuffer);
        return;
    }

    if (self.assetWriter.status == AVAssetWriterStatusWriting &&
        self.audioWriterInput.readyForMoreMediaData) {

        // Downmix >2ch to stereo. iOS mic arrays deliver 4ch but the AAC
        // encoder only supports 1-2ch. AVAssetWriterInput won't auto-downmix.
        CMSampleBufferRef stereoBuffer = [self _stereoBufferFromMultiChannel:sampleBuffer];
        CMSampleBufferRef bufferToAppend = stereoBuffer ?: sampleBuffer;

        if (self.audioFrameCount == 0) {
            CMFormatDescriptionRef inFmt = CMSampleBufferGetFormatDescription(sampleBuffer);
            CMFormatDescriptionRef outFmt = CMSampleBufferGetFormatDescription(bufferToAppend);
            const AudioStreamBasicDescription *inASBD = inFmt ? CMAudioFormatDescriptionGetStreamBasicDescription(inFmt) : NULL;
            const AudioStreamBasicDescription *outASBD = outFmt ? CMAudioFormatDescriptionGetStreamBasicDescription(outFmt) : NULL;
            NSLog(@"[HeyJoeCapturer] First audio frame: %.0fHz %uch → %uch %s",
                  inASBD ? inASBD->mSampleRate : 0,
                  inASBD ? (unsigned)inASBD->mChannelsPerFrame : 0,
                  outASBD ? (unsigned)outASBD->mChannelsPerFrame : 0,
                  stereoBuffer ? "(downmixed)" : "(passthrough)");
        }
        self.audioFrameCount++;
        if (![self.audioWriterInput appendSampleBuffer:bufferToAppend]) {
            NSError *audioErr = self.assetWriter.error;
            NSLog(@"[HeyJoeCapturer] RECORDING FAILURE at audioAppend: domain=%@ code=%ld desc=%@ underlying=%@, writerStatus=%ld",
                  audioErr.domain, (long)audioErr.code, audioErr.localizedDescription,
                  audioErr.userInfo[NSUnderlyingErrorKey], (long)self.assetWriter.status);
            self.lastRecordingFailurePoint = @"audioAppend";
            if (self.assetWriter.status == AVAssetWriterStatusFailed) {
                if (stereoBuffer) CFRelease(stereoBuffer);
                CFRelease(sampleBuffer);
                [self _failRecordingWithError:audioErr];
                return;
            }
        }
        if (stereoBuffer) CFRelease(stereoBuffer);
    }

    CFRelease(sampleBuffer);
}

/// Central error handler — must be called on recordingQueue.
/// All error paths funnel through here.
- (void)_failRecordingWithError:(NSError *)error {
    // Rich error logging
    NSLog(@"[HeyJoeCapturer] RECORDING FAILURE at %@: domain=%@ code=%ld desc=%@ underlying=%@",
          self.lastRecordingFailurePoint ?: @"unknown",
          error.domain, (long)error.code, error.localizedDescription,
          error.userInfo[NSUnderlyingErrorKey]);

    // State dump at failure
    NSLog(@"[HeyJoeCapturer] State at failure: recordingState=%ld, isCapturing=%d, "
          "writerStatus=%ld, encodedFrames=%d, hasFirstVideoFrame=%d, audioAdded=%d",
          (long)self.recordingState, self.isCapturing,
          (long)(self.assetWriter ? self.assetWriter.status : -1),
          self.encodedFrameCount,
          self.hasWrittenFirstVideoFrame, self.audioWriterInputAdded);

    self.recordingActive = NO;
    self.recordingStarting = NO;
    self.recordingState = HJRecordingStateIdle;

    self.pixelBufferAdaptor = nil;
    if (self.scaleBufferPool) {
        CVPixelBufferPoolRelease(self.scaleBufferPool);
        self.scaleBufferPool = NULL;
    }

    // Cancel asset writer
    if (self.assetWriter) {
        [self.assetWriter cancelWriting];
    }

    // Clean up all recording state
    self.assetWriter = nil;
    self.videoWriterInput = nil;
    self.audioWriterInput = nil;
    self.recordingURL = nil;
    self.hasWrittenFirstVideoFrame = NO;
    self.recordingStartTime = kCMTimeInvalid;
    self.recordingSetupError = nil;

    // Call pending completion handler if any
    void (^pendingCompletion)(NSURL *, NSError *) = self.recordingCompletionHandler;
    self.recordingCompletionHandler = nil;
    if (pendingCompletion) {
        dispatch_async(dispatch_get_main_queue(), ^{
            pendingCompletion(nil, error);
        });
    }

    // Build rich error info for JS
    NSMutableDictionary *errorInfo = [NSMutableDictionary dictionary];
    errorInfo[@"error"] = error.localizedDescription ?: @"Unknown error";
    errorInfo[@"domain"] = error.domain ?: @"unknown";
    errorInfo[@"code"] = @(error.code);
    if (error.userInfo[NSUnderlyingErrorKey]) {
        NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
        errorInfo[@"underlyingError"] = [NSString stringWithFormat:@"%@ code=%ld", underlying.domain, (long)underlying.code];
    }
    errorInfo[@"failurePoint"] = self.lastRecordingFailurePoint ?: @"unknown";

    // Notify JS
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSNotificationCenter defaultCenter]
            postNotificationName:@"HeyJoeRecordingFailedMidStream"
            object:nil
            userInfo:errorInfo];
    });
}

- (void)startRecordingToURL:(NSURL *)outputURL
          completionHandler:(void (^)(NSError *))completionHandler {

    dispatch_async(self.recordingQueue, ^{
        if (!self.isCapturing) {
            NSLog(@"[HeyJoeCapturer] Cannot start recording — not capturing");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler([NSError errorWithDomain:@"HeyJoeCapturer" code:3 userInfo:@{NSLocalizedDescriptionKey: @"Not capturing"}]);
                });
            }
            return;
        }

        if (self.recordingState != HJRecordingStateIdle) {
            NSLog(@"[HeyJoeCapturer] Already recording (state=%ld)", (long)self.recordingState);
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler([NSError errorWithDomain:@"HeyJoeCapturer" code:4 userInfo:@{NSLocalizedDescriptionKey: @"Already recording"}]);
                });
            }
            return;
        }

        // Pre-recording cleanup: force-clean any stale resources
        self.pixelBufferAdaptor = nil;
        if (self.scaleBufferPool) {
            CVPixelBufferPoolRelease(self.scaleBufferPool);
            self.scaleBufferPool = NULL;
        }
        if (self.assetWriter) {
            NSLog(@"[HeyJoeCapturer] Cleaning up stale asset writer before new recording (status=%ld)",
                  (long)self.assetWriter.status);
            [self.assetWriter cancelWriting];
            self.assetWriter = nil;
            self.videoWriterInput = nil;
            self.audioWriterInput = nil;
        }

        // Delete existing file if present
        NSFileManager *fileManager = [NSFileManager defaultManager];
        if ([fileManager fileExistsAtPath:outputURL.path]) {
            [fileManager removeItemAtURL:outputURL error:nil];
        }

        self.recordingURL = outputURL;
        self.hasWrittenFirstVideoFrame = NO;
        self.recordingStartTime = kCMTimeInvalid;
        self.recordingSetupError = nil;
        self.encodedFrameCount = 0;
        self.audioFrameCount = 0;
        self.lastRecordingFailurePoint = nil;
        self.recordingCompletionHandler = nil;

        // Transition: Idle → Starting
        self.recordingState = HJRecordingStateStarting;
        self.recordingStarting = YES;
        // recordingActive stays NO until we actually transition to Recording
        // (after compression session is set up on first frame dispatch)

        NSLog(@"[HeyJoeCapturer] startRecordingToURL: isCapturing=%d, recordingState=%ld, "
              "existingWriter=%@(status=%ld), target=%s, URL=%@",
              self.isCapturing, (long)self.recordingState,
              self.assetWriter ? @"YES" : @"NO",
              (long)(self.assetWriter ? self.assetWriter.status : -1),
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
    dispatch_async(self.recordingQueue, ^{
        [self _stopRecordingInternalWithCompletionHandler:completionHandler];
    });
}

/// Must be called on recordingQueue.
- (void)_stopRecordingInternalWithCompletionHandler:(void (^)(NSURL *, NSError *))completionHandler {
    // Check for deferred errors
    if (self.recordingState == HJRecordingStateIdle && self.recordingSetupError) {
        NSError *setupErr = self.recordingSetupError;
        self.recordingSetupError = nil;
        NSLog(@"[HeyJoeCapturer] Reporting deferred recording setup error: %@", setupErr);
        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(nil, setupErr);
            });
        }
        return;
    }

    if (self.recordingState == HJRecordingStateIdle) {
        NSLog(@"[HeyJoeCapturer] Not recording, nothing to stop");
        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(nil, [NSError errorWithDomain:@"HeyJoeCapturer" code:7 userInfo:@{NSLocalizedDescriptionKey: @"Not recording"}]);
            });
        }
        return;
    }

    // Handle case where we're still in Starting state (no frames processed yet)
    if (self.recordingState == HJRecordingStateStarting) {
        NSLog(@"[HeyJoeCapturer] Recording stopped before any frames were processed");
        [self _cleanupRecordingState];
        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(nil, nil);
            });
        }
        return;
    }

    // Double-stop guard: if stop is already in progress, chain the completion handler
    if (self.recordingState == HJRecordingStateDraining ||
        self.recordingState == HJRecordingStateFinalizing) {
        NSLog(@"[HeyJoeCapturer] Stop already in progress (state=%ld), chaining completion",
              (long)self.recordingState);
        if (completionHandler) {
            void (^existing)(NSURL *, NSError *) = self.recordingCompletionHandler;
            self.recordingCompletionHandler = ^(NSURL *url, NSError *err) {
                if (existing) existing(url, err);
                dispatch_async(dispatch_get_main_queue(), ^{ completionHandler(url, err); });
            };
        }
        return;
    }

    NSURL *outputURL = self.recordingURL;

    NSLog(@"[HeyJoeCapturer] Stopping recording — state: %ld, assetWriter=%@",
          (long)self.recordingState,
          self.assetWriter ? @"exists" : @"nil");

    // Step 1: Stop accepting new frames
    // Do NOT nil pixelBufferAdaptor here — its pixel buffer pool must stay alive
    // until finishWritingWithCompletionHandler: completes. _cleanupRecordingState handles it.
    self.recordingActive = NO;
    self.recordingState = HJRecordingStateDraining;
    NSLog(@"[HeyJoeCapturer] recordingActive=NO, state=Draining — no more frames will be dispatched");

    // Step 2: Finalize asset writer
    self.recordingState = HJRecordingStateFinalizing;

    if (!self.assetWriter || self.assetWriter.status != AVAssetWriterStatusWriting) {
        // No writer or not in writing state
        NSError *writerError = self.assetWriter.error;
        AVAssetWriterStatus writerStatus = self.assetWriter ? self.assetWriter.status : -1;

        if (!self.assetWriter || writerStatus == AVAssetWriterStatusUnknown) {
            NSLog(@"[HeyJoeCapturer] No frames were written — recording too short");
            [self _cleanupRecordingState];
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(nil, nil);
                });
            }
        } else if (writerStatus == AVAssetWriterStatusCompleted) {
            NSLog(@"[HeyJoeCapturer] Asset writer already completed");
            [self _cleanupRecordingState];
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(outputURL, nil);
                });
            }
        } else {
            NSLog(@"[HeyJoeCapturer] Asset writer in unexpected state: %ld, error=%@",
                  (long)writerStatus, writerError);
            [self _cleanupRecordingState];
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    if (writerError) {
                        completionHandler(nil, writerError);
                    } else {
                        NSString *desc = [NSString stringWithFormat:
                            @"Recording failed — writer in state %ld (0=Unknown,3=Failed,4=Cancelled)",
                            (long)writerStatus];
                        completionHandler(nil, [NSError errorWithDomain:@"HeyJoeCapturer" code:8 userInfo:@{NSLocalizedDescriptionKey: desc}]);
                    }
                });
            }
        }
        return;
    }

    // Writer is in Writing state — finalize properly
    NSLog(@"[HeyJoeCapturer] Finishing asset writer...");
    [self.videoWriterInput markAsFinished];
    if (self.audioWriterInputAdded) {
        [self.audioWriterInput markAsFinished];
    }

    [self.assetWriter finishWritingWithCompletionHandler:^{
        // This completion runs on an arbitrary queue — dispatch back to recordingQueue
        dispatch_async(self.recordingQueue, ^{
            AVAssetWriterStatus finalStatus = self.assetWriter.status;
            NSError *finalError = self.assetWriter.error;

            if (finalStatus == AVAssetWriterStatusFailed) {
                NSLog(@"[HeyJoeCapturer] finishWriting completed but writer FAILED: %@", finalError);
                [self _cleanupRecordingState];
                if (completionHandler) {
                    dispatch_async(dispatch_get_main_queue(), ^{
                        completionHandler(nil, finalError ?: [NSError errorWithDomain:@"HeyJoeCapturer" code:11
                            userInfo:@{NSLocalizedDescriptionKey: @"Recording finalization failed"}]);
                    });
                }
                return;
            }

            NSLog(@"[HeyJoeCapturer] Recording finished: %@", outputURL.path);

            // Log file size
            NSError *fsError = nil;
            NSDictionary *attrs = [[NSFileManager defaultManager] attributesOfItemAtPath:outputURL.path error:&fsError];
            if (attrs) {
                unsigned long long fileSize = [attrs fileSize];
                NSLog(@"[HeyJoeCapturer] File size: %.2f MB", fileSize / (1024.0 * 1024.0));
            }

            [self _cleanupRecordingState];

            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(outputURL, nil);
                });
            }
        });
    }];
}

/// Must be called on recordingQueue. Resets all recording state to idle.
- (void)_cleanupRecordingState {
    self.recordingActive = NO;
    self.recordingStarting = NO;
    self.recordingState = HJRecordingStateIdle;
    self.hasWrittenFirstVideoFrame = NO;
    self.audioWriterInputAdded = NO;
    self.recordingStartTime = kCMTimeInvalid;
    self.recordingSetupError = nil;
    self.encodedFrameCount = 0;
    self.audioFrameCount = 0;
    self.pixelBufferAdaptor = nil;
    if (self.scaleBufferPool) {
        CVPixelBufferPoolRelease(self.scaleBufferPool);
        self.scaleBufferPool = NULL;
    }
    self.assetWriter = nil;
    self.videoWriterInput = nil;
    self.audioWriterInput = nil;
    self.recordingURL = nil;
    self.recordingCompletionHandler = nil;
}

#pragma mark - AVCaptureVideoDataOutputSampleBufferDelegate

- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {

    // Fast atomic check — early return if not capturing
    if (!self.isCapturing) return;

    // Handle video frames (delivered on videoOutputQueue)
    if (output == self.videoDataOutput) {
        CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
        if (!pixelBuffer) return;

        CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
        int64_t timeStampNs = CMTimeGetSeconds(timestamp) * NSEC_PER_SEC;

        // === WebRTC frame delivery (sync, fast, no I/O) ===
        RTCVideoRotation rotation = [self rtcVideoRotationForCurrentDeviceOrientation];

        int pbWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
        int pbHeight = (int)CVPixelBufferGetHeight(pixelBuffer);

        // Target 720p for WebRTC
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

        // === Recording: dispatch to recordingQueue if active ===
        // Both recordingActive and recordingStarting are atomic — safe to read from videoOutputQueue
        if (self.recordingActive || self.recordingStarting) {
            // Retain pixel buffer for async dispatch to recordingQueue
            CVPixelBufferRetain(pixelBuffer);
            CMTime ts = timestamp; // value copy
            dispatch_async(self.recordingQueue, ^{
                [self _encodeVideoFrame:pixelBuffer timestamp:ts];
                CVPixelBufferRelease(pixelBuffer);
            });
        }
    }
    // Handle audio frames (delivered on audioOutputQueue)
    else if (output == self.audioDataOutput) {
        if (self.recordingActive) {
            CFRetain(sampleBuffer);
            dispatch_async(self.recordingQueue, ^{
                [self _handleAudioSample:sampleBuffer];
            });
        }
    }
}

/// Must be called on recordingQueue. Returns a scaled pixel buffer from the pool, or NULL on failure.
/// Caller must CVPixelBufferRelease the returned buffer.
- (CVPixelBufferRef)_scaledPixelBufferFromBuffer:(CVPixelBufferRef)sourceBuffer
                                           width:(int)targetWidth
                                          height:(int)targetHeight {
    // Create pool on first use (or if dimensions changed)
    if (!self.scaleBufferPool) {
        NSDictionary *poolAttrs = @{
            (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
            (NSString *)kCVPixelBufferWidthKey: @(targetWidth),
            (NSString *)kCVPixelBufferHeightKey: @(targetHeight),
            (NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},
            (NSString *)kCVPixelBufferMetalCompatibilityKey: @YES
        };
        CVReturn status = CVPixelBufferPoolCreate(kCFAllocatorDefault, NULL,
                                                   (__bridge CFDictionaryRef)poolAttrs,
                                                   &_scaleBufferPool);
        if (status != kCVReturnSuccess) {
            NSLog(@"[HeyJoeCapturer] Failed to create scale buffer pool: %d", (int)status);
            return NULL;
        }
        NSLog(@"[HeyJoeCapturer] Created scale buffer pool: %dx%d", targetWidth, targetHeight);
    }

    CVPixelBufferRef destBuffer = NULL;
    CVReturn status = CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault,
                                                          self.scaleBufferPool,
                                                          &destBuffer);
    if (status != kCVReturnSuccess || !destBuffer) {
        NSLog(@"[HeyJoeCapturer] Failed to get buffer from scale pool: %d", (int)status);
        return NULL;
    }

    CVPixelBufferLockBaseAddress(sourceBuffer, kCVPixelBufferLock_ReadOnly);
    CVPixelBufferLockBaseAddress(destBuffer, 0);

    // Scale Y plane (plane 0)
    vImage_Buffer srcY = {
        .data = CVPixelBufferGetBaseAddressOfPlane(sourceBuffer, 0),
        .height = CVPixelBufferGetHeightOfPlane(sourceBuffer, 0),
        .width = CVPixelBufferGetWidthOfPlane(sourceBuffer, 0),
        .rowBytes = CVPixelBufferGetBytesPerRowOfPlane(sourceBuffer, 0)
    };
    vImage_Buffer dstY = {
        .data = CVPixelBufferGetBaseAddressOfPlane(destBuffer, 0),
        .height = CVPixelBufferGetHeightOfPlane(destBuffer, 0),
        .width = CVPixelBufferGetWidthOfPlane(destBuffer, 0),
        .rowBytes = CVPixelBufferGetBytesPerRowOfPlane(destBuffer, 0)
    };
    vImage_Error yErr = vImageScale_Planar8(&srcY, &dstY, NULL, kvImageNoFlags);

    // Scale CbCr plane (plane 1) — interleaved 2-byte pairs
    vImage_Buffer srcCbCr = {
        .data = CVPixelBufferGetBaseAddressOfPlane(sourceBuffer, 1),
        .height = CVPixelBufferGetHeightOfPlane(sourceBuffer, 1),
        .width = CVPixelBufferGetWidthOfPlane(sourceBuffer, 1),
        .rowBytes = CVPixelBufferGetBytesPerRowOfPlane(sourceBuffer, 1)
    };
    vImage_Buffer dstCbCr = {
        .data = CVPixelBufferGetBaseAddressOfPlane(destBuffer, 1),
        .height = CVPixelBufferGetHeightOfPlane(destBuffer, 1),
        .width = CVPixelBufferGetWidthOfPlane(destBuffer, 1),
        .rowBytes = CVPixelBufferGetBytesPerRowOfPlane(destBuffer, 1)
    };
    vImage_Error cErr = vImageScale_CbCr8(&srcCbCr, &dstCbCr, NULL, kvImageNoFlags);

    CVPixelBufferUnlockBaseAddress(destBuffer, 0);
    CVPixelBufferUnlockBaseAddress(sourceBuffer, kCVPixelBufferLock_ReadOnly);

    if (yErr != kvImageNoError || cErr != kvImageNoError) {
        NSLog(@"[HeyJoeCapturer] vImage scale failed Y=%ld CbCr=%ld — dropping buffer", yErr, cErr);
        CVPixelBufferRelease(destBuffer);
        return NULL;
    }

    return destBuffer; // caller must CVPixelBufferRelease
}

/// Must be called on recordingQueue. Appends a pixel buffer via AVAssetWriterInputPixelBufferAdaptor.
- (void)_encodeVideoFrame:(CVPixelBufferRef)pixelBuffer timestamp:(CMTime)timestamp {
    // Check recording state
    if (self.recordingState != HJRecordingStateStarting &&
        self.recordingState != HJRecordingStateRecording) {
        return;
    }

    // Deferred asset writer setup on first frame
    if (self.recordingState == HJRecordingStateStarting && !self.assetWriter) {
        int actualWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
        int actualHeight = (int)CVPixelBufferGetHeight(pixelBuffer);
        OSType pixelFormat = CVPixelBufferGetPixelFormatType(pixelBuffer);
        NSLog(@"[HeyJoeCapturer] First encode frame: pixelBuffer=%dx%d format=%.4s",
              actualWidth, actualHeight, (char *)&pixelFormat);

        // Compute target dimensions and bitrate.
        // For 1080p target, we downscale via vImage before appending.
        int targetWidth = actualWidth;
        int targetHeight = actualHeight;
        int bitrate = 25000000; // 25 Mbps for 4K (H.264)

        if (self.recordingTargetResolution == HeyJoeRecordingResolution1080p) {
            if (actualWidth > actualHeight) {
                targetWidth = MIN(actualWidth, 1920);
                targetHeight = MIN(actualHeight, 1080);
            } else {
                targetWidth = MIN(actualWidth, 1080);
                targetHeight = MIN(actualHeight, 1920);
            }
            bitrate = 10000000; // 10 Mbps for 1080p (H.264)
        }

        NSLog(@"[HeyJoeCapturer] Setting up asset writer: %dx%d @ %d Mbps H.264 (source: %dx%d, target: %s)",
              targetWidth, targetHeight, bitrate / 1000000,
              actualWidth, actualHeight,
              self.recordingTargetResolution == HeyJoeRecordingResolution4K ? "4K" : "1080p");

        self.writerTargetWidth = targetWidth;
        self.writerTargetHeight = targetHeight;

        if (![self _setupAssetWriterWithWidth:targetWidth height:targetHeight bitrate:bitrate]) {
            NSLog(@"[HeyJoeCapturer] Failed to setup asset writer");
            if (!self.lastRecordingFailurePoint) self.lastRecordingFailurePoint = @"assetWriterSetup";
            [self _failRecordingWithError:[NSError errorWithDomain:@"HeyJoeCapturer" code:5
                userInfo:@{NSLocalizedDescriptionKey: @"Asset writer setup failed"}]];
            return;
        }

        // Start writing
        if ([self.assetWriter startWriting]) {
            [self.assetWriter startSessionAtSourceTime:timestamp];
            self.recordingStartTime = timestamp;
            NSLog(@"[HeyJoeCapturer] Asset writer started at time: %.3f", CMTimeGetSeconds(timestamp));
        } else {
            NSError *writerErr = self.assetWriter.error;
            NSLog(@"[HeyJoeCapturer] RECORDING FAILURE at startWriting: domain=%@ code=%ld desc=%@ underlying=%@, writerStatus=%ld, URL=%@",
                  writerErr.domain, (long)writerErr.code, writerErr.localizedDescription,
                  writerErr.userInfo[NSUnderlyingErrorKey], (long)self.assetWriter.status, self.recordingURL);
            self.lastRecordingFailurePoint = @"startWriting";
            [self _failRecordingWithError:writerErr ?: [NSError errorWithDomain:@"HeyJoeCapturer" code:10
                userInfo:@{NSLocalizedDescriptionKey: @"Asset writer startWriting failed"}]];
            return;
        }

        // Transition: Starting → Recording
        self.recordingState = HJRecordingStateRecording;
        self.recordingActive = YES;
        self.recordingStarting = NO;
        NSLog(@"[HeyJoeCapturer] Recording state: Starting → Recording (recordingActive=YES)");
    }

    // Append pixel buffer via adaptor — scale down if needed for 1080p target
    if (self.assetWriter.status == AVAssetWriterStatusWriting) {
        self.encodedFrameCount++;
        if (self.encodedFrameCount <= 3) {
            size_t w = CVPixelBufferGetWidth(pixelBuffer);
            size_t h = CVPixelBufferGetHeight(pixelBuffer);
            OSType fmt = CVPixelBufferGetPixelFormatType(pixelBuffer);
            Boolean isSurface = CVPixelBufferGetIOSurface(pixelBuffer) != NULL;
            NSLog(@"[HeyJoeCapturer] Frame #%d — PixelBuffer: %zux%zu format=%.4s ioSurface=%d writerStatus=%ld PTS=%.3f",
                  self.encodedFrameCount, w, h, (char *)&fmt, isSurface,
                  (long)self.assetWriter.status, CMTimeGetSeconds(timestamp));
        } else if (self.encodedFrameCount % 30 == 0) {
            NSLog(@"[HeyJoeCapturer] Encoding video frame #%d", self.encodedFrameCount);
        }

        // Scale if source dimensions exceed writer output dimensions
        CVPixelBufferRef bufferToAppend = pixelBuffer;
        CVPixelBufferRef scaledBuffer = NULL;
        int srcWidth = (int)CVPixelBufferGetWidth(pixelBuffer);
        int srcHeight = (int)CVPixelBufferGetHeight(pixelBuffer);

        if (srcWidth != self.writerTargetWidth || srcHeight != self.writerTargetHeight) {
            scaledBuffer = [self _scaledPixelBufferFromBuffer:pixelBuffer
                                                        width:self.writerTargetWidth
                                                       height:self.writerTargetHeight];
            if (scaledBuffer) {
                bufferToAppend = scaledBuffer;
            } else {
                // Drop frame rather than appending wrong-sized buffer which
                // would put the writer into AVAssetWriterStatusFailed.
                return;
            }
        }

        if (self.videoWriterInput.readyForMoreMediaData) {
            if ([self.pixelBufferAdaptor appendPixelBuffer:bufferToAppend withPresentationTime:timestamp]) {
                if (!self.hasWrittenFirstVideoFrame) {
                    self.hasWrittenFirstVideoFrame = YES;
                    NSLog(@"[HeyJoeCapturer] First video frame appended OK — writerStatus=%ld PTS=%.3f",
                          (long)self.assetWriter.status, CMTimeGetSeconds(timestamp));
                }
            } else {
                NSError *appendErr = self.assetWriter.error;
                NSLog(@"[HeyJoeCapturer] RECORDING FAILURE at videoAppend: domain=%@ code=%ld desc=%@ underlying=%@, writerStatus=%ld",
                      appendErr.domain, (long)appendErr.code, appendErr.localizedDescription,
                      appendErr.userInfo[NSUnderlyingErrorKey], (long)self.assetWriter.status);
                self.lastRecordingFailurePoint = @"videoAppend";
                if (self.assetWriter.status == AVAssetWriterStatusFailed) {
                    if (scaledBuffer) CVPixelBufferRelease(scaledBuffer);
                    [self _failRecordingWithError:appendErr];
                    return;
                }
            }
        }

        if (scaledBuffer) CVPixelBufferRelease(scaledBuffer);
    } else if (self.assetWriter.status == AVAssetWriterStatusFailed) {
        NSError *err = self.assetWriter.error;
        NSLog(@"[HeyJoeCapturer] RECORDING FAILURE at writerFailed: domain=%@ code=%ld desc=%@ underlying=%@",
              err.domain, (long)err.code, err.localizedDescription, err.userInfo[NSUnderlyingErrorKey]);
        self.lastRecordingFailurePoint = @"writerFailed";
        [self _failRecordingWithError:err];
        return;
    }
}

#pragma mark - Helper Methods

+ (BOOL)formatSupportsPreferredStabilization:(AVCaptureDeviceFormat *)format {
    if (!format) return NO;
    // Only Standard is ever requested — the cinematic modes add 1-2s of latency.
    return [format isVideoStabilizationModeSupported:AVCaptureVideoStabilizationModeStandard];
}

+ (AVCaptureDeviceFormat *)bestFormatForDevice:(AVCaptureDevice *)device
                               targetFrameRate:(NSInteger)fps {
    if (!device) return nil;

    AVCaptureDeviceFormat *bestFormat = nil;
    int32_t bestPixelCount = 0;

    const int32_t maxPixelCount = 3840 * 2160;

    for (AVCaptureDeviceFormat *format in device.formats) {
        CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        int32_t pixelCount = dims.width * dims.height;

        if (pixelCount > maxPixelCount) {
            continue;
        }

        BOOL supportsTargetFps = NO;
        for (AVFrameRateRange *range in format.videoSupportedFrameRateRanges) {
            if (range.maxFrameRate >= fps) {
                supportsTargetFps = YES;
                break;
            }
        }

        if (!supportsTargetFps) continue;

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

    dispatch_async(self.captureQueue, ^{
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
    dispatch_async(self.captureQueue, ^{
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

- (void)setZoomFactorImmediate:(CGFloat)zoomFactor {
    if (isnan(zoomFactor) || isinf(zoomFactor) || zoomFactor <= 0) {
        return;
    }

    dispatch_async(self.captureQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        if (!device) {
            return;
        }

        NSError *error = nil;
        if ([device lockForConfiguration:&error]) {
            CGFloat minZoom = device.minAvailableVideoZoomFactor;
            CGFloat maxZoom = device.maxAvailableVideoZoomFactor;
            CGFloat clamped = MAX(minZoom, MIN(zoomFactor, maxZoom));

            // Direct set (no ramp) so a drag/slider tracks the finger responsively.
            device.videoZoomFactor = clamped;
            [device unlockForConfiguration];
        } else {
            NSLog(@"[HeyJoeCapturer] setZoomFactorImmediate: lock failed: %@", error);
        }
    });
}

- (void)getZoomConfigWithCompletionHandler:(void (^)(NSDictionary *config))completionHandler {
    dispatch_async(self.captureQueue, ^{
        AVCaptureDevice *device = self.videoInput.device;
        CGFloat currentZoom = 1.0;
        CGFloat minZoom = 1.0;
        CGFloat maxZoom = 1.0;
        CGFloat wideBase = 1.0;
        BOOL isMultiLens = NO;
        NSMutableArray<NSNumber *> *switchOver = [NSMutableArray array];

        if (device) {
            currentZoom = device.videoZoomFactor;
            minZoom = device.minAvailableVideoZoomFactor;
            maxZoom = device.maxAvailableVideoZoomFactor;

            if (@available(iOS 13.0, *)) {
                NSArray<AVCaptureDevice *> *constituents = device.constituentDevices;
                NSArray<NSNumber *> *factors = device.virtualDeviceSwitchOverVideoZoomFactors;
                isMultiLens = constituents.count > 1;

                if (factors) {
                    [switchOver addObjectsFromArray:factors];
                }

                if (isMultiLens) {
                    // UI "1x" is the wide lens. Its raw videoZoomFactor base is the
                    // switch-over factor just below it (because anything below that is
                    // the ultra-wide). If wide is the first constituent (no ultra-wide,
                    // e.g. dual W+T), the base is simply 1.0.
                    NSInteger wideIndex = -1;
                    for (NSInteger i = 0; i < (NSInteger)constituents.count; i++) {
                        if ([constituents[i].deviceType isEqualToString:AVCaptureDeviceTypeBuiltInWideAngleCamera]) {
                            wideIndex = i;
                            break;
                        }
                    }
                    if (wideIndex > 0 && (NSInteger)factors.count >= wideIndex) {
                        wideBase = [factors[wideIndex - 1] doubleValue];
                    } else {
                        wideBase = 1.0;
                    }
                }
            }
        }

        NSDictionary *config = @{
            @"currentZoom": @(currentZoom),
            @"minZoom": @(minZoom),
            @"maxZoom": @(maxZoom),
            @"wideBaseZoomFactor": @(wideBase),
            @"isMultiLens": @(isMultiLens),
            @"switchOverZoomFactors": switchOver
        };

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(config);
            });
        }
    });
}

@end
