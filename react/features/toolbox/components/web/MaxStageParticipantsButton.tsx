import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';

import { IReduxState } from '../../../app/types';
import { IconUsers } from '../../../base/icons/svg';
import ContextMenu from '../../../base/ui/components/web/ContextMenu';
import ContextMenuItem from '../../../base/ui/components/web/ContextMenuItem';
import ContextMenuItemGroup from '../../../base/ui/components/web/ContextMenuItemGroup';
import { updateSettings } from '../../../base/settings/actions';
import { MAX_ACTIVE_PARTICIPANTS } from '../../../filmstrip/constants';
import ToolboxButtonWithIcon from '../../../base/toolbox/components/web/ToolboxButtonWithIcon';
import VideoSettingsPopup from '../../../settings/components/web/video/VideoSettingsPopup';

/**
 * Button to control the maximum number of participants that can be pinned to the main stage.
 *
 * @returns {JSX.Element | null}
 */
const MaxStageParticipantsButton = (): JSX.Element | null => {
    const { t } = useTranslation();
    const dispatch = useDispatch();
    const [isOpen, setIsOpen] = useState(false);

    const maxStageParticipants = useSelector((state: IReduxState) =>
        state['features/base/settings'].maxStageParticipants ?? 6
    );

    const stageFilmstripEnabled = useSelector((state: IReduxState) =>
        state['features/base/config'].filmstrip?.disableStageFilmstrip !== true
    );

    const handleMaxStageParticipantsChange = useCallback((value: number) => {
        dispatch(updateSettings({ maxStageParticipants: value }));
        setIsOpen(false);
    }, [ dispatch ]);

    const handleTogglePopup = useCallback(() => {
        setIsOpen(prev => !prev);
    }, []);

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
        <VideoSettingsPopup>
            <ToolboxButtonWithIcon
                ariaControls = 'max-stage-participants-dialog'
                ariaExpanded = { isOpen }
                ariaHasPopup = { true }
                ariaLabel = { t('toolbar.accessibilityLabel.maxStageParticipants') }
                icon = { IconUsers }
                iconDisabled = { false }
                iconId = 'max-stage-participants-button'
                iconTooltip = { `${t('settings.maxStageParticipants')}: ${maxStageParticipants}` }
                onIconClick = { handleTogglePopup }>
                <ContextMenu
                    activateFocusTrap = { true }
                    hidden = { !isOpen }
                    id = 'max-stage-participants-dialog'>
                    <ContextMenuItemGroup>
                        {options.map(option => (
                            <ContextMenuItem
                                key = { option.text }
                                onClick = { option.onClick }
                                selected = { option.selected }
                                text = { option.text } />
                        ))}
                    </ContextMenuItemGroup>
                </ContextMenu>
            </ToolboxButtonWithIcon>
        </VideoSettingsPopup>
    );
};

export default MaxStageParticipantsButton;
