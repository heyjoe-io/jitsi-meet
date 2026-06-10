#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <WebRTC/RTCVideoCapturer.h>
#import <WebRTC/RTCVideoFrame.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, HeyJoeRecordingResolution) {
    HeyJoeRecordingResolution4K = 0,
    HeyJoeRecordingResolution1080p = 1,
};

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

#pragma mark - Zoom Control

/// Set the camera zoom factor (clamped to device limits) with async completion
/// @param zoomFactor The desired zoom factor
/// @param completionHandler Called on main thread with actual zoom applied, zoom range, and any error
- (void)setZoomFactor:(CGFloat)zoomFactor
    completionHandler:(nullable void (^)(CGFloat actualZoom, CGFloat minZoom, CGFloat maxZoom, NSError * _Nullable error))completionHandler;

/// Get zoom info asynchronously (thread-safe)
/// @param completionHandler Called on main thread with current zoom, min, and max values
- (void)getZoomInfoWithCompletionHandler:(void (^)(CGFloat currentZoom, CGFloat minZoom, CGFloat maxZoom))completionHandler;

/// Set zoom immediately without the smooth ramp — used for slider/drag tracking so the
/// zoom follows the finger responsively. Clamped to device limits. Use setZoomFactor:
/// (ramped) for tapping a preset.
/// @param zoomFactor The desired raw videoZoomFactor
- (void)setZoomFactorImmediate:(CGFloat)zoomFactor;

/// Get full zoom configuration for building a 1x/2x/5x style zoom control. Returns a
/// dictionary with: currentZoom, minZoom, maxZoom (raw videoZoomFactor values),
/// wideBaseZoomFactor (the raw factor that corresponds to UI "1x", i.e. the wide lens),
/// isMultiLens (BOOL — whether a virtual multi-lens device with optical switching is
/// active), and switchOverZoomFactors (array of raw factors where the lens hands off).
/// @param completionHandler Called on main thread with the config dictionary
- (void)getZoomConfigWithCompletionHandler:(void (^)(NSDictionary *config))completionHandler;

/// Get the current zoom factor (synchronous, blocks on session queue)
- (CGFloat)currentZoomFactor;

/// Get the minimum zoom factor for the current device (synchronous, blocks on session queue)
- (CGFloat)minZoomFactor;

/// Get the maximum zoom factor for the current device (synchronous, blocks on session queue)
- (CGFloat)maxZoomFactor;

/// Target recording resolution (default: 1080p for smaller file sizes)
@property (nonatomic, assign) HeyJoeRecordingResolution recordingTargetResolution;

@end

NS_ASSUME_NONNULL_END
