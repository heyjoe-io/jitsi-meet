import { useCallback, useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';

import { IReduxState } from '../../../../app/types';
import { SET_IOS_RECORDING_QUALITY } from '../../../../onboard/actionTypes';
import { addWsListener, removeWsListener, sendMessage } from '../../../../onboard/functions';
import { toggleCameraFacingMode } from '../../actions';
import { CAMERA_FACING_MODE } from '../../constants';

import { applyUiZoomRamped, emitUiZoom, readZoomState, subscribeUiZoom } from './cameraZoom';

/**
 * Debounce for reporting talent-initiated zoom changes back to the CD, so a drag
 * doesn't flood the channel.
 */
const LOCAL_ZOOM_REPORT_DEBOUNCE_MS = 300;

/**
 * RemoteCameraControl — headless (renders nothing). Lets the casting director drive
 * the talent's camera over the websocket.
 *
 * Rooms are asymmetric: the phone only JOINS `talent-${talentId}` (initWebsocket in
 * onboard/functions.js), so the CD must send commands there — same room as
 * `start-local-recording`. The phone SENDS its reports to
 * `talent-session-${sessionId}`, which the CD joins.
 *
 * CD → phone (room `talent-${talentId}`):
 *   { type: 'flip-camera', facingMode?: 'user' | 'environment' }
 *       Toggles the camera. With facingMode, acts as "switch to" and no-ops when
 *       already there — explicit targets can't double-flip on a re-send.
 *   { type: 'set-camera-zoom', uiZoom: number }
 *       Zoom as a wide-lens multiple (the pill's 1x/2x/5x scale). Clamped to the
 *       device range; ignored when there's no optical zoom to drive.
 *   { type: 'set-recording-quality', quality: '1080p' | '4K' }
 *       Set the resolution for the NEXT recording (the writer dimensions are fixed
 *       at record start, so it can't change a take already rolling). "Session-wide"
 *       on the CD is just this sent to every talent's room. Reports back.
 *   { type: 'get-camera-state' }
 *       Ask for a camera-state report (e.g. when the CD UI mounts mid-session).
 *
 * Phone → CD (reported on room `talent-session-${sessionId}`):
 *   { type: 'camera-state', talentId, facingMode, videoMuted, zoom, recordingQuality, isRecording }
 *       zoom is { currentUiZoom, maxUiZoom, stops, optical, warnAboveUiZoom } or null
 *       when zoom can't be offered (single-lens rear camera, video muted, Android).
 *       The front camera reports digital zoom (stops 1/2/3, optical=false,
 *       warnAboveUiZoom=2 → CD should flag softness past 2x). recordingQuality is
 *       '1080p'|'4K'; isRecording lets the CD disable the quality toggle mid-take
 *       (a change wouldn't apply until the next one). Sent on mount, after every
 *       flip/mute/quality/recording change, after applying a remote zoom, and
 *       (debounced) when the talent moves the zoom themselves.
 */
const RemoteCameraControl = () => {
    const dispatch = useDispatch();
    const sessionId = useSelector((state: IReduxState) => state['features/talent'].session?._id);
    const talentId = useSelector((state: IReduxState) => state['features/talent'].talent?._id);
    const facingMode = useSelector((state: IReduxState) => state['features/base/media'].video.facingMode);
    const videoMuted = useSelector((state: IReduxState) => Boolean(state['features/base/media'].video.muted));
    const recordingQuality = useSelector((state: IReduxState) => state['features/talent'].iosRecordingQuality || '1080p');
    const isRecording = useSelector((state: IReduxState) => Boolean(state['features/talent'].isNativeLocalRecording));

    // Refs so the long-lived ws handler always sees current values.
    const sessionIdRef = useRef(sessionId);
    const talentIdRef = useRef(talentId);
    const facingModeRef = useRef(facingMode);
    const videoMutedRef = useRef(videoMuted);
    const recordingQualityRef = useRef(recordingQuality);
    const isRecordingRef = useRef(isRecording);

    sessionIdRef.current = sessionId;
    talentIdRef.current = talentId;
    facingModeRef.current = facingMode;
    videoMutedRef.current = videoMuted;
    recordingQualityRef.current = recordingQuality;
    isRecordingRef.current = isRecording;

    const reportCameraState = useCallback(async (appliedUiZoom?: number) => {
        if (!sessionIdRef.current || !talentIdRef.current) {
            return;
        }

        let zoom = null;

        if (Platform.OS === 'ios' && !videoMutedRef.current) {
            const expected = facingModeRef.current === CAMERA_FACING_MODE.ENVIRONMENT ? 'back' : 'front';
            const state = await readZoomState(expected);

            if (state) {
                zoom = {
                    currentUiZoom: typeof appliedUiZoom === 'number' ? appliedUiZoom : state.currentUiZoom,
                    maxUiZoom: state.maxUiZoom,
                    stops: state.stops,

                    // True when the stops ride real lens handoffs (multi-lens rear
                    // camera); false for the front camera's digital zoom.
                    optical: state.isMultiLens,

                    // UI zoom above which front digital zoom softens the image — the
                    // CD should warn past it. null when optical (never warns).
                    warnAboveUiZoom: state.warnAboveUiZoom
                };
            }
        }

        sendMessage(`talent-session-${sessionIdRef.current}`, {
            type: 'camera-state',
            talentId: talentIdRef.current,
            facingMode: facingModeRef.current,
            videoMuted: videoMutedRef.current,
            zoom,
            recordingQuality: recordingQualityRef.current,
            isRecording: isRecordingRef.current
        });
    }, []);

    // CD commands over the websocket.
    useEffect(() => {
        const handler = (ev: any) => {
            const msg = ev.message;

            switch (msg?.type) {
                case 'flip-camera': {
                    if (msg.facingMode && msg.facingMode === facingModeRef.current) {
                        // Already facing the requested way — just (re)confirm state.
                        reportCameraState();
                        break;
                    }
                    console.log('[RemoteCameraControl] Remote camera flip');
                    dispatch(toggleCameraFacingMode());

                    // The facingMode effect below reports the post-flip state.
                    break;
                }
                case 'set-camera-zoom': {
                    const uiZoom = Number(msg.uiZoom);

                    if (!isFinite(uiZoom) || uiZoom <= 0) {
                        break;
                    }
                    console.log('[RemoteCameraControl] Remote zoom request:', uiZoom);
                    applyUiZoomRamped(uiZoom).then(applied => {
                        if (applied !== null) {
                            emitUiZoom(applied, 'remote');
                            reportCameraState(applied);
                        } else {
                            // Nothing to zoom (front camera / single lens) — report
                            // the truth so the CD UI corrects itself.
                            reportCameraState();
                        }
                    });
                    break;
                }
                case 'set-recording-quality': {
                    const quality = msg.quality;

                    if (quality !== '1080p' && quality !== '4K') {
                        break;
                    }
                    console.log('[RemoteCameraControl] Remote recording quality:', quality);

                    // Applies to the NEXT recording — startRecording reads this from
                    // redux. Harmless if a take is rolling; it just won't take effect
                    // until the next one (CD disables the toggle mid-take via isRecording).
                    dispatch({ type: SET_IOS_RECORDING_QUALITY, quality });

                    // Optimistic so the immediate ack carries the new value; the redux
                    // update re-reports via the effect below as confirmation.
                    recordingQualityRef.current = quality;
                    reportCameraState();
                    break;
                }
                case 'get-camera-state':
                    reportCameraState();
                    break;
            }
        };

        addWsListener(handler);

        return () => removeWsListener(handler);
    }, [ dispatch, reportCameraState ]);

    // Announce camera state on mount and whenever the camera flips, video mutes,
    // recording quality changes, or recording starts/stops (so the CD can enable/
    // disable the quality toggle and reflect the live setting).
    useEffect(() => {
        reportCameraState();
    }, [ facingMode, videoMuted, recordingQuality, isRecording, reportCameraState ]);

    // Talent-initiated zoom changes (pill taps/drags) — tell the CD, debounced.
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;

        const unsubscribe = subscribeUiZoom((uiZoom, source) => {
            if (source !== 'local') {
                return;
            }
            timer && clearTimeout(timer);
            timer = setTimeout(() => reportCameraState(uiZoom), LOCAL_ZOOM_REPORT_DEBOUNCE_MS);
        });

        return () => {
            timer && clearTimeout(timer);
            unsubscribe();
        };
    }, [ reportCameraState ]);

    return null;
};

export default RemoteCameraControl;
