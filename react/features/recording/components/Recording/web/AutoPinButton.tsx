import { connect } from 'react-redux';

import { IReduxState } from '../../../../app/types';
import { translate } from '../../../../base/i18n/functions';
import { IconPin } from '../../../../base/icons/svg';
import { isLocalParticipantModerator } from '../../../../base/participants/functions';
import AbstractButton, { IProps as AbstractButtonProps } from '../../../../base/toolbox/components/AbstractButton';
import { toggleAutoPinOnRecording } from '../../../actions.any';

interface IProps extends AbstractButtonProps {
    _autoPinEnabled: boolean;
    _isModerator: boolean;
}

class AutoPinButton extends AbstractButton<IProps> {
    override accessibilityLabel = 'toolbar.accessibilityLabel.autoPinRecording';
    override icon = IconPin;
    override label = 'toolbar.autoPinRecording';
    override toggledLabel = 'toolbar.autoPinRecordingEnabled';

    override _handleClick() {
        this.props.dispatch(toggleAutoPinOnRecording());
    }

    override _isToggled() {
        return this.props._autoPinEnabled;
    }
}

function _mapStateToProps(state: IReduxState) {
    const { autoPinOnRecording } = state['features/recording'];
    const _isModerator = isLocalParticipantModerator(state);
    const { toolbarButtons } = state['features/toolbox'];
    const visible = Boolean(toolbarButtons?.includes('autopinrecording') && _isModerator);

    return {
        _autoPinEnabled: autoPinOnRecording,
        _isModerator,
        visible
    };
}

export default translate(connect(_mapStateToProps)(AutoPinButton));
