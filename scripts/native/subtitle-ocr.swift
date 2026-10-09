import Foundation
import Vision

struct TextLine: Codable {
    let text: String
    let confidence: Float
    let left: Double
    let top: Double
    let right: Double
    let bottom: Double
}

do {
    guard CommandLine.arguments.count == 2 else { throw NSError(domain: "subtitle-ocr", code: 1) }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
    let lines = (request.results ?? []).prefix(200).compactMap { result -> TextLine? in
        guard let candidate = result.topCandidates(1).first else { return nil }
        let box = result.boundingBox
        return TextLine(text: candidate.string, confidence: candidate.confidence,
                        left: box.minX, top: 1 - box.maxY, right: box.maxX, bottom: 1 - box.minY)
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(lines))
} catch {
    FileHandle.standardError.write(Data("Local subtitle OCR failed: \(error)\n".utf8))
    exit(1)
}
