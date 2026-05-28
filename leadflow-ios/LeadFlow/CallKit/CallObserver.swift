import Foundation
import CallKit

// MARK: - Call Observer

final class CallObserver: NSObject, ObservableObject, CXCallObserverDelegate {
    static let shared = CallObserver()
    private let observer = CXCallObserver()
    private var activeCalls: [UUID: CallRecord] = [:]

    private override init() {
        super.init()
        observer.setDelegate(self, queue: .main)
    }

    func callObserver(_ callObserver: CXCallObserver, callChanged call: CXCall) {
        guard LocalStorageService.shared.recordingEnabled else { return }

        if call.hasConnected && !call.hasEnded {
            handleCallConnected(call)
        } else if call.hasEnded {
            handleCallEnded(call)
        }
    }

    private func handleCallConnected(_ call: CXCall) {
        guard activeCalls[call.uuid] == nil else { return }

        let record = CallRecord(
            uuid: call.uuid,
            isOutgoing: call.isOutgoing,
            startTime: Date()
        )
        activeCalls[call.uuid] = record

        let direction: String = call.isOutgoing ? "outbound" : "inbound"
        print("[CallObserver] Call connected — UUID: \(call.uuid), direction: \(direction)")

        RecordingManager.shared.startRecording(for: call.uuid, direction: direction)
    }

    private func handleCallEnded(_ call: CXCall) {
        guard let record = activeCalls[call.uuid] else { return }
        activeCalls.removeValue(forKey: call.uuid)

        let duration = Int(Date().timeIntervalSince(record.startTime))
        let direction = record.isOutgoing ? "outbound" : "inbound"
        print("[CallObserver] Call ended — UUID: \(call.uuid), duration: \(duration)s")

        RecordingManager.shared.stopRecording(for: call.uuid, duration: duration, direction: direction)
    }
}

// MARK: - Call Record

private struct CallRecord {
    let uuid: UUID
    let isOutgoing: Bool
    let startTime: Date
}
