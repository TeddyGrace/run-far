import Foundation
import HealthKit

/// Reads HealthKit and pushes to the run-far API.
///
/// The single implementation of that, used by both paths: a foreground sync the athlete
/// triggered, and a background wake from HealthKit observer queries with no WebView alive.
/// Keeping it in one place is the reason the plugin's surface is as thin as it is — see
/// definitions.ts.
final class HealthBridgeSync {
  static let shared = HealthBridgeSync()

  private let store = HKHealthStore()
  private let defaults = UserDefaults.standard
  private var observerQueries: [HKObserverQuery] = []
  /// Serializes syncs. A background wake and a foreground tap can land together, and two
  /// concurrent passes would read the same window twice and push it twice.
  private let queue = DispatchQueue(label: "app.runfar.healthbridge.sync")
  private var syncing = false

  private enum Keys {
    static let apiBaseUrl = "runfar.health.apiBaseUrl"
    static let timeZone = "runfar.health.timeZone"
    static let backgroundEnabled = "runfar.health.backgroundEnabled"
    static let lastSyncedAt = "runfar.health.lastSyncedAt"
    static let lastError = "runfar.health.lastError"
  }

  var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

  var isConfigured: Bool {
    Keychain.deviceToken() != nil && defaults.string(forKey: Keys.apiBaseUrl) != nil
  }

  var backgroundDeliveryEnabled: Bool { defaults.bool(forKey: Keys.backgroundEnabled) }
  var lastSyncedAt: String? { defaults.string(forKey: Keys.lastSyncedAt) }
  var lastError: String? { defaults.string(forKey: Keys.lastError) }

  // MARK: - Configuration

  func requestAuthorization(completion: @escaping (Result<Void, Error>) -> Void) {
    guard isAvailable else {
      completion(.failure(HealthBridgeError.unavailable))
      return
    }
    // Read-only: run-far never writes to the Health store. Passing an empty share set is what
    // says so, and it is also what keeps the permission sheet to a single read column.
    store.requestAuthorization(toShare: [], read: HealthKitReader.readTypes) { _, error in
      DispatchQueue.main.async {
        if let error = error {
          completion(.failure(error))
        } else {
          // Deliberately not reporting a granted/denied verdict: iOS does not disclose
          // read-permission status (it would leak that someone declined to share a condition),
          // so the only honest signal is what a sync actually returns.
          completion(.success(()))
        }
      }
    }
  }

  func configure(apiBaseUrl: String, deviceToken: String, timeZone: String?) {
    defaults.set(apiBaseUrl, forKey: Keys.apiBaseUrl)
    if let timeZone = timeZone { defaults.set(timeZone, forKey: Keys.timeZone) }
    Keychain.setDeviceToken(deviceToken)
  }

  func reset() {
    setBackgroundDelivery(enabled: false)
    Keychain.clearDeviceToken()
    for key in [Keys.apiBaseUrl, Keys.timeZone, Keys.lastSyncedAt, Keys.lastError] {
      defaults.removeObject(forKey: key)
    }
  }

  // MARK: - Background delivery

  /// Register observer queries so iOS wakes the app when new sleep or workout data lands.
  ///
  /// This is what the iOS app is *for*. Without it, Apple Health data reaches run-far only when
  /// the athlete opens the app, which means the morning recommendation — the whole point of the
  /// product — is computed from yesterday. With it, the watch syncs on waking, iOS wakes the
  /// app, and the recovery score is on the dashboard before the athlete looks.
  ///
  /// Requires the HealthKit background-delivery capability in the app target; see docs/ios.md.
  func setBackgroundDelivery(enabled: Bool) {
    defaults.set(enabled, forKey: Keys.backgroundEnabled)

    let types: [HKSampleType] = [
      HKObjectType.categoryType(forIdentifier: .sleepAnalysis),
      HKObjectType.workoutType(),
    ].compactMap { $0 as? HKSampleType }

    guard enabled else {
      for query in observerQueries { store.stop(query) }
      observerQueries.removeAll()
      for type in types {
        store.disableBackgroundDelivery(for: type) { _, _ in }
      }
      return
    }

    for type in types {
      let query = HKObserverQuery(sampleType: type, predicate: nil) { [weak self] _, handler, _ in
        // `handler` must be called or iOS escalates to eventually stopping delivery to the
        // app. Called after the sync settles, whether or not it succeeded: a failed push leaves
        // nothing behind to lose, since the next wake re-reads the same rolling window.
        self?.sync(full: false) { _ in handler() }
      }
      store.execute(query)
      observerQueries.append(query)

      // `.immediate` for sleep and workouts specifically: both are low-frequency events where
      // the whole value is in arriving promptly. iOS still coalesces and rate-limits this.
      store.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
    }
  }

  // MARK: - Sync

  func sync(full: Bool, completion: @escaping (Result<[String: Any], Error>) -> Void) {
    queue.async { [weak self] in
      guard let self = self else { return }
      if self.syncing {
        // Not an error: the in-flight pass covers the same window, so there is nothing this
        // caller would learn by running a second one.
        DispatchQueue.main.async {
          completion(.success(["skipped": true, "reason": "a sync is already running"]))
        }
        return
      }
      self.syncing = true
      self.performSync(full: full) { result in
        self.queue.async { self.syncing = false }
        DispatchQueue.main.async { completion(result) }
      }
    }
  }

