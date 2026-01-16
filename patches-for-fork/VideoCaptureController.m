#if !TARGET_OS_TV

#import "VideoCaptureController.h"
#import "HeyJoeVideoCapturer.h"

#import <React/RCTLog.h>

@interface VideoCaptureController ()

@property(nonatomic, strong) RTCCameraVideoCapturer *capturer; // Keep for compatibility, but we use heyJoeCapturer
@property(nonatomic, strong) HeyJoeVideoCapturer *heyJoeCapturer;
@property(nonatomic, strong) AVCaptureDeviceFormat *selectedFormat;
@property(nonatomic, strong) AVCaptureDevice *device;
@property(nonatomic, copy) NSString *deviceId;
@property(nonatomic, assign) BOOL running;
@property(nonatomic, assign) BOOL usingFrontCamera;
@property(nonatomic, assign) int width;
@property(nonatomic, assign) int height;
@property(nonatomic, assign) int frameRate;

@end

@implementation VideoCaptureController

- (instancetype)initWithCapturer:(RTCCameraVideoCapturer *)capturer andConstraints:(NSDictionary *)constraints {
    self = [super init];
    if (self) {
        self.capturer = capturer;
        self.running = NO;

        // Default to the front camera.
        self.usingFrontCamera = YES;

        self.deviceId = constraints[@"deviceId"];
        self.width = [constraints[@"width"] intValue];
        self.height = [constraints[@"height"] intValue];
        self.frameRate = [constraints[@"frameRate"] intValue];

        if (self.frameRate == 0) {
            self.frameRate = 30;
        }

        id facingMode = constraints[@"facingMode"];

        if (facingMode && [facingMode isKindOfClass:[NSString class]]) {
            AVCaptureDevicePosition position;
            if ([facingMode isEqualToString:@"environment"]) {
                position = AVCaptureDevicePositionBack;
            } else if ([facingMode isEqualToString:@"user"]) {
                position = AVCaptureDevicePositionFront;
            } else {
                // If the specified facingMode value is not supported, fall back
                // to the front camera.
                position = AVCaptureDevicePositionFront;
            }

            self.usingFrontCamera = position == AVCaptureDevicePositionFront;
        }

        // Create our HeyJoeVideoCapturer using the same delegate as the original capturer
        // The delegate is the RTCVideoSource that feeds into WebRTC
        self.heyJoeCapturer = [[HeyJoeVideoCapturer alloc] initWithDelegate:capturer.delegate];

        RCTLog(@"[VideoCaptureController] Initialized with HeyJoeVideoCapturer for unified capture");
    }

    return self;
}

- (void)dealloc {
    self.device = NULL;
}

- (void)startCapture {
    if (self.deviceId) {
        self.device = [AVCaptureDevice deviceWithUniqueID:self.deviceId];
    }
    if (!self.device) {
        AVCaptureDevicePosition position =
            self.usingFrontCamera ? AVCaptureDevicePositionFront : AVCaptureDevicePositionBack;
        self.device = [self findDeviceForPosition:position];
    }

    if (!self.device) {
        RCTLogWarn(@"[VideoCaptureController] No capture devices found!");
        return;
    }

    // Get the BEST format (4K if available) instead of matching constraints
    AVCaptureDeviceFormat *format = [HeyJoeVideoCapturer bestFormatForDevice:self.device
                                                             targetFrameRate:self.frameRate];
    if (!format) {
        // Fallback to constraint-based selection
        format = [self selectFormatForDevice:self.device
                             withTargetWidth:self.width
                            withTargetHeight:self.height];
    }

    if (!format) {
        RCTLogWarn(@"[VideoCaptureController] No valid formats for device %@", self.device);
        return;
    }

    self.selectedFormat = format;

    CMVideoDimensions dims = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
    RCTLog(@"[VideoCaptureController] Starting capture at %dx%d (native resolution)", dims.width, dims.height);

    // Start HeyJoeVideoCapturer - fully async, no blocking
    __weak VideoCaptureController *weakSelf = self;
    [self.heyJoeCapturer startCaptureWithDevice:self.device
                                         format:format
                                            fps:self.frameRate
                              completionHandler:^(NSError *err) {
                                  if (err) {
                                      RCTLogError(@"[VideoCaptureController] Error starting capture: %@", err);
                                  } else {
                                      RCTLog(@"[VideoCaptureController] Capture started with HeyJoeVideoCapturer");
                                      weakSelf.running = YES;
                                  }
                              }];
}

- (void)stopCapture {
    if (!self.running)
        return;

    RCTLog(@"[VideoCaptureController] Capture will stop");

    // Fully async - no blocking
    __weak VideoCaptureController *weakSelf = self;
    [self.heyJoeCapturer stopCaptureWithCompletionHandler:^{
        RCTLog(@"[VideoCaptureController] Capture stopped");
        weakSelf.running = NO;
        weakSelf.device = nil;
    }];
}

