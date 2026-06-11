import { NativeModules } from 'react-native';

const { HighResRecorder } = NativeModules;

/**
 * UI zoom stops to offer, expressed as multiples of the wide (1x) lens — the same
 * 1x / 2x / 5x selector the iOS camera and Instagram Edits show. Stops that exceed the
 * device's max zoom are filtered out at render time.
 */
export const UI_STOPS = [ 1, 2, 5 ];

/**
 * Zoom capability + position of the live camera, in UI (1x-based) terms.
 */
export interface IZoomState {
    currentUiZoom: number;
    isMultiLens: boolean;
    maxUiZoom: number;
    stops: number[];
}

/**
 * Who initiated a zoom change: the talent touching the pill, or the CD via the
 * websocket. The pill only re-renders for remote changes (it already knows about its
 * own), and the CD is only notified about local ones (it already knows about its own).
 */
export type ZoomSource = 'local' | 'remote';

type ZoomListener = (uiZoom: number, source: ZoomSource) => void;

const zoomListeners = new Set<ZoomListener>();

/**
 * Broadcast an applied UI zoom so the pill and the remote-control reporter stay in
 * sync without new redux plumbing.
 */
export function emitUiZoom(uiZoom: number, source: ZoomSource) {
    zoomListeners.forEach(l => l(uiZoom, source));
}

/**
 * Subscribe to zoom changes. Returns an unsubscribe function.
 */
export function subscribeUiZoom(listener: ZoomListener) {
    zoomListeners.add(listener);

    return () => {
        zoomListeners.delete(listener);
    };
}

/**
 * Read the native zoom config and normalize it to UI terms. After a camera flip the
 * native switch completes after redux updates, so the first reads can still describe
 * the old (single-lens) camera — retry until a multi-lens device shows up or
 * attempts run out (single-lens devices legitimately never do; returns null).
 */
export async function readZoomState(maxAttempts = 8, retryMs = 500): Promise<IZoomState | null> {
    if (!HighResRecorder?.getZoomConfig) {
        return null;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const c = await HighResRecorder.getZoomConfig();

            if (c.isMultiLens) {
                const wideBase = c.wideBaseZoomFactor || 1;
                const maxUiZoom = c.maxZoom / wideBase;

                return {
                    currentUiZoom: (c.currentZoom || wideBase) / wideBase,
                    isMultiLens: true,
                    maxUiZoom,
                    stops: UI_STOPS.filter(s => s <= maxUiZoom + 0.01)
                };
            }
        } catch {
            return null;
        }

        await new Promise(r => setTimeout(r, retryMs));
    }

    return null;
}

/**
 * Apply a UI zoom multiple with the smooth native ramp, clamped to the device range.
 * Returns the clamped value that was applied, or null when there's no optical zoom
 * to drive (front camera, single-lens device, Android).
 */
export async function applyUiZoomRamped(uiZoom: number): Promise<number | null> {
    if (!HighResRecorder?.getZoomConfig || !HighResRecorder?.setZoomFactor) {
        return null;
    }

    try {
        const c = await HighResRecorder.getZoomConfig();

        if (!c.isMultiLens) {
            return null;
        }

        const wideBase = c.wideBaseZoomFactor || 1;
        const clampedUi = Math.max(1, Math.min(uiZoom, c.maxZoom / wideBase));

        await HighResRecorder.setZoomFactor(wideBase * clampedUi);

        return clampedUi;
    } catch {
        return null;
    }
}
