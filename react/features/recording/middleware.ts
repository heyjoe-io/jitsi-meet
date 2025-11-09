import { batch } from 'react-redux';
import { debounce } from 'lodash-es';

import { createRecordingEvent } from '../analytics/AnalyticsEvents';
import { sendAnalytics } from '../analytics/functions';
import { IStore } from '../app/types';
import { APP_WILL_MOUNT, APP_WILL_UNMOUNT } from '../base/app/actionTypes';
import { CONFERENCE_JOIN_IN_PROGRESS } from '../base/conference/actionTypes';
import { getCurrentConference } from '../base/conference/functions';
import { openDialog } from '../base/dialog/actions';
import JitsiMeetJS, {
    JitsiConferenceEvents,
    JitsiRecordingConstants
} from '../base/lib-jitsi-meet';
import {
    setAudioMuted,
    setAudioUnmutePermissions,
    setVideoMuted,
    setVideoUnmutePermissions
} from '../base/media/actions';
import { MEDIA_TYPE } from '../base/media/constants';
import { PARTICIPANT_JOINED, PARTICIPANT_UPDATED } from '../base/participants/actionTypes';
import { pinParticipant, updateLocalRecordingStatus } from '../base/participants/actions';
import { PARTICIPANT_ROLE } from '../base/participants/constants';
import { getLocalParticipant, getRemoteParticipants, isParticipantModerator } from '../base/participants/functions';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import StateListenerRegistry from '../base/redux/StateListenerRegistry';
import {
    playSound,
    stopSound
} from '../base/sounds/actions';
import { TRACK_ADDED, TRACK_UPDATED } from '../base/tracks/actionTypes';
import { isParticipantVideoMuted } from '../base/tracks/functions.any';
import { hideNotification, showErrorNotification, showNotification } from '../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE } from '../notifications/constants';
import { isRecorderTranscriptionsRunning } from '../transcribing/functions';

import { RECORDING_SESSION_UPDATED, START_LOCAL_RECORDING, STOP_LOCAL_RECORDING, TOGGLE_AUTO_PIN_RECORDING } from './actionTypes';
import {
    clearRecordingSessions,
    hidePendingRecordingNotification,
    markConsentRequested,
    showRecordingError,
    showRecordingLimitNotification,
    showRecordingWarning,
    showStartRecordingNotification,
    updateRecordingSessionData
} from './actions';
import { RecordingConsentDialog } from './components/Recording';
import LocalRecordingManager from './components/Recording/LocalRecordingManager';
import {
    LIVE_STREAMING_OFF_SOUND_ID,
    LIVE_STREAMING_ON_SOUND_ID,
    RECORDING_OFF_SOUND_ID,
    RECORDING_ON_SOUND_ID,
    START_RECORDING_NOTIFICATION_ID
} from './constants';
import {
    getSessionById,
    registerRecordingAudioFiles,
    shouldRequireRecordingConsent,
    unregisterRecordingAudioFiles
} from './functions';
import logger from './logger';

/**
 * StateListenerRegistry provides a reliable way to detect the leaving of a
 * conference, where we need to clean up the recording sessions.
 */
StateListenerRegistry.register(
    /* selector */ state => getCurrentConference(state),
    /* listener */ (conference, { dispatch }) => {
        if (!conference) {
            dispatch(clearRecordingSessions());
        }
    }
);

/**
 * The redux middleware to handle the recorder updates in a React way.
 *
 * @param {Store} store - The redux store.
 * @returns {Function}
 */
