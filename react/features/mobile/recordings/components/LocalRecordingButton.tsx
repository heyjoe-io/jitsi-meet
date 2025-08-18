import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, View, Text, NativeModules, Dimensions,
    TouchableOpacity, Platform } from 'react-native'
import { connect } from 'react-redux'
import DeviceInfo from 'react-native-device-info'
import { getLocalAudioTrack, getLocalVideoTrack } from '../../../base/tracks/functions.any'
import { IReduxState, IStore } from '../../app/types'
import { ADD_NATIVE_LOCAL_RECORDING, SET_CURRENT_RECORDING_PATH,
    START_NATIVE_LOCAL_RECORDING, STOP_NATIVE_LOCAL_RECORDING } from '../../../onboard/actionTypes'
import styles from './styles'
import { IconRecord } from '../../../base/icons/svg'
import { addWsListener, removeWsListener, sendMessage, uploadLocalRecordingNative } from '../../../onboard/functions'

console.log("NativeModules", NativeModules)

const Recorder = NativeModules.Recorder

let active = true

const formatDateString = (str?: string) => {
    if (!str) return ''
    return str.replace(/:/g, '-').replace('T', '-').replace(/\s/g, '-').replace(/\./g, '-').replace('Z', '')
}

const LocalRecordingButton = ({
    state,
    talent,
    videoTrack,
    audioTrack,
    mirror,
    isNativeLocalRecording,
    nativeLocalRecordings,
    roomName,
    currentRecordingPath,
    autoUploadLocalRecording,
    sessionId,
    talentId,

    setCurrentReccordingPath,
    startNativeLocalRecording,
    stopNativeLocalRecording,
    addNativeLocalRecording,
    uploadRecording,
    enable1080p
}) => {
    const recordingFilePath = useRef(currentRecordingPath)
    const [enabled, setEnabled]= useState(false)
    const startTime = useRef<Date | null>(null)

    const startRecording = useCallback(() => {
        if (!videoTrack) { return }

        // The videoTrack._constraints.width, videoTrack._constraints.height doesn't respond well to orientation on IOS
        // Within ios I just ignore those params, and use actual video track buffer's width, height.
        const isLandScape = Dimensions.get('screen').width > Dimensions.get('screen').height
        let width = Math.max(videoTrack._constraints.width, videoTrack._constraints.height)
        let height = Math.min(videoTrack._constraints.width, videoTrack._constraints.height)
        if (!isLandScape) {
            width = Math.min(videoTrack._constraints.width, videoTrack._constraints.height)
            height = Math.max(videoTrack._constraints.width, videoTrack._constraints.height)
        }
        startTime.current = new Date()
        Recorder.startRecording(
            videoTrack.id,
            width,
            height,
            videoTrack._constraints.frameRate,
            mirror === true,  // Explicitly convert to boolean, defaults to false
            roomName + "_" + (+new Date()),
            enable1080p === true  // Explicitly convert to boolean, defaults to false
        ).then((filePath: string) => {
            recordingFilePath.current = filePath
            setCurrentReccordingPath(filePath)
            startNativeLocalRecording()
        })
    }, [enable1080p, videoTrack, nativeLocalRecordings])

    const stopRecording = useCallback(() => {
        Recorder.stopRecording().then((fileSize: string) => {
            if (fileSize.startsWith("ERROR:")) {
                Alert.alert("Error!", fileSize)
            }
            stopNativeLocalRecording()
            if (recordingFilePath.current) {
                const endTime = new Date()
                const ext = recordingFilePath.current.split('.').pop()
                const upKey = `${state['features/talent'].studio?.jitsi_meeting_id}_${formatDateString(startTime.current?.toISOString())}_to_${formatDateString(endTime.toISOString())}.${ext}`
                addNativeLocalRecording(recordingFilePath.current, fileSize, startTime.current, endTime, upKey)
                if (autoUploadLocalRecording) {
                    setTimeout(() => {
                        uploadRecording(state, recordingFilePath.current, sessionId, talentId, upKey)
                    }, 1000)
                }
            }
        })

    }, [videoTrack, sessionId, talentId, autoUploadLocalRecording])

    const handleRecordPress = () => {
        if (!isNativeLocalRecording) {
            startRecording()
        } else {
            stopRecording()
        }
    }

    const checkEnabled = async () => {
        setEnabled(false)
        if (Platform.OS === 'android') {
            const apiLevel = await DeviceInfo.getApiLevel();
            console.log('apiLevel', apiLevel)
            if (!active) { return }

            if (apiLevel >= 34) {
                setEnabled(true)
            }
        } else {
            if (!active) { return }
            setEnabled(true)
        }
    };

    useEffect(() => {
        active = true
        checkEnabled()
        return () => { active = false }
    }, [])

    useEffect(() => {
        if (!enabled) return
        const wsHandler = (ev: any) => { 
            const type = ev.message?.type
            switch (type) {
                case 'start-local-recording':
                    startRecording()
                    break
                case 'stop-local-recording':
                    stopRecording()
                    break
            }
        }
        addWsListener(wsHandler)
        return () => {
            removeWsListener(wsHandler)
        }
    }, [enabled, startRecording, stopRecording])

    useEffect(() => {
        if (!sessionId || !talentId) return
        let intervalHandler: NodeJS.Timeout | null = null
        if (isNativeLocalRecording) {
            intervalHandler = setInterval(() => {
                sendMessage(`talent-session-${sessionId}`, {
                    type: 'local-record-started',
                    talentId,
                })
            }, 1000);
        } else {
            sendMessage(`talent-session-${sessionId}`, {
                type: 'local-record-stopped',
                talentId,
            })
        }
        return () => {
            if (!intervalHandler) return
            clearInterval(intervalHandler)
        }
    }, [isNativeLocalRecording, sessionId, talentId])

    if (!videoTrack || !talent) return null
    if (!enabled) return null

    const color = isNativeLocalRecording ? "white": "black"

    return (
        <TouchableOpacity onPress={() => handleRecordPress()}>
            <View style={[
                styles.nativeRecordingButtonWrapper,
                { backgroundColor: isNativeLocalRecording ? "red": "rgba(255,255,255,0.8)" }
            ]}>
                <IconRecord fill={color} />
                <Text style={{ color, fontWeight: 900 }}>
                    {isNativeLocalRecording ? "STOP": "REC"}
                </Text>
            </View>
        </TouchableOpacity>
    )
}

