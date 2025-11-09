import { batch } from 'react-redux';

import { createRecordingEvent } from '../analytics/AnalyticsEvents';
import { sendAnalytics } from '../analytics/functions';
import { IStore } from '../app/types';
import { APP_WILL_MOUNT, APP_WILL_UNMOUNT } from '../base/app/actionTypes';
import { CONFERENCE_JOIN_IN_PROGRESS } from '../base/conference/actionTypes';
import { setFollowMeRecorder } from '../base/conference/actions.any';
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
import { updateLocalRecordingStatus } from '../base/participants/actions';
import { PARTICIPANT_ROLE } from '../base/participants/constants';
import { getLocalParticipant, getParticipantDisplayName, getRemoteParticipants, isParticipantModerator } from '../base/participants/functions';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';
import StateListenerRegistry from '../base/redux/StateListenerRegistry';
import { updateSettings } from '../base/settings/actions';
import {
    playSound,
    stopSound
} from '../base/sounds/actions';
import { TRACK_ADDED } from '../base/tracks/actionTypes';
import { getVideoTrackByParticipant, isParticipantMediaMuted } from '../base/tracks/functions.any';
import { addStageParticipant, setStageParticipants } from '../filmstrip/actions.web';
import { MAX_ACTIVE_PARTICIPANTS } from '../filmstrip/constants';
import { isStageFilmstripAvailable } from '../filmstrip/functions.web';
import { hideNotification, showErrorNotification, showNotification } from '../notifications/actions';
import { NOTIFICATION_TIMEOUT_TYPE } from '../notifications/constants';
import { isRecorderTranscriptionsRunning } from '../transcribing/functions';

import { RECORDING_SESSION_UPDATED, START_LOCAL_RECORDING, STOP_LOCAL_RECORDING } from './actionTypes';
import {
    clearRecordingSessions,
    hidePendingRecordingNotification,
    markConsentRequested,
    showPendingRecordingNotification,
    showRecordingError,
    showRecordingLimitNotification,
    showRecordingWarning,
    showStartRecordingNotification,
    showStartedRecordingNotification,
    showStoppedRecordingNotification,
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
    getResourceId,
    getSessionById,
    isCloudRecordingRunning,
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
            // Don't pin participants at PENDING - wait for Jibri to actually join
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

                // Don't pin immediately - wait for Jibri to fully join first
                logger.info('Recording started, waiting for Jibri to join before pinning participants');
            } else if (initiator && !oldSessionData?.initiator) {
                // Pin participants AFTER Jibri has joined and initiator is confirmed
                // This ensures Jibri receives the pinning events
                logger.info('Initiator confirmed, pinning participants for Jibri in 2 seconds');
                setTimeout(() => {
                    _autoPinNonModeratorsWithVideo(dispatch, getState);
                }, 2000);
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

            dispatch(setFollowMeRecorder(false));
        }

        break;
    }
    case TRACK_ADDED: {
        const { track } = action;

        if (LocalRecordingManager.isRecordingLocally()
                && track.mediaType === MEDIA_TYPE.AUDIO && track.local) {
            const audioTrack = track.jitsiTrack.track;

            LocalRecordingManager.addAudioTrackToLocalRecording(audioTrack);
        }
        break;
    }
    case PARTICIPANT_JOINED: {
        const state = getState();
        const { participant } = action;

        // If recording is active and a non-moderator with video joins, add them to stage
        if (isCloudRecordingRunning(state) && isStageFilmstripAvailable(state) && state['features/recording'].autoPinEnabled) {
            if (participant && !isParticipantModerator(participant)) {
                // Use setTimeout to ensure video track is available
                setTimeout(() => {
                    const currentState = getState();
                    const videoTrack = getVideoTrackByParticipant(currentState, participant);
                    const isVideoMuted = isParticipantMediaMuted(participant, MEDIA_TYPE.VIDEO, currentState);

                    if (videoTrack && !isVideoMuted) {
                        const remoteParticipants = getRemoteParticipants(currentState);
                        const nonModeratorsWithVideo: string[] = [];

                        // Only include remote non-moderators with video
                        remoteParticipants.forEach(p => {
                            if (isParticipantModerator(p)) {
                                return;
                            }
                            const vTrack = getVideoTrackByParticipant(currentState, p);
                            const vMuted = isParticipantMediaMuted(p, MEDIA_TYPE.VIDEO, currentState);

                            if (vTrack && !vMuted) {
                                nonModeratorsWithVideo.push(p.id);
                            }
                        });

                        const requiredStageSlots = Math.min(
                            nonModeratorsWithVideo.length || 1,
                            MAX_ACTIVE_PARTICIPANTS
                        );
                        const stageQueue = nonModeratorsWithVideo.map(participantId => ({
                            participantId,
                            pinned: true
                        }));

                        batch(() => {
                            dispatch(updateSettings({
                                maxStageParticipants: requiredStageSlots
                            }));
                            // Always replace stage participants to ensure moderators are removed
                            dispatch(setStageParticipants(stageQueue));
                        });
                    }
                }, 500);
            }
        }
        break;
    }
    case PARTICIPANT_UPDATED: {
        const { id, role } = action.participant;
        const state = getState();
        const localParticipant = getLocalParticipant(state);

        if (localParticipant?.id !== id) {
            return next(action);
        }

        if (role === PARTICIPANT_ROLE.MODERATOR) {
            dispatch(showStartRecordingNotification());
        }

        return next(action);
    }
    }

    return result;
});

