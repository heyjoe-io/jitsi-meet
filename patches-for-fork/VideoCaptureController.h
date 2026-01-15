#if !TARGET_OS_TV

#import <Foundation/Foundation.h>
#import <WebRTC/RTCCameraVideoCapturer.h>

#import "CaptureController.h"

// Forward declaration for HeyJoeVideoCapturer
@class HeyJoeVideoCapturer;

@interface VideoCaptureController : CaptureController
@property(nonatomic, readonly, strong) AVCaptureDeviceFormat *selectedFormat;
@property(nonatomic, readonly, assign) int frameRate;

// Expose the capturer for recording access
@property(nonatomic, readonly, strong) HeyJoeVideoCapturer *heyJoeCapturer;

- (instancetype)initWithCapturer:(RTCCameraVideoCapturer *)capturer andConstraints:(NSDictionary *)constraints;
- (void)startCapture;
- (void)stopCapture;
- (void)switchCamera;

@end
#endif