function _mapStateToProps(state: IReduxState, ownProps: any) {
    const videoTrack = getLocalVideoTrack(state['features/base/tracks']);
    const audioTrack = getLocalAudioTrack(state['features/base/tracks']);
    const isNativeLocalRecording = state['features/talent'].isNativeLocalRecording
    const nativeLocalRecordings = state['features/talent'].nativeLocalRecordings || []
    const talent = state['features/talent'].talent
    const currentRecordingPath = state['features/talent'].currentRecordingPath
    const autoUploadLocalRecording = state['features/talent'].autoUploadLocalRecording
    const sessionId = state['features/talent'].session?._id
    const talentId = state['features/talent'].talent?._id
    const enable1080p = state['features/talent'].enable1080p

    const roomName = state['features/base/conference'].room

    console.log('videoTrack', isNativeLocalRecording)

    return {
        state,
        videoTrack: videoTrack?.jitsiTrack?.track,
        audioTrack: audioTrack?.jitsiTrack?.track,
        mirror: videoTrack?.mirror,
        currentRecordingPath,
        isNativeLocalRecording,
        nativeLocalRecordings,
        roomName,
        talent,
        autoUploadLocalRecording,
        sessionId,
        talentId,
        enable1080p
    };
}

function _mapDispatchToProps(dispatch: IStore['dispatch']) {
    const uploadRecording = (state, key, session, talent, upKey) => {
        return uploadLocalRecordingNative(
            state, dispatch, key, session, talent, upKey
        )
    }
    return {
        setCurrentReccordingPath(key: string) {
            dispatch({ type: SET_CURRENT_RECORDING_PATH, key })
        },
        startNativeLocalRecording() {
            dispatch({ type: START_NATIVE_LOCAL_RECORDING })
        },
        stopNativeLocalRecording() {
            dispatch({ type: STOP_NATIVE_LOCAL_RECORDING })
        },
        addNativeLocalRecording(key: string, fileSize: string, startTime: Date, endTime: Date, upKey: string) {
            dispatch({ type: ADD_NATIVE_LOCAL_RECORDING, key, fileSize, startTime, endTime, upKey })
        },
        uploadRecording
    };
}


export default connect(_mapStateToProps, _mapDispatchToProps)(LocalRecordingButton)
