import Foundation
import HealthKit

/// Reads the Health store and assembles the payload the run-far API expects.
///
/// HealthKit's shape is nothing like the API's. Sleep is a stream of per-stage category
/// samples, one per stage transition, with no notion of a night; the nightly vitals are
/// separate quantity samples that happen to fall inside a sleep window. Only code running on
/// the device can see the whole store, so assembling sessions out of that stream is this
/// layer's job — the server deliberately does not try to re-associate samples by timestamp,
/// because it cannot see what it would be guessing about.
///
/// What the server *does* re-derive is every conclusion: which session is a nap, where cycles
/// begin, what the recovery score is. This file reports observations, not verdicts.
enum HealthKitReader {
  /// How far back a full (unanchored) read goes.
  ///
  /// 90 days matches the Whoop backfill, so a new athlete's first sync gives the engine the
  /// same amount of history either way — which matters because the derived recovery score needs
  /// a baseline before it will say anything at all.
  static let fullLookbackDays = 90

  /// Types run-far asks to read. Requested as one set so the athlete sees a single permission
  /// sheet rather than a sequence of them.
  static var readTypes: Set<HKObjectType> {
    var types: Set<HKObjectType> = [
      HKObjectType.categoryType(forIdentifier: .sleepAnalysis)!,
      HKObjectType.quantityType(forIdentifier: .heartRateVariabilitySDNN)!,
      HKObjectType.quantityType(forIdentifier: .restingHeartRate)!,
      HKObjectType.quantityType(forIdentifier: .respiratoryRate)!,
      HKObjectType.quantityType(forIdentifier: .oxygenSaturation)!,
      HKObjectType.quantityType(forIdentifier: .heartRate)!,
      HKObjectType.quantityType(forIdentifier: .activeEnergyBurned)!,
      HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning)!,
      HKObjectType.workoutType(),
    ]
    // Wrist temperature arrived in iOS 16 with Series 8; on anything older the type does not
    // exist and requesting it would fail the whole authorization request.
    if #available(iOS 16.0, *) {
      if let wristTemp = HKObjectType.quantityType(forIdentifier: .appleSleepingWristTemperature) {
        types.insert(wristTemp)
      }
    }
    return types
  }

  // MARK: - Sleep

  /// Assemble sleep sessions from the raw sample stream.
  ///
  /// A "session" is a run of samples separated by no more than `sessionGapMinutes` of nothing.
  /// The gap rule is what turns a stream of stage transitions into nights: Apple Watch records
  /// core/deep/REM/awake as adjacent samples through one night, so adjacency is the signal, and
  /// a long silence is the boundary.
  ///
  /// Deliberately does *not* decide what is a nap. The server re-derives that (one primary
  /// sleep per local day, longest wins, minimum duration) because it also has to hold for
  /// nights this batch does not contain, and because the snapshot's correctness depends on that
  /// classification being consistent across every batch rather than per-batch.
  static func sleepSessions(
    store: HKHealthStore,
    since: Date,
    until: Date,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    guard let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
      completion(.success([]))
      return
    }

    let predicate = HKQuery.predicateForSamples(withStart: since, end: until, options: [])
    let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
    let query = HKSampleQuery(
      sampleType: sleepType,
      predicate: predicate,
      limit: HKObjectQueryNoLimit,
      sortDescriptors: [sort]
    ) { _, samples, error in
      if let error = error {
        completion(.failure(error))
        return
      }
      let categorySamples = (samples as? [HKCategorySample]) ?? []
      let groups = groupIntoSessions(categorySamples)

      // Vitals are fetched per session, so a session with no readings (watch left off) is
      // reported with nulls rather than being dropped — the sleep duration is still worth
      // having, and the server's sleep-debt derivation needs the night to exist.
      let dispatch = DispatchGroup()
      var assembled = [[String: Any]?](repeating: nil, count: groups.count)

      for (index, group) in groups.enumerated() {
        dispatch.enter()
        assembleSession(store: store, samples: group) { session in
          assembled[index] = session
          dispatch.leave()
        }
      }

      dispatch.notify(queue: .main) {
        completion(.success(assembled.compactMap { $0 }))
      }
    }
    store.execute(query)
  }

  /// Longest silence that still counts as the same night. A trip to the bathroom leaves a gap
  /// of minutes; a nap the following afternoon leaves hours.
  private static let sessionGapMinutes: TimeInterval = 60 * 60

  private static func groupIntoSessions(_ samples: [HKCategorySample]) -> [[HKCategorySample]] {
    var sessions: [[HKCategorySample]] = []
    var current: [HKCategorySample] = []

    for sample in samples {
      guard let last = current.last else {
        current = [sample]
        continue
      }
      if sample.startDate.timeIntervalSince(last.endDate) > sessionGapMinutes {
        sessions.append(current)
        current = [sample]
      } else {
        current.append(sample)
      }
    }
    if !current.isEmpty { sessions.append(current) }
    return sessions
  }

  private static func assembleSession(
    store: HKHealthStore,
    samples: [HKCategorySample],
    completion: @escaping ([String: Any]?) -> Void
  ) {
    guard let first = samples.first, let last = samples.last else {
      completion(nil)
      return
    }
    let start = first.startDate
    let end = samples.map { $0.endDate }.max() ?? last.endDate

    var inBed: TimeInterval = 0
    var light: TimeInterval = 0
    var deep: TimeInterval = 0
    var rem: TimeInterval = 0
    var awake: TimeInterval = 0
    var unspecifiedAsleep: TimeInterval = 0

    for sample in samples {
      let duration = sample.endDate.timeIntervalSince(sample.startDate)
      guard let value = HKCategoryValueSleepAnalysis(rawValue: sample.value) else { continue }
      switch value {
      case .inBed:
        // inBed overlaps the asleep samples rather than sitting alongside them, so it is
        // accumulated separately and never added into the asleep total.
        inBed += duration
      case .awake:
        awake += duration
      case .asleepCore:
        light += duration
      case .asleepDeep:
        deep += duration
      case .asleepREM:
        rem += duration
      case .asleepUnspecified:
        // Pre-watchOS 9, and third-party sleep trackers: asleep with no stage breakdown. Kept
        // apart from the staged totals so the server can tell "no stages recorded" from
        // "zero minutes of deep sleep", which are very different claims.
        unspecifiedAsleep += duration
      @unknown default:
        // A stage added by a future iOS. Counting it as asleep-with-no-stage is the
        // conservative reading: the alternative silently shortens the night.
        unspecifiedAsleep += duration
      }
    }

    let stagedAsleep = light + deep + rem
    let asleep = stagedAsleep + unspecifiedAsleep
    let hasStages = stagedAsleep > 0

    var session: [String: Any] = [
      "externalId": first.uuid.uuidString,
      "startedAt": ISO8601.string(start),
      "endedAt": ISO8601.string(end),
      "asleepMin": asleep / 60,
    ]
    // Only report inBed when something actually recorded it: many watch-only sleepers have no
    // inBed samples, and a fabricated value would make sleep efficiency a lie rather than null.
    if inBed > 0 { session["inBedMin"] = inBed / 60 }
    if awake > 0 { session["awakeMin"] = awake / 60 }
    if hasStages {
      session["lightMin"] = light / 60
      session["deepMin"] = deep / 60
      session["remMin"] = rem / 60
    }

    // Vitals measured during (or just after) the night. Each is fetched independently and is
    // allowed to be absent.
    let dispatch = DispatchGroup()

    // HRV and resting HR are recorded around waking rather than throughout the night, and
    // Apple attributes them to a timestamp that can land slightly after the sleep sample ends.
    // The window is extended past `end` so the morning's reading is picked up; without the
    // extension the most important input to the recovery score is intermittently missing.
    let vitalsWindowEnd = end.addingTimeInterval(2 * 60 * 60)

    dispatch.enter()
    latestQuantity(
      store: store, identifier: .heartRateVariabilitySDNN, start: start, end: vitalsWindowEnd,
      unit: HKUnit.secondUnit(with: .milli)
    ) { value in
      if let value = value { session["hrvSdnnMs"] = value }
      dispatch.leave()
    }

    dispatch.enter()
    latestQuantity(
      store: store, identifier: .restingHeartRate, start: start, end: vitalsWindowEnd,
      unit: HKUnit.count().unitDivided(by: .minute())
    ) { value in
      if let value = value { session["restingHr"] = value }
      dispatch.leave()
    }

    dispatch.enter()
    averageQuantity(
      store: store, identifier: .respiratoryRate, start: start, end: end,
      unit: HKUnit.count().unitDivided(by: .minute())
    ) { value in
      if let value = value { session["respiratoryRate"] = value }
      dispatch.leave()
    }

    dispatch.enter()
    averageQuantity(
      store: store, identifier: .oxygenSaturation, start: start, end: end, unit: HKUnit.percent()
    ) { value in
      // HKUnit.percent() is a 0-1 fraction; the API wants a percentage.
      if let value = value { session["oxygenSaturationPct"] = value * 100 }
      dispatch.leave()
    }

    if #available(iOS 16.0, *) {
      dispatch.enter()
      averageQuantity(
        store: store, identifier: .appleSleepingWristTemperature, start: start,
        end: vitalsWindowEnd, unit: HKUnit.degreeCelsius()
      ) { value in
        if let value = value { session["wristTempC"] = value }
        dispatch.leave()
      }
    }

    dispatch.notify(queue: .main) { completion(session) }
  }

  // MARK: - Workouts

  static func workouts(
    store: HKHealthStore,
    since: Date,
    until: Date,
    completion: @escaping (Result<[[String: Any]], Error>) -> Void
  ) {
    let predicate = HKQuery.predicateForSamples(withStart: since, end: until, options: [])
    let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
    let query = HKSampleQuery(
      sampleType: HKObjectType.workoutType(),
      predicate: predicate,
      limit: HKObjectQueryNoLimit,
      sortDescriptors: [sort]
    ) { _, samples, error in
      if let error = error {
        completion(.failure(error))
        return
      }
      let workouts = (samples as? [HKWorkout]) ?? []
      completion(.success(workouts.map(describe)))
    }
    store.execute(query)
  }

  private static func describe(_ workout: HKWorkout) -> [String: Any] {
    var payload: [String: Any] = [
      "externalId": workout.uuid.uuidString,
      "activityType": ActivityTypeNames.name(for: workout.workoutActivityType),
      // HKMetadataKeyIndoorWorkout is what separates a treadmill run from a road run. It
      // matters beyond labelling: an indoor run with no distance is an expected shape, not a
      // recording failure, and the server classifies it as treadmill_running so it still
      // counts toward adherence.
      "indoor": (workout.metadata?[HKMetadataKeyIndoorWorkout] as? Bool) ?? false,
      "startedAt": ISO8601.string(workout.startDate),
      "endedAt": ISO8601.string(workout.endDate),
      // workout.duration excludes paused time, so it is not endDate - startDate. Sent as its
      // own field for exactly that reason.
      "durationMin": workout.duration / 60,
    ]

    if #available(iOS 16.0, *) {
      if let distance = workout.statistics(for: HKQuantityType(.distanceWalkingRunning))?
        .sumQuantity()?.doubleValue(for: .meter())
      {
        payload["distanceM"] = distance
      }
      if let energy = workout.statistics(for: HKQuantityType(.activeEnergyBurned))?
        .sumQuantity()?.doubleValue(for: .kilocalorie())
      {
        // Converted here rather than server-side so the server never has to guess which energy
        // unit it received. 1 kcal = 4.184 kJ.
        payload["activeEnergyKj"] = energy * 4.184
      }
      if let avgHr = workout.statistics(for: HKQuantityType(.heartRate))?
        .averageQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
      {
        payload["avgHr"] = avgHr
      }
      if let maxHr = workout.statistics(for: HKQuantityType(.heartRate))?
        .maximumQuantity()?.doubleValue(for: HKUnit.count().unitDivided(by: .minute()))
      {
        payload["maxHr"] = maxHr
      }
    } else {
      if let distance = workout.totalDistance?.doubleValue(for: .meter()) {
        payload["distanceM"] = distance
      }
      if let energy = workout.totalEnergyBurned?.doubleValue(for: .kilocalorie()) {
        payload["activeEnergyKj"] = energy * 4.184
      }
    }

    if let ascended = (workout.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity)?
      .doubleValue(for: .meter())
    {
      payload["elevationAscendedM"] = ascended
    }

    return payload
  }

  // MARK: - Quantity helpers

  /// The most recent reading in a window. Right for HRV and resting heart rate, which Apple
  /// records as a single figure per night rather than a series to average.
  private static func latestQuantity(
    store: HKHealthStore,
    identifier: HKQuantityTypeIdentifier,
    start: Date,
    end: Date,
    unit: HKUnit,
    completion: @escaping (Double?) -> Void
  ) {
    guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
      completion(nil)
      return
    }
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
    let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
    let query = HKSampleQuery(
      sampleType: type, predicate: predicate, limit: 1, sortDescriptors: [sort]
    ) { _, samples, _ in
      let value = (samples?.first as? HKQuantitySample)?.quantity.doubleValue(for: unit)
      DispatchQueue.main.async { completion(value) }
    }
    store.execute(query)
  }

  /// The mean over a window. Right for respiratory rate, SpO2 and wrist temperature, which are
  /// sampled repeatedly through the night and where any single reading is noisy.
  private static func averageQuantity(
    store: HKHealthStore,
    identifier: HKQuantityTypeIdentifier,
    start: Date,
    end: Date,
    unit: HKUnit,
    completion: @escaping (Double?) -> Void
  ) {
    guard let type = HKObjectType.quantityType(forIdentifier: identifier) else {
      completion(nil)
      return
    }
    let predicate = HKQuery.predicateForSamples(withStart: start, end: end, options: [])
    let query = HKStatisticsQuery(
      quantityType: type, quantitySamplePredicate: predicate, options: .discreteAverage
    ) { _, statistics, _ in
      let value = statistics?.averageQuantity()?.doubleValue(for: unit)
      DispatchQueue.main.async { completion(value) }
    }
    store.execute(query)
  }
}

