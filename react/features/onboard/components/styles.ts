import BaseTheme from "../../base/ui/components/BaseTheme.native"

export default {
    nativeRecordingButtonWrapper: {
        height: 36,
        alignItems: 'center',
        backgroundColor: 'rgba(255,255,255,0.8)',
        paddingVertical: 2,
        paddingHorizontal: 8,
        borderRadius: 5,
        flexDirection: 'row',
        marginLeft: 4,
        gap: 4
    },
    optionItem: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingTop: 12,
        backgroundColor: 'black',
        marginHorizontal: 18,
    },
    recordingItemText: {
        color: 'white'
    },
    button: {
        width: 40,
        height: 40,
        backgroundColor: BaseTheme.palette.action01,
        borderRadius: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    uploadButton: {
        backgroundColor: BaseTheme.palette.ui09,
        borderRadius: 8,
        borderColor: BaseTheme.palette.action01,
        borderWidth: 1,
        alignItems: 'center',
        height: 36,
        paddingHorizontal: 16,
        justifyContent: 'center',
        flexDirection: 'row',
        gap: 8
    },
    uploadButtonText: {
        color: BaseTheme.palette.action01,
    }
}
