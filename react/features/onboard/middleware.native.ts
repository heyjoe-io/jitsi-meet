import { AppState, NativeEventSubscription } from 'react-native';

import { IStore } from '../app/types';
import { APP_WILL_MOUNT, APP_WILL_UNMOUNT } from '../base/app/actionTypes';
import { SET_NETWORK_INFO } from '../base/net-info/actionTypes';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';

import { INCREMENT_UPLOAD_RESUME_ATTEMPTS, UPDATE_LOCAL_RECORDING_STATUS } from './actionTypes';
import { isUploadInFlight, uploadLocalRecordingNative } from './functions';
import { STORE_NAME } from './reducer';

/**
 * Max number of resume attempts per take before we stop auto-retrying and mark it
 * failed. Each attempt itself performs up to UPLOAD_CONFIG.maxRetries network tries,
 * so this bounds a permanently broken/missing file (iOS can purge a recording from
 * tmp/Caches) from retrying forever.
 */
const MAX_RESUME_ATTEMPTS = 5;

/**
 * Minimum gap between queue drains, to coalesce near-simultaneous triggers such as
 * the app returning to the foreground at the same moment the network is restored.
 */
const DRAIN_DEBOUNCE_MS = 3000;

let appStateSubscription: NativeEventSubscription | null = null;
let lastDrainAt = 0;

/**
 * Re-uploads any recorded take that hasn't been confirmed uploaded. Safe to call
 * repeatedly: {@link uploadLocalRecordingNative} self-guards against duplicate
 * in-flight uploads, and the casting backend upserts by upKey, so retries never
 * create duplicate Video docs.
 *
 * @param {IStore} store - The redux store.
 * @param {boolean} force - Bypass the debounce (used for the launch sweep).
 * @returns {void}
 */
function drainUploadQueue(store: IStore, force = false) {
    const now = Date.now();

    if (!force && now - lastDrainAt < DRAIN_DEBOUNCE_MS) {
        return;
    }
    lastDrainAt = now;

    const { dispatch, getState } = store;

    // The talent slice is a plain-JS reducer not declared on IReduxState, so access
    // it untyped.
    const talentState = (getState() as any)[STORE_NAME];
    const recordings = talentState?.nativeLocalRecordings;

    if (!recordings || !recordings.length) {
        return;
    }

    recordings.forEach((rec: any) => {
        if (!rec || rec.status === 'uploaded') {
            return;
        }

        const sessionId = rec.session?.id;
        const talentId = rec.talent?.id;

        // Need the original local file path, the stable S3 key, and the routing ids.
        if (!rec.key || !rec.upKey || !sessionId || !talentId) {
            return;
        }

        // Already uploading right now (e.g. the auto-upload path) — leave it alone.
        if (isUploadInFlight(rec.upKey)) {
            return;
        }

        // Stop auto-retrying once we've exhausted the resume budget.
        if ((rec.resumeAttempts || 0) >= MAX_RESUME_ATTEMPTS) {
            if (rec.status !== 'upload_failed') {
                dispatch({
                    type: UPDATE_LOCAL_RECORDING_STATUS,
                    key: rec.key,
                    status: 'upload_failed'
                });
            }

            return;
        }

        dispatch({
            type: INCREMENT_UPLOAD_RESUME_ATTEMPTS,
            key: rec.key
        });
        console.log('🔁 Resuming pending upload for take:', rec.upKey, 'attempt', (rec.resumeAttempts || 0) + 1);

        // Fire and forget; uploadLocalRecordingNative manages its own redux + WS state.
        uploadLocalRecordingNative(getState(), dispatch, rec.key, sessionId, talentId, rec.upKey);
    });
}

/**
 * Middleware that drains the local-recording upload queue on app launch, on return
 * to the foreground, and when network connectivity is restored.
 */
MiddlewareRegistry.register((store: IStore) => (next: Function) => (action: any) => {
    switch (action.type) {
    case APP_WILL_MOUNT: {
        const result = next(action);

        if (!appStateSubscription) {
            appStateSubscription = AppState.addEventListener('change', nextState => {
                if (nextState === 'active') {
                    drainUploadQueue(store);
                }
            });
        }

        // Delay the launch sweep so persisted state has rehydrated and the network
        // stack is up before we try to upload.
        setTimeout(() => drainUploadQueue(store, true), 5000);

        return result;
    }

    case APP_WILL_UNMOUNT: {
        if (appStateSubscription) {
            appStateSubscription.remove();
            appStateSubscription = null;
        }

        return next(action);
    }

    case SET_NETWORK_INFO: {
        const result = next(action);

        if (action.isOnline) {
            drainUploadQueue(store);
        }

        return result;
    }
    }

    return next(action);
});
