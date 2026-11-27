import AVFoundation
import Flutter
import ImageIO
import UniformTypeIdentifiers
import VideoToolbox

// SelfPhotos Storage saver: shrinks a video or photo before it's uploaded.
class StorageSaverPlugin: ImmichPlugin, FlutterPlugin {
  static let name = "StorageSaverPlugin"

  private static let maxSizeRatio = 0.8
  private static let maxFrameRate: Float = 60
  private static let maxShortSide = 1080
  private static let maxPixels = 16_000_000
  private static let photoQuality = 0.85
  private static let timeLimitExtra: TimeInterval = 60

  private static let worker = DispatchQueue(label: "selfphotos.storage-saver")

  private struct State {
    var cancelledRuns = Set<Int64>()
    var running: (run: Int64, export: VideoExport)?
    var detached = false
  }

  private let state = Mutex(State())

  static func register(with registrar: any FlutterPluginRegistrar) {
    let instance = StorageSaverPlugin()
    let channel = FlutterMethodChannel(name: "selfphotos/storage_saver", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(instance, channel: channel)
    registrar.publish(instance)
  }

  func detachFromEngine(for registrar: any FlutterPluginRegistrar) {
    detachFromEngine()
  }

  override func detachFromEngine() {
    super.detachFromEngine()
    state.withLock { state in
      state.detached = true
      state.running?.export.cancel()
    }
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    switch call.method {
    case "shrink":
      guard let run = (args["runId"] as? NSNumber)?.int64Value,
            let input = args["inputPath"] as? String,
            let output = args["outputPath"] as? String,
            let kind = args["kind"] as? String
      else {
        result(FlutterError(code: "failed", message: "Missing arguments", details: nil))
        return
      }
      let videoBitrate = (args["videoBitrate"] as? NSNumber)?.intValue
      let shrinkHdr = args["shrinkHdr"] as? Bool ?? false
      Self.worker.async {
        let value: Any
        do {
          value = self.isCancelled(run)
            ? Self.notShrunk("cancelled")
            : try self.shrink(
              run: run,
              input: URL(fileURLWithPath: input),
              output: URL(fileURLWithPath: output),
              kind: kind,
              videoBitrate: videoBitrate,
              shrinkHdr: shrinkHdr
            )
        } catch {
          print("StorageSaver: couldn't shrink: \(error)")
          value = FlutterError(code: "failed", message: "\(error)", details: nil)
        }
        DispatchQueue.main.async { self.completeWhenActive(for: result, with: value) }
      }
    case "cancel":
      guard let run = (args["runId"] as? NSNumber)?.int64Value else {
        result(FlutterError(code: "failed", message: "Missing arguments", details: nil))
        return
      }
      cancel(run)
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func isCancelled(_ run: Int64) -> Bool {
    state.withLock { $0.detached || $0.cancelledRuns.contains(run) }
  }

  // Stops [run]'s running shrink and skips the ones it already asked for.
  private func cancel(_ run: Int64) {
    state.withLock { state in
      state.cancelledRuns.insert(run)
      if let running = state.running, running.run == run {
        running.export.cancel()
      }
    }
  }

  private func shrink(run: Int64, input: URL, output: URL, kind: String, videoBitrate: Int?, shrinkHdr: Bool) throws -> [String: Any] {
    let reason: String?
    switch kind {
    case "video":
      guard let videoBitrate else { throw StorageSaverError("No video bitrate") }
      reason = try shrinkVideo(run: run, input: input, output: output, bitrate: videoBitrate, shrinkHdr: shrinkHdr)
    case "photo":
      reason = try autoreleasepool { try shrinkPhoto(input: input, output: output) }
    default:
      throw StorageSaverError("Unknown kind \(kind)")
    }
    if let reason {
      try? FileManager.default.removeItem(at: output)
      return Self.notShrunk(reason)
    }
    if Double(try fileSize(output)) > Double(try fileSize(input)) * Self.maxSizeRatio {
      try? FileManager.default.removeItem(at: output)
      return Self.notShrunk("notSmaller")
    }
    return ["shrunk": true]
  }

  // Returns why the video is kept as it is, or nil once [output] is written.
  private func shrinkVideo(run: Int64, input: URL, output: URL, bitrate: Int, shrinkHdr: Bool) throws -> String? {
    let asset = AVURLAsset(url: input)
    guard let track = asset.tracks(withMediaType: .video).first else { throw StorageSaverError("No video track") }
    let facts = VideoFacts(asset: asset, track: track, fileSize: try fileSize(input))
    if facts.hdr && !shrinkHdr { return "hdr" }
    if facts.frameRate > Self.maxFrameRate { return "frameRate" }
    let resize = facts.shortSide > Self.maxShortSide
    if !resize && Double(facts.bitrate) <= Double(bitrate) / Self.maxSizeRatio { return "alreadySmall" }

    let export = VideoExport(
      asset: asset,
      track: track,
      output: output,
      bitrate: bitrate,
      size: resize ? facts.scaled(shortSide: Self.maxShortSide) : facts.size,
      frameRate: facts.frameRate,
      hdr: facts.hdr
    )
    state.withLock { $0.running = (run, export) }
    defer { state.withLock { $0.running = nil } }
    if isCancelled(run) { export.cancel() }
    return export.run(timeLimit: facts.duration * 2 + Self.timeLimitExtra)
  }

  // Returns why the photo is kept as it is, or nil once [output] is written.
  private func shrinkPhoto(input: URL, output: URL) throws -> String? {
    guard let source = CGImageSourceCreateWithURL(input as CFURL, nil),
          let type = CGImageSourceGetType(source)
    else { return "unreadable" }
    guard type == UTType.jpeg.identifier as CFString || type == UTType.heic.identifier as CFString else {
      return "notJpegOrHeic"
    }
    if let reason = PhotoFacts(source: source).skipReason() { return reason }
    guard var properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int
    else { return "unreadable" }

    let image: CGImage?
    let pixels = width * height
    if pixels > Self.maxPixels {
      let scale = (Double(Self.maxPixels) / Double(pixels)).squareRoot()
      let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: false,
        kCGImageSourceShouldCacheImmediately: true,
        kCGImageSourceThumbnailMaxPixelSize: Int((Double(max(width, height)) * scale).rounded(.down)),
      ]
      image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    } else {
      image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    }
    guard let image else { return "unreadable" }

    guard let destination = CGImageDestinationCreateWithURL(output as CFURL, type, 1, nil) else {
      throw StorageSaverError("Couldn't create the photo")
    }
    properties[kCGImageDestinationLossyCompressionQuality] = Self.photoQuality
    properties[kCGImagePropertyPixelWidth] = image.width
    properties[kCGImagePropertyPixelHeight] = image.height
    if var exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] {
      exif[kCGImagePropertyExifPixelXDimension] = image.width
      exif[kCGImagePropertyExifPixelYDimension] = image.height
      properties[kCGImagePropertyExifDictionary] = exif
    }
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw StorageSaverError("Couldn't encode the photo") }
    return nil
  }

