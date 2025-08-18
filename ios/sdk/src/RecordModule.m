#import <Foundation/Foundation.h>
#import <React/RCTLog.h>
#import "WebRTCModule.h"
#import <WebRTC/RTCVideoFrame.h>
#import <React/RCTBridgeModule.h>
#import <CoreImage/CoreImage.h>
#import <AVFoundation/AVFoundation.h>


@interface CustomVideoRenderer : NSObject <RTCVideoRenderer>

@property (nonatomic, strong) AVAssetWriter *assetWriter;
@property (nonatomic, strong) AVAssetWriterInput *videoInput;
@property (nonatomic, strong) AVAssetWriterInput *audioInput;
@property (nonatomic, strong) AVAssetWriterInputPixelBufferAdaptor *videoAdaptor;

@property (nonatomic, strong) AVAudioEngine *audioEngine;
@property (nonatomic, strong) AVAudioInputNode *inputNode;
@property (nonatomic, strong) AVAudioFormat *audioFormat;

@property int64_t startTimestamp;
@property int64_t startAudioTimestamp;

- (void)startWritingToURL:(NSURL *)url mirror:(BOOL)mirror use1080p:(BOOL)use1080p;
- (CMSampleBufferRef)createSampleBufferFromPCMBuffer:(AVAudioPCMBuffer *)buffer when:(AVAudioTime *)when;
- (CVPixelBufferRef)pixelBufferFromI420Buffer:(RTCI420Buffer *)i420Buffer;
- (void)finishWriting;

@end

@implementation CustomVideoRenderer

static inline uint8_t clamp(int value) {
    return (uint8_t)(value < 0 ? 0 : (value > 255 ? 255 : value));
}

static int outputWidth = 1920;
static int outputHeight = 1080;
static bool using1080p = true;

- (CMSampleBufferRef)createSampleBufferFromPCMBuffer:(AVAudioPCMBuffer *)buffer when:(AVAudioTime *)when {
    // Ensure buffer and when are not nil
    if (!buffer || !when) return NULL;

    // Create audio format
    AVAudioFormat *audioFormat = buffer.format;

    if (self.startAudioTimestamp == -1) {
        self.startAudioTimestamp = when.sampleTime;
    }

    NSLog(@"when.sampleTime: %lld", when.sampleTime);
    NSLog(@"when.hostTime: %lld", when.hostTime);
    NSLog(@"when.sampleRate: %f", when.sampleRate);
    NSLog(@"buffer.frameLength: %d", buffer.frameLength);
    NSLog(@"buffer.sampleRate: %f", buffer.format.sampleRate);
    NSLog(@"buffer.mBytesPerFrame: %d", audioFormat.streamDescription->mBytesPerFrame);

    // Create timing info
    CMTime presentationTime = CMTimeMake(when.sampleTime - self.startAudioTimestamp, buffer.format.sampleRate);
    CMTime duration = CMTimeMake(buffer.frameLength,
                                 buffer.format.sampleRate);
    CMSampleTimingInfo timingInfo = {
        .duration = duration,
        .presentationTimeStamp = presentationTime,
        .decodeTimeStamp = presentationTime
    };

    // Create sample buffer
    CMSampleBufferRef sampleBuffer = NULL;
    CMBlockBufferRef blockBuffer = NULL;

    CMFormatDescriptionRef formatDescription = NULL;
    OSStatus status = CMAudioFormatDescriptionCreate(kCFAllocatorDefault,
                                                    audioFormat.streamDescription,
                                                    audioFormat.streamDescription->mBytesPerFrame,
                                                    NULL,
                                                    0,
                                                    NULL,
                                                    NULL,
                                                    &formatDescription);
    if (status != noErr) {
        return NULL;
    }

    status = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault,
          buffer.floatChannelData[0],
          buffer.frameLength * audioFormat.streamDescription->mBytesPerFrame,
          0,
          NULL,
          0,
          buffer.frameLength * audioFormat.streamDescription->mBytesPerFrame,
          0,
          &blockBuffer);

    if (status != noErr) {
        return NULL;
    }

    // Create a block buffer from the audio data
    status = CMSampleBufferCreate(kCFAllocatorDefault,
                                  blockBuffer,
                                  true,
                                  NULL,
                                  NULL,
                                  formatDescription,
                                  buffer.frameLength,
                                  1,
                                  &timingInfo,
                                  0,
                                  NULL,
                                  &sampleBuffer);
    
    return (status == noErr) ? sampleBuffer : NULL;
}

