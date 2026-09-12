import Foundation
import Security

/// The device push token, in the iOS Keychain.
///
/// Keychain rather than UserDefaults because this is a credential: it authenticates pushes as
/// the athlete for as long as the registration stands, with no expiry. UserDefaults is in the
/// app's plist, readable from an unencrypted device backup; the Keychain is not.
///
/// `ThisDeviceOnly` on the accessibility attribute matters for the same reason: without it the
/// token travels in an encrypted iCloud backup and can be restored onto a different phone,
/// which would leave a credential live on a device the athlete may no longer have. The whole
/// point of a per-device registration is that revoking one device does not affect another, and
/// a token that migrates quietly breaks that.
///
/// `AfterFirstUnlock` rather than `WhenUnlocked` because the background wake this token exists
/// for typically happens while the phone is locked in a pocket — HealthKit delivers when the
/// watch syncs on waking. `WhenUnlocked` would make the token unreadable in exactly the case
/// it was added for.
enum Keychain {
  private static let service = "app.runfar.healthbridge"
  private static let account = "device-token"

  static func setDeviceToken(_ token: String) {
    clearDeviceToken()
    guard let data = token.data(using: .utf8) else { return }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    SecItemAdd(query as CFDictionary, nil)
  }

  static func deviceToken() -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
      let data = item as? Data
    else {
      return nil
    }
    return String(data: data, encoding: .utf8)
  }

  static func clearDeviceToken() {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
  }
}
