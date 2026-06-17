import Foundation

// DockKit ships only in the iPhoneOS SDK (not the simulator SDK), so EVERY
// DockKit-typed member must be compiled out on simulator via canImport — not just
// gated by @available. The two-layer gate: #if canImport(DockKit) for SDK/type
// availability, @available(iOS 17, *) for the OS version within the device SDK.
#if canImport(DockKit)
import DockKit
import Spatial
#endif

/// DockKit gimbal control (iOS 17+). Owns the connected accessory, runs the seven
/// V1 commands, and posts `statusDidChangeNotification` on any support/connection/
/// tracking change so the RN layer can re-report capability to Casting Admin.
///
/// On simulator (no DockKit) or iOS < 17, `isSupported` is false and every command
/// fails cleanly. DockKit calls are isolated below; the motor API uses Spatial's
/// Vector3D/Rotation3D (not simd). Axis signs + nudge magnitude must be tuned on the
/// physical Insta360 gimbal.
@objc(HJGimbalController)
public class HJGimbalController: NSObject, @unchecked Sendable {

    // @unchecked Sendable: this is an ObjC-interop singleton whose mutable state is
    // low-contention (status bools + one accessory ref) and only mutated from its own
    // serialized Tasks. We vouch for its cross-concurrency safety so strict concurrency
    // allows the shared singleton and Task self-captures.
    @objc public static let shared = HJGimbalController()

    /// Posted (main thread) on any support/connected/tracking change.
    @objc public static let statusDidChangeNotification = Notification.Name("HJGimbalStatusDidChange")

    /// Manual nudge tuning — rad/s and step duration. Tune on device.
    private static let nudgeRate: Double = 0.6
    private static let nudgeNanos: UInt64 = 300_000_000 // 0.3s

    private var isTracking = false
    private var observing = false

    /// Holds a `DockAccessory` at runtime, typed as AnyObject so the property exists
    /// on SDKs without DockKit (simulator). Nil ⇒ no gimbal docked.
    private var _accessory: AnyObject?

    // MARK: - Status

    @objc public var isSupported: Bool {
        #if canImport(DockKit)
        if #available(iOS 17.0, *) { return true }
        #endif

        return false
    }

    @objc public var isConnected: Bool {
        _accessory != nil
    }

    @objc public var isTrackingActive: Bool { isTracking }

    // MARK: - Observation

    /// Begin watching for gimbal connect/disconnect. Safe to call repeatedly.
    @objc public func startObserving() {
        #if canImport(DockKit)
        guard #available(iOS 17.0, *), !observing else { return }
        observing = true

        Task { [weak self] in
            // Resilient: if the stream ends or throws (e.g. it was opened at module
            // init before any camera session existed), back off and re-subscribe
            // instead of going permanently deaf to later docks.
            while true {
                guard let self = self else { return }
                do {
                    // accessoryStateChanges is a throwing async sequence AND the property
                    // access itself throws, so evaluate it with `try` before iterating.
                    let stateChanges = try DockAccessoryManager.shared.accessoryStateChanges
                    for try await change in stateChanges {
                        if change.state == .docked {
                            self._accessory = change.accessory
                        } else {
                            self._accessory = nil
                            self.isTracking = false
                        }
                        self.postStatusChange()
                    }
                } catch {
                    // Stream ended/errored — re-subscribe after a brief backoff.
                }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
        #endif
    }

    private func postStatusChange() {
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: HJGimbalController.statusDidChangeNotification, object: nil)
        }
    }

    // MARK: - Commands

    /// Run one of the seven V1 commands. completion(ok, error) on an arbitrary queue.
    // completion is @Sendable so it can be safely called both from the early guard
    // paths (current task) and from inside the Task below — without it, Xcode 26's
    // strict concurrency rejects the Task closure capturing a non-Sendable callback.
    @objc public func executeCommand(_ command: String, completion: @escaping @Sendable (Bool, String?) -> Void) {
        #if canImport(DockKit)
        guard #available(iOS 17.0, *) else {
            completion(false, "Gimbal control requires iOS 17 or later")

            return
        }
        guard let accessory = _accessory as? DockAccessory else {
            completion(false, "Gimbal not connected")

            return
        }

        Task {
            do {
                switch command {
                case "start_tracking":
                    try await DockAccessoryManager.shared.setSystemTrackingEnabled(true)
                    self.isTracking = true
                case "stop_tracking":
                    try await DockAccessoryManager.shared.setSystemTrackingEnabled(false)
                    self.isTracking = false
                case "recenter":
                    // Manual move requires tracking off; point neutral. setOrientation
                    // has defaulted params on the 17+ SDK, so the identity rotation
                    // alone should satisfy it — if your SDK requires explicit
                    // duration/reference args, add them here.
                    try await DockAccessoryManager.shared.setSystemTrackingEnabled(false)
                    self.isTracking = false
                    // setOrientation is synchronous and returns an animation handle
                    // we don't need to await — fire-and-forget the move to neutral.
                    _ = try accessory.setOrientation(Rotation3D.identity)
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
        #else
        completion(false, "Gimbal control is not available on this device")
        #endif
    }

    #if canImport(DockKit)
    /// A discrete manual nudge: spin briefly, then stop. Requires tracking off.
    /// Axis convention to confirm on device: x = pitch (tilt), y = yaw (pan), z = roll.
    @available(iOS 17.0, *)
    private func nudge(_ accessory: DockAccessory, pitch: Double, yaw: Double) async throws {
        try await DockAccessoryManager.shared.setSystemTrackingEnabled(false)
        isTracking = false
        // Spatial Vector3D, rad/s.
        try await accessory.setAngularVelocity(Vector3D(x: pitch, y: yaw, z: 0))
        try await Task.sleep(nanoseconds: Self.nudgeNanos)
        try await accessory.setAngularVelocity(Vector3D(x: 0, y: 0, z: 0))
    }
    #endif
}
