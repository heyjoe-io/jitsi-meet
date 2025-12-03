import { connect } from 'react-redux';

import { createRecordingDialogEvent } from '../../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../../analytics/functions';
import { IReduxState, IStore } from '../../../../app/types';
import { IJitsiConference } from '../../../../base/conference/reducer';
import { translate } from '../../../../base/i18n/functions';
import { JitsiRecordingConstants } from '../../../../base/lib-jitsi-meet';
import { setRequestingSubtitles } from '../../../../subtitles/actions.any';
import { toggleScreenshotCaptureSummary } from '../../../../screenshot-capture/actions';
import { RECORDING_METADATA_ID } from '../../../constants';
import { getActiveSession } from '../../../functions';
import AbstractRecordButton, {
    IProps as AbstractProps,
    _mapStateToProps as _abstractMapStateToProps
} from '../AbstractRecordButton';

/**
 * The type of the React {@code Component} props of {@link RecordingButton}.
 */
interface IProps extends AbstractProps {

    /**
     * The {@code JitsiConference} for the current conference.
     */
    _conference?: IJitsiConference;

    /**
     * Whether subtitles should be displayed or not.
     */
    _displaySubtitles?: boolean;

    /**
     * The redux representation of the recording session to be stopped.
     */
    _fileRecordingSession?: any;

    /**
     * The selected language for subtitles.
     */
    _subtitlesLanguage: string | null;

    /**
     * Redux dispatch function.
     */
    dispatch: IStore['dispatch'];
}


/**
 * Button for opening a dialog where a recording session can be started.
 */
class RecordingButton extends AbstractRecordButton<IProps> {

    /**
     * Handles clicking / pressing the button.
     *
     * @override
     * @protected
     * @returns {void}
     */
    override _onHandleClick() {
        const { _isRecordingRunning } = this.props;

        if (_isRecordingRunning) {
            // Stop recording directly without showing dialog
            this._stopRecording();
        } else {
            // Start recording directly without dialog
            this._startRecording();
        }
    }

    /**
     * Starts recording directly with default settings using Jibri.
     *
     * @private
     * @returns {void}
     */
    async _startRecording() {
        const { _conference, dispatch } = this.props;

        if (_conference) {
            // Step 1: Pin camera-enabled users to stage first
            await this._pinCameraEnabledUsers();

            // Step 2: Enable follow-me after pinning is done
            const { setFollowMe } = await import('../../../../base/conference/actions.any');
            const { setFollowMeModerator } = await import('../../../../follow-me/actions');
            const { getLocalParticipant } = await import('../../../../base/participants/functions');
            
            const state = APP.store.getState();
            const localParticipant = getLocalParticipant(state);
            
            dispatch(setFollowMeModerator(localParticipant?.id));
            dispatch(setFollowMe(true));

            // Step 3: Start Jibri recording
            const appData = JSON.stringify({
                'file_recording_metadata': {
                    'share': false // You can set this to true if you want sharing enabled by default
                }
            });

            _conference.startRecording({
                mode: JitsiRecordingConstants.mode.FILE,
                appData
            });
        }
    }

    /**
     * Pins all participants with camera enabled to the stage.
     *
     * @private
     * @returns {Promise<void>}
     */
    async _pinCameraEnabledUsers() {
        if (navigator.product === 'ReactNative') {
            return;
        }

        try {
            const { dispatch } = this.props;
            const { isStageFilmstripAvailable } = await import('../../../../filmstrip/functions.web');
            const { addStageParticipant, clearStageParticipants } = await import('../../../../filmstrip/actions.web');
            const { setFilmstripVisible } = await import('../../../../filmstrip/actions.any');
            const { setTileView } = await import('../../../../video-layout/actions.web');
            const { updateSettings } = await import('../../../../base/settings/actions');
            const { getRemoteParticipants, getLocalParticipant } = await import('../../../../base/participants/functions');
            const { isParticipantVideoMuted } = await import('../../../../base/tracks/functions.any');
            
            const state = APP.store.getState();

            if (!isStageFilmstripAvailable(state)) {
                return;
            }

            const remoteParticipants = getRemoteParticipants(state);
            const localParticipant = getLocalParticipant(state);
            const participantsToPinIds: string[] = [];

            remoteParticipants.forEach((participant: any) => {
                if (!participant.botType && !isParticipantVideoMuted(participant, state)) {
                    participantsToPinIds.push(participant.id);
                }
            });

            if (localParticipant && !isParticipantVideoMuted(localParticipant, state)) {
                participantsToPinIds.push(localParticipant.id);
            }

            if (participantsToPinIds.length === 0) {
                return;
            }

            // Update maxStageParticipants
            const maxNeeded = Math.max(participantsToPinIds.length, 6);
            dispatch(updateSettings({ maxStageParticipants: maxNeeded }));

            // Disable tile view
            dispatch(setTileView(false));

            // Hide filmstrip
            dispatch(setFilmstripVisible(false));

            // Clear existing pins and add camera-enabled participants
            dispatch(clearStageParticipants());
            participantsToPinIds.forEach(participantId => {
                dispatch(addStageParticipant(participantId, true));
            });

            // Wait a bit for layout to stabilize before enabling follow-me
            await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
            console.error('Error pinning camera-enabled users:', error);
        }
    }

    /**
     * Stops the recording if it's currently running.
     *
     * @private
     * @returns {void}
     */
    _stopRecording() {
        const {
            _conference,
            _displaySubtitles,
            _fileRecordingSession,
            _subtitlesLanguage,
            dispatch
        } = this.props;

        sendAnalytics(createRecordingDialogEvent('stop', 'confirm.button'));

        // Only handle Jibri (file) recordings
        if (_fileRecordingSession) {
            _conference?.stopRecording(_fileRecordingSession.id);
            dispatch(toggleScreenshotCaptureSummary(false));
        }

        dispatch(setRequestingSubtitles(Boolean(_displaySubtitles), _displaySubtitles, _subtitlesLanguage));

        _conference?.getMetadataHandler().setMetadata(RECORDING_METADATA_ID, {
            isTranscribingEnabled: false
        });
    }
}

/**
 * Maps (parts of) the redux state to the associated props for the
 * {@code RecordButton} component.
 *
 * @param {Object} state - The Redux state.
 * @private
 * @returns {{
 *     _conference: IJitsiConference,
 *     _fileRecordingsDisabledTooltipKey: ?string,
 *     _isRecordingRunning: boolean,
 *     _disabled: boolean,
 *     visible: boolean
 * }}
 */
export function _mapStateToProps(state: IReduxState) {
    const abstractProps = _abstractMapStateToProps(state);
    const { toolbarButtons } = state['features/toolbox'];
    const visible = Boolean(toolbarButtons?.includes('recording') && abstractProps.visible);

    const {
        _displaySubtitles,
        _language: _subtitlesLanguage
    } = state['features/subtitles'];

    return {
        ...abstractProps,
        _conference: state['features/base/conference'].conference,
        _displaySubtitles,
        _fileRecordingSession: getActiveSession(state, JitsiRecordingConstants.mode.FILE),
        _subtitlesLanguage,
        visible
    };
}

export default translate(connect(_mapStateToProps)(RecordingButton));
