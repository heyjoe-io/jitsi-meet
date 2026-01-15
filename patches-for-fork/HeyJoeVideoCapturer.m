#import "HeyJoeVideoCapturer.h"
#import <WebRTC/RTCCVPixelBuffer.h>
#import <WebRTC/RTCVideoFrameBuffer.h>

static HeyJoeVideoCapturer *_sharedInstance = nil;

@interface HeyJoeVideoCapturer ()

@property (nonatomic, strong) AVCaptureSession *captureSession;
@property (nonatomic, strong) AVCaptureDeviceInput *videoInput;
@property (nonatomic, strong) AVCaptureDeviceInput *audioInput;
@property (nonatomic, strong) AVCaptureVideoDataOutput *videoDataOutput;
@property (nonatomic, strong) AVCaptureMovieFileOutput *movieOutput;

@property (nonatomic, strong) dispatch_queue_t sessionQueue;
@property (nonatomic, strong) dispatch_queue_t videoQueue;

@property (nonatomic, assign) BOOL isRecording;
@property (nonatomic, assign) BOOL isCapturing;
@property (nonatomic, assign) int videoWidth;
@property (nonatomic, assign) int videoHeight;

@property (nonatomic, copy, nullable) void (^recordingCompletionHandler)(NSURL * _Nullable, NSError * _Nullable);

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
        _isRecording = NO;
        _isCapturing = NO;
        _videoWidth = 1280;
        _videoHeight = 720;

        // Set as shared instance
        [HeyJoeVideoCapturer setSharedInstance:self];

        NSLog(@"[HeyJoeCapturer] Initialized");
    }
    return self;
}

- (void)dealloc {
    [self stopCaptureWithCompletionHandler:nil];
    if (_sharedInstance == self) {
        _sharedInstance = nil;
    }
    NSLog(@"[HeyJoeCapturer] Deallocated");
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
            }
        } else {
            NSLog(@"[HeyJoeCapturer] Cannot add video data output");
        }

        // Add movie file output for recording
        self.movieOutput = [[AVCaptureMovieFileOutput alloc] init];
        self.movieOutput.maxRecordedFileSize = 0;
        self.movieOutput.maxRecordedDuration = kCMTimeInvalid;

        if ([self.captureSession canAddOutput:self.movieOutput]) {
            [self.captureSession addOutput:self.movieOutput];

            // Configure movie output connection
            AVCaptureConnection *movieConnection = [self.movieOutput connectionWithMediaType:AVMediaTypeVideo];
            if (movieConnection) {
                if ([movieConnection isVideoOrientationSupported]) {
                    movieConnection.videoOrientation = AVCaptureVideoOrientationPortrait;
                }
                if (device.position == AVCaptureDevicePositionFront && [movieConnection isVideoMirroringSupported]) {
                    movieConnection.videoMirrored = YES;
                }
                if ([movieConnection isVideoStabilizationSupported]) {
                    movieConnection.preferredVideoStabilizationMode = AVCaptureVideoStabilizationModeAuto;
                }

                // Set HEVC codec if available
                if (@available(iOS 11.0, *)) {
                    NSArray *availableCodecs = [self.movieOutput availableVideoCodecTypes];
                    if ([availableCodecs containsObject:AVVideoCodecTypeHEVC]) {
                        [self.movieOutput setOutputSettings:@{AVVideoCodecKey: AVVideoCodecTypeHEVC} forConnection:movieConnection];
                        NSLog(@"[HeyJoeCapturer] HEVC codec configured for recording");
                    }
                }
            }
            NSLog(@"[HeyJoeCapturer] Movie output added for recording");
        } else {
            NSLog(@"[HeyJoeCapturer] Cannot add movie output - recording will not be available");
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

        // Stop recording first if active
        if (self.isRecording && self.movieOutput.isRecording) {
            [self.movieOutput stopRecording];
        }

        [self.captureSession stopRunning];
        self.isCapturing = NO;

        self.captureSession = nil;
        self.videoInput = nil;
        self.audioInput = nil;
        self.videoDataOutput = nil;
        self.movieOutput = nil;

        NSLog(@"[HeyJoeCapturer] Capture session stopped");

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler();
            });
        }
    });
}

#pragma mark - Recording Control

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

        if (!self.movieOutput) {
            NSLog(@"[HeyJoeCapturer] Movie output not available");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler([NSError errorWithDomain:@"HeyJoeCapturer" code:5 userInfo:@{NSLocalizedDescriptionKey: @"Movie output not available"}]);
                });
            }
            return;
        }

        // Delete existing file if present
        NSFileManager *fileManager = [NSFileManager defaultManager];
        if ([fileManager fileExistsAtPath:outputURL.path]) {
            [fileManager removeItemAtURL:outputURL error:nil];
        }

        self.isRecording = YES;
        [self.movieOutput startRecordingToOutputFileURL:outputURL recordingDelegate:self];

        NSLog(@"[HeyJoeCapturer] Recording started to: %@", outputURL.path);

        if (completionHandler) {
            dispatch_async(dispatch_get_main_queue(), ^{
                completionHandler(nil);
            });
        }
    });
}

