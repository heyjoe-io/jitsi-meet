import { connect } from 'react-redux';

import { IReduxState } from '../../../../app/types';
import { translate } from '../../../../base/i18n/functions';
import { IconPin, IconPinned } from '../../../../base/icons/svg';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../../base/toolbox/components/AbstractButton';
import { toggleAutoPinRecording } from '../../../actions.any';

/**
 * The type of the React {@code Component} props of {@link AutoPinToggleButton}.
 */
interface IProps extends AbstractButtonProps {

    /**
     * Whether auto-pin is currently enabled or not.
     */
    _autoPinEnabled: boolean;
}

/**
 * An implementation of a button for toggling the auto-pin feature during recording.
 */
class AutoPinToggleButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.autoPinToggle';
    override icon = IconPin;
    override label = 'toolbar.autoPinRecording';
    override toggledIcon = IconPinned;
    override toggledLabel = 'toolbar.autoPinRecordingEnabled';

    /**
     * Handles clicking/pressing the button.
     *
     * @returns {void}
     */
    override _handleClick() {
        const { dispatch } = this.props;

        console.log('[AutoPinToggleButton] Button clicked, current state:', this.props._autoPinEnabled);
        dispatch(toggleAutoPinRecording());
        console.log('[AutoPinToggleButton] Action dispatched');
    }

    /**
     * Indicates whether this button is in toggled state or not.
     *
     * @returns {boolean}
     */
    override _isToggled() {
        return this.props._autoPinEnabled;
    }
}

/**
 * Maps (parts of) the redux state to the associated props for the
 * {@code AutoPinToggleButton} component.
 *
 * @param {Object} state - The Redux state.
 * @returns {IProps}
 */
function mapStateToProps(state: IReduxState) {
    const { autoPinEnabled, sessionDatas } = state['features/recording'];
    
    // Only show the button when recording is active
    const isRecording = sessionDatas?.some(
        (session: any) => session.mode === 'file' 
            && (session.status === 'on' || session.status === 'pending')
    ) ?? false;

    return {
        _autoPinEnabled: autoPinEnabled,
        visible: isRecording
    };
}

export default translate(connect(mapStateToProps)(AutoPinToggleButton));
