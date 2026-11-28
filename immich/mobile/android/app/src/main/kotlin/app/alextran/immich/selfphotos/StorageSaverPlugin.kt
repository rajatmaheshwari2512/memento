package app.alextran.immich.selfphotos

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Gainmap
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.MediaStore
import android.util.Log
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.TransformationRequest
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.DataInputStream
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.math.floor
import kotlin.math.min
import kotlin.math.sqrt

// SelfPhotos Storage saver: shrinks a video or photo before it's uploaded.
class StorageSaverPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
  private var channel: MethodChannel? = null
  private var context: Context? = null
  private val main = Handler(Looper.getMainLooper())
  private val cancelledRuns = ConcurrentHashMap.newKeySet<Long>()
  @Volatile private var detached = false
  @Volatile private var running: Pair<Long, VideoExport>? = null

  override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    context = binding.applicationContext
    channel = MethodChannel(binding.binaryMessenger, "selfphotos/storage_saver").also { it.setMethodCallHandler(this) }
  }

  override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
    channel?.setMethodCallHandler(null)
    channel = null
    detached = true
    running?.second?.cancel()
  }

  override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
    when (call.method) {
      "shrink" -> {
        val run = call.argument<Number>("runId")!!.toLong()
        worker.execute {
          try {
            val value = if (isCancelled(run)) {
              notShrunk("cancelled")
            } else {
              shrink(
                run,
                File(call.argument<String>("inputPath")!!),
                File(call.argument<String>("outputPath")!!),
                call.argument<String>("kind")!!,
                call.argument<Int>("videoBitrate"),
                call.argument<Int>("videoShortSide"),
              )
            }
            main.post { result.success(value) }
          } catch (e: Throwable) {
            Log.w(TAG, "Couldn't shrink", e)
            main.post { result.error("failed", e.message ?: e.toString(), null) }
          }
        }
      }
      "sizes" -> {
        val ids = call.argument<List<String>>("localIds")!!
        queries.execute {
          try {
            val value = sizes(ids)
            main.post { result.success(value) }
          } catch (e: Throwable) {
            Log.w(TAG, "Couldn't read the sizes", e)
            main.post { result.error("failed", e.message ?: e.toString(), null) }
          }
        }
      }
      "cancel" -> {
        cancel(call.argument<Number>("runId")!!.toLong())
        result.success(null)
      }
      else -> result.notImplemented()
    }
  }

  private fun isCancelled(run: Long) = detached || run in cancelledRuns

  // Stops [run]'s running shrink and skips the ones it already asked for.
  private fun cancel(run: Long) {
    cancelledRuns.add(run)
    running?.let { (runningRun, export) -> if (runningRun == run) export.cancel() }
  }

  // Maps each local id (a MediaStore id) to the size of its file on the phone, in bytes.
  private fun sizes(localIds: List<String>): Map<String, Long> {
    val resolver = context!!.contentResolver
    val uri = MediaStore.Files.getContentUri("external")
    val sizes = HashMap<String, Long>()
    for (chunk in localIds.chunked(SIZES_CHUNK)) {
      val selection = "${MediaStore.Files.FileColumns._ID} IN (${chunk.joinToString(",") { "?" }})"
      val projection = arrayOf(MediaStore.Files.FileColumns._ID, MediaStore.MediaColumns.SIZE)
      resolver.query(uri, projection, selection, chunk.toTypedArray(), null)?.use { cursor ->
        while (cursor.moveToNext()) {
          sizes[cursor.getLong(0).toString()] = cursor.getLong(1)
        }
      }
    }
    return sizes
  }

  private fun shrink(run: Long, input: File, output: File, kind: String, videoBitrate: Int?, videoShortSide: Int?): Map<String, Any> {
    val reason = when (kind) {
      "video" -> shrinkVideo(run, input, output, videoBitrate!!, videoShortSide!!)
      "photo" -> shrinkPhoto(input, output)
      else -> error("Unknown kind $kind")
    }
    if (reason != null) {
      output.delete()
      return notShrunk(reason)
    }
    if (output.length() > input.length() * MAX_SIZE_RATIO) {
      output.delete()
      return notShrunk("notSmaller")
    }
    return mapOf("shrunk" to true)
  }

  // Returns why the video is kept as it is, or null once [output] is written.
  private fun shrinkVideo(run: Long, input: File, output: File, bitrate: Int, maxShortSide: Int): String? {
    val facts = VideoFacts.read(input)
    if (facts.frameRate > MAX_FRAME_RATE) return "frameRate"
    val resize = facts.shortSide > maxShortSide
    if (!resize && facts.bitrate <= bitrate / MAX_SIZE_RATIO) return "alreadySmall"

    val export = VideoExport(context!!, input, output, bitrate, resize, min(facts.shortSide, maxShortSide))
    running = run to export
    try {
      if (isCancelled(run)) export.cancel()
      return export.run(facts.durationMs * 2 + TIME_LIMIT_EXTRA_MS)
    } finally {
      running = null
    }
  }

  // Returns why the photo is kept as it is, or null once [output] is written.
  private fun shrinkPhoto(input: File, output: File): String? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(input.path, bounds)
    if (bounds.outMimeType != "image/jpeg") return "notJpeg"
    val headers = JpegHeaders.read(input)
    headers.skipReason()?.let { return it }

    val decoded = BitmapFactory.decodeFile(input.path, BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }) ?: return "unreadable"
    var bitmap = decoded
    var gainmap: Gainmap? = null
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) gainmap = decoded.gainmap
      if (headers.ultraHdr && gainmap == null) return "gainMap"
      val pixels = decoded.width.toLong() * decoded.height
      if (pixels > MAX_PIXELS) {
        val scale = sqrt(MAX_PIXELS.toDouble() / pixels)
        bitmap = Bitmap.createScaledBitmap(
          decoded,
          floor(decoded.width * scale).toInt(),
          floor(decoded.height * scale).toInt(),
          true,
        )
        if (gainmap != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) bitmap.gainmap = gainmap
      }
      FileOutputStream(output).use { stream ->
        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, stream)) error("Couldn't encode the photo")
      }
      copyExif(input, output, bitmap.width, bitmap.height)
    } finally {
      if (bitmap !== decoded) bitmap.recycle()
      decoded.recycle()
    }
    return if (gainmap != null && !hasGainmap(output)) "gainMapLost" else null
  }

  // Whether [file] decodes with an HDR gain map (Android 14 and later).
  private fun hasGainmap(file: File): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
    val decoded = BitmapFactory.decodeFile(file.path) ?: return false
    return decoded.hasGainmap().also { decoded.recycle() }
  }

  private fun copyExif(input: File, output: File, width: Int, height: Int) {
    val from = ExifInterface(input.path)
    val to = ExifInterface(output.path)
    for (tag in EXIF_TAGS) {
      from.getAttribute(tag)?.let { to.setAttribute(tag, it) }
    }
    to.setAttribute(ExifInterface.TAG_IMAGE_WIDTH, width.toString())
    to.setAttribute(ExifInterface.TAG_IMAGE_LENGTH, height.toString())
    to.setAttribute(ExifInterface.TAG_PIXEL_X_DIMENSION, width.toString())
    to.setAttribute(ExifInterface.TAG_PIXEL_Y_DIMENSION, height.toString())
    to.saveAttributes()
  }

  private fun notShrunk(reason: String): Map<String, Any> = mapOf("shrunk" to false, "reason" to reason)

  private companion object {
    const val TAG = "StorageSaver"
    const val MAX_SIZE_RATIO = 0.8
    const val MAX_FRAME_RATE = 60f
    const val MAX_PIXELS = 16_000_000L
    const val JPEG_QUALITY = 85
    const val SIZES_CHUNK = 500
    const val TIME_LIMIT_EXTRA_MS = 60_000L

    val worker = Executors.newSingleThreadExecutor()
    val queries = Executors.newSingleThreadExecutor()

    val EXIF_TAGS = listOf(
      ExifInterface.TAG_DATETIME,
      ExifInterface.TAG_DATETIME_ORIGINAL,
      ExifInterface.TAG_DATETIME_DIGITIZED,
      ExifInterface.TAG_OFFSET_TIME,
      ExifInterface.TAG_OFFSET_TIME_ORIGINAL,
      ExifInterface.TAG_OFFSET_TIME_DIGITIZED,
      ExifInterface.TAG_SUBSEC_TIME,
      ExifInterface.TAG_SUBSEC_TIME_ORIGINAL,
      ExifInterface.TAG_SUBSEC_TIME_DIGITIZED,
      ExifInterface.TAG_GPS_VERSION_ID,
      ExifInterface.TAG_GPS_LATITUDE,
      ExifInterface.TAG_GPS_LATITUDE_REF,
      ExifInterface.TAG_GPS_LONGITUDE,
      ExifInterface.TAG_GPS_LONGITUDE_REF,
      ExifInterface.TAG_GPS_ALTITUDE,
      ExifInterface.TAG_GPS_ALTITUDE_REF,
      ExifInterface.TAG_GPS_TIMESTAMP,
      ExifInterface.TAG_GPS_DATESTAMP,
      ExifInterface.TAG_GPS_PROCESSING_METHOD,
      ExifInterface.TAG_GPS_DOP,
      ExifInterface.TAG_GPS_SPEED,
      ExifInterface.TAG_GPS_SPEED_REF,
      ExifInterface.TAG_GPS_IMG_DIRECTION,
      ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
      ExifInterface.TAG_GPS_MAP_DATUM,
      ExifInterface.TAG_ORIENTATION,
      ExifInterface.TAG_MAKE,
      ExifInterface.TAG_MODEL,
      ExifInterface.TAG_ARTIST,
      ExifInterface.TAG_COPYRIGHT,
      ExifInterface.TAG_IMAGE_DESCRIPTION,
      ExifInterface.TAG_USER_COMMENT,
      ExifInterface.TAG_LENS_MAKE,
      ExifInterface.TAG_LENS_MODEL,
      ExifInterface.TAG_EXPOSURE_TIME,
      ExifInterface.TAG_F_NUMBER,
      ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
      ExifInterface.TAG_FLASH,
      ExifInterface.TAG_FOCAL_LENGTH,
      ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM,
      ExifInterface.TAG_WHITE_BALANCE,
    )
  }
}