MiddlewareRegistry.register(({ dispatch, getState }) => next => action => {
    let oldSessionData;

    if (action.type === RECORDING_SESSION_UPDATED) {
        oldSessionData
            = getSessionById(getState(), action.sessionData.id);
    }

    const result = next(action);

    switch (action.type) {
    case APP_WILL_MOUNT:
        registerRecordingAudioFiles(dispatch);

        break;

    case APP_WILL_UNMOUNT:
        unregisterRecordingAudioFiles(dispatch);

        break;

    case CONFERENCE_JOIN_IN_PROGRESS: {
        const { conference } = action;

        conference.on(
            JitsiConferenceEvents.RECORDER_STATE_CHANGED,
            (recorderSession: any) => {
                if (recorderSession) {
                    recorderSession.getID() && dispatch(updateRecordingSessionData(recorderSession));
                    if (recorderSession.getError()) {
                        _showRecordingErrorNotification(recorderSession, dispatch, getState);
                    } else {
                        _showExplicitConsentDialog(recorderSession, dispatch, getState);
                    }
                }

                return;
            });

        break;
    }

    case PARTICIPANT_JOINED: {
        const state = getState();
        const { sessionDatas, autoPinEnabled } = state['features/recording'];
        const isRecordingOrPending = sessionDatas.some(
            (session: any) => session.mode === JitsiRecordingConstants.mode.FILE
                && (session.status === JitsiRecordingConstants.status.ON
                    || session.status === JitsiRecordingConstants.status.PENDING)
        );

        // Check if Jibri (recorder bot) just joined during an active recording
        if (action.participant?.botType) {
            if (isRecordingOrPending && autoPinEnabled) {
                // Pin non-moderators when Jibri joins
                _pinNonModeratorsForRecording(dispatch, getState);
            }

            // Always close participants pane when Jibri joins during recording initiation
            try {
                const { close } = require('../participants-pane/actions');

                dispatch(close());
            } catch (e) {
                // Participants pane not available on this platform
            }
        }
        break;
    }

    case START_LOCAL_RECORDING: {
        const { localRecording } = getState()['features/base/config'];
        const { onlySelf } = action;

        LocalRecordingManager.startLocalRecording({
            dispatch,
            getState
        }, action.onlySelf)
        .then(() => {
            const props = {
                descriptionKey: 'recording.on',
                titleKey: 'dialog.recording'
            };

            if (localRecording?.notifyAllParticipants && !onlySelf) {
                dispatch(playSound(RECORDING_ON_SOUND_ID));
            }
            dispatch(showNotification(props, NOTIFICATION_TIMEOUT_TYPE.MEDIUM));
            dispatch(showNotification({
                titleKey: 'recording.localRecordingStartWarningTitle',
                descriptionKey: 'recording.localRecordingStartWarning'
            }, NOTIFICATION_TIMEOUT_TYPE.STICKY));
            dispatch(updateLocalRecordingStatus(true, onlySelf));
            sendAnalytics(createRecordingEvent('started', `local${onlySelf ? '.self' : ''}`));
            if (typeof APP !== 'undefined') {
                APP.API.notifyRecordingStatusChanged(
                    true, 'local', undefined, isRecorderTranscriptionsRunning(getState()));
            }
        })
        .catch(err => {
            logger.error('Capture failed', err);

            let descriptionKey = 'recording.error';

            if (err.message === 'WrongSurfaceSelected') {
                descriptionKey = 'recording.surfaceError';

            } else if (err.message === 'NoLocalStreams') {
                descriptionKey = 'recording.noStreams';
            } else if (err.message === 'NoMicTrack') {
                descriptionKey = 'recording.noMicPermission';
            }
            const props = {
                descriptionKey,
                titleKey: 'recording.failedToStart'
            };

            if (typeof APP !== 'undefined') {
                APP.API.notifyRecordingStatusChanged(
                    false, 'local', err.message, isRecorderTranscriptionsRunning(getState()));
            }

            dispatch(showErrorNotification(props));
        });
        break;
    }

    case STOP_LOCAL_RECORDING: {
        const { localRecording } = getState()['features/base/config'];

        if (LocalRecordingManager.isRecordingLocally()) {
            LocalRecordingManager.stopLocalRecording();
            dispatch(updateLocalRecordingStatus(false));
            if (localRecording?.notifyAllParticipants && !LocalRecordingManager.selfRecording) {
                dispatch(playSound(RECORDING_OFF_SOUND_ID));
            }
            if (typeof APP !== 'undefined') {
                APP.API.notifyRecordingStatusChanged(
                    false, 'local', undefined, isRecorderTranscriptionsRunning(getState()));
            }
        }
        break;
    }

    case RECORDING_SESSION_UPDATED: {
        const state = getState();

        // When in recorder mode no notifications are shown
        // or extra sounds are also not desired
        // but we want to indicate those in case of sip gateway
        const {
            iAmRecorder,
            iAmSipGateway,
            recordingLimit
        } = state['features/base/config'];

        if (iAmRecorder && !iAmSipGateway) {
            break;
        }

        const updatedSessionData
            = getSessionById(state, action.sessionData.id);
        const { initiator, mode = '', terminator } = updatedSessionData ?? {};
        const { PENDING, OFF, ON } = JitsiRecordingConstants.status;
        const isRecordingStarting = updatedSessionData?.status === PENDING && oldSessionData?.status !== PENDING;

        if (isRecordingStarting || updatedSessionData?.status === ON) {
            dispatch(hideNotification(START_RECORDING_NOTIFICATION_ID));
        }

        if (isRecordingStarting) {
            // Close participants pane when recording enters PENDING state
            if (mode === JitsiRecordingConstants.mode.FILE) {
                try {
                    const { close } = require('../participants-pane/actions');

                    dispatch(close());
                } catch (e) {
                    // Participants pane not available on this platform
                }
            }
            break;
        }

        dispatch(hidePendingRecordingNotification(mode));

        if (updatedSessionData?.status === ON) {

            // We receive 2 updates of the session status ON. The first one is from jibri when it joins.
            // The second one is from jicofo which will deliver the initiator value. Since the start
            // recording notification uses the initiator value we skip the jibri update and show the
            // notification on the update from jicofo.
            // FIXME: simplify checks when the backend start sending only one status ON update containing
            // the initiator.
            if (initiator && !oldSessionData?.initiator) {
                if (typeof recordingLimit === 'object') {
                    dispatch(showRecordingLimitNotification(mode));
                } else {
                    // dispatch(showStartedRecordingNotification(mode, initiator, action.sessionData.id));
                }
            }

            if (oldSessionData?.status !== ON) {
                sendAnalytics(createRecordingEvent('start', mode));

                let soundID;

                if (mode === JitsiRecordingConstants.mode.FILE && !isRecorderTranscriptionsRunning(state)) {
                    soundID = RECORDING_ON_SOUND_ID;
                } else if (mode === JitsiRecordingConstants.mode.STREAM) {
                    soundID = LIVE_STREAMING_ON_SOUND_ID;
                }

                if (soundID) {
                    dispatch(playSound(soundID));
                }

                if (typeof APP !== 'undefined') {
                    APP.API.notifyRecordingStatusChanged(
                        true, mode, undefined, isRecorderTranscriptionsRunning(state));
                }

                // Pin non-moderators and close participants pane when recording starts
                if (mode === JitsiRecordingConstants.mode.FILE) {
                    const { autoPinEnabled } = state['features/recording'];

                    if (autoPinEnabled) {
                        // Call directly (not debounced) on recording start for immediate pinning
                        _pinNonModeratorsForRecordingImpl(dispatch, getState);
                    }

                    // Close participants pane
                    try {
                        const { close } = require('../participants-pane/actions');

                        dispatch(close());
                    } catch (e) {
                        // Participants pane not available on this platform
                    }
                }
            }
        } else if (updatedSessionData?.status === OFF && oldSessionData?.status !== OFF) {
            if (terminator) {
                // dispatch(
                //     showStoppedRecordingNotification(
                //         mode, getParticipantDisplayName(state, getResourceId(terminator))));
            }

            let duration = 0, soundOff, soundOn;

            if (oldSessionData?.timestamp) {
                duration
                    = (Date.now() / 1000) - oldSessionData.timestamp;
            }
            sendAnalytics(createRecordingEvent('stop', mode, duration));

            if (mode === JitsiRecordingConstants.mode.FILE && !isRecorderTranscriptionsRunning(state)) {
                soundOff = RECORDING_OFF_SOUND_ID;
                soundOn = RECORDING_ON_SOUND_ID;
            } else if (mode === JitsiRecordingConstants.mode.STREAM) {
                soundOff = LIVE_STREAMING_OFF_SOUND_ID;
                soundOn = LIVE_STREAMING_ON_SOUND_ID;
            }

            if (soundOff && soundOn) {
                dispatch(stopSound(soundOn));
                dispatch(playSound(soundOff));
            }

            if (typeof APP !== 'undefined') {
                APP.API.notifyRecordingStatusChanged(
                    false, mode, undefined, isRecorderTranscriptionsRunning(state));
            }

            // Clear pinned participants when recording stops
            if (mode === JitsiRecordingConstants.mode.FILE) {
                try {
                    const { clearStageParticipants } = require('../filmstrip/actions.web');

                    dispatch(clearStageParticipants());
                } catch (e) {
                    // Fallback to unpinning if stage not available
                    dispatch(pinParticipant(null));
                }
            }
        }

        break;
    }
    case TRACK_ADDED:
    case TRACK_UPDATED: {
        const { track } = action;
        const state = getState();
        const { sessionDatas, autoPinEnabled } = state['features/recording'];
        const isRecording = sessionDatas.some(
            (session: any) => session.mode === JitsiRecordingConstants.mode.FILE
                && session.status === JitsiRecordingConstants.status.ON
        );

        if (isRecording && autoPinEnabled && track.mediaType === MEDIA_TYPE.VIDEO && !track.local) {
            _pinNonModeratorsForRecording(dispatch, getState);
        }

        if (action.type === TRACK_ADDED && LocalRecordingManager.isRecordingLocally()
                && track.mediaType === MEDIA_TYPE.AUDIO && track.local) {
            const audioTrack = track.jitsiTrack.track;

            LocalRecordingManager.addAudioTrackToLocalRecording(audioTrack);
        }
        break;
    }
    case PARTICIPANT_UPDATED: {
        const nextResult = next(action);
        const { id, role } = action.participant;
        const state = getState();
        const localParticipant = getLocalParticipant(state);
        const { sessionDatas, autoPinEnabled } = state['features/recording'];
        const isRecording = sessionDatas.some(
            (session: any) => session.mode === JitsiRecordingConstants.mode.FILE
                && session.status === JitsiRecordingConstants.status.ON
        );

        if (localParticipant?.id === id && role === PARTICIPANT_ROLE.MODERATOR) {
            dispatch(showStartRecordingNotification());
        }

        if (isRecording && autoPinEnabled && role !== undefined) {
            _pinNonModeratorsForRecording(dispatch, getState);
        }

        return nextResult;
    }
    case TOGGLE_AUTO_PIN_RECORDING: {
        // Note: next(action) was already called before this switch statement (line 93)
        // so the reducer has already toggled the state. We just need to react to the change.
        const state = getState();
        const { autoPinEnabled, sessionDatas } = state['features/recording'];
        const isRecording = sessionDatas.some(
            (session: any) => session.mode === JitsiRecordingConstants.mode.FILE
                && session.status === JitsiRecordingConstants.status.ON
        );

        console.log('[Recording Middleware] TOGGLE_AUTO_PIN_RECORDING - new state:', autoPinEnabled, 'isRecording:', isRecording);

        // If auto-pin is now disabled during an active recording, clear the stage
        if (isRecording && !autoPinEnabled) {
            console.log('[Recording Middleware] Clearing stage (auto-pin disabled)');

            try {
                const { isStageFilmstripEnabled } = require('../filmstrip/functions');

                if (isStageFilmstripEnabled(state)) {
                    const { setStageParticipants } = require('../filmstrip/actions.web');

                    // Clear the stage by setting an empty array
                    dispatch(setStageParticipants([]));
                }
            } catch (e) {
                // Stage filmstrip not available on this platform
            }
        } else if (isRecording && autoPinEnabled) {
            console.log('[Recording Middleware] Pinning non-moderators (auto-pin enabled)');
            // If auto-pin is now enabled during an active recording, pin non-moderators
            _pinNonModeratorsForRecordingImpl(dispatch, getState);
        }

        break;
    }
    }

    return result;
});

