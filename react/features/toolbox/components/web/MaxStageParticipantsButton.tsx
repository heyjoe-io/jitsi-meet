import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';

import { IReduxState } from '../../../app/types';
import { IconUsers } from '../../../base/icons/svg';
import ContextMenu from '../../../base/ui/components/web/ContextMenu';
import ContextMenuItemGroup from '../../../base/ui/components/web/ContextMenuItemGroup';
import { updateSettings } from '../../../base/settings/actions';
import { MAX_ACTIVE_PARTICIPANTS } from '../../../filmstrip/constants';
import ToolboxButtonWithIconPopup from '../../../base/toolbox/components/web/ToolboxButtonWithIconPopup';

/**
 * Button to control the maximum number of participants that can be pinned to the main stage.
 *
 * @returns {JSX.Element}
 */
const MaxStageParticipantsButton = (): JSX.Element => {
    const { t } = useTranslation();
    const dispatch = useDispatch();

    const maxStageParticipants = useSelector((state: IReduxState) =>
        state['features/base/settings'].maxStageParticipants ?? 6
    );

    const stageFilmstripEnabled = useSelector((state: IReduxState) =>
        state['features/base/config'].filmstrip?.disableStageFilmstrip !== true
    );

    const handleMaxStageParticipantsChange = useCallback((value: number) => {
        dispatch(updateSettings({ maxStageParticipants: value }));
    }, [ dispatch ]);

    if (!stageFilmstripEnabled) {
        return null;
    }

    const options = Array(MAX_ACTIVE_PARTICIPANTS).fill(0).map((_, index) => {
        const value = index + 1;

        return {
            text: `${value}`,
            onClick: () => handleMaxStageParticipantsChange(value),
            selected: value === maxStageParticipants
        };
    });

    return (
        <ToolboxButtonWithIconPopup
            ariaLabel = { t('toolbar.accessibilityLabel.maxStageParticipants') }
            icon = { IconUsers }
            iconDisabled = { false }
            iconId = 'max-stage-participants-button'
            iconToggledId = 'max-stage-participants-button-toggled'
            popupContent = {
                <ContextMenu>
                    <ContextMenuItemGroup>
                        {options.map(option => (
                            <ContextMenuItemGroup.Item
                                key = { option.text }
                                onClick = { option.onClick }
                                selected = { option.selected }
                                text = { option.text } />
                        ))}
                    </ContextMenuItemGroup>
                </ContextMenu>
            }
            toggled = { false }
            tooltip = { `${t('settings.maxStageParticipants')}: ${maxStageParticipants}` }
            visible = { true } />
    );
};

export default MaxStageParticipantsButton;