- (void)switchCamera {
    self.usingFrontCamera = !self.usingFrontCamera;
    self.deviceId = nil;
    self.device = nil;

    // Stop and restart with new camera
    [self.heyJoeCapturer stopCaptureWithCompletionHandler:^{
        self.running = NO;
        [self startCapture];
    }];
}

#pragma mark NSKeyValueObserving

- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary<NSKeyValueChangeKey, id> *)change
                       context:(void *)context {
    if (@available(iOS 11.1, *)) {
        if ([object isKindOfClass:[AVCaptureDevice class]] && [keyPath isEqualToString:@"systemPressureState"]) {
            AVCaptureDevice *device = (AVCaptureDevice *)object;
            AVCaptureSystemPressureLevel pressureLevel =
                ((AVCaptureSystemPressureState *)change[NSKeyValueChangeNewKey]).level;
            if (pressureLevel == AVCaptureSystemPressureLevelSerious ||
                pressureLevel == AVCaptureSystemPressureLevelCritical) {
                RCTLogWarn(
                    @"[VideoCaptureController] Reached elevated system pressure level: %@. Throttling frame rate.",
                    pressureLevel);
                [self throttleFrameRateForDevice:device];
            } else if (pressureLevel == AVCaptureSystemPressureLevelNominal) {
                RCTLogWarn(@"[VideoCaptureController] Restored normal system pressure level. Resetting frame rate to "
                           @"default.");
                [self resetFrameRateForDevice:device];
            }
        }
    }
}

- (void)registerSystemPressureStateObserverForDevice:(AVCaptureDevice *)device {
    if (@available(iOS 11.1, *)) {
        [device addObserver:self forKeyPath:@"systemPressureState" options:NSKeyValueObservingOptionNew context:nil];
    }
}

- (void)removeObserverForDevice:(AVCaptureDevice *)device {
    if (@available(iOS 11.1, *)) {
        @try {
            [device removeObserver:self forKeyPath:@"systemPressureState"];
        } @catch (NSException *exception) {
            // Observer was not registered
        }
    }
}

#pragma mark Private

- (void)setDevice:(AVCaptureDevice *)device {
    if (_device) {
        [self removeObserverForDevice:_device];
    }
    if (device) {
        [self registerSystemPressureStateObserverForDevice:device];
    }

    _device = device;
}

- (AVCaptureDevice *)findDeviceForPosition:(AVCaptureDevicePosition)position {
    NSArray<AVCaptureDevice *> *captureDevices = [RTCCameraVideoCapturer captureDevices];
    for (AVCaptureDevice *device in captureDevices) {
        if (device.position == position) {
            return device;
        }
    }

    return [captureDevices firstObject];
}

- (AVCaptureDeviceFormat *)selectFormatForDevice:(AVCaptureDevice *)device
                                 withTargetWidth:(int)targetWidth
                                withTargetHeight:(int)targetHeight {
    NSArray<AVCaptureDeviceFormat *> *formats = [RTCCameraVideoCapturer supportedFormatsForDevice:device];
    AVCaptureDeviceFormat *selectedFormat = nil;
    int currentDiff = INT_MAX;

    for (AVCaptureDeviceFormat *format in formats) {
        CMVideoDimensions dimension = CMVideoFormatDescriptionGetDimensions(format.formatDescription);
        FourCharCode pixelFormat = CMFormatDescriptionGetMediaSubType(format.formatDescription);
        int diff = abs(targetWidth - dimension.width) + abs(targetHeight - dimension.height);
        if (diff < currentDiff) {
            selectedFormat = format;
            currentDiff = diff;
        } else if (diff == currentDiff && pixelFormat == [_capturer preferredOutputPixelFormat]) {
            selectedFormat = format;
        }
    }

    return selectedFormat;
}

- (void)throttleFrameRateForDevice:(AVCaptureDevice *)device {
    NSError *error = nil;

    [device lockForConfiguration:&error];
    if (error) {
        RCTLog(@"[VideoCaptureController] Could not lock device for configuration: %@", error);
        return;
    }

    device.activeVideoMinFrameDuration = CMTimeMake(1, 20);
    device.activeVideoMaxFrameDuration = CMTimeMake(1, 15);

    [device unlockForConfiguration];
}

- (void)resetFrameRateForDevice:(AVCaptureDevice *)device {
    NSError *error = nil;

    [device lockForConfiguration:&error];
    if (error) {
        RCTLog(@"[VideoCaptureController] Could not lock device for configuration: %@", error);
        return;
    }

    device.activeVideoMinFrameDuration = kCMTimeInvalid;
    device.activeVideoMaxFrameDuration = kCMTimeInvalid;

    [device unlockForConfiguration];
}

@end

#endif