/// HKWorkoutActivityType is an enum of integers with no name at runtime. The server maps these
/// names onto its own sport vocabulary (integrations/appleHealth/sports.ts), so what matters is
/// that they are stable and match what that mapping expects — an unrecognized one lands as an
/// activity with an odd label, which is a cosmetic problem, rather than being coerced into
/// something close, which would silently corrupt mileage and adherence.
enum ActivityTypeNames {
  static func name(for type: HKWorkoutActivityType) -> String {
    switch type {
    case .running: return "running"
    case .walking: return "walking"
    case .hiking: return "hiking"
    case .cycling: return "cycling"
    case .handCycling: return "handCycling"
    case .swimming: return "swimming"
    case .yoga: return "yoga"
    case .traditionalStrengthTraining: return "traditionalStrengthTraining"
    case .functionalStrengthTraining: return "functionalStrengthTraining"
    case .highIntensityIntervalTraining: return "highIntensityIntervalTraining"
    case .crossTraining: return "crossTraining"
    case .coreTraining: return "coreTraining"
    case .elliptical: return "elliptical"
    case .rowing: return "rowing"
    case .stairClimbing, .stairs: return "stairs"
    case .mixedCardio: return "mixedCardio"
    case .other: return "other"
    default:
      if #available(iOS 17.0, *), type == .cardioDance { return "cardioDance" }
      // Rather than dropping it: an unnamed activity still carries duration, energy and heart
      // rate, all of which count toward load.
      return "other"
    }
  }
}

enum ISO8601 {
  private static let formatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    // Fractional seconds so the string satisfies the API's `z.string().datetime()`, which
    // accepts both but is stricter about the overall shape.
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    f.timeZone = TimeZone(secondsFromGMT: 0)
    return f
  }()

  static func string(_ date: Date) -> String {
    formatter.string(from: date)
  }
}
