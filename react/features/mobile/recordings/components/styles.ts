import BaseTheme from '../../../base/ui/components/BaseTheme.native';

export default {
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
    }
};