  private func fileSize(_ url: URL) throws -> Int64 {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.size] as? NSNumber)?.int64Value ?? 0
  }

  private static func notShrunk(_ reason: String) -> [String: Any] {
    ["shrunk": false, "reason": reason]
  }
}

private struct StorageSaverError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

// The facts that decide whether a video is shrunk.
private struct VideoFacts {
  let size: CGSize
  let frameRate: Float
  let hdr: Bool
  let bitrate: Int64
  let duration: TimeInterval

  var shortSide: Int { Int(min(size.width, size.height)) }

  init(asset: AVURLAsset, track: AVAssetTrack, fileSize: Int64) {
    size = track.naturalSize
    frameRate = track.nominalFrameRate
    let format = (track.formatDescriptions as! [CMFormatDescription]).first
    let transfer = format.flatMap {
      CMFormatDescriptionGetExtension($0, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String
    }
    hdr = track.hasMediaCharacteristic(.containsHDRVideo)
      || transfer == kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String
      || transfer == kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String
    let seconds = CMTimeGetSeconds(asset.duration)
    duration = seconds.isFinite ? seconds : 0
    bitrate = duration > 0 ? Int64(Double(fileSize) * 8 / duration) : Int64.max
  }

  // The size with its short side made [shortSide], both sides even.
  func scaled(shortSide: Int) -> CGSize {
    let scale = Double(shortSide) / Double(min(size.width, size.height))
    return CGSize(width: Self.even(size.width * scale), height: Self.even(size.height * scale))
  }

  private static func even(_ value: Double) -> Double {
    (value / 2).rounded() * 2
  }
}

// The facts that keep a photo full size.
private struct PhotoFacts {
  let source: CGImageSource

