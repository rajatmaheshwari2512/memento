// SelfPhotos Adjust: the iOS side of saving a full-size copy (channel selfphotos/adjust_image).
import Flutter
import ImageIO
import UniformTypeIdentifiers
import os

class AdjustImagePlugin: ImmichPlugin, FlutterPlugin {
  static let name = "AdjustImagePlugin"

  private let queue = DispatchQueue(label: "AdjustImage", qos: .userInitiated)
  private var source: AdjustSource?
  private var output: AdjustOutput?

  static func register(with registrar: any FlutterPluginRegistrar) {
    let instance = AdjustImagePlugin()
    let channel = FlutterMethodChannel(name: "selfphotos/adjust_image", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(instance, channel: channel)
    registrar.publish(instance)
  }

  func detachFromEngine(for registrar: any FlutterPluginRegistrar) {
    super.detachFromEngine()
    queue.async { self.release() }
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    queue.async {
      let value: Any?
      do {
        switch call.method {
        case "open":
          value = try self.open(path: Self.argument(call, "path"))
        case "read":
          value = try self.read(Self.rect(call))
        case "createOutput":
          try self.createOutput(width: Self.argument(call, "width"), height: Self.argument(call, "height"))
          value = nil
        case "write":
          try self.write(Self.rect(call), pixels: Self.argument(call, "pixels"))
          value = nil
        case "encode":
          value = try self.encode(path: Self.argument(call, "path"), png: Self.argument(call, "png"), quality: Self.argument(call, "quality"))
        case "close":
          self.release()
          value = nil
        default:
          value = FlutterMethodNotImplemented
        }
      } catch AdjustImageError.tooLarge {
        self.release()
        value = FlutterError(code: "too-large", message: "Not enough memory for a photo this large.", details: nil)
      } catch AdjustImageError.unreadable(let message) {
        value = FlutterError(code: "unreadable", message: message, details: nil)
      } catch AdjustImageError.failed(let message) {
        value = FlutterError(code: "failed", message: message, details: nil)
      } catch {
        value = FlutterError(code: "failed", message: "\(error)", details: nil)
      }
      DispatchQueue.main.async { self.completeWhenActive(for: result, with: value) }
    }
  }

  private static func argument<T>(_ call: FlutterMethodCall, _ key: String) throws -> T {
    guard let value = (call.arguments as? [String: Any])?[key] as? T else {
      throw AdjustImageError.failed("Missing argument \(key)")
    }
    return value
  }

  private static func rect(_ call: FlutterMethodCall) throws -> CGRect {
    let x: Int = try argument(call, "x")
    let y: Int = try argument(call, "y")
    let width: Int = try argument(call, "width")
    let height: Int = try argument(call, "height")
    return CGRect(x: x, y: y, width: width, height: height)
  }

  private func open(path: String) throws -> [String: Int] {
    release()
    let opened = try AdjustSource(path: path)
    source = opened
    return ["width": opened.width, "height": opened.height]
  }

  private func read(_ rect: CGRect) throws -> FlutterStandardTypedData {
    guard let source else { throw AdjustImageError.failed("No photo open") }
    return FlutterStandardTypedData(bytes: try source.read(rect))
  }

  private func createOutput(width: Int, height: Int) throws {
    output = nil
    let available = os_proc_available_memory()
    if available > 0 && width * height * 4 > available {
      throw AdjustImageError.tooLarge
    }
    output = try AdjustOutput(width: width, height: height)
  }

  private func write(_ rect: CGRect, pixels: FlutterStandardTypedData) throws {
    guard let output else { throw AdjustImageError.failed("No output") }
    try output.write(rect, pixels: pixels.data)
  }

  private func encode(path: String, png: Bool, quality: Int) throws -> Int64 {
    guard let output else { throw AdjustImageError.failed("No output") }
    return try output.encode(path: path, png: png, quality: quality)
  }

  private func release() {
    source = nil
    output = nil
  }
}

enum AdjustImageError: Error {
  case tooLarge
  case unreadable(String)
  case failed(String)
}

private enum AdjustPixels {
  static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!
  static let rgba = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
  static let rgbx = CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue
}

// The photo at a path, read upright in parts: RGBA bytes, premultiplied, sRGB.
final class AdjustSource {
  let width: Int
  let height: Int
  private let image: CGImage
  private let toUpright: CGAffineTransform
  private let toRaw: CGAffineTransform