// The facts that decide whether a video is shrunk.
private class VideoFacts(
  val shortSide: Int,
  val frameRate: Float,
  val bitrate: Long,
  val durationMs: Long,
) {
  companion object {
    fun read(file: File): VideoFacts {
      val extractor = MediaExtractor()
      val retriever = MediaMetadataRetriever()
      try {
        extractor.setDataSource(file.path)
        retriever.setDataSource(file.path)
        val format = (0 until extractor.trackCount)
          .map { extractor.getTrackFormat(it) }
          .firstOrNull { it.getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true }
          ?: error("No video track")
        val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
        val frameRate = if (!format.containsKey(MediaFormat.KEY_FRAME_RATE)) {
          0f
        } else {
          try {
            format.getFloat(MediaFormat.KEY_FRAME_RATE)
          } catch (e: ClassCastException) {
            format.getInteger(MediaFormat.KEY_FRAME_RATE).toFloat()
          }
        }
        return VideoFacts(
          shortSide = min(format.getInteger(MediaFormat.KEY_WIDTH), format.getInteger(MediaFormat.KEY_HEIGHT)),
          frameRate = frameRate,
          bitrate = if (durationMs > 0) file.length() * 8 * 1000 / durationMs else Long.MAX_VALUE,
          durationMs = durationMs,
        )
      } finally {
        extractor.release()
        retriever.release()
      }
    }
  }
}

