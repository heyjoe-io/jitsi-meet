import { connect } from 'react-redux';
import { batch } from 'react-redux';

import { createToolbarEvent } from '../../../analytics/AnalyticsEvents';
import { sendAnalytics } from '../../../analytics/functions';
import { IReduxState } from '../../../app/types';
import { translate } from '../../../base/i18n/functions';
import { IconPin, IconPinned } from '../../../base/icons/svg';
import { MEDIA_TYPE, VIDEO_TYPE } from '../../../base/media/constants';
import { getLocalParticipant, getRemoteParticipants, isLocalParticipantModerator } from '../../../base/participants/functions';
import { updateSettings } from '../../../base/settings/actions';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../base/toolbox/components/AbstractButton';
import { getLocalVideoTrack, getTrackState } from '../../../base/tracks/functions.any';
import { addStageParticipant, removeStageParticipant } from '../../../filmstrip/actions.web';
import { MAX_ACTIVE_PARTICIPANTS } from '../../../filmstrip/constants';
import { isStageFilmstripAvailable } from '../../../filmstrip/functions.web';

/**
 * The type of the React {@code Component} props of {@link PinAllCamerasButton}.
 */
interface IProps extends AbstractButtonProps {

    /**
     * Array of participant IDs with camera enabled.
     */
    participantsWithCamera: string[];

    /**
     * Whether all camera participants are currently pinned.
     */
    allCamerasPinned: boolean;
}

/**
 * Implementation of a button for pinning/unpinning all participants with camera enabled.
 */
class PinAllCamerasButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.pinAllCameras';
    override toggledAccessibilityLabel = 'toolbar.accessibilityLabel.unpinAllCameras';
    override icon = IconPin;
    override toggledIcon = IconPinned;
    override label = 'toolbar.pinAllCameras';
    override toggledLabel = 'toolbar.unpinAllCameras';
    override tooltip = 'toolbar.pinAllCameras';
    override toggledTooltip = 'toolbar.unpinAllCameras';

    /**
     * Handles clicking the button to toggle pin/unpin all participants with camera enabled.
     *
     * @private
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch, participantsWithCamera, allCamerasPinned } = this.props;

        if (allCamerasPinned) {
            // Unpin all camera participants
            sendAnalytics(createToolbarEvent('unpin.all.cameras'));
            console.log('PinAllCamerasButton: Removing participants from stage:', participantsWithCamera);

            participantsWithCamera.forEach(participantId => {
                console.log('PinAllCamerasButton: Removing participant from stage:', participantId);
                dispatch(removeStageParticipant(participantId));
            });
        } else {
            // Pin all camera participants
            sendAnalytics(createToolbarEvent('pin.all.cameras'));

            const cameraCount = participantsWithCamera.length;
            const newMaxStageParticipants = Math.min(cameraCount, MAX_ACTIVE_PARTICIPANTS);

            console.log('PinAllCamerasButton: Camera count:', cameraCount);
            console.log('PinAllCamerasButton: Setting maxStageParticipants to:', newMaxStageParticipants);
            console.log('PinAllCamerasButton: Adding participants to stage:', participantsWithCamera);

            batch(() => {
                // First, update the maxStageParticipants setting
                dispatch(updateSettings({ maxStageParticipants: newMaxStageParticipants }));

                // Then, pin all camera participants (addStageParticipant will handle updating existing ones)
                participantsWithCamera.forEach(participantId => {
                    console.log('PinAllCamerasButton: Adding participant to stage:', participantId);
                    dispatch(addStageParticipant(participantId, true));
                });
            });
        }
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

    /**
     * Indicates whether this button is in toggled state or not.
     *
     * @override
     * @protected
     * @returns {boolean}
     */
    override _isToggled() {
        return this.props.allCamerasPinned;
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
    const { activeParticipants } = state['features/filmstrip'];
    const isModerator = isLocalParticipantModerator(state);

    console.log('PinAllCamerasButton: Total remote participants:', remoteParticipants.size);
    console.log('PinAllCamerasButton: Stage filmstrip available:', stageFilmstripAvailable);
    console.log('PinAllCamerasButton: Is moderator:', isModerator);

    // Check if local participant has camera enabled
    if (localParticipant) {
        const tracks = getTrackState(state);
        const localVideoTrack = getLocalVideoTrack(tracks);
        const hasLocalCameraEnabled = localVideoTrack
            && !localVideoTrack.muted
            && localVideoTrack.videoType === VIDEO_TYPE.CAMERA;

        console.log('PinAllCamerasButton: Local participant has camera:', hasLocalCameraEnabled, 'localVideoTrack:', localVideoTrack);

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

                console.log(`PinAllCamerasButton: Participant ${id} has camera:`, hasCameraEnabled, 'videoSources:', videoSources);

                if (hasCameraEnabled) {
                    participantsWithCamera.push(id);
                }
            }
        }
    });

    console.log('PinAllCamerasButton: Participants with camera:', participantsWithCamera);

    // Check if all camera participants are currently pinned on stage
    const pinnedParticipantIds = activeParticipants
        .filter(p => p.pinned)
        .map(p => p.participantId);

    const allCamerasPinned = participantsWithCamera.length > 0
        && participantsWithCamera.every(id => pinnedParticipantIds.includes(id));

    console.log('PinAllCamerasButton: Pinned participants:', pinnedParticipantIds);
    console.log('PinAllCamerasButton: All cameras pinned:', allCamerasPinned);

    return {
        participantsWithCamera,
        allCamerasPinned,
        visible: isModerator && stageFilmstripAvailable && participantsWithCamera.length > 0
    };
}

export default translate(connect(mapStateToProps)(PinAllCamerasButton));
