/* eslint-disable react/jsx-no-bind */
import React, { useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';

import { IconRecord } from '../../../base/icons/svg';

const LocalRecordingButton = () => {
    const [ isNativeLocalRecording, setIsNativeLocalRecording ] = useState(false);

    const handleRecordPress = () => {
        // Mock functionality - just toggle the recording state
        setIsNativeLocalRecording(!isNativeLocalRecording);
        console.log('Recording button pressed:', !isNativeLocalRecording ? 'Starting' : 'Stopping');
    };

    const color = isNativeLocalRecording ? 'white' : 'black';
    const buttonStyle = {
        backgroundColor: isNativeLocalRecording ? 'red' : 'rgba(255,255,255,0.8)',
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 6,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 4
    };
    const textStyle = {
        color,
        fontWeight: '900' as const
    };

    return (
        <TouchableOpacity onPress = { handleRecordPress }>
            <View style = { buttonStyle }>
                <IconRecord fill = { color } />
                <Text style = { textStyle }>
                    {isNativeLocalRecording ? 'STOP' : 'REC'}
                </Text>
            </View>
        </TouchableOpacity>
    );
};

export default LocalRecordingButton;
