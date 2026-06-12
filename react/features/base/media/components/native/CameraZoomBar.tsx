import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, NativeModules, PanResponder, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSelector } from 'react-redux';

import { IReduxState } from '../../../../app/types';
import { CAMERA_FACING_MODE } from '../../constants';

import { UI_STOPS, emitUiZoom, subscribeUiZoom } from './cameraZoom';

const { HighResRecorder } = NativeModules;

/**
 * Throttle for native immediate-zoom calls while dragging (~30fps). Keeps the slider
 * responsive without flooding the bridge.
 */
const DRAG_THROTTLE_MS = 33;

/**
 * The redux facing-mode flip happens before the native capture session has actually
 * switched devices, so the first config reads after a camera flip can still describe
 * the old (single-lens front) camera. Retry on this cadence until the multi-lens rear
 * device is live.
 */
const CONFIG_RETRY_MS = 500;
const CONFIG_RETRY_MAX = 8;

interface IZoomConfig {
    currentZoom: number;
    isMultiLens: boolean;
    maxZoom: number;
    minZoom: number;
    wideBaseZoomFactor: number;
}

/**
 * CameraZoomBar - a horizontal 1x/2x/5x zoom selector for the local camera.
 *
 * Tap a stop to jump to it (smooth ramp), or press and slide across the bar to zoom
 * continuously. Zoom is applied at the sensor level via the HighResRecorder native
 * module, so the live WebRTC feed and the local recording both reflect it — which is
 * also why the bar doesn't need to be attached to any particular video view. It is
 * mounted at the conference level, just above the toolbar, and shows whenever the
 * rear camera is live (no need to pin the self-view).
 *
 * Only shown on iOS, and only when the active rear device is a virtual multi-lens
 * camera with a telephoto (so the stops map to real optical glass rather than digital
 * crop). On the front camera or a single-lens device, the bar hides itself.
 */
const CameraZoomBar: React.FC = () => {
    const [ config, setConfig ] = useState<IZoomConfig | null>(null);
    const [ uiZoom, setUiZoom ] = useState(1);
    const configRef = useRef<IZoomConfig | null>(null);
    const uiZoomRef = useRef(1);
    const lastSentRef = useRef(0);
    const barWidthRef = useRef(0);

    const facingMode = useSelector((state: IReduxState) => state['features/base/media'].video.facingMode);
    const videoMuted = useSelector((state: IReduxState) => Boolean(state['features/base/media'].video.muted));
    const isBackCamera = facingMode === CAMERA_FACING_MODE.ENVIRONMENT;

    configRef.current = config;
    uiZoomRef.current = uiZoom;

    // Track zoom applied by the CD (RemoteCameraControl) so the pill highlights the
    // position the director chose. Local changes already update state directly.
    useEffect(() => subscribeUiZoom((z, source) => {
        if (source === 'remote') {
            setUiZoom(z);
        }
    }), []);

    // Read zoom config whenever the rear camera becomes the live capture device.
    useEffect(() => {
        if (Platform.OS !== 'ios' || !isBackCamera || videoMuted || !HighResRecorder?.getZoomConfig) {
            setConfig(null);

            return undefined;
        }

        let cancelled = false;
        let attempts = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const read = () => {
            HighResRecorder.getZoomConfig()
                .then((c: IZoomConfig) => {
                    if (cancelled) {
                        return;
                    }

                    if (!c.isMultiLens && attempts < CONFIG_RETRY_MAX) {
                        attempts++;
                        timer = setTimeout(read, CONFIG_RETRY_MS);

                        return;
                    }

                    setConfig(c);
                    const wideBase = c.wideBaseZoomFactor || 1;

                    setUiZoom((c.currentZoom || wideBase) / wideBase);
                })
                .catch(() => { /* keep defaults; bar stays hidden */ });
        };

        read();

        return () => {
            cancelled = true;
            timer && clearTimeout(timer);
        };
    }, [ isBackCamera, videoMuted ]);

    /**
     * Apply a UI zoom multiple (1x-based). When immediate, set directly for slider
     * tracking; otherwise use the ramped setter for a smooth tap-to-stop transition.
     */
    const applyUiZoom = useCallback((targetUi: number, immediate: boolean) => {
        const c = configRef.current;

        if (!c) {
            return;
        }

        const wideBase = c.wideBaseZoomFactor || 1;
        const maxUi = c.maxZoom / wideBase;
        const clampedUi = Math.max(1, Math.min(targetUi, maxUi));
        const raw = wideBase * clampedUi;

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
            const wideBase = c.wideBaseZoomFactor || 1;
            const maxUi = c.maxZoom / wideBase;
            const stops = UI_STOPS.filter(s => s <= maxUi + 0.01);

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

    // Hide on Android, on the front camera, when the camera is off, or when there's
    // no real optical zoom to offer (single-lens device) — we deliberately don't
    // surface a digital-only zoom.
    if (Platform.OS !== 'ios' || !isBackCamera || videoMuted || !config?.isMultiLens) {
        return null;
    }

    const wideBase = config.wideBaseZoomFactor || 1;
    const maxUi = config.maxZoom / wideBase;
    const stops = UI_STOPS.filter(s => s <= maxUi + 0.01);

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
