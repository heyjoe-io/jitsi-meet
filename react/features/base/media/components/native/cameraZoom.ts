import { NativeModules } from 'react-native';

const { HighResRecorder } = NativeModules;

/**
 * UI zoom stops to offer, expressed as multiples of the wide (1x) lens — the same
 * 1x / 2x / 5x selector the iOS camera and Instagram Edits show. Stops that exceed the
 * device's max zoom are filtered out per device.
 */
export const UI_STOPS = [ 1, 2, 5 ];

/**
 * Zoom cap for single-lens cameras (the front camera), where zoom is a digital crop.
 * We capture the front sensor at 3088px wide but record 1080p and send 720p, so up to
 * ~1.6x the crop only discards pixels we weren't keeping anyway — 2x is the familiar
 * stop just past that, still close to lossless in the 1080p file. Beyond it quality
 * drops fast, so the cap is firm. (Single-lens REAR cameras get no zoom at all — see
 * readZoomState.)
 */
export const SINGLE_LENS_MAX_UI_ZOOM = 2;

/**
 * Which camera a zoom config describes, as reported by native. Used to detect stale
 * reads right after a camera flip (the native switch completes after redux updates).
 */
export type DevicePosition = 'front' | 'back';

/**
 * Zoom capability + position of the live camera, in UI (1x-based) terms, with the
 * single-lens policy already applied.
 */
export interface IZoomState {
    currentUiZoom: number;
    isMultiLens: boolean;
    maxUiZoom: number;
    stops: number[];

    /**
     * Raw videoZoomFactor that corresponds to UI 1x — multiply a UI value by this
     * to get the raw factor for the native setters.
     */
    wideBaseZoomFactor: number;
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
 * Normalize a native zoom config to UI terms, applying the zoom policy:
 * multi-lens rear camera gets its full (optical) range; a single-lens front camera
 * gets digital zoom capped at SINGLE_LENS_MAX_UI_ZOOM; a single-lens rear camera
 * gets nothing (we deliberately don't surface digital-only zoom where users expect
 * optical reach).
 */
function toZoomState(c: any): IZoomState | null {
    const wideBase = c.wideBaseZoomFactor || 1;
    let maxUiZoom = c.maxZoom / wideBase;

    if (!c.isMultiLens) {
        if (c.devicePosition !== 'front') {
            return null;
        }
        maxUiZoom = Math.min(maxUiZoom, SINGLE_LENS_MAX_UI_ZOOM);
    }

    return {
        currentUiZoom: Math.min((c.currentZoom || wideBase) / wideBase, maxUiZoom),
        isMultiLens: Boolean(c.isMultiLens),
        maxUiZoom,
        stops: UI_STOPS.filter(s => s <= maxUiZoom + 0.01),
        wideBaseZoomFactor: wideBase
    };
}

/**
 * Read the native zoom config and normalize it to UI terms. After a camera flip the
 * native switch completes after redux updates, so the first reads can still describe
 * the old camera — pass the expected position and this retries until the report
 * matches (or attempts run out). Returns null when the live camera offers no zoom
 * under the policy (single-lens rear camera, Android).
 */
export async function readZoomState(
        expectedPosition?: DevicePosition, maxAttempts = 8, retryMs = 500): Promise<IZoomState | null> {
    if (!HighResRecorder?.getZoomConfig) {
        return null;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
            const c = await HighResRecorder.getZoomConfig();
            const positionKnown = c.devicePosition === 'front' || c.devicePosition === 'back';

            if (!expectedPosition || !positionKnown || c.devicePosition === expectedPosition) {
                return toZoomState(c);
            }
        } catch {
            return null;
        }

        await new Promise(r => setTimeout(r, retryMs));
    }

    return null;
}

/**
 * Apply a UI zoom multiple with the smooth native ramp, clamped per the zoom policy.
 * Returns the clamped value that was applied, or null when there's no zoom to drive.
 */
export async function applyUiZoomRamped(uiZoom: number): Promise<number | null> {
    if (!HighResRecorder?.getZoomConfig || !HighResRecorder?.setZoomFactor) {
        return null;
    }

    try {
        const c = await HighResRecorder.getZoomConfig();
        const state = toZoomState(c);

        if (!state) {
            return null;
        }

        const clampedUi = Math.max(1, Math.min(uiZoom, state.maxUiZoom));

        await HighResRecorder.setZoomFactor(state.wideBaseZoomFactor * clampedUi);

        return clampedUi;
    } catch {
        return null;
    }
}
