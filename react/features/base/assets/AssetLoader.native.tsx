import React, { ComponentType, lazy, Suspense } from 'react';
import { View, ActivityIndicator } from 'react-native';

/**
 * Creates a lazy-loaded component with a loading fallback
 * This helps reduce the initial bundle size by loading components on demand
 */
export function createLazyComponent<T extends ComponentType<any>>(
    importFunction: () => Promise<{ default: T }>,
    fallback?: React.ReactNode
) {
    const LazyComponent = lazy(importFunction);
    
    return (props: any) => (
        <Suspense fallback={fallback || (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
                <ActivityIndicator size="small" />
            </View>
        )}>
            <LazyComponent {...props} />
        </Suspense>
    );
}

/**
 * Lazy loads virtual background images to reduce initial bundle size
 */
export const VirtualBackgroundLoader = createLazyComponent(
    () => import('./VirtualBackgroundLoader.native')
);

/**
 * Lazy loads heavy UI components
 */
export const HeavyUIComponents = createLazyComponent(
    () => import('./HeavyUIComponents.native')
);