// One video, re-encoded as HEVC at [bitrate]; [resize] makes its short side [shortSide]. An HDR video stays HDR, or
// isn't shrunk ("hdrUnsupported") on a phone that can't keep it HDR.
private class VideoExport(
  private val context: Context,
  private val input: File,
  private val output: File,
  private val bitrate: Int,
  private val resize: Boolean,
  private val shortSide: Int,
) {
  private val thread = HandlerThread("storage-saver").apply { start() }
  private val handler = Handler(thread.looper)
  private val done = CountDownLatch(1)
  private var transformer: Transformer? = null
  @Volatile private var failure: String? = null

  // Returns null once [output] is written within [timeLimitMs], or why it wasn't.
  fun run(timeLimitMs: Long): String? {
    try {
      handler.post(::start)
      if (!done.await(timeLimitMs, TimeUnit.MILLISECONDS)) {
        handler.post { transformer?.cancel() }
        return "failed: timedOut"
      }
      return failure
    } finally {
      thread.quitSafely()
    }
  }

  fun cancel() {
    handler.post {
      transformer?.cancel()
      finish("cancelled")
    }
  }

  private fun start() {
    if (done.count == 0L) return
    try {
      startExport()
    } catch (e: Exception) {
      Log.w(TAG, "Couldn't start shrinking a video", e)
      finish("failed: ${e.javaClass.simpleName}")
    }
  }

  private fun startExport() {
    val encoderFactory = DefaultEncoderFactory.Builder(context)
      .setRequestedVideoEncoderSettings(
        VideoEncoderSettings.Builder().setBitrate(bitrate).setiFrameIntervalSeconds(KEYFRAME_INTERVAL_SECONDS).build(),
      )
      .setEnableFallback(true)
      .build()
    val built = Transformer.Builder(context)
      .setLooper(thread.looper)
      .setVideoMimeType(MimeTypes.VIDEO_H265)
      .setEncoderFactory(encoderFactory)
      .addListener(object : Transformer.Listener {
        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
          val outputShortSide = min(exportResult.width, exportResult.height)
          finish(if (outputShortSide in 0 until shortSide - SIZE_TOLERANCE) "encoderLimit" else null)
        }

        override fun onFallbackApplied(
          composition: Composition,
          originalTransformationRequest: TransformationRequest,
          fallbackTransformationRequest: TransformationRequest,
        ) {
          if (fallbackTransformationRequest.hdrMode != Composition.HDR_MODE_KEEP_HDR) {
            handler.post { transformer?.cancel() }
            finish("hdrUnsupported")
          }
        }

        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
          Log.w(TAG, "Couldn't shrink a video", exportException)
          finish("failed: ${exportException.errorCodeName}")
        }
      })
      .build()
    transformer = built
    val item = EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(input)))
    if (resize) item.setEffects(Effects(listOf(), listOf(Presentation.createForShortSide(shortSide))))
    built.start(item.build(), output.path)
  }

  private fun finish(reason: String?) {
    if (done.count == 0L) return
    failure = reason
    done.countDown()
  }

  private companion object {
    const val TAG = "StorageSaver"
    const val SIZE_TOLERANCE = 16
    const val KEYFRAME_INTERVAL_SECONDS = 1f
  }
}

