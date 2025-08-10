/* eslint-disable react/jsx-no-bind */
import React from 'react';
import {
    Animated,
    Image,
    ImageStyle,
    Linking,
    NativeSyntheticEvent,
    SafeAreaView,
    StyleProp,
    TextInputFocusEventData,
    TextStyle,
    TouchableHighlight,
    TouchableOpacity,
    View,
    ViewStyle
} from 'react-native';
import { connect } from 'react-redux';

import { IReduxState } from '../../app/types';
import { translate } from '../../base/i18n/functions';
import LoadingIndicator from '../../base/react/components/native/LoadingIndicator';
import Text from '../../base/react/components/native/Text';
import BaseTheme from '../../base/ui/components/BaseTheme.native';
import Button from '../../base/ui/components/native/Button';
import Input from '../../base/ui/components/native/Input';
import { BUTTON_TYPES } from '../../base/ui/constants.native';
import getUnsafeRoomText from '../../base/util/getUnsafeRoomText.native';

import {
    IProps as AbstractProps,
    AbstractWelcomePage,
    _mapStateToProps as _abstractMapStateToProps
} from './AbstractWelcomePage';
import styles from './styles.native';

const HEY_JOE_LOGO = require('../../../../images/hey-joe-logo.png');

interface IProps extends AbstractProps {

    /**
     * Function for getting the unsafe room text.
     */
    getUnsafeRoomTextFn: Function;

    /**
     * Default prop for navigating between screen components(React Navigation).
     */
    navigation: any;
}

/**
 * The native container rendering the talent page.
 *
 * @augments AbstractWelcomePage
 */
class TalentPage extends AbstractWelcomePage<IProps> {
    _onFieldBlur: (e: NativeSyntheticEvent<TextInputFocusEventData>) => void;
    _onFieldFocus: (e: NativeSyntheticEvent<TextInputFocusEventData>) => void;

    /**
     * Constructor of the Component.
     *
     * @inheritdoc
     */
    constructor(props: IProps) {
        super(props);

        this.state._fieldFocused = false;

        this.state.isSettingsScreenFocused = false;

        this.state.roomNameInputAnimation = new Animated.Value(1);

        this.state.hintBoxAnimation = new Animated.Value(0);

        this.state.showEnterRoomNumber = false;

        // Bind event handlers so they are only bound once per instance.
        this._onFieldFocusChange = this._onFieldFocusChange.bind(this);
        this._renderHintBox = this._renderHintBox.bind(this);

        // Specially bind functions to avoid function definition on render.
        this._onFieldBlur = this._onFieldFocusChange.bind(this, false);
        this._onFieldFocus = this._onFieldFocusChange.bind(this, true);
        this._onSettingsScreenFocused = this._onSettingsScreenFocused.bind(this);
    }

    /**
     * Implements React's {@link Component#componentDidMount()}. Invoked
     * immediately after mounting occurs. Creates a local video track if none
     * is available and the camera permission was already granted.
     *
     * @inheritdoc
     * @returns {void}
     */
    override componentDidMount() {
        super.componentDidMount();

        const {
            navigation
        } = this.props;

        navigation.setOptions({
            headerTitle: 'Talent Portal'
        });

        navigation.addListener('focus', () => {
            this._updateRoomName();
        });

        navigation.addListener('blur', () => {
            this._clearTimeouts();

            this.setState({
                generatedRoomName: '',
                insecureRoomName: false,
                room: ''
            });
        });
    }

    /**
     * Implements React's {@link Component#render()}. Renders a prompt for
     * entering a room name.
     *
     * @inheritdoc
     * @returns {ReactElement}
     */
    override render() {
        // We want to have the welcome page support the reduced UI layout,
        // but we ran into serious issues enabling it so we disable it
        // until we have a proper fix in place. We leave the code here though, because
        // this part should be fine when the bug is fixed.
        //
        // NOTE: when re-enabling, don't forget to uncomment the respective _mapStateToProps line too

        /*
        const { _reducedUI } = this.props;

        if (_reducedUI) {
            return this._renderReducedUI();
        }
        */

        return this._renderFullUI();
    }


