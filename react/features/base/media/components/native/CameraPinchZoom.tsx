import React, { useRef, useEffect, useCallback } from 'react';
import { View, PanResponder, NativeModules, Platform, StyleSheet, GestureResponderEvent, PanResponderGestureState } from 'react-native';

import { SINGLE_LENS_MAX_UI_ZOOM } from './cameraZoom';

const { HighResRecorder } = NativeModules;

// Minimum distance between fingers to consider it a valid pinch (avoid division issues)
const MIN_PINCH_DISTANCE = 10;

// Throttle interval for native zoom calls (ms)
const NATIVE_CALL_THROTTLE_MS = 50;

// Max consecutive native call failures before triggering a full reset
const MAX_CONSECUTIVE_FAILURES = 3;

// Retry delays for zoom info initialization (ms)
const ZOOM_INFO_RETRY_DELAYS = [500, 1000, 2000];

/**
 * Interface for zoom state tracking.
 */
interface ZoomState {
    currentZoom: number;
    lastConfirmedZoom: number;
    minZoom: number;
    maxZoom: number;
    initialDistance: number;
    baseZoom: number;
    isMounted: boolean;
    lastNativeCallTime: number;
    pendingZoom: number | null;
    pendingTimer: ReturnType<typeof setTimeout> | null;
    consecutiveFailures: number;
    zoomInfoReady: boolean;
}

/**
 * Props for CameraPinchZoom component.
 */
interface IProps {
    children: React.ReactNode;
    enabled?: boolean;
    onPress?: () => void;
}

// Tap detection thresholds
const TAP_MAX_DURATION_MS = 300;
const TAP_MAX_MOVEMENT = 10;

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

    if (typeof touch1?.pageX !== 'number' || typeof touch1?.pageY !== 'number'
        || typeof touch2?.pageX !== 'number' || typeof touch2?.pageY !== 'number') {
        return 0;
    }

    const dx = touch1.pageX - touch2.pageX;
    const dy = touch1.pageY - touch2.pageY;

    return Math.sqrt(dx * dx + dy * dy);
};

/**
 * Fetch zoom info from the native module.
 * Returns null on failure.
 *
 * Uses getZoomConfig (not getZoomInfo) so we can read isMultiLens / devicePosition /
 * wideBaseZoomFactor and apply the same front-camera cap the zoom bar uses — the
 * front camera only zooms digitally, and we cap the pinch at SINGLE_LENS_MAX_UI_ZOOM
 * (legible for virtual slates) instead of letting it crop to the device's 10x+
 * digital max. Single-lens REAR cameras keep their historical unbounded pinch.
 */