// The JPEG's header segments that mark photos kept full size.
private class JpegHeaders(val xmp: String, val multiPicture: Boolean) {
  // Whether the photo carries an HDR gain map (Ultra HDR).
  val ultraHdr get() = xmp.contains("hdrgm")

  fun skipReason(): String? = when {
    xmp.contains("MotionPhoto") || xmp.contains("MicroVideo") -> "motionPhoto"
    DEPTH_MARKERS.any { xmp.contains(it) } -> "depth"
    xmp.contains("Container:Directory") && containerItems() != ULTRA_HDR_ITEMS -> "depth"
    multiPicture && !ultraHdr -> "depth"
    ultraHdr && Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> "gainMap"
    else -> null
  }

  private fun containerItems(): Set<String> = ITEM_SEMANTIC.findAll(xmp).map { it.groupValues[1] }.toSet()

  companion object {
    private val DEPTH_MARKERS = listOf("GDepth", "GImage")
    private val ULTRA_HDR_ITEMS = setOf("Primary", "GainMap")
    private val ITEM_SEMANTIC = Regex("""Item:Semantic="([^"]+)"""")
    private const val XMP_PREFIX = "http://ns.adobe.com/"
    private val MPF_PREFIX = byteArrayOf('M'.code.toByte(), 'P'.code.toByte(), 'F'.code.toByte(), 0)

    fun read(file: File): JpegHeaders {
      val xmp = StringBuilder()
      var multiPicture = false
      DataInputStream(file.inputStream().buffered()).use { input ->
        if (input.readUnsignedShort() != 0xFFD8) return JpegHeaders("", false)
        while (true) {
          if (input.readUnsignedByte() != 0xFF) break
          var marker = input.readUnsignedByte()
          while (marker == 0xFF) marker = input.readUnsignedByte()
          if (marker == 0xDA || marker == 0xD9) break
          val data = ByteArray(input.readUnsignedShort() - 2)
          input.readFully(data)
          when (marker) {
            0xE1 -> {
              val text = String(data, Charsets.ISO_8859_1)
              if (text.startsWith(XMP_PREFIX)) xmp.append(text)
            }
            0xE2 -> if (data.size >= MPF_PREFIX.size && data.copyOf(MPF_PREFIX.size).contentEquals(MPF_PREFIX)) multiPicture = true
          }
        }
      }
      return JpegHeaders(xmp.toString(), multiPicture)
    }
  }
}
