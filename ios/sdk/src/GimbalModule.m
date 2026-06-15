#import "GimbalModule.h"
#import <React/RCTLog.h>

// HJGimbalController is a Swift class in this SDK target; the generated Swift header
// exposes it to Objective-C. If the SDK's product module name differs, adjust here.
#if __has_include(<JitsiMeetSDK/JitsiMeetSDK-Swift.h>)
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

@end