/**
 * Shows a notification about an error in the recording session. A
 * default notification will display if no error is specified in the passed
 * in recording session.
 *
 * @private
 * @param {Object} session - The recorder session model from the
 * lib.
 * @param {Dispatch} dispatch - The Redux Dispatch function.
 * @param {Function} getState - The Redux getState function.
 * @returns {void}
 */
function _showRecordingErrorNotification(session: any, dispatch: IStore['dispatch'], getState: IStore['getState']) {
    const mode = session.getMode();
    const error = session.getError();
    const isStreamMode = mode === JitsiMeetJS.constants.recording.mode.STREAM;

    switch (error) {
    case JitsiMeetJS.constants.recording.error.SERVICE_UNAVAILABLE:
        dispatch(showRecordingError({
            descriptionKey: 'recording.unavailable',
            descriptionArguments: {
                serviceName: isStreamMode
                    ? '$t(liveStreaming.serviceName)'
                    : '$t(recording.serviceName)'
            },
            titleKey: isStreamMode
                ? 'liveStreaming.unavailableTitle'
                : 'recording.unavailableTitle'
        }));
        break;
    case JitsiMeetJS.constants.recording.error.RESOURCE_CONSTRAINT:
        dispatch(showRecordingError({
            descriptionKey: isStreamMode
                ? 'liveStreaming.busy'
                : 'recording.busy',
            titleKey: isStreamMode
                ? 'liveStreaming.busyTitle'
                : 'recording.busyTitle'
        }));
        break;
    case JitsiMeetJS.constants.recording.error.UNEXPECTED_REQUEST:
        dispatch(showRecordingWarning({
            descriptionKey: isStreamMode
                ? 'liveStreaming.sessionAlreadyActive'
                : 'recording.sessionAlreadyActive',
            titleKey: isStreamMode ? 'liveStreaming.inProgress' : 'recording.inProgress'
        }));
        break;
    case JitsiMeetJS.constants.recording.error.POLICY_VIOLATION:
        dispatch(showRecordingWarning({
            descriptionKey: isStreamMode ? 'liveStreaming.policyError' : 'recording.policyError',
            titleKey: isStreamMode ? 'liveStreaming.failedToStart' : 'recording.failedToStart'
        }));
        break;
    default:
        dispatch(showRecordingError({
            descriptionKey: isStreamMode
                ? 'liveStreaming.error'
                : 'recording.error',
            titleKey: isStreamMode
                ? 'liveStreaming.failedToStart'
                : 'recording.failedToStart'
        }));
        break;
    }

    if (typeof APP !== 'undefined') {
        APP.API.notifyRecordingStatusChanged(false, mode, error, isRecorderTranscriptionsRunning(getState()));
    }
}

