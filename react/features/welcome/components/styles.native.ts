import { StyleSheet } from 'react-native';

import { BoxModel } from '../../base/styles/components/styles/BoxModel';
import BaseTheme from '../../base/ui/components/BaseTheme.native';

export const AVATAR_SIZE = 104;

/**
 * The default color of text on the WelcomePage.
 */
const TEXT_COLOR = BaseTheme.palette.text01;

/**
 * The styles of the React {@code Components} of the feature welcome including
 * {@code WelcomePage} and {@code BlankPage}.
 */
export default {

    blankPageText: {
        color: TEXT_COLOR,
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
        backgroundColor: BaseTheme.palette.action01,
        borderColor: BaseTheme.palette.action01,
        borderRadius: BaseTheme.shape.borderRadius,
        borderWidth: 1,
        height: BaseTheme.spacing[7],
        justifyContent: 'center',
        paddingHorizontal: BaseTheme.spacing[4]
    },

    joinButtonLabel: {
        textTransform: 'uppercase'
    },

    joinButtonText: {
        alignSelf: 'center',
        color: BaseTheme.palette.text01,
        fontSize: 14
    },

    enterRoomText: {
        color: TEXT_COLOR,
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
        color: BaseTheme.palette.text01,
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

    /**
     * A view that contains the field and hint box.
     */
    joinControls: {
        padding: BoxModel.padding
    },

    messageContainer: {
        backgroundColor: BaseTheme.palette.ui03,
        borderRadius: BaseTheme.shape.borderRadius,
        marginVertical: BaseTheme.spacing[1],
        paddingHorizontal: BaseTheme.spacing[2],
        paddingVertical: 2 * BaseTheme.spacing[2]
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
        color: TEXT_COLOR,
        fontSize: 12
    },

    /**
     * Container for room name input box and 'join' button.
     */
    roomContainer: {
        alignSelf: 'stretch',
        flexDirection: 'column',
        marginHorizontal: BaseTheme.spacing[2]
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
        borderColor: BaseTheme.palette.ui10,
        borderRadius: 4,
        borderWidth: 1,
        color: TEXT_COLOR,
        fontSize: 23,
        height: 50,
        padding: 4,
        textAlign: 'center'
    },

    /**
     * Application title style.
     */
    title: {
        color: TEXT_COLOR,
        fontSize: 25,
        marginBottom: 2 * BoxModel.margin,
        textAlign: 'center'
    },

    insecureRoomNameWarningContainer: {
        alignItems: 'center',
        flexDirection: 'row',
        paddingHorizontal: BaseTheme.spacing[1]
    },

    insecureRoomNameWarningIcon: {
        color: BaseTheme.palette.warning02,
        fontSize: 24,
        marginRight: 10
    },

    insecureRoomNameWarningText: {
        color: BaseTheme.palette.text01,
        flex: 1
    },

    /**
     * The style of the top-level container of {@code WelcomePage}.
     */
    safeAreaView: {
        flex: 1
    },
    welcomePage: {
        backgroundColor: BaseTheme.palette.uiBackground,
        flex: 1,
        overflow: 'hidden',
        paddingTop: 20
    },
    talentPage: {
        backgroundColor: BaseTheme.palette.uiBackground,
        flex: 1,
        overflow: 'hidden',
        paddingTop: 20,
        justifyContent: 'space-between',
    },
    talentTopContainer: {
        paddingHorizontal: 8,
        gap: 20,
    },
    logo: {
        width: 120,
        height: 120,
        alignSelf: 'center'
    },
    onboardContainer: {
        marginHorizontal: 16,
    },
    welcomeText: {
        color: 'white',
        fontSize: 24,
        fontWeight: 'bold',
        textAlign: 'center',
        marginTop: 30,
    },
    cardWrap: {
        marginVertical: 20,
        backgroundColor: BaseTheme.palette.ui03,
        borderRadius: 8,
        flexDirection: 'column',
        gap: 18,
    },
    card: {
        margin: 10,
        paddingHorizontal: 10,
        paddingVertical: 16,
        gap: 18,
    },
    cardTitle: {
        fontSize: 18,
        fontWeight: 'bold',
        textAlign: 'center',
        color: 'white',
    },
    cardText: {
        color: 'white',
        fontSize: 16,
    },
    talentButton: {
        backgroundColor: BaseTheme.palette.action01,
        borderRadius: BaseTheme.shape.borderRadius,
        borderWidth: 1,
        height: BaseTheme.spacing[7],
        justifyContent: 'center',
        paddingHorizontal: BaseTheme.spacing[4],
        marginVertical: 8,
    },
    optionsButton: {
        backgroundColor: BaseTheme.palette.ui03,
        borderRadius: BaseTheme.shape.borderRadius,
        borderWidth: 1,
        height: BaseTheme.spacing[7],
        justifyContent: 'center',
        paddingHorizontal: BaseTheme.spacing[4],
    },
    buttonText: {
        alignSelf: 'center',
        color: BaseTheme.palette.text01,
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
        color: '#007AFF',
        fontSize: 16,
    },
    linkTextSmall: {
        color: '#007AFF',
    },
    supportContainer: {
        paddingHorizontal: 18,
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
    },
    supportText: {
        color: BaseTheme.palette.ui08,
    },
    customInput: {
        fontSize: 18,
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
};
