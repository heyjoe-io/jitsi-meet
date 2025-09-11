// NB: This import must always come first.
import './bootstrap.native';

import React, { PureComponent, Suspense, lazy } from 'react';
import { AppRegistry, View, ActivityIndicator } from 'react-native';

import { _initLogging } from './features/base/logging/functions';

// Lazy load the main App component for better code splitting
const App = lazy(() => import('./features/app/components/App.native').then(module => ({ default: module.App })));

/**
 * React Native doesn't support specifying props to the main/root component (in
 * the JS/JSX source code). So create a wrapper React Component (class) around
 * features/app's App instead.
 *
 * @augments Component
 */
class Root extends PureComponent {
    /**
     * Implements React's {@link Component#render()}.
     *
     * @inheritdoc
     * @returns {ReactElement}
     */
    render() {
        return (
            <Suspense fallback={
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                    <ActivityIndicator size="large" />
                </View>
            }>
                <App { ...this.props } />
            </Suspense>
        );
    }
}

// Initialize logging.
_initLogging();

// Register the main/root Component of JitsiMeetView.
AppRegistry.registerComponent('App', () => Root);
