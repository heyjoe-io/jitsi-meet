#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <WebRTC/RTCVideoCapturer.h>
#import <WebRTC/RTCVideoFrame.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * HeyJoeVideoCapturer - Single-session video capturer with 4K recording support
 *
 * This capturer manages a single AVCaptureSession that:
 * 1. Captures at the camera's native resolution (4K where supported)
 * 2. Feeds frames to WebRTC via RTCVideoCapturerDelegate
 * 3. Records locally via AVCaptureMovieFileOutput
 *
 * This solves the iOS limitation of only allowing one session per camera.
 */
@interface HeyJoeVideoCapturer : RTCVideoCapturer <AVCaptureVideoDataOutputSampleBufferDelegate, AVCaptureFileOutputRecordingDelegate>

/// The capture session - exposed for debugging/monitoring
@property (nonatomic, strong, readonly) AVCaptureSession *captureSession;

/// Current recording state
@property (nonatomic, assign, readonly) BOOL isRecording;

/// Current video dimensions
@property (nonatomic, assign, readonly) int videoWidth;
@property (nonatomic, assign, readonly) int videoHeight;

/// Shared instance for global access
+ (nullable instancetype)sharedInstance;
+ (void)setSharedInstance:(nullable HeyJoeVideoCapturer *)instance;

/// Initialize with delegate (typically RTCVideoSource)
- (instancetype)initWithDelegate:(id<RTCVideoCapturerDelegate>)delegate;

/// Start capturing from the specified camera
- (void)startCaptureWithDevice:(AVCaptureDevice *)device
                        format:(AVCaptureDeviceFormat *)format
                           fps:(NSInteger)fps
             completionHandler:(nullable void (^)(NSError * _Nullable error))completionHandler;

/// Stop capturing
- (void)stopCaptureWithCompletionHandler:(nullable void (^)(void))completionHandler;

/// Start recording to the specified file URL
- (void)startRecordingToURL:(NSURL *)outputURL
          completionHandler:(nullable void (^)(NSError * _Nullable error))completionHandler;

/// Stop recording
- (void)stopRecordingWithCompletionHandler:(nullable void (^)(NSURL * _Nullable fileURL, NSError * _Nullable error))completionHandler;

/// Get best available format for device (prefers highest resolution at 30fps)
+ (nullable AVCaptureDeviceFormat *)bestFormatForDevice:(AVCaptureDevice *)device
                                        targetFrameRate:(NSInteger)fps;

@end

NS_ASSUME_NONNULL_END
