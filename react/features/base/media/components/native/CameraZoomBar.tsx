import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, NativeModules, PanResponder, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSelector } from 'react-redux';

import { IReduxState } from '../../../../app/types';
import { CAMERA_FACING_MODE } from '../../constants';

import { IZoomState, emitUiZoom, readZoomState, subscribeUiZoom } from './cameraZoom';

const { HighResRecorder } = NativeModules;

/**
 * Throttle for native immediate-zoom calls while dragging (~30fps). Keeps the slider
 * responsive without flooding the bridge.
 */
const DRAG_THROTTLE_MS = 33;

/**
 * CameraZoomBar - a horizontal zoom selector for the local camera.
 *
 * Tap a stop to jump to it (smooth ramp), or press and slide across the bar to zoom
 * continuously — the gesture is anchored to the chip centers, so halfway between two
 * chips is halfway between their values and the zoom stays wherever the finger lifts.
 * Zoom is applied at the sensor level via the HighResRecorder native module, so the
 * live WebRTC feed and the local recording both reflect it — which is also why the bar
 * doesn't need to be attached to any particular video view. It is mounted at the
 * conference level, just above the toolbar.
 *
 * Only shown on iOS, and only where the zoom policy (cameraZoom.ts) offers something:
 * the rear camera when it's a multi-lens device (1x/2x/5x mapping to real glass), or
 * the front camera with digital zoom (1x/2x/3x — great for virtual slates). Single-
 * lens rear cameras get no bar — we deliberately don't surface digital-only zoom
 * where users expect optical reach.
 */
