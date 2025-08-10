/* eslint-disable react/jsx-no-bind */
import React from 'react';
import { SafeAreaView, Text, View, ViewStyle } from 'react-native';
import { connect } from 'react-redux';

import { IReduxState } from '../../../app/types';
import Switch from '../../../base/ui/components/native/Switch';

import styles from './styles';

interface IRecordingItem {
    date?: string;
    id: string;
    key: string;
    status: 'pending' | 'uploaded' | 'failed';
    title?: string;
}

interface IProps {
    autoUploadLocalRecording: boolean;
    data: IRecordingItem[];
    enable1080p: boolean;
    setAutoUpload: (enabled: boolean) => void;
    setEnable1080p: (enabled: boolean) => void;
    state: IReduxState;
}

/**
 * Component for displaying local recordings list.
 *
 * @returns {React.ReactElement} The local recordings component.
 */
const LocalRecordings: React.FC<IProps> = ({
    autoUploadLocalRecording,
    enable1080p,
    data,
    setAutoUpload,
    setEnable1080p,
    state
}) => {
    const handleAutoUploadToggle = () => {
        setAutoUpload(!autoUploadLocalRecording);
    };

    const handle1080pToggle = () => {
        setEnable1080p(!enable1080p);
    };


    return (
        <SafeAreaView style = { styles.container }>
            <View style = { styles.optionItem }>
                <Text style = { styles.optionText }>Auto Upload?</Text>
                <Switch
                    checked = { autoUploadLocalRecording }
                    onChange = { handleAutoUploadToggle } />
            </View>

            <View style = { styles.optionItem }>
                <Text style = { styles.optionText }>Quality</Text>
                <View style = { styles.qualityContainer }>
                    <Text style = { styles.qualityText }>720p</Text>
                    <Switch
                        checked = { enable1080p }
                        onChange = { handle1080pToggle } />
                    <Text style = { styles.qualityText }>1080p</Text>
                </View>
            </View>

            <View style = { styles.optionItem }>
                <Text style = { styles.studioName }>
                    {state['features/talent']?.studio?.name ?? 'Hey Joe'}
                </Text>
            </View>

            <View style = { styles.recordingsContainer }>
                {data.length === 0 ? (
                    <View style = { styles.emptyContainer as unknown as ViewStyle }>
                        <Text style = { styles.emptyText }>
                            Looks like you haven't made any recordings yet.
                        </Text>
                    </View>
                ) : (
                    <View style = { styles.recordingsList }>
                        <Text style = { styles.optionText }>
                            Recordings will be displayed here
                        </Text>
                    </View>
                )}
            </View>
        </SafeAreaView>
    );
};

/**
 * Maps part of the Redux state to the props of this component.
 *
 * @param {Object} state - The Redux state.
 * @returns {Object}
 */
function _mapStateToProps(state: IReduxState) {
    const data = [];
    const autoUploadLocalRecording = state['features/talent']?.autoUploadLocalRecording || false;
    const enable1080p = state['features/talent']?.enable1080p || true;

    return {
        state,
        data,
        autoUploadLocalRecording,
        enable1080p,
    };
}

/**
 * Maps dispatch functions to props.
 *
 * @param {Function} dispatch - The Redux dispatch function.
 * @returns {Object}
 */
function _mapDispatchToProps(dispatch: any) {
    return {
        setAutoUpload(enabled: boolean) {
            dispatch({ type: 'SET_LOCAL_RECORD_AUTO_UPLOAD', enabled });
        },
        setEnable1080p(enabled: boolean) {
            dispatch({ type: 'SET_ENABLE_1080P', enabled });
        }
    };
}

export default connect(_mapStateToProps, _mapDispatchToProps)(LocalRecordings);