- (CVPixelBufferRef)pixelBufferFromI420Buffer:(RTCI420Buffer *)buffer {
    size_t width = buffer.width;
    size_t height = buffer.height;
    
    // Updated pixel buffer attributes to prevent ghosting
    NSDictionary *options = @{
        (NSString *)kCVPixelBufferCGImageCompatibilityKey: @YES,
        (NSString *)kCVPixelBufferCGBitmapContextCompatibilityKey: @YES,
        (NSString *)kCVPixelBufferIOSurfacePropertiesKey: @{},  // Add this line
        (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
        (NSString *)kCVPixelBufferWidthKey: @(width),
        (NSString *)kCVPixelBufferHeightKey: @(height),
        (NSString *)kCVPixelBufferBytesPerRowAlignmentKey: @(16)  // Add this line
    };

    CVPixelBufferRef pixelBuffer = NULL;
    CVReturn status = CVPixelBufferCreate(kCFAllocatorDefault, width, height,
                                         kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)options,
                                         &pixelBuffer);

    if (status != kCVReturnSuccess) {
        NSLog(@"Error creating pixel buffer: %d", status);
        return NULL;
    }

    CVPixelBufferLockBaseAddress(pixelBuffer, 0);

    uint8_t *baseAddress = (uint8_t *)CVPixelBufferGetBaseAddress(pixelBuffer);
    size_t bytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer);  // Use actual bytes per row

    const uint8_t *yPlane = buffer.dataY;
    const uint8_t *uPlane = buffer.dataU;
    const uint8_t *vPlane = buffer.dataV;

    size_t yStride = buffer.strideY;
    size_t uStride = buffer.strideU;
    size_t vStride = buffer.strideV;

    // Loop through each pixel and convert YUV to RGB with improved color conversion
    for (size_t row = 0; row < height; row++) {
        for (size_t col = 0; col < width; col++) {
            size_t yIndex = row * yStride + col;
            size_t uvIndex = (row / 2) * uStride + (col / 2);

            // Improved YUV to RGB conversion with proper scaling
            float y = (yPlane[yIndex] - 16) * 1.164;
            float u = uPlane[uvIndex] - 128;
            float v = vPlane[uvIndex] - 128;

            int r = y + 1.596 * v;
            int g = y - 0.813 * v - 0.391 * u;
            int b = y + 2.018 * u;

            // Use bytesPerRow for proper stride handling
            size_t pixelIndex = row * bytesPerRow + col * 4;
            
            // Clamp RGB values to [0, 255]
            baseAddress[pixelIndex] = clamp(b);     // B
            baseAddress[pixelIndex + 1] = clamp(g); // G
            baseAddress[pixelIndex + 2] = clamp(r); // R
            baseAddress[pixelIndex + 3] = 255;      // A
        }
    }

    CVPixelBufferUnlockBaseAddress(pixelBuffer, 0);
    return pixelBuffer;
}

- (CVPixelBufferRef)resizePixelBuffer:(CVPixelBufferRef)pixelBuffer width:(int)width height:(int)height {
    CIImage *ciImage = [CIImage imageWithCVPixelBuffer:pixelBuffer];
    CGFloat scaleX = (CGFloat)width / CVPixelBufferGetWidth(pixelBuffer);
    CGFloat scaleY = (CGFloat)height / CVPixelBufferGetHeight(pixelBuffer);
    CIImage *scaledImage = [ciImage imageByApplyingTransform:CGAffineTransformMakeScale(scaleX, scaleY)];
    
    CVPixelBufferRef newPixelBuffer = NULL;
    NSDictionary *attributes = @{ (NSString *)kCVPixelBufferPixelFormatTypeKey: @(kCVPixelFormatType_32BGRA),
                                  (NSString *)kCVPixelBufferWidthKey: @(width),
                                  (NSString *)kCVPixelBufferHeightKey: @(height) };
    
    CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, (__bridge CFDictionaryRef)attributes, &newPixelBuffer);
    
    if (!newPixelBuffer) {
        return NULL;
    }
    
    static CIContext *ciContext = nil;
    if (!ciContext) {
        ciContext = [CIContext contextWithOptions:nil];
    }
    
    [ciContext render:scaledImage toCVPixelBuffer:newPixelBuffer];
    
    return newPixelBuffer;
}

