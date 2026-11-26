package app.alextran.immich.selfphotos

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.BitmapRegionDecoder
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.exifinterface.media.ExifInterface
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.util.concurrent.Executors
import kotlin.math.roundToInt

// SelfPhotos Adjust: the parts of saving a full-size copy that Flutter can't do well itself.
class AdjustImagePlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
  private var channel: MethodChannel? = null
  private val worker = Executors.newSingleThreadExecutor()
  private val main = Handler(Looper.getMainLooper())
  private var source: AdjustSource? = null
  private var output: Bitmap? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel = MethodChannel(binding.binaryMessenger, "selfphotos/adjust_image").also { it.setMethodCallHandler(this) }
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel?.setMethodCallHandler(null)
    channel = null
    worker.execute { release() }
    worker.shutdown()
  }

  override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
    worker.execute {
      try {
        val value: Any? = when (call.method) {
          "open" -> open(call.argument<String>("path")!!)
          "read" -> read(call.rect())
          "createOutput" -> createOutput(call.argument<Int>("width")!!, call.argument<Int>("height")!!)
          "write" -> write(call.rect(), call.argument<ByteArray>("pixels")!!)
          "encode" -> encode(call.argument<String>("path")!!, call.argument<Boolean>("png")!!, call.argument<Int>("quality")!!)
          "close" -> release()
          else -> {
            main.post { result.notImplemented() }
            return@execute
          }
        }
        main.post { result.success(value) }
      } catch (e: OutOfMemoryError) {
        release()
        main.post { result.error("too-large", "Not enough memory for a photo this large.", null) }
      } catch (e: UnreadableImageException) {
        main.post { result.error("unreadable", e.message, null) }
      } catch (e: Exception) {
        main.post { result.error("failed", e.message ?: e.toString(), null) }
      }
    }
  }

  private fun MethodCall.rect() = Rect(
    argument<Int>("x")!!,
    argument<Int>("y")!!,
    argument<Int>("x")!! + argument<Int>("width")!!,
    argument<Int>("y")!! + argument<Int>("height")!!,
  )

  private fun open(path: String): Map<String, Int> {
    release()
    val opened = AdjustSource(path)
    source = opened
    return mapOf("width" to opened.width, "height" to opened.height)
  }

  private fun read(rect: Rect): ByteArray {
    val part = (source ?: error("No photo open")).read(rect)
    try {
      val bytes = ByteArray(part.width * part.height * 4)
      part.copyPixelsToBuffer(ByteBuffer.wrap(bytes))
      return bytes
    } finally {
      part.recycle()
    }
  }

  private fun createOutput(width: Int, height: Int) {
    output?.recycle()
    output = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
  }

  private fun write(rect: Rect, pixels: ByteArray) {
    val target = output ?: error("No output")
    val tile = Bitmap.createBitmap(rect.width(), rect.height(), Bitmap.Config.ARGB_8888)
    try {
      tile.copyPixelsFromBuffer(ByteBuffer.wrap(pixels))
      Canvas(target).drawBitmap(tile, rect.left.toFloat(), rect.top.toFloat(), COPY)
    } finally {
      tile.recycle()
    }
  }

  private fun encode(path: String, png: Boolean, quality: Int): Long {
    val target = output ?: error("No output")
    FileOutputStream(path).use { stream ->
      if (!target.compress(if (png) Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, quality, stream)) {
        error("Couldn't encode the photo")
      }
    }
    return File(path).length()
  }

  private fun release() {
    source?.close()
    source = null
    output?.recycle()
    output = null
  }

  private companion object {
    val COPY = Paint().apply { xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC) }
  }
}

private class UnreadableImageException(message: String) : Exception(message)

private class AdjustSource(path: String) {
  private val decoder: BitmapRegionDecoder?
  private var whole: Bitmap? = null
  private val orientation: Matrix
  private val toRaw = Matrix()
  val width: Int
  val height: Int

  init {
    val exif = runCatching { ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
      .getOrDefault(ExifInterface.ORIENTATION_NORMAL)
    decoder = runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        BitmapRegionDecoder.newInstance(path)
      } else {
        @Suppress("DEPRECATION")
        BitmapRegionDecoder.newInstance(path, false)
      }
    }.getOrNull()

    if (decoder != null) {
      orientation = orientationMatrix(exif)
      val bounds = RectF(0f, 0f, decoder.width.toFloat(), decoder.height.toFloat())
      val toUpright = Matrix(orientation)
      toUpright.mapRect(bounds)
      toUpright.postTranslate(-bounds.left, -bounds.top)
      toUpright.invert(toRaw)
      width = bounds.width().roundToInt()
      height = bounds.height().roundToInt()
    } else {
      val decoded = decodeWhole(path, exif)
      whole = decoded
      orientation = Matrix()
      width = decoded.width
      height = decoded.height
    }
  }

  // The upright part `rect`.
  fun read(rect: Rect): Bitmap {
    whole?.let { photo ->
      val part = Bitmap.createBitmap(photo, rect.left, rect.top, rect.width(), rect.height())
      return if (part === photo) photo.copy(Bitmap.Config.ARGB_8888, false) else part
    }
    val raw = RectF(rect)
    toRaw.mapRect(raw)
    val region = decoder!!.decodeRegion(
      Rect(raw.left.roundToInt(), raw.top.roundToInt(), raw.right.roundToInt(), raw.bottom.roundToInt()),
      sRgbOptions(),
    ) ?: throw UnreadableImageException("Couldn't read part of the photo")
    val argb = region.asArgb()
    if (orientation.isIdentity) return argb
    return Bitmap.createBitmap(argb, 0, 0, argb.width, argb.height, orientation, false).also { argb.recycle() }
  }

  fun close() {
    decoder?.recycle()
    whole?.recycle()
    whole = null
  }

  companion object {
    fun sRgbOptions() = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inPreferredColorSpace = ColorSpace.get(ColorSpace.Named.SRGB)
    }

    fun Bitmap.asArgb(): Bitmap =
      if (config == Bitmap.Config.ARGB_8888) this else copy(Bitmap.Config.ARGB_8888, false).also { recycle() }

    fun orientationMatrix(exif: Int) = Matrix().apply {
      when (exif) {
        ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> setScale(-1f, 1f)
        ExifInterface.ORIENTATION_ROTATE_180 -> setRotate(180f)
        ExifInterface.ORIENTATION_FLIP_VERTICAL -> { setRotate(180f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_TRANSPOSE -> { setRotate(90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_90 -> setRotate(90f)
        ExifInterface.ORIENTATION_TRANSVERSE -> { setRotate(-90f); postScale(-1f, 1f) }
        ExifInterface.ORIENTATION_ROTATE_270 -> setRotate(-90f)
      }
    }

    // Formats the region decoder can't read (e.g. AVIF).
    fun decodeWhole(path: String, exif: Int): Bitmap {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        return runCatching {
          ImageDecoder.decodeBitmap(ImageDecoder.createSource(File(path))) { decoder, _, _ ->
            decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            decoder.setTargetColorSpace(ColorSpace.get(ColorSpace.Named.SRGB))
          }.asArgb()
        }.getOrElse { throw UnreadableImageException("This photo's format can't be read here") }
      }
      val decoded = BitmapFactory.decodeFile(path, sRgbOptions())?.asArgb()
        ?: throw UnreadableImageException("This photo's format can't be read here")
      val matrix = orientationMatrix(exif)
      if (matrix.isIdentity) return decoded
      return Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, false).also { decoded.recycle() }
    }
  }
}
