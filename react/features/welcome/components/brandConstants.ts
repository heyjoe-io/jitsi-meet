import { Platform } from 'react-native';

// HeyJoe Brand Design System
// Used ONLY for welcome/talent screens.
// Jitsi conference screens use the global BaseTheme (dark mode) unchanged.

export const HJColors = {
    primary: '#000000',
    white: '#ffffff',
    beige: '#fcf4e6',

    pink: '#f46ab9',
    green: '#8cc640',
    yellow: '#fad202',
    blue: '#4171f9',

    gray50: '#f9fafb',
    gray100: '#f3f4f6',
    gray200: '#e5e7eb',
    gray300: '#d1d5db',
    gray400: '#9ca3af',
    gray500: '#6b7280',
    gray600: '#4b5563',
    gray700: '#374151',
    gray800: '#1f2937',
    gray900: '#111827',
};

// iOS uses the font family name from the font metadata.
// Android uses the filename (without extension).
export const HJFonts = {
    headline: Platform.select({
        ios: 'Red Hat Display',
        android: 'RedHatDisplay-VariableFont_wght',
    }) as string,
    body: Platform.select({
        ios: 'Myriad Variable Concept',
        android: 'MyriadVariableConcept-Roman',
    }) as string,
    bodyBold: Platform.select({
        ios: 'Myriad Pro',
        android: 'MyriadPro-Bold',
    }) as string,
};

export const HJBorderRadius = {
    sm: 4,
    md: 6,
    lg: 8,
    xl: 12,
    pill: 50,
};

export const HJShadow = {
    card: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.08,
        shadowRadius: 3,
        elevation: 2,
    },
};