- (void)stopRecordingWithCompletionHandler:(void (^)(NSURL *, NSError *))completionHandler {
    dispatch_async(self.sessionQueue, ^{
        if (!self.isRecording || !self.movieOutput.isRecording) {
            NSLog(@"[HeyJoeCapturer] Not recording, nothing to stop");
            if (completionHandler) {
                dispatch_async(dispatch_get_main_queue(), ^{
                    completionHandler(nil, [NSError errorWithDomain:@"HeyJoeCapturer" code:6 userInfo:@{NSLocalizedDescriptionKey: @"Not recording"}]);
                });
            }
            return;
        }

        self.recordingCompletionHandler = completionHandler;
        [self.movieOutput stopRecording];

        NSLog(@"[HeyJoeCapturer] Recording stop requested");
    });
}

#pragma mark - AVCaptureVideoDataOutputSampleBufferDelegate

- (void)captureOutput:(AVCaptureOutput *)output
didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
       fromConnection:(AVCaptureConnection *)connection {

    if (!self.isCapturing) return;

    // Get pixel buffer from sample buffer
    CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
    if (!pixelBuffer) return;

    // Get timestamp
    CMTime timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer);
    int64_t timeStampNs = CMTimeGetSeconds(timestamp) * NSEC_PER_SEC;

    // Create RTCCVPixelBuffer wrapper
    RTCCVPixelBuffer *rtcPixelBuffer = [[RTCCVPixelBuffer alloc] initWithPixelBuffer:pixelBuffer];

    // Create RTCVideoFrame
    RTCVideoFrame *videoFrame = [[RTCVideoFrame alloc] initWithBuffer:rtcPixelBuffer
                                                             rotation:RTCVideoRotation_0
                                                          timeStampNs:timeStampNs];

    // Send to WebRTC delegate (RTCVideoSource)
    [self.delegate capturer:self didCaptureVideoFrame:videoFrame];
}

#pragma mark - AVCaptureFileOutputRecordingDelegate

- (void)captureOutput:(AVCaptureFileOutput *)output
didStartRecordingToOutputFileAtURL:(NSURL *)fileURL
       fromConnections:(NSArray<AVCaptureConnection *> *)connections {
    NSLog(@"[HeyJoeCapturer] Recording started to file: %@", fileURL.path);
}

- (void)captureOutput:(AVCaptureFileOutput *)output
didFinishRecordingToOutputFileAtURL:(NSURL *)outputFileURL
       fromConnections:(NSArray<AVCaptureConnection *> *)connections
                 error:(NSError *)error {

    self.isRecording = NO;

    // AVErrorRecordingSuccessfullyFinished = -11818
    BOOL success = (error == nil || error.code == noErr || error.code == -11818);

    NSLog(@"[HeyJoeCapturer] Recording finished. Success: %@, Error: %@", success ? @"YES" : @"NO", error);

    if (self.recordingCompletionHandler) {
        void (^handler)(NSURL *, NSError *) = self.recordingCompletionHandler;
        self.recordingCompletionHandler = nil;

        dispatch_async(dispatch_get_main_queue(), ^{
            if (success) {
                handler(outputFileURL, nil);
            } else {
                handler(nil, error);
            }
        });
    }
}

#pragma mark - Helper Methods

+ (AVCaptureDeviceFormat *)bestFormatForDevice:(AVCaptureDevice *)device
                               targetFrameRate:(NSInteger)fps {
    if (!device) return nil;

    AVCaptureDeviceFormat *bestFormat = nil;
    int32_t bestPixelCount = 0;

    for (AVCaptureDeviceFormat *format in device.formats) {
        CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        int32_t pixelCount = dims.width * dims.height;

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
        } else if (pixelCount == bestPixelCount && isBiplanar && bestFormat) {
            // Same resolution but better format
            FourCharCode bestPixelFormat = CMFormatDescriptionGetMediaSubType(bestFormat.formatDescription);
            if (bestPixelFormat != kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange &&
                bestPixelFormat != kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) {
                bestFormat = format;
            }
        }
    }

    if (bestFormat) {
        CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(bestFormat.formatDescription);
        NSLog(@"[HeyJoeCapturer] Best format for device: %dx%d", dims.width, dims.height);
    }

    return bestFormat;
}

@end
