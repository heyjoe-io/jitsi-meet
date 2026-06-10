import React, { useCallback, useEffect, useRef, useState } from 'react';
import { GestureResponderEvent, NativeModules, PanResponder, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

const { HighResRecorder } = NativeModules;

/**
 * UI zoom stops to offer, expressed as multiples of the wide (1x) lens — the same
 * 1x / 2x / 5x selector the iOS camera and Instagram Edits show. Stops that exceed the
 * device's max zoom are filtered out at render time.
 */
const UI_STOPS = [ 1, 2, 5 ];

/**
 * Throttle for native immediate-zoom calls while dragging (~30fps). Keeps the slider
 * responsive without flooding the bridge.
 */
const DRAG_THROTTLE_MS = 33;

interface IZoomConfig {
    currentZoom: number;
    isMultiLens: boolean;
    maxZoom: number;
    minZoom: number;
    wideBaseZoomFactor: number;
}

interface IProps {

    /**
     * Whether the bar is enabled at all.
     */
    enabled?: boolean;

    /**
     * The local video is mirrored on the front camera. We use this as a hint (front
     * cameras are single-lens, so there's no optical zoom to offer) and as a trigger to
     * re-read the zoom config whenever the camera flips.
     */
    mirror?: boolean;
}

/**
 * CameraZoomBar - a horizontal 1x/2x/5x zoom selector for the local camera preview.
 *
 * Tap a stop to jump to it (smooth ramp), or press and slide across the bar to zoom
 * continuously. Zoom is applied at the sensor level via the HighResRecorder native
 * module, so both the live WebRTC feed and the local recording reflect it.
 *
 * Only shown on iOS, and only when the active rear device is a virtual multi-lens
 * camera with a telephoto (so the stops map to real optical glass rather than digital
 * crop). On the front camera or a single-lens device, the bar hides itself.
 */
const CameraZoomBar: React.FC<IProps> = ({ enabled = true, mirror = false }) => {
    const [ config, setConfig ] = useState<IZoomConfig | null>(null);
    const [ uiZoom, setUiZoom ] = useState(1);
    const configRef = useRef<IZoomConfig | null>(null);
    const lastSentRef = useRef(0);
    const barWidthRef = useRef(0);

    configRef.current = config;

    // Read zoom config on mount and whenever the camera flips (mirror toggles).
    useEffect(() => {
        if (Platform.OS !== 'ios' || !enabled || !HighResRecorder?.getZoomConfig) {
            return undefined;
        }

        let cancelled = false;

        HighResRecorder.getZoomConfig()
            .then((c: IZoomConfig) => {
                if (cancelled) {
                    return;
                }
                setConfig(c);
                const wideBase = c.wideBaseZoomFactor || 1;

                setUiZoom((c.currentZoom || wideBase) / wideBase);
            })
            .catch(() => { /* keep defaults; bar stays hidden */ });

        return () => {
            cancelled = true;
        };
    }, [ enabled, mirror ]);

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
            const frac = x / width;
            const wideBase = c.wideBaseZoomFactor || 1;
            const maxUi = c.maxZoom / wideBase;

            // Map the bar width across [1x, top stop] (capped to device max).
            const topUi = Math.min(maxUi, UI_STOPS[UI_STOPS.length - 1]);
            const target = 1 + (frac * (topUi - 1));

            applyUiZoom(target, true);
        }
    })).current;

    // Hide on Android, when disabled, on the front camera, or when there's no real
    // optical zoom to offer (single-lens device) — we deliberately don't surface a
    // digital-only zoom.
    if (Platform.OS !== 'ios' || !enabled || mirror || !config?.isMultiLens) {
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
                            onPress = { () => applyUiZoom(s, false) }>
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
    wrapper: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 24,
        alignItems: 'center'
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
