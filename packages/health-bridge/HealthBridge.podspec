require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name = 'HealthBridge'
  s.version = package['version']
  s.summary = 'Reads Apple Health (HealthKit) on-device and pushes it to the run-far API.'
  s.license = 'UNLICENSED'
  s.homepage = 'https://github.com/TeddyGrace/run-far'
  s.author = 'run-far'
  s.source = { :git => 'https://github.com/TeddyGrace/run-far.git', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m,c,cc,mm,cpp}'
  # Capacitor 6 requires iOS 13; HealthKit types this plugin reads conditionally (wrist
  # temperature) are gated at their own availability, not raised here — an iPhone without a
  # Series 8 should still install and sync everything else.
  s.ios.deployment_target = '13.0'
  s.dependency 'Capacitor'
  s.frameworks = 'HealthKit'
  s.swift_version = '5.1'
end