  private func performSync(
    full: Bool, completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    guard isAvailable else {
      completion(.failure(HealthBridgeError.unavailable))
      return
    }

    let now = Date()
    // A rolling window rather than HKAnchoredObjectQuery's strictly-new samples, which is the
    // deliberate choice here. Apple revises data after the fact — a night's sleep stages are
    // refined once the watch finishes processing, a workout's distance is backfilled — and an
    // anchor would never show those again, so run-far would keep a first draft forever. Since
    // the server's upserts are idempotent, re-sending costs nothing and picks up every
    // revision. The same reasoning as the Whoop sync's 1-day overlap, just a wider window
    // because Apple's revisions arrive later.
    let lookbackDays = full ? HealthKitReader.fullLookbackDays : 10
    let since = Calendar.current.date(byAdding: .day, value: -lookbackDays, to: now) ?? now

    var sleepSessions: [[String: Any]] = []
    var workouts: [[String: Any]] = []
    var readError: Error?

    let dispatch = DispatchGroup()

    dispatch.enter()
    HealthKitReader.sleepSessions(store: store, since: since, until: now) { result in
      switch result {
      case .success(let sessions): sleepSessions = sessions
      case .failure(let error): readError = error
      }
      dispatch.leave()
    }

    dispatch.enter()
    HealthKitReader.workouts(store: store, since: since, until: now) { result in
      switch result {
      case .success(let items): workouts = items
      case .failure(let error): readError = error
      }
      dispatch.leave()
    }

    dispatch.notify(queue: .main) { [weak self] in
      guard let self = self else { return }
      if let readError = readError {
        self.defaults.set(readError.localizedDescription, forKey: Keys.lastError)
        completion(.failure(readError))
        return
      }

      let read: [String: Any] = [
        "sleepSessions": sleepSessions.count,
        "workouts": workouts.count,
        "full": full,
      ]

      guard let baseUrl = self.defaults.string(forKey: Keys.apiBaseUrl),
        let token = Keychain.deviceToken()
      else {
        // Read fine, nowhere to send it. Reported rather than thrown: this is the ordinary
        // state of an app that has HealthKit permission but has not been connected to an
        // account yet.
        completion(.success(["read": read, "error": "not configured"]))
        return
      }

      // `coveredThrough` is the watermark the server's reconciliation coverage gate reads to
      // decide whether an absence of workouts means an absence of running. It is `now` only
      // because the read above genuinely examined everything up to now; claiming coverage over
      // a window this pass did not look at would have the server mark real sessions missed.
      let payload: [String: Any] = [
        "device": self.deviceInfo(),
        "coveredThrough": ISO8601.string(now),
        "sleepSessions": sleepSessions,
        "workouts": workouts,
      ]

      self.push(payload: payload, baseUrl: baseUrl, token: token) { result in
        switch result {
        case .success(let ingested):
          self.defaults.set(ISO8601.string(Date()), forKey: Keys.lastSyncedAt)
          self.defaults.removeObject(forKey: Keys.lastError)
          completion(.success(["read": read, "ingested": ingested]))
        case .failure(let error):
          self.defaults.set(error.localizedDescription, forKey: Keys.lastError)
          // Reported as a successful call with an error field rather than a thrown error: the
          // read worked, and the UI wants to show both halves. The next wake retries.
          completion(.success(["read": read, "error": error.localizedDescription]))
        }
      }
    }
  }

  private func deviceInfo() -> [String: Any] {
    var info: [String: Any] = [:]
    #if canImport(UIKit)
      info["model"] = UIDevice.current.model
      info["osVersion"] = UIDevice.current.systemVersion
    #endif
    if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String {
      info["appVersion"] = version
    }
    info["timeZone"] = defaults.string(forKey: Keys.timeZone) ?? TimeZone.current.identifier
    return info
  }

  private func push(
    payload: [String: Any],
    baseUrl: String,
    token: String,
    completion: @escaping (Result<[String: Any], Error>) -> Void
  ) {
    guard let url = URL(string: "\(baseUrl)/api/apple-health/ingest") else {
      completion(.failure(HealthBridgeError.badConfiguration))
      return
    }

    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.timeoutInterval = 60

    do {
      request.httpBody = try JSONSerialization.data(withJSONObject: payload)
    } catch {
      completion(.failure(error))
      return
    }

    URLSession.shared.dataTask(with: request) { data, response, error in
      if let error = error {
        completion(.failure(error))
        return
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0

      // 401 means this device's registration was revoked, and 402 that the account's
      // subscription lapsed. Both are permanent as far as the device is concerned — no amount
      // of retrying fixes either — so the token is discarded and background delivery stops
      // rather than the app waking forever to be refused.
      if status == 401 || status == 403 {
        HealthBridgeSync.shared.reset()
        completion(.failure(HealthBridgeError.deviceUnauthorized))
        return
      }
      if status == 402 {
        HealthBridgeSync.shared.setBackgroundDelivery(enabled: false)
        completion(.failure(HealthBridgeError.subscriptionRequired))
        return
      }
      guard (200..<300).contains(status) else {
        completion(.failure(HealthBridgeError.httpStatus(status)))
        return
      }

      let parsed =
        (try? JSONSerialization.jsonObject(with: data ?? Data())) as? [String: Any] ?? [:]
      completion(.success(parsed))
    }.resume()
  }
}

enum HealthBridgeError: LocalizedError {
  case unavailable
  case badConfiguration
  case deviceUnauthorized
  case subscriptionRequired
  case httpStatus(Int)

  var errorDescription: String? {
    switch self {
    case .unavailable:
      return "Apple Health isn't available on this device."
    case .badConfiguration:
      return "run-far isn't configured for Apple Health sync yet."
    case .deviceUnauthorized:
      return "This device is no longer authorized. Reconnect Apple Health in Settings."
    case .subscriptionRequired:
      return "Your run-far subscription is inactive, so syncing is paused."
    case .httpStatus(let status):
      return "run-far couldn't accept the health data (HTTP \(status))."
    }
  }
}

#if canImport(UIKit)
  import UIKit
#endif
