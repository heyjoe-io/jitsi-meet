import { StyleSheet } from 'react-native';

import { BoxModel } from '../../base/styles/components/styles/BoxModel';
import BaseTheme from '../../base/ui/components/BaseTheme.native';

import { HJBorderRadius, HJColors, HJFonts, HJShadow } from './brandConstants';

export const AVATAR_SIZE = 104;

/**
 * The styles of the React {@code Components} of the feature welcome including
 * {@code WelcomePage} and {@code BlankPage}.
 */
export default {

    blankPageText: {
        color: BaseTheme.palette.text01,
        fontSize: 18
    },

    /**
     * View that is rendered when there is no welcome page.
     */
    blankPageWrapper: {
        ...StyleSheet.absoluteFillObject,
        alignItems: 'center',
        backgroundColor: BaseTheme.palette.uiBackground,
        flex: 1,
        flexDirection: 'column',
        justifyContent: 'center'
    },

    /**
     * Join button style.
     */
    button: {
        backgroundColor: HJColors.primary,
        borderColor: HJColors.primary,
        borderRadius: HJBorderRadius.md,
        borderWidth: 1,
        height: 48,
        justifyContent: 'center',
        paddingHorizontal: 16
    },

    joinButtonLabel: {
        textTransform: 'uppercase'
    },

    joinButtonText: {
        alignSelf: 'center',
        color: HJColors.white,
        fontSize: 14
    },

    enterRoomText: {
        color: HJColors.gray800,
        fontFamily: HJFonts.body,
        fontSize: 18,
        marginBottom: BoxModel.margin
    },

    /**
     * Container for the button on the hint box.
     */
    hintButtonContainer: {
        flexDirection: 'row',
        justifyContent: 'center'
    },

    /**
     * Container for the hint box.
     */
    hintContainer: {
        flexDirection: 'column',
        overflow: 'hidden',
        marginVertical: 16,
    },

    /**
     * The text of the hint box.
     */
    hintText: {
        color: HJColors.gray800,
        textAlign: 'center'
    },

    /**
     * Container for the text on the hint box.
     */
    hintTextContainer: {
        marginBottom: 2 * BoxModel.margin
    },

    /**
     * Container for the items in the side bar.
     */
    itemContainer: {
        flexDirection: 'column',
        paddingTop: 10
    },

    messageContainer: {
        backgroundColor: HJColors.gray100,
        borderRadius: HJBorderRadius.md,
        marginVertical: 4,
        paddingHorizontal: 8,
        paddingVertical: 16
    },

    roomNameInputContainer: {
        height: '0%'
    },

    /**
     * Top-level screen style.
     */
    page: {
        flex: 1,
        flexDirection: 'column'
    },

    /**
     * The styles for reduced UI mode.
     */
    reducedUIContainer: {
        alignItems: 'center',
        backgroundColor: BaseTheme.palette.link01,
        flex: 1,
        justifyContent: 'center'
    },

    reducedUIText: {
        color: BaseTheme.palette.text01,
        fontSize: 12
    },

    /**
     * Container for room name input box and 'join' button.
     */
    roomContainer: {
        alignSelf: 'stretch',
        flexDirection: 'column',
        marginHorizontal: 8
    },

    /**
     * The container of the label of the audio-video switch.
     */
    switchLabel: {
        paddingHorizontal: 3
    },

    /**
     * Room input style.
     */
    textInput: {
        backgroundColor: 'transparent',
        borderColor: HJColors.gray300,
        borderRadius: 4,
        borderWidth: 1,
        color: HJColors.gray800,
        fontSize: 23,
        height: 50,
        padding: 4,
        textAlign: 'center'
    },

    /**
     * Application title style.
     */
    title: {
        color: HJColors.primary,
        fontSize: 25,
        marginBottom: 2 * BoxModel.margin,
        textAlign: 'center'
    },

    insecureRoomNameWarningContainer: {
        alignItems: 'center',
        flexDirection: 'row',
        paddingHorizontal: 4
    },

    insecureRoomNameWarningIcon: {
        color: BaseTheme.palette.warning02,
        fontSize: 24,
        marginRight: 10
    },

    insecureRoomNameWarningText: {
        color: HJColors.gray800,
        flex: 1
    },

    /**
     * The style of the top-level container of {@code WelcomePage}.
     */
    safeAreaView: {
        flex: 1,
        backgroundColor: HJColors.beige
    },
    welcomePage: {
        backgroundColor: HJColors.beige,
        flex: 1,
        overflow: 'hidden',
        paddingTop: 20
    },
    talentPage: {
        backgroundColor: HJColors.beige,
        flex: 1,
        overflow: 'hidden',
        paddingTop: 20,
        justifyContent: 'space-between',
        marginTop: '8%',
        paddingBottom: 16
    },
    talentTopContainer: {
        paddingHorizontal: 8,
        gap: 20,
    },
    logo: {
        width: 200,
        height: 97,
        alignSelf: 'center'
    },
    onboardContainer: {
        marginHorizontal: 16,
    },
    welcomeText: {
        color: HJColors.primary,
        fontFamily: HJFonts.headline,
        fontSize: 24,
        fontWeight: 'bold',
        textAlign: 'center',
        marginTop: 30,
    },
    cardWrap: {
        marginVertical: 20,
        backgroundColor: HJColors.white,
        borderRadius: HJBorderRadius.lg,
        borderColor: HJColors.gray200,
        borderWidth: 1,
        flexDirection: 'column',
        gap: 18,
        ...HJShadow.card,
    },
    card: {
        margin: 10,
        paddingHorizontal: 10,
        paddingVertical: 16,
        gap: 18,
    },
    cardTitle: {
        fontSize: 18,
        fontFamily: HJFonts.headline,
        fontWeight: 'bold',
        textAlign: 'center',
        color: HJColors.primary,
    },
    cardText: {
        color: HJColors.gray800,
        fontFamily: HJFonts.body,
        fontSize: 16,
        fontWeight: '500',
    },
    talentButton: {
        backgroundColor: HJColors.primary,
        borderColor: HJColors.primary,
        borderRadius: HJBorderRadius.md,
        borderWidth: 1,
        height: 48,
        justifyContent: 'center',
        paddingHorizontal: 16,
        marginVertical: 8,
    },
    optionsButton: {
        backgroundColor: HJColors.white,
        borderColor: HJColors.gray300,
        borderRadius: HJBorderRadius.md,
        borderWidth: 1,
        height: 48,
        justifyContent: 'center',
        paddingHorizontal: 16,
        marginVertical: 8,
    },
    buttonText: {
        alignSelf: 'center',
        color: HJColors.white,
        fontFamily: HJFonts.headline,
        fontSize: 16,
        fontWeight: 'bold'
    },
    optionsButtonText: {
        alignSelf: 'center',
        color: HJColors.primary,
        fontFamily: HJFonts.headline,
        fontSize: 16,
        fontWeight: 'bold'
    },
    listItem: {
        flexDirection: 'row',
        marginBottom: 4,
        gap: 8,
    },
    itemTextWrap: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'baseline',
    },
    linkText: {
        color: HJColors.pink,
        fontFamily: HJFonts.body,
        fontSize: 16,
        textDecorationLine: 'underline',
    },
    linkTextSmall: {
        color: HJColors.pink,
        fontFamily: HJFonts.body,
        textDecorationLine: 'underline',
    },
    supportContainer: {
        paddingHorizontal: 18,
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
    },
    supportText: {
        color: HJColors.gray500,
        fontFamily: HJFonts.body,
        fontWeight: '500',
    },
    customInput: {
        fontSize: 22,
        fontFamily: HJFonts.body,
        fontWeight: '500',
        letterSpacing: 0,
        textAlign: 'center'
    },
    recentList: {
        backgroundColor: BaseTheme.palette.uiBackground,
        flex: 1,
        overflow: 'hidden'
    },

    recentListDisabled: {
        backgroundColor: BaseTheme.palette.uiBackground,
        flex: 1,
        opacity: 0.8,
        overflow: 'hidden'
    },

    talentInfoText: {
        color: HJColors.gray800,
        fontFamily: HJFonts.body,
        textAlign: 'center'
    }
};
