import React, { useState, useEffect } from 'react';
import { Image } from 'react-native';

interface VirtualBackgroundLoaderProps {
    backgroundId: string;
    children: React.ReactNode;
}

/**
 * Lazy loads virtual background images to reduce initial bundle size
 * This component only loads the background image when it's actually needed
 */
export default function VirtualBackgroundLoader({ backgroundId, children }: VirtualBackgroundLoaderProps) {
    const [backgroundImage, setBackgroundImage] = useState<string | null>(null);
    const [isLoading, setIsLoading] = useState(true);

    useEffect(() => {
        // Only load the background image when it's actually needed
        const loadBackground = async () => {
            try {
                // Use dynamic import to load the image only when needed
                const imageModule = await import(`../../../images/virtual-background/background-${backgroundId}.jpg`);
                setBackgroundImage(imageModule.default);
            } catch (error) {
                console.warn('Failed to load virtual background:', error);
            } finally {
                setIsLoading(false);
            }
        };

        if (backgroundId) {
            loadBackground();
        } else {
            setIsLoading(false);
        }
    }, [backgroundId]);

    if (isLoading) {
        return <>{children}</>;
    }

    return (
        <>
            {backgroundImage && (
                <Image
                    source={{ uri: backgroundImage }}
                    style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        width: '100%',
                        height: '100%'
                    }}
                    resizeMode="cover"
                />
            )}
            {children}
        </>
    );
}
