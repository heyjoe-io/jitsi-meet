import { NativeModules } from 'react-native';

const { HighResRecorder } = NativeModules;

/**
 * UI zoom stops to offer, expressed as multiples of the wide (1x) lens — the same
 * 1x / 2x / 5x selector the iOS camera and Instagram Edits show. Stops that exceed the
 * device's max zoom are filtered out per device.
 */
export const UI_STOPS = [ 1, 2, 5 ];

/**
 * UI zoom stops for the front (single fixed lens) camera. Zoom there is a digital
 * crop — there's no glass to hand off to — but it's invaluable for virtual slates,
 * where reach to read a slate/ID matters more than pixel-for-pixel sharpness. We
 * capture the front sensor well above 1080p, so 1x–~1.6x is genuinely lossless and
 * 3x only mildly upscales the 1080p recording (≈1.5–1.9x) while keeping slate text
 * clearly legible. Past ~4x a tiny sensor crop is blown up into 1080p — mushy and
 * shake-prone — so 3x is the cap. Bump the last stop to raise it.
 */
export const FRONT_UI_STOPS = [ 1, 2, 3 ];

/**
 * Hard zoom cap for single-lens cameras (the front camera), in UI multiples — the
 * top front stop. (Single-lens REAR cameras get no zoom at all — see readZoomState;
 * we don't surface digital-only zoom where users expect optical reach.)
 */
export const SINGLE_LENS_MAX_UI_ZOOM = FRONT_UI_STOPS[FRONT_UI_STOPS.length - 1];

/**
 * Front-camera UI zoom above which the digital crop is upscaling enough to soften
 * the recording. At/below this it's effectively lossless; above it the UI shows a
 * warning so the talent/CD knows they're trading sharpness for reach (fine for a
 * slate, not for a beauty shot). Optical (rear multi-lens) zoom never warns.
 */
export const FRONT_WARN_ABOVE_UI_ZOOM = 2;

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
     * UI zoom above which quality degrades enough to warn the user (front digital
     * zoom). null when zoom is optical and never warns.
     */
    warnAboveUiZoom: number | null;

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
 * multi-lens rear camera gets the 1x/2x/5x optical stops; a single-lens front
 * camera gets the 1x/2x/3x digital stops capped at SINGLE_LENS_MAX_UI_ZOOM; a
 * single-lens rear camera gets nothing (we deliberately don't surface digital-only
 * zoom where users expect optical reach).
 *
 * The usable range (maxUiZoom) tops out at the highest OFFERED stop — never the
 * device's raw videoZoomFactor ceiling, which on a rear multi-lens camera is the
 * digital-crop max (40x+) far past any real glass. That ceiling was leaking into
 * the CD's zoom slider.
 */
function toZoomState(c: any): IZoomState | null {
    const front = !c.isMultiLens;

    if (front && c.devicePosition !== 'front') {
        return null;
    }

    const wideBase = c.wideBaseZoomFactor || 1;
    const deviceMaxUi = c.maxZoom / wideBase;
    const ceilingUi = front ? Math.min(deviceMaxUi, SINGLE_LENS_MAX_UI_ZOOM) : deviceMaxUi;
    const stops = (front ? FRONT_UI_STOPS : UI_STOPS).filter(s => s <= ceilingUi + 0.01);
    const maxUiZoom = stops.length ? stops[stops.length - 1] : 1;

    return {
        currentUiZoom: Math.min((c.currentZoom || wideBase) / wideBase, maxUiZoom),
        isMultiLens: Boolean(c.isMultiLens),
        maxUiZoom,
        stops,
        warnAboveUiZoom: front ? FRONT_WARN_ABOVE_UI_ZOOM : null,
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
