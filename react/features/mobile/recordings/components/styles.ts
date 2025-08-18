import BaseTheme from '../../../base/ui/components/BaseTheme.native';

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
    container: {
        flex: 1,
        backgroundColor: BaseTheme.palette.uiBackground
    },
    optionItem: {
        flexDirection: 'row' as const,
        justifyContent: 'space-between' as const,
        alignItems: 'center' as const,
        paddingVertical: 8,
        paddingHorizontal: 18,
        borderBottomWidth: 1,
    },
    optionText: {
        color: BaseTheme.palette.text01,
        fontSize: 16
    },
    qualityContainer: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 8
    },
    qualityText: {
        color: BaseTheme.palette.text01,
        fontSize: 14
    },
    studioName: {
        color: BaseTheme.palette.text01,
        fontSize: 18,
        fontWeight: 'bold' as const
    },
    recordingsContainer: {
        flex: 1,
        backgroundColor: '#1f2937',
        borderColor: '#374151',
        borderTopWidth: 1,
        marginTop: 12
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'start' as const,
        alignItems: 'center' as const,
        padding: 20,
        color: 'white'
    },
    emptyText: {
        color: BaseTheme.palette.text02,
        fontSize: 16,
        textAlign: 'center' as const
    },
    recordingsList: {
        flex: 1
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
};
