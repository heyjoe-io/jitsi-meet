import { connect } from 'react-redux';
import { batch } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconRestore } from '../../../base/icons/svg';
import { MEDIA_TYPE, VIDEO_TYPE } from '../../../base/media/constants';
import { getLocalParticipant, getRemoteParticipants, isLocalParticipantModerator } from '../../../base/participants/functions';
import { updateSettings } from '../../../base/settings/actions';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { getLocalVideoTrack, getTrackState } from '../../../base/tracks/functions.any';
import { addStageParticipant, clearStageParticipants, removeStageParticipant } from '../../../filmstrip/actions.web';
import { MAX_ACTIVE_PARTICIPANTS } from '../../../filmstrip/constants';
import { isStageFilmstripAvailable } from '../../../filmstrip/functions.web';

/**
 * The type of the React {@code Component} props of {@link UpdatePinnedCamerasButton}.
 */
interface IProps extends AbstractButtonProps {

    /**
     * Array of participant IDs with camera enabled.
     */
    participantsWithCamera: string[];

    /**
     * Array of participant IDs currently pinned on stage.
     */
    currentlyPinnedParticipants: string[];

    /**
     * Current maximum stage participants setting.
     */
    currentMaxStageParticipants: number;
}

/**
 * Implementation of a button for updating pinned participants based on camera count.
 */
class UpdatePinnedCamerasButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.updatePinnedCameras';
    override icon = IconRestore;
    override label = 'toolbar.updatePinnedCameras';
    override tooltip = 'toolbar.updatePinnedCameras';

    /**
     * Handles clicking the button to update pinned participants.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, participantsWithCamera, currentlyPinnedParticipants } = this.props;

        sendAnalytics(createToolbarEvent('update.pinned.cameras'));

        const cameraCount = participantsWithCamera.length;
        const newMaxStageParticipants = Math.min(cameraCount, MAX_ACTIVE_PARTICIPANTS);

        console.log('UpdatePinnedCamerasButton: Camera count:', cameraCount);
        console.log('UpdatePinnedCamerasButton: Currently pinned:', currentlyPinnedParticipants);
        console.log('UpdatePinnedCamerasButton: Setting maxStageParticipants to:', newMaxStageParticipants);
        console.log('UpdatePinnedCamerasButton: Participants to pin:', participantsWithCamera);

        batch(() => {
            // First, clear all stage participants to ensure clean state
            console.log('UpdatePinnedCamerasButton: Clearing all stage participants');
            dispatch(clearStageParticipants());

            // Then, update the maxStageParticipants setting
            console.log('UpdatePinnedCamerasButton: Updating maxStageParticipants to:', newMaxStageParticipants);
            dispatch(updateSettings({ maxStageParticipants: newMaxStageParticipants }));

            // Finally, pin only the camera-enabled participants
            participantsWithCamera.forEach(participantId => {
                console.log('UpdatePinnedCamerasButton: Pinning participant:', participantId);
                dispatch(addStageParticipant(participantId, true));
            });
        });
    }

    /**
     * Indicates whether this button is disabled or not.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isDisabled() {
        return this.props.participantsWithCamera.length === 0;
    }
}

/**
 * Function that maps parts of Redux state tree into component props.
 *
 * @param {Object} state - Redux state.
 * @returns {Object}
 */
function mapStateToProps(state: IReduxState) {
    const remoteParticipants = getRemoteParticipants(state);
    const localParticipant = getLocalParticipant(state);
    const participantsWithCamera: string[] = [];
    const stageFilmstripAvailable = isStageFilmstripAvailable(state);
    const isModerator = isLocalParticipantModerator(state);
    const currentMaxStageParticipants = state['features/base/settings'].maxStageParticipants ?? 1;
    const { activeParticipants } = state['features/filmstrip'];

    // Get currently pinned participant IDs
    const currentlyPinnedParticipants = activeParticipants
        .filter(p => p.pinned)
        .map(p => p.participantId);

    console.log('UpdatePinnedCamerasButton: Total remote participants:', remoteParticipants.size);
    console.log('UpdatePinnedCamerasButton: Stage filmstrip available:', stageFilmstripAvailable);
    console.log('UpdatePinnedCamerasButton: Is moderator:', isModerator);
    console.log('UpdatePinnedCamerasButton: Current maxStageParticipants:', currentMaxStageParticipants);
    console.log('UpdatePinnedCamerasButton: Currently pinned participants:', currentlyPinnedParticipants);

    // Check if local participant has camera enabled
    if (localParticipant) {
        const tracks = getTrackState(state);
        const localVideoTrack = getLocalVideoTrack(tracks);
        const hasLocalCameraEnabled = localVideoTrack
            && !localVideoTrack.muted
            && localVideoTrack.videoType === VIDEO_TYPE.CAMERA;

        console.log('UpdatePinnedCamerasButton: Local participant has camera:', hasLocalCameraEnabled);

        if (hasLocalCameraEnabled) {
            participantsWithCamera.push(localParticipant.id);
        }
    }

    // Check remote participants
    remoteParticipants.forEach((participant, id) => {
        if (participant.sources) {
            const videoSources = participant.sources.get(MEDIA_TYPE.VIDEO);

            if (videoSources) {
                const hasCameraEnabled = Array.from(videoSources.values()).some(
                    source => source.videoType === VIDEO_TYPE.CAMERA && !source.muted
                );

                console.log(`UpdatePinnedCamerasButton: Participant ${id} has camera:`, hasCameraEnabled);

                if (hasCameraEnabled) {
                    participantsWithCamera.push(id);
                }
            }
        }
    });

    console.log('UpdatePinnedCamerasButton: Participants with camera:', participantsWithCamera);

    return {
        participantsWithCamera,
        currentlyPinnedParticipants,
        currentMaxStageParticipants,
        visible: isModerator && stageFilmstripAvailable && participantsWithCamera.length > 0
    };
}

export default translate(connect(mapStateToProps)(UpdatePinnedCamerasButton));

