import React, { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSelector } from 'react-redux';

import { IReduxState } from '../../../app/types';
import { ITeleprompterState } from '../../reducer';

// Intentional overlay colors (translucent scrim + white script text) that have no
// palette token; the teleprompter must stay legible over arbitrary video.
/* eslint-disable react-native/no-color-literals */

/**
 * Scroll-loop tick (~30fps).
 */
const TICK_MS = 33;

const styles = StyleSheet.create({
    overlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: 'rgba(0, 0, 0, 0.88)'
    },
    content: {
        paddingHorizontal: 20,
        // Clear the status bar / notch at the top and leave room at the bottom
        // so the final lines can scroll up into view.
        paddingTop: 80,
        paddingBottom: '60%'
    },
    text: {
        color: '#ffffff',
        fontWeight: '700',
        textAlign: 'center'
    }
});

/**
 * Headless-ish native overlay that renders the CD-driven teleprompter script and
 * auto-scrolls it. State arrives via the teleprompter middleware (endpoint
 * messages over the Jitsi data channel). Renders nothing until a script arrives.
 *
 * @returns {JSX.Element|null}
 */
const Teleprompter = (): JSX.Element | null => {
    const tp = useSelector(
        (state: IReduxState) => state['features/teleprompter'] as ITeleprompterState | undefined
    );
    const scrollRef = useRef<ScrollView>(null);
    const posRef = useRef(0);
    const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const lastResetRef = useRef(0);
    const lastNudgeRef = useRef(0);

    const script = tp?.script;
    const fontSize = tp?.fontSize || 28;
    const scrollSpeed = tp?.scrollSpeed || 30;
    const isScrolling = Boolean(tp?.isScrolling);
    const resetTrigger = tp?.resetTrigger || 0;
    const nudgeTrigger = tp?.nudgeTrigger || 0;
    const nudgeDir = tp?.nudgeDir || 0;

    // Auto-scroll loop, paced to scrollSpeed (px/sec) under CD control.
    useEffect(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }

        if (!isScrolling || !script) {
            return undefined;
        }

        const stepPx = Math.max(0.3, scrollSpeed / (1000 / TICK_MS));

        timerRef.current = setInterval(() => {
            posRef.current += stepPx;
            scrollRef.current?.scrollTo({ y: posRef.current, animated: false });
        }, TICK_MS);

        return () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [ isScrolling, scrollSpeed, script ]);

    // CD reset → scroll back to top.
    useEffect(() => {
        if (resetTrigger !== lastResetRef.current) {
            lastResetRef.current = resetTrigger;
            posRef.current = 0;
            scrollRef.current?.scrollTo({ y: 0, animated: true });
        }
    }, [ resetTrigger ]);

    // CD nudge → small jump in the given direction.
    useEffect(() => {
        if (nudgeTrigger !== lastNudgeRef.current) {
            lastNudgeRef.current = nudgeTrigger;
            posRef.current = Math.max(0, posRef.current + ((nudgeDir || 1) * 40));
            scrollRef.current?.scrollTo({ y: posRef.current, animated: true });
        }
    }, [ nudgeTrigger ]);

    // Only show while the CD has the teleprompter running (isScrolling). A pause is
    // sent as scrollSpeed 0 with isScrolling still true, so pausing holds the script
    // on screen; stopping (isScrolling false) hides it. Pasting a script without
    // starting it does not show anything.
    if (!script || !isScrolling) {
        return null;
    }

    return (
        <View
            pointerEvents = 'none'
            style = { styles.overlay }>
            <ScrollView
                contentContainerStyle = { styles.content }
                ref = { scrollRef }
                scrollEnabled = { false }
                showsVerticalScrollIndicator = { false }>
                <Text style = { [ styles.text, { fontSize } ] }>{ script }</Text>
            </ScrollView>
        </View>
    );
};

export default Teleprompter;