  init(path: String) throws {
    let options: [NSString: Any] = [kCGImageSourceShouldCache: false]
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, options as CFDictionary)
    else {
      throw AdjustImageError.unreadable("This photo's format can't be read here")
    }
    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [NSString: Any]
    let exif = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    let orientation = Self.orientationMatrix(CGImagePropertyOrientation(rawValue: exif) ?? .up)
    let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height).applying(orientation)
    self.image = image
    toUpright = orientation.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
    toRaw = toUpright.inverted()
    width = Int(bounds.width.rounded())
    height = Int(bounds.height.rounded())
  }

  // The upright part `rect`.
  func read(_ rect: CGRect) throws -> Data {
    let mapped = rect.applying(toRaw)
    let raw = CGRect(
      x: mapped.minX.rounded(),
      y: mapped.minY.rounded(),
      width: mapped.width.rounded(),
      height: mapped.height.rounded()
    )
    guard rect.width > 0, rect.height > 0,
          CGRect(x: 0, y: 0, width: image.width, height: image.height).contains(raw)
    else {
      throw AdjustImageError.failed("The part is outside the photo")
    }
    guard let part = image.cropping(to: raw), part.width == Int(raw.width), part.height == Int(raw.height) else {
      throw AdjustImageError.unreadable("Couldn't read part of the photo")
    }

    let width = Int(rect.width)
    let height = Int(rect.height)
    // Top-left pixel coordinates of the raw part, to top-left pixel coordinates of the upright tile.
    let toTile = CGAffineTransform(translationX: raw.minX, y: raw.minY)
      .concatenating(toUpright)
      .concatenating(CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
    let fromImage = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: CGFloat(part.height))
    let toContext = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: CGFloat(height))

    var pixels = Data(count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer in
      guard let context = CGContext(
        data: buffer.baseAddress,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: AdjustPixels.sRGB,
        bitmapInfo: AdjustPixels.rgba
      ) else {
        return false
      }
      context.interpolationQuality = .none
      context.setBlendMode(.copy)
      context.concatenate(fromImage.concatenating(toTile).concatenating(toContext))
      context.draw(part, in: CGRect(x: 0, y: 0, width: part.width, height: part.height))
      return true
    }
    guard drawn else { throw AdjustImageError.tooLarge }
    return pixels
  }

  // EXIF orientation, as a transform from stored pixels to upright (top-left origin, y down).
  static func orientationMatrix(_ orientation: CGImagePropertyOrientation) -> CGAffineTransform {
    switch orientation {
    case .upMirrored: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 0, ty: 0)
    case .down: CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 0, ty: 0)
    case .downMirrored: CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: 0)
    case .leftMirrored: CGAffineTransform(a: 0, b: 1, c: 1, d: 0, tx: 0, ty: 0)
    case .right: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 0, ty: 0)
    case .rightMirrored: CGAffineTransform(a: 0, b: -1, c: -1, d: 0, tx: 0, ty: 0)
    case .left: CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 0)
    default: .identity
    }
  }
}

// The full-size copy, filled tile by tile (RGBA bytes, premultiplied, sRGB) and encoded once.
final class AdjustOutput {
  let width: Int
  let height: Int
  private let bytesPerRow: Int
  private let data: UnsafeMutableRawPointer

  init(width: Int, height: Int) throws {
    guard width > 0, height > 0 else { throw AdjustImageError.failed("Width and height must be > 0") }
    guard let data = calloc(width * height, 4) else { throw AdjustImageError.tooLarge }
    self.width = width
    self.height = height
    self.bytesPerRow = width * 4
    self.data = data
  }

  deinit {
    free(data)
  }

  // Replaces the pixels under `rect` with `pixels` (rect.width × rect.height × 4 bytes).
  func write(_ rect: CGRect, pixels: Data) throws {
    let x = Int(rect.minX)
    let y = Int(rect.minY)
    let tileWidth = Int(rect.width)
    let tileHeight = Int(rect.height)
    guard tileWidth > 0, tileHeight > 0, pixels.count >= tileWidth * tileHeight * 4 else {
      throw AdjustImageError.failed("Buffer not large enough for pixels")
    }
    let left = max(x, 0)
    let top = max(y, 0)
    let right = min(x + tileWidth, width)
    let bottom = min(y + tileHeight, height)
    guard left < right, top < bottom else { return }
    pixels.withUnsafeBytes { tile in
      for row in top..<bottom {
        memcpy(
          data + row * bytesPerRow + left * 4,
          tile.baseAddress! + ((row - y) * tileWidth + (left - x)) * 4,
          (right - left) * 4
        )
      }
    }
  }

  // Writes a JPEG (alpha ignored) or PNG to `path`; returns its size in bytes.
  func encode(path: String, png: Bool, quality: Int) throws -> Int64 {
    let encodeFailed = AdjustImageError.failed("Couldn't encode the photo")
    guard let provider = CGDataProvider(dataInfo: nil, data: data, size: bytesPerRow * height, releaseData: { _, _, _ in }),
          let image = CGImage(
            width: width,
            height: height,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: bytesPerRow,
            space: AdjustPixels.sRGB,
            bitmapInfo: CGBitmapInfo(rawValue: png ? AdjustPixels.rgba : AdjustPixels.rgbx),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
          ),
          let destination = CGImageDestinationCreateWithURL(
            URL(fileURLWithPath: path) as CFURL,
            (png ? UTType.png : UTType.jpeg).identifier as CFString,
            1,
            nil
          )
    else {
      throw encodeFailed
    }
    let properties: [NSString: Any] = png ? [:] : [kCGImageDestinationLossyCompressionQuality: Double(quality) / 100]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(destination) else { throw encodeFailed }
    let attributes = try FileManager.default.attributesOfItem(atPath: path)
    return (attributes[.size] as? NSNumber)?.int64Value ?? 0
  }
}