    /**
     * Constructs a style array to handle the hint box animation.
     *
     * @private
     * @returns {Array<Object>}
     */
    _getHintBoxStyle() {
        return [
            styles.messageContainer,
            styles.hintContainer,
            {
                opacity: this.state.hintBoxAnimation
            }
        ];
    }

    /**
     * Callback for when the room field's focus changes so the hint box
     * must be rendered or removed.
     *
     * @private
     * @param {boolean} focused - The focused state of the field.
     * @returns {void}
     */
    _onFieldFocusChange(focused: boolean) {
        if (focused) {
            // Stop placeholder animation.
            this._clearTimeouts();
            this.setState({
                _fieldFocused: true,
                roomPlaceholder: ''
            });
        } else {
            // Restart room placeholder animation.
            this._updateRoomName();
        }

        Animated.timing(

            this.state.hintBoxAnimation,

            {
                duration: 300,
                toValue: focused ? 1 : 0,
                useNativeDriver: true
            })
            .start(animationState =>

                animationState.finished

                && !focused
                    && this.setState({
                        _fieldFocused: false
                    }));
    }

    /**
     * Callback for when the settings screen is focused.
     *
     * @private
     * @param {boolean} focused - The focused state of the screen.
     * @returns {void}
     */
    _onSettingsScreenFocused(focused: boolean) {
        this.setState({
            isSettingsScreenFocused: focused
        });

        this.props.navigation.setOptions({
            headerShown: !focused
        });

        Animated.timing(
            this.state.roomNameInputAnimation,
            {
                toValue: focused ? 0 : 1,
                duration: 500,
                useNativeDriver: true
            })
            .start();
    }

    /**
     * Renders the hint box if necessary.
     *
     * @private
     * @returns {React$Node}
     */
    _renderHintBox() {

        if (this.state._fieldFocused) {
            return (
                <Animated.View style = { this._getHintBoxStyle() as ViewStyle[] }>
                    <View style = { styles.hintButtonContainer as ViewStyle } >
                        { this._renderJoinButton() }
                    </View>
                </Animated.View>
            );
        }

        return null;
    }

    /**
     * Renders the join button.
     *
     * @private
     * @returns {ReactElement}
     */
    _renderJoinButton() {
        const { t } = this.props;
        let joinButton;


        if (this.state.joining) {
            // TouchableHighlight is picky about what its children can be, so
            // wrap it in a native component, i.e. View to avoid having to
            // modify non-native children.
            joinButton = (
                <TouchableHighlight
                    accessibilityLabel =
                        { t('welcomepage.accessibilityLabel.join') }
                    onPress = { this._onJoin }
                    style = { styles.button as ViewStyle }>
                    <View>
                        <LoadingIndicator
                            color = { BaseTheme.palette.icon01 }
                            size = 'small' />
                    </View>
                </TouchableHighlight>
            );
        } else {
            joinButton = (
                <Button
                    accessibilityLabel = { 'welcomepage.accessibilityLabel.join' }
                    labelKey = { 'welcomepage.join' }
                    labelStyle = { styles.joinButtonLabel }
                    onClick = { this._onJoin }
                    type = { BUTTON_TYPES.PRIMARY } />
            );
        }

        return joinButton;
    }

    _renderJoinLobbyButton() {
        return (
            <TouchableHighlight
                onPress = { () => {
                    // TODO: implement join lobby
                } }
                style = { styles.talentButton as ViewStyle }>
                <Text style = { styles.buttonText as TextStyle }>
                    Join New Video Capture Lobby
                </Text>
            </TouchableHighlight>
        );
    }