- (void)startWritingToURL:(NSURL *)url mirror:(BOOL)mirror use1080p:(BOOL)use1080p {
    // Initiate Audio engine first, and set video engine once we get actual size check setSize function
    NSLog(@"startWritingToURL called");

    using1080p = use1080p;

    self.assetWriter = [[AVAssetWriter alloc] initWithURL:url fileType:AVFileTypeMPEG4 error:nil];

    self.audioEngine = [[AVAudioEngine alloc] init];
    self.inputNode = self.audioEngine.inputNode;
    self.audioFormat = [self.inputNode outputFormatForBus:0];

    AVAudioFormat *audioFormat = [self.inputNode outputFormatForBus:0];

    NSDictionary *audioSettings = @{
        AVFormatIDKey: @(kAudioFormatMPEG4AAC),
        AVNumberOfChannelsKey: @(audioFormat.channelCount),
        AVSampleRateKey: @(audioFormat.sampleRate)
    };

    self.audioInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeAudio outputSettings:audioSettings];
    [self.assetWriter addInput:self.audioInput];
    self.audioInput.expectsMediaDataInRealTime = YES;

    __weak typeof(self) weakSelf = self;
    [self.inputNode installTapOnBus:0 bufferSize:8192 format:self.audioFormat block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
        NSLog(@"install Tap on bus invoke");
        if (buffer != nil && weakSelf.audioInput.isReadyForMoreMediaData) {
            NSLog(@"audio Input status pass");
            CMSampleBufferRef sampleBuffer = [weakSelf createSampleBufferFromPCMBuffer:buffer when:when];
            if (sampleBuffer) {
                if (![weakSelf.audioInput appendSampleBuffer:sampleBuffer]) {
                    NSLog(@"Failed to append audio sample buffer: %@", weakSelf.assetWriter.error);
                }
                CFRelease(sampleBuffer);
            }
        }
    }];

    self.startTimestamp = -1;
    self.startAudioTimestamp = -1;
}

- (void)finishWriting {
    [self.inputNode removeTapOnBus:0];
    [self.audioEngine stop];
    [self.videoInput markAsFinished];
    [self.audioInput markAsFinished];
    [self.assetWriter finishWritingWithCompletionHandler:^{
        NSLog(@"Finished writing to file");
    }];
}

// RTCVideoRenderer protocol method
- (void)renderFrame:(RTCVideoFrame *)frame {
    NSLog(@"Render Frame");
    if (self.assetWriter.status != AVAssetWriterStatusWriting) {
        NSLog(@"Status block - return");
        return;
    }

    NSLog(@"Assert writer status pass, %d, %d", frame.width, frame.height);

    CVPixelBufferRef pixelBuffer = nil;
    CVPixelBufferRef upscaledPixelBuffer = nil;
    RTCI420Buffer *frameBuffer = [frame.buffer toI420];
    pixelBuffer = [self pixelBufferFromI420Buffer:frameBuffer];

    upscaledPixelBuffer = [self resizePixelBuffer:pixelBuffer width:outputWidth height:outputHeight];

    NSLog(@"Assert writer upscale, %d, %d", outputWidth, outputHeight);

    if (self.startTimestamp == -1) {
        self.startTimestamp = frame.timeStampNs;
    }

    // Convert the timestamp from nanoseconds to CMTime
    CMTime time = CMTimeMake(frame.timeStampNs - self.startTimestamp, 1000000000);

    // Ensure the time is correct (for instance, you might want to start from the beginning of the session)
    if (self.videoAdaptor.assetWriterInput.readyForMoreMediaData) {
        if ([self.videoAdaptor appendPixelBuffer:upscaledPixelBuffer withPresentationTime:time]) {
            NSLog(@"Appended frame at time: %f", CMTimeGetSeconds(time));
        } else {
            NSLog(@"Failed to append frame: %@", self.assetWriter.error);
        }
    }

    CFRelease(pixelBuffer);
    CFRelease(upscaledPixelBuffer);
}