const fetchZoomInfo = async (): Promise<{
    currentZoom: number;
    minZoom: number;
    maxZoom: number;
} | null> => {
    try {
        if (HighResRecorder?.getZoomConfig) {
            const info = await HighResRecorder.getZoomConfig();
            let maxZoom = info.maxZoom ?? 5.0;

            if (!info.isMultiLens && info.devicePosition === 'front') {
                const wideBase = info.wideBaseZoomFactor || 1;

                maxZoom = Math.min(maxZoom, wideBase * SINGLE_LENS_MAX_UI_ZOOM);
            }

            return {
                currentZoom: info.currentZoom ?? 1.0,
                minZoom: info.minZoom ?? 1.0,
                maxZoom
            };
        }
    } catch {
        // caller handles retry
    }

    return null;
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
const CameraPinchZoom: React.FC<IProps> = ({ children, enabled = true, onPress }) => {
    const onPressRef = useRef(onPress);

    onPressRef.current = onPress;

    const tapState = useRef({
        startTime: 0,
        startX: 0,
        startY: 0,
        isSingleFinger: false
    });

    const zoomState = useRef<ZoomState>({
        currentZoom: 1.0,
        lastConfirmedZoom: 1.0,
        minZoom: 1.0,
        maxZoom: 5.0,
        initialDistance: 0,
        baseZoom: 1.0,
        isMounted: true,
        lastNativeCallTime: 0,
        pendingZoom: null,
        pendingTimer: null,
        consecutiveFailures: 0,
        zoomInfoReady: false
    });

    /**
     * Apply zoom info from native to state.
     */
    const applyZoomInfo = useCallback((info: { currentZoom: number; minZoom: number; maxZoom: number }) => {
        const state = zoomState.current;

        state.currentZoom = info.currentZoom;
        state.lastConfirmedZoom = info.currentZoom;
        state.minZoom = info.minZoom;
        state.maxZoom = info.maxZoom;
        state.baseZoom = info.currentZoom;
        state.zoomInfoReady = true;
    }, []);

    /**
     * Full state reset: re-fetch zoom info and reset all tracking state.
     */
    const resetZoomState = useCallback(async () => {
        const state = zoomState.current;

        if (!state.isMounted) {
            return;
        }

        const info = await fetchZoomInfo();

        if (info && state.isMounted) {
            applyZoomInfo(info);
            state.consecutiveFailures = 0;
            state.initialDistance = 0;
            state.pendingZoom = null;
            if (state.pendingTimer) {
                clearTimeout(state.pendingTimer);
                state.pendingTimer = null;
            }
        }
    }, [ applyZoomInfo ]);

    // Initialize zoom info on mount with retry
    useEffect(() => {
        if (Platform.OS !== 'ios' || !enabled) {
            return;
        }

        zoomState.current.isMounted = true;

        const initWithRetry = async () => {
            const info = await fetchZoomInfo();

            if (info && zoomState.current.isMounted) {
                applyZoomInfo(info);

                return;
            }

            // Retry with increasing delays
            for (const delay of ZOOM_INFO_RETRY_DELAYS) {
                if (!zoomState.current.isMounted) {
                    return;
                }

                await new Promise<void>(resolve => {
                    setTimeout(resolve, delay);
                });

                if (!zoomState.current.isMounted) {
                    return;
                }

                const retryInfo = await fetchZoomInfo();

                if (retryInfo && zoomState.current.isMounted) {
                    applyZoomInfo(retryInfo);

                    return;
                }
            }

            console.warn('[CameraPinchZoom] Failed to get zoom info after retries, using defaults');
        };

        initWithRetry();

        return () => {
            zoomState.current.isMounted = false;
            if (zoomState.current.pendingTimer) {
                clearTimeout(zoomState.current.pendingTimer);
                zoomState.current.pendingTimer = null;
            }
        };
    }, [ enabled, applyZoomInfo ]);

    /**
     * Send a zoom value to the native module and handle the result.
     */
    const sendNativeZoom = useCallback((zoom: number) => {
        const state = zoomState.current;

        if (!state.isMounted) {
            return;
        }

        state.lastNativeCallTime = Date.now();

        HighResRecorder?.setZoomFactor?.(zoom)
            ?.then((result: any) => {
                if (!state.isMounted) {
                    return;
                }
                state.consecutiveFailures = 0;
                if (result?.zoomFactor != null) {
                    state.currentZoom = result.zoomFactor;
                    state.lastConfirmedZoom = result.zoomFactor;
                }
            })
            ?.catch(() => {
                if (!state.isMounted) {
                    return;
                }
                // Revert to last confirmed zoom
                state.currentZoom = state.lastConfirmedZoom;
                state.consecutiveFailures++;

                if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                    console.warn('[CameraPinchZoom] Too many failures, resetting zoom state');
                    resetZoomState();
                }
            });
    }, [ resetZoomState ]);

    /**
     * Apply zoom to the camera hardware with time-based throttling.
     */
    const applyZoom = useCallback((newZoom: number) => {
        if (!Number.isFinite(newZoom) || newZoom <= 0) {
            return;
        }

        const state = zoomState.current;

        if (!state.isMounted) {
            return;
        }

        const clampedZoom = Math.max(state.minZoom, Math.min(newZoom, state.maxZoom));
        const now = Date.now();
        const elapsed = now - state.lastNativeCallTime;

        // Optimistically update currentZoom so gesture math stays correct
        state.currentZoom = clampedZoom;

        if (elapsed >= NATIVE_CALL_THROTTLE_MS) {
            // Enough time has passed — send immediately
            if (state.pendingTimer) {
                clearTimeout(state.pendingTimer);
                state.pendingTimer = null;
            }
            state.pendingZoom = null;
            sendNativeZoom(clampedZoom);
        } else {
            // Within throttle window — store and flush after remaining time
            state.pendingZoom = clampedZoom;
            if (!state.pendingTimer) {
                const remaining = NATIVE_CALL_THROTTLE_MS - elapsed;

                state.pendingTimer = setTimeout(() => {
                    state.pendingTimer = null;
                    if (state.isMounted && state.pendingZoom !== null) {
                        const zoom = state.pendingZoom;

                        state.pendingZoom = null;
                        sendNativeZoom(zoom);
                    }
                }, remaining);
            }
        }
    }, [ sendNativeZoom ]);

    const panResponder = useRef(
        PanResponder.create({
            onStartShouldSetPanResponder: (evt: GestureResponderEvent) => {
                const touchCount = evt.nativeEvent.touches?.length ?? 0;

                if (touchCount >= 2) {
                    return true;
                }

                return !!onPressRef.current;
            },

            onMoveShouldSetPanResponder: (_: GestureResponderEvent, gestureState: PanResponderGestureState) => {
                return gestureState.numberActiveTouches >= 2;
            },

            onPanResponderTerminationRequest: () => false,

            onPanResponderGrant: (evt: GestureResponderEvent) => {
                const touches = evt.nativeEvent.touches;
                const touchCount = touches?.length ?? 0;

                if (touchCount === 1) {
                    const touch = touches[0];

                    tapState.current = {
                        startTime: Date.now(),
                        startX: touch.pageX,
                        startY: touch.pageY,
                        isSingleFinger: true
                    };
                } else if (touchCount === 2) {
                    tapState.current.isSingleFinger = false;
                    const distance = getTouchDistance(touches as any);

                    if (distance >= MIN_PINCH_DISTANCE) {
                        const state = zoomState.current;

                        state.initialDistance = distance;
                        // Use lastConfirmedZoom as the base to avoid desync
                        state.baseZoom = state.lastConfirmedZoom;

                        // Opportunistically refresh zoom info if not yet ready
                        if (!state.zoomInfoReady) {
                            fetchZoomInfo().then(info => {
                                if (info && state.isMounted) {
                                    applyZoomInfo(info);
                                }
                            });
                        }
                    }
                }
            },

            onPanResponderMove: (evt: GestureResponderEvent, gestureState: PanResponderGestureState) => {
                const touches = evt.nativeEvent.touches;
                const touchCount = touches?.length ?? 0;

                if (touchCount === 2 && zoomState.current.initialDistance === 0) {
                    tapState.current.isSingleFinger = false;
                    const distance = getTouchDistance(touches as any);

                    if (distance >= MIN_PINCH_DISTANCE) {
                        const state = zoomState.current;

                        state.initialDistance = distance;
                        state.baseZoom = state.lastConfirmedZoom;
                    }

                    return;
                }

                if (touchCount === 2 && zoomState.current.initialDistance >= MIN_PINCH_DISTANCE) {
                    const currentDistance = getTouchDistance(touches as any);

                    if (currentDistance >= MIN_PINCH_DISTANCE) {
                        const scale = currentDistance / zoomState.current.initialDistance;

                        if (Number.isFinite(scale) && scale > 0.1 && scale < 10) {
                            const newZoom = zoomState.current.baseZoom * scale;

                            applyZoom(newZoom);
                        }
                    }
                }

                if (tapState.current.isSingleFinger) {
                    const { dx, dy } = gestureState;
                    const movement = Math.sqrt(dx * dx + dy * dy);

                    if (movement > TAP_MAX_MOVEMENT) {
                        tapState.current.isSingleFinger = false;
                    }
                }
            },

            onPanResponderRelease: () => {
                if (tapState.current.isSingleFinger) {
                    const duration = Date.now() - tapState.current.startTime;

                    if (duration < TAP_MAX_DURATION_MS && onPressRef.current) {
                        onPressRef.current();
                    }
                }

                zoomState.current.initialDistance = 0;
                tapState.current.isSingleFinger = false;
            },

            onPanResponderTerminate: () => {
                zoomState.current.initialDistance = 0;
                tapState.current.isSingleFinger = false;
            }
        })
    ).current;

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
