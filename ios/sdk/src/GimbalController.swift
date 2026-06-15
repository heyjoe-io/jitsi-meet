import Foundation
import simd

#if canImport(DockKit)
import DockKit
#endif

/// DockKit gimbal control (iOS 17+). Owns the connected accessory, runs the seven
/// V1 commands, and posts `statusDidChangeNotification` whenever support/connection/
/// tracking changes so the RN layer can re-report capability to Casting Admin.
///
/// Exposed to Objective-C (the RN module) via @objc; DockKit's async APIs are wrapped
/// in completion handlers so ObjC can call them.
///
/// NOTE for the build/device pass: the DockKit call sites below (marked DOCKKIT) use
/// the framework's documented shapes (setSystemTrackingEnabled / setAngularVelocity /
/// setOrientation, accessoryStateChanges). Confirm the exact signatures against the
/// 17+ SDK in Xcode, and tune the nudge axis signs + magnitude against the physical
/// Insta360 gimbal — "which way is left" and the right step size can only be set on
/// hardware.
@objc(HJGimbalController)
public class HJGimbalController: NSObject {

    @objc public static let shared = HJGimbalController()

    /// Posted (main thread) on any support/connected/tracking change.
    @objc public static let statusDidChangeNotification = Notification.Name("HJGimbalStatusDidChange")

    /// Angular speed for a manual pan/tilt nudge, rad/s. Tune on device.
    private static let nudgeRate: Float = 0.6
    /// How long a single nudge runs before stopping, giving a discrete step.
    private static let nudgeNanos: UInt64 = 300_000_000 // 0.3s

    private var isTracking = false
    private var observing = false

    // Stored as Any so the property exists on iOS < 17 (DockAccessory is 17+).
    private var _accessory: AnyObject?

    @available(iOS 17.0, *)
    private var accessory: DockAccessory? {
        get { _accessory as? DockAccessory }
        set { _accessory = newValue }
    }

    // MARK: - Status

    @objc public var isSupported: Bool {
        if #available(iOS 17.0, *) { return true }

        return false
    }

    @objc public var isConnected: Bool {
        if #available(iOS 17.0, *) { return accessory != nil }

        return false
    }

    @objc public var isTrackingActive: Bool { isTracking }

    /// Begin watching for gimbal connect/disconnect. Safe to call repeatedly.
    @objc public func startObserving() {
        guard #available(iOS 17.0, *), !observing else { return }
        observing = true

        Task { [weak self] in
            // DOCKKIT: accessoryStateChanges is an async sequence of connect/disconnect
            // events; each carries the accessory and its docked state.
            for await change in DockAccessoryManager.shared.accessoryStateChanges {
                guard let self = self else { return }

                if change.state == .docked {
                    self.accessory = change.accessory
                } else {
                    self.accessory = nil
                    self.isTracking = false
                }
                self.postStatusChange()
            }
        }
    }

    private func postStatusChange() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: HJGimbalController.statusDidChangeNotification, object: nil)
        }
    }

    // MARK: - Commands

    /// Run one of the seven V1 commands. completion(ok, error) on an arbitrary queue.
    @objc public func executeCommand(_ command: String, completion: @escaping (Bool, String?) -> Void) {
        guard #available(iOS 17.0, *) else {
            completion(false, "Gimbal control requires iOS 17 or later")

            return
        }
        guard let accessory = self.accessory else {
            completion(false, "Gimbal not connected")

            return
        }

        Task {
            do {
                switch command {
                case "start_tracking":
                    // DOCKKIT
                    try await DockAccessoryManager.shared.setSystemTrackingEnabled(true)
                    self.isTracking = true
                case "stop_tracking":
                    try await DockAccessoryManager.shared.setSystemTrackingEnabled(false)
                    self.isTracking = false
                case "recenter":
                    // Manual move requires tracking off; point level/forward.
                    try await DockAccessoryManager.shared.setSystemTrackingEnabled(false)
                    self.isTracking = false
                    // DOCKKIT: neutral orientation (identity quaternion).
                    try await accessory.setOrientation(simd_quatf(angle: 0, axis: simd_float3(0, 1, 0)))
                case "pan_left":
                    try await self.nudge(accessory, pitch: 0, yaw: Self.nudgeRate)
                case "pan_right":
                    try await self.nudge(accessory, pitch: 0, yaw: -Self.nudgeRate)
                case "tilt_up":
                    try await self.nudge(accessory, pitch: Self.nudgeRate, yaw: 0)
                case "tilt_down":
                    try await self.nudge(accessory, pitch: -Self.nudgeRate, yaw: 0)
                default:
                    completion(false, "Unsupported command: \(command)")

                    return
                }
                self.postStatusChange()
                completion(true, nil)
            } catch {
                completion(false, error.localizedDescription)
            }
        }
    }

    /// A discrete manual nudge: spin briefly, then stop. Requires tracking off.
    /// Axis convention (verify on device): x = pitch (tilt), y = yaw (pan), z = roll.
    @available(iOS 17.0, *)
    private func nudge(_ accessory: DockAccessory, pitch: Float, yaw: Float) async throws {
        try await DockAccessoryManager.shared.setSystemTrackingEnabled(false)
        isTracking = false
        // DOCKKIT: angular velocity in rad/s.
        try await accessory.setAngularVelocity(simd_float3(pitch, yaw, 0))
        try await Task.sleep(nanoseconds: Self.nudgeNanos)
        try await accessory.setAngularVelocity(simd_float3(0, 0, 0))
    }
}
