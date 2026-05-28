import Foundation
import AVFoundation

// MARK: - Recording Manager
// NOTE: Standard iOS APIs cannot capture both sides of a PSTN phone call.
// CXCallObserver detects calls but does not provide access to call audio.
// This implementation records the device microphone (business owner's voice).
// Speakerphone calls will also capture the other party's audio through the mic.
// Full bidirectional recording requires the app to be the telephony provider via
// CXProvider, which necessitates routing calls through a VoIP service.

final class RecordingManager: NSObject, ObservableObject, AVAudioRecorderDelegate {
    static let shared = RecordingManager()

    private var activeRecordings: [UUID: ActiveRecording] = [:]
    private var disclosurePlayer: AVAudioPlayer?
    private let disclosurePlayedKey = "disclosurePlayed_"

    private override init() { super.init() }

    // MARK: Start Recording

    func startRecording(for callUUID: UUID, direction: String) {
        guard LocalStorageService.shared.recordingEnabled else { return }

        let outputURL = LocalStorageService.shared.temporaryAudioURL()
        let recording = ActiveRecording(url: outputURL, direction: direction, startTime: Date())
        activeRecordings[callUUID] = recording

        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            self?.playDisclosureAndRecord(callUUID: callUUID, outputURL: outputURL)
        }
    }

    private func playDisclosureAndRecord(callUUID: UUID, outputURL: URL) {
        configureAudioSession()
        playDisclosure()

        // Brief delay to let disclosure finish playing (~3 seconds)
        Thread.sleep(forTimeInterval: 3.5)

        beginAudioRecording(callUUID: callUUID, outputURL: outputURL)
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // Use playAndRecord so we can both play the disclosure and record
            // .defaultToSpeaker makes the disclosure audible in the room
            try session.setCategory(
                .playAndRecord,
                mode: .voiceChat,
                options: [.defaultToSpeaker, .allowBluetooth, .allowBluetoothA2DP, .mixWithOthers]
            )
            try session.setActive(true)
            print("[RecordingManager] Audio session configured")
        } catch {
            print("[RecordingManager] Audio session error: \(error)")
        }
    }

    private func playDisclosure() {
        guard let disclosureURL = Bundle.main.url(forResource: "disclosure", withExtension: "m4a") else {
            print("[RecordingManager] disclosure.m4a not found in bundle")
            return
        }
        do {
            disclosurePlayer = try AVAudioPlayer(contentsOf: disclosureURL)
            disclosurePlayer?.play()
            print("[RecordingManager] Playing disclosure audio")
        } catch {
            print("[RecordingManager] Failed to play disclosure: \(error)")
        }
    }

    private func beginAudioRecording(callUUID: UUID, outputURL: URL) {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 44100.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
            AVEncoderBitRateKey: 64000,
        ]

        do {
            let recorder = try AVAudioRecorder(url: outputURL, settings: settings)
            recorder.delegate = self
            recorder.record()
            activeRecordings[callUUID]?.recorder = recorder
            print("[RecordingManager] Recording started: \(outputURL.lastPathComponent)")
        } catch {
            print("[RecordingManager] Failed to start recording: \(error)")
            activeRecordings.removeValue(forKey: callUUID)
        }
    }

    // MARK: Stop Recording

    func stopRecording(for callUUID: UUID, duration: Int, direction: String) {
        guard var recording = activeRecordings[callUUID] else {
            print("[RecordingManager] No active recording for UUID \(callUUID)")
            return
        }

        recording.recorder?.stop()
        activeRecordings.removeValue(forKey: callUUID)

        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            print("[RecordingManager] Failed to deactivate audio session: \(error)")
        }

        let url = recording.url
        guard FileManager.default.fileExists(atPath: url.path) else {
            print("[RecordingManager] Recording file not found: \(url.path)")
            return
        }

        let fileSize = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        guard fileSize > 1000 else {
            print("[RecordingManager] Recording too small (\(fileSize) bytes) — discarding")
            LocalStorageService.shared.deleteFile(at: url)
            return
        }

        print("[RecordingManager] Recording complete: \(url.lastPathComponent), size: \(fileSize) bytes")
        uploadRecording(url: url, duration: duration, direction: direction)
    }

    // MARK: Upload

    private func uploadRecording(url: URL, duration: Int, direction: String) {
        let storage = LocalStorageService.shared
        let timestamp = ISO8601DateFormatter().string(from: Date())

        Task {
            do {
                _ = try await APIService.shared.uploadRecording(
                    audioURL: url,
                    callerNumber: nil,
                    callDirection: direction,
                    callDuration: duration,
                    timestamp: timestamp,
                    vertical: storage.selectedVertical.rawValue,
                    capturedBy: storage.userName.isEmpty ? nil : storage.userName
                )
                storage.deleteFile(at: url)
                print("[RecordingManager] Upload successful")
            } catch {
                print("[RecordingManager] Upload failed: \(error.localizedDescription) — queuing for retry")
                queueForRetry(url: url, duration: duration, direction: direction, timestamp: timestamp)
            }
        }
    }

    private func queueForRetry(url: URL, duration: Int, direction: String, timestamp: String) {
        let storage = LocalStorageService.shared
        let upload = PendingUpload(
            id: UUID().uuidString,
            audioPath: url.path,
            callerNumber: nil,
            callDirection: direction,
            callDuration: duration,
            timestamp: timestamp,
            vertical: storage.selectedVertical.rawValue,
            retryCount: 0,
            capturedBy: storage.userName.isEmpty ? nil : storage.userName
        )
        storage.addPendingUpload(upload)
    }

    // MARK: Retry Pending Uploads

    func retryPendingUploads() {
        let storage = LocalStorageService.shared
        let pending = storage.pendingUploads.filter { $0.retryCount < 3 }
        guard !pending.isEmpty else { return }

        print("[RecordingManager] Retrying \(pending.count) pending upload(s)")

        for upload in pending {
            let fileURL = URL(fileURLWithPath: upload.audioPath)
            guard FileManager.default.fileExists(atPath: upload.audioPath) else {
                storage.removePendingUpload(id: upload.id)
                continue
            }

            Task {
                do {
                    _ = try await APIService.shared.uploadRecording(
                        audioURL: fileURL,
                        callerNumber: upload.callerNumber,
                        callDirection: upload.callDirection,
                        callDuration: upload.callDuration,
                        timestamp: upload.timestamp,
                        vertical: upload.vertical,
                        capturedBy: upload.capturedBy
                    )
                    storage.removePendingUpload(id: upload.id)
                    storage.deleteFile(at: fileURL)
                    print("[RecordingManager] Retry upload \(upload.id) succeeded")
                } catch {
                    storage.incrementRetry(id: upload.id)
                    print("[RecordingManager] Retry upload \(upload.id) failed (attempt \(upload.retryCount + 1)): \(error.localizedDescription)")
                }
            }
        }

        // Remove entries that have exhausted retries
        storage.pendingUploads = storage.pendingUploads.filter { upload in
            if upload.retryCount >= 3 {
                storage.deleteFile(at: URL(fileURLWithPath: upload.audioPath))
                return false
            }
            return true
        }
    }

    // MARK: AVAudioRecorderDelegate

    func audioRecorderDidFinishRecording(_ recorder: AVAudioRecorder, successfully flag: Bool) {
        if !flag { print("[RecordingManager] Recording finished unsuccessfully") }
    }

    func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        if let error { print("[RecordingManager] Encode error: \(error)") }
    }
}

// MARK: - Active Recording

private class ActiveRecording {
    let url: URL
    let direction: String
    let startTime: Date
    var recorder: AVAudioRecorder?

    init(url: URL, direction: String, startTime: Date) {
        self.url = url
        self.direction = direction
        self.startTime = startTime
    }
}