- (void)setSize:(CGSize)size {
    if (self.assetWriter.status == AVAssetWriterStatusWriting) {
        NSLog(@"Status block on setSize - return");
        return;
    }

    // Initiate video writer and fire record start
    NSLog(@"Set Size called! %f, %f : %f, %f", size.width, size.height, outputWidth, outputHeight);

    if (using1080p) {
        outputWidth = (size.width > size.height) ? 1920 : 1080;
        outputHeight = (size.width > size.height) ? 1080 : 1920;
    } else {
        outputWidth = (size.width > size.height) ? 1280 : 720;
        outputHeight = (size.width > size.height) ? 720 : 1280;
    }

    NSLog(@"Set Size output! %f, %f", outputWidth, outputHeight);

    NSDictionary *videoSettings = @{
        AVVideoCodecKey : AVVideoCodecTypeH264,
        AVVideoWidthKey : @(outputWidth),
        AVVideoHeightKey : @(outputHeight),
    };
    self.videoInput = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo outputSettings:videoSettings];
    [self.assetWriter addInput:self.videoInput];
    self.videoInput.expectsMediaDataInRealTime = YES;

    self.videoAdaptor = [[AVAssetWriterInputPixelBufferAdaptor alloc] initWithAssetWriterInput:self.videoInput sourcePixelBufferAttributes:nil];

    [self.assetWriter startWriting];
    [self.assetWriter startSessionAtSourceTime:kCMTimeZero];

    NSError *error = nil;
    [self.audioEngine startAndReturnError: &error]; // Start the audio engine
    if (error) {
        NSLog(@"Error starting audio engine: %@", error.localizedDescription);
    }
}

@end


@interface Recorder :  NSObject<RCTBridgeModule>

@property (nonatomic, strong) CustomVideoRenderer *videoRenderer;
@property (nonatomic, weak) RCTBridge *bridge;
@property (nonatomic, weak) RTCVideoTrack *localTrack;

@end

@implementation Recorder

NSString *filePath;

RCT_EXPORT_MODULE();

RCT_EXPORT_METHOD(startRecording:(NSString *)trackId
                  width:(NSInteger)width
                  height:(NSInteger)height
                  rate:(NSInteger)rate
                  mirror:(BOOL)mirror
                  name:(NSString *)name
                  use1080p:(BOOL)use1080p
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    RCTLogInfo(@"Invoke %@", name);
    WebRTCModule *module = [self.bridge moduleForName:@"WebRTCModule"];
    RCTLogInfo(@"Module received");
    self.localTrack = (RTCVideoTrack *) module.localTracks[trackId];
    RCTLogInfo(@"track accuired");
    NSString *fileName = [name stringByAppendingPathExtension:@"mp4"];

    RCTLogInfo(@"File name created %@", fileName);

    NSArray *paths = NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
    NSString *documentsDirectory = [paths firstObject];

    // Create the "recordings" directory path
    NSString *recordingsDirectory = [documentsDirectory stringByAppendingPathComponent:@"recordings"];

    // Create the recordings directory if it doesn't exist
    NSFileManager *fileManager = [NSFileManager defaultManager];
    if (![fileManager fileExistsAtPath:recordingsDirectory]) {
        NSError *error = nil;
        [fileManager createDirectoryAtPath:recordingsDirectory withIntermediateDirectories:YES attributes:nil error:&error];
        if (error) {
            NSLog(@"Error creating recordings directory: %@", error.localizedDescription);
        }
    }

    filePath = [recordingsDirectory stringByAppendingPathComponent:fileName];

    self.videoRenderer = [[CustomVideoRenderer alloc] init];

    dispatch_async(module.workerQueue, ^{
        [self.localTrack addRenderer:self.videoRenderer];
    });
    NSURL *outputURL = [NSURL fileURLWithPath:filePath];
    [self.videoRenderer startWritingToURL:outputURL mirror:mirror use1080p:use1080p];

    resolve(filePath);
}

RCT_EXPORT_METHOD(stopRecording:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject) {
    @try {
        if (self.videoRenderer) {
            [self.localTrack removeRenderer:self.videoRenderer];
            [self.videoRenderer finishWriting];
            self.videoRenderer = nil; // Optional: Reset after stopping
            NSError *error = nil;

            NSDictionary *fileAttributes = [[NSFileManager defaultManager] attributesOfItemAtPath:filePath error:&error];
            NSNumber *fileSize = fileAttributes[NSFileSize];

            unsigned long long size = [fileSize unsignedLongLongValue];

            NSArray *units = @[@"B", @"KB", @"MB", @"GB", @"TB"];
            double convertedSize = (double)size;
            int unitIndex = 0;

            while (convertedSize >= 1024 && unitIndex < units.count - 1) {
                convertedSize /= 1024;
                unitIndex++;
            }
            NSString *formattedSize = [NSString stringWithFormat:@"%.2f %@", convertedSize, units[unitIndex]];
            resolve(formattedSize);
        } else {
            resolve(@"ERROR: videoRenderer is empty");
        }
    } @catch (NSException *exception) {
        NSString *errorMessage = [NSString stringWithFormat:@"ERROR: Caught exception: %@", exception];
        resolve(errorMessage);
    }
}

@end