  func skipReason() -> String? {
    if hasAuxiliaryData(kCGImageAuxiliaryDataTypeHDRGainMap) { return "gainMap" }
    if #available(iOS 18, *), hasAuxiliaryData(kCGImageAuxiliaryDataTypeISOGainMap) { return "gainMap" }
    let xmp = xmpText()
    if xmp.contains("hdrgm") { return "gainMap" }
    if xmp.contains("MotionPhoto") || xmp.contains("MicroVideo") { return "motionPhoto" }
    if CGImageSourceGetCount(source) > 1
      || hasAuxiliaryData(kCGImageAuxiliaryDataTypeDisparity)
      || hasAuxiliaryData(kCGImageAuxiliaryDataTypeDepth)
      || hasAuxiliaryData(kCGImageAuxiliaryDataTypePortraitEffectsMatte)
      || ["GDepth", "GImage", "Container:Directory"].contains(where: { xmp.contains($0) })
    {
      return "depth"
    }
    return nil
  }

  private func hasAuxiliaryData(_ type: CFString) -> Bool {
    CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, type) != nil
  }

  private func xmpText() -> String {
    guard let metadata = CGImageSourceCopyMetadataAtIndex(source, 0, nil),
          let data = CGImageMetadataCreateXMPData(metadata, nil)
    else { return "" }
    return String(decoding: data as Data, as: UTF8.self)
  }
}

// One video, re-encoded as HEVC at [bitrate] and [size], with its audio, rotation, date and place kept.
private final class VideoExport {
  private let asset: AVURLAsset
  private let track: AVAssetTrack
  private let output: URL
  private let bitrate: Int
  private let size: CGSize
  private let frameRate: Float
  private let hdr: Bool
  private let done = DispatchSemaphore(value: 0)

  private struct State {
    var finished = false
    var failure: String?
    var reader: AVAssetReader?
  }

  private let state = Mutex(State())

  init(asset: AVURLAsset, track: AVAssetTrack, output: URL, bitrate: Int, size: CGSize, frameRate: Float, hdr: Bool) {
    self.asset = asset
    self.track = track
    self.output = output
    self.bitrate = bitrate
    self.size = size
    self.frameRate = frameRate
    self.hdr = hdr
  }

  // Returns nil once [output] is written within [timeLimit] seconds, or why it wasn't.
  func run(timeLimit: TimeInterval) -> String? {
    do {
      try start()
    } catch {
      print("StorageSaver: couldn't start shrinking a video: \(error)")
      finish("failed: \(error)")
    }
    if done.wait(timeout: .now() + timeLimit) == .timedOut {
      finish("failed: timedOut")
      state.withLock { $0.reader }?.cancelReading()
      return "failed: timedOut"
    }
    return state.withLock { $0.failure }
  }

  func cancel() {
    finish("cancelled")
    state.withLock { $0.reader }?.cancelReading()
  }

  private func start() throws {
    if state.withLock({ $0.finished }) { return }
    try? FileManager.default.removeItem(at: output)
    let reader = try AVAssetReader(asset: asset)
    let writer = try AVAssetWriter(outputURL: output, fileType: output.pathExtension.lowercased() == "mp4" ? .mp4 : .mov)
    writer.metadata = metadata()

    let videoOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [
      kCVPixelBufferPixelFormatTypeKey as String: hdr
        ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
        : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
    ])
    videoOutput.alwaysCopiesSampleData = false
    let videoSettings = videoSettings()
    guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else {
      throw StorageSaverError("Video settings not supported")
    }
    let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
    videoInput.transform = track.preferredTransform
    videoInput.expectsMediaDataInRealTime = false
    let pairs = try [(videoOutput, videoInput)] + audioPair(writer: writer)

    for (readerOutput, writerInput) in pairs {
      guard reader.canAdd(readerOutput), writer.canAdd(writerInput) else { throw StorageSaverError("Can't add a track") }
      reader.add(readerOutput)
      writer.add(writerInput)
    }

    let cancelled = state.withLock { state in
      state.reader = reader
      return state.finished
    }
    if cancelled { return }
    guard reader.startReading() else { throw reader.error ?? StorageSaverError("Couldn't read the video") }
    guard writer.startWriting() else { throw writer.error ?? StorageSaverError("Couldn't write the video") }
    writer.startSession(atSourceTime: .zero)

