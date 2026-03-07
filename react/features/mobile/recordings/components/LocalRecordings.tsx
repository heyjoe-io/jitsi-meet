import { FlatList, View, Text, SafeAreaView, Share, NativeModules, Alert, Platform, Linking } from 'react-native'
import { connect } from 'react-redux'
import { uploadLocalRecordingNative } from '../../../onboard/functions'
import { WebView } from 'react-native-webview';
import { TouchableOpacity } from 'react-native-gesture-handler'
import { useEffect, useState } from 'react'
import { Button, Modal, Portal } from 'react-native-paper'
import Video from 'react-native-video'
import BaseTheme from '../../../base/ui/components/BaseTheme.native';
import moment from 'moment'
import { IconCheck, IconCloudUpload, IconPlay, IconRestore, IconShare } from '../../../base/icons/svg'
import { SET_LOCAL_RECORD_AUTO_UPLOAD, SET_RECORDING_QUALITY, REMOVE_NATIVE_LOCAL_RECORDING } from '../../../onboard/actionTypes'
import Switch from '../../../base/ui/components/native/Switch'
import React from 'react';
import styles from './styles';

const VideoPlayer = ({ video, manualRotation }) => {
    return Platform.OS === 'ios' ? (
        <Video
            source={{ uri: `file://${video}` }}
            style={{ flex: 1 }}
            resizeMode="contain"
            controls
        />
    ) : (
        <WebView
            source={{
                html: `
                    <html>
                    <head>
                        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">
                        <style>
                            body {
                                margin: 0;
                                background: black;
                                display: flex;
                                justify-content: center;
                                align-items: center;
                                height: 100vh;
                                width: 100vw;
                                overflow: hidden;
                                position: relative;
                            }
                            video {
                                position: absolute;
                                width: ${manualRotation === 90 || manualRotation === 270 ? 'auto' : '100%'};
                                height: ${manualRotation === 90 || manualRotation === 270 ? '100vw' : '100%'};
                                max-width: ${manualRotation === 90 || manualRotation === 270 ? '100vh' : '100%'};
                                max-height: ${manualRotation === 90 || manualRotation === 270 ? '100vw' : '100%'};
                                transform: rotate(${manualRotation}deg);
                                object-fit: contain;
                            }
                            video::-webkit-media-controls-panel {
                                transform: rotate(-${manualRotation}deg);
                            }
                        </style>
                    </head>
                    <body>
                        <video controls autoplay playsinline src="file://${video}"></video>
                    </body>
                    </html>
                `
            }}
            style={{ flex: 1, backgroundColor: 'black' }}
            allowsInlineMediaPlayback={true}
            mediaPlaybackRequiresUserAction={false}
            originWhitelist={['*']}
            allowsFullscreenVideo={true}
            mixedContentMode="always"
            allowFileAccess={true}
            allowUniversalAccessFromFileURLs={true}
            javaScriptEnabled={true}
        />
    )
}

const RecordingItem = ({ item, onPress, onUpload }) => {
    const onShare = () => {
        if (Platform.OS === 'android') {
            // Just try to open the Movies folder
            Linking.openURL('content://com.android.externalstorage.documents/document/primary%3AMovies').catch(() => {
                // If that fails, show simple instructions
                Alert.alert(
                    'Find Your Videos',
                    'Open your Files app → Movies → HeyJoe',
                    [{ text: 'OK' }]
                );
            });
        } else {
            Share.share({
                url: `file://${item.key}`
            });
        }
    }

    return (
        <View style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 12,
            backgroundColor: 'black',
            marginTop: 12,
            marginHorizontal: 12,
            borderRadius: 4,
            borderColor: '#374151',
            borderWidth: 1,
            gap: 8
        }}>
            <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[styles.recordingItemText, {
                    fontSize: 18,
                }]}>
                    {moment(item.timestamp).format('YYYY/MM/DD hh:mm A')}
                </Text>
                <Text style={styles.recordingItemText}>{item.fileSize}</Text>
            </View>
            <View style={{flexDirection: 'row', gap: 12 }}>
                {item.status === 'uploaded' && (
                    <View style={{ flexDirection: 'row', gap: 4, alignItems: 'center'}}>
                        <IconCheck fill="green" />
                    </View>
                )}
                {item.status === 'uploading' && (
                    <View style={{flexDirection: 'row', gap: 8, marginLeft: 8}}>
                        <View style={{ flexDirection: 'column', gap: 2, alignItems: 'center'}}>
                            <IconCloudUpload fill="yellow" />
                            <Text style={{color: 'white'}}>{item.progress}%</Text>
                        </View>
                        <TouchableOpacity onPress={onUpload} style={[styles.button, {
                            backgroundColor: BaseTheme.palette.warning01
                        }]}>
                            <IconRestore fill="white" />
                        </TouchableOpacity>
                    </View>
                )}
                {item.status === 'pending' && (
                    <TouchableOpacity onPress={onUpload} style={styles.button}>
                        <IconCloudUpload fill="white" />
                    </TouchableOpacity>
                )}
                <TouchableOpacity onPress={onPress}  style={styles.button}>
                    <View>
                        <IconPlay fill="white" />
                    </View>
                </TouchableOpacity>
                <TouchableOpacity onPress={onShare} style={styles.button}>
                    <View>
                    {Platform.OS === 'android' ? (
                            <Text style={{color: 'white', fontSize: 18}}>▤</Text>  // Box symbol
                        ) : (
                            <IconShare fill="white" />
                        )}
                    </View>
                </TouchableOpacity>
            </View>
        </View>
    )
}

