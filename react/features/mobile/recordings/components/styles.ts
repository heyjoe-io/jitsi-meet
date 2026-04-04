import { HJBorderRadius, HJColors, HJFonts, HJShadow } from '../../../welcome/components/brandConstants';

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
        backgroundColor: HJColors.beige
    },
    optionItem: {
        flexDirection: 'row' as const,
        justifyContent: 'space-between' as const,
        alignItems: 'center' as const,
        paddingVertical: 12,
        paddingHorizontal: 18,
        backgroundColor: HJColors.white,
        borderBottomWidth: 1,
        borderBottomColor: HJColors.gray200,
    },
    optionText: {
        color: HJColors.gray800,
        fontFamily: HJFonts.body,
        fontWeight: '500' as const,
        fontSize: 16
    },
    qualityContainer: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 8
    },
    qualityText: {
        color: HJColors.gray600,
        fontFamily: HJFonts.body,
        fontSize: 14
    },
    studioName: {
        color: HJColors.primary,
        fontFamily: HJFonts.headline,
        fontSize: 18,
        fontWeight: 'bold' as const
    },
    recordingsContainer: {
        flex: 1,
        backgroundColor: HJColors.beige,
    },
    emptyContainer: {
        flex: 1,
        justifyContent: 'center' as const,
        alignItems: 'center' as const,
        padding: 20,
    },
    emptyText: {
        color: HJColors.gray500,
        fontFamily: HJFonts.body,
        fontSize: 16,
        textAlign: 'center' as const
    },
    recordingsList: {
        flex: 1
    },
    recordingItem: {
        flexDirection: 'row' as const,
        justifyContent: 'space-between' as const,
        alignItems: 'center' as const,
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: HJColors.white,
        marginTop: 8,
        marginHorizontal: 12,
        borderRadius: HJBorderRadius.lg,
        borderColor: HJColors.gray200,
        borderWidth: 1,
        gap: 8,
        ...HJShadow.card,
    },
    recordingItemText: {
        color: HJColors.gray800,
        fontFamily: HJFonts.body,
    },
    recordingItemDate: {
        color: HJColors.gray800,
        fontFamily: HJFonts.body,
        fontWeight: '500' as const,
        fontSize: 16,
    },
    recordingItemSize: {
        color: HJColors.gray500,
        fontFamily: HJFonts.body,
        fontSize: 14,
    },
    button: {
        width: 40,
        height: 40,
        backgroundColor: HJColors.primary,
        borderRadius: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    warningButton: {
        width: 40,
        height: 40,
        backgroundColor: '#d97706',
        borderRadius: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
    uploadButton: {
        backgroundColor: HJColors.white,
        borderRadius: HJBorderRadius.lg,
        borderColor: HJColors.primary,
        borderWidth: 1,
        alignItems: 'center' as const,
        height: 36,
        paddingHorizontal: 16,
        justifyContent: 'center' as const,
        flexDirection: 'row' as const,
        gap: 8
    },
    uploadButtonText: {
        color: HJColors.primary,
        fontFamily: HJFonts.body,
        fontWeight: '500' as const,
    },
    uploadProgressText: {
        color: HJColors.gray600,
        fontFamily: HJFonts.body,
        fontSize: 12,
    },
    actionButtonRow: {
        flexDirection: 'row' as const,
        gap: 12,
    },
};
