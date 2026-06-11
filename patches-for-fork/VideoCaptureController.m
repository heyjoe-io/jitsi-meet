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

        // Thread-safe singleton — multiple getUserMedia calls during room join
        // can race here. Without @synchronized, all of them see sharedInstance==nil
        // and each creates a new HeyJoeVideoCapturer, causing 6+ instances that
        // fight over the hardware encoder.
        @synchronized([HeyJoeVideoCapturer class]) {
            HeyJoeVideoCapturer *existing = [HeyJoeVideoCapturer sharedInstance];
            if (existing) {
                [existing updateDelegate:capturer.delegate];
                self.heyJoeCapturer = existing;
                RCTLog(@"[VideoCaptureController] Reusing existing HeyJoeVideoCapturer instance");
            } else {
                self.heyJoeCapturer = [[HeyJoeVideoCapturer alloc] initWithDelegate:capturer.delegate];
                RCTLog(@"[VideoCaptureController] Created new HeyJoeVideoCapturer instance");
            }
        }
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

    AVCaptureDevicePosition position =
        self.usingFrontCamera ? AVCaptureDevicePositionFront : AVCaptureDevicePositionBack;
    AVCaptureDevice *newDevice = [self findDeviceForPosition:position];

    if (!newDevice) {
        RCTLogWarn(@"[VideoCaptureController] switchCamera: no device for position %ld", (long)position);
        return;
    }

    AVCaptureDeviceFormat *format = [HeyJoeVideoCapturer bestFormatForDevice:newDevice
                                                             targetFrameRate:self.frameRate];
    if (!format) {
        format = [self selectFormatForDevice:newDevice
                             withTargetWidth:self.width
                            withTargetHeight:self.height];
    }
    if (!format) {
        RCTLogWarn(@"[VideoCaptureController] switchCamera: no valid formats for device %@", newDevice);
        return;
    }

    self.device = newDevice;
    self.selectedFormat = format;

    // Swap the camera on the live session — an active recording survives the switch.
    // A full stop/start would force-stop the recording (the file gets finalized and
    // JS is notified, but the take is cut short), so it's only the fallback path.
    __weak VideoCaptureController *weakSelf = self;
    [self.heyJoeCapturer switchCaptureToDevice:newDevice
                                        format:format
                                           fps:self.frameRate
                             completionHandler:^(NSError *err) {
                                 if (!err) {
                                     RCTLog(@"[VideoCaptureController] Camera switched in-place");
                                     return;
                                 }
                                 RCTLogWarn(@"[VideoCaptureController] In-place camera switch failed (%@) — falling back to stop/start", err);
                                 [weakSelf.heyJoeCapturer stopCaptureWithCompletionHandler:^{
                                     weakSelf.running = NO;
                                     [weakSelf startCapture];
                                 }];
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
    // For the back camera, prefer a virtual multi-camera that INCLUDES the telephoto
    // lens, so zoom hands off to real optical glass (true 2x/5x) instead of digitally
    // cropping the wide sensor. builtInTripleCamera (UW+W+T) and builtInDualCamera
    // (W+T) both include a telephoto; builtInDualWideCamera (UW+W) does NOT, so we skip
    // it. WebRTC's RTCCameraVideoCapturer only ever vends the wide-angle lens, which is
    // why zoom was digital-only before. The capture pipeline is unchanged otherwise —
    // HeyJoeVideoCapturer just receives a different AVCaptureDevice.
    if (position == AVCaptureDevicePositionBack) {
        AVCaptureDevice *virtualDevice = [self preferredBackVirtualCamera];
        if (virtualDevice) {
            return virtualDevice;
        }
    }

    // Fallback (front camera, or a device with no telephoto): single wide lens via the
    // existing WebRTC discovery.
    NSArray<AVCaptureDevice *> *captureDevices = [RTCCameraVideoCapturer captureDevices];
    for (AVCaptureDevice *device in captureDevices) {
        if (device.position == position) {
            return device;
        }
    }

    return [captureDevices firstObject];
}

- (AVCaptureDevice *)preferredBackVirtualCamera {
    NSMutableArray<AVCaptureDeviceType> *preferred = [NSMutableArray array];

    if (@available(iOS 13.0, *)) {
        [preferred addObject:AVCaptureDeviceTypeBuiltInTripleCamera];
    }
    [preferred addObject:AVCaptureDeviceTypeBuiltInDualCamera];

    AVCaptureDeviceDiscoverySession *session =
        [AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:preferred
                                                               mediaType:AVMediaTypeVideo
                                                                position:AVCaptureDevicePositionBack];

    // Honor our preference order (triple before dual) regardless of discovery ordering.
    for (AVCaptureDeviceType type in preferred) {
        for (AVCaptureDevice *device in session.devices) {
            if ([device.deviceType isEqualToString:type]) {
                RCTLog(@"[VideoCaptureController] Using virtual multi-camera with telephoto: %@", type);
                return device;
            }
        }
    }

    RCTLog(@"[VideoCaptureController] No telephoto-capable virtual camera; falling back to wide lens (zoom will be digital)");
    return nil;
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