const LocalRecordingList = ({
    state, data, uploadRecording, autoUploadLocalRecording, setAutoUpload,
    recordingQuality, setRecordingQuality,
    removeLocalRecordings
}) => {
    const [video, showVideo] = useState(null)
    const [videoRotation, setVideoRotation] = useState(0)
    const [videoDimensions, setVideoDimensions] = useState({ width: '100%', height: '100%' })
    const [manualRotation, setManualRotation] = useState(0);

    const handleVideoPress = async (item) => {
        try {
            const filename = item.fileName || item.key.split('/').pop();
            console.log('Opening video:', filename);
            
            // Try to get video info first
            if (NativeModules.HighResRecorder && NativeModules.HighResRecorder.getRecordingInfo) {
                try {
                    const info = await NativeModules.HighResRecorder.getRecordingInfo(filename);
                    console.log('Video info:', info);
                    
                    // Check if dimensions indicate portrait
                    const width = parseInt(info.videoWidth || '0');
                    const height = parseInt(info.videoHeight || '0');
                    
                    if (height > width && width > 0) {
                        // Portrait video detected by dimensions
                        console.log('Portrait video detected:', width + 'x' + height);
                        setVideoRotation(90);
                        setVideoDimensions({ width: '56.25%', height: '100%' });
                    } else {
                        // Landscape or square
                        console.log('Landscape video:', width + 'x' + height);
                        setVideoRotation(0);
                        setVideoDimensions({ width: '100%', height: '100%' });
                    }
                } catch (error) {
                    console.log('getRecordingInfo failed, assuming portrait for now');
                    // For now, assume portrait if we can't get info
                    setVideoRotation(90);
                    setVideoDimensions({ width: '56.25%', height: '100%' });
                }
            } else {
                // No recorder module, default to portrait rotation
                setVideoRotation(90);
                setVideoDimensions({ width: '56.25%', height: '100%' });
            }
            
            showVideo(item);
        } catch (error) {
            console.log('Error in handleVideoPress:', error);
            setVideoRotation(0);
            setVideoDimensions({ width: '100%', height: '100%' });
            showVideo(item);
        }
    };

    const uploadAll = () => {
        data.forEach(item => {
            if (item.status === 'pending') {
                uploadRecording(state, item.key, item.session?.id, item.talent?.id, item.upKey)
            }
        })
    }

    const syncWithFiles = async () => {
        const toRemove = []
        for (item of data) {
            const url = "file://" + item.key
            try {
                await fetch(url, {method: 'HEAD'})
            } catch(err) {
                toRemove.push(item.key)
            }
        }
        if (toRemove.length > 0) {
            removeLocalRecordings(toRemove)
        }
    }

    useEffect(() => {
        syncWithFiles()
    }, [])

    return (
        <SafeAreaView style={{ flex : 1 }}>
            <View style = { styles.optionItem }>
                <Text style = { styles.optionText }>Auto Upload?</Text>
                <Switch
                    checked = { autoUploadLocalRecording }
                    onChange = {() => { setAutoUpload(!autoUploadLocalRecording) }}
                />
            </View>

            <View style = { styles.optionItem }>
                <Text style = { styles.optionText }>Quality</Text>
                <View style = { styles.qualityContainer }>
                    <Text style = { styles.qualityText }>1080p</Text>
                    <Switch
                        checked = { recordingQuality === '4K' }
                        onChange = {() => { setRecordingQuality(recordingQuality === '4K' ? '1080p' : '4K') }}
                    />
                    <Text style = { styles.qualityText }>4K</Text>
                </View>
            </View>

            <View style = { styles.optionItem }>
                <Text style = { styles.studioName }>
                    {state['features/talent']?.studio?.name ?? 'Hey Joe'}
                </Text>
            </View>

            <View style = { styles.recordingsContainer }>
                {data.length === 0 && (
                    <View style={{ flex: 1, padding: 12 }}>
                        <Text style={{ color: 'white', fontSize: 16, textAlign: 'center' }}>
                            Looks like you haven't made any recordings yet.
                        </Text>
                    </View>
                )}
                <FlatList
                    style={{ flex : 1 }}
                    data={data}
                    keyExtractor={item => item.key + item.status + item.progress}
                    renderItem={({ item }) => (
                        <RecordingItem
                            item={item}
                            onPress={() => handleVideoPress(item)}
                            onUpload={() => {
                                uploadRecording(state, item.key, item.session?.id, item.talent?.id, item.upKey)
                            }}
                        />
                    )}
                />
               <Portal>
                <Modal
                    visible={!!video}
                    contentContainerStyle={{
                        backgroundColor: '#141414',
                        flex: 1,
                    }}
                    onDismiss={() => {
                        showVideo(null);
                        setManualRotation(0);
                    }}
                >
                    <View style={{
                        position: "relative",
                        flexGrow: 1,
                        minHeight: '100%',
                    }}>
                        {video && (
                            <VideoPlayer video={video.key} manualRotation={manualRotation} />
                        )}
                        <View style={{
                            position: 'absolute',
                            bottom: 30,
                            left: 0,
                            right: 0,
                            flexDirection: 'row',
                            justifyContent: 'space-between',
                            paddingHorizontal: 20,
                            backgroundColor: 'rgba(0,0,0,0.5)',
                            paddingVertical: 10
                        }}>
                            <Button textColor={BaseTheme.palette.action01} onPress={() => { 
                                showVideo(null);
                                setManualRotation(0);
                            }}>
                                Close
                            </Button>

                            {Platform.OS !== 'ios' && (
                                <Button textColor={BaseTheme.palette.action01} onPress={() => {
                                    setManualRotation((prev) => (prev + 90) % 360);
                                }}>
                                    Rotate
                                </Button>
                            )}
                            
                            {video && video.status === 'pending' && (
                                <Button mode="contained" buttonColor={BaseTheme.palette.action01} onPress={() => {
                                    uploadRecording(state, video.key, video.session?.id, video.talent?.id, video.upKey)
                                    showVideo(null);
                                    setManualRotation(0);
                                }}>
                                    Upload
                                </Button>
                            )}
                        </View>
                    </View>
                </Modal>
            </Portal>
            </View>
        </SafeAreaView>
    )
}