    let group = DispatchGroup()
    for (index, (readerOutput, writerInput)) in pairs.enumerated() {
      copy(
        from: readerOutput,
        to: writerInput,
        of: writer,
        on: DispatchQueue(label: "selfphotos.storage-saver.track\(index)"),
        group: group
      )
    }
    group.notify(queue: DispatchQueue.global(qos: .utility)) {
      if self.state.withLock({ $0.finished }) {
        writer.cancelWriting()
      } else if reader.status == .failed {
        writer.cancelWriting()
        self.finish("failed: \(reader.error.map { "\($0)" } ?? "reader")")
      } else {
        writer.finishWriting {
          self.finish(writer.status == .completed ? nil : "failed: \(writer.error.map { "\($0)" } ?? "writer")")
        }
      }
    }
  }

  private func videoSettings() -> [String: Any] {
    var compression: [String: Any] = [AVVideoAverageBitRateKey: bitrate]
    if frameRate > 0 {
      compression[AVVideoExpectedSourceFrameRateKey] = frameRate
    }
    if hdr {
      compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main10_AutoLevel as String
    }
    var settings: [String: Any] = [
      AVVideoCodecKey: AVVideoCodecType.hevc,
      AVVideoWidthKey: Int(size.width),
      AVVideoHeightKey: Int(size.height),
      AVVideoScalingModeKey: AVVideoScalingModeResizeAspectFill,
      AVVideoCompressionPropertiesKey: compression,
    ]
    if let colors = colorProperties() {
      settings[AVVideoColorPropertiesKey] = colors
    }
    return settings
  }

  // The source's colour primaries, transfer function and matrix, when it names all three.
  private func colorProperties() -> [String: Any]? {
    guard let format = (track.formatDescriptions as! [CMFormatDescription]).first,
          let primaries = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_ColorPrimaries) as? String,
          let transfer = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String,
          let matrix = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_YCbCrMatrix) as? String
    else { return nil }
    return [
      AVVideoColorPrimariesKey: primaries,
      AVVideoTransferFunctionKey: transfer,
      AVVideoYCbCrMatrixKey: matrix,
    ]
  }

  private func audioPair(writer: AVAssetWriter) throws -> [(AVAssetReaderOutput, AVAssetWriterInput)] {
    guard let audio = asset.tracks(withMediaType: .audio).first else { return [] }
    let hint = (audio.formatDescriptions as! [CMFormatDescription]).first
    let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: hint)
    input.expectsMediaDataInRealTime = false
    return [(AVAssetReaderTrackOutput(track: audio, outputSettings: nil), input)]
  }

  // The source's QuickTime metadata and user data, with its creation date added when only the movie header has it.
  private func metadata() -> [AVMetadataItem] {
    var items = asset.metadata(forFormat: .quickTimeMetadata) + asset.metadata(forFormat: .quickTimeUserData)
    if !items.contains(where: { $0.identifier == .quickTimeMetadataCreationDate }),
       let date = asset.creationDate?.dateValue
    {
      let item = AVMutableMetadataItem()
      item.identifier = .quickTimeMetadataCreationDate
      item.value = ISO8601DateFormatter().string(from: date) as NSString
      items.append(item)
    }
    return items
  }

  private func copy(
    from readerOutput: AVAssetReaderOutput,
    to writerInput: AVAssetWriterInput,
    of writer: AVAssetWriter,
    on queue: DispatchQueue,
    group: DispatchGroup
  ) {
    group.enter()
    var copied = false
    writerInput.requestMediaDataWhenReady(on: queue) {
      while !copied && writerInput.isReadyForMoreMediaData {
        if self.state.withLock({ $0.finished }) {
          copied = true
        } else if let buffer = readerOutput.copyNextSampleBuffer() {
          if !writerInput.append(buffer) {
            self.finish("failed: \(writer.error.map { "\($0)" } ?? "writer")")
            self.state.withLock { $0.reader }?.cancelReading()
            copied = true
          }
        } else {
          copied = true
        }
        if copied {
          writerInput.markAsFinished()
          group.leave()
        }
      }
    }
  }

  private func finish(_ failure: String?) {
    let first = state.withLock { state in
      if state.finished { return false }
      state.finished = true
      state.failure = failure
      return true
    }
    if first { done.signal() }
  }
}