const CameraZoomBar: React.FC = () => {
    const [ config, setConfig ] = useState<IZoomState | null>(null);
    const [ uiZoom, setUiZoom ] = useState(1);
    const configRef = useRef<IZoomState | null>(null);
    const uiZoomRef = useRef(1);
    const lastSentRef = useRef(0);
    const barWidthRef = useRef(0);

    const facingMode = useSelector((state: IReduxState) => state['features/base/media'].video.facingMode);
    const videoMuted = useSelector((state: IReduxState) => Boolean(state['features/base/media'].video.muted));

    configRef.current = config;
    uiZoomRef.current = uiZoom;

    // Track zoom applied by the CD (RemoteCameraControl) so the pill highlights the
    // position the director chose. Local changes already update state directly.
    useEffect(() => subscribeUiZoom((z, source) => {
        if (source === 'remote') {
            setUiZoom(z);
        }
    }), []);

    // Read zoom state whenever the live camera changes. readZoomState retries until
    // the reported device position matches the redux facing mode — the native switch
    // completes after redux updates, so early reads describe the old camera.
    useEffect(() => {
        if (Platform.OS !== 'ios' || videoMuted) {
            setConfig(null);

            return undefined;
        }

        let cancelled = false;
        const expected = facingMode === CAMERA_FACING_MODE.ENVIRONMENT ? 'back' : 'front';

        setConfig(null);
        readZoomState(expected).then(state => {
            if (cancelled) {
                return;
            }

            setConfig(state);

            if (state) {
                setUiZoom(state.currentUiZoom);
            }
        });

        return () => {
            cancelled = true;
        };
    }, [ facingMode, videoMuted ]);

    /**
     * Apply a UI zoom multiple (1x-based). When immediate, set directly for slider
     * tracking; otherwise use the ramped setter for a smooth tap-to-stop transition.
     */
    const applyUiZoom = useCallback((targetUi: number, immediate: boolean) => {
        const c = configRef.current;

        if (!c) {
            return;
        }

        const clampedUi = Math.max(1, Math.min(targetUi, c.maxUiZoom));
        const raw = c.wideBaseZoomFactor * clampedUi;

        setUiZoom(clampedUi);

        if (immediate) {
            HighResRecorder?.setZoomFactorImmediate?.(raw);
        } else {
            HighResRecorder?.setZoomFactor?.(raw)?.catch?.(() => { /* ignore */ });
        }
    }, []);

    // Continuous slide-across-the-bar to zoom.
    const panResponder = useRef(PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_evt: GestureResponderEvent, g) => Math.abs(g.dx) > 4,
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (evt: GestureResponderEvent) => {
            const c = configRef.current;

            if (!c) {
                return;
            }

            const now = Date.now();

            if (now - lastSentRef.current < DRAG_THROTTLE_MS) {
                return;
            }
            lastSentRef.current = now;

            const width = barWidthRef.current || 1;
            const x = Math.max(0, Math.min(evt.nativeEvent.locationX, width));
            const stops = c.stops;

            // Anchor the gesture to the chip centers (chips are evenly spaced), so the
            // position directly under a chip is exactly that stop and halfway between
            // two chips is halfway between their values — e.g. midway between 2× and
            // 5× reads 3.5×. A linear sweep of the whole range felt wrong: the point
            // under the "2×" chip mapped to 3×. This is the Edits-style behavior of
            // letting a drag settle anywhere between lens stops.
            const centers = stops.map((_s, i) => ((i + 0.5) / stops.length) * width);
            let target;

            if (stops.length < 2 || x <= centers[0]) {
                target = stops[0];
            } else if (x >= centers[centers.length - 1]) {
                target = stops[stops.length - 1];
            } else {
                let i = 0;

                while (x > centers[i + 1]) {
                    i++;
                }
                const frac = (x - centers[i]) / (centers[i + 1] - centers[i]);

                target = stops[i] + (frac * (stops[i + 1] - stops[i]));
            }

            applyUiZoom(target, true);
        },

        // Where the finger lifts is where the zoom stays — report that resting value
        // (the CD mirrors it in the web UI).
        onPanResponderRelease: () => emitUiZoom(uiZoomRef.current, 'local'),
        onPanResponderTerminate: () => emitUiZoom(uiZoomRef.current, 'local')
    })).current;

    // Hide on Android, when the camera is off, or when the zoom policy offers nothing
    // for the live camera (single-lens rear device).
    if (Platform.OS !== 'ios' || videoMuted || !config) {
        return null;
    }

    const stops = config.stops;

    // Which stop is currently "active" (closest to the live zoom).
    const activeStop = stops.reduce((best, s) =>
        (Math.abs(s - uiZoom) < Math.abs(best - uiZoom) ? s : best), stops[0]);

    return (
        <View style = { styles.wrapper } pointerEvents = 'box-none'>
            <View
                style = { styles.bar }
                onLayout = { e => {
                    barWidthRef.current = e.nativeEvent.layout.width;
                } }
                { ...panResponder.panHandlers }>
                { stops.map(s => {
                    const isActive = s === activeStop;

                    return (
                        <TouchableOpacity
                            key = { s }
                            style = { [ styles.stop, isActive && styles.stopActive ] }
                            onPress = { () => {
                                applyUiZoom(s, false);
                                emitUiZoom(s, 'local');
                            } }>
                            <Text style = { [ styles.stopLabel, isActive && styles.stopLabelActive ] }>
                                { isActive ? `${uiZoom.toFixed(1)}×` : `${s}×` }
                            </Text>
                        </TouchableOpacity>
                    );
                }) }
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    // Rendered as a flex child directly above the Toolbox in the conference's
    // bottom column, so it always clears the toolbar instead of hiding under it.
    wrapper: {
        alignItems: 'center',
        marginBottom: 8
    },
    bar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: 'rgba(0,0,0,0.5)',
        borderRadius: 22,
        paddingHorizontal: 6,
        paddingVertical: 6
    },
    stop: {
        minWidth: 40,
        height: 32,
        borderRadius: 16,
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: 2
    },
    stopActive: {
        backgroundColor: '#ffffff'
    },
    stopLabel: {
        color: '#ffffff',
        fontSize: 13,
        fontWeight: '600'
    },
    stopLabelActive: {
        color: '#000000'
    }
});

export default CameraZoomBar;
