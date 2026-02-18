#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * HighResRecordModule - High resolution local recording for HeyJoe
 *
 * Creates an independent AVCaptureSession for recording at native resolution
 * (4K where supported) using hardware HEVC encoding, completely separate from
 * WebRTC's streaming session.
 *
 * Architecture (Riverside-style):
 * - WebRTC uses its own capture session for low-res streaming
 * - HighResRecorder creates a separate session for high-res local recording
 * - Both can access the camera simultaneously on iOS
 * - Uses AVCaptureMovieFileOutput for optimal performance
 */
@interface HighResRecordModule : RCTEventEmitter <RCTBridgeModule>

// Recording state (readonly for external access)
@property (nonatomic, assign, readonly) BOOL isRecording;
@property (nonatomic, strong, readonly, nullable) NSString *currentFilePath;

@end

NS_ASSUME_NONNULL_END