/**
 * Automatically pins non-moderator participants with video enabled to the stage
 * when recording starts. This ensures only video-enabled non-moderators appear
 * in the recorded video. Also enables follow-me recorder mode to sync the layout
 * to Jibri.
 *
 * @private
 * @param {Dispatch} dispatch - The Redux Dispatch function.
 * @param {Function} getState - The Redux getState function.
 * @returns {void}
 */
function _autoPinNonModeratorsWithVideo(dispatch: IStore['dispatch'], getState: IStore['getState']) {
    const state = getState();

    // Check if auto-pin is enabled
    if (!state['features/recording'].autoPinEnabled) {
        logger.info('Auto-pin recording feature is disabled, skipping pinning');
        return;
    }

    if (!isStageFilmstripAvailable(state)) {
        return;
    }

    const remoteParticipants = getRemoteParticipants(state);
    const localParticipant = getLocalParticipant(state);
    const nonModeratorsWithVideo: string[] = [];

    // Only include remote non-moderators with video (never include local participant)
    remoteParticipants.forEach(participant => {
        if (isParticipantModerator(participant)) {
            logger.info(`Excluding moderator from stage: ${participant.name || participant.id}`);

            return;
        }

        const videoTrack = getVideoTrackByParticipant(state, participant);
        const isVideoMuted = isParticipantMediaMuted(participant, MEDIA_TYPE.VIDEO, state);

        if (videoTrack && !isVideoMuted) {
            nonModeratorsWithVideo.push(participant.id);
            logger.info(`Adding non-moderator with video to stage: ${participant.name || participant.id}`);
        } else {
            logger.info(`Excluding participant without video: ${participant.name || participant.id}`);
        }
    });

    logger.info(`Total non-moderators with video: ${nonModeratorsWithVideo.length}`, nonModeratorsWithVideo);

    if (nonModeratorsWithVideo.length === 0) {
        logger.warn('No non-moderators with video found, skipping stage setup');
        
        return;
    }

    const requiredStageSlots = Math.max(
        nonModeratorsWithVideo.length,
        MAX_ACTIVE_PARTICIPANTS
    );
    const stageQueue = nonModeratorsWithVideo.map(participantId => ({
        participantId,
        pinned: true
    }));

    logger.info(`Setting ${nonModeratorsWithVideo.length} stage participants with ${requiredStageSlots} max slots:`, stageQueue);

    // First, increase the max stage participants to accommodate all non-moderators
    dispatch(updateSettings({
        maxStageParticipants: requiredStageSlots
    }));

    // Small delay to ensure settings are applied before setting participants
    setTimeout(() => {
        logger.info('Applying stage participants:', stageQueue);
        dispatch(setStageParticipants(stageQueue));
    }, 100);

    // Enable follow-me recorder after participants are set
    // This ensures Jibri follows the moderator's layout going forward
    setTimeout(() => {
        logger.info('Enabling follow-me recorder mode');
        dispatch(setFollowMeRecorder(true));
    }, 500);
}

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