function _mapStateToProps(state, ownProps) {
    const data = (state['features/talent'].nativeLocalRecordings || [])
        .filter(video => video.studio.jitsi_meeting_id === state['features/talent'].studio.jitsi_meeting_id)
        .sort((a, b) => {
            return new Date(b.timestamp) - new Date(a.timestamp)
        })
    const autoUploadLocalRecording = state['features/talent'].autoUploadLocalRecording
    const recordingQuality = state['features/talent'].recordingQuality || '1080p'

    return {
        state,
        data,
        autoUploadLocalRecording,
        recordingQuality
    }
}

function _mapDispatchToProps(dispatch) {
    const uploadRecording = (state, key, session, talent, upKey) => {
        return uploadLocalRecordingNative(
            state, dispatch, key, session, talent, upKey
        )
    }

    return {
        uploadRecording,
        setAutoUpload (enabled) {
            dispatch({ type: SET_LOCAL_RECORD_AUTO_UPLOAD, enabled })
        },
        setRecordingQuality (quality) {
            dispatch({ type: SET_RECORDING_QUALITY, quality })
        },
        removeLocalRecordings (keys = []) {
            dispatch({ type: REMOVE_NATIVE_LOCAL_RECORDING, keys })
        }
    }
}

export default connect(_mapStateToProps, _mapDispatchToProps)(LocalRecordingList)