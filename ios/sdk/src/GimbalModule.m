#import "GimbalModule.h"
#import <React/RCTLog.h>

// HJGimbalController is a Swift class compiled into the consuming target. The
// generated -Swift.h name is derived from the target's product module name:
// the app target ("jitsi-meet" → identifier "jitsi_meet") emits jitsi_meet-Swift.h,
// the SDK target emits JitsiMeetSDK-Swift.h. Check both so the gimbal files can be
// hosted by either target without touching this import.
#if __has_include("jitsi_meet-Swift.h")
#import "jitsi_meet-Swift.h"
#elif __has_include(<JitsiMeetSDK/JitsiMeetSDK-Swift.h>)
#import <JitsiMeetSDK/JitsiMeetSDK-Swift.h>
#else
#import "JitsiMeetSDK-Swift.h"
#endif

@implementation GimbalModule

RCT_EXPORT_MODULE(GimbalControl);

+ (BOOL)requiresMainQueueSetup {
    return NO;
}

- (instancetype)init {
    self = [super init];
    if (self) {
        // Begin watching for gimbal connect/disconnect, and forward those changes
        // to JS so the CD can enable/disable its controls.
        [HJGimbalController.shared startObserving];
        [[NSNotificationCenter defaultCenter] addObserver:self
                                                 selector:@selector(handleStatusChange:)
                                                     name:@"HJGimbalStatusDidChange"
                                                   object:nil];
    }
    return self;
}

- (void)dealloc {
    [[NSNotificationCenter defaultCenter] removeObserver:self];
}

- (NSArray<NSString *> *)supportedEvents {
    return @[@"onGimbalStatus"];
}

- (NSDictionary *)statusDict {
    HJGimbalController *g = HJGimbalController.shared;
    return @{
        @"supported": @(g.isSupported),
        @"connected": @(g.isConnected),
        @"tracking": @(g.isTrackingActive)
    };
}

- (void)handleStatusChange:(NSNotification *)note {
    [self sendEventWithName:@"onGimbalStatus" body:[self statusDict]];
}

RCT_EXPORT_METHOD(getStatus:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    resolve([self statusDict]);
}

RCT_EXPORT_METHOD(executeCommand:(NSString *)command
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    [HJGimbalController.shared executeCommand:command completion:^(BOOL ok, NSString *error) {
        HJGimbalController *g = HJGimbalController.shared;
        resolve(@{
            @"ok": @(ok),
            @"error": error ?: [NSNull null],
            @"connected": @(g.isConnected),
            @"tracking": @(g.isTrackingActive)
        });
    }];
}

// Continuous press-and-hold moves (Gimbal_Continuous_PanTilt_Spec). Only
// startMove replies (so a failed start reaches the CD); keepalive/stop are
// fire-and-forget — the dead-man watchdog in HJGimbalController is the
// safety guarantee, not these calls.
RCT_EXPORT_METHOD(startMove:(NSString *)direction
                  moveId:(NSString *)moveId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    [HJGimbalController.shared startMove:direction moveId:moveId completion:^(BOOL ok, NSString *error) {
        resolve(@{
            @"ok": @(ok),
            @"error": error ?: [NSNull null]
        });
    }];
}

RCT_EXPORT_METHOD(moveKeepalive:(NSString *)moveId) {
    [HJGimbalController.shared moveKeepalive:moveId];
}

RCT_EXPORT_METHOD(stopMove:(NSString *)moveId) {
    [HJGimbalController.shared stopMove:moveId];
}

@end
