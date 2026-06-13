import React, { useRef, useEffect, useCallback } from 'react';
import { View, PanResponder, NativeModules, Platform, StyleSheet, GestureResponderEvent, PanResponderGestureState } from 'react-native';

import { SINGLE_LENS_MAX_UI_ZOOM } from './cameraZoom';

const { HighResRecorder } = NativeModules;

// Minimum distance between fingers to consider it a valid pinch (avoid division issues)
const MIN_PINCH_DISTANCE = 10;

// Minimum zoom change threshold to trigger native call (debounce)
const ZOOM_CHANGE_THRESHOLD = 0.05;

/**
 * Interface for zoom state tracking.
 */
interface ZoomState {
    currentZoom: number;
    minZoom: number;
    maxZoom: number;
    initialDistance: number;
    baseZoom: number;
    isMounted: boolean;
}

/**
 * Props for CameraPinchZoom component.
 */
interface IProps {
    children: React.ReactNode;
    enabled?: boolean;
    onPress?: () => void;
}

/**
 * Calculate the distance between two touch points.
 * Returns 0 if touches are invalid.
 */
const getTouchDistance = (touches: any[]): number => {
    if (!touches || touches.length < 2) {
        return 0;
    }

    const touch1 = touches[0];
    const touch2 = touches[1];

    // Validate touch objects have required properties
    if (typeof touch1?.pageX !== 'number' || typeof touch1?.pageY !== 'number' ||
        typeof touch2?.pageX !== 'number' || typeof touch2?.pageY !== 'number') {
        return 0;
    }

    const dx = touch1.pageX - touch2.pageX;
    const dy = touch1.pageY - touch2.pageY;

    return Math.sqrt(dx * dx + dy * dy);
};

/**
 * CameraPinchZoom - Enables pinch-to-zoom on the device camera.
 *
 * This component wraps the local video preview and allows the user to
 * pinch to zoom the camera hardware. The zoom is applied at the sensor
 * level, so both the WebRTC stream and local recording reflect the zoom.
 *
 * Note: This only works on iOS via the HighResRecorder native module.
 */
// Tap detection thresholds
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT = 10;

