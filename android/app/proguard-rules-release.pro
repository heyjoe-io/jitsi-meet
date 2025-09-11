-include proguard-rules.pro

# Crashlytics
-keepattributes *Annotation*
-keepattributes SourceFile,LineNumberTable
-keep public class * extends java.lang.Exception

# R8 missing classes - suppress warnings
-dontwarn com.facebook.memory.config.MemorySpikeConfig
-dontwarn kotlinx.parcelize.Parcelize

# 16KB page size optimization
-optimizations !code/simplification/arithmetic,!code/simplification/cast,!field/*,!class/merging/*
-optimizationpasses 5
-allowaccessmodification
-dontpreverify

# Remove logging
-assumenosideeffects class android.util.Log {
    public static boolean isLoggable(java.lang.String, int);
    public static int v(...);
    public static int i(...);
    public static int w(...);
    public static int d(...);
    public static int e(...);
}

# Keep React Native classes
-keep class com.facebook.react.** { *; }
-keep class com.facebook.jni.** { *; }
-keep class com.facebook.hermes.** { *; }

# Keep Jitsi Meet specific classes
-keep class org.jitsi.meet.** { *; }
-keep class org.hey.meet.** { *; }
