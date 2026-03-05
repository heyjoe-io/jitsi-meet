#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>
#import <AVFoundation/AVFoundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * HighResRecordModule - High resolution local recording for HeyJoe
 *
 * Uses the shared HeyJoeVideoCapturer singleton for recording at native
 * resolution (4K where supported) using hardware HEVC encoding.
 *
 * No internal queues or locks — delegates all recording state to the
 * capturer's recordingQueue and uses atomic recordingActive for fast checks.
 */
@interface HighResRecordModule : RCTEventEmitter <RCTBridgeModule>

/// Recording state — derived from the shared capturer's recordingActive flag
@property (nonatomic, assign, readonly) BOOL isRecording;

@end

NS_ASSUME_NONNULL_END