const CameraPinchZoom: React.FC<IProps> = ({ children, enabled = true, onPress }) => {
    // Store onPress in a ref so PanResponder always has the latest callback
    const onPressRef = useRef(onPress);

    onPressRef.current = onPress;

    // Track tap gesture
    const tapState = useRef({
        startTime: 0,
        startX: 0,
        startY: 0,
        isSingleFinger: false
    });
    // Use ref to persist zoom state across renders without causing re-renders
    const zoomState = useRef<ZoomState>({
        currentZoom: 1.0,
        minZoom: 1.0,
        maxZoom: 5.0,
        initialDistance: 0,
        baseZoom: 1.0,
        isMounted: true
    });

    // Initialize zoom info on mount and cleanup on unmount
    useEffect(() => {
        console.log('[CameraPinchZoom] Component mounted, enabled:', enabled, 'platform:', Platform.OS);

        if (Platform.OS !== 'ios' || !enabled) {
            console.log('[CameraPinchZoom] Skipping initialization - not iOS or not enabled');

            return;
        }

        zoomState.current.isMounted = true;
        console.log('[CameraPinchZoom] Initializing zoom info...');

        const getZoomInfo = async () => {
            try {
                if (HighResRecorder?.getZoomConfig) {
                    const info = await HighResRecorder.getZoomConfig();

                    // Only update if component is still mounted
                    if (zoomState.current.isMounted) {
                        zoomState.current.currentZoom = info.currentZoom ?? 1.0;
                        zoomState.current.minZoom = info.minZoom ?? 1.0;
                        zoomState.current.maxZoom = info.maxZoom ?? 1.0;
                        zoomState.current.baseZoom = info.currentZoom ?? 1.0;

                        // The front camera only zooms digitally — cap the pinch at the
                        // same point as the zoom bar policy (SINGLE_LENS_MAX_UI_ZOOM,
                        // legible for virtual slates) instead of letting it crop all
                        // the way to the device's 10x+ digital max. Single-lens REAR
                        // cameras keep their historical unbounded pinch.
                        if (!info.isMultiLens && info.devicePosition === 'front') {
                            const wideBase = info.wideBaseZoomFactor || 1;

                            zoomState.current.maxZoom = Math.min(
                                zoomState.current.maxZoom,
                                wideBase * SINGLE_LENS_MAX_UI_ZOOM);
                        }
                    }
                }
            } catch {
                // Silently handle errors - zoom will use defaults
            }
        };

        getZoomInfo();

        // Cleanup on unmount
        return () => {
            zoomState.current.isMounted = false;
        };
    }, [ enabled ]);

    /**
     * Apply zoom to the camera hardware.
     */
    const applyZoom = useCallback((newZoom: number) => {
        // Validate input
        if (!Number.isFinite(newZoom) || newZoom <= 0) {
            console.log('[CameraPinchZoom] applyZoom - invalid input:', newZoom);

            return;
        }

        const { minZoom, maxZoom, currentZoom, isMounted } = zoomState.current;

        if (!isMounted) {
            console.log('[CameraPinchZoom] applyZoom - not mounted');

            return;
        }

        const clampedZoom = Math.max(minZoom, Math.min(newZoom, maxZoom));

        // Only update if the change is significant (debounce small changes)
        if (Math.abs(clampedZoom - currentZoom) > ZOOM_CHANGE_THRESHOLD) {
            console.log('[CameraPinchZoom] applyZoom - calling native setZoomFactor:', clampedZoom.toFixed(2));
            zoomState.current.currentZoom = clampedZoom;

            HighResRecorder?.setZoomFactor?.(clampedZoom)
                .then((result: any) => {
                    console.log('[CameraPinchZoom] setZoomFactor result:', result);
                    // Update with the actual zoom value from the device
                    if (zoomState.current.isMounted && result?.zoomFactor != null) {
                        zoomState.current.currentZoom = result.zoomFactor;
                    }
                })
                .catch((error: any) => {
                    console.log('[CameraPinchZoom] setZoomFactor error:', error);
                });
        } else {
            console.log('[CameraPinchZoom] applyZoom - change too small, skipping. current:', currentZoom.toFixed(2), 'new:', clampedZoom.toFixed(2));
        }
    }, []);

    // Create pan responder for pinch gesture detection AND tap handling
    const panResponder = useRef(
        PanResponder.create({
            // Only capture immediately if we have an onPress handler
            // Otherwise, let single taps bubble up to parent (for filmstrip tile selection)
            onStartShouldSetPanResponder: (evt: GestureResponderEvent) => {
                const touchCount = evt.nativeEvent.touches?.length ?? 0;

                // Always capture two-finger gestures for pinch
                if (touchCount >= 2) {
                    return true;
                }

                // For single finger, only capture if we have an onPress handler
                return !!onPressRef.current;
            },

            // Capture two-finger gestures during movement (for pinch zoom)
            onMoveShouldSetPanResponder: (_: GestureResponderEvent, gestureState: PanResponderGestureState) => {
                // Always capture two-finger gestures
                return gestureState.numberActiveTouches >= 2;
            },

            // Don't let other views steal the responder once we have it
            onPanResponderTerminationRequest: () => false,

            // When gesture starts
            onPanResponderGrant: (evt: GestureResponderEvent) => {
                const touches = evt.nativeEvent.touches;
                const touchCount = touches?.length ?? 0;

                console.log('[CameraPinchZoom] onPanResponderGrant - touches:', touchCount);

                if (touchCount === 1) {
                    // Single finger - might be a tap, track it
                    const touch = touches[0];

                    tapState.current = {
                        startTime: Date.now(),
                        startX: touch.pageX,
                        startY: touch.pageY,
                        isSingleFinger: true
                    };
                } else if (touchCount === 2) {
                    // Two fingers - start pinch
                    tapState.current.isSingleFinger = false;
                    const distance = getTouchDistance(touches as any);

                    if (distance >= MIN_PINCH_DISTANCE) {
                        zoomState.current.initialDistance = distance;
                        zoomState.current.baseZoom = zoomState.current.currentZoom;
                        console.log('[CameraPinchZoom] Pinch started, distance:', distance.toFixed(0));
                    }
                }
            },

            // When fingers move
            onPanResponderMove: (evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
                const touches = evt.nativeEvent.touches;
                const touchCount = touches?.length ?? 0;

                // Check if second finger was added
                if (touchCount === 2 && zoomState.current.initialDistance === 0) {
                    // Second finger just added - start pinch
                    tapState.current.isSingleFinger = false;
                    const distance = getTouchDistance(touches as any);

                    if (distance >= MIN_PINCH_DISTANCE) {
                        zoomState.current.initialDistance = distance;
                        zoomState.current.baseZoom = zoomState.current.currentZoom;
                        console.log('[CameraPinchZoom] Pinch started (during move), distance:', distance.toFixed(0));
                    }

                    return;
                }

                // Handle pinch zoom
                if (touchCount === 2 && zoomState.current.initialDistance >= MIN_PINCH_DISTANCE) {
                    const currentDistance = getTouchDistance(touches as any);

                    if (currentDistance >= MIN_PINCH_DISTANCE) {
                        const scale = currentDistance / zoomState.current.initialDistance;

                        if (Number.isFinite(scale) && scale > 0.1 && scale < 10) {
                            const newZoom = zoomState.current.baseZoom * scale;

                            console.log('[CameraPinchZoom] Pinch move - scale:', scale.toFixed(2), 'zoom:', newZoom.toFixed(2));
                            applyZoom(newZoom);
                        }
                    }
                }

                // Check if single finger moved too much (not a tap anymore)
                if (tapState.current.isSingleFinger) {
                    const { dx, dy } = gestureState;
                    const movement = Math.sqrt(dx * dx + dy * dy);

                    if (movement > TAP_MAX_MOVEMENT) {
                        tapState.current.isSingleFinger = false;
                    }
                }
            },

            // When gesture ends
            onPanResponderRelease: () => {
                console.log('[CameraPinchZoom] onPanResponderRelease, isSingleFinger:', tapState.current.isSingleFinger);

                // Check if it was a tap
                if (tapState.current.isSingleFinger) {
                    const duration = Date.now() - tapState.current.startTime;

                    console.log('[CameraPinchZoom] Tap check - duration:', duration, 'max:', TAP_MAX_DURATION_MS, 'hasOnPress:', !!onPressRef.current);

                    if (duration < TAP_MAX_DURATION_MS && onPressRef.current) {
                        console.log('[CameraPinchZoom] Tap detected, calling onPress');
                        onPressRef.current();
                    }
                }

                // Reset states
                zoomState.current.initialDistance = 0;
                tapState.current.isSingleFinger = false;
            },

            // When gesture is terminated
            onPanResponderTerminate: () => {
                console.log('[CameraPinchZoom] onPanResponderTerminate');
                zoomState.current.initialDistance = 0;
                tapState.current.isSingleFinger = false;
            }
        })
    ).current;

    // Skip on non-iOS platforms or when disabled
    if (Platform.OS !== 'ios' || !enabled) {
        return <>{children}</>;
    }

    return (
        <View style = { styles.container } { ...panResponder.panHandlers }>
            {children}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1
    }
});

export default CameraPinchZoom;