/**
 * Mutes audio and video and displays the RecordingConsentDialog when the conditions are met.
 *
 * @param {any} recorderSession - The recording session.
 * @param {Function} dispatch - The Redux dispatch function.
 * @param {Function} getState - The Redux getState function.
 * @returns {void}
 */
function _showExplicitConsentDialog(recorderSession: any, dispatch: IStore['dispatch'], getState: IStore['getState']) {
    if (!shouldRequireRecordingConsent(recorderSession, getState())) {
        return;
    }

    batch(() => {
        dispatch(markConsentRequested(recorderSession.getID()));
        dispatch(setAudioUnmutePermissions(true, true));
        dispatch(setVideoUnmutePermissions(true, true));
        dispatch(setAudioMuted(true));
        dispatch(setVideoMuted(true));
        dispatch(openDialog(RecordingConsentDialog));
    });
}

/**
 * Pins non-moderator participants with video enabled to stage when recording starts.
 * This ensures that recorded video shows only non-moderators who have their video on.
 *
 * @param {Function} dispatch - The Redux dispatch function.
 * @param {Function} getState - The Redux getState function.
 * @returns {void}
 */
function _pinNonModeratorsForRecordingImpl(dispatch: IStore['dispatch'], getState: IStore['getState']) {
    const state = getState();
    const remoteParticipants = getRemoteParticipants(state);

    let isStageFilmstrip = false;

    try {
        const { isStageFilmstripEnabled } = require('../filmstrip/functions');

        isStageFilmstrip = isStageFilmstripEnabled(state);
    } catch (e) {
        // Stage filmstrip not available on this platform
    }

    const nonModeratorParticipantsWithVideo: Array<{ participantId: string; pinned: boolean; }> = [];

    remoteParticipants.forEach((participant, participantId) => {
        const isModerator = isParticipantModerator(participant);
        const hasVideo = !isParticipantVideoMuted(participant, state);

        if (!isModerator && hasVideo) {
            nonModeratorParticipantsWithVideo.push({
                participantId,
                pinned: true
            });
        }
    });

    if (nonModeratorParticipantsWithVideo.length > 0) {
        if (isStageFilmstrip) {
            try {
                const { setStageParticipants } = require('../filmstrip/actions.web');

                dispatch(setStageParticipants(nonModeratorParticipantsWithVideo));
            } catch (e) {
                // Fallback to pinning single participant if stage not available
                if (nonModeratorParticipantsWithVideo.length === 1) {
                    dispatch(pinParticipant(nonModeratorParticipantsWithVideo[0].participantId));
                }
            }
        } else if (nonModeratorParticipantsWithVideo.length === 1) {
            dispatch(pinParticipant(nonModeratorParticipantsWithVideo[0].participantId));
        }
    }
}

/**
 * Debounced version of _pinNonModeratorsForRecordingImpl for dynamic updates during recording.
 * Uses debouncing to avoid rapid consecutive calls when multiple tracks change simultaneously.
 * The direct (non-debounced) function is called on recording start for immediate pinning.
 */
const _pinNonModeratorsForRecording = debounce(_pinNonModeratorsForRecordingImpl, 500);
