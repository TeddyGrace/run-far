import Capacitor
import Foundation

/// Capacitor bridge for the HealthBridge plugin.
///
/// Thin by design: every method here translates a JS call into a `HealthBridgeSync` call and
/// translates the result back. All the actual work lives in HealthBridgeSync so that the
/// background wake path — which has no WebView and never reaches this file — runs exactly the
/// same code as a foreground sync.
@objc(HealthBridgePlugin)
public class HealthBridgePlugin: CAPPlugin, CAPBridgedPlugin {
  public let identifier = "HealthBridgePlugin"
  public let jsName = "HealthBridge"
  public let pluginMethods: [CAPPluginMethod] = [
    CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "sync", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "setBackgroundDelivery", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
    CAPPluginMethod(name: "reset", returnType: CAPPluginReturnPromise),
  ]

  private let sync = HealthBridgeSync.shared

  /// Re-arm background delivery on launch.
  ///
  /// Observer queries do not survive process death, and iOS kills and relaunches the app
  /// freely. Without this, background sync would work until the first time the app was
  /// terminated and then silently stop — which is the worst possible failure mode, because
  /// nothing looks broken until the athlete notices their recovery score is days old.
  override public func load() {
    if sync.backgroundDeliveryEnabled {
      sync.setBackgroundDelivery(enabled: true)
    }
  }

  @objc func isAvailable(_ call: CAPPluginCall) {
    call.resolve([
      "available": sync.isAvailable,
      "reason": sync.isAvailable
        ? "" : "Apple Health isn't available on this device (iPhone required).",
    ])
  }

  @objc func requestAuthorization(_ call: CAPPluginCall) {
    sync.requestAuthorization { result in
      switch result {
      case .success:
        // "Requested", not "granted": iOS does not disclose read-permission status, so
        // claiming a grant here would be asserting something the OS refused to tell us.
        call.resolve(["authorizationRequested": true])
      case .failure(let error):
        call.reject(error.localizedDescription)
      }
    }
  }

  @objc func configure(_ call: CAPPluginCall) {
    guard let apiBaseUrl = call.getString("apiBaseUrl"),
      let deviceToken = call.getString("deviceToken")
    else {
      call.reject("apiBaseUrl and deviceToken are required")
      return
    }
    sync.configure(
      apiBaseUrl: apiBaseUrl, deviceToken: deviceToken, timeZone: call.getString("timeZone"))
    call.resolve()
  }

  @objc func sync(_ call: CAPPluginCall) {
    let full = call.getBool("full") ?? false
    sync.sync(full: full) { result in
      switch result {
      case .success(let payload):
        call.resolve(payload)
      case .failure(let error):
        call.reject(error.localizedDescription)
      }
    }
  }

  @objc func setBackgroundDelivery(_ call: CAPPluginCall) {
    sync.setBackgroundDelivery(enabled: call.getBool("enabled") ?? false)
    call.resolve()
  }

  @objc func getStatus(_ call: CAPPluginCall) {
    call.resolve([
      "available": sync.isAvailable,
      "configured": sync.isConfigured,
      "backgroundDeliveryEnabled": sync.backgroundDeliveryEnabled,
      "lastSyncedAt": sync.lastSyncedAt ?? NSNull(),
      "lastError": sync.lastError ?? NSNull(),
    ])
  }

  @objc func reset(_ call: CAPPluginCall) {
    sync.reset()
    call.resolve()
  }
}