    _renderMoreOptionsButton() {
        const roomnameAccLabel = 'welcomepage.accessibilityLabel.roomname';
        const { t } = this.props;
        const { isSettingsScreenFocused } = this.state;

        return (
            <Animated.View
                style = { [
                    isSettingsScreenFocused && styles.roomNameInputContainer,
                    { opacity: this.state.roomNameInputAnimation }
                ] as StyleProp<ViewStyle> }>
                <TouchableHighlight
                    onPress = { () => this._onMoreOptions(!this.state.showEnterRoomNumber) }
                    style = { styles.talentButton as ViewStyle }>
                    <Text style = { styles.buttonText as TextStyle }>
                        More Options
                    </Text>
                </TouchableHighlight>
                { this.state.showEnterRoomNumber && <SafeAreaView style = { styles.roomContainer as StyleProp<ViewStyle> }>
                    <View style = { styles.joinControls } >
                        <Text style = { styles.enterRoomText as StyleProp<TextStyle> }>
                            Enter room number (admin use only)
                        </Text>
                        <Input
                            accessibilityLabel = { t(roomnameAccLabel) }
                            autoCapitalize = { 'none' }
                            autoFocus = { false }
                            customStyles = {{ input: styles.customInput }}
                            onBlur = { this._onFieldBlur }
                            onChange = { this._onRoomChange }
                            onFocus = { this._onFieldFocus }
                            onSubmitEditing = { this._onJoin }
                            placeholder = { 'Room #' }
                            returnKeyType = { 'go' }
                            value = { this.state.room } />
                        {
                            this._renderHintBox()
                        }
                    </View>
                </SafeAreaView>}
            </Animated.View>
        );
    }

    _renderLocalRecordingsButton() {
        return (
            <TouchableHighlight
                onPress = { () => {
                    this.props.navigation.navigate('Local Recordings');
                } }
                style = { styles.talentButton as ViewStyle }>
                <Text style = { styles.buttonText as TextStyle }>
                    Local Recordings
                </Text>
            </TouchableHighlight>
        );
    }

    _renderSupportText() {
        const renderInlineText = (text: string) =>
            text.split(' ').map((word, idx) => (
                <Text
                    key = { idx }
                    style = { styles.supportText }>{word}&nbsp;</Text>
            ));

        return (
            <View style = { styles.supportContainer as ViewStyle }>
                {renderInlineText('For support, email us at')}
                <TouchableOpacity onPress = { () => Linking.openURL('mailto:support@heyjoe.io') }>
                    <Text style = { styles.linkTextSmall }>support@heyjoe.io&nbsp;</Text>
                </TouchableOpacity>
                {renderInlineText('or live chat us at')}
                <TouchableOpacity onPress = { () => Linking.openURL('https://heyjoe.io/') }>
                    <Text style = { styles.linkTextSmall }>heyjoe.io</Text>
                </TouchableOpacity>
            </View>
        );
    }


    /**
     * Renders the full welcome page.
     *
     * @returns {ReactElement}
     */
    _renderFullUI() {
        return (
            <SafeAreaView style = { styles.safeAreaView as ViewStyle }>
                <View style = { styles.talentPage as ViewStyle }>
                    <View style = { styles.talentTopContainer as ViewStyle }>
                        <Image
                            source = { HEY_JOE_LOGO }
                            style = { styles.logo as ImageStyle } />
                        <View>
                            {this._renderJoinLobbyButton()}
                            {this._renderMoreOptionsButton()}
                            {this._renderLocalRecordingsButton()}
                        </View>
                    </View>
                    {this._renderSupportText()}
                </View>
            </SafeAreaView>
        );
    }
}

/**
 * Maps part of the Redux state to the props of this component.
 *
 * @param {Object} state - The Redux state.
 * @returns {Object}
 */
function _mapStateToProps(state: IReduxState) {
    return {
        ..._abstractMapStateToProps(state),

        // _reducedUI: state['features/base/responsive-ui'].reducedUI
        getUnsafeRoomTextFn: (t: Function) => getUnsafeRoomText(state, t, 'welcome')
    };
}

export default translate(connect(_mapStateToProps)(TalentPage));
